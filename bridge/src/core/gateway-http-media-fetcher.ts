// GatewayHttpMediaFetcher — the NO-SHARED-FILESYSTEM way to fetch outbound media.
//
// The vast majority of Atrium deployments do NOT co-locate Atrium and the gateway
// on one filesystem, so reading bytes off a shared `:ro` mount (LocalDirMediaFetcher)
// is the OPT-IN exception, not the default. This fetcher pulls the bytes over HTTP
// from the gateway's `/__openclaw__/assistant-media` endpoint instead.
//
// Contract (verified LIVE against OpenClaw 2026.6.5 on the local gateway):
//   1. META PROBE  GET <base>/__openclaw__/assistant-media?source=<path>&meta=1
//        Header: Authorization: Bearer <OPENCLAW_TOKEN>   (the SAME token the WS uses)
//        -> 200 { available:true, mediaTicket:"v1.<b64url>.<sig>", mediaTicketExpiresAt }
//           (a path-scoped, ~5-min-expiry ticket MINTED BY THE GATEWAY — the HMAC is
//            gateway-private, so we NEVER mint it; we relay it. No `size` field on 6.5.)
//        -> 200 { available:false, code:"file-not-found" }   when the path is unknown.
//        -> 401 when the Bearer is wrong/absent.
//   2. DOWNLOAD    GET <base>/__openclaw__/assistant-media?source=<path>&mediaTicket=<t>
//        The ticket ALONE authorizes the download (no Bearer needed) -> raw bytes +
//        a correct Content-Type. We stream the body straight into the Convex upload
//        URL (no base64, no full buffer), exactly like the shared-fs path.
//
// The endpoint is served on the SAME host:port as the operator WebSocket, so the
// HTTP base is just OPENCLAW_GATEWAY_URL with an http(s) scheme (config.deriveHttpBase).

import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { basename } from "node:path";
import {
  mimeForFilename,
  MEDIA_TOO_LARGE_CODE,
  type MediaFetcher,
  type OpenResult,
} from "./media-fetcher.js";

export interface GatewayHttpMediaFetcherOptions {
  /** Gateway HTTP origin, e.g. "http://host:18790" (trailing slash trimmed). */
  httpBase: string;
  /** Bearer token for the meta probe — the same OPENCLAW_TOKEN as the WS. */
  token: string;
  /** Reject a download whose Content-Length exceeds this (safety valve). */
  maxBytes: number;
  /**
   * Connection timeout (ms) for the meta-probe + the download RESPONSE HEADERS (an
   * AbortSignal, cleared once headers arrive). Defaults to 60s. Stops a gateway
   * that accepts the socket but never responds from hanging the turn (TurnSink
   * awaits addMedia). The body transfer is intentionally NOT bounded by it (it is
   * consumed at the Convex upload's speed; aborting on backpressure would drop
   * valid media).
   */
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const MEDIA_ROUTE = "/__openclaw__/assistant-media";

/**
 * A pass-through stream that ENFORCES the byte cap on the ACTUAL flow — the only
 * reliable guard when the gateway omits Content-Length (chunked) or its meta has
 * no `size` (the 6.5 case). The moment cumulative bytes exceed `maxBytes` it
 * errors (tagged MEDIA_TOO_LARGE_CODE so the writer reports `too_large`, not a
 * generic upload failure), so an oversized download aborts mid-stream instead of
 * slipping past the cap into Convex storage.
 *
 * Deliberately NOT an idle/stall timer: the returned stream is consumed only AFTER
 * the writer fetches a Convex upload URL, and a slow upload backpressures reads —
 * a chunk-flow timer can't tell that healthy pause from a gateway stall, so it
 * would false-drop valid media. The connection deadline (open()'s AbortController)
 * bounds the only window we can judge safely (probe + response headers).
 */
function byteCap(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) {
        const err = new Error(
          `media exceeds OPENCLAW_MEDIA_MAX_MB (${maxBytes} bytes)`,
        ) as Error & { code?: string };
        err.code = MEDIA_TOO_LARGE_CODE;
        cb(err);
      } else {
        cb(null, chunk);
      }
    },
  });
}

export class GatewayHttpMediaFetcher implements MediaFetcher {
  private readonly httpBase: string;
  private readonly token: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private warnedRouteAbsent = false;

  constructor(opts: GatewayHttpMediaFetcherOptions) {
    this.httpBase = opts.httpBase.replace(/\/+$/, "");
    this.token = opts.token;
    this.maxBytes = opts.maxBytes;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async open(
    path: string,
    opts?: { rejectOlderThanMs?: number | null },
  ): Promise<OpenResult> {
    const enc = encodeURIComponent(path);
    // Bounds the meta-probe + the time to get the download RESPONSE HEADERS. Once
    // headers arrive we clear it and hand the BODY to streamGuard's idle timeout, so
    // a large-but-steady download is never aborted by an absolute deadline. A hang
    // here -> AbortError -> caught below -> best-effort `fetch_error`, never a stuck
    // turn (TurnSink awaits addMedia).
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    connectTimer.unref?.();
    try {
      // 1) Authenticated meta probe -> the gateway mints the ticket.
      const metaRes = await this.fetchImpl(
        `${this.httpBase}${MEDIA_ROUTE}?source=${enc}&meta=1`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: controller.signal,
        },
      );
      if (metaRes.status === 404) {
        // The gateway has no assistant-media route (pre-6.x gateway-http target).
        // DISTINCT + actionable (switch to shared-fs), not a transient blip.
        this.warnRouteAbsentOnce(metaRes.status);
        return { ok: false, reason: "route_absent" };
      }
      if (!metaRes.ok) {
        // 401 (bad/absent token), 5xx, unreachable -> a TRANSPORT failure, which is
        // a different operator fix than a genuinely missing file.
        return { ok: false, reason: "fetch_error" };
      }
      const meta = (await metaRes.json()) as {
        available?: boolean;
        mediaTicket?: string;
        size?: number;
        mtimeMs?: number;
      };
      if (!meta.available || !meta.mediaTicket) {
        return { ok: false, reason: "not_found" };
      }
      if (typeof meta.size === "number" && meta.size > this.maxBytes) {
        return { ok: false, reason: "too_large" };
      }
      // Freshness guard (mentioned-only paths): refuse a source KNOWN to predate
      // the caller's bound, judged from the meta probe's mtime when the gateway
      // reports one. When absent, the download-side check below decides (Last-
      // Modified, else REFUSE as unverifiable).
      const metaMtime = typeof meta.mtimeMs === "number" ? meta.mtimeMs : null;
      if (
        opts?.rejectOlderThanMs != null &&
        metaMtime !== null &&
        metaMtime < opts.rejectOlderThanMs
      ) {
        return { ok: false, reason: "stale_mention" };
      }
      // 2) Ticketed download (ticket alone authorizes it; no Bearer).
      const dlRes = await this.fetchImpl(
        `${this.httpBase}${MEDIA_ROUTE}?source=${enc}` +
          `&mediaTicket=${encodeURIComponent(meta.mediaTicket)}`,
        { signal: controller.signal },
      );
      // Headers are in: clear the connect deadline. The BODY transfer is left
      // unbounded ON PURPOSE — it is consumed downstream at the speed of the Convex
      // upload, and aborting on a backpressure pause would false-drop valid media.
      clearTimeout(connectTimer);
      if (!dlRes.ok || !dlRes.body) {
        return { ok: false, reason: "fetch_error" };
      }
      // Download-side freshness check (covers a gateway that sets Last-Modified
      // but reports no mtime in the meta probe). When a bound is requested and NO
      // signal exists AT ALL (live-probed 6.11: neither meta.mtimeMs nor
      // Last-Modified) the mention is REFUSED — failing open here was exactly the
      // stale re-delivery bug (files from OTHER conversations, cited by the
      // agent's memory, re-attached to the current turn). Explicit deliveries
      // never carry a bound, so the documented MEDIA: path is unaffected.
      if (opts?.rejectOlderThanMs != null && metaMtime === null) {
        const lastModified = Date.parse(
          dlRes.headers.get("last-modified") ?? "",
        );
        if (!Number.isFinite(lastModified)) {
          void dlRes.body.cancel().catch(() => {});
          return { ok: false, reason: "unverifiable_mention" };
        }
        if (lastModified < opts.rejectOlderThanMs) {
          void dlRes.body.cancel().catch(() => {});
          return { ok: false, reason: "stale_mention" };
        }
      }
      const lenHeader = dlRes.headers.get("content-length");
      const len = lenHeader ? Number.parseInt(lenHeader, 10) : NaN;
      if (Number.isFinite(len) && len > this.maxBytes) {
        return { ok: false, reason: "too_large" };
      }
      const mimeType =
        dlRes.headers.get("content-type")?.split(";")[0]?.trim() ||
        mimeForFilename(basename(path));
      // null when truly unknown (chunked download, no meta.size on 6.5) — the
      // writer buckets that as "unknown", never "0" (which would read as empty).
      const size = Number.isFinite(len) ? len : (meta.size ?? null);
      // Enforce the cap on the REAL byte flow (Content-Length may be absent or a
      // lie). The cap errors mid-stream past the limit; wire both directions so
      // neither end leaks when the other fails.
      const src = Readable.fromWeb(dlRes.body as NodeWebReadableStream);
      const cap = byteCap(this.maxBytes);
      src.once("error", (e) => cap.destroy(e as Error));
      cap.once("error", () => src.destroy());
      const stream = src.pipe(cap);
      return { ok: true, stream, mimeType, size };
    } catch {
      // Network error, JSON parse failure, abort/timeout, anything: never throw at
      // the writer (a hang would otherwise stall the turn).
      return { ok: false, reason: "fetch_error" };
    } finally {
      // Clear on every early return (route_absent / not_found / too_large / errors)
      // too — `unref` already keeps it from holding the process, this avoids a
      // late spurious abort on a controller nobody is awaiting.
      clearTimeout(connectTimer);
    }
  }

  private warnRouteAbsentOnce(status: number): void {
    if (this.warnedRouteAbsent) return;
    this.warnedRouteAbsent = true;
    console.warn(
      `[media] gateway-http: the gateway has no ${MEDIA_ROUTE} route (HTTP ${status}) — ` +
        `outbound files will be dropped. If your gateway predates OpenClaw 6.x, set ` +
        `OPENCLAW_MEDIA_MODE=shared-fs (with a read-only mount) instead.`,
    );
  }
}
