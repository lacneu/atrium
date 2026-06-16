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
import { Readable } from "node:stream";
import { HttpConvexWriter, bytesBucket } from "../src/convex-writer";
import {
  MEDIA_TOO_LARGE_CODE,
  type MediaFetcher,
  type OpenResult,
} from "../src/core/media-fetcher";

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

// ---------------------------------------------------------------------------
// Outbound-media DIAGNOSTIC (openclaw.media trace) — addMedia behaviour, every
// branch (success + each failure), the SOC2 codes/buckets it emits, and the
// off-chain guarantee (a hung diagnostic must never block the turn — Codex P2).
// ---------------------------------------------------------------------------

const UPLOAD_URL = "http://upload.invalid";

/** Records ingest ops; serves getUploadUrl + the streamToUploadUrl POST. */
function mediaFlowFetch(opts?: {
  uploadFails?: boolean;
  uploadNoStorageId?: boolean;
  hangMediaTrace?: boolean;
  uploadThrows?: unknown;
}) {
  const sent: Array<{
    op: string;
    phase?: string;
    reason?: string;
    bytesBucket?: string;
    mimeBase?: string;
    messageId?: string;
  }> = [];
  const fetchImpl = (async (url: unknown, init: { body: unknown }) => {
    // The streamToUploadUrl POST goes to the pre-signed upload URL (body = stream).
    if (url === UPLOAD_URL) {
      if (opts?.uploadThrows !== undefined) {
        // Mimic fetch/undici rejecting when the request-body stream errors
        // mid-send (e.g. the byte-cap Transform fires past the limit).
        throw opts.uploadThrows;
      }
      if (opts?.uploadFails) {
        return {
          ok: false,
          status: 500,
          text: async () => "upload boom",
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => (opts?.uploadNoStorageId ? {} : { storageId: "st_1" }),
      } as unknown as Response;
    }
    // Everything else is an ingest op (body = JSON).
    const body = JSON.parse(init.body as string) as { op: string };
    sent.push(body as (typeof sent)[number]);
    if (body.op === "mediaTrace" && opts?.hangMediaTrace) {
      return await new Promise<Response>(() => {}); // never resolves
    }
    if (body.op === "getUploadUrl") {
      return {
        ok: true,
        json: async () => ({ uploadUrl: UPLOAD_URL }),
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const okOpen = (size = 5, mimeType = "text/markdown"): OpenResult => ({
  ok: true,
  stream: Readable.from([Buffer.alloc(size)]),
  mimeType,
  size,
});
const fakeFetcher = (result: OpenResult | (() => OpenResult)): MediaFetcher => ({
  open: async () => (typeof result === "function" ? result() : result),
});

function mediaWriter(fetchImpl: typeof fetch, mediaFetcher?: MediaFetcher) {
  return new HttpConvexWriter({
    convexHttpActionsUrl: "http://test.invalid",
    ingestSecret: "s",
    fetchImpl,
    mediaFetcher,
  });
}

describe("bytesBucket: unknown vs empty", () => {
  test("null/undefined/NaN size => 'unknown' (NOT '0' — would read as empty)", () => {
    expect(bytesBucket(null)).toBe("unknown");
    expect(bytesBucket(undefined)).toBe("unknown");
    expect(bytesBucket(Number.NaN)).toBe("unknown");
  });
  test("a genuine 0 stays '0'; positive sizes bucket normally", () => {
    expect(bytesBucket(0)).toBe("0");
    expect(bytesBucket(5)).toBe("<1KB");
    expect(bytesBucket(2048)).toBe("1KB-100KB");
  });
});

describe("addMedia outbound diagnostic (openclaw.media)", () => {
  test("UNKNOWN SIZE (chunked, no Content-Length): stored bucket is 'unknown', NOT '0'", async () => {
    // A chunked gateway-http download has no size up front -> OpenedMedia.size is
    // null. The `stored` diagnostic must bucket it as "unknown", never "0" (which
    // reads as an empty file). The real byte count is captured server-side (the
    // addMediaPart ingest trace reads _storage).
    const { fetchImpl, sent } = mediaFlowFetch();
    const nullSize: OpenResult = {
      ok: true,
      stream: Readable.from([Buffer.from("hi")]),
      mimeType: "text/markdown",
      size: null,
    };
    const w = mediaWriter(fetchImpl, fakeFetcher(nullSize));
    await w.addMedia("m1", { filename: "r.md", path: "/x/r.md" });
    await tick(10);
    const stored = sent
      .filter((s) => s.op === "mediaTrace")
      .find((t) => t.phase === "stored");
    expect(stored?.bytesBucket).toBe("unknown");
  });

  test("SUCCESS: received -> getUploadUrl -> addMediaPart -> stored(bytesBucket,mimeBase)", async () => {
    const { fetchImpl, sent } = mediaFlowFetch();
    const w = mediaWriter(fetchImpl, fakeFetcher(okOpen(5, "text/markdown")));
    await w.addMedia("m1", {
      filename: "r.md",
      path: "/home/node/.openclaw/media/outbound/r.md",
    });
    await tick(10);
    const ops = sent.map((s) => s.op);
    expect(ops).toContain("getUploadUrl");
    expect(ops).toContain("addMediaPart");
    const traces = sent.filter((s) => s.op === "mediaTrace");
    expect(traces.map((t) => t.phase)).toEqual(["received", "stored"]);
    const stored = traces.find((t) => t.phase === "stored");
    expect(stored?.bytesBucket).toBe("<1KB");
    expect(stored?.mimeBase).toBe("text");
    // SOC2: the diagnostic ops carry NO filename / path / content.
    for (const t of traces) {
      expect(JSON.stringify(t)).not.toContain("r.md");
      expect(JSON.stringify(t)).not.toContain("outbound");
    }
  });

  test("NO FETCHER: received -> dropped(no_fetcher), no upload at all", async () => {
    const { fetchImpl, sent } = mediaFlowFetch();
    const w = mediaWriter(fetchImpl, undefined); // no mediaFetcher
    await w.addMedia("m1", { filename: "r.md", path: "/x/r.md" });
    await tick(10);
    expect(sent.map((s) => s.op)).not.toContain("getUploadUrl");
    const traces = sent.filter((s) => s.op === "mediaTrace");
    expect(traces.map((t) => t.phase)).toEqual(["received", "dropped"]);
    expect(traces[1]?.reason).toBe("no_fetcher");
  });

  test.each([
    "not_found",
    "too_large",
    "path_escape",
    "symlink_rejected",
    "not_a_file",
    "invalid_filename",
    "route_absent",
  ] as const)(
    "OPEN FAILS (%s): received -> dropped(reason), no upload",
    async (reason) => {
      const { fetchImpl, sent } = mediaFlowFetch();
      const w = mediaWriter(fetchImpl, fakeFetcher({ ok: false, reason }));
      await w.addMedia("m1", { filename: "r.md", path: "/x/r.md" });
      await tick(10);
      expect(sent.map((s) => s.op)).not.toContain("getUploadUrl");
      expect(sent.map((s) => s.op)).not.toContain("addMediaPart");
      const traces = sent.filter((s) => s.op === "mediaTrace");
      expect(traces.map((t) => t.phase)).toEqual(["received", "dropped"]);
      expect(traces[1]?.reason).toBe(reason);
    },
  );

  test("UPLOAD ERROR: received -> getUploadUrl -> dropped(upload_error), no addMediaPart", async () => {
    const { fetchImpl, sent } = mediaFlowFetch({ uploadFails: true });
    const w = mediaWriter(fetchImpl, fakeFetcher(okOpen()));
    await w.addMedia("m1", { filename: "r.md", path: "/x/r.md" });
    await tick(10);
    expect(sent.map((s) => s.op)).toContain("getUploadUrl");
    expect(sent.map((s) => s.op)).not.toContain("addMediaPart");
    const traces = sent.filter((s) => s.op === "mediaTrace");
    expect(traces.map((t) => t.phase)).toEqual(["received", "dropped"]);
    expect(traces[traces.length - 1]?.reason).toBe("upload_error");
  });

  test("STREAMED CAP (code on the error): dropped(too_large), NOT upload_error", async () => {
    // When the gateway omits Content-Length/size the cap can only fire mid-upload
    // (the byteCap Transform). That surfaces AFTER open() returned ok, so the
    // catch must still map it to too_large — the real fix is cap/size, not storage.
    const capErr = Object.assign(new Error("media exceeds cap"), {
      code: MEDIA_TOO_LARGE_CODE,
    });
    const { fetchImpl, sent } = mediaFlowFetch({ uploadThrows: capErr });
    const w = mediaWriter(fetchImpl, fakeFetcher(okOpen()));
    await w.addMedia("m1", { filename: "r.md", path: "/x/r.md" });
    await tick(10);
    expect(sent.map((s) => s.op)).not.toContain("addMediaPart");
    const traces = sent.filter((s) => s.op === "mediaTrace");
    expect(traces[traces.length - 1]?.reason).toBe("too_large");
  });

  test("STREAMED CAP (wrapped as fetch .cause): still dropped(too_large)", async () => {
    // fetch/undici wraps a request-body stream error: the original becomes .cause.
    // causedByTooLarge walks the chain, so the diagnostic is right either way.
    const wrapped = Object.assign(new TypeError("terminated"), {
      cause: Object.assign(new Error("media exceeds cap"), {
        code: MEDIA_TOO_LARGE_CODE,
      }),
    });
    const { fetchImpl, sent } = mediaFlowFetch({ uploadThrows: wrapped });
    const w = mediaWriter(fetchImpl, fakeFetcher(okOpen()));
    await w.addMedia("m1", { filename: "r.md", path: "/x/r.md" });
    await tick(10);
    const traces = sent.filter((s) => s.op === "mediaTrace");
    expect(traces[traces.length - 1]?.reason).toBe("too_large");
  });

  test("UPLOAD returns 200 but NO storageId: dropped(upload_error), no addMediaPart", async () => {
    // streamToUploadUrl throws "no storageId" on a 200-without-storageId response;
    // addMedia must catch it, persist NO part, and record the diagnostic.
    const { fetchImpl, sent } = mediaFlowFetch({ uploadNoStorageId: true });
    const w = mediaWriter(fetchImpl, fakeFetcher(okOpen()));
    await w.addMedia("m1", { filename: "r.md", path: "/x/r.md" });
    await tick(10);
    expect(sent.map((s) => s.op)).toContain("getUploadUrl");
    expect(sent.map((s) => s.op)).not.toContain("addMediaPart");
    const traces = sent.filter((s) => s.op === "mediaTrace");
    expect(traces[traces.length - 1]?.reason).toBe("upload_error");
  });

  test("OFF-CHAIN (Codex P2): a HUNG mediaTrace never blocks the media writes", async () => {
    // The `received` mediaTrace POST hangs forever; addMedia must STILL complete
    // its real ops (getUploadUrl + addMediaPart) and resolve. On-chain (the bug)
    // it would queue behind the hung trace and time out.
    const { fetchImpl, sent } = mediaFlowFetch({ hangMediaTrace: true });
    const w = mediaWriter(fetchImpl, fakeFetcher(okOpen()));
    const outcome = await Promise.race([
      w.addMedia("m1", { filename: "r.md", path: "/x/r.md" }).then(() => "DONE"),
      tick(300).then(() => "TIMEOUT" as const),
    ]);
    expect(outcome).toBe("DONE");
    expect(sent.map((s) => s.op)).toContain("addMediaPart"); // real write happened
  });
});
