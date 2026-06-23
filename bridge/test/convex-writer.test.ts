// HttpConvexWriter delta coalescing — the BACKPRESSURE-ADAPTIVE contract.
//
// Prod incident: with fire-time buffer capture, a slow Convex backend (each
// ingest POST taking 0.5-3s) accumulated one ~50ms-of-text POST per flush window
// on the serialization chain; the queue grew unboundedly and the webchat kept
// "streaming" for MINUTES after the gateway had finished. The fix captures the
// buffer at CHAIN-EXECUTION time: while a POST is in flight, deltas accumulate
// in ONE buffer and the next executed flush carries ALL of them — one real POST
// per backend round-trip, no queue growth.

import { describe, expect, test, vi } from "vitest";
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

  test("noteMediaUndelivered -> dropped(generated_no_delivery), NO part, NO fetch", async () => {
    // The agent generated media (codex imageGeneration) but delivered none: a
    // content-free diagnostic only, never an upload or a media part.
    const { fetchImpl, sent } = mediaFlowFetch();
    const w = mediaWriter(fetchImpl); // no fetcher needed — nothing is fetched
    await w.noteMediaUndelivered("m1");
    await tick(10);
    const traces = sent.filter((s) => s.op === "mediaTrace");
    expect(traces).toHaveLength(1);
    expect(traces[0]?.phase).toBe("dropped");
    expect(traces[0]?.reason).toBe("generated_no_delivery");
    expect(sent.map((s) => s.op)).not.toContain("getUploadUrl");
    expect(sent.map((s) => s.op)).not.toContain("addMediaPart");
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

  test("EARLY STREAM ERROR (file vanished in the getUploadUrl window): dropped(read_error), NEVER an empty upload", async () => {
    // The fs stream errored BEFORE the first read (open() captured it via
    // readError()). Uploading it would stream 0 bytes and silently persist an EMPTY
    // attachment. addMedia must detect readError() after the getUploadUrl round-trip
    // and DROP. Discriminating: a fetcher whose readError() is null on the SAME
    // stream uploads normally (see SUCCESS) — only the non-null error forces the drop.
    const open: OpenResult = {
      ok: true,
      stream: Readable.from([Buffer.alloc(5)]),
      mimeType: "text/markdown",
      size: 5,
      readError: () => new Error("ENOENT: gone after stat"),
    };
    const { fetchImpl, sent } = mediaFlowFetch();
    const w = mediaWriter(fetchImpl, fakeFetcher(open));
    await w.addMedia("m1", { filename: "r.md", path: "/x/r.md" });
    await tick(10);
    expect(sent.map((s) => s.op)).toContain("getUploadUrl"); // got that far
    expect(sent.map((s) => s.op)).not.toContain("addMediaPart"); // but never persisted
    const traces = sent.filter((s) => s.op === "mediaTrace");
    expect(traces.map((t) => t.phase)).toEqual(["received", "dropped"]);
    expect(traces[traces.length - 1]?.reason).toBe("read_error");
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

// Bridge-never-falls hardening (audit CRITICAL): the writer used to funnel EVERY
// chat through ONE chain with no write deadline, so a slow/hung Convex backend (the
// listChats-saturation incident) wedged ALL chats. These pin the per-message chain
// + the write timeout + the delta cap.
describe("per-message chains + write timeout + delta cap (never-falls)", () => {
  test("a HELD op on one message does NOT block an op on a DIFFERENT message (no cross-chat wedge)", async () => {
    const { fetchImpl, sent, release } = controlledFetch();
    const w = writerWith(fetchImpl, 5);
    // m1's snapshot POST goes in flight and is HELD (slow Convex for that message).
    const p1 = w.setSnapshot("m1", "A");
    await tick(2);
    expect(sent.length).toBe(1); // m1's POST in flight, held
    // m2's snapshot must NOT wait behind m1 — with the old single global chain it
    // would; with per-message chains it posts independently.
    const p2 = w.setSnapshot("m2", "B");
    await tick(2);
    expect(sent.length).toBe(2); // m2 went through WITHOUT m1 being released
    release();
    release();
    await Promise.all([p1, p2]);
  });

  test("a single message's delta buffer is CAPPED (cannot grow without bound -> OOM)", async () => {
    const { fetchImpl, sent, release } = controlledFetch();
    const w = writerWith(fetchImpl, 5);
    const CAP = 256 * 1024;
    await w.appendDelta("m1", "x".repeat(CAP + 50_000)); // way over the cap
    await tick(15); // the flush POST goes in flight with the CAPPED buffer
    release();
    await tick(20);
    const appended = sent.filter((s) => s.op === "appendDelta");
    expect(appended.length).toBe(1);
    expect(appended[0]!.text!.length).toBe(CAP); // trimmed to the cap, not 306KB
  });

  test("finalize FORGETS the message even when its FINAL flush POST fails (memory bound holds on the failure path)", async () => {
    // A fetch that rejects the appendDelta flush (models Convex backpressure/timeout
    // on the very last flush) but would otherwise succeed.
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { op: string };
      if (body.op === "appendDelta") throw new Error("convex backpressure on flush");
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const w = writerWith(fetchImpl, 5);
    await w.appendDelta("m1", "buffered tail"); // arm a pending delta + flush timer
    expect(w.hasMessageState("m1")).toBe(true);
    // finalize flushes FIRST -> that POST throws -> finalize rejects (text re-buffered)
    await expect(w.finalize("m1", "complete", "final", null)).rejects.toThrow(
      /backpressure/,
    );
    // ...but the message MUST still be forgotten. The OLD code put forgetMessage in a
    // finally that began AFTER the flush, so a flush throw leaked the chain + the
    // re-buffered delta forever and stranded the message in `streaming`. Discriminating:
    // revert finalize to flush-before-try and this flips to true.
    expect(w.hasMessageState("m1")).toBe(false);
  });

  test("a hung Convex write TIMES OUT and rejects (self-heals; never wedges forever)", async () => {
    vi.useFakeTimers();
    // A fetch that only settles when its AbortSignal fires (models a hung backend).
    const fetchImpl = ((_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as unknown as typeof fetch;
    const w = writerWith(fetchImpl, 5);
    const p = w.setSnapshot("m1", "X").then(
      () => "resolved",
      (e) => (e as Error).message,
    );
    await vi.advanceTimersByTimeAsync(20_001); // past WRITE_TIMEOUT_MS
    expect(await p).toMatch(/timed out/i);
    vi.useRealTimers();
  });
});

// A fetch fake that resolves immediately + records the parsed op bodies. Lets a
// SEQUENCE of awaited writes run without manual release (the ordering under test
// here is the snapshot->op decision, not backpressure).
function autoFetch() {
  const sent: SentOp[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as SentOp);
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

// Reconstruct the server-side liveText from the posted ops, EXACTLY as Convex
// does (appendDelta -> append, setSnapshot -> replace). The whole point of the
// optimization is that this stays byte-identical to the snapshots fed in.
function liveTextOf(sent: SentOp[]): string {
  let t = "";
  for (const op of sent) {
    if (op.op === "appendDelta") t += op.text ?? "";
    else if (op.op === "setSnapshot") t = op.text ?? "";
  }
  return t;
}

describe("snapshot write-reduction (suffix-delta, heartbeat-preserving)", () => {
  test("a snapshot that STRICTLY EXTENDS the last write goes out as a SUFFIX delta", async () => {
    const { fetchImpl, sent } = autoFetch();
    const w = writerWith(fetchImpl);
    await w.setSnapshot("m1", "Hello");
    await w.setSnapshot("m1", "Hello world");
    await w.setSnapshot("m1", "Hello world!");
    // Only the new bytes each time — never the full 2KB re-write.
    expect(sent).toEqual([
      { op: "appendDelta", messageId: "m1", text: "Hello" },
      { op: "appendDelta", messageId: "m1", text: " world" },
      { op: "appendDelta", messageId: "m1", text: "!" },
    ]);
    // …and the reconstructed liveText is identical to the last snapshot.
    expect(liveTextOf(sent)).toBe("Hello world!");
  });

  test("a snapshot identical to the last write still WRITES (full setSnapshot) to keep the watchdog heartbeat", async () => {
    const { fetchImpl, sent } = autoFetch();
    const w = writerWith(fetchImpl);
    await w.setSnapshot("m1", "abc");
    await w.setSnapshot("m1", "abc"); // byte-identical re-send (seen live)
    // NOT skipped: a skipped write would stop bumping `updatedAt`, and
    // reconcileStuckStreams reaps a `streaming` message stale >12min. The identical
    // frame falls to a full setSnapshot (stream.ts re-stamps updatedAt).
    expect(sent).toEqual([
      { op: "appendDelta", messageId: "m1", text: "abc" }, // first: suffix from empty
      { op: "setSnapshot", messageId: "m1", text: "abc" }, // identical: re-stamp
    ]);
    expect(liveTextOf(sent)).toBe("abc");
  });

  test("a NON-extension snapshot (revision/shrink) falls back to a full setSnapshot", async () => {
    const { fetchImpl, sent } = autoFetch();
    const w = writerWith(fetchImpl);
    await w.setSnapshot("m1", "the quick brown fox");
    await w.setSnapshot("m1", "the quick red fox"); // diverges at "red" -> not a prefix
    expect(sent[1]).toEqual({
      op: "setSnapshot",
      messageId: "m1",
      text: "the quick red fox",
    });
    expect(liveTextOf(sent)).toBe("the quick red fox");
  });

  test("a snapshot extending DELTAS already streamed emits only the new suffix", async () => {
    const { fetchImpl, sent } = autoFetch();
    const w = writerWith(fetchImpl);
    await w.appendDelta("m1", "ab"); // buffered; setSnapshot's flush drains it first
    await w.setSnapshot("m1", "abcd");
    expect(sent).toEqual([
      { op: "appendDelta", messageId: "m1", text: "ab" },
      { op: "appendDelta", messageId: "m1", text: "cd" },
    ]);
    expect(liveTextOf(sent)).toBe("abcd");
  });

  test("end-to-end: a realistic snapshot stream reconstructs the exact final text", async () => {
    const { fetchImpl, sent } = autoFetch();
    const w = writerWith(fetchImpl);
    // extend, extend, identical, extend, revise, extend.
    for (const s of [
      "Si par", // appendDelta "Si par"   (suffix from empty)
      "Si par ces", // appendDelta " ces"
      "Si par ces", // setSnapshot (identical -> heartbeat)
      "Si par ces documents", // appendDelta " documents"
      "Si par CES documents", // setSnapshot (revision: not a prefix)
      "Si par CES documents tu", // appendDelta " tu"
    ]) {
      await w.setSnapshot("m1", s);
    }
    // The extensions stay tiny suffix deltas; only the identical + the revision are
    // full setSnapshots. The reconstructed liveText is byte-exact regardless.
    expect(sent.filter((o) => o.op === "setSnapshot")).toHaveLength(2);
    expect(sent.filter((o) => o.op === "appendDelta")).toHaveLength(4);
    expect(liveTextOf(sent)).toBe("Si par CES documents tu");
  });

  test("CONTENTION: a snapshot extending an IN-FLIGHT delta stays byte-exact when posts settle in order", async () => {
    const { fetchImpl, sent, release, inFlight } = controlledFetch();
    const w = writerWith(fetchImpl, 5);
    // Delta "ab" buffered, then flushed -> POST#1 goes in flight (HELD).
    await w.appendDelta("m1", "ab");
    await tick(15);
    expect(sent.map((s) => s.text)).toEqual(["ab"]);
    expect(inFlight()).toBe(1);
    // While POST#1 is still in flight, a snapshot that extends the (not-yet-acked)
    // text is requested. setSnapshot's own flushDelta + the per-message chain force
    // it to run AFTER POST#1 settles, so confirmedText is "ab" when it diffs.
    const snap = w.setSnapshot("m1", "abcd");
    release(); // POST#1 ("ab") acks -> confirmedText = "ab"
    await tick(0);
    release(); // POST#2 (the suffix) acks
    await snap;
    expect(sent).toEqual([
      { op: "appendDelta", messageId: "m1", text: "ab" },
      { op: "appendDelta", messageId: "m1", text: "cd" }, // suffix, not "abcd"
    ]);
    expect(liveTextOf(sent)).toBe("abcd");
  });

  test("FAILURE: after a failed suffix the NEXT snapshot FULL-REPLACES (appendDelta is not idempotent)", async () => {
    const { fetchImpl, sent, release, fail } = controlledFetch();
    const w = writerWith(fetchImpl, 5);
    const p0 = w.setSnapshot("m1", "ab"); // POST#1 (appendDelta "ab" from empty), held
    await tick(0);
    release(); // acks -> confirmedText = "ab"
    await p0;

    // Next snapshot extends -> suffix "cd"; its post FAILS. A timeout is NOT proof
    // the mutation didn't land server-side.
    const p = w.setSnapshot("m1", "abcd").then(
      () => "ok",
      () => "threw",
    );
    await tick(0);
    fail(); // the suffix post rejects
    expect(await p).toBe("threw"); // the caller sees the error (this.post propagates)

    // The next snapshot must NOT re-send a suffix (that could DOUBLE "cd" if the
    // failed delta actually applied). It full-replaces, correcting liveText whether
    // or not "cd" landed.
    const p2 = w.setSnapshot("m1", "abcdef");
    await tick(0);
    release(); // the full-snapshot post acks
    await p2;
    expect(sent.at(-1)).toEqual({
      op: "setSnapshot",
      messageId: "m1",
      text: "abcdef",
    });
    // Worst case (the failed "cd" DID apply): liveText = "ab"+"cd" then replaced ->
    // exactly "abcdef". No doubling.
    expect(liveTextOf(sent)).toBe("abcdef");
  });

  test("FAILURE (delta flush): a failed appendDelta FLUSH also forces the next snapshot to full-replace", async () => {
    // The first POST (the delta flush) fails; everything after succeeds.
    const sent: SentOp[] = [];
    let i = 0;
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as SentOp);
      if (i++ === 0) {
        throw Object.assign(new Error("ingest down"), { name: "Error" });
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const w = writerWith(fetchImpl, 5);

    await w.appendDelta("m1", "ab");
    await tick(15); // timer flush posts appendDelta("ab") -> FAILS (re-buffer + resync)
    // A snapshot extends the (ambiguously-applied) prefix. Because the flush failed,
    // it must NOT trust confirmedText and emit a suffix — it full-replaces.
    await w.setSnapshot("m1", "abcd");
    expect(sent.at(-1)).toEqual({
      op: "setSnapshot",
      messageId: "m1",
      text: "abcd",
    });
    // Even if the failed "ab" applied AND the retry re-applied it (doubling), the
    // full setSnapshot corrects liveText to exactly "abcd".
    expect(liveTextOf(sent)).toBe("abcd");
  });

  test("FAILURE (full snapshot): a failed full setSnapshot also forces the next snapshot to full-replace", async () => {
    const { fetchImpl, sent, release, fail } = controlledFetch();
    const w = writerWith(fetchImpl, 5);
    const p0 = w.setSnapshot("m1", "abc"); // appendDelta "abc" from empty, held
    await tick(0);
    release();
    await p0; // confirmedText = "abc"

    // An identical frame takes the FULL setSnapshot branch (heartbeat) — and FAILS.
    const p = w.setSnapshot("m1", "abc").then(
      () => "ok",
      () => "threw",
    );
    await tick(0);
    fail();
    expect(await p).toBe("threw");

    // The next frame extends "abc". Without the resync flag it would go out as a
    // suffix onto a liveText the failed (maybe-applied) snapshot already touched; it
    // must full-replace instead (the full branch's failure must also set resync).
    const p2 = w.setSnapshot("m1", "abcd");
    await tick(0);
    release();
    await p2;
    expect(sent.at(-1)).toEqual({
      op: "setSnapshot",
      messageId: "m1",
      text: "abcd",
    });
  });

  test("per-message state (incl. the new confirmedText) is evicted on finalize", async () => {
    const { fetchImpl } = autoFetch();
    const w = writerWith(fetchImpl);
    await w.setSnapshot("m1", "hello");
    expect(w.hasMessageState("m1")).toBe(true);
    await w.finalize("m1", "complete", "hello", null);
    expect(w.hasMessageState("m1")).toBe(false);
  });
});
