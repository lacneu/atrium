/// <reference types="vitest" />
//
// A session the gateway ROTATED must be followed (lot 36 — G-46, the last CRITICAL gap
// of the Hermes wave).
//
// An auto-compaction ENDS the session it was running in and continues the conversation in
// a NEW one (upstream `_sync_session_key_after_compress`). Atrium learned only `run_id`,
// so every later turn resumed the ended parent and the agent restarted from the transcript
// as it stood BEFORE the compaction. That is the Hermes form of "it forgot what we just
// said" — the report this whole programme exists to end.
//
// Both transports announce the rotation and neither was read:
//   * WS   — `session.info` carries `stored_session_id`, emitted in the turn's TAIL,
//            after `message.complete`. The reader dropped everything non-monitoring once
//            the turn was finalized, so the one announcement never landed.
//   * REST — `assistant.completed` / `run.completed` carry the effective `session_id`.
//
// What is pinned here is CONTINUITY, not a callback: the assertion is that the NEXT turn
// resumes the new id. Driving `onBoundSession` would only prove a function ran — the trap
// this programme has paid for in lots 30, 31 and 34.

import { describe, expect, it } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import { HermesNormalizer } from "../src/providers/hermes/normalizer.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const OLD = "20260706_212939_aee24e";
const ROTATED = "20260706_221500_bb31cc";

function writerStub(): ConvexWriter {
  return {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async () => {},
    addReasoningPart: async () => {},
    setPhase: () => {},
    finalize: async () => {},
    __cleared: undefined,
    reportSessionMeta: async () => {},
    heartbeat: async () => {},
    upsertSubAgent: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
}

/** A client that records which session each turn RESUMED — the only thing that proves
 *  continuity. */
function recordingClient(resumed: string[]) {
  return {
    call: async (method: string, params?: Record<string, unknown>) => {
      if (method === "session.resume") {
        const asked = String((params as { session_id?: string })?.session_id ?? "");
        resumed.push(asked);
        return { session_id: "rt-1", stored_session_id: asked };
      }
      if (method === "session.create") {
        return { session_id: "rt-1", stored_session_id: OLD };
      }
      if (method === "prompt.submit") return { status: "streaming" };
      return {};
    },
  } as unknown as HermesWsClient;
}

describe("WS: the rotation announced in the turn's tail is learned", () => {
  it("the NEXT turn resumes the rotated session, not the ended one", async () => {
    const resumed: string[] = [];
    const client = recordingClient(resumed);
    // The chat's persisted binding, as the dispatcher would pass it.
    let persisted: string | null = OLD;
    const runTurn = async () => {
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        {
          client,
          writer: writerStub(),
          chatId: "c1",
          sessionKey: "k",
          providerChatId: persisted,
          text: "suite",
          onBoundSession: async (sid) => {
            persisted = sid;
          },
        },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      return { run, lane };
    };

    // TURN 1: it resumes the stored session, answers, and the gateway then announces —
    // AFTER the terminal, exactly as upstream emits it — that the session rotated.
    const first = await runTurn();
    first.lane("message.complete", { text: "voilà", status: "complete" });
    first.lane("session.info", {
      model: "gpt-5.5",
      stored_session_id: ROTATED,
    });
    await first.run.done;
    expect(resumed).toEqual([OLD]);
    expect(persisted, "the rotation must reach the chat's binding").toBe(ROTATED);

    // TURN 2: the proof. Resuming OLD here is the defect — the gateway ended that
    // session, so the agent would restart from the pre-compaction transcript.
    const second = await runTurn();
    second.lane("message.complete", { text: "ok", status: "complete" });
    await second.run.done;
    expect(resumed).toEqual([OLD, ROTATED]);
  });

  it("a turn that CLEARED its session does not bind the rotation back in", async () => {
    // The crossing the review named: the rotation arrives around the terminal, and a turn
    // that lost its transport has just had its session cleared. Binding here would write
    // one straight back into the slot the clearing exists to empty.
    const resumed: string[] = [];
    let persisted: string | null = OLD;
    let lane!: (t: string, p: Record<string, unknown>) => void;
    let lost!: (reason: string) => void;
    const run = runHermesWsTurn(
      {
        client: recordingClient(resumed),
        writer: writerStub(),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: OLD,
        text: "suite",
        onBoundSession: async (sid) => {
          persisted = sid;
        },
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        lost = cb.onTransportLost;
        return () => {};
      },
    );
    await run.accepted;
    lost("socket closed"); // the terminal clears the session
    // …and only THEN does the rotation arrive, exactly as it would on the wire.
    lane("session.info", { stored_session_id: ROTATED });
    await run.done;
    expect(
      persisted,
      "a cleared session must not be re-bound by a late rotation",
    ).toBe(OLD);
  });

  it("a value that is not a stored session id is refused", async () => {
    const resumed: string[] = [];
    let persisted: string | null = OLD;
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: recordingClient(resumed),
        writer: writerStub(),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: OLD,
        text: "suite",
        onBoundSession: async (sid) => {
          persisted = sid;
        },
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    // A REST-shaped id, or a routing segment, must never reach the WS slot.
    lane("session.info", { stored_session_id: "api_1783351043_b99e6df2" });
    lane("message.complete", { text: "ok", status: "complete" });
    await run.done;
    expect(persisted).toBe(OLD);
  });
});

describe("REST: the rotated session id on the terminals is learned", () => {
  it("the normalizer follows `session_id`, shape-guarded", () => {
    const norm = new HermesNormalizer();
    expect(norm.currentStoredSessionId).toBeNull();
    norm.feed({
      event: "assistant.completed",
      data: JSON.stringify({
        content: "voilà",
        session_id: "api_1783351099_ffee01",
        completed: true,
      }),
    });
    expect(norm.currentStoredSessionId).toBe("api_1783351099_ffee01");
  });

  it("…and refuses a WS-shaped id in the REST slot", () => {
    const norm = new HermesNormalizer();
    norm.feed({
      event: "assistant.completed",
      data: JSON.stringify({ content: "voilà", session_id: ROTATED }),
    });
    // Feeding one transport's id to the other is how a chat that switched transports
    // wedges itself — the shape guard is what keeps the shared slot honest.
    expect(norm.currentStoredSessionId).toBeNull();
  });
});

describe("the ORDER of the writes matches the order of the decisions", () => {
  it("a SLOW mint bind cannot overwrite a rotation decided after it", async () => {
    // Both binds were fire-and-forget, so nothing made the wire order follow the decision
    // order: the minted id could land AFTER the rotation and durably restore the parent
    // session the gateway had just closed (raised in review). The next turn then resumed
    // a dead session — the very defect this lot exists to close, reintroduced by its own
    // fix.
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstLanded = new Promise<void>((res) => {
      releaseFirst = res;
    });
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      {
        client: {
          call: async (method: string) => {
            if (method === "session.create") {
              return { session_id: "rt-1", stored_session_id: OLD };
            }
            if (method === "prompt.submit") return { status: "streaming" };
            return {};
          },
        } as unknown as HermesWsClient,
        writer: writerStub(),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: null, // a FRESH session: the mint bind fires post-ACK
        text: "première question",
        onBoundSession: async (sid) => {
          // The mint's write is slow; the rotation's is not.
          if (sid === OLD) await firstLanded;
          writes.push(sid);
        },
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    lane("message.complete", { text: "voilà", status: "complete" });
    lane("session.info", { stored_session_id: ROTATED });
    releaseFirst();
    await run.done;
    // Serialized, so the LAST write is the last decision.
    expect(writes).toEqual([OLD, ROTATED]);
  });

  it("a rotation decided BEFORE the transport died is not written after the clear", async () => {
    // The mirror of the earlier test, and the order the first cut missed: rotation first,
    // loss second. The bind is dropped at write time rather than resurrecting a session
    // the terminal is clearing.
    const writes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let lane!: (t: string, p: Record<string, unknown>) => void;
    let lost!: (reason: string) => void;
    const run = runHermesWsTurn(
      {
        client: recordingClient([]),
        writer: writerStub(),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: OLD,
        text: "suite",
        onBoundSession: async (sid) => {
          await gate;
          writes.push(sid);
        },
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        lost = cb.onTransportLost;
        return () => {};
      },
    );
    await run.accepted;
    lane("session.info", { stored_session_id: ROTATED }); // decided…
    lost("socket closed"); // …then the turn gives up on the session
    release();
    await run.done;
    expect(writes, "a queued bind must not outlive the decision to clear").toEqual([]);
  });
});

describe("what a giving-up turn CLEARS is the binding it currently holds", () => {
  it("after a rotation, the clear names the ROTATED id — not the one it started on", async () => {
    // The clear is matched by ID (lot 31): naming the stale one matches nothing, so the
    // rotated session would stay bound to a turn that just declared it unusable (raised
    // in review). The turn must clear what it HOLDS, not what it began with.
    const cleared: (string | undefined)[] = [];
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addPart: async () => {},
      addToolPart: async () => {},
      addReasoningPart: async () => {},
      setPhase: () => {},
      finalize: async (
        _id: string,
        _status: string,
        _t?: string,
        _e?: string | null,
        _k?: string | null,
        o?: { clearProviderSession?: string },
      ) => {
        cleared.push(o?.clearProviderSession);
      },
      reportSessionMeta: async () => {},
      heartbeat: async () => {},
      upsertSubAgent: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    } as unknown as ConvexWriter;
    let lane!: (t: string, p: Record<string, unknown>) => void;
    let lost!: (reason: string) => void;
    const run = runHermesWsTurn(
      {
        client: recordingClient([]),
        writer,
        chatId: "c1",
        sessionKey: "k",
        providerChatId: OLD,
        text: "suite",
        onBoundSession: async () => {},
      },
      (_sid, cb) => {
        lane = cb.onEvent;
        lost = cb.onTransportLost;
        return () => {};
      },
    );
    await run.accepted;
    lane("session.info", { stored_session_id: ROTATED });
    lost("socket closed");
    await run.done;
    expect(cleared).toEqual([ROTATED]);
  });
});
