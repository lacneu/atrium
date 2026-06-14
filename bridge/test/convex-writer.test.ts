// HttpConvexWriter delta coalescing — the BACKPRESSURE-ADAPTIVE contract.
//
// Prod incident: with fire-time buffer capture, a slow Convex backend (each
// ingest POST taking 0.5-3s) accumulated one ~50ms-of-text POST per flush window
// on the serialization chain; the queue grew unboundedly and the webchat kept
// "streaming" for MINUTES after the gateway had finished. The fix captures the
// buffer at CHAIN-EXECUTION time: while a POST is in flight, deltas accumulate
// in ONE buffer and the next executed flush carries ALL of them — one real POST
// per backend round-trip, no queue growth.

import { describe, expect, test } from "vitest";
import { HttpConvexWriter } from "../src/convex-writer";

type SentOp = { op: string; messageId?: string; text?: string };

/** A fetch fake whose in-flight requests are released MANUALLY (deterministic). */
function controlledFetch() {
  const sent: SentOp[] = [];
  const pending: Array<{
    resolve: (r: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as SentOp);
    return await new Promise((resolve, reject) => {
      pending.push({
        resolve: () =>
          resolve({ ok: true, json: async () => ({}) } as unknown as Response),
        reject,
      });
    });
  }) as unknown as typeof fetch;
  const release = () => pending.shift()?.resolve(undefined);
  const fail = () =>
    pending
      .shift()
      ?.reject(Object.assign(new Error("ingest down"), { name: "Error" }));
  return { fetchImpl, sent, release, fail, inFlight: () => pending.length };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function writerWith(fetchImpl: typeof fetch, deltaFlushMs = 5) {
  return new HttpConvexWriter({
    convexHttpActionsUrl: "http://test.invalid",
    ingestSecret: "s",
    deltaFlushMs,
    fetchImpl,
  });
}

describe("delta coalescing under backpressure (the prod fix)", () => {
  test("deltas arriving WHILE a POST is in flight all leave in ONE follow-up POST", async () => {
    const { fetchImpl, sent, release } = controlledFetch();
    const w = writerWith(fetchImpl, 5);

    // First delta -> after the 5ms window, POST#1 ("a") goes in flight (held).
    await w.appendDelta("m1", "a");
    await tick(15);
    expect(sent.map((s) => s.text)).toEqual(["a"]);

    // While POST#1 is STILL IN FLIGHT, more deltas arrive across several flush
    // windows. Fire-time capture would enqueue one POST per window ("b", then
    // "c", then "d"); execution-time capture accumulates them in ONE buffer.
    await w.appendDelta("m1", "b");
    await tick(12);
    await w.appendDelta("m1", "c");
    await tick(12);
    await w.appendDelta("m1", "d");
    await tick(12);
    expect(sent.length).toBe(1); // nothing else left while #1 is in flight

    // Release POST#1 -> the chain advances; the next REAL flush carries "bcd".
    release();
    await tick(20);
    release(); // release POST#2
    await tick(20);

    const appended = sent.filter((s) => s.op === "appendDelta");
    expect(appended.map((s) => s.text)).toEqual(["a", "bcd"]);
    // Full text preserved, in order, with NO per-window queue growth.
    expect(appended.map((s) => s.text).join("")).toBe("abcd");
  });

  test("a FAILED flush re-buffers its text (nothing lost) and the next flush retries it FIRST", async () => {
    const { fetchImpl, sent, release, fail } = controlledFetch();
    const w = writerWith(fetchImpl, 5);

    await w.appendDelta("m1", "a");
    await tick(15); // POST#1 ("a") in flight
    fail(); // ingest 5xx / network error
    await tick(10);

    // New delta after the failure: the retry flush must carry "a" + "b".
    await w.appendDelta("m1", "b");
    await tick(15);
    release();
    await tick(20);

    const appended = sent.filter((s) => s.op === "appendDelta");
    expect(appended.map((s) => s.text)).toEqual(["a", "ab"]);
  });

  test("setSnapshot drains pending deltas FIRST (ordering preserved)", async () => {
    const { fetchImpl, sent, release } = controlledFetch();
    // Huge window: the timer never fires by itself in this test.
    const w = writerWith(fetchImpl, 10_000);

    await w.appendDelta("m1", "early");
    const snap = w.setSnapshot("m1", "FULL");
    await tick(10);
    release(); // appendDelta("early")
    await tick(10);
    release(); // setSnapshot
    await snap;

    expect(sent.map((s) => s.op)).toEqual(["appendDelta", "setSnapshot"]);
    expect(sent[0]?.text).toBe("early");
  });
});

describe("reportSessionMeta is OFF the serialization chain (Codex review #12)", () => {
  test("a HUNG meta POST never blocks the turn's critical writes (startAssistant)", async () => {
    // fetch that HANGS forever on setSessionMeta but resolves everything else.
    let metaDispatched = 0;
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { op: string };
      if (body.op === "setSessionMeta") {
        metaDispatched++;
        return await new Promise<Response>(() => {}); // never resolves
      }
      return {
        ok: true,
        json: async () => ({ messageId: "m1" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const w = writerWith(fetchImpl);

    // Fire-and-forget the meta (hangs forever), then do a turn-CRITICAL write.
    // On-chain (the bug) startAssistant would queue behind the hung meta and
    // never resolve; off-chain (the fix) it resolves immediately.
    void w.reportSessionMeta("c1", { model: "x" }).catch(() => {});
    const id = await Promise.race([
      w.startAssistant("c1", "run-1"),
      tick(250).then(() => "TIMEOUT" as const),
    ]);

    expect(metaDispatched).toBe(1); // the meta POST WAS dispatched (and is hung)
    expect(id).toBe("m1"); // startAssistant resolved despite the hung meta
  });
});
