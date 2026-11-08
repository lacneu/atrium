// THIS CONVERSATION'S OWN APPROVALS — lot « trames 1 » (0.103.5).
//
// N2. A broadcast is sent once, `dropIfSlow` (server-methods/approval-shared.ts:340-368 at
// v2026.9.36). The Control UI lists the pending approvals at every connection —
// `exec.approval.list`, `plugin.approval.list`, `openclaw.approval.list`
// (ui/src/app/exec-approval.ts:419-473) — and so does the observer, keeping its own
// session's. Each entry has the broadcast's own shape (approval-record-lookup.ts:121-155).
//
// A SUB-AGENT's approval is NOT shown in the parent conversation — deliberately, until
// N1-v2. Upstream addresses it to the child's whole lineage, the parent included
// (src/gateway/approval-session-audience.ts:52-107), computed once when it registers it and
// served on the session-scoped stream (`session.approval`) that a conversation socket does
// not subscribe to; the broadcast names the raising session alone. Rebuilding that audience
// from the broadcasts was tried and withdrawn: every rule left a cross-conversation case.
//
// A TERMINAL snapshot settles the card: an approval decided while its one resolution
// broadcast never reached this socket is settled from `approval.get`, with the gateway's own
// status and decision, exactly once.
//
// The frames and RPC answers are the captured 2026.9.36 shapes
// (helpers/approval-frames-2026.9.36.ts); terminal snapshots are that pending snapshot closed
// the way upstream closes it (operator-approval-snapshot.ts:23-37, server-methods/
// approval.ts:56-80), checked against the vendored schema.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";

import { OpenClawAgentRequestObserver } from "../src/providers/openclaw/agent-request-observer.js";
import type { AgentRequestRecord, AgentRequestSettle } from "../src/core/agent-requests.js";
import { TerminalApprovalSnapshotSchema } from "../protocol/openclaw/2026.9.36/approvals.js";
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
const NOW = 1_793_658_291_800;

const own: ApprovalIds = {
  sessionKey: PARENT,
  runId: "webchat-run-1",
  approvalId: "a0000000-0000-4000-8000-000000000001",
  toolCallId: "tool_call:call_1:exec:1",
};
/** Raised by a sub-agent this conversation spawned. */
const child: ApprovalIds = {
  sessionKey: CHILD,
  runId: "child-run-1",
  approvalId: "a0000000-0000-4000-8000-000000000002",
  toolCallId: "tool_call:call_2:exec:1",
  agentId: "files",
};
/** Another conversation's own. */
const other: ApprovalIds = {
  sessionKey: OTHER_PARENT,
  runId: "other-run",
  approvalId: "a0000000-0000-4000-8000-000000000003",
  toolCallId: "tool_call:call_3:exec:1",
};
/** The generation of `own` (the captured creation time). */
const CREATED = execApprovalRequestedPayload(own).createdAtMs as number;

type Terminal =
  | { status: "allowed"; decision: "allow-once" | "allow-always" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "cancelled" };

/** `approval.get` for a DECIDED approval: the captured pending snapshot, closed as upstream
 *  closes it — resolution time, closed reason, the decision of an allow or a deny, and the
 *  reviewer-safe source attribution RPC readers get. */
function terminalApprovalGet(ids: ApprovalIds, end: Terminal): Record<string, unknown> {
  const pending = pendingApprovalGet(ids).approval as Record<string, unknown>;
  const reason = { allowed: "user", denied: "user", expired: "timeout", cancelled: "run-aborted" }[end.status];
  return {
    approval: {
      ...pending,
      status: end.status,
      resolvedAtMs: 1_793_658_297_797,
      reason,
      ...(end.status === "allowed"
        ? { decision: end.decision }
        : end.status === "denied"
          ? { decision: "deny" }
          : {}),
      source: { agentId: ids.agentId ?? "alice", sessionKey: ids.sessionKey },
    },
  };
}

interface Setup {
  pending?: { exec?: ApprovalIds[]; plugin?: unknown[]; openclaw?: unknown[] };
  /** Methods the gateway refuses, with the message it refuses with. */
  refuse?: Record<string, string>;
  /** What `approval.get` answers for an id, when not its pending snapshot. */
  snapshots?: Record<string, Record<string, unknown> | null>;
}

function setup(opts: Setup = {}) {
  const upserts: AgentRequestRecord[] = [];
  const settles: AgentRequestSettle[] = [];
  const requested: Array<[string, Record<string, unknown>]> = [];
  const released: string[] = [];
  const rpcs: Array<[string, unknown]> = [];
  let approvalGate: Promise<void> = Promise.resolve();
  const all = [own, child, other];
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
          await approvalGate;
          const id = (params as { id: string }).id;
          const ids = all.find((x) => x.approvalId === id);
          payload =
            opts.snapshots !== undefined && id in opts.snapshots
              ? opts.snapshots[id]
              : ids === undefined
                ? null
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
    wake: () => {},
    nowMs: () => NOW,
  });
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    obs,
    upserts,
    settles,
    requested,
    released,
    rpcs,
    flush,
    /** Hold every `approval.get` answer until opened. */
    holdApprovalGet: () => {
      let open: () => void = () => {};
      approvalGate = new Promise<void>((r) => (open = r));
      return () => open();
    },
    /** What `approval.get` answers for `id` from now on. */
    answerApprovalGet: (id: string, got: Record<string, unknown> | null) => {
      opts.snapshots = { ...(opts.snapshots ?? {}), [id]: got };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("N2 — this conversation's pending approvals are listed at every (re)connection", () => {
  it("records its own session's — never a sub-agent's, nor another conversation's", async () => {
    const t = setup({ pending: { exec: [own, child, other] } });
    await t.obs.replayPending();
    await t.flush();
    // The three lists the Control UI reads, with the body it sends.
    for (const m of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"]) {
      expect(t.rpcs).toContainEqual([m, {}]);
    }
    expect(t.upserts.map((u) => [u.providerRequestId, u.sessionKey])).toEqual([[own.approvalId, PARENT]]);
    // Only its own request is even read.
    expect(t.rpcs.filter(([m]) => m === "approval.get").map(([, p]) => (p as { id: string }).id)).toEqual([own.approvalId]);
    // It holds the turn it names (the reconnection case: the run's `waiting-approval` went
    // to the socket that closed).
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

describe("a sub-agent's approval is NOT shown in the parent conversation — deliberately, until N1-v2", () => {
  // See the header: the audience upstream computes for it is served on `session.approval`,
  // which this socket does not consume, and is not rebuilt from the broadcasts.
  it("not from its broadcast: nothing is read, recorded, routed or held", async () => {
    const t = setup();
    await t.obs.observe(execApprovalRequestedFrame(child));
    await t.flush();
    expect(t.rpcs, "not even its lineage or its snapshot is asked").toEqual([]);
    expect(t.upserts).toEqual([]);
    expect(t.requested).toEqual([]);
    expect(t.obs.routedApproval(child.approvalId)).toBe(false);
  });

  it("not from the pending lists either", async () => {
    const t = setup({ pending: { exec: [child] } });
    await t.obs.replayPending();
    await t.flush();
    expect(t.rpcs.filter(([m]) => m === "approval.get" || m === "sessions.describe")).toEqual([]);
    expect(t.upserts).toEqual([]);
    expect(t.obs.routedApproval(child.approvalId)).toBe(false);
  });

  it("and its resolution settles nothing here", async () => {
    const t = setup();
    await t.obs.observe(execApprovalResolvedFrame(child));
    await t.flush();
    expect(t.settles).toEqual([]);
    expect(t.released).toEqual([]);
  });
});

describe("a TERMINAL snapshot settles this conversation's card, once", () => {
  it("the terminal snapshots below are the gateway's own shape", () => {
    for (const end of [
      { status: "allowed", decision: "allow-always" },
      { status: "denied" },
      { status: "expired" },
      { status: "cancelled" },
    ] as Terminal[]) {
      const got = terminalApprovalGet(own, end);
      expect(Value.Check(TerminalApprovalSnapshotSchema, got.approval), end.status).toBe(true);
    }
  });

  it.each<[string, Terminal, Pick<AgentRequestSettle, "status" | "decision">]>([
    ["allowed", { status: "allowed", decision: "allow-always" }, { status: "allowed", decision: "allow-always" }],
    ["denied", { status: "denied" }, { status: "denied", decision: "deny" }],
    // An exec broadcast says `deny` for an expiry and a cancel too (`record.decision ??
    // "deny"`, server-methods/approval-publication.ts:71-83): the snapshot says which.
    ["expired", { status: "expired" }, { status: "expired" }],
    ["cancelled", { status: "cancelled" }, { status: "cancelled" }],
  ])(
    "listed after a reconnection, %s before its snapshot was read, its resolution never seen: settled once, as the gateway recorded it",
    async (_label, end, settled) => {
      // The NEW socket's observer: empty. The card is the one the closed socket recorded.
      const t = setup({ pending: { exec: [own] }, snapshots: { [own.approvalId]: terminalApprovalGet(own, end) } });
      await t.obs.replayPending();
      await t.flush();
      expect(t.upserts, "nothing is asked any more").toEqual([]);
      expect(t.settles).toEqual([
        { chatId: "c1", providerRequestId: own.approvalId, family: "approval", providerCreatedAt: CREATED, ...settled },
      ]);
      // Its sighting held the turn; the snapshot released it.
      expect(t.requested.map(([id]) => id)).toEqual([own.approvalId]);
      expect(t.released).toEqual([own.approvalId]);
    },
  );

  it("a snapshot that is not terminal settles nothing — still pending yet unshowable, unknown, or none", async () => {
    for (const got of [
      { approval: { id: own.approvalId, status: "pending", createdAtMs: CREATED } },
      { approval: { id: own.approvalId, status: "resolved", createdAtMs: CREATED } },
      null,
    ]) {
      const t = setup({ pending: { exec: [own] }, snapshots: { [own.approvalId]: got } });
      await t.obs.replayPending();
      await t.flush();
      expect([t.upserts, t.settles, t.released], JSON.stringify(got)).toEqual([[], [], []]);
    }
  });

  it("a resolution that arrives while the snapshot is read is settled once — by the snapshot", async () => {
    const t = setup();
    const open = t.holdApprovalGet();
    await t.obs.observe(execApprovalRequestedFrame(own));
    // Decided while `approval.get` is on the wire: routed here, so its broadcast is taken…
    t.answerApprovalGet(own.approvalId, terminalApprovalGet(own, { status: "denied" }));
    await t.obs.observe(execApprovalResolvedFrame(own, "deny"));
    // …and the snapshot that answers is terminal too.
    open();
    await t.flush();
    expect(t.upserts).toEqual([]);
    expect(t.settles).toEqual([
      { chatId: "c1", providerRequestId: own.approvalId, family: "approval", providerCreatedAt: CREATED, status: "denied", decision: "deny" },
    ]);
    expect(t.released).toContain(own.approvalId);
  });
});
