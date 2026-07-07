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

  /** List a workspace directory (managed-files API). Returns [] on any error
   *  — the outbound scan treats that as "nothing to deliver". */
  async listFiles(
    dirPath: string,
  ): Promise<Array<{ name: string; path: string; mtime: number; size: number | null }>> {
    try {
      const res = await this.authedGet(
        `/api/files?path=${encodeURIComponent(dirPath)}`,
      );
      if (!res.ok) return [];
      const d = (await res.json()) as {
        entries?: Array<Record<string, unknown>>;
      };
      return (d.entries ?? [])
        .filter((e) => e.is_directory !== true && typeof e.path === "string")
        .map((e) => ({
          name: String(e.name ?? ""),
          path: String(e.path),
          mtime: typeof e.mtime === "number" ? e.mtime * 1000 : 0,
          size: typeof e.size === "number" ? e.size : null,
        }));
    } catch {
      return [];
    }
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
