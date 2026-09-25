// `/agent-request/respond`, the provider half: what the bridge sends when a person
// answers, and what it makes of the provider's reply. The RPCs are recorded, so what
// is asserted is the exact call the gateway would receive.
import { describe, expect, it } from "vitest";
import {
  parseRespondBody,
  respondHermes,
  respondOpenClaw,
  type RespondBody,
} from "../src/agent-request-respond.js";
import { questionShape } from "../src/core/agent-requests.js";

const SESSION = "agent:denis:atrium:chat:denis:c1";
/** The chat's live session in this bridge process. */
const LIVE = { sessionKey: SESSION, instanceName: "prod", connection: { isClosed: false } };

function body(over: Partial<RespondBody>): RespondBody {
  return {
    chatId: "c1",
    instanceName: "prod",
    provider: "openclaw",
    source: "openclaw.ask_user",
    providerRequestId: "ask_1",
    sessionKey: SESSION,
    // Every recorded OpenClaw request carries its generation (required at ingest).
    providerCreatedAt: 1_000,
    skip: false,
    ...over,
  };
}

function recorder(replies: Record<string, unknown | Error>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc = async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    const r = replies[method];
    if (r instanceof Error) throw r;
    return r;
  };
  // The OpenClaw side is handed the CONNECTION, whose `request` resolves a frame.
  const gw = {
    request: async (method: string, params: Record<string, unknown>) => ({
      type: "res",
      ok: true,
      payload: await rpc(method, params),
    }),
  };
  return { calls, rpc, gw };
}

describe("parsing", () => {
  it("refuses a body without a known source or id", () => {
    expect(parseRespondBody("{}")).toBeNull();
    expect(parseRespondBody(JSON.stringify({ chatId: "c", instanceName: "i", providerRequestId: "x", source: "nope" }))).toBeNull();
  });

  it("refuses an answer past the value bound instead of cutting it (codex, 0.21.5 pass 10)", () => {
    const body = (n: number) =>
      JSON.stringify({
        chatId: "c",
        instanceName: "i",
        providerRequestId: "x",
        source: "openclaw.ask_user",
        answers: [{ id: "tags", values: Array.from({ length: n }, (_, i) => `v${i}`) }],
      });
    expect(parseRespondBody(body(8))?.answers?.[0]?.values).toHaveLength(8);
    expect(parseRespondBody(body(9))).toBeNull();
  });

  it("refuses a provider that contradicts the source", () => {
    expect(
      parseRespondBody(JSON.stringify({ chatId: "c", instanceName: "i", providerRequestId: "x", source: "hermes.sudo", provider: "openclaw" })),
    ).toBeNull();
  });
});

describe("OpenClaw questions", () => {
  it("re-checks at the gateway, then resolves with the resolver's own answer shape", async () => {
    const { calls, gw } = recorder({
      "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "pending", createdAtMs: 1_000 } },
      "question.resolve": { status: "answered" },
    });
    const out = await respondOpenClaw(body({ answers: [{ id: "format", values: ["PDF"] }] }), gw, false, LIVE);
    expect(out).toEqual({ ok: true });
    expect(calls).toEqual([
      ["question.get", { id: "ask_1" }],
      ["question.resolve", { id: "ask_1", answers: { answers: { format: ["PDF"] } }, resolvedBy: "atrium" }],
    ]);
  });

  it("refuses when the id now asks ANOTHER question at the same creation time (codex, 0.21.5 pass 15)", async () => {
    const record = {
      id: "ask_1",
      sessionKey: SESSION,
      status: "pending",
      createdAtMs: 1_000,
      questions: [{ questionId: "token", question: "Jeton ?", options: [], isSecret: true }],
    };
    // The card showed an ORDINARY `token`; the gateway now asks a SECRET one.
    const other = recorder({ "question.get": { question: record }, "question.resolve": { status: "answered" } });
    expect(
      await respondOpenClaw(
        body({ answers: [{ id: "token", values: ["x"] }], questionShape: '[["token",false,false,[],null,[null,"Jeton ?",[],null,null]]]' }),
        other.gw, false, LIVE,
      ),
    ).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "expired" });
    expect(other.calls.map(([m]) => m)).toEqual(["question.get"]);
    // The same question: answered.
    const same = recorder({ "question.get": { question: record }, "question.resolve": { status: "answered" } });
    expect(
      await respondOpenClaw(
        body({ answers: [{ id: "token", values: ["x"] }], questionShape: '[["token",true,false,[],null,[null,"Jeton ?",[],null,null]]]' }),
        same.gw, false, LIVE,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses when the secret's DESTINATION changed under the same id (codex, 0.21.5 pass 16)", async () => {
    const record = {
      id: "ask_1",
      sessionKey: SESSION,
      status: "pending",
      createdAtMs: 1_000,
      questions: [
        {
          questionId: "token",
          question: "Jeton ?",
          options: [],
          isSecret: true,
          secretStore: { name: "OTHER_KEY", allowedHosts: ["other.example"] },
        },
      ],
    };
    const g = recorder({ "question.get": { question: record }, "question.resolve": { status: "answered" } });
    expect(
      await respondOpenClaw(
        body({
          answers: [{ id: "token", values: ["s3cr3t"] }],
          questionShape: '[["token",true,false,[],["SAFE_KEY",["safe.example"]],[null,"Jeton ?",[],null,null]]]',
        }),
        g.gw, false, LIVE,
      ),
    ).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "expired" });
    expect(g.calls.map(([m]) => m)).toEqual(["question.get"]);
  });

  it("refuses when the same id now asks something ELSE in the same words' place (codex, 0.21.5 pass 17)", async () => {
    const record = {
      id: "ask_1",
      sessionKey: SESSION,
      status: "pending",
      createdAtMs: 1_000,
      questions: [
        { questionId: "confirm", question: "Delete production data?", options: [{ label: "Yes" }, { label: "No" }] },
      ],
    };
    const g = recorder({ "question.get": { question: record }, "question.resolve": { status: "answered" } });
    expect(
      await respondOpenClaw(
        body({
          answers: [{ id: "confirm", values: ["Yes"] }],
          questionShape: questionShape([
            { id: "confirm", text: "Delete staging data?", secret: false, multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] },
          ]),
        }),
        g.gw, false, LIVE,
      ),
    ).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "expired" });
    expect(g.calls.map(([m]) => m)).toEqual(["question.get"]);
  });

  it("is NEVER resolved unless the chat's session is live here, on the request's session (codex, 0.21.5 pass 23)", async () => {
    // After a bridge restart the resolution would go out on an operator connection that
    // ingests nothing: the agent would resume with nobody reading what follows.
    const g = recorder({ "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "pending", createdAtMs: 1_000, questions: [] } }, "question.resolve": { status: "answered" } });
    const gone = { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    const b = body({ answers: [{ id: "token", values: ["x"] }] });
    expect(await respondOpenClaw(b, g.gw, false, undefined)).toEqual(gone); // no live session
    expect(await respondOpenClaw(b, g.gw, false, { ...LIVE, sessionKey: "agent:denis:atrium:chat:denis:c2" })).toEqual(gone);
    expect(await respondOpenClaw(b, g.gw, false, { ...LIVE, instanceName: "other" })).toEqual(gone);
    const approval = body({ source: "openclaw.exec", approvalKind: "exec", decision: "allow-once", providerRequestId: "ap_1" } as Partial<RespondBody>);
    expect(await respondOpenClaw(approval, g.gw, true, undefined)).toEqual(gone);
    // A CLOSED socket still registered (awaiting the reaper) reads nothing either (pass 25).
    expect(await respondOpenClaw(b, g.gw, false, { ...LIVE, connection: { isClosed: true } })).toEqual(gone);
    expect(await respondOpenClaw(approval, g.gw, true, { ...LIVE, connection: { isClosed: true } })).toEqual(gone);
    expect(g.calls).toEqual([]);
  });

  it("skipping CANCELS — the agent is told to proceed without an answer", async () => {
    const { calls, gw } = recorder({
      "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "pending", createdAtMs: 1_000 } },
      "question.resolve": { status: "cancelled" },
    });
    await respondOpenClaw(body({ skip: true }), gw, false, LIVE);
    expect(calls[1]).toEqual(["question.resolve", { id: "ask_1", cancel: true, resolvedBy: "atrium" }]);
  });

  it("never settles another session's question, whatever id it is handed", async () => {
    const { calls, gw } = recorder({
      "question.get": { question: { id: "ask_1", sessionKey: "agent:denis:atrium:chat:bob:c2", status: "pending" } },
    });
    const out = await respondOpenClaw(body({ answers: [{ id: "format", values: ["PDF"] }] }), gw, false, LIVE);
    expect(out).toEqual({ ok: false, httpStatus: 403, code: "session_mismatch" });
    expect(calls.map(([m]) => m)).toEqual(["question.get"]);
  });

  it("the same id asked AGAIN is another request: an old card cannot answer the new one", async () => {
    // The gateway forgets a settled question after 15 s and takes caller-chosen ids.
    const { calls, gw } = recorder({
      "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "pending", createdAtMs: 2_000 } },
    });
    const out = await respondOpenClaw(body({ providerCreatedAt: 1_000, answers: [{ id: "format", values: ["PDF"] }] }), gw, false, LIVE);
    expect(out).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "expired" });
    expect(calls.map(([m]) => m)).toEqual(["question.get"]);
    // Same generation: answered.
    const same = recorder({
      "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "pending", createdAtMs: 1_000 } },
      "question.resolve": { status: "answered" },
    });
    expect(await respondOpenClaw(body({ providerCreatedAt: 1_000, answers: [{ id: "format", values: ["PDF"] }] }), same.gw, false, LIVE)).toEqual({ ok: true });
    // …and an approval likewise.
    const ap = recorder({ "approval.get": { approval: { status: "pending", createdAtMs: 5, presentation: { kind: "exec", agentId: "denis" } } } });
    expect(
      await respondOpenClaw(body({ source: "openclaw.exec", providerRequestId: "ap-1", approvalKind: "exec", decision: "allow-once", providerCreatedAt: 4 }), ap.gw, false, LIVE),
    ).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "expired" });
  });

  it("a question already settled says HOW, for the card to show", async () => {
    const { gw } = recorder({
      "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "answered", createdAtMs: 1_000 } },
    });
    expect(await respondOpenClaw(body({}), gw, false, LIVE)).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "answered" });
  });

  it("the gateway's own refusals map to our vocabulary", async () => {
    const gone = recorder({
      "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "pending", createdAtMs: 1_000 } },
      "question.resolve": new Error("INVALID_REQUEST: question 'ask_1' is already expired"),
    });
    expect(await respondOpenClaw(body({ answers: [{ id: "f", values: ["x"] }] }), gone.gw, false, LIVE)).toEqual({
      ok: false,
      httpStatus: 409,
      code: "request_gone",
      status: "expired",
    });
    const invalid = recorder({
      "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "pending", createdAtMs: 1_000 } },
      "question.resolve": new Error("INVALID_REQUEST: question 'format' contains an unknown option"),
    });
    expect(await respondOpenClaw(body({ answers: [{ id: "format", values: ["x"] }] }), invalid.gw, false, LIVE)).toEqual({
      ok: false,
      httpStatus: 422,
      code: "invalid_answer",
    });
    const notFound = recorder({ "question.get": new Error("INVALID_REQUEST: question 'ask_1' was not found") });
    expect((await respondOpenClaw(body({}), notFound.gw, false, LIVE)).ok).toBe(false);
  });
});

describe("OpenClaw approvals", () => {
  it("resolve through the unified resolver with the approval's own kind", async () => {
    const { calls, gw } = recorder({
      "approval.get": { approval: { status: "pending", createdAtMs: 1_000, presentation: { kind: "exec", agentId: "denis" } } },
      "approval.resolve": { applied: true, approval: { status: "allowed" } },
    });
    const out = await respondOpenClaw(
      body({ source: "openclaw.exec", providerRequestId: "ap-1", approvalKind: "exec", decision: "allow-always" }), gw, false, LIVE);
    expect(out).toEqual({ ok: true });
    expect(calls[1]).toEqual(["approval.resolve", { id: "ap-1", kind: "exec", decision: "allow-always" }]);
  });

  it("never resolves another agent's approval, whatever id it is handed", async () => {
    const { calls, gw } = recorder({
      "approval.get": { approval: { status: "pending", createdAtMs: 1_000, presentation: { kind: "exec", agentId: "bob" } } },
    });
    const out = await respondOpenClaw(
      body({ source: "openclaw.exec", providerRequestId: "ap-9", approvalKind: "exec", decision: "allow-once" }),
      gw, false, LIVE,
    );
    expect(out).toEqual({ ok: false, httpStatus: 403, code: "session_mismatch" });
    expect(calls.map(([m]) => m)).toEqual(["approval.get"]);
    // Its own agent, same shape: resolved.
    const own = recorder({
      "approval.get": { approval: { status: "pending", createdAtMs: 1_000, presentation: { kind: "exec", agentId: "denis" } } },
      "approval.resolve": { applied: true, approval: { status: "allowed" } },
    });
    expect(
      await respondOpenClaw(
        body({ source: "openclaw.exec", providerRequestId: "ap-9", approvalKind: "exec", decision: "allow-once" }),
        own.gw, false, LIVE,
      ),
    ).toEqual({ ok: true });
  });

  it("an approval naming NO agent is answerable only when this chat's socket routed it here", async () => {
    // Upstream allows `agentId: null` on an exec approval.
    const agentless = () =>
      recorder({
        "approval.get": { approval: { status: "pending", createdAtMs: 1_000, presentation: { kind: "exec", agentId: null } } },
        "approval.resolve": { applied: true, approval: { status: "allowed" } },
      });
    const b = body({ source: "openclaw.exec", providerRequestId: "ap-7", approvalKind: "exec", decision: "allow-once" });
    const unproven = agentless();
    expect(await respondOpenClaw(b, unproven.gw, false, LIVE)).toEqual({ ok: false, httpStatus: 403, code: "session_mismatch" });
    expect(unproven.calls.map(([m]) => m)).toEqual(["approval.get"]);
    expect(await respondOpenClaw(b, agentless().gw, true, LIVE)).toEqual({ ok: true });
  });

  it("first answer wins: someone else's verdict is the record", async () => {
    const { gw } = recorder({
      "approval.get": { approval: { status: "pending", createdAtMs: 1_000, presentation: { kind: "exec", agentId: "denis" } } },
      "approval.resolve": { applied: false, approval: { status: "denied" } },
    });
    expect(
      await respondOpenClaw(body({ source: "openclaw.plugin", providerRequestId: "ap-1", approvalKind: "plugin", decision: "allow-once" }), gw, false, LIVE),
    ).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "denied" });
  });
});

describe("incomplete gateway replies are never a confirmation", () => {
  it("an approval snapshot or a resolve reply missing what the schema requires is refused", async () => {
    const empty = recorder({ "approval.get": { approval: {} }, "approval.resolve": {} });
    const out = await respondOpenClaw(
      body({ source: "openclaw.exec", providerRequestId: "ap-1", approvalKind: "exec", decision: "allow-once" }),
      empty.gw, false, LIVE,
    );
    expect(out.ok).toBe(false);
    expect(empty.calls.map(([m]) => m)).toEqual(["approval.get"]);
    // A readable snapshot but an unreadable resolve reply: not "applied".
    const blank = recorder({
      "approval.get": { approval: { status: "pending", createdAtMs: 1_000, presentation: { kind: "exec", agentId: "denis" } } },
      "approval.resolve": {},
    });
    expect(
      await respondOpenClaw(body({ source: "openclaw.exec", providerRequestId: "ap-1", approvalKind: "exec", decision: "allow-once" }), blank.gw, false, LIVE),
    ).toEqual({ ok: false, httpStatus: 502, code: "gateway_error" });
  });

  it("a question record or a resolve reply missing what the schema requires is refused", async () => {
    const noGen = recorder({ "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "pending" } } });
    expect((await respondOpenClaw(body({ answers: [{ id: "format", values: ["PDF"] }] }), noGen.gw, false, LIVE)).ok).toBe(false);
    expect(noGen.calls.map(([m]) => m)).toEqual(["question.get"]);
    const blank = recorder({
      "question.get": { question: { id: "ask_1", sessionKey: SESSION, status: "pending", createdAtMs: 1_000 } },
      "question.resolve": {},
    });
    expect(await respondOpenClaw(body({ answers: [{ id: "format", values: ["PDF"] }] }), blank.gw, false, LIVE)).toEqual({
      ok: false,
      httpStatus: 502,
      code: "gateway_error",
    });
  });
});

describe("Hermes", () => {
  const hb = (over: Partial<RespondBody>) =>
    body({ provider: "hermes", sessionKey: "cc4ebdee", ...over });

  /** The live turn's queue, as ws-turn keeps it. */
  const queueOf = (...ids: string[]) => {
    const answered = new Set<string>();
    let unknown = false;
    return {
      ambiguity: () => (unknown ? ("order_unknown" as const) : null),
      head: () => (unknown ? null : (ids.find((id) => !answered.has(id)) ?? null)),
      answered: (id: string) => {
        answered.add(id);
      },
      uncertain: () => {
        unknown = true;
      },
    };
  };
  /** The chat's live turn holding the ≤ 0.19 prompts `ids`. */
  const holding = (...ids: string[]) => ({ ...queueOf(), holds: (id: string) => ids.includes(id) });

  it("an approval is answered by SESSION with Hermes' own choice word", async () => {
    const { calls, rpc } = recorder({ "approval.respond": { resolved: 1 } });
    const id = "hermes-approval:cc4ebdee:1:1";
    const out = await respondHermes(hb({ source: "hermes.approval", providerRequestId: id, decision: "allow-session" }), rpc as never, queueOf(id));
    expect(out).toEqual({ ok: true });
    expect(calls).toEqual([["approval.respond", { session_id: "cc4ebdee", choice: "session" }]]);
  });

  it("an approval queue already empty is a request gone", async () => {
    const { rpc } = recorder({ "approval.respond": { resolved: 0 } });
    expect(
      await respondHermes(hb({ source: "hermes.approval", providerRequestId: "x", decision: "deny" }), rpc as never, queueOf("x")),
    ).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "expired" });
  });

  it("several approvals waiting at once: none is decidable from here (another client may reorder them silently)", async () => {
    const { calls, rpc } = recorder({ "approval.respond": { resolved: 1 } });
    const several = { head: () => null, ambiguity: () => "several" as const, answered: () => {}, uncertain: () => {} };
    expect(await respondHermes(hb({ source: "hermes.approval", providerRequestId: "A", decision: "allow-once" }), rpc as never, several)).toEqual({
      ok: false,
      httpStatus: 409,
      code: "approval_ambiguous",
    });
    expect(calls).toEqual([]);
  });

  it("a decision is sent ONLY for the head: any other card would decide the head instead", async () => {
    const { calls, rpc } = recorder({ "approval.respond": { resolved: 1 } });
    const gone = { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    // B while A still waits ahead of it.
    expect(await respondHermes(hb({ source: "hermes.approval", providerRequestId: "B", decision: "allow-once" }), rpc as never, queueOf("A", "B"))).toEqual(gone);
    // No live turn: Hermes cleared its prompts when the run ended.
    expect(await respondHermes(hb({ source: "hermes.approval", providerRequestId: "A", decision: "allow-once" }), rpc as never)).toEqual(gone);
    expect(calls).toEqual([]);
  });

  it("a failed call freezes the queue: applied or never sent, no later decision can land on the wrong approval", async () => {
    // Codex P1, both directions. If A was APPLIED and only the reply was lost, retrying A
    // would decide B. If A was NEVER SENT, answering B would decide A. The two cannot be
    // told apart from here, so nothing is sent until the agent moves again.
    const q = queueOf("A", "B");
    const { calls, rpc } = recorder({ "approval.respond": new Error("socket closed") });
    const first = await respondHermes(hb({ source: "hermes.approval", providerRequestId: "A", decision: "allow-once" }), rpc as never, q);
    expect(first.ok).toBe(false);
    const frozen = { ok: false, httpStatus: 409, code: "approval_order_unknown" };
    expect(await respondHermes(hb({ source: "hermes.approval", providerRequestId: "A", decision: "allow-once" }), rpc as never, q)).toEqual(frozen);
    expect(await respondHermes(hb({ source: "hermes.approval", providerRequestId: "B", decision: "deny" }), rpc as never, q)).toEqual(frozen);
    expect(calls).toHaveLength(1);
  });

  it("clarify is answered by request_id; skip sends the empty answer", async () => {
    const { calls, rpc } = recorder({ "clarify.respond": { status: "ok" } });
    await respondHermes(hb({ source: "hermes.clarify", providerRequestId: "abc123", answers: [{ id: "answer", values: ["postgres"] }] }), rpc as never, holding("abc123"));
    await respondHermes(hb({ source: "hermes.clarify", providerRequestId: "abc123", skip: true }), rpc as never, holding("abc123"));
    expect(calls).toEqual([
      ["clarify.respond", { request_id: "abc123", answer: "postgres" }],
      ["clarify.respond", { request_id: "abc123", answer: "" }],
    ]);
  });

  it("a credential goes under its responder's own key", async () => {
    const { calls, rpc } = recorder({ "secret.respond": { status: "ok" }, "sudo.respond": { status: "ok" } });
    await respondHermes(hb({ source: "hermes.secret", providerRequestId: "s1", secret: "sk-1" }), rpc as never, holding("s1"));
    await respondHermes(hb({ source: "hermes.sudo", providerRequestId: "u1", secret: "hunter2" }), rpc as never, holding("u1"));
    expect(calls).toEqual([
      ["secret.respond", { request_id: "s1", value: "sk-1" }],
      ["sudo.respond", { request_id: "u1", password: "hunter2" }],
    ]);
  });

  it("a reply that is not Hermes' own shape confirms nothing — and freezes the approval queue", async () => {
    const q = queueOf("A", "B");
    const odd = recorder({ "approval.respond": {} });
    expect(await respondHermes(hb({ source: "hermes.approval", providerRequestId: "A", decision: "allow-once" }), odd.rpc as never, q)).toEqual({
      ok: false,
      httpStatus: 502,
      code: "gateway_error",
    });
    // The decision's fate is unknown: B must not become answerable as if A were gone.
    expect(q.head()).toBeNull();
    const blank = recorder({ "clarify.respond": {}, "secret.respond": { status: "weird" } });
    expect(await respondHermes(hb({ source: "hermes.clarify", providerRequestId: "c1", answers: [{ id: "answer", values: ["x"] }] }), blank.rpc as never, holding("c1"))).toEqual({
      ok: false,
      httpStatus: 502,
      code: "gateway_error",
    });
    const secret = await respondHermes(hb({ source: "hermes.secret", providerRequestId: "s1", secret: "v" }), blank.rpc as never, holding("s1"));
    expect(secret).toEqual({ ok: false, httpStatus: 502, code: "gateway_error" });
  });

  it("`no pending … request` is a request gone, not a failure to retry", async () => {
    const { rpc } = recorder({ "clarify.respond": new Error("no pending answer request [RPC_ERROR]") });
    expect(
      await respondHermes(hb({ source: "hermes.clarify", providerRequestId: "gone", answers: [{ id: "answer", values: ["x"] }] }), rpc as never, holding("gone")),
    ).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "expired" });
  });

  it("a ≤ 0.19 approval Hermes already TOOK is over as ITS decision on a retry (codex, 0.21.5 pass 27)", async () => {
    const taken = new Map<string, string>();
    const q = {
      ...queueOf("A"),
      served: (id: string, verdict?: string) => {
        if (verdict !== undefined) taken.set(id, verdict);
      },
    };
    const { calls, rpc } = recorder({ "approval.respond": { resolved: 1 } });
    const b = hb({ source: "hermes.approval", providerRequestId: "A", decision: "deny" });
    const answeredAs = (id: string) => (taken.get(id) ?? null) as never;
    expect(await respondHermes(b, rpc as never, q, answeredAs)).toEqual({ ok: true });
    expect(await respondHermes(b, rpc as never, q, answeredAs)).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "denied" });
    expect(calls).toHaveLength(1);
  });

  it("a ≤ 0.19 prompt Hermes already TOOK is over as answered on a retry (codex, 0.21.5 pass 26)", async () => {
    const taken = new Map<string, string>();
    const turn = {
      ...holding("p1"),
      served: (id: string, verdict?: string) => {
        if (verdict !== undefined) taken.set(id, verdict);
      },
    };
    const { calls, rpc } = recorder({ "secret.respond": { status: "ok" } });
    const b = hb({ source: "hermes.secret", providerRequestId: "p1", secret: "sk-1" });
    const answeredAs = (id: string) => (taken.get(id) ?? null) as never;
    expect(await respondHermes(b, rpc as never, turn, answeredAs)).toEqual({ ok: true });
    expect(await respondHermes(b, rpc as never, turn, answeredAs)).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "answered" });
    expect(calls).toHaveLength(1); // the secret is never sent twice
    const clarify = recorder({ "clarify.respond": { status: "ok" } });
    const c = hb({ source: "hermes.clarify", providerRequestId: "p1", answers: [{ id: "answer", values: ["x"] }] });
    taken.clear();
    expect(await respondHermes(c, clarify.rpc as never, turn, answeredAs)).toEqual({ ok: true });
    expect(await respondHermes(c, clarify.rpc as never, turn, answeredAs)).toMatchObject({ code: "request_gone", status: "answered" });
    expect(clarify.calls).toHaveLength(1);
  });

  it("a ≤ 0.19 prompt is NEVER answered unless the chat's live turn holds it (codex, 0.21.5 pass 19)", async () => {
    // Hermes 0.19 resolves `*.respond` by request_id alone and a running session outlives
    // its socket: after a bridge restart the answer would release a run nobody observes.
    const { calls, rpc } = recorder({ "clarify.respond": { status: "ok" }, "secret.respond": { status: "ok" }, "sudo.respond": { status: "ok" } });
    const gone = { ok: false, httpStatus: 409, code: "request_gone", status: "expired" };
    const bodies = [
      hb({ source: "hermes.clarify", providerRequestId: "p1", answers: [{ id: "answer", values: ["x"] }] }),
      hb({ source: "hermes.secret", providerRequestId: "p1", secret: "sk-1" }),
      hb({ source: "hermes.sudo", providerRequestId: "p1", secret: "hunter2" }),
    ];
    for (const b of bodies) {
      expect(await respondHermes(b, rpc as never)).toEqual(gone); // no live turn
      expect(await respondHermes(b, rpc as never, holding("other"))).toEqual(gone); // not its prompt
    }
    expect(calls).toEqual([]);
  });
});
