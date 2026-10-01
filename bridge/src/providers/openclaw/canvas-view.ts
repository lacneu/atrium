// `/canvas-view` — relay ONE inline-widget document from the gateway to Convex.
//
// `canvas.document.view {docId}` (packages/gateway-protocol/src/schema/canvas.ts,
// src/gateway/server-methods/canvas.ts) answers any operator socket holding
// `operator.read` with the stored HTML of a managed canvas document — no session,
// agent or capability scoping. The AUTHORIZATION therefore lives in Convex: it calls
// this route only after checking that the person may read the conversation AND that
// the view id is one of that conversation's own `widget` parts. This module only
// validates, relays and bounds.
//
// The gateway answers `UNAVAILABLE` for an unknown or pruned document (32 per session,
// oldest evicted) AND when its sandbox listener cannot bind (gateway port + 1, or
// `mcp.apps.sandboxPort`) — one code for both, by upstream design.

import { GatewayAnsweredError } from "./openclaw-client.js";
import { WIDGET_VIEW_ID_RE } from "./widgets.js";

/** Upstream bound on a widget document: 2 MiB through 2026.9.6, 10 MiB from 2026.9.7
 *  (`WIDGET_HTML_MAX_UTF8_BYTES`). The relay accepts the larger one. */
export const WIDGET_HTML_MAX_UTF8_BYTES = 10 * 1024 * 1024;
export const CANVAS_VIEW_TIMEOUT_MS = 15_000;

export type CanvasViewOutcome =
  | { ok: true; html: string }
  | {
      ok: false;
      httpStatus: number;
      code:
        | "invalid_view_id"
        | "widget_unavailable"
        | "gateway_error"
        | "invalid_response"
        | "too_large"
        | "busy";
    };

/** The one RPC this module sends — the connection's `request`, narrowed. */
interface CanvasViewConnection {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export function isWidgetViewId(value: unknown): value is string {
  return typeof value === "string" && WIDGET_VIEW_ID_RE.test(value);
}

export async function fetchCanvasView(
  conn: CanvasViewConnection,
  docId: unknown,
): Promise<CanvasViewOutcome> {
  if (!isWidgetViewId(docId)) return { ok: false, httpStatus: 400, code: "invalid_view_id" };
  let frame: unknown;
  try {
    frame = await conn.request("canvas.document.view", { docId }, CANVAS_VIEW_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof GatewayAnsweredError && /^UNAVAILABLE\b/.test(err.message)) {
      return { ok: false, httpStatus: 404, code: "widget_unavailable" };
    }
    return { ok: false, httpStatus: 502, code: "gateway_error" };
  }
  const payload =
    frame && typeof frame === "object" && "payload" in frame
      ? (frame as { payload: unknown }).payload
      : undefined;
  const html =
    payload && typeof payload === "object" ? (payload as { html?: unknown }).html : undefined;
  if (typeof html !== "string") return { ok: false, httpStatus: 502, code: "invalid_response" };
  if (Buffer.byteLength(html, "utf8") > WIDGET_HTML_MAX_UTF8_BYTES) {
    return { ok: false, httpStatus: 502, code: "too_large" };
  }
  return { ok: true, html };
}

/** Bounds of the relay's cache (see CanvasViewCache). */
export const CANVAS_VIEW_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const CANVAS_VIEW_CACHE_TTL_MS = 10 * 60_000;
export const CANVAS_VIEW_MAX_CONCURRENT = 4;

/**
 * A small cache in front of `canvas.document.view`, and a bound on how many are asked
 * at once.
 *
 * Every reader of a conversation fetches each widget of it, on every render — and each
 * fetch costs the gateway a document read plus a short operator connection. A widget
 * document is written once under its id (`show_widget` mints a new `cv_` id per call),
 * so a successful answer is reused for a while: bounded by total bytes (LRU) and by
 * age, so a document the gateway later pruned does not live on here for long. Only
 * successes are cached. Identical concurrent asks share one fetch, and past
 * CANVAS_VIEW_MAX_CONCURRENT misses in flight the relay answers `busy` (retryable)
 * instead of opening more gateway connections.
 *
 * Authorization is NOT this cache's business: Convex decides who may read a view
 * before it asks the bridge, for every request.
 */
export class CanvasViewCache {
  private readonly entries = new Map<string, { html: string; bytes: number; at: number }>();
  private readonly inflight = new Map<string, Promise<CanvasViewOutcome>>();
  private bytes = 0;
  private active = 0;

  constructor(
    private readonly opts: {
      maxBytes?: number;
      ttlMs?: number;
      maxConcurrent?: number;
      now?: () => number;
    } = {},
  ) {}

  private get maxBytes(): number {
    return this.opts.maxBytes ?? CANVAS_VIEW_CACHE_MAX_BYTES;
  }

  async get(key: string, load: () => Promise<CanvasViewOutcome>): Promise<CanvasViewOutcome> {
    const now = (this.opts.now ?? Date.now)();
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      if (now - hit.at <= (this.opts.ttlMs ?? CANVAS_VIEW_CACHE_TTL_MS)) {
        this.entries.set(key, hit); // most recently used
        return { ok: true, html: hit.html };
      }
      this.bytes -= hit.bytes;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    if (this.active >= (this.opts.maxConcurrent ?? CANVAS_VIEW_MAX_CONCURRENT)) {
      return { ok: false, httpStatus: 429, code: "busy" };
    }
    this.active++;
    const promise = load()
      .then((out) => {
        if (out.ok) this.store(key, out.html, (this.opts.now ?? Date.now)());
        return out;
      })
      .finally(() => {
        this.active--;
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private store(key: string, html: string, at: number): void {
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as string;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { html, bytes, at });
    this.bytes += bytes;
  }

  /** Test seam: what the cache holds. */
  get size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}
