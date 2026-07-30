// HermesFilesFetcher — the Hermes leg of the outbound-media seam. Resolves a
// workspace path to a byte stream via the `hermes serve` managed-files API
// (`GET /api/files/download?path=`), authenticated with the SAME credential
// the WS client uses (password-login → session cookie; static token appended
// as `?token=` on the legacy loopback mode). Streams straight into the
// writer's Convex upload — no base64 inflation, no full-file buffer.

import { Readable } from "node:stream";
import type { MediaFetcher, OpenResult } from "../../core/media-fetcher.js";

/**
 * The managed-files API is NOT DEPLOYED on this instance — not a fault to retry.
 *
 * It lives only in the dashboard web server (`hermes_cli/web_server.py:2131-2202`), which
 * upstream supervises "if HERMES_DASHBOARD is set" (`hermes_cli/gateway.py:6607`), while
 * `tui_gateway` mounts exactly one route, `/api/ws` (`tui_gateway/ws.py:19`). So a plain
 * `hermes serve` answers every turn perfectly and 404s every agent-files operation.
 *
 * Its own CLASS rather than its own sentence: `classifyGatewayError` reads the type, the way
 * it already does for `ContextBlockedError`, so a decision this code made cannot come undone
 * because someone rephrased a string. Without it the 404 read as a generic upstream fault and
 * the operator was invited to retry, forever, against a server that will never be there.
 */
export class HermesDashboardAbsentError extends Error {
  readonly code = "dashboard_not_deployed";
  constructor(readonly path: string) {
    super(
      `Hermes managed-files API not deployed on this instance (${path} -> HTTP 404). ` +
        `That surface belongs to the dashboard web server, which the gateway starts only ` +
        `when HERMES_DASHBOARD is set — the turn transport is unaffected.`,
    );
    this.name = "HermesDashboardAbsentError";
  }
}

export interface HermesFilesFetcherOptions {
  baseUrl: string;
  /** Static token OR "user:password" (same convention as the WS client). */
  credential: string;
  maxBytes: number;
  requestTimeoutMs?: number;
}

export class HermesFilesFetcher implements MediaFetcher {
  private readonly base: string;
  private readonly credential: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private cookies: string | null = null;

  constructor(opts: HermesFilesFetcherOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.credential = opts.credential;
    this.maxBytes = opts.maxBytes;
    this.timeoutMs = opts.requestTimeoutMs ?? 20_000;
  }

  /** Authenticated GET; on 401 re-logins ONCE (session cookie expired). */
  async authedGet(path: string, retry = true): Promise<Response> {
    const colon = this.credential.indexOf(":");
    let url = `${this.base}${path}`;
    const headers: Record<string, string> = {};
    if (colon === -1) {
      url += `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.credential)}`;
    } else {
      if (!this.cookies) await this.login();
      if (this.cookies) headers.Cookie = this.cookies;
    }
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 && colon !== -1 && retry) {
      this.cookies = null;
      return this.authedGet(path, false);
    }
    return res;
  }

  private async login(): Promise<void> {
    const colon = this.credential.indexOf(":");
    const res = await fetch(`${this.base}/auth/password-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "basic",
        username: this.credential.slice(0, colon),
        password: this.credential.slice(colon + 1),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) return; // open() reports the failure structurally
    this.cookies = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  /**
   * RE-ASK whether the dashboard is there, after an ambiguous 404.
   *
   * Every 404 on this API means one of two things — the route is not mounted, or the path is
   * not there — and only the no-path probe tells them apart. The root is CACHED, so after one
   * success that probe is skipped and a server that goes away later would be reported as an
   * ordinary fault forever (raised in review). Dropping the cache and re-asking costs one GET
   * on a call that already failed, and it is the only way the ambiguity is resolved rather
   * than assumed.
   *
   * Returns normally when the dashboard answers — the caller then keeps its ORIGINAL verdict,
   * which for a read is the perfectly ordinary "this file does not exist".
   */
  private async assertDashboardStillThere(): Promise<void> {
    this.rootPath = null;
    await this.agentFilesRoot();
  }

  /** STRICT list for ADMIN operations (/agent-files): a gateway failure THROWS
   *  so the caller returns a retryable 502 — an empty result must always mean
   *  "the directory really is empty", never a swallowed 500/timeout. */
  async listFilesStrict(
    dirPath: string,
  ): Promise<Array<{ name: string; path: string; mtime: number; size: number | null }>> {
    const res = await this.authedGet(
      `/api/files?path=${encodeURIComponent(dirPath)}`,
    );
    // NOT promoted here: this call CARRIES a path, and upstream answers `404 "Path not found"`
    // for a directory that does not exist. Telling an operator to enable a server that is
    // already running would be the same false diagnosis this lot exists to remove, mirrored.
    //
    // But a 404 IS worth re-asking about, because the root is CACHED: after one success the
    // unambiguous no-path probe is skipped, so a dashboard that goes away later would be
    // reported as a plain upstream fault forever (raised in review). Dropping the cache and
    // re-probing costs one request on a path that already failed, and it is the only way the
    // ambiguity gets resolved rather than assumed.
    if (res.status === 404) await this.assertDashboardStillThere();
    if (!res.ok) throw new Error(`files list -> HTTP ${res.status}`);
    const d = (await res.json()) as { entries?: Array<Record<string, unknown>> };
    return (d.entries ?? [])
      .filter((e) => e.is_directory !== true && typeof e.path === "string")
      .map((e) => ({
        name: String(e.name ?? ""),
        path: String(e.path),
        mtime: typeof e.mtime === "number" ? e.mtime * 1000 : 0,
        size: typeof e.size === "number" ? e.size : null,
      }));
  }

  /** List a workspace directory (managed-files API). Returns [] on any error
   *  — the outbound scan treats that as "nothing to deliver". */
  async listFiles(
    dirPath: string,
  ): Promise<Array<{ name: string; path: string; mtime: number; size: number | null }>> {
    try {
      return await this.listFilesStrict(dirPath);
    } catch {
      return [];
    }
  }

  /** The managed-files ROOT (the agent home, e.g. /opt/data). Learned from the
   *  first list call; agent files (SOUL.md…) live at this root. */
  private rootPath: string | null = null;

  async agentFilesRoot(): Promise<string> {
    if (this.rootPath) return this.rootPath;
    // NO path parameter, deliberately: the handler then resolves its OWN managed root, so a
    // 404 here is the route being absent rather than a directory being missing. That is what
    // makes this the unambiguous probe for `HermesDashboardAbsentError`.
    const res = await this.authedGet("/api/files");
    if (res.status === 404) {
      // …with one residual case named rather than assumed away: the managed root itself
      // could be gone, and upstream says so in its body. Read it before claiming absence.
      const detail = await res
        .clone()
        .json()
        .then((b: unknown) => (b as { detail?: unknown } | null)?.detail)
        .catch(() => undefined);
      if (detail !== "Path not found") throw new HermesDashboardAbsentError("/api/files");
    }
    if (!res.ok) throw new Error(`files root -> HTTP ${res.status}`);
    const d = (await res.json()) as { path?: string };
    this.rootPath = typeof d.path === "string" && d.path ? d.path : "/";
    return this.rootPath;
  }

  /** Read a root-level agent file: content (decoded) or missing.
   *
   *  `decoded` says whether the response actually CARRIED a parsable data URL. Without
   *  it, a malformed 200 and a genuinely empty file were the same `content: ""` — so an
   *  empty write "confirmed" itself against a response that contained nothing, and the
   *  post-write check that reads this had no way to tell. Callers that make a decision
   *  on the content must consult it; callers that only display it need not. */
  async readAgentFile(
    name: string,
  ): Promise<{ content: string; missing: boolean; decoded: boolean }> {
    const root = await this.agentFilesRoot();
    const res = await this.authedGet(
      `/api/files/read?path=${encodeURIComponent(`${root}/${name}`)}`,
    );
    if (res.status === 404) {
      // Ambiguous: an absent FILE (the common case — the tab offers to create it) or an
      // absent SERVER. Ask before answering, or a vanished dashboard is reported as an empty
      // file the operator is invited to write to (raised in review).
      await this.assertDashboardStillThere();
      return { content: "", missing: true, decoded: false };
    }
    if (!res.ok) throw new Error(`files read -> HTTP ${res.status}`);
    const d = (await res.json()) as { data_url?: string };
    const m = /^data:[^;]*;base64,(.*)$/s.exec(d.data_url ?? "");
    if (m === null) return { content: "", missing: false, decoded: false };
    // The PAYLOAD is validated, not just the prefix. `Buffer.from` accepts invalid
    // base64 silently — `"%%%%"` decodes to an empty string — so matching the regex was
    // enough to declare a read "decoded", and an empty write then confirmed itself
    // against garbage. An EMPTY payload stays valid: that is a genuinely empty file.
    const payload = (m[1] ?? "").replace(/\s+/g, "");
    const wellFormed =
      payload.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(payload);
    if (!wellFormed) return { content: "", missing: false, decoded: false };
    const bytes = Buffer.from(payload, "base64");
    const text = bytes.toString("utf8");
    // A LOSSY decode is not a read either. `toString("utf8")` replaces invalid byte
    // sequences with U+FFFD without complaining, so bytes that are not text came back
    // as a plausible string — and a post-write comparison against that string can
    // "match" content the file does not hold. Round-tripping is the cheap proof.
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      return { content: "", missing: false, decoded: false };
    }
    return { content: text, missing: false, decoded: true };
  }

  /** Write (create/overwrite) a root-level agent file. `retry` bounds the
   *  401→relogin loop to ONE attempt (a persistent 401 must surface, not
   *  recurse — codex P2). */
  async writeAgentFile(name: string, content: string, retry = true): Promise<void> {
    const root = await this.agentFilesRoot();
    // POST needs the same auth as GET: reuse the cookie/token seam.
    const colon = this.credential.indexOf(":");
    let url = `${this.base}/api/files/upload`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (colon === -1) {
      url += `?token=${encodeURIComponent(this.credential)}`;
    } else {
      if (!this.cookies) await this.loginForWrite();
      if (this.cookies) headers.Cookie = this.cookies;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        path: `${root}/${name}`,
        data_url: `data:text/markdown;base64,${Buffer.from(content, "utf8").toString("base64")}`,
        overwrite: true,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 && colon !== -1 && retry) {
      this.cookies = null;
      await this.loginForWrite();
      return this.writeAgentFile(name, content, false);
    }
    if (res.status === 404) await this.assertDashboardStillThere();
    if (!res.ok) throw new Error(`files upload -> HTTP ${res.status}`);
  }

  private async loginForWrite(): Promise<void> {
    // Same login as authedGet's password path.
    await this.authedGet("/api/files").catch(() => {});
  }

  async open(
    path: string,
    opts?: { rejectOlderThanMs?: number | null },
  ): Promise<OpenResult> {
    try {
      const res = await this.authedGet(
        `/api/files/download?path=${encodeURIComponent(path)}`,
      );
      if (res.status === 404) {
        // Ambiguous, like every other 404 on this API — and here the wrong answer is the most
        // expensive one: recording a file the agent PRODUCED as "not found" makes it vanish
        // with a false reason in the media trace (raised in review). `route_absent` is the
        // vocabulary's existing word for a route that is not there.
        try {
          await this.assertDashboardStillThere();
        } catch (err) {
          // ONLY the probe's own verdict names absence. A probe that 500s, 401s or never
          // answers means the dashboard is there and unwell — reporting "not deployed" would
          // send the operator to enable a server that is already running (raised in review).
          return {
            ok: false,
            reason:
              err instanceof HermesDashboardAbsentError ? "route_absent" : "fetch_error",
          };
        }
        return { ok: false, reason: "not_found" };
      }
      if (!res.ok || !res.body) return { ok: false, reason: "fetch_error" };
      const size = Number(res.headers.get("content-length") ?? "0") || undefined;
      if (size !== undefined && size > this.maxBytes) {
        await res.body.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      const lm = res.headers.get("last-modified");
      if (opts?.rejectOlderThanMs && lm) {
        const mtime = Date.parse(lm);
        if (Number.isFinite(mtime) && mtime < opts.rejectOlderThanMs) {
          await res.body.cancel().catch(() => {});
          return { ok: false, reason: "stale_mention" };
        }
      }
      const mime =
        res.headers.get("content-type")?.split(";")[0] ||
        "application/octet-stream";
      // Enforce the cap DURING the stream too: a chunked download without
      // Content-Length must not blow past maxBytes unbounded (codex P2).
      const limit = this.maxBytes;
      let seen = 0;
      const guard = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > limit) {
            controller.error(new Error("media exceeds the configured size cap"));
            return;
          }
          controller.enqueue(chunk);
        },
      });
      const bounded = (res.body as ReadableStream<Uint8Array>).pipeThrough(guard);
      return {
        ok: true,
        stream: Readable.fromWeb(
          bounded as import("node:stream/web").ReadableStream,
        ),
        mimeType: mime,
        size: size ?? null,
      };
    } catch {
      return { ok: false, reason: "not_found" };
    }
  }
}
