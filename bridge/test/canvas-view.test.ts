// `/canvas-view` relays ONE widget document (canvas.document.view), replayed from the
// responses captured live on the 2026.9.6 bench. The gateway scopes nothing — any
// operator.read socket reads any document by id — so the relay's own job is narrow:
// refuse an id that is not a managed widget view before any RPC, map the gateway's
// single UNAVAILABLE (unknown, pruned, or sandbox listener unbindable) to "widget
// unavailable", and bound the bytes.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CanvasViewCache,
  WIDGET_HTML_MAX_UTF8_BYTES,
  fetchCanvasView,
} from "../src/providers/openclaw/canvas-view.js";
import { GatewayAnsweredError } from "../src/providers/openclaw/openclaw-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURE = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/widgets/canvas-view-2026.9.6.json"), "utf-8"),
) as {
  request: { method: string; params: { docId: string } };
  ok: { payload: { html: string; sandboxUrl: string; sandboxPort: number } };
  unavailable: { error: { code: string; message: string } };
  unknownDoc: { error: { code: string; message: string } };
};

/** A connection that answers like the gateway did, and records what was asked. */
function conn(answer: () => Promise<unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      return answer();
    },
  };
}

const refusal = (e: { code: string; message: string }) =>
  new GatewayAnsweredError(`${e.code}: ${e.message}`);

describe("canvas.document.view relay", () => {
  it("sends exactly the captured request and returns the document", async () => {
    const c = conn(async () => ({ type: "res", ok: true, payload: CAPTURE.ok.payload }));
    const out = await fetchCanvasView(c, CAPTURE.request.params.docId);
    expect(c.calls).toEqual([{ method: CAPTURE.request.method, params: CAPTURE.request.params }]);
    expect(out).toEqual({ ok: true, html: CAPTURE.ok.payload.html });
  });

  it("UNAVAILABLE (sandbox port held, or unknown/pruned doc) -> widget_unavailable", async () => {
    for (const e of [CAPTURE.unavailable.error, CAPTURE.unknownDoc.error]) {
      const out = await fetchCanvasView(conn(async () => Promise.reject(refusal(e))), CAPTURE.request.params.docId);
      expect(out).toEqual({ ok: false, httpStatus: 404, code: "widget_unavailable" });
    }
  });

  it("any other failure is the gateway's, not the widget's", async () => {
    const other = await fetchCanvasView(
      conn(async () => Promise.reject(refusal({ code: "INVALID_REQUEST", message: "x" }))),
      CAPTURE.request.params.docId,
    );
    expect(other).toEqual({ ok: false, httpStatus: 502, code: "gateway_error" });
    const timeout = await fetchCanvasView(conn(async () => Promise.reject(new Error("timed out"))), CAPTURE.request.params.docId);
    expect(timeout).toEqual({ ok: false, httpStatus: 502, code: "gateway_error" });
  });

  it("refuses a non-widget id BEFORE any RPC", async () => {
    for (const bad of ["../etc", "board-x", "cv_", "", 42, null, "cv_a/b"]) {
      const c = conn(async () => ({ payload: CAPTURE.ok.payload }));
      expect(await fetchCanvasView(c, bad)).toEqual({ ok: false, httpStatus: 400, code: "invalid_view_id" });
      expect(c.calls).toEqual([]);
    }
  });

  it("bounds the document and refuses a malformed answer", async () => {
    const big = "x".repeat(WIDGET_HTML_MAX_UTF8_BYTES + 1);
    expect(
      await fetchCanvasView(conn(async () => ({ payload: { html: big } })), CAPTURE.request.params.docId),
    ).toEqual({ ok: false, httpStatus: 502, code: "too_large" });
    expect(
      await fetchCanvasView(conn(async () => ({ payload: {} })), CAPTURE.request.params.docId),
    ).toEqual({ ok: false, httpStatus: 502, code: "invalid_response" });
  });
});

describe("the relay's cache and concurrency bound", () => {
  const ok = (html: string) => async () => ({ ok: true as const, html });

  it("serves a document once per id while fresh, then asks again", async () => {
    let now = 0;
    const cache = new CanvasViewCache({ ttlMs: 1000, now: () => now });
    let loads = 0;
    const load = async () => {
      loads++;
      return { ok: true as const, html: "<p>x</p>" };
    };
    await cache.get("a", load);
    await cache.get("a", load);
    expect(loads).toBe(1);
    now = 2000;
    await cache.get("a", load);
    expect(loads).toBe(2);
  });

  it("never caches a failure", async () => {
    const cache = new CanvasViewCache();
    let loads = 0;
    const fail = async () => {
      loads++;
      return { ok: false as const, httpStatus: 404, code: "widget_unavailable" as const };
    };
    await cache.get("a", fail);
    await cache.get("a", fail);
    expect(loads).toBe(2);
  });

  it("shares one fetch between identical concurrent asks, and refuses past the bound", async () => {
    const cache = new CanvasViewCache({ maxConcurrent: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let loads = 0;
    const slow = async () => {
      loads++;
      await gate;
      return { ok: true as const, html: "x" };
    };
    const a1 = cache.get("a", slow);
    const a2 = cache.get("a", slow);
    expect(await cache.get("b", ok("y"))).toEqual({ ok: false, httpStatus: 429, code: "busy" });
    release();
    expect(await a1).toEqual({ ok: true, html: "x" });
    expect(await a2).toEqual({ ok: true, html: "x" });
    expect(loads).toBe(1);
  });

  it("is bounded in bytes (least recently used goes first)", async () => {
    const cache = new CanvasViewCache({ maxBytes: 10 });
    await cache.get("a", ok("12345"));
    await cache.get("b", ok("12345"));
    await cache.get("a", ok("zzzzz")); // a is now the most recent
    await cache.get("c", ok("12345")); // evicts b
    expect(cache.size).toEqual({ entries: 2, bytes: 10 });
    let reloaded = false;
    await cache.get("b", async () => {
      reloaded = true;
      return { ok: true as const, html: "12345" };
    });
    expect(reloaded).toBe(true);
    await cache.get("big", ok("x".repeat(11))); // larger than the whole budget: not kept
    expect(cache.size.bytes).toBeLessThanOrEqual(10);
  });
});
