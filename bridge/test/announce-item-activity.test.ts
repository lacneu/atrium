// DELIVERY-run item-derived activity, pinned against the frames captured live
// on the 2026.7.1 bench (2026-07-14): a sub-agent ANNOUNCE run carries NO
// `tool` stream frames — its update_plan / sessions_spawn calls surface as
// bare `item` frames only, and the whole turn ends `chat state:"aborted"`
// with no content when the model streams no text. Before this contract, such
// a turn was discarded as silent: the plan card froze, the chained spawn's
// child was born unanchored (every later delivery opened its own bubble),
// and no tool card ever showed the continuation's work.

import { describe, expect, it } from "vitest";
import { isDeliveryRunId } from "../src/core/async-task.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  SubAgentRecord,
  ToolPart,
} from "../src/convex-writer.js";

const SESSION_KEY = "agent:alice:atrium:chat:olivier:annitems1";
const CHILD_A = "agent:files:subagent:aaaa1111-2222-3333-4444-555566667777";
const ANNOUNCE_RUN = `announce:v1:${CHILD_A}:3899bd5f-9ce4-4468-bd1e-8c19ef301b41`;
const CHILD_B = "agent:files:subagent:bbbb1111-2222-3333-4444-555566667777";

describe("isDeliveryRunId (both delivery families)", () => {
  it("matches the task family and the announce family", () => {
    expect(
      isDeliveryRunId("image_generate:c3e21208-67c2-40ca-b9a4-7368a7109605:ok"),
    ).toBe(true);
    expect(
      isDeliveryRunId("video_generate:c3e21208-67c2-40ca-b9a4-7368a7109605:error"),
    ).toBe(true);
    expect(isDeliveryRunId(ANNOUNCE_RUN)).toBe(true);
  });
  it("never matches ordinary run families", () => {
    for (const rid of [
      "webchat-0ad6c740504bd56662d39314b2ee513e994d51f9",
      "cron:10f525c0-5085-480c-9a8c-c7c246954a3f:1783877963955",
      "image_generate:not-a-uuid:ok",
      "announce:v1:",
      "announce:only",
      "",
      null,
      undefined,
    ]) {
      expect(isDeliveryRunId(rid as never)).toBe(false);
    }
  });
});

// Exact captured shapes (bench 2026-07-14, gateway 2026.7.1).
function itemFrame(
  runId: string,
  name: string,
  phase: "start" | "end",
  status: string,
  meta: string,
  toolCallId = "call_ckth|fc_1",
): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId,
      stream: "item",
      sessionKey: SESSION_KEY,
      data: {
        itemId: `tool:${toolCallId}`,
        phase,
        kind: "tool",
        title: `${name} ${meta}`,
        status,
        name,
        meta,
        toolCallId,
      },
    },
  };
}
function lifecycleFrame(runId: string, phase: string): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId,
      stream: "lifecycle",
      sessionKey: SESSION_KEY,
      data: { phase },
    },
  };
}
function chatAborted(runId: string): unknown {
  return {
    type: "event",
    event: "chat",
    payload: { runId, sessionKey: SESSION_KEY, state: "aborted" },
  };
}
function childStartup(): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      sessionKey: CHILD_B,
      spawnedBy: SESSION_KEY,
      runId: "child-run-b",
      stream: "lifecycle",
      data: { phase: "startup" },
    },
  };
}

class ItemWriter implements ConvexWriter {
  upserts: SubAgentRecord[] = [];
  finals: { status: FinalizeStatus; error: string | null; errorKind?: string | null }[] = [];
  toolParts: ToolPart[] = [];
  advances: { messageId: string; count: number; settleIfIdle: boolean }[] = [];
  started = 0;
  async startAssistant(): Promise<string> {
    this.started++;
    return `msg_item_${this.started}`;
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_m: string, p: ToolPart): Promise<void> {
    this.toolParts.push(p);
  }
  async advancePlanPart(
    messageId: string,
    count: number,
    settleIfIdle: boolean,
  ): Promise<void> {
    this.advances.push({ messageId, count, settleIfIdle });
  }
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(
    _m: string,
    status: FinalizeStatus,
    _t: string,
    error: string | null = null,
    errorKind: string | null = null,
  ): Promise<void> {
    this.finals.push({ status, error, errorKind });
  }
  async getRehydrationContext(): Promise<{
    history: string | null;
    turnCount: number;
  }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionRoster(): Promise<void> {}
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(record: SubAgentRecord): Promise<void> {
    this.upserts.push(record);
  }
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

const PLAN_STEP = "Reconstruire les cinq slides depuis la base saine";
const SPAWN_META =
  "task OBJECTIF: Reconstruire les slides., agent files, model openai/gpt-5.6-sol, cleanup keep";

async function driveAnnounceTurn(writer: ItemWriter): Promise<void> {
  const manager = new RunManager("annitems1", SESSION_KEY, writer);
  let now = 1000;
  // Spontaneous announce run — no active turn, no chat.send.
  await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
  await manager.feed(
    itemFrame(ANNOUNCE_RUN, "update_plan", "start", "running", PLAN_STEP),
    (now += 1),
  );
  await manager.feed(
    itemFrame(ANNOUNCE_RUN, "update_plan", "end", "completed", PLAN_STEP),
    (now += 1),
  );
  // The chained spawn: item frames ONLY (no tool result on delivery runs).
  await manager.feed(
    itemFrame(ANNOUNCE_RUN, "sessions_spawn", "start", "running", SPAWN_META, "call_sp|fc_2"),
    (now += 1),
  );
  await manager.feed(
    itemFrame(ANNOUNCE_RUN, "sessions_spawn", "end", "completed", SPAWN_META, "call_sp|fc_2"),
    (now += 1),
  );
  // The spawned child comes up on its own lane while the announce still runs.
  await manager.feed(childStartup(), (now += 1));
  // The gateway closes the text-less continuation turn as aborted, no content.
  await manager.feed(chatAborted(ANNOUNCE_RUN), (now += 1));
  await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "end"), (now += 1));
  await manager.tick(now + 100_000);
}

describe("announce run with item-only tool activity (captured 2026-07-14)", () => {
  it("opens the bubble, renders the tool cards, advances the plan", async () => {
    const writer = new ItemWriter();
    await driveAnnounceTurn(writer);
    // The tool-only turn is VISIBLE now: the deferred open fired.
    expect(writer.started).toBe(1);
    expect(
      writer.toolParts.map((p) => [p.name, p.phase]),
    ).toEqual([
      ["update_plan", "completed"],
      ["sessions_spawn", "completed"],
    ]);
    // Item-derived cards carry no args/result (none exist on the wire).
    expect(writer.toolParts.every((p) => p.input === undefined && p.output === undefined)).toBe(true);
    // Applied ONCE at turn end: the turn spawned a further child, so the
    // chain continues (no settle) and the plan advances one step per call.
    expect(writer.advances).toEqual([
      { messageId: "msg_item_1", count: 1, settleIfIdle: false },
    ]);
  });

  it("folds the text-less aborted terminal to COMPLETE (never Interrompu)", async () => {
    const writer = new ItemWriter();
    await driveAnnounceTurn(writer);
    expect(writer.finals).toHaveLength(1);
    expect(writer.finals[0]?.status).toBe("complete");
    expect(writer.finals[0]?.error).toBeNull();
    // The tool-only delivery turn is NOT an empty response either.
    expect(writer.finals[0]?.errorKind ?? null).toBeNull();
  });

  it("an update_plan-ONLY announce turn requests the SETTLE (pipeline idle)", async () => {
    const writer = new ItemWriter();
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
    await manager.feed(
      itemFrame(ANNOUNCE_RUN, "update_plan", "end", "completed", PLAN_STEP),
      (now += 1),
    );
    await manager.feed(chatAborted(ANNOUNCE_RUN), (now += 1));
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "end"), (now += 1));
    await manager.tick(now + 100_000);
    expect(writer.advances).toEqual([
      { messageId: "msg_item_1", count: 1, settleIfIdle: true },
    ]);
  });

  it("any OTHER tool on the turn blocks the settle (async items carry no taskId)", async () => {
    const writer = new ItemWriter();
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
    await manager.feed(
      itemFrame(ANNOUNCE_RUN, "update_plan", "end", "completed", PLAN_STEP),
      (now += 1),
    );
    // The chain's next link: an async generation — its item has NO taskId,
    // so no engagement row will exist for Convex's idle check.
    await manager.feed(
      itemFrame(ANNOUNCE_RUN, "image_generate", "end", "completed", "gen", "call_ig|fc_3"),
      (now += 1),
    );
    await manager.feed(chatAborted(ANNOUNCE_RUN), (now += 1));
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "end"), (now += 1));
    await manager.tick(now + 100_000);
    expect(writer.advances).toEqual([
      { messageId: "msg_item_1", count: 1, settleIfIdle: false },
    ]);
  });

  it("a kind:command item on a delivery run derives a card too (exec-only turns stay visible)", async () => {
    const writer = new ItemWriter();
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
    const cmd = {
      type: "event",
      event: "agent",
      payload: {
        runId: ANNOUNCE_RUN,
        stream: "item",
        sessionKey: SESSION_KEY,
        data: {
          itemId: "cmd:1",
          phase: "end",
          kind: "command",
          status: "completed",
          name: "exec",
          meta: "ls",
          toolCallId: "cmd:1",
        },
      },
    };
    await manager.feed(cmd, (now += 1));
    await manager.feed(chatAborted(ANNOUNCE_RUN), (now += 1));
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "end"), (now += 1));
    await manager.tick(now + 100_000);
    expect(writer.started).toBe(1);
    expect(writer.toolParts.map((p) => [p.name, p.phase])).toEqual([
      ["exec", "completed"],
    ]);
    expect(writer.finals[0]?.status).toBe("complete");
  });

  it("a USER abort keeps the aborted status (the fold never repaints a stop)", async () => {
    const writer = new ItemWriter();
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
    await manager.feed(
      itemFrame(ANNOUNCE_RUN, "update_plan", "end", "completed", PLAN_STEP),
      (now += 1),
    );
    // The /abort RPC flags the session BEFORE the gateway kill lands.
    manager.noteUserAbort();
    await manager.feed(chatAborted(ANNOUNCE_RUN), (now += 1));
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "end"), (now += 1));
    await manager.tick(now + 100_000);
    expect(writer.finals[0]?.status).toBe("aborted");
    // A user-stopped turn never requests the settle either.
    expect(writer.advances[0]?.settleIfIdle).toBe(false);
  });

  it("an ERRORED delivery close never requests the settle (advance only)", async () => {
    const writer = new ItemWriter();
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
    await manager.feed(
      itemFrame(ANNOUNCE_RUN, "update_plan", "end", "completed", PLAN_STEP),
      (now += 1),
    );
    await manager.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: ANNOUNCE_RUN,
          sessionKey: SESSION_KEY,
          state: "error",
          errorMessage: "boom",
        },
      },
      (now += 1),
    );
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "end"), (now += 1));
    await manager.tick(now + 100_000);
    expect(writer.finals[0]?.status).toBe("error");
    expect(writer.advances).toEqual([
      { messageId: "msg_item_1", count: 1, settleIfIdle: false },
    ]);
  });

  it("an announce arriving DURING the previous merge's finalize is stashed, then opened", async () => {
    const writer = new ItemWriter();
    // Make finalize hang until released: the finalizing window under test.
    let releaseFinalize: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseFinalize = res;
    });
    const origFinalize = writer.finalize.bind(writer);
    writer.finalize = async (...args: Parameters<typeof origFinalize>) => {
      await gate;
      return origFinalize(...args);
    };
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
    await manager.feed(
      itemFrame(ANNOUNCE_RUN, "update_plan", "end", "completed", PLAN_STEP),
      (now += 1),
    );
    // Terminal of announce A: its finalize hangs on the gate — do NOT await.
    const closing = manager.feed(chatAborted(ANNOUNCE_RUN), (now += 1));
    await new Promise((r) => setTimeout(r, 10));
    // Announce B lands INSIDE the finalize window: it must be stashed, not
    // opened (opening now would fail Convex's streaming gate -> fresh bubble).
    const RUN_B = `announce:v1:${CHILD_B}:99995555-9ce4-4468-bd1e-8c19ef301b41`;
    await manager.feed(lifecycleFrame(RUN_B, "start"), (now += 1));
    await manager.feed(
      itemFrame(RUN_B, "update_plan", "end", "completed", PLAN_STEP, "call_B|fc_9"),
      (now += 1),
    );
    expect(writer.started).toBe(1); // B not opened during the window
    releaseFinalize();
    await closing;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "end"), (now += 1));
    // The stash drains between turns (tick / next inactive-window frame).
    await manager.tick(now + 100_000);
    expect(writer.started).toBe(2); // B opened AFTER the finalize settled
  });

  it("a NORMAL run's item frames still derive nothing (the tool pipeline owns them)", async () => {
    const writer = new ItemWriter();
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.beginTurn((now += 1), "webchat-ordinaryrun1");
    await manager.feed(
      itemFrame("webchat-ordinaryrun1", "update_plan", "end", "completed", PLAN_STEP),
      (now += 1),
    );
    expect(writer.toolParts).toHaveLength(0);
    expect(writer.advances).toHaveLength(0);
  });
});

// A delivery item's PROGRESS (`phase: "update"`), as the bench captured it on 2026.9.33
// (distribution image r6, 2026-10-17): an announce run whose `exec` runs long emits, between
// its `start` and its `end`, item frames with `phase:"update"` and `status:"running"`
// (upstream `src/agents/embedded-agent-subscribe.handlers.tools.progress.ts:115-144`,
// through `emitTrackedItemEvent`, `...tools.start.ts:223-246`; the schema's phase union is
// `start | update | end`, vendored `logs-chat.ts` AgentActivityItemSchema). Upstream counts
// only `start` and `end` as the item's life (`itemActiveIds`); `update` refreshes the
// running item, and the Control UI replaces that item's activity on its live card and
// syncs at once only on `end` (ui/src/pages/chat/tool-stream.ts:521-551). A delivery run's
// card is written at `end`, so the progress frames add nothing to it and close nothing.
function capturedExecItem(phase: "start" | "update" | "end", status: string): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: ANNOUNCE_RUN,
      stream: "item",
      sessionKey: SESSION_KEY,
      data: {
        itemId: "tool:call_ca56|fc_0efd",
        toolCallId: "call_ca56|fc_0efd",
        name: "exec",
        kind: "tool",
        phase,
        title: "Exec Verify completed chain file",
        status,
        meta: "Verify completed chain file",
        commandBearing: true,
      },
    },
  };
}

describe("a delivery item's progress frames (phase update, captured 2026.9.33)", () => {
  async function drive(updates: number): Promise<ItemWriter> {
    const writer = new ItemWriter();
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
    await manager.feed(capturedExecItem("start", "running"), (now += 1));
    for (let i = 0; i < updates; i++) {
      await manager.feed(capturedExecItem("update", "running"), (now += 1));
    }
    await manager.feed(capturedExecItem("end", "completed"), (now += 1));
    await manager.feed(chatAborted(ANNOUNCE_RUN), (now += 1));
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "end"), (now += 1));
    await manager.tick(now + 100_000);
    return writer;
  }

  it("one card, written by the item's end, whatever the number of progress frames", async () => {
    const writer = await drive(4);
    expect(writer.toolParts.map((p) => [p.name, p.phase])).toEqual([["exec", "completed"]]);
    expect(writer.finals.map((f) => f.status)).toEqual(["complete"]);
  });

  it("reads exactly as the same run without its progress frames", async () => {
    const withUpdates = await drive(4);
    const without = await drive(0);
    expect(withUpdates.toolParts).toEqual(without.toolParts);
    expect(withUpdates.finals).toEqual(without.finals);
    expect(withUpdates.started).toBe(without.started);
  });

  it("progress frames alone open no card and close nothing", async () => {
    const writer = new ItemWriter();
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
    await manager.feed(capturedExecItem("start", "running"), (now += 1));
    await manager.feed(capturedExecItem("update", "running"), (now += 1));
    await manager.feed(capturedExecItem("update", "running"), (now += 1));
    expect(writer.toolParts).toEqual([]);
    expect(writer.finals).toEqual([]);
  });
});

// THE WRAPPER RE-EMISSION (prod report prod-ms7dc0ne…, 2026-10-18; bench 2026.9.33 r6): when a
// delivery run finishes, upstream re-emits the `end` of every completed wrapper — a code-mode
// `exec` that ran nested tools — marked `hideFromChannelProgress`
// (src/agents/embedded-agent-subscribe.handlers.tools.start.ts:285-322 `finalizeToolActivity`).
// The same item again: the Control UI replaces an item's activity by its `itemId`
// (ui/src/pages/chat/tool-stream.ts:536-547). One card per item, whatever the frames.
function wrapperEnd(itemId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: ANNOUNCE_RUN,
      stream: "item",
      sessionKey: SESSION_KEY,
      data: {
        itemId: `tool:${itemId}`,
        toolCallId: itemId,
        name: "exec",
        kind: "tool",
        phase: "end",
        title: "Exec Send requested pair of attachments",
        status: "completed",
        meta: "Send requested pair of attachments",
        ...extra,
      },
    },
  };
}

describe("a delivery item's end seen twice writes one card (wrapper re-emission, 2026.9.33)", () => {
  async function drive(frames: unknown[]): Promise<ItemWriter> {
    const writer = new ItemWriter();
    const manager = new RunManager("annitems1", SESSION_KEY, writer);
    let now = 1000;
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "start"), (now += 1));
    for (const f of frames) await manager.feed(f, (now += 1));
    await manager.feed(chatAborted(ANNOUNCE_RUN), (now += 1));
    await manager.feed(lifecycleFrame(ANNOUNCE_RUN, "end"), (now += 1));
    await manager.tick(now + 100_000);
    return writer;
  }

  it("the re-emitted end of a wrapper adds no card", async () => {
    const writer = await drive([
      wrapperEnd("call_a|fc_1"),
      wrapperEnd("call_b|fc_1"),
      wrapperEnd("call_b|fc_1", { hideFromChannelProgress: true }),
      wrapperEnd("call_a|fc_1", { hideFromChannelProgress: true }),
    ]);
    expect(writer.toolParts.map((p) => [p.name, p.phase])).toEqual([
      ["exec", "completed"],
      ["exec", "completed"],
    ]);
  });

  it("a second end of one update_plan item advances the plan once", async () => {
    const writer = await drive([
      itemFrame(ANNOUNCE_RUN, "update_plan", "end", "completed", PLAN_STEP),
      itemFrame(ANNOUNCE_RUN, "update_plan", "end", "completed", PLAN_STEP),
    ]);
    expect(writer.advances).toEqual([{ messageId: "msg_item_1", count: 1, settleIfIdle: true }]);
  });

  it("a re-emitted end alone still writes its card (the first end was never seen)", async () => {
    const writer = await drive([wrapperEnd("call_c|fc_1", { hideFromChannelProgress: true })]);
    expect(writer.toolParts.map((p) => p.name)).toEqual(["exec"]);
  });

  // Codex review 1 of 0.101.1 [medium]: the item lane's card was anonymous, so the same call
  // brought by the transcript under its id added a second `exec` card while the run was being
  // written. The card carries the call's id from the frame (AgentActivityItemSchema
  // `toolCallId`) through `tool.status` to the part.
  it("the item lane's card carries the call's toolCallId to the part", async () => {
    const writer = await drive([
      wrapperEnd("call_a|fc_1"),
      itemFrame(ANNOUNCE_RUN, "update_plan", "end", "completed", PLAN_STEP, "call_p|fc_2"),
    ]);
    expect(writer.toolParts.map((p) => [p.name, p.toolCallId])).toEqual([
      ["exec", "call_a|fc_1"],
      ["update_plan", "call_p|fc_2"],
    ]);
    expect(writer.toolParts.every((p) => p.parentToolCallId === undefined)).toBe(true);
  });

  it("an item naming no id keeps every card (nothing to match it by)", async () => {
    const bare = (): unknown => ({
      type: "event",
      event: "agent",
      payload: {
        runId: ANNOUNCE_RUN,
        stream: "item",
        sessionKey: SESSION_KEY,
        data: { kind: "command", name: "exec", phase: "end", status: "completed" },
      },
    });
    const writer = await drive([bare(), bare()]);
    expect(writer.toolParts).toHaveLength(2);
  });
});
