// A SUB-AGENT'S APPROVAL (N1) AND THE PENDING ONES AFTER A RECONNECTION (N2) — lot « trames 1 ».
//
// N1. Upstream addresses an approval to the raising session's LINEAGE
// (src/gateway/approval-session-audience.ts:52-107 at v2026.9.36); the operator broadcast
// names the raising session itself (server-methods/approval-shared.ts:133-147). The
// observer accepted only its conversation's own key, so a sub-agent's approval was shown
// nowhere and the child waited out the gateway's 30 min.
//
// N2. The broadcast is sent once, `dropIfSlow` (approval-shared.ts:340-368). The Control UI
// lists the pending ones at every connection — `exec.approval.list`, `plugin.approval.list`,
// `openclaw.approval.list` (ui/src/app/exec-approval.ts:419-473) — and Atrium never did
// ("there is no approval replay" was wrong). Each entry has the broadcast's own shape
// (approval-record-lookup.ts:121-155).
//
// The frames and RPC answers are the captured 2026.9.36 shapes
// (helpers/approval-frames-2026.9.36.ts).
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenClawAgentRequestObserver } from "../src/providers/openclaw/agent-request-observer.js";
import { ApprovalLineage } from "../src/providers/openclaw/approval-lineage.js";
import type { AgentRequestRecord, AgentRequestSettle } from "../src/core/agent-requests.js";
import {
  execApprovalRequestedFrame,
  execApprovalRequestedPayload,
  execApprovalResolvedFrame,
  pendingApprovalGet,
  type ApprovalIds,
} from "./helpers/approval-frames-2026.9.36.js";

const PARENT = "agent:alice:atrium:chat:u-1:c1";
const OTHER_PARENT = "agent:alice:atrium:chat:u-2:c2";
const CHILD = "agent:files:subagent:11111111-1111-4111-8111-111111111111";
const STRANGER = "agent:files:subagent:99999999-9999-4999-8999-999999999999";
const NOW = 1_793_658_291_800;

const own: ApprovalIds = {
  sessionKey: PARENT,
  runId: "webchat-run-1",
  approvalId: "a0000000-0000-4000-8000-000000000001",
  toolCallId: "tool_call:call_1:exec:1",
};
const child: ApprovalIds = {
  sessionKey: CHILD,
  runId: "child-run-1",
  approvalId: "a0000000-0000-4000-8000-000000000002",
  toolCallId: "tool_call:call_2:exec:1",
  agentId: "files",
};
const stranger: ApprovalIds = {
  sessionKey: STRANGER,
  runId: "stranger-run",
  approvalId: "a0000000-0000-4000-8000-000000000003",
  toolCallId: "tool_call:call_3:exec:1",
  agentId: "files",
};

interface Setup {
  knownChildren?: Record<string, string | null>;
  rows?: Record<string, Record<string, unknown> | null>;
  pending?: { exec?: ApprovalIds[]; plugin?: unknown[]; openclaw?: unknown[] };
  /** Methods the gateway refuses, with the message it refuses with. */
  refuse?: Record<string, string>;
  /** Approval ids `approval.get` reports as no longer pending. */
  settled?: Set<string>;
}

function setup(opts: Setup = {}) {
  const upserts: AgentRequestRecord[] = [];
  const settles: AgentRequestSettle[] = [];
  const requested: Array<[string, Record<string, unknown>]> = [];
  const released: string[] = [];
  const rpcs: Array<[string, unknown]> = [];
  let describeGate: Promise<void> = Promise.resolve();
  const lineage = new ApprovalLineage({
    sessionKey: PARENT,
    knownChild: (key) =>
      opts.knownChildren !== undefined && key in opts.knownChildren
        ? { anchorMessageId: opts.knownChildren[key]! }
        : null,
    describe: async (key) => {
      rpcs.push(["sessions.describe", { key }]);
      await describeGate;
      return opts.rows?.[key] ?? null;
    },
    nowMs: () => NOW,
  });
  const all = [own, child, stranger];
  const obs = new OpenClawAgentRequestObserver({
    chatId: "c1",
    sessionKey: PARENT,
    agentId: "alice",
    gateway: {
      request: async (method: string, params: Record<string, unknown>) => {
        rpcs.push([method, params]);
        if (opts.refuse?.[method] !== undefined) throw new Error(opts.refuse[method]);
        let payload: unknown = null;
        if (method === "approval.get") {
          const ids = all.find((x) => x.approvalId === (params as { id: string }).id);
          payload =
            ids === undefined
              ? null
              : opts.settled?.has(ids.approvalId)
                ? { approval: { ...(pendingApprovalGet(ids).approval as object), status: "allowed" } }
                : pendingApprovalGet(ids);
        } else if (method === "exec.approval.list") {
          payload = (opts.pending?.exec ?? []).map(execApprovalRequestedPayload);
        } else if (method === "plugin.approval.list") {
          payload = opts.pending?.plugin ?? [];
        } else if (method === "openclaw.approval.list") {
          payload = opts.pending?.openclaw ?? [];
        } else if (method === "question.list") {
          payload = { questions: [] };
        }
        return { type: "res", ok: true, payload };
      },
    },
    upsert: async (r) => {
      upserts.push(r);
    },
    settle: async (s) => {
      settles.push(s);
    },
    currentMessageId: () => "msg-live",
    noteQuestion: async () => true,
    noteQuestionSettled: async () => {},
    noteApprovalSettled: async (id) => {
      released.push(id);
    },
    noteApprovalRequested: async (id, facts) => {
      requested.push([id, facts]);
    },
    audience: {
      known: (key) => lineage.known(key),
      resolve: (key) => lineage.resolve(key),
    },
    wake: () => {},
    nowMs: () => NOW,
  });
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    obs,
    upserts,
    settles,
    requested,
    released,
    rpcs,
    flush,
    holdDescribe: () => {
      let open: () => void = () => {};
      describeGate = new Promise<void>((r) => (open = r));
      return () => open();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("N1 — a sub-agent's approval reaches the conversation that spawned it", () => {
  it("a KNOWN child's request is recorded here, as the child's, under the bubble it was spawned from", async () => {
    const t = setup({ knownChildren: { [CHILD]: "msg-spawn" } });
    await t.obs.observe(execApprovalRequestedFrame(child));
    await t.flush();
    expect(t.upserts).toHaveLength(1);
    expect(t.upserts[0]).toMatchObject({
      chatId: "c1",
      source: "openclaw.exec",
      providerRequestId: child.approvalId,
      // The raising session and agent — what the answer path re-checks.
      sessionKey: CHILD,
      agentId: "files",
      messageId: "msg-spawn",
      runId: child.runId,
      expiresAt: (execApprovalRequestedPayload(child).expiresAtMs as number),
      approval: { command: "echo BENCH_APPROVAL_OK" },
    });
    expect(t.obs.routedApproval(child.approvalId)).toBe(true);
    expect(await t.obs.answersFor(CHILD)).toBe(true);
    // The PARENT's turn is not held by the child's wait (the Control UI scopes the waiting
    // state to the pane's own session).
    expect(t.requested).toEqual([]);
  });

  it("an UNKNOWN sub-agent proven by the gateway's row — without holding the frame loop", async () => {
    const t = setup({ rows: { [CHILD]: { key: CHILD, spawnedBy: PARENT } } });
    const open = t.holdDescribe();
    // observe() returns while the row is still being read: a broadcast never waits on it.
    await t.obs.observe(execApprovalRequestedFrame(child));
    expect(t.upserts).toEqual([]);
    open();
    await t.flush();
    expect(t.rpcs.filter(([m]) => m === "sessions.describe")).toEqual([["sessions.describe", { key: CHILD }]]);
    expect(t.upserts.map((u) => [u.providerRequestId, u.sessionKey])).toEqual([[child.approvalId, CHILD]]);
  });

  it("another conversation's sub-agent is never recorded, nor read", async () => {
    const t = setup({ rows: { [STRANGER]: { spawnedBy: OTHER_PARENT } } });
    await t.obs.observe(execApprovalRequestedFrame(stranger));
    await t.flush();
    expect(t.upserts).toEqual([]);
    expect(t.rpcs.some(([m]) => m === "approval.get")).toBe(false);
    expect(t.obs.routedApproval(stranger.approvalId)).toBe(false);
    expect(await t.obs.answersFor(STRANGER)).toBe(false);
  });

  it("the child's resolution settles the card and releases nothing of the parent's turn", async () => {
    const t = setup({ knownChildren: { [CHILD]: "msg-spawn" } });
    await t.obs.observe(execApprovalRequestedFrame(child));
    await t.flush();
    await t.obs.observe(execApprovalResolvedFrame(child));
    await t.flush();
    expect(t.settles).toEqual([
      expect.objectContaining({ providerRequestId: child.approvalId, family: "approval", status: "allowed", decision: "allow-once" }),
    ]);
    // Released by id — a no-op on a turn that never held it (Normalizer.noteApprovalSettled).
    expect(t.released).toEqual([child.approvalId]);
  });

  it("this conversation's OWN request holds its turn until the request's own deadline", async () => {
    const t = setup();
    await t.obs.observe(execApprovalRequestedFrame(own));
    await t.flush();
    expect(t.requested).toEqual([
      [
        own.approvalId,
        { kind: "exec", runId: own.runId, toolCallId: own.toolCallId, expiresInSec: expect.closeTo(1800, 0), hold: true },
      ],
    ]);
  });
});

describe("N2 — the pending approvals are listed at every (re)connection", () => {
  it("records this conversation's and its sub-agents' — never another's", async () => {
    const t = setup({
      knownChildren: { [CHILD]: null },
      rows: { [STRANGER]: { spawnedBy: OTHER_PARENT } },
      pending: { exec: [own, child, stranger] },
    });
    await t.obs.replayPending();
    await t.flush();
    // The three lists the Control UI reads, with the body it sends.
    for (const m of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"]) {
      expect(t.rpcs).toContainEqual([m, {}]);
    }
    expect(t.upserts.map((u) => [u.providerRequestId, u.sessionKey]).sort()).toEqual(
      [
        [own.approvalId, PARENT],
        [child.approvalId, CHILD],
      ].sort(),
    );
    // Its own one holds the turn it names (the reconnection case: the run's
    // `waiting-approval` went to the socket that closed).
    expect(t.requested.map(([id, f]) => [id, f.hold])).toEqual([[own.approvalId, true]]);
  });

  it("is idempotent: a second read of the lists writes nothing new", async () => {
    const t = setup({ pending: { exec: [own] } });
    await t.obs.replayPending();
    await t.flush();
    await t.obs.replayPending();
    await t.flush();
    expect(t.upserts).toHaveLength(1);
  });

  it("an approval decided since the list was read is not raised again", async () => {
    const t = setup({ pending: { exec: [own] }, settled: new Set([own.approvalId]) });
    await t.obs.replayPending();
    await t.flush();
    expect(t.upserts).toEqual([]);
  });

  it("a refused list is skipped and SAID — method and reason only — the others still read", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({
      pending: { exec: [own] },
      refuse: { "plugin.approval.list": "missing scope: operator.approvals (do not echo: secret-prompt)" },
    });
    await t.obs.replayPending();
    await t.flush();
    expect(t.upserts.map((u) => u.providerRequestId)).toEqual([own.approvalId]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(
      "[agent-request] approval replay skipped method=plugin.approval.list chat=c1 reason=scope_missing",
    );
    expect(lines.join("\n")).not.toContain("secret-prompt");
  });

  it("a plugin and a system-agent entry take their own families", async () => {
    const t = setup({
      pending: {
        plugin: [{ approvalKind: "plugin", id: "plug-1", request: { sessionKey: PARENT, agentId: "alice", title: "T" }, createdAtMs: NOW, expiresAtMs: NOW + 120_000 }],
        openclaw: [{ id: "sys-1", request: { sessionKey: PARENT }, createdAtMs: NOW, expiresAtMs: NOW + 60_000 }],
      },
    });
    await t.obs.replayPending();
    await t.flush();
    // Both are read by approval.get (the card shows the reviewer-safe presentation), with
    // the kind each list stands for.
    const gets = t.rpcs.filter(([m]) => m === "approval.get").map(([, p]) => (p as { id: string }).id);
    expect(gets.sort()).toEqual(["plug-1", "sys-1"]);
  });
});
