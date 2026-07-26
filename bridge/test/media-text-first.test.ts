// The TEXT-FIRST media contract (report ms70hx1c… 2026-07-05): a large media
// upload must NOT gate the reply text. Four invariants, each pinned below:
//   1. text visible BEFORE the (slow) media upload completes
//   2. media never dropped — the part still attaches
//   3. finalize (→ complete) lands LAST, after the media (busy window unchanged)
//   4. part order stable — text snapshot then media part
//
// The fake writer makes addMedia SLOW (a controllable gate) and records the
// ORDER of every write, so the assertions are on sequence, not wall-clock.

import { describe, expect, it } from "vitest";
import { TurnSink } from "../src/core/turn-sink.js";
import type {
  ConvexWriter,
  FinalizeStatus,
} from "../src/convex-writer.js";

type Ev = string;

class OrderingWriter implements ConvexWriter {
  readonly order: Ev[] = [];
  private releaseUpload!: () => void;
  readonly uploadGate = new Promise<void>((r) => {
    this.releaseUpload = r;
  });
  release() {
    this.releaseUpload();
  }

  async startAssistant(): Promise<string> {
    return "msg_1";
  }
  async appendDelta(_messageId: string, _text: string): Promise<void> {}
  refuseShorter = false;
  private lastSnapshot = "";
  async setSnapshot(
    _messageId: string,
    text: string,
    replace?: boolean,
  ): Promise<boolean> {
    if (
      this.refuseShorter &&
      replace !== true &&
      text.length < this.lastSnapshot.length
    ) {
      this.order.push(`snapshot-refused:${text}`);
      return false;
    }
    this.lastSnapshot = text;
    this.order.push(`snapshot:${text}`);
    return true;
  }
  readonly toolParts: { textOffset?: number; toolCallId?: string; phase?: string }[] =
    [];
  /** When set, an addToolPart of THIS phase throws (a transient write failure). */
  failToolPhase: string | null = null;
  async addToolPart(
    _messageId: string,
    part: { textOffset?: number; toolCallId?: string; phase?: string },
  ): Promise<void> {
    if (this.failToolPhase !== null && part.phase === this.failToolPhase) {
      throw new Error("transient write failure");
    }
    this.toolParts.push(part);
  }
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  // When set, a mention-only (explicit !== true) addMedia REJECTS the file
  // (simulating a failed freshness gate) so the explicit-rescue path is testable.
  failMentions = false;
  async addMedia(
    _messageId: string,
    media: { explicit?: boolean },
  ): Promise<boolean> {
    const kind = media.explicit === true ? "explicit" : "mention";
    this.order.push(`addMedia:${kind}:start`);
    if (this.failMentions && media.explicit !== true) {
      this.order.push(`addMedia:${kind}:dropped`);
      return false;
    }
    await this.uploadGate; // held until release() — simulates a SLOW upload
    this.order.push(`addMedia:${kind}:done`);
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  lastFinalizeKind: string | null = null;
  async finalize(
    _messageId: string,
    status: FinalizeStatus,
    _text: string,
    _error: string | null,
    errorKind: string | null,
  ): Promise<void> {
    this.lastFinalizeKind = errorKind;
    this.order.push(`finalize:${status}${errorKind ? `:${errorKind}` : ""}`);
  }
  async getRehydrationContext(): Promise<{
    history: string | null;
    turnCount: number;
  }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

describe("text-first media delivery (report ms70hx1c…)", () => {
  it("writes the reply text BEFORE the slow media upload finishes, finalizes LAST", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_1", writer);
    await sink.beginTurn("run-1");

    // The terminal batch: media (fires the background upload), then the reply
    // text, then the run terminal. apply() resolves only after flushFinal, so
    // drive it WITHOUT awaiting and release the upload once the text has landed.
    const applied = sink.apply([
      { type: "media", items: [{ filename: "video.mp4", path: "/out/video.mp4", explicit: true }] },
      { type: "message.final", text: "Voici le fichier." },
      { type: "run.status", status: "final" },
    ]);

    // Let the microtasks run up to the upload gate. The text snapshot must be
    // recorded already; the media upload is in flight (not done); finalize has
    // NOT fired.
    await new Promise((r) => setTimeout(r, 5));
    expect(writer.order).toContain("snapshot:Voici le fichier.");
    expect(writer.order.some((e) => e.startsWith("addMedia:"))).toBe(true);
    expect(writer.order.some((e) => e.endsWith(":done") && e.startsWith("addMedia:"))).toBe(false);
    expect(writer.order.some((e) => e.startsWith("finalize:"))).toBe(false);
    // Now the 32MB upload completes.
    writer.release();
    await applied;

    // INVARIANT 1: the reply text was written BEFORE the upload COMPLETED (the
    // upload STARTS at the media event, which is fine — the point is the text
    // is not gated behind the upload finishing).
    const doneIdx = writer.order.findIndex(
      (e) => e.startsWith("addMedia:") && e.endsWith(":done"),
    );
    expect(writer.order.indexOf("snapshot:Voici le fichier.")).toBeLessThan(doneIdx);
    // INVARIANT 2 + 3: media attached, and finalize(complete) is LAST.
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(writer.order[writer.order.length - 1]).toBe("finalize:complete");
    expect(doneIdx).toBeLessThan(writer.order.indexOf("finalize:complete"));
  });

  it("a normal (no-media, no-scan) turn writes its text once, at finalize (no early snapshot)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_2", writer);
    await sink.beginTurn("run-2");
    await sink.apply([
      { type: "message.final", text: "Juste du texte." },
      { type: "run.status", status: "final" },
    ]);
    // No pending media, no outbound scan -> no early setSnapshot; the text rides
    // finalize as before.
    expect(writer.order.filter((e) => e.startsWith("snapshot:"))).toHaveLength(0);
    expect(writer.order[writer.order.length - 1]).toBe("finalize:complete");
  });


  it("an EXPLICIT delivery RESCUES a same-file mention that fails its freshness gate (one attach)", async () => {
    const writer = new OrderingWriter();
    writer.release(); // uploads resolve immediately here
    writer.failMentions = true; // the mention (explicit:false) is dropped
    const sink = new TurnSink("chat_4", writer);
    await sink.beginTurn("run-4");
    await sink.apply([
      // Tool prose mentions the freshly-written path (mention, explicit:false)...
      { type: "media", items: [{ filename: "f.png", path: "/out/f.png", explicit: false }] },
      // ...then the final text delivers it explicitly (MEDIA:).
      { type: "media", items: [{ filename: "f.png", path: "/out/f.png", explicit: true }] },
      { type: "message.final", text: "Le fichier." },
      { type: "run.status", status: "final" },
    ]);
    // The mention was dropped; the EXPLICIT one attached — exactly ONE attach.
    expect(writer.order.filter((e) => e === "addMedia:mention:dropped")).toHaveLength(1);
    expect(writer.order.filter((e) => e === "addMedia:explicit:done")).toHaveLength(1);
    expect(writer.order[writer.order.length - 1]).toBe("finalize:complete");
  });

  it("the OUTBOUND-SCAN path (no MEDIA: directive) also gets text-first via detect+host", async () => {
    const writer = new OrderingWriter();
    const order = writer.order;
    // Scan detects a candidate fast (no upload), hosts it later (slow) — the
    // detect+host split lets the sink write text before the host upload.
    const scan = async (): Promise<{
      candidates: string[];
      host: () => Promise<void>;
    }> => {
      order.push("scan:detect");
      return {
        candidates: ["dropped.pdf"],
        host: async () => {
          order.push("scan:host:start");
          await writer.uploadGate;
          order.push("scan:host:done");
        },
      };
    };
    const sink = new TurnSink("chat_scan", writer, scan);
    await sink.beginTurn("run-scan");
    const applied = sink.apply([
      { type: "message.final", text: "Fichier joint." },
      { type: "run.status", status: "final" },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    // Text visible BEFORE the scan host upload finishes.
    expect(order).toContain("snapshot:Fichier joint.");
    expect(order).toContain("scan:host:start");
    expect(order).not.toContain("scan:host:done");
    writer.release();
    await applied;
    expect(order.indexOf("snapshot:Fichier joint.")).toBeLessThan(
      order.indexOf("scan:host:done"),
    );
    expect(order[order.length - 1]).toBe("finalize:complete");
  });

  it("a first EXPLICIT delivery that fails does not block a same-turn re-delivery (codex P2)", async () => {
    const writer = new OrderingWriter();
    writer.release();
    // First explicit addMedia fails (file not yet readable), the second succeeds.
    let n = 0;
    writer.addMedia = async (
      _m: string,
      _media: { explicit?: boolean },
    ): Promise<boolean> => {
      n++;
      writer.order.push(`addMedia:${n}`);
      return n >= 2; // #1 fails, #2 attaches
    };
    const sink = new TurnSink("chat_5", writer);
    await sink.beginTurn("run-5");
    await sink.apply([
      { type: "media", items: [{ filename: "g.png", path: "/out/g.png", explicit: true }] },
      { type: "media", items: [{ filename: "g.png", path: "/out/g.png", explicit: true }] },
      { type: "message.final", text: "ok" },
      { type: "run.status", status: "final" },
    ]);
    // Both fired (the first did NOT block the retry); the second attached.
    expect(writer.order.filter((e) => e.startsWith("addMedia:"))).toHaveLength(2);
    expect(writer.order[writer.order.length - 1]).toBe("finalize:complete");
  });
});

// --- W5 confinement: no spinner may outlive its turn -----------------------
describe("open tool cards are closed at the turn's terminal", () => {
  it("a tool whose result never came is CLOSED, not left running forever", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_spin", writer);
    await sink.beginTurn("run-spin");
    await sink.apply([
      { type: "tool.status", name: "exec", phase: "start", toolCallId: "t1" },
      // …no result ever arrives; the turn reaches its terminal anyway.
      { type: "message.final", text: "done" },
      { type: "run.status", status: "final" },
    ]);
    const t1 = writer.toolParts.filter(
      (p) => (p as { toolCallId?: string }).toolCallId === "t1",
    );
    expect((t1.at(-1) as { phase?: string })?.phase).toBe("completed");
  });

  it("on an ERROR terminal the unfinished card reads ERROR, never a success", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_spinerr", writer);
    await sink.beginTurn("run-spinerr");
    await sink.apply([
      { type: "tool.status", name: "exec", phase: "start", toolCallId: "t1" },
      { type: "message.final", text: "", error: "gateway died" },
      { type: "run.status", status: "error", message: "gateway died" },
    ]);
    const t1 = writer.toolParts.filter(
      (p) => (p as { toolCallId?: string }).toolCallId === "t1",
    );
    expect((t1.at(-1) as { phase?: string })?.phase).toBe("error");
  });

  it("codex P2: a SYNTHETIC close (a timeout) reads ERROR too, never a success", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_synth", writer);
    await sink.beginTurn("run-synth");
    await sink.apply([
      { type: "tool.status", name: "exec", phase: "start", toolCallId: "t1" },
      // The deferred terminal never arrived: the turn closes on OUR deadline,
      // which confirms nothing about the tool.
      {
        type: "message.final",
        text: "partial",
        diagnosticFinalizeCause: "lifecycle_finishing_timeout",
      },
      { type: "run.status", status: "final" },
    ]);
    const t1 = writer.toolParts.filter(
      (p) => (p as { toolCallId?: string }).toolCallId === "t1",
    );
    expect((t1.at(-1) as { phase?: string })?.phase).toBe("error");
  });

  it("codex P2: a turn RECLASSIFIED as empty closes its unfinished tool as ERROR", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_reclass", writer);
    await sink.beginTurn("run-reclass");
    await sink.apply([
      { type: "tool.status", name: "exec", phase: "start", toolCallId: "t1" },
      // A CLEAN gateway terminal with no visible reply: the empty-response guard
      // turns it into an error AFTER the raw status is read.
      { type: "message.final", text: "" },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).not.toBeNull(); // the turn IS an error
    const t1 = writer.toolParts.filter(
      (p) => (p as { toolCallId?: string }).toolCallId === "t1",
    );
    // A success badge next to a failed reply is a contradiction the reader
    // cannot resolve.
    expect((t1.at(-1) as { phase?: string })?.phase).toBe("error");
  });

  it("codex P2: a FAILED terminal write leaves the card tracked, so the turn still closes it", async () => {
    const writer = new OrderingWriter();
    writer.failToolPhase = "completed"; // the terminal update hits a transient error
    const sink = new TurnSink("chat_toolfail", writer);
    await sink.beginTurn("run-toolfail");
    await sink.apply([
      { type: "tool.status", name: "exec", phase: "start", toolCallId: "t1" },
    ]);
    // The terminal update throws; the sink's apply propagates it, which is the
    // existing contract — what matters is what the TURN does next.
    await expect(
      sink.apply([
        { type: "tool.status", name: "exec", phase: "completed", toolCallId: "t1" },
      ]),
    ).rejects.toThrow();
    writer.failToolPhase = null; // the turn's own cleanup writes fine
    await sink.apply([
      { type: "message.final", text: "done" },
      { type: "run.status", status: "final" },
    ]);
    const t1 = writer.toolParts.filter(
      (p) => (p as { toolCallId?: string }).toolCallId === "t1",
    );
    // Untracked after the failed write, nothing would have closed the card.
    expect((t1.at(-1) as { phase?: string })?.phase).toBe("completed");
  });

  it("a tool that DID finish is not closed twice", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_nospin", writer);
    await sink.beginTurn("run-nospin");
    await sink.apply([
      { type: "tool.status", name: "exec", phase: "start", toolCallId: "t1" },
      { type: "tool.status", name: "exec", phase: "completed", toolCallId: "t1" },
      { type: "message.final", text: "done" },
      { type: "run.status", status: "final" },
    ]);
    expect(
      writer.toolParts.filter(
        (p) => (p as { toolCallId?: string }).toolCallId === "t1",
      ),
    ).toHaveLength(2);
  });
});

describe("codex P2: a refused snapshot must not move the tool-card anchor", () => {
  it("keeps the anchor on the text Convex actually holds", async () => {
    const writer = new OrderingWriter();
    writer.refuseShorter = true;
    const sink = new TurnSink("chat_anchor", writer);
    await sink.beginTurn("run-anchor");
    await sink.apply([
      { type: "message.snapshot", text: "line one\nline two\nline three" },
      // A stale, shorter snapshot: Convex refuses it and keeps the long text.
      { type: "message.snapshot", text: "line one\n" },
      { type: "tool.status", name: "read", phase: "completed" },
    ]);
    expect(writer.order).toContain("snapshot-refused:line one\n");
    // The anchor must still point INSIDE the text the reader is looking at —
    // the start of "line three" (offset 18), not offset 9 of a refused write.
    expect(writer.toolParts.at(-1)?.textOffset).toBe(18);
  });
});

describe("empty-result guard (report ms7b5j… — silent blank bubble)", () => {
  it("a COMPLETE turn that WORKED (tool) but delivered no text and no media -> empty_response error", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_er", writer);
    await sink.beginTurn("run-er");
    await sink.apply([
      { type: "tool.status", name: "read", phase: "completed" },
      { type: "message.final", text: "" }, // no reply text
      { type: "run.status", status: "final" }, // -> complete
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response");
    expect(writer.order[writer.order.length - 1]).toBe(
      "finalize:error:empty_response",
    );
  });

  it("a ZERO-WORK clean-close (silent NO_REPLY / end-of-run grace, no tools at all) -> empty_response error", async () => {
    // The Fabien signature (live prod 2026-07-19 ×3, reproduced live
    // 2026-07-20 via the NO_REPLY sentinel): the gateway ends the run CLEANLY
    // with no content and no activity — before this fix the bubble settled
    // COMPLETE and empty, indistinguishable from "nothing to say".
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_zw", writer);
    await sink.beginTurn("run-zw");
    await sink.apply([
      { type: "message.final", text: "" }, // clean, empty final — zero work
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response_silent");
    expect(writer.order[writer.order.length - 1]).toBe(
      "finalize:error:empty_response_silent",
    );
  });

  it("G-20: a turn the GATEWAY says it handed off is exempt, with no sessions_yield tool", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_y", writer);
    await sink.beginTurn("run-y");
    await sink.apply([
      // No `sessions_yield` frame anywhere: the gateway's own signal is primary.
      { type: "message.final", text: "", gatewayYielded: true },
      { type: "run.status", status: "final" },
    ]);
    // A deliberate hand-off is not an empty response — the child announces later.
    expect(writer.lastFinalizeKind).toBeNull();
  });

  it("G-16: an empty turn whose message-tool args were UNREADABLE names that cause, not a generic empty response", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_mt", writer);
    await sink.beginTurn("run-mt");
    await sink.apply([
      { type: "tool.status", name: "message", phase: "start" },
      // The reply mechanism ran; its arguments could not be read, so no text
      // reached us and the transcript recovery came back with nothing either.
      { type: "message.final", text: "", msgtoolArgsUnreadable: 1 },
      { type: "run.status", status: "final" },
    ]);
    // NOT "the agent produced nothing" — the fault is ours and is named.
    expect(writer.lastFinalizeKind).toBe("msgtool_args_unreadable");
  });

  it("G-16: the named cause does not leak into the NEXT turn", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_mt2", writer);
    await sink.beginTurn("run-mt-a");
    await sink.apply([
      { type: "tool.status", name: "message", phase: "start" },
      { type: "message.final", text: "", msgtoolArgsUnreadable: 1 },
      { type: "run.status", status: "final" },
    ]);
    // Turn B closes on the run status ALONE — no message.final, so nothing
    // recomputes the flag from the event: only beginTurn's reset can clear it.
    await sink.beginTurn("run-mt-b");
    await sink.apply([
      { type: "tool.status", name: "read", phase: "completed" },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response");
  });

  it("a top-level reply of EXACTLY the NO_REPLY sentinel is silence, not content (codex P2)", async () => {
    const writer = new OrderingWriter();
    const deltas: string[] = [];
    writer.appendDelta = async (_m: string, t: string) => {
      deltas.push(t);
    };
    const sink = new TurnSink("chat_nr", writer);
    await sink.beginTurn("run-nr");
    await sink.apply([
      // Split across deltas like a real stream — the live gate must hold it.
      { type: "message.delta", text: "NO_" },
      { type: "message.delta", text: "REPLY" },
      { type: "message.final", text: "NO_REPLY" },
      { type: "run.status", status: "final" },
    ]);
    // The sentinel never reached the live stream (no flash in the bubble).
    expect(deltas).toEqual([]);
    // Classified as the retryable silent class — never a bubble that shows
    // the literal sentinel.
    expect(writer.lastFinalizeKind).toBe("empty_response_silent");
    expect(writer.order[writer.order.length - 1]).toBe(
      "finalize:error:empty_response_silent",
    );
  });

  it("text that merely STARTS like the sentinel flushes intact once it diverges", async () => {
    const writer = new OrderingWriter();
    const deltas: string[] = [];
    writer.appendDelta = async (_m: string, t: string) => {
      deltas.push(t);
    };
    const sink = new TurnSink("chat_nrd", writer);
    await sink.beginTurn("run-nrd");
    await sink.apply([
      { type: "message.delta", text: "NO" },
      { type: "message.delta", text: "N, je préfère répondre." },
      { type: "message.final", text: "NON, je préfère répondre." },
      { type: "run.status", status: "final" },
    ]);
    expect(deltas.join("")).toBe("NON, je préfère répondre.");
    expect(writer.order[writer.order.length - 1]).toBe("finalize:complete");
  });

  it("a COMPLETE turn with a media that DROPPED (not attached) + no text -> empty_response", async () => {
    const writer = new OrderingWriter();
    writer.release();
    // addMedia returns FALSE (dropped not_found) — nothing attaches.
    writer.addMedia = async () => false;
    const sink = new TurnSink("chat_dr", writer);
    await sink.beginTurn("run-dr");
    await sink.apply([
      { type: "media", items: [{ filename: "g.md", path: "/out/g.md", explicit: true }] },
      { type: "message.final", text: "" },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response");
  });

  it("a DELEGATE-THEN-YIELD turn (sessions_yield) with no text is NOT empty_response (live prod denis 2026-07-10)", async () => {
    // Denis' turn worked (read/exec/spawn) then called sessions_yield to hand off
    // to a sub-agent that announced the real answer as a LATER spontaneous turn.
    // The child ran AFTER the yield so no child key was on this turn's wire — the
    // intersection can't save it, but the explicit yield must.
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_yield", writer);
    await sink.beginTurn("run-yield");
    await sink.apply([
      { type: "tool.status", name: "read", phase: "completed" },
      { type: "tool.status", name: "sessions_spawn", phase: "completed", output: "{}" },
      { type: "tool.status", name: "sessions_yield", phase: "completed" },
      { type: "message.final", text: "" }, // deliberate: the child answers
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBeNull(); // complete, never an error card
  });

  it("a turn that STREAMED text via deltas then an empty final is NOT converted (codex P2)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_st", writer);
    await sink.beginTurn("run-st");
    await sink.apply([
      { type: "message.delta", text: "Réponse déjà streamée" },
      { type: "tool.status", name: "read", phase: "completed" },
      { type: "message.final", text: "" }, // empty final, but text was streamed
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBeNull();
  });

  it("a FAILED outbound scan (candidate detected, host fails) + no text -> empty_response (codex P2)", async () => {
    const writer = new OrderingWriter();
    writer.release();
    writer.addMedia = async () => false; // scan host attaches nothing
    const scan = async (): Promise<{
      candidates: string[];
      host: () => Promise<void>;
    }> => ({ candidates: ["dropped.md"], host: async () => {} });
    const sink = new TurnSink("chat_sf", writer, scan);
    await sink.beginTurn("run-sf");
    await sink.apply([
      { type: "message.final", text: "" },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response");
  });

  it("an empty snapshot (compaction clear) after streamed text -> empty_response (codex P2)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_cc", writer);
    await sink.beginTurn("run-cc");
    await sink.apply([
      { type: "message.delta", text: "prefix being written" },
      { type: "message.snapshot", text: "" }, // compaction clears the invalid prefix
      { type: "tool.status", name: "read", phase: "completed" },
      { type: "message.final", text: "" },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response");
  });

  it("a WHITESPACE-ONLY delta before an empty final still -> empty_response (codex P2)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_ws", writer);
    await sink.beginTurn("run-ws");
    await sink.apply([
      { type: "message.delta", text: "   \n  " }, // whitespace only
      { type: "tool.status", name: "read", phase: "completed" },
      { type: "message.final", text: "" },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response");
  });

  it("native media GENERATED but not delivered (no MEDIA:) + no text -> empty_response (codex P2)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_ig", writer);
    await sink.beginTurn("run-ig");
    await sink.apply([
      { type: "message.final", text: "", mediaGeneratedUndelivered: true },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response");
  });

  it("a SILENT parent whose OWN spawned child was observed is NOT an error (announce pattern, ms79rj0e)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_sa", writer);
    const childKey = "agent:alice:subagent:11111111-2222-3333-4444-555555555555";
    await sink.beginTurn("run-sa");
    await sink.apply([
      {
        type: "tool.status",
        name: "sessions_spawn",
        phase: "completed",
        output: { status: "accepted", childSessionKey: childKey },
      },
      { type: "message.final", text: "", observedChildKeys: [childKey] },
      { type: "run.status", status: "final" },
    ]);
    // The reply arrives later as an announce/spontaneous turn — zero bubble,
    // never an empty_response error card.
    expect(writer.lastFinalizeKind).toBeNull();
  });

  it("a NESTED child key (subagent-of-subagent) still exempts (codex P2 — full-key capture)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_nk", writer);
    const nested =
      "agent:alice.prod:subagent:aaaaaaaa-1111-2222-3333-444444444444:subagent:bbbbbbbb-1111-2222-3333-444444444444";
    await sink.beginTurn("run-nk");
    await sink.apply([
      {
        type: "tool.status",
        name: "sessions_spawn",
        phase: "completed",
        output: { status: "accepted", childSessionKey: nested },
      },
      { type: "message.final", text: "", observedChildKeys: [nested] },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBeNull();
  });

  it("a spawn WITHOUT a key in its result + observed child activity still exempts (gateway-variance fallback)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_fb", writer);
    await sink.beginTurn("run-fb");
    await sink.apply([
      // result WITHOUT childSessionKey (variance) — key intersection impossible
      { type: "tool.status", name: "sessions_spawn", phase: "completed", output: { status: "accepted" } },
      {
        type: "message.final",
        text: "",
        observedChildKeys: ["agent:alice:subagent:cccccccc-0000-0000-0000-000000000000"],
      },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBeNull();
  });

  it("keys extracted + only a STALE child observed -> empty_response (fallback must not ride)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_st2", writer);
    await sink.beginTurn("run-st2");
    await sink.apply([
      {
        type: "tool.status",
        name: "sessions_spawn",
        phase: "completed",
        output: {
          status: "accepted",
          childSessionKey: "agent:alice:subagent:dddddddd-0000-0000-0000-000000000000",
        },
      },
      {
        type: "message.final",
        text: "",
        observedChildKeys: [
          "agent:alice:subagent:eeeeeeee-0000-0000-0000-000000000000",
        ],
      },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response");
  });

  it("child activity WITHOUT any spawn this turn does NOT exempt (stale child of a previous turn)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_lc", writer);
    await sink.beginTurn("run-lc");
    await sink.apply([
      { type: "tool.status", name: "read", phase: "completed" },
      // an OLD turn's child emits during this spawn-free turn
      {
        type: "message.final",
        text: "",
        observedChildKeys: [
          "agent:alice:subagent:aaaaaaaa-0000-0000-0000-000000000000",
        ],
      },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBe("empty_response");
  });

  it("a normal COMPLETE turn WITH text is untouched (no false positive)", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_ok", writer);
    await sink.beginTurn("run-ok");
    await sink.apply([
      { type: "tool.status", name: "read", phase: "completed" },
      { type: "message.final", text: "Voici la réponse." },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBeNull();
    expect(writer.order[writer.order.length - 1]).toBe("finalize:complete");
  });

  it("a COMPLETE turn with an ATTACHED media + no text is NOT an error (file delivered)", async () => {
    const writer = new OrderingWriter();
    writer.release(); // addMedia resolves attached=true
    const sink = new TurnSink("chat_md", writer);
    await sink.beginTurn("run-md");
    await sink.apply([
      { type: "media", items: [{ filename: "f.png", path: "/out/f.png", explicit: true }] },
      { type: "message.final", text: "" },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.lastFinalizeKind).toBeNull();
  });
});

describe("provider_internal x undelivered media (codex P1: never re-bill a generation)", () => {
  it("a provider error on a turn that GENERATED media without delivering reclasses non-retryable", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_mg", writer);
    await sink.beginTurn("run-mg");
    await sink.apply([
      {
        type: "message.final",
        text: "",
        error: "read ECONNRESET",
        errorKind: "provider_internal",
        mediaGeneratedUndelivered: true,
      },
      { type: "run.status", status: "error" },
    ]);
    // WORKED-but-undelivered class: honest delivery-failure card, no retry.
    expect(writer.lastFinalizeKind).toBe("empty_response");
  });

  it("the same provider error WITHOUT media stays retryable", async () => {
    const writer = new OrderingWriter();
    const sink = new TurnSink("chat_mg2", writer);
    await sink.beginTurn("run-mg2");
    await sink.apply([
      {
        type: "message.final",
        text: "",
        error: "read ECONNRESET",
        errorKind: "provider_internal",
      },
      { type: "run.status", status: "error" },
    ]);
    expect(writer.lastFinalizeKind).toBe("provider_internal");
  });
});
