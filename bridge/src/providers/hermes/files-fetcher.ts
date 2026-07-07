// HermesFilesFetcher — the Hermes leg of the outbound-media seam. Resolves a
// workspace path to a byte stream via the `hermes serve` managed-files API
// (`GET /api/files/download?path=`), authenticated with the SAME credential
// the WS client uses (password-login → session cookie; static token appended
// as `?token=` on the legacy loopback mode). Streams straight into the
// writer's Convex upload — no base64 inflation, no full-file buffer.

import { Readable } from "node:stream";
import type { MediaFetcher, OpenResult } from "../../core/media-fetcher.js";

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

  /** STRICT list for ADMIN operations (/agent-files): a gateway failure THROWS
   *  so the caller returns a retryable 502 — an empty result must always mean
   *  "the directory really is empty", never a swallowed 500/timeout. */
  async listFilesStrict(
    dirPath: string,
  ): Promise<Array<{ name: string; path: string; mtime: number; size: number | null }>> {
    const res = await this.authedGet(
      `/api/files?path=${encodeURIComponent(dirPath)}`,
    );
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
    const res = await this.authedGet("/api/files");
    if (!res.ok) throw new Error(`files root -> HTTP ${res.status}`);
    const d = (await res.json()) as { path?: string };
    this.rootPath = typeof d.path === "string" && d.path ? d.path : "/";
    return this.rootPath;
  }

  /** Read a root-level agent file: content (decoded) or missing. */
  async readAgentFile(
    name: string,
  ): Promise<{ content: string; missing: boolean }> {
    const root = await this.agentFilesRoot();
    const res = await this.authedGet(
      `/api/files/read?path=${encodeURIComponent(`${root}/${name}`)}`,
    );
    if (res.status === 404) return { content: "", missing: true };
    if (!res.ok) throw new Error(`files read -> HTTP ${res.status}`);
    const d = (await res.json()) as { data_url?: string };
    const m = /^data:[^;]*;base64,(.*)$/s.exec(d.data_url ?? "");
    const content = m?.[1] ? Buffer.from(m[1], "base64").toString("utf8") : "";
    return { content, missing: false };
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
      if (res.status === 404) return { ok: false, reason: "not_found" };
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
