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

/**
 * Convex's side of the cards, as convex/agentRequests.ts keeps it (upsertFromBridge,
 * settleFromBridge — pinned by convex/agentRequests.test.ts « a verdict that reaches Convex
 * before its card » and the ingest route's « says what a settle did »): one card per id and
 * generation; any creation of a generation already recorded is that card. A settle closes an
 * OPEN card (`settled`), does nothing to a closed one (`none`), and — no card yet — keeps the
 * FIRST verdict of an approval that names its generation (`kept`), for its whole window: the
 * card is then created in that verdict, never `pending`. Nothing else is kept (`none`).
 */
class FakeConvex {
  readonly cards = new Map<string, { status: string; decision?: string }>();
  readonly kept = new Map<string, { status: string; decision?: string }>();
  upsert(r: AgentRequestRecord): { recorded: boolean } {
    const key = `${r.providerRequestId}@${String(r.providerCreatedAt)}`;
    if (!this.cards.has(key)) this.cards.set(key, { ...(this.kept.get(key) ?? { status: "pending" }) });
    return { recorded: true };
  }
  settle(s: AgentRequestSettle): { outcome: "settled" | "kept" | "none" } {
    const ofId = [...this.cards.entries()].filter(([k]) => k.startsWith(`${s.providerRequestId}@`));
    // That generation's card, or — none named — the newest of the id.
    const card =
      s.providerCreatedAt !== undefined
        ? this.cards.get(`${s.providerRequestId}@${String(s.providerCreatedAt)}`)
        : ofId.at(-1)?.[1];
    if (card !== undefined) {
      if (card.status !== "pending") return { outcome: "none" };
      card.status = s.status;
      if (s.decision !== undefined) card.decision = s.decision;
      return { outcome: "settled" };
    }
    if (s.family !== "approval" || typeof s.providerCreatedAt !== "number") return { outcome: "none" };
    const key = `${s.providerRequestId}@${String(s.providerCreatedAt)}`;
    if (!this.kept.has(key)) {
      this.kept.set(key, { status: s.status, ...(s.decision !== undefined ? { decision: s.decision } : {}) });
    }
    return { outcome: "kept" };
  }
  /** The card of `id` (its only generation in these tests). */
  card(id: string): { status: string; decision?: string } | undefined {
    return [...this.cards.entries()].find(([k]) => k.startsWith(`${id}@`))?.[1];
  }
}

interface Setup {
  pending?: { exec?: ApprovalIds[]; plugin?: unknown[]; openclaw?: unknown[] };
  /** Methods the gateway refuses, with the message it refuses with. */
  refuse?: Record<string, string>;
  /** What `approval.get` answers for an id, when not its pending snapshot. */
  snapshots?: Record<string, Record<string, unknown> | null>;
  /** How many settle writes Convex refuses first (the writer's own retries spent). */
  failSettles?: number;
  /** Convex's cards, shared by the observers of one conversation. Without it, a settle
   *  finds the card an earlier socket recorded, open, and closes it. */
  convex?: FakeConvex;
  /** Holds the exec list's answer until it resolves. */
  listGate?: Promise<void>;
}

function setup(opts: Setup = {}) {
  const upserts: AgentRequestRecord[] = [];
  /** The settles that LANDED. */
  const settles: AgentRequestSettle[] = [];
  /** Every settle write tried, landed or not. */
  const settleAttempts: AgentRequestSettle[] = [];
  let failSettles = opts.failSettles ?? 0;
  const requested: Array<[string, Record<string, unknown>]> = [];
  const released: string[] = [];
  const rpcs: Array<[string, unknown]> = [];
  let approvalGate: Promise<void> = Promise.resolve();
  let upsertGate: Promise<void> = Promise.resolve();
  let socketClosed = false;
  const all = [own, child, other];
  const obs = new OpenClawAgentRequestObserver({
    chatId: "c1",
    sessionKey: PARENT,
    agentId: "alice",
    gateway: {
      request: async (method: string, params: Record<string, unknown>) => {
        rpcs.push([method, params]);
        if (socketClosed) throw new Error("gateway socket closed");
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
          await opts.listGate;
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
      await upsertGate;
      upserts.push(r);
      return opts.convex?.upsert(r);
    },
    settle: async (s) => {
      settleAttempts.push(s);
      if (failSettles > 0) {
        failSettles -= 1;
        throw new Error("ingest refused the settle");
      }
      settles.push(s);
      return opts.convex?.settle(s) ?? { outcome: "settled" };
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
    settleAttempts,
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
    /** Hold every card write until opened (it is on the wire). */
    holdUpserts: () => {
      let open: () => void = () => {};
      upsertGate = new Promise<void>((r) => (open = r));
      return () => open();
    },
    /** Every gateway call fails from now on, as on a socket that closed. */
    closeSocket: () => {
      socketClosed = true;
    },
    /** How many `approval.get` reads were sent. */
    approvalReads: () => rpcs.filter(([m]) => m === "approval.get").length,
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
        // …named by its identity: the id, and the generation its announcement gives.
        { kind: "exec", runId: own.runId, toolCallId: own.toolCallId, expiresInSec: expect.closeTo(1800, 0), hold: true, generation: CREATED },
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

  it("a snapshot's settle that FAILS is not taken as done: the resolution that follows retries it, and it lands once", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const t = setup({
        pending: { exec: [own] },
        snapshots: { [own.approvalId]: terminalApprovalGet(own, { status: "allowed", decision: "allow-once" }) },
        failSettles: 1,
      });
      await t.obs.replayPending();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.settleAttempts, "the snapshot's settle was tried…").toHaveLength(1);
      expect(t.settles, "…and refused").toEqual([]);
      // Its resolution broadcast: the settle is written again, and lands.
      await t.obs.observe(execApprovalResolvedFrame(own, "allow-once"));
      await vi.advanceTimersByTimeAsync(0);
      // Past the failed write's deferred retry: nothing is settled twice. The resolution
      // names the generation its list entry announced.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(t.settles).toEqual([
        { chatId: "c1", providerRequestId: own.approvalId, family: "approval", providerCreatedAt: CREATED, status: "allowed", decision: "allow-once" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("…and without a resolution, the verdict already read is written again on its own back-off — no new gateway read — once, a late resolution included", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const t = setup({
        pending: { exec: [own] },
        snapshots: { [own.approvalId]: terminalApprovalGet(own, { status: "allowed", decision: "allow-once" }) },
        failSettles: 1,
      });
      await t.obs.replayPending();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.settles).toEqual([]);
      const reads = t.approvalReads();
      // Its own back-off (2 s): the verdict the snapshot gave, not a new read of it.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.settles).toEqual([
        { chatId: "c1", providerRequestId: own.approvalId, family: "approval", providerCreatedAt: CREATED, status: "allowed", decision: "allow-once" },
      ]);
      // Past every later back-off: nothing more is written, nothing more is read.
      await vi.advanceTimersByTimeAsync(300_000);
      // A resolution broadcast arriving after that finds nothing left to settle.
      await t.obs.observe(execApprovalResolvedFrame(own, "allow-once"));
      await vi.advanceTimersByTimeAsync(0);
      expect(t.settles).toHaveLength(1);
      expect(t.settleAttempts).toHaveLength(2);
      expect(t.approvalReads()).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Convex refusing the snapshot's settle, then the socket closing: once Convex is back the verdict lands, once — without reading the gateway again", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const t = setup({
        pending: { exec: [own] },
        snapshots: { [own.approvalId]: terminalApprovalGet(own, { status: "allowed", decision: "allow-once" }) },
        failSettles: 2,
      });
      await t.obs.replayPending();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.settleAttempts, "the snapshot's settle, refused").toHaveLength(1);
      // The socket closes after that first failure: the gateway answers nothing any more.
      t.closeSocket();
      const reads = t.approvalReads();
      // Convex refuses once more (2 s), then takes it (10 s later).
      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.settles).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.settles).toEqual([
        { chatId: "c1", providerRequestId: own.approvalId, family: "approval", providerCreatedAt: CREATED, status: "allowed", decision: "allow-once" },
      ]);
      // Past every back-off: once, and never a gateway read.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(t.settleAttempts).toHaveLength(3);
      expect(t.settles).toHaveLength(1);
      expect(t.approvalReads()).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the memory of a held verdict only saves work", () => {
  it("a card write that failed is not retried once its verdict is held — no gateway read for it", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const refuse: Record<string, string> = { "approval.get": "request timed out" };
      const t = setup({ pending: { exec: [own] }, refuse });
      await t.obs.replayPending();
      // Every read fails (now, 1 s, 3 s): the card write's one retry waits 15 s.
      await vi.advanceTimersByTimeAsync(5_000);
      const reads = t.approvalReads();
      expect(reads).toBe(3);
      // Its resolution: Convex closes the card the closed socket recorded.
      await t.obs.observe(execApprovalResolvedFrame(own, "allow-once"));
      await vi.advanceTimersByTimeAsync(0);
      expect(t.settles).toHaveLength(1);
      delete refuse["approval.get"];
      await vi.advanceTimersByTimeAsync(20_000);
      expect(t.approvalReads(), "nothing left to write for it").toBe(reads);
      expect(t.settles).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the terminal state does not depend on the order of two sockets' writes", () => {
  it("the closed socket's card write lands AFTER the new socket settled it: the card ends in the gateway's terminal state", async () => {
    const convex = new FakeConvex();
    // The socket that closes: it saw the request, and its card write is still on the wire.
    const before = setup({ convex });
    const openWrite = before.holdUpserts();
    await before.obs.observe(execApprovalRequestedFrame(own));
    await before.flush();
    expect(convex.card(own.approvalId), "not recorded yet").toBeUndefined();
    // The new socket lists it, already decided: its snapshot's settle reaches Convex first…
    const after = setup({
      convex,
      pending: { exec: [own] },
      snapshots: { [own.approvalId]: terminalApprovalGet(own, { status: "allowed", decision: "allow-once" }) },
    });
    await after.obs.replayPending();
    await after.flush();
    expect(after.settles).toEqual([
      { chatId: "c1", providerRequestId: own.approvalId, family: "approval", providerCreatedAt: CREATED, status: "allowed", decision: "allow-once" },
    ]);
    // …and the old write, landing now, records the card in that verdict — never pending.
    openWrite();
    await before.flush();
    expect(before.upserts.map((u) => [u.providerRequestId, u.providerCreatedAt])).toEqual([[own.approvalId, CREATED]]);
    expect(convex.card(own.approvalId)).toEqual({ status: "allowed", decision: "allow-once" });
    // Its resolution reaching the new socket afterwards changes nothing.
    await after.obs.observe(execApprovalResolvedFrame(own, "allow-once"));
    await after.flush();
    expect(convex.card(own.approvalId)).toEqual({ status: "allowed", decision: "allow-once" });
  });

  it("its reads failing, the resolution that follows names the generation the announcement gave: kept and retried with it — the old socket's late card is born decided", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const convex = new FakeConvex();
      const before = setup({ convex });
      const openWrite = before.holdUpserts();
      await before.obs.observe(execApprovalRequestedFrame(own));
      await vi.advanceTimersByTimeAsync(0);
      // The new socket lists it; its `approval.get` fails, every attempt (now, 1 s, 3 s)…
      const refuse: Record<string, string> = { "approval.get": "request timed out" };
      const after = setup({ convex, pending: { exec: [own] }, refuse, failSettles: 1 });
      await after.obs.replayPending();
      await vi.advanceTimersByTimeAsync(5_000);
      // …and the resolution reaches it then: its settle, refused once, is written again on its
      // back-off — with the generation the list entry announced, each time.
      await after.obs.observe(execApprovalResolvedFrame(own, "allow-once"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(after.settleAttempts.map((x) => x.providerCreatedAt)).toEqual([CREATED, CREATED]);
      expect(convex.kept.size, "kept for the card still on the wire").toBe(1);
      // The old write lands: the card is born in the gateway's verdict.
      openWrite();
      await vi.advanceTimersByTimeAsync(0);
      expect(convex.card(own.approvalId)).toEqual({ status: "allowed", decision: "allow-once" });
      // The new socket's card retry (15 s) has nothing left to do: Convex holds the verdict.
      const reads = after.approvalReads();
      delete refuse["approval.get"];
      await vi.advanceTimersByTimeAsync(20_000);
      expect(after.approvalReads()).toBe(reads);
      expect(convex.card(own.approvalId)).toEqual({ status: "allowed", decision: "allow-once" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a resolution that comes while a list asked before it is on the wire: the list's entry gives it its generation — kept for the card the old socket is still writing", async () => {
    const convex = new FakeConvex();
    const before = setup({ convex });
    const openWrite = before.holdUpserts();
    await before.obs.observe(execApprovalRequestedFrame(own));
    await before.flush();
    // The new socket asks the lists; the gateway is slow to answer, and every read fails.
    let answerList: () => void = () => {};
    const listGate = new Promise<void>((r) => (answerList = r));
    const after = setup({ convex, pending: { exec: [own] }, refuse: { "approval.get": "request timed out" }, listGate });
    const replay = after.obs.replayPending();
    await after.flush();
    // The resolution comes first: nothing announced here yet, nothing Convex can keep.
    await after.obs.observe(execApprovalResolvedFrame(own, "allow-once"));
    await after.flush();
    expect(after.settles.map((x) => x.providerCreatedAt)).toEqual([undefined]);
    expect(convex.kept.size).toBe(0);
    // The list, read before the decision, names the request: that is its generation.
    answerList();
    await replay;
    await after.flush();
    expect(after.approvalReads(), "the decided request is not read again").toBe(0);
    expect(after.settles.map((x) => x.providerCreatedAt)).toEqual([undefined, CREATED]);
    openWrite();
    await before.flush();
    expect(convex.card(own.approvalId)).toEqual({ status: "allowed", decision: "allow-once" });
  });
});

describe("a reused id is another request on this socket too (approval-identity.ts)", () => {
  it("A decided and held, then B under the same id and a new generation: B's card is written, and its resolution settles B", async () => {
    const convex = new FakeConvex();
    const reused: ApprovalIds = { ...own, runId: "webchat-run-2", toolCallId: "tool_call:call_9:exec:1", createdAtMs: CREATED + 300_000 };
    const t = setup({ convex });
    await t.obs.observe(execApprovalRequestedFrame(own));
    await t.flush();
    await t.obs.observe(execApprovalResolvedFrame(own, "allow-once"));
    await t.flush();
    expect(convex.cards.get(`${own.approvalId}@${CREATED}`)).toEqual({ status: "allowed", decision: "allow-once" });
    // The gateway forgets A and gives its id to B: `approval.get` answers B now.
    t.answerApprovalGet(own.approvalId, pendingApprovalGet(reused));
    await t.obs.observe(execApprovalRequestedFrame(reused));
    await t.flush();
    expect(t.upserts.map((u) => u.providerCreatedAt)).toEqual([CREATED, CREATED + 300_000]);
    expect(convex.cards.get(`${own.approvalId}@${CREATED + 300_000}`)).toEqual({ status: "pending" });
    expect(t.requested.map(([, f]) => f.generation)).toEqual([CREATED, CREATED + 300_000]);
    // B's resolution names no generation: the one waiting, B's.
    await t.obs.observe(execApprovalResolvedFrame(reused, "deny"));
    await t.flush();
    expect(t.settles.at(-1)).toMatchObject({ providerCreatedAt: CREATED + 300_000 });
    expect(convex.cards.get(`${own.approvalId}@${CREATED + 300_000}`)?.status).toBe("denied");
    expect(convex.cards.get(`${own.approvalId}@${CREATED}`)).toEqual({ status: "allowed", decision: "allow-once" });
  });
});
