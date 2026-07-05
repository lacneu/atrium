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
  async appendDelta(): Promise<void> {}
  async setSnapshot(_messageId: string, text: string): Promise<void> {
    this.order.push(`snapshot:${text}`);
  }
  async addToolPart(): Promise<void> {}
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
  async finalize(_messageId: string, status: FinalizeStatus): Promise<void> {
    this.order.push(`finalize:${status}`);
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