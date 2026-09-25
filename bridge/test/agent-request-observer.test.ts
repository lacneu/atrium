// The OpenClaw agent-request observer on ONE conversation's socket.
//
// Questions and approvals are BROADCASTS: an operator socket receives them for every
// session on the gateway. The observer's first duty is therefore isolation — nothing
// is recorded for this chat unless it names this chat's session — and its second is to
// tell the turn that a human now holds it.
import { describe, expect, it, vi } from "vitest";
import { OpenClawAgentRequestObserver } from "../src/providers/openclaw/agent-request-observer.js";
import { questionShape, type AgentRequestRecord, type AgentRequestSettle } from "../src/core/agent-requests.js";

const OURS = "agent:denis:atrium:chat:denis:c1";
const THEIRS = "agent:denis:atrium:chat:bob:c2";
const NOW = 1_790_110_000_000;

function setup(approvalGet: (id: string) => unknown = () => null) {
  const upserts: AgentRequestRecord[] = [];
  const settles: AgentRequestSettle[] = [];
  const held: Array<[string, number | null]> = [];
  const released: string[] = [];
  const approvalsReleased: string[] = [];
  const rpcs: Array<[string, unknown]> = [];
  let wakes = 0;
  const obs = new OpenClawAgentRequestObserver({
    chatId: "c1",
    sessionKey: OURS,
    agentId: "denis",
    gateway: {
      request: async (method: string, params: Record<string, unknown>) => {
        rpcs.push([method, params]);
        const payload =
          method === "approval.get"
            ? approvalGet((params as { id: string }).id)
            : method === "question.list"
              ? { questions: [] }
              : null;
        return { type: "res", ok: true, payload };
      },
    },
    upsert: async (r) => {
      upserts.push(r);
    },
    settle: async (s) => {
      settles.push(s);
    },
    currentMessageId: () => "msg-7",
    noteQuestion: async (id, exp) => {
      held.push([id, exp]);
      return true;
    },
    noteQuestionSettled: async (id) => {
      released.push(id);
    },
    noteApprovalSettled: async (id) => {
      approvalsReleased.push(id);
    },
    wake: () => {
      wakes += 1;
    },
    nowMs: () => NOW,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { obs, upserts, settles, held, released, approvalsReleased, rpcs, flush, wakes: () => wakes };
}

const question = (sessionKey: string, id = "ask_1") => ({
  type: "event",
  event: "question.requested",
  payload: {
    id,
    questions: [{ questionId: "format", header: "Format", question: "Quel format ?", options: [] }],
    sessionKey,
    runId: "webchat-1",
    createdAtMs: NOW,
    expiresAtMs: NOW + 900_000,
    status: "pending",
  },
});

describe("isolation", () => {
  it("another conversation's question is never recorded here", async () => {
    const t = setup();
    await t.obs.observe(question(THEIRS));
    await t.flush();
    expect(t.upserts).toEqual([]);
    expect(t.held).toEqual([]);
  });

  it("…nor its resolution, which names no session at all", async () => {
    const t = setup();
    await t.obs.observe(question(THEIRS, "ask_theirs"));
    await t.obs.observe({ type: "event", event: "question.resolved", payload: { id: "ask_theirs", status: "answered", answers: { answers: {} } } });
    await t.flush();
    expect(t.settles).toEqual([]);
    expect(t.released).toEqual([]);
  });

  it("another conversation's approval is never read, let alone recorded", async () => {
    const t = setup(() => ({ approval: { status: "pending", presentation: { kind: "exec", commandText: "ls", allowedDecisions: ["deny"] } } }));
    await t.obs.observe({ type: "event", event: "exec.approval.requested", payload: { id: "ap-x", request: { sessionKey: THEIRS }, expiresAtMs: NOW + 1 } });
    await t.flush();
    expect(t.rpcs).toEqual([]);
    expect(t.upserts).toEqual([]);
  });
});

describe("our questions", () => {
  it("are recorded once, anchored to the live turn, and HOLD it until their deadline", async () => {
    const t = setup();
    await t.obs.observe(question(OURS));
    await t.obs.observe(question(OURS)); // a replay
    await t.flush();
    expect(t.upserts).toHaveLength(1);
    expect(t.upserts[0]).toMatchObject({
      chatId: "c1",
      messageId: "msg-7",
      source: "openclaw.ask_user",
      providerRequestId: "ask_1",
      sessionKey: OURS,
      runId: "webchat-1",
      expiresAt: NOW + 900_000,
    });
    // The deadline reaches the turn as TIME LEFT (its clock is not an epoch).
    expect(t.held[0]).toEqual(["ask_1", 900]);
    expect(t.wakes()).toBeGreaterThan(0);
  });

  it("their resolution releases the turn and settles the card", async () => {
    const t = setup();
    await t.obs.observe(question(OURS));
    await t.obs.observe({ type: "event", event: "question.resolved", payload: { id: "ask_1", status: "answered", answers: { answers: { format: ["PDF"] } } } });
    await t.flush();
    expect(t.released).toEqual(["ask_1"]);
    expect(t.settles).toEqual([
      {
        chatId: "c1",
        providerRequestId: "ask_1",
        family: "question",
        providerCreatedAt: NOW,
        // WHICH question settled: a generation sharing its creation time is another one.
        questionShape: questionShape([
          { id: "format", header: "Format", text: "Quel format ?", secret: false, multiSelect: false, options: [] },
        ]),
        // …and WHEN it was seen: generations alike in both are told apart by it.
        providerSeenSeq: t.upserts[0]!.providerSeenSeq,
        status: "answered",
        answers: [{ id: "format", values: ["PDF"] }],
      },
    ]);
  });

  it("the same id asked again after its resolution is a NEW question (the gateway forgets settled ones)", async () => {
    const t = setup();
    await t.obs.observe(question(OURS, "x"));
    await t.obs.observe({ type: "event", event: "question.resolved", payload: { id: "x", status: "answered", answers: { answers: {} } } });
    await t.obs.observe({ ...question(OURS, "x"), payload: { ...question(OURS, "x").payload, createdAtMs: NOW + 20_000 } });
    await t.flush();
    expect(t.upserts.map((u) => [u.providerRequestId, u.providerCreatedAt])).toEqual([
      ["x", NOW],
      ["x", NOW + 20_000],
    ]);
    // Each settle names the generation it settles.
    await t.obs.observe({ type: "event", event: "question.resolved", payload: { id: "x", status: "cancelled" } });
    await t.flush();
    await t.flush();
    expect(t.settles.map((x) => x.providerCreatedAt)).toEqual([NOW, NOW + 20_000]);
  });

  it("an id reused after a MISSED resolution is a new question, with its own secrets", async () => {
    const t = setup();
    await t.obs.observe(question(OURS, "x")); // ordinary, generation NOW — its `resolved` is lost
    await t.obs.observe({
      type: "event",
      event: "question.requested",
      payload: {
        ...question(OURS, "x").payload,
        createdAtMs: NOW + 30_000,
        questions: [{ questionId: "token", header: "T", question: "Jeton ?", options: [], isSecret: true }],
      },
    });
    await t.obs.observe({ type: "event", event: "question.resolved", payload: { id: "x", status: "answered", answers: { answers: { token: ["TOP-SECRET"] } } } });
    await t.flush();
    await t.flush();
    expect(t.upserts.map((u) => u.providerCreatedAt)).toEqual([NOW, NOW + 30_000]);
    expect(JSON.stringify(t.settles)).not.toContain("TOP-SECRET");
    expect(t.settles[0]!.providerCreatedAt).toBe(NOW + 30_000);
  });

  it("a SECRET answer never leaves the bridge, not even toward Convex", async () => {
    const t = setup();
    await t.obs.observe({
      type: "event",
      event: "question.requested",
      payload: {
        ...question(OURS, "ask_s").payload,
        questions: [
          { questionId: "couleur", header: "C", question: "Couleur ?", options: [] },
          { questionId: "token", header: "T", question: "Jeton ?", options: [], isSecret: true },
        ],
      },
    });
    await t.obs.observe({ type: "event", event: "question.resolved", payload: { id: "ask_s", status: "answered", answers: { answers: { couleur: ["BLEU"], token: ["TOP-SECRET"] } } } });
    await t.flush();
    await t.flush();
    expect(JSON.stringify(t.settles)).not.toContain("TOP-SECRET");
    expect(t.settles[0]!.answers).toEqual([
      { id: "couleur", values: ["BLEU"] },
      { id: "token", values: [] },
    ]);
  });

  it("a session key differing only in case is the same session on the gateway's side", async () => {
    const t = setup();
    await t.obs.observe(question(OURS.toUpperCase()));
    await t.flush();
    expect(t.upserts).toHaveLength(1);
  });
});

describe("our approvals", () => {
  it("are shown through the gateway's reviewer-safe presentation", async () => {
    const t = setup((id) => ({
      approval: {
        id,
        status: "pending",
        expiresAtMs: NOW + 60_000,
        // What the gateway presents is already redacted; the raw broadcast command is not.
        presentation: { kind: "exec", commandText: "npm publish --token=*** && rm -rf dist", commandPreview: "npm publish", allowedDecisions: ["allow-once", "deny"] },
      },
    }));
    await t.obs.observe({
      type: "event",
      event: "exec.approval.requested",
      payload: { id: "ap-1", request: { sessionKey: OURS, agentId: "denis", command: "npm publish --token=abc" }, expiresAtMs: NOW + 60_000 },
    });
    await t.flush();
    await t.flush();
    expect(t.rpcs).toEqual([["approval.get", { id: "ap-1" }]]);
    expect(t.upserts).toEqual([
      expect.objectContaining({
        source: "openclaw.exec",
        approvalKind: "exec",
        providerRequestId: "ap-1",
        messageId: "msg-7",
        expiresAt: NOW + 60_000,
        approval: { command: "npm publish --token=*** && rm -rf dist", decisions: ["allow-once", "deny"] },
      }),
    ]);
    expect(JSON.stringify(t.upserts)).not.toContain("token=abc");
  });

  it("knows which approvals it routed HERE — the answer path's proof for an agent-less one", async () => {
    const t = setup(() => ({ approval: { status: "pending", createdAtMs: NOW, presentation: { kind: "exec", commandText: "ls", allowedDecisions: ["deny"] } } }));
    await t.obs.observe({ type: "event", event: "exec.approval.requested", payload: { id: "ap-ours", request: { sessionKey: OURS }, expiresAtMs: NOW + 1 } });
    await t.obs.observe({ type: "event", event: "exec.approval.requested", payload: { id: "ap-theirs", request: { sessionKey: THEIRS }, expiresAtMs: NOW + 1 } });
    await t.flush();
    expect(t.obs.routedApproval("ap-ours")).toBe(true);
    expect(t.obs.routedApproval("ap-theirs")).toBe(false);
  });

  it("their resolution releases the turn by approval id and settles the card", async () => {
    const t = setup(() => ({ approval: { status: "denied" } }));
    await t.obs.observe({ type: "event", event: "plugin.approval.resolved", payload: { id: "ap-2", decision: "deny", resolvedBy: "cli", request: { sessionKey: OURS } } });
    await t.flush();
    await t.flush();
    expect(t.approvalsReleased).toEqual(["ap-2"]);
    expect(t.settles).toEqual([{ chatId: "c1", providerRequestId: "ap-2", family: "approval", status: "denied", decision: "deny" }]);
  });

  it("an allow carries the decision the gateway recorded (another reviewer's may differ from ours)", async () => {
    const t = setup(() => null);
    await t.obs.observe({ type: "event", event: "exec.approval.resolved", payload: { id: "ap-5", decision: "allow-always", resolvedBy: "control-ui", request: { sessionKey: OURS } } });
    await t.flush();
    await t.flush();
    expect(t.settles).toEqual([{ chatId: "c1", providerRequestId: "ap-5", family: "approval", status: "allowed", decision: "allow-always" }]);
  });

  it("an approval that RAN OUT is recorded expired, not refused — the broadcast says `deny` for both", async () => {
    // The terminal snapshot tells them apart…
    const bySnapshot = setup(() => ({ approval: { status: "expired" } }));
    await bySnapshot.obs.observe({ type: "event", event: "exec.approval.resolved", payload: { id: "ap-3", decision: "deny", resolvedBy: null, request: { sessionKey: OURS } } });
    await bySnapshot.flush();
    await bySnapshot.flush();
    expect(bySnapshot.settles).toEqual([{ chatId: "c1", providerRequestId: "ap-3", family: "approval", status: "expired" }]);
    // …and without it, a timeout is the resolution that has NO resolver.
    const byResolver = setup(() => null);
    await byResolver.obs.observe({ type: "event", event: "exec.approval.resolved", payload: { id: "ap-4", decision: "deny", request: { sessionKey: OURS } } });
    await byResolver.flush();
    await byResolver.flush();
    expect(byResolver.settles).toEqual([{ chatId: "c1", providerRequestId: "ap-4", family: "approval", status: "expired" }]);
  });
});

describe("a failed read is not a lost card", () => {
  it("approval.get failing once is retried — the broadcast will not come again", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const upserts: AgentRequestRecord[] = [];
      const obs = new OpenClawAgentRequestObserver({
        chatId: "c1",
        sessionKey: OURS,
        agentId: "denis",
        gateway: {
          request: async () => {
            reads += 1;
            if (reads === 1) throw new Error("GATEWAY_TIMEOUT");
            return {
              type: "res",
              ok: true,
              payload: { approval: { status: "pending", presentation: { kind: "exec", commandText: "ls", allowedDecisions: ["allow-once", "deny"] } } },
            };
          },
        },
        upsert: async (r) => {
          upserts.push(r);
        },
        settle: async () => {},
        currentMessageId: () => null,
        noteQuestion: async () => false,
        noteQuestionSettled: async () => {},
        noteApprovalSettled: async () => {},
        wake: () => {},
        nowMs: () => NOW,
      });
      await obs.observe({ type: "event", event: "exec.approval.requested", payload: { id: "ap-1", request: { sessionKey: OURS }, expiresAtMs: NOW + 60_000 } });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reads).toBe(2);
      expect(upserts.map((u) => u.providerRequestId)).toEqual(["ap-1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a card that could not be recorded is not lost", () => {
  const observer = (upsert: (r: AgentRequestRecord) => Promise<void>, approval: unknown = null) =>
    new OpenClawAgentRequestObserver({
      chatId: "c1",
      sessionKey: OURS,
      agentId: "denis",
      gateway: { request: async () => ({ type: "res", ok: true, payload: approval }) },
      upsert,
      settle: async () => {},
      currentMessageId: () => null,
      noteQuestion: async () => false,
      noteQuestionSettled: async () => {},
      noteApprovalSettled: async () => {},
      wake: () => {},
      nowMs: () => NOW,
    });

  it("a question whose write failed is re-read LATER while the socket stays up (no second broadcast)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const lists: number[] = [];
      const obs = new OpenClawAgentRequestObserver({
        chatId: "c1",
        sessionKey: OURS,
        agentId: "denis",
        gateway: {
          request: async (method: string) => {
            if (method === "question.list") lists.push(1);
            return { type: "res", ok: true, payload: { questions: [question(OURS, "ask_r").payload] } };
          },
        },
        upsert: async () => {
          calls += 1;
          if (calls === 1) throw new Error("ingest 503");
        },
        settle: async () => {},
        currentMessageId: () => null,
        noteQuestion: async () => false,
        noteQuestionSettled: async () => {},
        noteApprovalSettled: async () => {},
        wake: () => {},
        nowMs: () => NOW,
      });
      await obs.observe(question(OURS, "ask_r"));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(lists).toHaveLength(1);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a question and an approval sharing an id are both recorded", async () => {
    const t = setup(() => ({ approval: { status: "pending", createdAtMs: NOW, presentation: { kind: "exec", commandText: "ls", allowedDecisions: ["deny"] } } }));
    await t.obs.observe(question(OURS, "shared"));
    await t.obs.observe({ type: "event", event: "exec.approval.requested", payload: { id: "shared", request: { sessionKey: OURS }, expiresAtMs: NOW + 1 } });
    await t.flush();
    await t.flush();
    expect(t.upserts.map((u) => u.source).sort()).toEqual(["openclaw.ask_user", "openclaw.exec"]);
  });

  it("a question whose write failed is recorded when it is seen again (the reconnect replay)", async () => {
    let calls = 0;
    const obs = observer(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ingest 503");
    });
    await obs.observe(question(OURS));
    await new Promise((r) => setTimeout(r, 0));
    await obs.observe(question(OURS));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  it("an approval whose write failed is tried once more — its broadcast will not come again", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const obs = observer(
        async () => {
          calls += 1;
          if (calls === 1) throw new Error("ingest 503");
        },
        { approval: { status: "pending", createdAtMs: NOW, presentation: { kind: "exec", commandText: "ls", allowedDecisions: ["deny"] } } },
      );
      await obs.observe({ type: "event", event: "exec.approval.requested", payload: { id: "ap-9", request: { sessionKey: OURS }, expiresAtMs: NOW + 60_000 } });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ordering", () => {
  it("a settle is posted only after the card it settles was created", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const obs = new OpenClawAgentRequestObserver({
      chatId: "c1",
      sessionKey: OURS,
      agentId: "denis",
      gateway: { request: async () => ({ type: "res", ok: true, payload: null }) },
      upsert: async () => {
        await gate;
        order.push("upsert");
      },
      settle: async () => {
        order.push("settle");
      },
      currentMessageId: () => null,
      noteQuestion: async () => false,
      noteQuestionSettled: async () => {},
      noteApprovalSettled: async () => {},
      wake: () => {},
      nowMs: () => NOW,
    });
    await obs.observe(question(OURS));
    await obs.observe({ type: "event", event: "question.resolved", payload: { id: "ask_1", status: "cancelled" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["upsert", "settle"]);
  });
});

describe("reconnect", () => {
  it("replays the questions still pending for THIS session", async () => {
    const upserts: AgentRequestRecord[] = [];
    const obs = new OpenClawAgentRequestObserver({
      chatId: "c1",
      sessionKey: OURS,
      agentId: "denis",
      gateway: {
        request: async () => ({
          type: "res",
          ok: true,
          payload: { questions: [question(OURS, "ask_a").payload, question(THEIRS, "ask_b").payload] },
        }),
      },
      upsert: async (r) => {
        upserts.push(r);
      },
      settle: async () => {},
      currentMessageId: () => null,
      noteQuestion: async () => false,
      noteQuestionSettled: async () => {},
      noteApprovalSettled: async () => {},
      wake: () => {},
      nowMs: () => NOW,
    });
    await obs.replayPending();
    await new Promise((r) => setTimeout(r, 0));
    expect(upserts.map((u) => u.providerRequestId)).toEqual(["ask_a"]);
  });
});

describe("an OLD generation's late write never touches the NEW one under the same id (codex, 0.21.5 pass 7)", () => {
  function gated(firstWrite: "resolves" | "rejects") {
    const settles: AgentRequestSettle[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const obs = new OpenClawAgentRequestObserver({
      chatId: "c1",
      sessionKey: OURS,
      agentId: "denis",
      gateway: { request: async () => ({ type: "res", ok: true, payload: { questions: [] } }) },
      upsert: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          if (firstWrite === "rejects") throw new Error("ingest down");
        }
      },
      settle: async (s) => {
        settles.push(s);
      },
      currentMessageId: () => "msg-7",
      noteQuestion: async () => true,
      noteQuestionSettled: async () => {},
      noteApprovalSettled: async () => {},
      wake: () => {},
      nowMs: () => NOW,
    });
    const secretQ = (createdAtMs: number) => ({
      type: "event",
      event: "question.requested",
      payload: {
        ...question(OURS, "x").payload,
        createdAtMs,
        questions: [{ questionId: "token", header: "T", question: "Jeton ?", options: [], isSecret: true }],
      },
    });
    const resolved = (secret: string) => ({
      type: "event",
      event: "question.resolved",
      payload: { id: "x", status: "answered", answers: { answers: { token: [secret] } } },
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { obs, settles, release, secretQ, resolved, flush };
  }

  it("the old one's settle cannot consume the new one's secret mask", async () => {
    const t = gated("resolves");
    await t.obs.observe(t.secretQ(NOW)); // its write hangs
    await t.obs.observe(t.resolved("SECRET-1")); // its settle waits for that write
    await t.obs.observe(t.secretQ(NOW + 30_000)); // the id comes back, a new question
    t.release();
    await t.flush();
    await t.flush();
    await t.obs.observe(t.resolved("SECRET-2"));
    await t.flush();
    await t.flush();
    expect(t.settles.map((s) => s.providerCreatedAt)).toEqual([NOW, NOW + 30_000]);
    expect(JSON.stringify(t.settles)).not.toContain("SECRET-");
  });

  it("the old one's failed write cannot forget the new one", async () => {
    const t = gated("rejects");
    await t.obs.observe(t.secretQ(NOW));
    await t.obs.observe(t.resolved("SECRET-1"));
    await t.obs.observe(t.secretQ(NOW + 30_000));
    t.release(); // the OLD write fails now
    await t.flush();
    await t.flush();
    await t.obs.observe(t.resolved("SECRET-2"));
    await t.flush();
    await t.flush();
    // The new generation is still known, so its resolution is still settled.
    expect(t.settles.map((s) => s.providerCreatedAt)).toContain(NOW + 30_000);
    expect(JSON.stringify(t.settles)).not.toContain("SECRET-");
  });
});

describe("each sighting is stamped in the bridge's own order (codex, 0.21.5 pass 8)", () => {
  it("a later sighting carries a greater providerSeenSeq, whatever the provider clock says", async () => {
    const t = setup();
    await t.obs.observe({ ...question(OURS, "x"), payload: { ...question(OURS, "x").payload, createdAtMs: NOW + 50_000 } });
    await t.obs.observe({ type: "event", event: "question.resolved", payload: { id: "x", status: "cancelled" } });
    await t.obs.observe({ ...question(OURS, "x"), payload: { ...question(OURS, "x").payload, createdAtMs: NOW } });
    await t.flush();
    const seqs = t.upserts.map((u) => u.providerSeenSeq);
    expect(seqs).toHaveLength(2);
    expect(Number(seqs[1])).toBeGreaterThan(Number(seqs[0]));
    // …and names the process that saw it: seqs compare within one process only.
    expect(new Set(t.upserts.map((u) => u.providerSeenEpoch)).size).toBe(1);
    expect(t.upserts[0]!.providerSeenEpoch).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("a write Convex REFUSED is a failed write (codex, 0.21.5 pass 12)", () => {
  it("a refused question is forgotten and re-read later, not taken as recorded", async () => {
    vi.useFakeTimers();
    try {
      const rpcs: string[] = [];
      let upserts = 0;
      const obs = new OpenClawAgentRequestObserver({
        chatId: "c1",
        sessionKey: OURS,
        agentId: "denis",
        gateway: {
          request: async (method: string) => {
            rpcs.push(method);
            return { type: "res", ok: true, payload: { questions: [] } };
          },
        },
        upsert: async () => {
          upserts += 1;
          return { recorded: false };
        },
        settle: async () => {},
        currentMessageId: () => "msg-7",
        noteQuestion: async () => true,
        noteQuestionSettled: async () => {},
        noteApprovalSettled: async () => {},
        wake: () => {},
        nowMs: () => NOW,
      });
      await obs.observe(question(OURS, "x"));
      await vi.advanceTimersByTimeAsync(0);
      expect(upserts).toBe(1);
      // Forgotten → the deferred replay re-reads what is still pending.
      await vi.advanceTimersByTimeAsync(16_000);
      expect(rpcs).toContain("question.list");
      // …and a later sighting of the same id is recorded afresh.
      await obs.observe(question(OURS, "x"));
      await vi.advanceTimersByTimeAsync(0);
      expect(upserts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a reused id asking ANOTHER question at the SAME creation time is new (codex, 0.21.5 pass 15)", () => {
  it("its secret is masked by ITS flags, not the old question's", async () => {
    const t = setup();
    // An ordinary `token` question, whose resolution is lost…
    await t.obs.observe({
      type: "event",
      event: "question.requested",
      payload: { ...question(OURS, "x").payload, questions: [{ questionId: "token", header: "T", question: "Jeton ?", options: [] }] },
    });
    // …then the same id, the same creation time, now a SECRET `token`.
    await t.obs.observe({
      type: "event",
      event: "question.requested",
      payload: {
        ...question(OURS, "x").payload,
        questions: [{ questionId: "token", header: "T", question: "Jeton ?", options: [], isSecret: true }],
      },
    });
    await t.obs.observe({ type: "event", event: "question.resolved", payload: { id: "x", status: "answered", answers: { answers: { token: ["TOP-SECRET"] } } } });
    await t.flush();
    await t.flush();
    expect(t.upserts).toHaveLength(2);
    expect(t.upserts[1]!.source).toBe("openclaw.secret");
    expect(JSON.stringify(t.settles)).not.toContain("TOP-SECRET");
  });
});
