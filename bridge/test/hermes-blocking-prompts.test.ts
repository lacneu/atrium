/// <reference types="vitest" />
//
// Hermes' BLOCKING prompts — first lot 33 (G-38, G-39), now AGENT REQUESTS.
//
// Upstream `_block(event, sid, payload, timeout)` emits a request carrying a `request_id`
// and then STOPS THE TURN until a matching `*.respond` arrives or the timeout expires.
// Lot 33 stopped leaving the gateway blocked by answering on the person's behalf: an
// EMPTY clarification, a DENIED approval. That was the least bad thing a chat that could
// not ask the person could do. Atrium can ask now: every prompt a person can answer
// becomes an agent request — a card they answer (convex/agentRequests.ts) — and the
// bridge answers NOTHING in their place. What stays from lot 33 is the clock rule: a
// turn blocked on a prompt is not a silent turn, and outlives the gateway's own
// timeout rather than dying first.

import { describe, expect, it, vi } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter } from "../src/convex-writer.js";

type Call = [string, Record<string, unknown> | undefined];

type Raised = Record<string, unknown>;

function harness(
  calls: Call[],
  parts: unknown[],
  finals: unknown[],
  raised: Raised[] = [],
  settled: Raised[] = [],
  phases: string[] = [],
) {
  const client = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "session.create") {
        return { session_id: "cc4ebdee", stored_session_id: "20260706_212939_aee24e" };
      }
      if (method === "prompt.submit") return { status: "streaming" };
      return {};
    },
  } as unknown as HermesWsClient;
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async (_id: string, part: unknown) => {
      parts.push(part);
    },
    setPhase: (_id: string, phase: string) => {
      phases.push(phase);
    },
    finalize: async (_id: string, status: string, _t?: string, e?: string | null) => {
      finals.push({ status, error: e ?? undefined });
    },
    upsertAgentRequest: async (r: Raised) => {
      raised.push(r);
    },
    settleAgentRequest: async (r: Raised) => {
      settled.push(r);
    },
    reportSessionMeta: async () => {},
    heartbeat: async () => {},
    upsertSubAgent: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  return { client, writer };
}

async function turnWith(
  emit: (send: (t: string, p: Record<string, unknown>) => void) => void,
) {
  const calls: Call[] = [];
  const parts: unknown[] = [];
  const finals: unknown[] = [];
  const raised: Raised[] = [];
  const settled: Raised[] = [];
  const phases: string[] = [];
  const { client, writer } = harness(calls, parts, finals, raised, settled, phases);
  let lane!: (t: string, p: Record<string, unknown>) => void;
  const run = runHermesWsTurn(
    {
      client,
      writer,
      chatId: "c1",
      sessionKey: "k",
      providerChatId: null,
      text: "fais le travail",
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  emit(lane);
  // Close the turn normally so `done` resolves and the queued writes drain.
  lane("message.complete", { text: "fini", status: "complete" });
  await run.done;
  // The end-of-turn settle rides `done`; let its microtask run.
  await new Promise((r) => setTimeout(r, 0));
  return { calls, parts, finals, raised, settled, phases };
}

const methodsOf = (calls: Call[]) => calls.map(([m]) => m);

describe("a question is the PERSON'S to answer", () => {
  it("clarify.request becomes an agent request — and the bridge answers nothing", async () => {
    const { calls, raised, phases, parts } = await turnWith((send) =>
      send("clarify.request", {
        request_id: "abc123",
        question: "Quelle base de données ?",
        choices: ["postgres", "sqlite"],
      }),
    );
    // Not even empty: an empty answer is what SKIP sends, and only the person skips.
    expect(methodsOf(calls)).not.toContain("clarify.respond");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      chatId: "c1",
      source: "hermes.clarify",
      // Addressed by `request_id` — the ONLY address `clarify.respond` accepts.
      providerRequestId: "abc123",
      sessionKey: "cc4ebdee",
      questions: [
        {
          id: "answer",
          text: "Quelle base de données ?",
          options: [{ label: "postgres" }, { label: "sqlite" }],
          allowOther: true,
          multiSelect: false,
          secret: false,
        },
      ],
    });
    expect(raised[0]!.expiresAt).toBeTypeOf("number");
    expect(phases).toContain("awaiting_input");
    // The card replaces the old tool-card surfacing: shown once, not twice.
    expect(parts.some((p) => (p as { name?: string }).name === "hermes.clarify")).toBe(false);
  });

  it("terminal.read.request is answered too", async () => {
    const { calls } = await turnWith((send) =>
      send("terminal.read.request", { request_id: "t1", count: 40 }),
    );
    const answered = calls.find(([m]) => m === "terminal.read.respond");
    expect(answered?.[1]?.request_id).toBe("t1");
    expect(answered?.[1]?.text).toBe("");
  });

  it("a prompt with NO request_id is not answerable — and the turn OUTLASTS the block", async () => {
    // `request_id` is the only address a responder accepts. Unanswerable means the
    // gateway holds the turn for its full 300 s and THEN carries on (`_block` returns ""
    // and the agent proceeds) — so the turn must not be killed at our own 240 s deadline
    // and blamed on silence (raised in review). No terminal is injected here: injecting
    // one is what made the first version of this test green without exercising the block.
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      const finals: unknown[] = [];
      const { client, writer } = harness(calls, [], finals);
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        {
          client,
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "fais le travail",
        },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      lane("clarify.request", { question: "et maintenant ?" });
      expect(methodsOf(calls)).not.toContain("clarify.respond");
      // Past our own deadline, the turn is still alive: it is BLOCKED, not silent.
      await vi.advanceTimersByTimeAsync(250_000);
      expect(finals, "killed at 240 s, a minute before the gateway gives up").toEqual([]);
      // Past the gateway's OWN 300 s + margin, with not a single frame in between: the
      // grace expiring is not a verdict on the turn. Upstream has unblocked itself and
      // the agent carries on, and its first move may be silent thinking — so an ordinary
      // deadline starts fresh instead of the turn dying on the grace (raised in review).
      await vi.advanceTimersByTimeAsync(100_000); // 350 s total, grace well past
      expect(finals, "the grace expiring must not end the turn").toEqual([]);
      expect(methodsOf(calls)).not.toContain("session.interrupt");
      // …and the ordinary deadline really did restart, counted from the grace's end
      // (330 s) rather than from the prompt: still alive at 550 s, under the 570 s mark.
      await vi.advanceTimersByTimeAsync(200_000);
      expect(finals).toEqual([]);
      // The agent resumes and finishes.
      lane("message.complete", { text: "j'ai continué", status: "complete" });
      await run.done;
      expect(finals).toEqual([{ status: "complete", error: undefined }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("…and once the block is over, ordinary silence is ordinary again", async () => {
    // The other half: the restored deadline must still BITE. A grace that quietly became
    // permanent would trade a turn killed too early for one that never ends.
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      const finals: unknown[] = [];
      const { client, writer } = harness(calls, [], finals);
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        {
          client,
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "fais le travail",
        },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      lane("clarify.request", { question: "et maintenant ?" });
      await vi.advanceTimersByTimeAsync(331_000); // the block's budget, elapsed
      expect(finals).toEqual([]);
      await vi.advanceTimersByTimeAsync(241_000); // then a REAL silence
      await run.done;
      expect(finals).toHaveLength(1);
      expect(JSON.stringify(finals)).toMatch(/stopped sending/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("credentials: the person may type one, Atrium never invents one", () => {
  it("secret.request becomes a credential request — never answered by the bridge", async () => {
    const { calls, raised } = await turnWith((send) =>
      send("secret.request", {
        request_id: "s1",
        env_var: "STRIPE_API_KEY",
        prompt: "Clé API Stripe",
      }),
    );
    // Answering "" would be a refusal Atrium invented on the user's behalf, and it would
    // suppress the `secret.expire` the gateway emits when the prompt lapses.
    expect(methodsOf(calls)).not.toContain("secret.respond");
    expect(raised).toEqual([
      expect.objectContaining({
        source: "hermes.secret",
        providerRequestId: "s1",
        credential: { prompt: "Clé API Stripe", envVar: "STRIPE_API_KEY" },
      }),
    ]);
  });

  it("sudo.request likewise — a password asks for nothing to show but the ask", async () => {
    const { calls, raised } = await turnWith((send) =>
      send("sudo.request", { request_id: "u1" }),
    );
    expect(methodsOf(calls)).not.toContain("sudo.respond");
    expect(raised).toEqual([
      expect.objectContaining({ source: "hermes.sudo", providerRequestId: "u1", credential: {} }),
    ]);
  });

  it("the turn survives to RECEIVE the 300 s expiry, and the expiry settles the card", async () => {
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      const finals: unknown[] = [];
      const raised: Raised[] = [];
      const settled: Raised[] = [];
      const { client, writer } = harness(calls, [], finals, raised, settled);
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        {
          client,
          writer,
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "fais le travail",
        },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      lane("secret.request", { request_id: "s1", env_var: "STRIPE_API_KEY" });
      await vi.advanceTimersByTimeAsync(250_000); // past OUR deadline…
      expect(finals, "the turn is blocked, not silent").toEqual([]);
      expect(methodsOf(calls)).not.toContain("session.interrupt");
      await vi.advanceTimersByTimeAsync(55_000); // …up to the gateway's own 300 s
      lane("secret.expire", { request_id: "s1" });
      lane("message.complete", { text: "sans le secret", status: "complete" });
      await run.done;
      await vi.advanceTimersByTimeAsync(0);
      expect(settled, "the gateway's own fail-closed closes the card").toEqual([
        { chatId: "c1", providerRequestId: "s1", status: "expired" },
      ]);
      expect(finals).toEqual([{ status: "complete", error: undefined }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an approval is the person's decision (G-39)", () => {
  it("becomes an agent request addressed by SESSION — and nothing is denied on their behalf", async () => {
    const { calls, finals, raised, phases } = await turnWith((send) =>
      send("approval.request", {
        command: "rm -rf build",
        description: "recursive delete",
        choices: ["once", "session", "deny"],
      }),
    );
    expect(
      methodsOf(calls),
      "denying in the person's place is exactly what this lot removes",
    ).not.toContain("approval.respond");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      source: "hermes.approval",
      // Hermes answers approvals by SESSION (oldest first): the runtime session id is
      // the address, the provider id is ours.
      sessionKey: "cc4ebdee",
      approval: {
        command: "rm -rf build",
        description: "recursive delete",
        decisions: ["allow-once", "allow-session", "deny"],
      },
    });
    expect(String(raised[0]!.providerRequestId)).toMatch(/^hermes-approval:cc4ebdee:/);
    expect(phases).toContain("awaiting_approval");
    expect(finals).toEqual([{ status: "complete", error: undefined }]);
  });

  it("several approvals keep the order Hermes resolves them in", async () => {
    const { raised } = await turnWith((send) => {
      send("approval.request", { command: "one" });
      send("approval.request", { command: "two" });
    });
    expect(raised).toHaveLength(2);
    expect(Number(raised[1]!.seq)).toBeGreaterThan(Number(raised[0]!.seq));
    // No `choices`: the gateway's own default offers every scope.
    expect((raised[0]!.approval as { decisions: string[] }).decisions).toEqual([
      "allow-once",
      "allow-session",
      "allow-always",
      "deny",
    ]);
  });

  it("the turn is held while Hermes waits — however long the OPERATOR set it to wait", async () => {
    // `approvals.timeout` is Hermes configuration (60 s only by default) and rides no
    // payload. A fixed 60 s hold killed a turn Hermes was still legitimately holding
    // (codex P1: timeout=600 → the turn closed at 330 s). Now the agent's NEXT STEP ends
    // the hold, and then the card too — Hermes resolves by session FIFO, so an approval
    // card left open after Hermes moved on would decide the next one.
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      const finals: unknown[] = [];
      const raised: Raised[] = [];
      const settled: Raised[] = [];
      const { client, writer } = harness(calls, [], finals, raised, settled);
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        { client, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "fais le travail" },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      const t0 = Date.now();
      lane("tool.start", { name: "terminal", tool_id: "t1" });
      lane("approval.request", { command: "rm -rf build" });
      // No countdown of ours: the card lives until the agent moves (or the ceiling).
      expect(Number(raised[0]!.expiresAt) - t0).toBeGreaterThanOrEqual(29 * 60_000);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(finals, "Hermes still waits at 10 min; so does the turn").toEqual([]);
      expect(settled).toEqual([]);
      // Hermes gave up (or someone answered it elsewhere): the gated tool completes.
      lane("tool.complete", { name: "terminal", tool_id: "t1" });
      // The settle is chained after the card's own write (ordered, see below).
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toEqual([
        { chatId: "c1", providerRequestId: raised[0]!.providerRequestId, status: "cancelled" },
      ]);
      // …and ordinary silence is ordinary again.
      await vi.advanceTimersByTimeAsync(241_000);
      await run.done;
      expect(finals).toHaveLength(1);
      expect(JSON.stringify(finals)).toMatch(/stopped sending/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the turn knows the queue's HEAD — the only approval a decision may be sent for", async () => {
    const calls: Call[] = [];
    const raised: Raised[] = [];
    const settled: Raised[] = [];
    const { client, writer } = harness(calls, [], [], raised, settled);
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      { client, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "fais le travail" },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    expect(run.approvalHead()).toBeNull();
    lane("tool.start", { name: "execute_code", tool_id: "t1" });
    lane("approval.request", { command: "one" });
    lane("approval.request", { command: "two" });
    const [a, b] = raised.map((r) => String(r.providerRequestId));
    // TWO wait: our copy of Hermes' order could be wrong (another client may have taken
    // one off its queue, silently) — no decision can be sent from here.
    expect(run.approvalHead()).toBeNull();
    // Hermes took a decision for A: B is the only one left, and so the one answerable.
    run.noteApprovalAnswered(a!);
    expect(run.approvalHead()).toBe(b);
    // A decision's fate became unknown (the call failed): no head is named any more.
    run.noteApprovalOrderUnknown();
    expect(run.approvalHead()).toBeNull();
    // The tool returned: both are over, nothing is answerable any more.
    lane("tool.complete", { name: "execute_code", tool_id: "t1" });
    expect(run.approvalHead()).toBeNull();
    // …and the next approval starts from a KNOWN order again.
    lane("tool.start", { name: "terminal", tool_id: "t2" });
    lane("approval.request", { command: "three" });
    expect(run.approvalHead()).toBe(String(raised[2]!.providerRequestId));
    lane("message.complete", { text: "fini", status: "complete" });
    await run.done;
    await new Promise((r) => setTimeout(r, 0));
    // A and B at the resume; the third at the end of the turn.
    expect(settled.map((x) => x.providerRequestId).sort()).toEqual(
      [a, b, String(raised[2]!.providerRequestId)].sort(),
    );
  });

  it("a card's settle is never posted before its creation (an unordered settle finds no row)", async () => {
    const order: string[] = [];
    let releaseUpsert!: () => void;
    const upsertGate = new Promise<void>((r) => {
      releaseUpsert = r;
    });
    const calls: Call[] = [];
    const { client, writer } = harness(calls, [], []);
    (writer as unknown as { upsertAgentRequest: () => Promise<void> }).upsertAgentRequest = async () => {
      await upsertGate;
      order.push("upsert");
    };
    (writer as unknown as { settleAgentRequest: () => Promise<void> }).settleAgentRequest = async () => {
      order.push("settle");
    };
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      { client, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "fais le travail" },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    lane("tool.start", { name: "terminal", tool_id: "t1" });
    lane("approval.request", { command: "rm -rf build" });
    lane("tool.complete", { name: "terminal", tool_id: "t1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(order, "the settle waits for the row it settles").toEqual([]);
    releaseUpsert();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["upsert", "settle"]);
    lane("message.complete", { text: "fini", status: "complete" });
    await run.done;
  });

  it("while a person is asked, the bubble stays alive for the Convex watchdog", async () => {
    vi.useFakeTimers();
    try {
      const beats: string[] = [];
      const { client, writer } = harness([], [], []);
      (writer as unknown as { heartbeat: (id: string) => Promise<void> }).heartbeat = async (id: string) => {
        beats.push(id);
      };
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        { client, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "fais le travail" },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      lane("message.delta", { text: "je vérifie" });
      lane("tool.start", { name: "terminal", tool_id: "t1" });
      lane("approval.request", { command: "rm -rf build" });
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      // One beat a minute: the 12-minute stuck-stream watchdog never sees a stale bubble.
      expect(beats.length).toBeGreaterThanOrEqual(14);
      lane("tool.complete", { name: "terminal", tool_id: "t1" });
      await vi.advanceTimersByTimeAsync(0);
      const after = beats.length;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(beats.length, "nothing asked any more: no beat of ours").toBeLessThanOrEqual(after + 1);
      lane("message.complete", { text: "fini", status: "complete" });
      await run.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("an approval Atrium cannot show still keeps the bubble alive while Hermes waits", async () => {
    vi.useFakeTimers();
    try {
      const beats: string[] = [];
      const { client, writer } = harness([], [], []);
      (writer as unknown as { heartbeat: (id: string) => Promise<void> }).heartbeat = async (id: string) => {
        beats.push(id);
      };
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        { client, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "fais le travail" },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      lane("message.delta", { text: "je vérifie" });
      lane("tool.start", { name: "terminal", tool_id: "t1" });
      // No command, no description: nothing a card could show.
      lane("approval.request", {});
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(beats.length).toBeGreaterThanOrEqual(14);
      lane("tool.complete", { name: "terminal", tool_id: "t1" });
      lane("message.complete", { text: "fini", status: "complete" });
      await run.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a card whose creation failed is created on a later try — Hermes will not ask again", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { client, writer } = harness([], [], []);
      (writer as unknown as { upsertAgentRequest: () => Promise<void> }).upsertAgentRequest = async () => {
        calls += 1;
        if (calls === 1) throw new Error("ingest 503");
      };
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        { client, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "fais le travail" },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      lane("clarify.request", { question: "Laquelle ?", choices: ["a", "b"], request_id: "r1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(calls).toBe(2);
      lane("message.complete", { text: "fini", status: "complete" });
      await run.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("an approval names the bound before which the session's approvals are over (codex P2, pass 26)", async () => {
    // Hermes ACKs `streaming` only on an idle session, whose approval queue is empty.
    // Every approval raised before this turn's ACK is therefore over, and Convex closes
    // what a lost settle left open when this one is recorded.
    const before = Date.now();
    const { raised } = await turnWith((send) => send("approval.request", { command: "rm x" }));
    const bound = Number(raised[0]!.supersedesBeforeSeq);
    expect(bound).toBeGreaterThanOrEqual(before * 1000);
    expect(Number(raised[0]!.seq), "never below its own bound").toBeGreaterThan(bound);
  });

  it("two turns under a clock that stands still never share an approval's id or order (codex P1, pass 27)", async () => {
    // Id and order were (clock, per-turn counter): turn N+1's first approval came out
    // identical to turn N's, and Convex took it for a replay of N's card — which then
    // answered N+1's command. The bound must also still clear N's.
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const first = await turnWith((send) => send("approval.request", { command: "rm a" }));
      const second = await turnWith((send) => send("approval.request", { command: "rm b" }));
      const a = first.raised[0]!;
      const b = second.raised[0]!;
      expect(b.providerRequestId).not.toBe(a.providerRequestId);
      expect(Number(b.seq)).toBeGreaterThan(Number(a.seq));
      expect(Number(b.supersedesBeforeSeq), "turn N's approval falls under N+1's bound").toBeGreaterThan(
        Number(a.seq),
      );
      expect(Number(b.seq)).toBeGreaterThan(Number(b.supersedesBeforeSeq));
    } finally {
      now.mockRestore();
    }
  });

  it("a card whose CLOSE failed is closed on a later try (codex P2, pass 26)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { client, writer } = harness([], [], []);
      (writer as unknown as { settleAgentRequest: () => Promise<void> }).settleAgentRequest = async () => {
        calls += 1;
        if (calls === 1) throw new Error("ingest 503");
      };
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const run = runHermesWsTurn(
        { client, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "fais le travail" },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      lane("approval.request", { command: "rm x" });
      lane("message.complete", { text: "fini", status: "complete" });
      await run.done;
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a turn that ends releases the cards it still held", async () => {
    // Hermes unblocks every prompt when the run ends: a card left open would offer an
    // answer nobody can receive.
    const { raised, settled } = await turnWith((send) =>
      send("approval.request", { command: "rm -rf build" }),
    );
    expect(settled).toEqual([
      { chatId: "c1", providerRequestId: raised[0]!.providerRequestId, status: "cancelled" },
    ]);
  });

  it("never tells the user to go around the defect", async () => {
    // The old message advised configuring auto-approval on the gateway or approving from
    // the Hermes dashboard. Handing someone a workaround for our own defect is a rule
    // this repo holds explicitly, so the string must be GONE, not reworded.
    const { finals } = await turnWith((send) =>
      send("approval.request", { request_id: "a1", command: "rm -rf build" }),
    );
    const prose = JSON.stringify(finals);
    expect(prose).not.toMatch(/dashboard/i);
    expect(prose).not.toMatch(/approval_policy/i);
  });
});
