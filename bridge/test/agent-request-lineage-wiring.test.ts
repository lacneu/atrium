// N1 + N2 ON THE REAL SESSION (lot « trames 1 »): a sub-agent's approval reaches the
// conversation that spawned it, the answer path accepts it for that conversation, and a NEW
// socket (a reconnection: its observer starts empty) lists what still waits and records it.
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
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { buildSessionKey } from "../src/providers/openclaw/session-keys.js";
import {
  execApprovalRequestedFrame,
  execApprovalRequestedPayload,
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

describe("a sub-agent's approval on the real Session", () => {
  it("is shown in the parent conversation, answerable there, and listed again on a new socket", async () => {
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
    // The parent's spawn result registers the child (sub-agent-observer.ts).
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
    // The child asks for an approval: the broadcast names the CHILD's session.
    state.pending = [child];
    state.rows.set(CHILD, { key: CHILD, spawnedBy: PARENT, status: "running" });
    conv1.push(execApprovalRequestedFrame(child));
    await sleep(30);
    expect(upserts.map((u) => [u.chatId, u.providerRequestId, u.sessionKey, u.agentId])).toEqual([
      ["c1", child.approvalId, CHILD, "files"],
    ]);
    // The answer path: this conversation answers for its sub-agent's session.
    expect(await reg.peekByChat("c1")!.answersFor(CHILD)).toBe(true);
    expect(await reg.peekByChat("c1")!.answersFor("agent:files:subagent:not-ours")).toBe(false);

    // A reconnection: the new socket inherits nothing, lists what still waits, and records it.
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
      [child.approvalId, CHILD],
      [child.approvalId, CHILD],
    ]);
    expect(await reg.peekByChat("c1")!.answersFor(CHILD)).toBe(true);
    reg.closeAll();
  });
});
