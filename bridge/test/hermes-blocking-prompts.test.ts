/// <reference types="vitest" />
//
// Hermes' BLOCKING prompts (lot 33 — G-38 and G-39).
//
// Upstream `_block(event, sid, payload, timeout)` emits a request carrying a `request_id`
// and then STOPS THE TURN until a matching `*.respond` arrives or the timeout expires.
// Atrium answered none of them. Four fell through the reader's default case, so the turn
// hung — 300 s for clarify/secret, 120 s for sudo, 30 s for terminal.read — which since
// the recv deadline means it dies at 240 s with the wrong cause and drops a healthy
// session. The fifth, `approval.request`, was worse: it KILLED the turn while telling the
// user to go approve on the Hermes dashboard (advice to work around our own defect), and
// still never answered — so Hermes kept blocking, denied itself ~60 s later, and
// PERSISTED that turn. The next turn then resumed from a context this thread never had.
//
// The rule pinned here: never leave the gateway blocking on something this chat cannot
// answer — with one deliberate exception, credentials, which are left to expire.

import { describe, expect, it, vi } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter } from "../src/convex-writer.js";

type Call = [string, Record<string, unknown> | undefined];

function harness(calls: Call[], parts: unknown[], finals: unknown[]) {
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
    setPhase: () => {},
    finalize: async (_id: string, status: string, _t?: string, e?: string | null) => {
      finals.push({ status, error: e ?? undefined });
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
  const { client, writer } = harness(calls, parts, finals);
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
  return { calls, parts, finals };
}

const methodsOf = (calls: Call[]) => calls.map(([m]) => m);

describe("a blocking prompt is always ANSWERED (G-38)", () => {
  it("clarify.request is answered by request_id, and the question is shown", async () => {
    const { calls, parts } = await turnWith((send) =>
      send("clarify.request", {
        request_id: "abc123",
        question: "Quelle base de données ?",
        choices: ["postgres", "sqlite"],
      }),
    );
    const answered = calls.find(([m]) => m === "clarify.respond");
    expect(answered, "the gateway must not be left blocking").toBeDefined();
    // Addressed by `request_id` — the ONLY address the responder accepts.
    expect(answered?.[1]?.request_id).toBe("abc123");
    // …and answered EMPTY. Writing "proceed with your best guess" would be Atrium
    // answering the agent in the user's place.
    expect(answered?.[1]?.answer).toBe("");
    // The question reaches the thread, so the user can actually reply next turn.
    expect(
      parts.some(
        (p) =>
          (p as { name?: string }).name === "hermes.clarify" &&
          String((p as { output?: string }).output ?? "").includes("base de données"),
      ),
      "the user must SEE what was asked",
    ).toBe(true);
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

describe("credentials are the ONE deliberate exception (G-38)", () => {
  it("secret.request is surfaced and LEFT TO EXPIRE — never answered", async () => {
    const { calls, parts } = await turnWith((send) =>
      send("secret.request", {
        request_id: "s1",
        env_var: "STRIPE_API_KEY",
        prompt: "Clé API Stripe",
      }),
    );
    // Answering "" would be a refusal Atrium invented on the user's behalf, and it would
    // suppress the `secret.expire` the gateway emits when the prompt lapses — its own
    // fail-closed, designed for exactly this.
    expect(methodsOf(calls)).not.toContain("secret.respond");
    expect(
      parts.some((p) => (p as { name?: string }).name === "hermes.secret"),
      "the user must still see that a credential was asked for",
    ).toBe(true);
  });

  it("sudo.request likewise", async () => {
    const { calls, parts } = await turnWith((send) =>
      send("sudo.request", { request_id: "u1" }),
    );
    expect(methodsOf(calls)).not.toContain("sudo.respond");
    expect(parts.some((p) => (p as { name?: string }).name === "hermes.sudo")).toBe(true);
  });

  it("the turn survives to RECEIVE the 300 s expiry — our clock must not fire first", async () => {
    // The whole "leave the credential prompt to expire" design was defeated by our own
    // deadline: upstream holds `secret.request` for 300 s, we gave up at 240 s, so the
    // turn died a minute early as a `response_timeout` AND dropped a healthy session —
    // the exact regression this lot claims to fix (raised in review).
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      const parts: unknown[] = [];
      const finals: unknown[] = [];
      const { client, writer } = harness(calls, parts, finals);
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
      // Counted AFTER the drain: the parts ride the same apply chain as everything else,
      // so asserting mid-flight would only prove the queue is asynchronous.
      expect(
        parts.filter((p) => (p as { name?: string }).name === "hermes.secret").length,
        "the expiry must be SEEN — it is the gateway's fail-closed, not ours",
      ).toBe(2);
      expect(finals).toEqual([{ status: "complete", error: undefined }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an approval no longer kills the turn (G-39)", () => {
  it("answers the gateway and KEEPS the turn alive", async () => {
    const { calls, finals, parts } = await turnWith((send) =>
      send("approval.request", { request_id: "a1", command: "rm -rf build" }),
    );
    const answered = calls.find(([m]) => m === "approval.respond");
    expect(answered, "leaving it unanswered is what poisoned the NEXT turn").toBeDefined();
    // Addressed by SESSION, not request_id — upstream resolves the oldest pending
    // approval for the session (FIFO). Two call shapes in one family; the asymmetry is
    // upstream's, and getting it wrong here passes tests and fails in production.
    expect(answered?.[1]?.session_id).toBe("cc4ebdee");
    expect(answered?.[1]?.choice).toBe("deny");
    // The turn ran to its OWN terminal: exactly one finalize, and a successful one.
    expect(finals).toEqual([{ status: "complete", error: undefined }]);
    expect(parts.some((p) => (p as { name?: string }).name === "hermes.approval")).toBe(
      true,
    );
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
