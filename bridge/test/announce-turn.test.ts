// Gateway-initiated post-turn ANNOUNCE runs (fixture live-captured 2026-07-03).
//
// When a sub-agent finishes AFTER its parent turn ended (sessions_yield / the
// maxConcurrent queue), the gateway starts a run ON THE PARENT SESSION with
// runId `announce:v1:<childSessionKey>:<childRunId>` and streams the parent's
// consolidated report as a normal turn. Before this feature the RunManager
// dropped every frame (sink inactive between turns) — the final answer (a real
// case: a 24KB analysis report) never reached Atrium, and the late child stayed
// a "running" ghost until the TTL sweep mislabeled it timed-out.
//
// The fix: an inactive-sink frame carrying EXACTLY our sessionKey and an
// `announce:`-prefixed runId opens a SPONTANEOUS turn with a DEFERRED message
// (turn-sink deferOpen): the normalizer judges content across every gateway
// shape, and the sink creates the assistant message only on the first
// user-visible normalized event — a silent (NO_REPLY) run never creates one.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  ToolPart,
} from "../src/convex-writer.js";

const ANNOUNCE_FRAMES = readFileSync(
  new URL("./fixtures/announce_frames.jsonl", import.meta.url),
  "utf-8",
)
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"))
  .map((l) => JSON.parse(l) as Record<string, unknown>);

// The captured session + run identity (see the fixture header).
const SESSION_KEY = "agent:alice:atrium:chat:olivier:m97f5pmv6skx4aq9as6af4bgtx89qsb2";
const ANNOUNCE_RUN =
  "announce:v1:agent:alice:subagent:5b0f9680-7a29-427a-ace0-02a9eb10f573:a40575b2-6ddd-4b8f-85aa-351e1a26c2b7";

type Call =
  | ["startAssistant", string, string | null]
  | ["appendDelta", string, string]
  | ["setSnapshot", string, string]
  | ["finalize", string, FinalizeStatus, string];

class FakeWriter implements ConvexWriter {
  readonly calls: Call[] = [];
  async startAssistant(chatId: string, runId: string | null): Promise<string> {
    this.calls.push(["startAssistant", chatId, runId]);
    return "msg_announce_1";
  }
  async appendDelta(messageId: string, text: string): Promise<void> {
    this.calls.push(["appendDelta", messageId, text]);
  }
  async setSnapshot(messageId: string, text: string): Promise<void> {
    this.calls.push(["setSnapshot", messageId, text]);
  }
  async addToolPart(_m: string, _p: ToolPart): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(
    messageId: string,
    status: FinalizeStatus,
    text: string,
  ): Promise<void> {
    this.calls.push(["finalize", messageId, status, text]);
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

describe("gateway ANNOUNCE run -> spontaneous turn (real captured frames)", () => {
  it("inactive sink + announce frames -> ONE assistant message, streamed + finalized complete", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    // No beginTurn, no armReplayBuffer: the between-turns state where the old
    // code dropped everything.
    let now = 1000;
    for (const frame of ANNOUNCE_FRAMES) {
      await manager.feed(frame, (now += 1));
    }
    const starts = writer.calls.filter((c) => c[0] === "startAssistant");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.[2]).toBe(ANNOUNCE_RUN); // runId = the announce run
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[2]).toBe("complete");
    // The captured report text made it through (the probe's token).
    expect(finals[0]?.[3]).toContain("ANNOUNCE_TOKEN_99");
  });

  it("an announce for a FOREIGN session is still dropped (isolation stays strict)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager(
      "chatAnnounce",
      "agent:alice:atrium:chat:olivier:someOtherChat",
      writer,
    );
    let now = 1000;
    for (const frame of ANNOUNCE_FRAMES) {
      await manager.feed(frame, (now += 1));
    }
    expect(writer.calls).toHaveLength(0);
  });

  it("announce racing an in-flight chat.send: STASHED during the send, delivered AFTER the real turn (never lost)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    manager.armReplayBuffer(); // a dispatch is in flight
    let now = 1000;
    for (const frame of ANNOUNCE_FRAMES) {
      await manager.feed(frame, (now += 1));
    }
    // No spontaneous turn mid-send-window — the announce is stashed, not lost.
    expect(writer.calls.filter((c) => c[0] === "startAssistant")).toHaveLength(0);
    // The REAL turn runs and finalizes.
    await manager.beginTurn((now += 1), "webchat-realrun");
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "webchat-realrun",
          sessionKey: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "vraie réponse" }] },
        },
      },
      (now += 1),
    );
    // Delivery is IMMEDIATE at the real turn's finalize (post-finalize flush —
    // no later tick is guaranteed once the loop goes idle).
    const starts = writer.calls.filter((c) => c[0] === "startAssistant");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.[2]).toBe(ANNOUNCE_RUN);
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(2);
    expect(finals[1]?.[3]).toContain("ANNOUNCE_TOKEN_99");
  });

  it("announce arriving DURING an active user turn: stashed, delivered after that turn (never dropped as foreign)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    let now = 1000;
    // A real user turn is streaming.
    await manager.beginTurn((now += 1), "webchat-activerun");
    // The late child announce lands MID-TURN.
    for (const frame of ANNOUNCE_FRAMES) {
      await manager.feed(frame, (now += 1));
    }
    // Still only the real turn's message.
    expect(writer.calls.filter((c) => c[0] === "startAssistant")).toHaveLength(1);
    // The real turn finalizes.
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "webchat-activerun",
          sessionKey: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "réponse en cours" }] },
        },
      },
      (now += 1),
    );
    // Delivery is IMMEDIATE at the real turn's finalize (no tick guaranteed
    // afterwards — the consume loop may go idle).
    const starts = writer.calls.filter((c) => c[0] === "startAssistant");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.[2]).toBe(ANNOUNCE_RUN);
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals[1]?.[3]).toContain("ANNOUNCE_TOKEN_99");
  });

  it("a RETRANSMITTED terminal frame of an already-handled announce never duplicates the report", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    let now = 1000;
    for (const frame of ANNOUNCE_FRAMES) {
      await manager.feed(frame, (now += 1));
    }
    expect(writer.calls.filter((c) => c[0] === "finalize")).toHaveLength(1);
    // The gateway retransmits the run's chat:final after we finalized.
    const finalFrame = ANNOUNCE_FRAMES[ANNOUNCE_FRAMES.length - 1];
    await manager.feed(finalFrame, (now += 1));
    await manager.feed(finalFrame, (now += 1));
    expect(writer.calls.filter((c) => c[0] === "startAssistant")).toHaveLength(1);
    expect(writer.calls.filter((c) => c[0] === "finalize")).toHaveLength(1);
  });

  it("a stale announce RETRANSMIT during a LATER user turn never touches that turn (P1: no contamination)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    let now = 1000;
    // The announce runs to completion (handled).
    for (const frame of ANNOUNCE_FRAMES) {
      await manager.feed(frame, (now += 1));
    }
    expect(writer.calls.filter((c) => c[0] === "finalize")).toHaveLength(1);
    // A new USER turn starts streaming.
    await manager.beginTurn((now += 1), "webchat-nextrun");
    const callsBefore = writer.calls.length;
    // The gateway retransmits the OLD announce's chat:final mid-turn: it must be
    // dropped outright — never fed to the normalizer (whose lifecycle-end grace
    // could admit it and finalize the user's in-flight reply with stale text).
    const finalFrame = ANNOUNCE_FRAMES[ANNOUNCE_FRAMES.length - 1];
    await manager.feed(finalFrame, (now += 1));
    expect(writer.calls.length).toBe(callsBefore); // zero writer activity
  });

  it("a stale announce retransmit during a PRE-ACK window is dropped (never buffered into the replay)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    let now = 1000;
    // The announce completes normally (handled).
    for (const frame of ANNOUNCE_FRAMES) {
      await manager.feed(frame, (now += 1));
    }
    expect(writer.calls.filter((c) => c[0] === "finalize")).toHaveLength(1);
    // A new send arms the pre-ack buffer; the gateway retransmits the OLD final.
    manager.armReplayBuffer();
    const finalFrame = ANNOUNCE_FRAMES[ANNOUNCE_FRAMES.length - 1];
    await manager.feed(finalFrame, (now += 1));
    // The real turn begins: the replay must NOT deliver the stale announce.
    await manager.beginTurn((now += 1), "webchat-nextrun2");
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1); // still only the original announce finalize
    // The real turn is streaming, untouched.
    expect(writer.calls.filter((c) => c[0] === "startAssistant")).toHaveLength(2);
  });

  it("announce deltas racing the deferred startAssistant write are all delivered (concurrent applies)", async () => {
    // Reproduce the race: startAssistant is SLOW (Convex write latency); while
    // the deferred open is in flight, more of the run\'s frames keep applying
    // concurrently. Every delta must end up in the message — none dropped.
    class SlowWriter extends FakeWriter {
      resolveStart: (() => void) | null = null;
      override async startAssistant(
        chatId: string,
        runId: string | null,
      ): Promise<string> {
        this.calls.push(["startAssistant", chatId, runId]);
        await new Promise<void>((r) => {
          this.resolveStart = r;
        });
        return "msg_announce_slow";
      }
    }
    const writer = new SlowWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    // Fire ALL frames concurrently (consume loop + stash flush can interleave).
    const all = Promise.all(
      ANNOUNCE_FRAMES.map((frame, i) => manager.feed(frame, 1000 + i)),
    );
    // Let the first visible event request the open, then complete the write.
    await new Promise((r) => setTimeout(r, 0));
    expect(writer.calls.filter((c) => c[0] === "startAssistant")).toHaveLength(1);
    writer.resolveStart?.();
    await all;
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[2]).toBe("complete");
    expect(finals[0]?.[3]).toContain("ANNOUNCE_TOKEN_99");
  });

  it("a NO_REPLY announce (protocol sentinel) never becomes a visible message", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    const RUN = "announce:v1:agent:alice:subagent:noreply-child:noreply-run";
    let now = 1000;
    const mk = (payload: Record<string, unknown>, event = "agent") => ({
      type: "event",
      event,
      payload: { runId: RUN, sessionKey: SESSION_KEY, ...payload },
    });
    // The real fixture shape: provenance-ish lifecycle, an assistant "NO_REPLY"
    // delta, then a bare chat final.
    await manager.feed(mk({ stream: "lifecycle", data: { phase: "start" } }), (now += 1));
    await manager.feed(mk({ stream: "assistant", data: { text: "NO_REPLY" } }), (now += 1));
    await manager.feed(mk({ state: "final" }, "chat"), (now += 1));
    expect(writer.calls).toHaveLength(0); // no message, no finalize — never opened
    // A RETRANSMIT of the silent final stays invisible (probe re-buffers, bounded).
    await manager.feed(mk({ state: "final" }, "chat"), (now += 1));
    expect(writer.calls).toHaveLength(0);
  });

  it("a delta-only announce (data.delta, no data.text) still opens and delivers", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    const RUN = "announce:v1:agent:alice:subagent:delta-child:delta-run";
    let now = 1000;
    const mk = (payload: Record<string, unknown>, event = "agent") => ({
      type: "event",
      event,
      payload: { runId: RUN, sessionKey: SESSION_KEY, ...payload },
    });
    await manager.feed(mk({ stream: "lifecycle", data: { phase: "start" } }), (now += 1));
    await manager.feed(mk({ stream: "assistant", data: { delta: "Rapport delta-only" } }), (now += 1));
    await manager.feed(
      mk(
        {
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "Rapport delta-only" }] },
        },
        "chat",
      ),
      (now += 1),
    );
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[3]).toContain("Rapport delta-only");
  });

  it("an EMPTY final preceding the visible content does not condemn the run (empty-final grace)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    const RUN = "announce:v1:agent:alice:subagent:grace-child:grace-run";
    let now = 1000;
    const mk = (payload: Record<string, unknown>, event = "agent") => ({
      type: "event",
      event,
      payload: { runId: RUN, sessionKey: SESSION_KEY, ...payload },
    });
    await manager.feed(mk({ stream: "lifecycle", data: { phase: "start" } }), (now += 1));
    // Contentless terminal arrives FIRST (the gateway pattern the normalizer
    // handles with its empty-final grace on normal turns).
    await manager.feed(mk({ state: "final" }, "chat"), (now += 1));
    expect(writer.calls).toHaveLength(0);
    // The visible reply follows — the run must still open and deliver.
    await manager.feed(mk({ stream: "assistant", data: { text: "Rapport tardif" } }), (now += 1));
    await manager.feed(
      mk(
        {
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "Rapport tardif" }] },
        },
        "chat",
      ),
      (now += 1),
    );
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[3]).toContain("Rapport tardif");
  });

  it("a chat final with STRING content (chat-final-content-string shape) opens and delivers", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    const RUN = "announce:v1:agent:alice:subagent:string-child:string-run";
    let now = 1000;
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: RUN,
          sessionKey: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: "Rapport contenu-chaine" },
        },
      },
      (now += 1),
    );
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[3]).toContain("Rapport contenu-chaine");
  });

  it("a media-ONLY announce (mediaUrls, no text) still opens the turn (file delivery)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    const RUN = "announce:v1:agent:alice:subagent:media-child:media-run";
    let now = 1000;
    await manager.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: RUN,
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: {
            mediaUrls: ["/home/node/.openclaw/media/outbound/rapport.pdf"],
          },
        },
      },
      (now += 1),
    );
    // The spontaneous turn opened (message created) so the media event can land.
    expect(writer.calls.filter((c) => c[0] === "startAssistant")).toHaveLength(1);
  });

  it("a silent announce that reaches its terminal is DISCARDED: no message, sink freed for the next turn", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    const RUN = "announce:v1:agent:alice:subagent:silent-child:silent-run";
    let now = 1000;
    const mk = (payload: Record<string, unknown>, event = "agent") => ({
      type: "event",
      event,
      payload: { runId: RUN, sessionKey: SESSION_KEY, ...payload },
    });
    await manager.feed(mk({ stream: "lifecycle", data: { phase: "start" } }), (now += 1));
    await manager.feed(mk({ stream: "assistant", data: { text: "NO_REPLY" } }), (now += 1));
    await manager.feed(mk({ state: "final" }, "chat"), (now += 1));
    // The empty-final grace expires -> the normalizer emits the terminal pair
    // -> the deferred sink discards the whole turn (nothing was visible).
    await manager.tick(now + 120);
    expect(writer.calls).toHaveLength(0);
    expect(manager.isFinalized).toBe(true);
    // The sink is FREE again: a subsequent REAL turn works normally.
    await manager.beginTurn((now += 200), "webchat-afterdiscard");
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "webchat-afterdiscard",
          sessionKey: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "tour suivant" }] },
        },
      },
      (now += 1),
    );
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[3]).toContain("tour suivant");
  });

  it("an ERRORED announce with no text still surfaces (error finalize, never silent)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    const RUN = "announce:v1:agent:alice:subagent:err-child:err-run";
    let now = 1000;
    const mk = (payload: Record<string, unknown>, event = "agent") => ({
      type: "event",
      event,
      payload: { runId: RUN, sessionKey: SESSION_KEY, ...payload },
    });
    await manager.feed(mk({ stream: "lifecycle", data: { phase: "start" } }), (now += 1));
    // The real gateway error shape on the main lane: a lifecycle ERROR frame
    // (chat state:"error" is not consumed by the main-lane normalizer).
    await manager.feed(
      mk({ stream: "lifecycle", data: { phase: "error", error: "provider exploded" } }),
      (now += 1),
    );
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[2]).toBe("error");
    expect(writer.calls.filter((c) => c[0] === "startAssistant")).toHaveLength(1);
  });

  it("a real send preempting an INVISIBLE deferred announce does not lose the report", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    let now = 1000;
    // Only the announce lifecycle arrived: deferred turn active, NO message yet.
    await manager.feed(ANNOUNCE_FRAMES[0], (now += 1));
    expect(writer.calls).toHaveLength(0);
    // A real user dispatch preempts it (the chat did not look busy).
    await manager.beginTurn((now += 1), "webchat-preempt");
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "webchat-preempt",
          sessionKey: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "réponse utilisateur" }] },
        },
      },
      (now += 1),
    );
    // The announce run\'s remaining frames arrive AFTER the real turn — they
    // must re-open a fresh spontaneous turn (not drop as stale retransmits).
    for (const frame of ANNOUNCE_FRAMES.slice(1)) {
      await manager.feed(frame, (now += 1));
    }
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(2);
    expect(finals[1]?.[3]).toContain("ANNOUNCE_TOKEN_99");
  });

  it("a real turn preempting an IN-FLIGHT deferred open is never corrupted by the stale closure (epoch)", async () => {
    class SlowWriter extends FakeWriter {
      resolveStart: (() => void) | null = null;
      startCount = 0;
      override async startAssistant(
      chatId: string,
      runId: string | null,
      ): Promise<string> {
        this.calls.push(["startAssistant", chatId, runId]);
        this.startCount++;
        if (this.startCount === 1) {
          // Only the DEFERRED announce open hangs; the real turn's is instant.
          await new Promise<void>((r) => {
            this.resolveStart = r;
          });
          return "msg_stale_announce";
        }
        return "msg_real_turn";
      }
    }
    const writer = new SlowWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    let now = 1000;
    // Announce arrives; its first visible frame requests the open (hangs).
    await manager.feed(ANNOUNCE_FRAMES[0], (now += 1));
    const opening = manager.feed(ANNOUNCE_FRAMES[1], (now += 1));
    await new Promise((r) => setTimeout(r, 0));
    // A real user dispatch preempts while startAssistant is still in flight.
    await manager.beginTurn((now += 1), "webchat-preempt-midopen");
    // The stale open completes now — it must NOT touch the new turn.
    writer.resolveStart?.();
    await opening;
    // The real turn streams + finalizes normally on ITS message.
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "webchat-preempt-midopen",
          sessionKey: SESSION_KEY,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "réponse propre" }] },
        },
      },
      (now += 1),
    );
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    const realFinal = finals.find((c) => c[1] === "msg_real_turn");
    expect(realFinal?.[3]).toContain("réponse propre");
    // Nothing from the stale announce ever landed on the real turn\'s message.
    const strayOnReal = writer.calls.filter(
      (c) =>
        (c[0] === "appendDelta" || c[0] === "setSnapshot") &&
        c[1] === "msg_real_turn" &&
        String(c[2]).includes("ANNOUNCE_TOKEN_99"),
    );
    expect(strayOnReal).toHaveLength(0);
    // And no finalize ever targeted the orphan announce message.
    expect(finals.every((c) => c[1] === "msg_real_turn")).toBe(true);
  });

  it("frames racing the PREEMPTING real turn's startAssistant are buffered, not lost (sink deactivated)", async () => {
    class SlowRealWriter extends FakeWriter {
      resolveStart: (() => void) | null = null;
      override async startAssistant(
      chatId: string,
      runId: string | null,
      ): Promise<string> {
        this.calls.push(["startAssistant", chatId, runId]);
        // Only the REAL turn's create is slow here (no deferred open happens:
        // the announce never showed visible content).
        await new Promise<void>((r) => {
          this.resolveStart = r;
        });
        return "msg_real_slow";
      }
    }
    const writer = new SlowRealWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    let now = 1000;
    // A deferred announce turn is ACTIVE but unopened (lifecycle only).
    await manager.feed(ANNOUNCE_FRAMES[0], (now += 1));
    expect(writer.calls).toHaveLength(0);
    // A real dispatch preempts: arm + beginTurn (startAssistant hangs).
    manager.armReplayBuffer();
    const bt = manager.beginTurn((now += 1), "webchat-slowreal");
    // The real run's first delta RACES the create — it must reach the armed
    // pre-ack buffer (sink deactivated), NOT vanish into the stale deferred state.
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "webchat-slowreal",
          sessionKey: SESSION_KEY,
          state: "delta",
          deltaText: "Début de réponse",
          seq: 1,
        },
      },
      (now += 1),
    );
    writer.resolveStart?.();
    await bt;
    // The replay delivered the raced delta into the real message.
    const deltas = writer.calls.filter(
      (c) => c[0] === "appendDelta" && String(c[2]).includes("Début de réponse"),
    );
    expect(deltas).toHaveLength(1);
  });

  it("a real-run frame racing its ACK while an announce turn is active reaches the pre-ack buffer", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    let now = 1000;
    // An announce turn is ACTIVE (deferred, unopened — the preemptable window).
    await manager.feed(ANNOUNCE_FRAMES[0], (now += 1));
    // A user send arms the pre-ack buffer; the real run's first delta races
    // the chat.send ack.
    manager.armReplayBuffer();
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "webchat-racing-real",
          sessionKey: SESSION_KEY,
          state: "delta",
          deltaText: "Début de la vraie réponse",
          seq: 1,
        },
      },
      (now += 1),
    );
    // The ack lands: beginTurn replays the buffered delta into the real turn.
    await manager.beginTurn((now += 1), "webchat-racing-real");
    const deltas = writer.calls.filter(
      (c) =>
        c[0] === "appendDelta" && String(c[2]).includes("Début de la vraie réponse"),
    );
    expect(deltas).toHaveLength(1);
  });

  it("a replay failure AFTER the deferred create still delivers the final (never wedged behind a closed gate)", async () => {
    class FlakyReplayWriter extends FakeWriter {
      override async addProvenancePart(): Promise<void> {
        throw new Error("convex write timeout"); // the buffered pre-open event fails
      }
    }
    const writer = new FlakyReplayWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    const RUN = "announce:v1:agent:alice:subagent:flaky-child:flaky-run";
    let now = 1000;
    const mk = (payload: Record<string, unknown>, event = "agent") => ({
      type: "event",
      event,
      payload: { runId: RUN, sessionKey: SESSION_KEY, ...payload },
    });
    // A provenance report buffers BEFORE the open (non-visible)...
    await manager.feed(
      mk({
        stream: "hindsight-openclaw.provenance",
        data: { v: 1, source: "hindsight", kind: "memory", retrieval: { count: 1 } },
      }),
      (now += 1),
    );
    // ...then visible content opens the message; the buffered provenance replay THROWS.
    await manager.feed(mk({ stream: "assistant", data: { text: "Rapport fiable" } }), (now += 1));
    await manager.feed(
      mk(
        {
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "Rapport fiable" }] },
        },
        "chat",
      ),
      (now += 1),
    );
    const finals = writer.calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[2]).toBe("complete");
    expect(finals[0]?.[3]).toContain("Rapport fiable");
  });

  it("a plain foreign-run frame between turns never opens a turn (non-announce)", async () => {
    const writer = new FakeWriter();
    const manager = new RunManager("chatAnnounce", SESSION_KEY, writer);
    await manager.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: "webchat-somebackgroundrun",
          sessionKey: SESSION_KEY,
          stream: "assistant",
          data: { text: "stray", delta: "stray" },
        },
      },
      1000,
    );
    expect(writer.calls).toHaveLength(0);
  });
});
