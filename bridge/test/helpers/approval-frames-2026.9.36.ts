// EXEC APPROVAL FRAMES as OpenClaw 2026.9.36 sends them — the SHAPES of a live capture, its
// identifiers and contents replaced by neutral values.
//
// Source: the GO bench of 2026-11-02 (run 2026-11-02T22-06-41-810Z, scenario
// `agent-request-exec-approval`, captured frames 197-211 of its slice): the request
// broadcast, the run's own `waiting-approval` / `approval-resolved` lifecycle, the
// `approval.get` answer and the resolution broadcast, in that order on each socket. Every
// key below is the captured key, in the captured order; `expiresAtMs - createdAtMs` is the
// captured 1 800 000 ms (the gateway's default exec timeout,
// src/infra/exec-approvals-core.ts:296). The pending lists (`exec.approval.list`) answer an
// array of the broadcast's own payload (server-methods/approval-record-lookup.ts:121-155).

export interface ApprovalIds {
  sessionKey: string;
  runId: string;
  approvalId: string;
  toolCallId: string;
  agentId?: string;
  createdAtMs?: number;
}

const TIMEOUT_MS = 1_800_000;

/** The `request` of an exec approval broadcast (24 keys, captured order). */
export function execApprovalRequest(ids: ApprovalIds): Record<string, unknown> {
  return {
    command: "echo BENCH_APPROVAL_OK",
    systemRunBinding: null,
    systemRunPlan: null,
    cwd: "/home/node/.openclaw/workspace-x",
    nodeId: null,
    host: "gateway",
    security: "allowlist",
    ask: "on-miss",
    warningText: null,
    scope: null,
    commandAnalysis: { commandCount: 1, nestedCommandCount: 0, riskKinds: [], warningLines: [] },
    allowedDecisions: ["allow-once", "allow-always", "deny"],
    agentId: ids.agentId ?? "alice",
    resolvedPath: "/usr/bin/echo",
    sessionKey: ids.sessionKey,
    sessionId: null,
    runId: ids.runId,
    toolCallId: ids.toolCallId,
    turnSourceChannel: "webchat",
    turnSourceTo: null,
    turnSourceAccountId: null,
    turnSourceThreadId: null,
    cronExecutionSource: null,
    cronOperationBinding: null,
  };
}

/** The `exec.approval.requested` payload — also one entry of `exec.approval.list`. */
export function execApprovalRequestedPayload(ids: ApprovalIds): Record<string, unknown> {
  const createdAtMs = ids.createdAtMs ?? 1_793_658_291_732;
  return {
    approvalKind: "exec",
    id: ids.approvalId,
    request: execApprovalRequest(ids),
    createdAtMs,
    expiresAtMs: createdAtMs + TIMEOUT_MS,
  };
}

export function execApprovalRequestedFrame(ids: ApprovalIds, seq = 3421): Record<string, unknown> {
  return { type: "event", event: "exec.approval.requested", payload: execApprovalRequestedPayload(ids), seq };
}

/** The run's own lifecycle around the wait (bash-tools.exec-host-gateway.ts:1313-1337). */
export function approvalLifecycleFrame(
  ids: ApprovalIds,
  phase: "waiting-approval" | "approval-resolved",
  seq = 13,
): Record<string, unknown> {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: ids.runId,
      sessionKey: ids.sessionKey,
      sessionId: "00000000-0000-4000-8000-000000000003",
      stream: "lifecycle",
      data: { phase, approvalId: ids.approvalId, toolCallId: ids.toolCallId },
      agentId: ids.agentId ?? "alice",
      seq,
      ts: 1_793_658_291_720 + seq,
      isHeartbeat: false,
    },
    seq: 3422 + seq,
  };
}

/** The `approval.get` answer for a pending exec approval (captured response). */
export function pendingApprovalGet(ids: ApprovalIds): Record<string, unknown> {
  const createdAtMs = ids.createdAtMs ?? 1_793_658_291_732;
  return {
    approval: {
      id: ids.approvalId,
      status: "pending",
      presentation: {
        kind: "exec",
        commandText: "echo BENCH_APPROVAL_OK",
        commandPreview: null,
        warningText: null,
        host: "gateway",
        nodeId: null,
        agentId: ids.agentId ?? "alice",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
      urlPath: `/approve/${ids.approvalId}`,
      createdAtMs,
      expiresAtMs: createdAtMs + TIMEOUT_MS,
    },
  };
}

/** The `exec.approval.resolved` broadcast (captured keys). */
export function execApprovalResolvedFrame(
  ids: ApprovalIds,
  decision: "allow-once" | "allow-always" | "deny" = "allow-once",
): Record<string, unknown> {
  return {
    type: "event",
    event: "exec.approval.resolved",
    payload: {
      id: ids.approvalId,
      decision,
      resolvedBy: "cli",
      ts: 1_793_658_297_797,
      request: execApprovalRequest(ids),
    },
    seq: 3424,
  };
}
