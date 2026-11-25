// N2 ON THE REAL SESSION (lot « trames 1 »): the conversation's own approval is shown, and a
// NEW socket (a reconnection: its observer starts empty) lists what still waits and records
// it. A SUB-AGENT's approval is not shown in the parent conversation, nor answered from it —
// deliberately, until N1-v2 (agent-request-observer.ts header): not even when the parent's
// own frames registered the child and the gateway's row names the parent.
//
// Frames and answers are the captured 2026.9.36 shapes (helpers/approval-frames-2026.9.36.ts);
// the spawn result is the one child-row-status-wiring.test.ts drives (sessions_spawn
// `childSessionKey`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "./helpers/sleep.js";

import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import { servedMap } from "./helpers/served.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import type { AgentRequestRecord } from "../src/core/agent-requests.js";
import { respondOpenClaw } from "../src/agent-request-respond.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { buildSessionKey } from "../src/providers/openclaw/session-keys.js";
import {
  execApprovalRequestedFrame,
  execApprovalRequestedPayload,
  execApprovalResolvedFrame,
  pendingApprovalGet,
  type ApprovalIds,
} from "./helpers/approval-frames-2026.9.36.js";

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;
const ROUTING = {
  chatId: "c1",
  openclawChatId: "oc1",
  agentId: "alice",
  canonical: "olivier",
  instanceName: "primary",
};
const PARENT = buildSessionKey(ROUTING.openclawChatId, ROUTING.agentId, ROUTING.canonical);
const CHILD = "agent:files:subagent:11111111-1111-4111-8111-111111111111";
const own: ApprovalIds = {
  sessionKey: PARENT,
  runId: "run-1",
  approvalId: "a0000000-0000-4000-8000-0000000000a1",
  toolCallId: "tool_call:call_a:exec:1",
};
const child: ApprovalIds = {
  sessionKey: CHILD,
  runId: "child-run-1",
  approvalId: "a0000000-0000-4000-8000-0000000000c1",
  toolCallId: "tool_call:call_c:exec:1",
  agentId: "files",
};

/** A conversation socket on a gateway that shows agent requests (2026.9.36). */
function conversationSocket(state: { pending: ApprovalIds[]; rows: Map<string, Record<string, unknown>> }) {
  let closed = false;
  const buffer: unknown[] = [];
  let pending: ((r: IteratorResult<unknown>) => void) | null = null;
  const closedListeners: Array<() => void> = [];
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    gatewayVersion: "2026.9.36",
    calls,
    push(frame: unknown) {
      if (pending) {
        const p = pending;
        pending = null;
        p({ value: frame, done: false });
      } else buffer.push(frame);
    },
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
      for (const l of closedListeners.splice(0)) l();
      if (pending) {
        const p = pending;
        pending = null;
        p({ value: undefined, done: true });
      }
    },
    onConfigChanged: () => () => {},
    onSessionSharing: () => () => {},
    onClosed: (l: () => void) => {
      closedListeners.push(l);
      return () => {};
    },
    frames() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => (pending = resolve));
        },
      };
    },
    async request(method: string, params: Record<string, unknown>) {
      calls.push([method, params]);
      if (method === "approval.get") {
        const ids = state.pending.find((x) => x.approvalId === params.id);
        return { type: "res", ok: true, payload: ids ? pendingApprovalGet(ids) : null };
      }
      if (method === "exec.approval.list") {
        return { type: "res", ok: true, payload: state.pending.map(execApprovalRequestedPayload) };
      }
      if (method === "plugin.approval.list" || method === "openclaw.approval.list") {
        return { type: "res", ok: true, payload: [] };
      }
      if (method === "question.list") return { type: "res", ok: true, payload: { questions: [] } };
      if (method === "sessions.describe") {
        return { type: "res", ok: true, payload: { session: state.rows.get(params.key as string) ?? null } };
      }
      if (method === "sessions.list") {
        return {
          type: "res",
          ok: true,
          payload: { sessions: [...state.rows.values()].filter((r) => r.spawnedBy === PARENT) },
        };
      }
      return { type: "res", ok: true, payload: {} };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("approvals on the real Session: its own session's only", () => {
  it("its own is shown and listed again on a new socket — its sub-agent's is neither shown nor answerable", async () => {
    const state = { pending: [] as ApprovalIds[], rows: new Map<string, Record<string, unknown>>() };
    const sockets: Array<ReturnType<typeof conversationSocket>> = [];
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      const c = conversationSocket(state);
      sockets.push(c);
      return c as never;
    });
    const upserts: AgentRequestRecord[] = [];
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addToolPart: async () => {},
      addMedia: async () => {},
      finalize: async () => {},
      reportSessionMeta: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      upsertSubAgent: async () => {},
      upsertAgentRequest: async (r: AgentRequestRecord) => {
        upserts.push(r);
        return { recorded: true };
      },
      settleAgentRequest: async () => {},
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);

    const s1 = await reg.acquire(ROUTING);
    await sleep(5);
    // The LAST socket: the first handshake proves the version and the socket re-opens once
    // with `approvals` (session.ts approvalCaps).
    const conv1 = sockets.at(-1)!;
    expect(conv1.isClosed).toBe(false);
    // The parent's spawn result registers the child (sub-agent-observer.ts), and the
    // gateway's row of the child names the parent.
    await s1.runManager.beginTurn(1000, "run-1");
    s1.wake();
    conv1.push({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: PARENT,
        runId: "run-1",
        stream: "tool",
        data: {
          phase: "result",
          name: "sessions_spawn",
          meta: "task wait, agent files",
          result: { contentItems: [{ text: JSON.stringify({ childSessionKey: CHILD, status: "accepted" }) }] },
        },
      },
    });
    await sleep(20);
    state.rows.set(CHILD, { key: CHILD, spawnedBy: PARENT, status: "running" });
    state.pending = [own, child];
    conv1.push(execApprovalRequestedFrame(own));
    conv1.push(execApprovalRequestedFrame(child));
    await sleep(30);
    expect(upserts.map((u) => [u.chatId, u.providerRequestId, u.sessionKey])).toEqual([["c1", own.approvalId, PARENT]]);
    expect(
      conv1.calls.filter(([m, p]) => m === "approval.get" && p.id === child.approvalId),
      "the child's request is not even read",
    ).toEqual([]);

    // The answer path: the child's card is refused before anything reaches the gateway — a
    // refusal, never a verdict that would close a card.
    const operator = { calls: [] as string[], request: async (m: string) => (operator.calls.push(m), { type: "res", ok: true, payload: null }) };
    expect(
      await respondOpenClaw(
        {
          chatId: "c1",
          instanceName: "primary",
          provider: "openclaw",
          source: "openclaw.exec",
          providerRequestId: child.approvalId,
          providerCreatedAt: execApprovalRequestedPayload(child).createdAtMs as number,
          approvalKind: "exec",
          sessionKey: CHILD,
          skip: false,
          decision: "allow-once",
        },
        operator,
        reg.peekByChat("c1")!.routedApproval(child.approvalId),
        reg.peekByChat("c1"),
      ),
    ).toEqual({ ok: false, httpStatus: 403, code: "session_mismatch" });
    expect(operator.calls).toEqual([]);

    // A reconnection: the new socket inherits nothing, lists what still waits, and records its
    // own session's — the child's stays out.
    conv1.close();
    await sleep(20);
    const s2 = await reg.acquire(ROUTING);
    expect(s2).not.toBe(s1);
    await sleep(40);
    const conv2 = sockets.at(-1)!;
    expect(conv2).not.toBe(conv1);
    expect(conv2.calls.map(([m]) => m)).toEqual(
      expect.arrayContaining(["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"]),
    );
    expect(upserts.map((u) => [u.providerRequestId, u.sessionKey])).toEqual([
      [own.approvalId, PARENT],
      [own.approvalId, PARENT],
    ]);
    reg.closeAll();
  });

  // The gateway version served here (2026.9.36) writes the frame exactly as 2026.10.33 does:
  // the same treatment applies to both.
  it("an approval allowed, then failed on the gateway: the session hands the word to the writer, for that card", async () => {
    const state = { pending: [own] as ApprovalIds[], rows: new Map<string, Record<string, unknown>>() };
    const sockets: Array<ReturnType<typeof conversationSocket>> = [];
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      const c = conversationSocket(state);
      sockets.push(c);
      return c as never;
    });
    const writes: Array<[string, unknown]> = [];
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addToolPart: async () => {},
      addMedia: async () => {},
      finalize: async () => {},
      reportSessionMeta: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      upsertSubAgent: async () => {},
      upsertAgentRequest: async () => ({ recorded: true }),
      settleAgentRequest: async (s: { status: string }) => {
        writes.push(["settle", s.status]);
        return { outcome: "settled" };
      },
      agentRequestGatewayFailed: async (f: unknown) => {
        writes.push(["gateway-failed", f]);
        return { outcome: "marked" };
      },
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const s1 = await reg.acquire(ROUTING);
    await sleep(5);
    const conv = sockets.at(-1)!;
    await s1.runManager.beginTurn(1000, own.runId);
    s1.wake();
    conv.push(execApprovalRequestedFrame(own));
    await sleep(30);
    conv.push(execApprovalResolvedFrame(own, "allow-once"));
    conv.push({
      type: "event",
      event: "agent",
      payload: {
        runId: own.runId,
        sessionKey: PARENT,
        stream: "approval",
        data: { phase: "resolved", kind: "exec", status: "failed", title: "<masked>", toolCallId: own.toolCallId, message: "<masked>" },
      },
    });
    await sleep(40);
    expect(writes).toEqual([
      ["settle", "allowed"],
      [
        "gateway-failed",
        {
          chatId: "c1",
          providerRequestId: own.approvalId,
          providerCreatedAt: execApprovalRequestedPayload(own).createdAtMs,
        },
      ],
    ]);
    reg.closeAll();
  });
});
