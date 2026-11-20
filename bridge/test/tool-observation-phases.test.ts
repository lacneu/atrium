/**
 * `input_delta` and `review` report on a tool call; neither ends it.
 *
 * Upstream writes two phases on `stream:"tool"` that are neither a start, nor output, nor a
 * result (v2026.9.36; both exist on every validated tag):
 *  - `input_delta` — `handleMessageUpdate`
 *    (src/agents/embedded-agent-subscribe.handlers.messages.update.ts) while the model is
 *    still STREAMING the arguments of a file-mutation call: `{phase, toolCallId, name, diff:
 *    {added, removed}}` (src/agents/embedded-agent-live-edit-diff.ts). It precedes the
 *    call's `start`.
 *  - `review` — `publishGatewayGuardianReview` (src/agents/bash-tools.exec-host-gateway.ts)
 *    with `name:"exec"`, and the Codex harness's `handleGuardianReview`
 *    (extensions/codex/src/app-server/event-projector-events.ts) with NO `name`.
 * The Control UI closes a tool card on `result` only (ui/src/pages/chat/tool-stream.ts).
 *
 * Atrium closed the card on any phase it did not list as progress: an edit showed as
 * completed before it had started, an exec as completed while its review was pending, the
 * buffered arguments were dropped so the real result landed without its input, and each
 * frame counted as one more tool call.
 *
 * NO captured frame exists for either phase (0 occurrence in the bench corpus and in the
 * fixtures): every frame below is built from the writers named above.
 */

import { describe, expect, it } from "vitest";

import type { ConvexWriter, ToolPart } from "../src/convex-writer.js";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { SubAgentObserver } from "../src/providers/openclaw/sub-agent-observer.js";

const SK = "agent:alice:atrium:chat:u-test:c-tools";
const RUN = "webchat-00112233445566778899aabbccddeeff";

const tool = (data: Record<string, unknown>, runId = RUN) => ({
  type: "event" as const,
  event: "agent",
  payload: { runId, sessionKey: SK, stream: "tool", data },
});

/** `updateLiveEditDiffProgress`: the lower-cased tool name and the running counters. */
const inputDelta = (toolCallId: string, added: number, removed: number) =>
  tool({ phase: "input_delta", toolCallId, name: "edit", diff: { added, removed } });

/** `publishGatewayGuardianReview`. */
const gatewayReview = (
  toolCallId: string,
  status: "in_progress" | "approved" | "denied" | "aborted",
) =>
  tool({
    phase: "review",
    name: "exec",
    toolCallId,
    hideFromChannelProgress: true,
    approvalReviewOutcome:
      status === "in_progress" ? "reviewing" : status === "approved" ? "approved" : "denied",
    review: {
      id: `guardian:${toolCallId}`,
      label: "Guardian",
      status,
      ...(status === "approved" ? { riskLevel: "low", rationale: "read-only listing" } : {}),
    },
  });

/** The Codex harness's `handleGuardianReview`: no `name`. */
const codexReview = (toolCallId: string, status: string) =>
  tool({
    phase: "review",
    toolCallId,
    hideFromChannelProgress: true,
    approvalReviewOutcome: status === "approved" ? "approved" : "reviewing",
    review: { id: "rev_1", label: "Guardian", status },
  });

type ToolEvent = {
  type: string;
  phase?: string;
  name?: string | null;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
};

function drive(frames: unknown[]): ToolEvent[] {
  const n = new Normalizer(SK);
  let now = 1_000;
  n.beginTurn(now);
  n.noteRunStarted(RUN, (now += 1));
  const out: ToolEvent[] = [];
  for (const f of frames) out.push(...(n.feed(f as never, (now += 1)) as ToolEvent[]));
  return out.filter((e) => e.type === "tool.status");
}

describe("input_delta — the arguments of an edit are still being written", () => {
  const EDIT_ARGS = { path: "notes.md", oldText: "a", newText: "b" };
  const frames = [
    inputDelta("call_edit", 1, 0),
    inputDelta("call_edit", 3, 1),
    inputDelta("call_edit", 7, 2),
    tool({ phase: "start", name: "edit", toolCallId: "call_edit", args: EDIT_ARGS }),
    tool({ phase: "result", name: "edit", toolCallId: "call_edit", result: { ok: true } }),
  ];

  it("shows nothing closed before the call has started", () => {
    const before = drive(frames.slice(0, 3));
    expect(before.filter((e) => e.phase === "completed" || e.phase === "error")).toStrictEqual([]);
  });

  it("opens no card for a call that has not started (it may never start)", () => {
    // `toolcall_end` only clears upstream's tracker; nothing promises a `start`. A card
    // opened here would be closed "completed" at the turn's terminal for a tool that
    // never ran.
    expect(drive(frames.slice(0, 3))).toStrictEqual([]);
  });

  it("the call then runs as one card: started with its args, completed with them", () => {
    const events = drive(frames);
    expect(events.map((e) => e.phase)).toStrictEqual(["start", "completed"]);
    expect(events[0]).toMatchObject({ name: "edit", toolCallId: "call_edit", input: EDIT_ARGS });
    expect(events[1]).toMatchObject({
      name: "edit",
      toolCallId: "call_edit",
      input: EDIT_ARGS,
      output: { ok: true },
    });
  });

  it("…also when a delta trails the start (a second call's arguments interleaved)", () => {
    const events = drive([
      frames[3],
      inputDelta("call_edit", 9, 2),
      inputDelta("call_other", 1, 0),
      frames[4],
    ]);
    expect(events.map((e) => e.phase)).toStrictEqual(["start", "completed"]);
    expect(events[1]).toMatchObject({ input: EDIT_ARGS });
  });
});

describe("review — an exec waits for its reviewer", () => {
  const EXEC_ARGS = { command: "ls -la" };
  const start = tool({ phase: "start", name: "exec", toolCallId: "call_exec", args: EXEC_ARGS });
  const result = tool({
    phase: "result",
    name: "exec",
    toolCallId: "call_exec",
    result: { exitCode: 0 },
  });

  it("the card stays running through the review and keeps its input", () => {
    const events = drive([
      start,
      gatewayReview("call_exec", "in_progress"),
      gatewayReview("call_exec", "approved"),
      result,
    ]);
    expect(events.map((e) => e.phase)).toStrictEqual(["start", "completed"]);
    expect(events[1]).toMatchObject({ input: EXEC_ARGS, output: { exitCode: 0 } });
  });

  it("a denied review closes nothing either: the result says how the call ended", () => {
    const events = drive([
      start,
      gatewayReview("call_exec", "in_progress"),
      gatewayReview("call_exec", "denied"),
      tool({
        phase: "result",
        name: "exec",
        toolCallId: "call_exec",
        isError: true,
        result: { error: "denied" },
      }),
    ]);
    expect(events.map((e) => e.phase)).toStrictEqual(["start", "error"]);
    expect(events[1]).toMatchObject({ input: EXEC_ARGS });
  });

  it("the Codex-harness shape, which names no tool, never renames or closes the card", () => {
    const events = drive([
      start,
      codexReview("call_exec", "in_progress"),
      codexReview("call_exec", "approved"),
      result,
    ]);
    expect(events.map((e) => e.phase)).toStrictEqual(["start", "completed"]);
    expect(events.every((e) => e.name === "exec")).toBe(true);
    expect(events[1]).toMatchObject({ input: EXEC_ARGS });
  });

  it("a review for a call this turn never saw started opens nothing", () => {
    expect(drive([codexReview("call_unknown", "in_progress")])).toStrictEqual([]);
  });
});

describe("what still closes a card", () => {
  it("a phase this build does not know, carrying a result, closes it", () => {
    // The allowlist names the phases that are NOT terminal on purpose: a card stuck
    // spinning is worse than one closed by an unrecognised name.
    const events = drive([
      tool({ phase: "start", name: "read", toolCallId: "c1", args: { path: "a" } }),
      tool({ phase: "finished", name: "read", toolCallId: "c1", result: "text" }),
    ]);
    expect(events.map((e) => e.phase)).toStrictEqual(["start", "completed"]);
    expect(events[1]).toMatchObject({ input: { path: "a" }, output: "text" });
  });

  it("`update` is still progress, with the card re-stated as running", () => {
    const events = drive([
      tool({ phase: "start", name: "exec", toolCallId: "c2", args: { command: "x" } }),
      tool({ phase: "update", name: "exec", toolCallId: "c2", partialResult: { aggregated: "…" } }),
    ]);
    expect(events.map((e) => e.phase)).toStrictEqual(["start", "start"]);
  });
});

class CountingWriter implements ConvexWriter {
  readonly parts: ToolPart[] = [];
  readonly pressures: Record<string, unknown>[] = [];
  async startAssistant(): Promise<string> {
    return "msg_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_m: string, p: ToolPart): Promise<void> {
    this.parts.push(JSON.parse(JSON.stringify(p)) as ToolPart);
  }
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(_c: string, _m: string, data: Record<string, unknown>): Promise<void> {
    this.pressures.push(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
  }
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async noteFrameGap(): Promise<void> {}
  async finalize(): Promise<void> {}
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async reportSessionRoster(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  async emitRehydrateTrace(): Promise<void> {}
}

describe("the turn's tool count and its cards (run manager → sink → writer)", () => {
  it("one edit with three deltas and one reviewed exec count as two tools, on two cards", async () => {
    const writer = new CountingWriter();
    const manager = new RunManager("chat-f3", SK, writer);
    manager.setGatewayVersionSource(() => "2026.9.36");
    let now = 1_000;
    await manager.beginTurn(now, RUN, {
      expectedSessionId: null,
      pressure: {
        totalTokens: 40_000,
        contextTokens: 272_000,
        fillPct: 15,
        fillSource: "gateway_estimate",
        model: "gpt-5.5",
      },
      dispatchOutboxId: "ob-1",
    });
    for (const f of [
      inputDelta("call_edit", 1, 0),
      inputDelta("call_edit", 3, 1),
      inputDelta("call_edit", 7, 2),
      tool({ phase: "start", name: "edit", toolCallId: "call_edit", args: { path: "n.md" } }),
      tool({ phase: "result", name: "edit", toolCallId: "call_edit", result: { ok: true } }),
      tool({ phase: "start", name: "exec", toolCallId: "call_exec", args: { command: "ls" } }),
      gatewayReview("call_exec", "in_progress"),
      gatewayReview("call_exec", "approved"),
      tool({ phase: "result", name: "exec", toolCallId: "call_exec", result: { exitCode: 0 } }),
      {
        type: "event" as const,
        event: "chat",
        payload: {
          runId: RUN,
          sessionKey: SK,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      },
    ]) {
      await manager.feed(f, (now += 10));
    }
    for (let i = 0; i < 40 && writer.pressures.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(writer.pressures[0]).toMatchObject({ toolCalls: 2 });
    expect(writer.parts.map((p) => `${p.name}:${p.phase}`)).toStrictEqual([
      "edit:start",
      "edit:completed",
      "exec:start",
      "exec:completed",
    ]);
    expect(writer.parts[3]).toMatchObject({ input: { command: "ls" }, output: { exitCode: 0 } });
  });
});

describe("a sub-agent's call (the observer)", () => {
  // A child's tool frames reach the observer in the same shape, on the child's lane.
  const PARENT = "agent:alice:atrium:chat:u-test:c-tools-parent";
  const CHILD = "agent:alice:subagent:5f0c7d5e-8f1a-4a43-9a51-1f8c6a2f7e10";
  const child = (data: Record<string, unknown>) => ({
    event: "agent",
    payload: { stream: "tool", sessionKey: CHILD, spawnedBy: PARENT, data },
  });

  const delta = child({
    phase: "input_delta",
    toolCallId: "call_edit",
    name: "edit",
    diff: { added: 2, removed: 0 },
  });

  it("a delta before the start lists no tool", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    expect(obs.observe(delta, 100).some((u) => (u.tools?.length ?? 0) > 0)).toBe(false);
  });

  it("…and the start that follows still records the call's arguments", () => {
    // The start's detail rides the emission where the tool first appears: a tool listed
    // by an earlier delta made the start a no-change, and its arguments were lost.
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(delta, 100);
    const ups = obs.observe(
      child({ phase: "start", name: "edit", toolCallId: "call_edit", args: { path: "CHILD_ARGS.md" } }),
      101,
    );
    expect(ups.at(-1)?.tools).toStrictEqual([
      { name: "edit", status: "running", toolCallId: "call_edit" },
    ]);
    expect(ups.at(-1)?.toolPart?.argsText).toContain("CHILD_ARGS.md");
  });

  it("a review leaves the running tool as it is, and the result still closes it", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(child({ phase: "start", name: "exec", toolCallId: "call_exec", args: { command: "ls" } }), 100);
    const during = obs.observe(
      child({
        phase: "review",
        name: "exec",
        toolCallId: "call_exec",
        approvalReviewOutcome: "approved",
        review: { id: "guardian:call_exec", label: "Guardian", status: "approved" },
      }),
      101,
    );
    expect(during.some((u) => u.toolPart !== undefined)).toBe(false);
    const ups = obs.observe(
      child({ phase: "result", name: "exec", toolCallId: "call_exec", result: "ok" }),
      102,
    );
    expect(ups.at(-1)?.tools).toStrictEqual([
      { name: "exec", status: "done", toolCallId: "call_exec" },
    ]);
  });
});
