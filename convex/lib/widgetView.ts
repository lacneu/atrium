// The relay half of `GET /api/v1/widget-view` (convex/http.ts): given an AUTHORIZED
// view (convex/widgets.ts authorizeWidgetView), ask the instance's bridge for the
// document (`POST /canvas-view` -> gateway `canvas.document.view`) and turn the answer
// into the reader's response. Pure apart from the injected fetch, so every mapping is
// unit-tested (convex/widgetView.test.ts).
//
// WHY an HTTP action and not an action returning the string: a widget document may
// weigh 10 MiB from OpenClaw 2026.9.7 (`WIDGET_HTML_MAX_UTF8_BYTES`). An HTTP action's
// response is bounded at 20 MiB, a function's return value at 16 MiB and a document at
// 1 MiB (docs.convex.dev/production/state/limits; the self-hosted backend enforces the
// same `HttpResponseTooLarge` refusal). The bytes are passed straight through — never
// stored, never cached (`no-store`).

/** The bound this relay accepts (the gateway's own, from 2026.9.7). */
export const WIDGET_VIEW_MAX_BYTES = 10 * 1024 * 1024;
export const WIDGET_VIEW_TIMEOUT_MS = 20_000;
/** Widget documents one reader may fetch per minute (apiRateLimit window). */
export const WIDGET_VIEW_RATE_PER_MINUTE = 60;

export type WidgetViewFailure =
  | "busy"
  | "not_configured"
  | "widget_unavailable"
  | "bridge_error"
  | "too_large";

export type WidgetViewResult =
  | { ok: true; html: string }
  | { ok: false; status: number; code: WidgetViewFailure };

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function relayWidgetView(args: {
  bridgeUrl: string | null;
  sharedSecret: string | undefined;
  instanceName: string;
  viewId: string;
  fetchImpl: FetchLike;
}): Promise<WidgetViewResult> {
  if (!args.bridgeUrl || !args.sharedSecret) {
    return { ok: false, status: 503, code: "not_configured" };
  }
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await args.fetchImpl(`${args.bridgeUrl.replace(/\/$/, "")}/canvas-view`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: args.sharedSecret },
      body: JSON.stringify({ instanceName: args.instanceName, viewId: args.viewId }),
      signal: AbortSignal.timeout(WIDGET_VIEW_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 502, code: "bridge_error" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!res.ok) {
    const code = (record.error as { code?: unknown } | undefined)?.code;
    // The gateway's one UNAVAILABLE: unknown or pruned document (32 per session, oldest
    // evicted), or its sandbox listener could not bind. Retryable from the card.
    if (res.status === 404 && code === "widget_unavailable") {
      return { ok: false, status: 404, code: "widget_unavailable" };
    }
    // The bridge's concurrency bound: retryable.
    if (res.status === 429) return { ok: false, status: 503, code: "busy" };
    return { ok: false, status: 502, code: "bridge_error" };
  }
  const html = record.html;
  if (typeof html !== "string") return { ok: false, status: 502, code: "bridge_error" };
  if (new TextEncoder().encode(html).byteLength > WIDGET_VIEW_MAX_BYTES) {
    return { ok: false, status: 502, code: "too_large" };
  }
  return { ok: true, html };
}

/** Headers of the document response. `text/plain` + `nosniff` + a sandbox CSP: the
 *  body is agent-authored HTML, and this route lives on the Convex site origin — it
 *  must never render there, even if someone navigates to it. The browser reads it as
 *  text and hands it to a sandboxed frame. */
export const WIDGET_VIEW_DOCUMENT_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  "Referrer-Policy": "no-referrer",
};
