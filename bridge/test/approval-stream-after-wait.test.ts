/**
 * `stream:"approval"` beside the run's own `waiting-approval` / `approval-resolved`.
 *
 * Both exist on every validated gateway (v2026.8.2 to v2026.9.36) and say different things:
 *   - the run that waits IN PLACE says so on its lifecycle, around the wait
 *     (src/agents/bash-tools.exec-host-gateway.ts);
 *   - `stream:"approval"` is written when the exec tool COMPLETES
 *     (src/agents/embedded-agent-subscribe.handlers.tools.completion.ts): `requested` when
 *     the exec returned instead of waiting — `status:"pending"` (an approval is waiting,
 *     with its `approvalId`) or `status:"unavailable"` (nobody can be asked, no id) — and
 *     `resolved` (`denied` / `failed`) when the result of the exec is an approval refusal,
 *     which is also how an in-place wait that ends in a refusal finishes.
 * So one approval can produce `waiting-approval`, `approval-resolved` and then an approval
 * `resolved`: three frames, one wait. The Control UI reads the lifecycle pair only.
 *
 * The first sequence is verbatim from the bench (run 2026-11-08T00-15-04-531Z, scenario
 * `agent-request-approval-long-wait`, envelope seq 25-80, free text and arguments masked):
 * the approval was granted (`allow-once`), the exec then refused with
 * `approval-request-failed`, and the approval stream said `resolved` / `failed`.
 * `requested` was never captured in either status: those frames are built from the writer.
 */

import { describe, expect, it } from "vitest";

import { Normalizer } from "../src/providers/openclaw/normalizer.js";

const SK = "agent:alice:atrium:chat:u-repro:turn-approval";
const RUN = "webchat-1f7e624e60d39871aaeba9005f2b0c45072da2c772efc7c79c1311d5539e5575";
const TC =
  "tool_call:call_54cbe5b9cbe44c04967a23869386409c_fc_074a3cc0921af70b016aefbf30613887d2b4b61731c47eb540:exec:1";
const PARENT = "call_54cbe5b9cbe44c04967a23869386409c|fc_074a3cc0921af70b016aefbf30613887d2b4b61731c47eb540";
const APPROVAL = "097b5f4c-1569-4997-a127-8960d9c06f17";

const agent = (stream: string, data: Record<string, unknown>) => ({
  type: "event" as const,
  event: "agent",
  payload: { runId: RUN, sessionKey: SK, stream, data },
});

/** Verbatim keys and order (seq 25, 27, 76, 77, 80). */
const CAPTURED = {
  start: agent("tool", { phase: "start", name: "exec", toolCallId: TC, parentToolCallId: PARENT, args: { command: "<masked>" } }),
  waiting: agent("lifecycle", { phase: "waiting-approval", approvalId: APPROVAL, toolCallId: TC }),
  resolvedOnLifecycle: agent("lifecycle", { phase: "approval-resolved", approvalId: APPROVAL, toolCallId: TC }),
  result: agent("tool", {
    phase: "result",
    name: "exec",
    toolCallId: TC,
    parentToolCallId: PARENT,
    meta: "<masked>",
    isError: true,
    commandBearing: true,
    result: "<masked>",
  }),
  resolvedOnApprovalStream: agent("approval", {
    phase: "resolved",
    kind: "exec",
    status: "failed",
    title: "<masked>",
    itemId: `command:${TC}`,
    toolCallId: TC,
    message: "<masked>",
  }),
};

/** Source-derived: the exec RETURNED `approval-unavailable` (no id, nobody to ask). */
const unavailable = (toolCallId: string) =>
  agent("approval", {
    phase: "requested",
    kind: "exec",
    status: "unavailable",
    title: "Command approval unavailable",
    itemId: `command:${toolCallId}`,
    toolCallId,
    command: "<masked>",
    host: "gateway",
    reason: "no-approval-route",
    message: "<masked>",
  });
/** Source-derived: the exec RETURNED `approval-pending`. */
const pending = (toolCallId: string, approvalId: string) =>
  agent("approval", {
    phase: "requested",
    kind: "exec",
    status: "pending",
    title: "Command approval requested",
    itemId: `command:${toolCallId}`,
    toolCallId,
    approvalId,
    approvalSlug: approvalId.slice(0, 8),
    command: "<masked>",
    host: "gateway",
    message: "<masked>",
  });
const speaks = agent("assistant", { text: "La commande n’a pas été exécutée.", delta: "La commande n’a pas été exécutée." });

function open(): { n: Normalizer; feed: (frame: unknown) => string[]; now: () => number } {
  const n = new Normalizer(SK);
  let now = 1_000;
  n.beginTurn(now);
  n.noteRunStarted(RUN, ++now);
  return {
    n,
    now: () => now,
    feed: (frame) =>
      n
        .feed(frame as never, ++now)
        .filter((e) => e.type === "turn.phase")
        .map((e) => String((e as { phase?: unknown }).phase)),
  };
}

describe("the captured order: lifecycle wait, lifecycle release, then the approval stream", () => {
  it("is one wait: held once, released once, and the late `resolved` holds nothing", () => {
    const t = open();
    t.feed(CAPTURED.start);
    expect(t.feed(CAPTURED.waiting)).toStrictEqual(["awaiting_approval"]);
    expect(t.n.recvDeadlineArmed, "a person decides: the silence clock is stopped").toBe(false);
    expect(t.feed(CAPTURED.resolvedOnLifecycle)).toStrictEqual(["generating"]);
    expect(t.n.recvDeadlineArmed).toBe(true);
    t.feed(CAPTURED.result);
    // Nothing is left to release: it publishes no phase at all — a `generating` here
    // would clear whatever label another producer set meanwhile.
    expect(t.feed(CAPTURED.resolvedOnApprovalStream)).toStrictEqual([]);
    expect(t.n.recvDeadlineArmed, "nothing waits on a person any more").toBe(true);
  });

  it("the late `resolved` does not release ANOTHER command still waiting on a person", () => {
    const t = open();
    t.feed(CAPTURED.start);
    t.feed(CAPTURED.waiting);
    t.feed(agent("lifecycle", { phase: "waiting-approval", approvalId: "second-approval", toolCallId: "tc-second" }));
    t.feed(CAPTURED.resolvedOnLifecycle);
    t.feed(CAPTURED.result);
    expect(t.feed(CAPTURED.resolvedOnApprovalStream)).toStrictEqual([]);
    expect(t.n.recvDeadlineArmed, "the second command still waits on a person").toBe(false);
  });

  it("the turn counted ONE request: the reply that follows a single wait still ends it", () => {
    // The lifecycle release went to another socket (a reconnection): the reply itself is
    // then what says the approval was answered — a rule that holds for a turn that asked
    // once, so a second count for the same approval would switch it off.
    const t = open();
    t.feed(CAPTURED.start);
    t.feed(CAPTURED.waiting);
    t.feed(CAPTURED.result);
    t.feed(CAPTURED.resolvedOnApprovalStream);
    // The stream's `resolved` names the tool call, which the wait is also known by.
    expect(t.n.recvDeadlineArmed, "released: the silence clock runs again").toBe(true);
  });
});

describe("a `resolved` that matches nothing", () => {
  it("does not wipe a provider back-off label that stands", () => {
    const t = open();
    t.feed(CAPTURED.start);
    t.feed(CAPTURED.waiting);
    t.feed(CAPTURED.resolvedOnLifecycle);
    t.feed(CAPTURED.result);
    // Shape-faithful: the retry the embedded runner emits (attempt-recovery.ts onRetry).
    expect(
      t.feed(agent("run_status", { phase: "retrying", attempt: 2, maxAttempts: 4, reason: "overloaded" })),
    ).toStrictEqual(["retrying"]);
    expect(t.feed(CAPTURED.resolvedOnApprovalStream)).toStrictEqual([]);
  });

  it("an unnamed one still answers an unnamed request", () => {
    const t = open();
    expect(t.feed(agent("approval", { phase: "requested", kind: "exec", status: "pending" }))).toStrictEqual([
      "awaiting_approval",
    ]);
    expect(t.feed(agent("approval", { phase: "resolved", kind: "exec", status: "denied" }))).toStrictEqual([
      "generating",
    ]);
  });
});

describe("`requested` on the approval stream", () => {
  it("`pending` holds the turn, and is the same request as its `waiting-approval`", () => {
    const t = open();
    expect(t.feed(pending("tc-a", "approval-a"))).toStrictEqual(["awaiting_approval"]);
    // Seen again on the lifecycle: not a second request.
    expect(
      t.feed(agent("lifecycle", { phase: "waiting-approval", approvalId: "approval-a", toolCallId: "tc-a" })),
    ).toStrictEqual([]);
    expect(t.feed(agent("lifecycle", { phase: "approval-resolved", approvalId: "approval-a", toolCallId: "tc-a" }))).toStrictEqual([
      "generating",
    ]);
    expect(t.n.recvDeadlineArmed).toBe(true);
  });

  it("`unavailable` asks nobody: the turn is not held and keeps its silence clock", () => {
    const t = open();
    expect(t.feed(unavailable("tc-u1"))).toStrictEqual([]);
    expect(t.n.recvDeadlineArmed).toBe(true);
  });

  it("two `unavailable` commands do not leave the turn waiting for an approval while it replies", () => {
    const t = open();
    t.feed(unavailable("tc-u1"));
    t.feed(unavailable("tc-u2"));
    t.feed(speaks);
    expect(t.n.recvDeadlineArmed).toBe(true);
  });

  it("an `unavailable` beside a real wait leaves that wait alone, and uncounted", () => {
    const t = open();
    t.feed(CAPTURED.start);
    t.feed(CAPTURED.waiting);
    t.feed(unavailable("tc-u1"));
    expect(t.n.recvDeadlineArmed, "the real wait still holds").toBe(false);
    // One request this turn: the reply that follows still releases it.
    t.feed(speaks);
    expect(t.n.recvDeadlineArmed).toBe(true);
  });
});
