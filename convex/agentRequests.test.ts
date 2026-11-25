// AGENT REQUESTS — the Convex half of "an agent asks, a person answers".
//
// Every test starts from the sequence that happens in production: the bridge writes
// the request it observed (`upsertFromBridge`), then the person answers through the
// public action, which POSTs to the bridge serving the request's instance. The bridge
// is a stubbed `fetch`; what it RECEIVED is asserted, not just what Convex stored.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { ANSWER_POST_TIMEOUT_MS, deleteMessageAgentRequests, SUBMIT_STALL_MS } from "./agentRequests";
import {
  boundQuestions,
  DEFAULT_REQUEST_TTL_MS,
  EXPIRY_SWEEP_GRACE_MS,
  MAX_ANSWER_VALUES,
  MAX_OPTIONS,
  MAX_OPTIONS_TEXT,
  questionShape,
} from "./lib/agentRequests";
import { answersFromDrafts } from "../src/chat/agentRequestsView";

const modules = import.meta.glob("./**/*.ts");

const INSTANCE = "prod";
const BRIDGE_URL = "https://bridge.test";

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user", canonical: "alice" });
    await ctx.db.insert("instances", {
      name: INSTANCE,
      gatewayUrl: "ws://gateway",
      kind: "openclaw",
      bridgeUrl: BRIDGE_URL,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 0,
      instanceName: INSTANCE,
      agentId: "denis",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
    return { userId, chatId, messageId };
  });
}

const ASK = {
  source: "openclaw.ask_user" as const,
  providerCreatedAt: 1,
  providerRequestId: "ask_0123456789abcdef",
  sessionKey: "agent:denis:atrium:chat:alice:c1",
  questions: [
    {
      id: "format",
      header: "Format",
      text: "Quel format de sortie ?",
      options: [{ label: "PDF" }, { label: "Word", description: "éditable" }],
      multiSelect: false,
      allowOther: false,
      secret: false,
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.BRIDGE_SHARED_SECRET = "shared";
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BRIDGE_SHARED_SECRET;
});

function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("the bridge records what an agent asked", () => {
  test("a question is stored bounded, anchored to the turn, and notifies the owner", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      messageId,
      ...ASK,
      expiresAt: Date.now() + 15 * 60_000,
    });
    expect(res.created).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row).toMatchObject({
      kind: "question",
      status: "pending",
      messageId,
      userId,
      instanceName: INSTANCE,
    });
    expect(row!.questions![0]!.options).toHaveLength(2);
    const notes = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(notes.map((n) => n.kind)).toEqual(["agent_request"]);
    expect(notes[0]!.href).toBe(`/chat/${chatId}`);
  });

  test("a secret-store binding is kept bounded — a name and hosts, never a value", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      // An ask_user source: nothing but the binding itself makes this a secret.
      providerRequestId: "ask_store",
      questions: [
        {
          id: "hosting_key",
          text: "Clé API ?",
          options: [],
          multiSelect: false,
          allowOther: true,
          secret: false,
          store: {
            name: "HOSTING_API_KEY",
            allowedHosts: Array.from({ length: 40 }, (_, i) => `h${i}.example`),
            replacesSinceMs: 1_790_000_000_000,
          },
        },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    const q = row!.questions![0]!;
    // Store-bound means the answer IS the secret, whatever the flag said.
    expect(q.secret).toBe(true);
    expect(q.store!.name).toBe("HOSTING_API_KEY");
    // EVERY host, as the gateway will use them all (codex P1): none hidden.
    expect(q.store!.allowedHosts).toHaveLength(40);
    expect(q.store!.replacesSinceMs).toBe(1_790_000_000_000);
    // A binding whose name is not upstream's shape is dropped, not shown half-trusted.
    const bad = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_bad_store",
      questions: [
        { id: "k", text: "?", options: [], multiSelect: false, allowOther: true, secret: true, store: { name: "not a name" } },
      ],
    });
    // A binding that cannot be shown truthfully: the request is not recorded at all.
    expect(bad.id).toBeNull();
  });

  test("a form question keeps every option — up to OpenClaw's own 64 — and one multi-select answer may name them all", async () => {
    // OpenClaw 2026.10.33: `Question.options` maxItems 64 (schema/questions.ts), more
    // than four only on a `presentation: "form"` question. Cut to four, a closed question
    // offered four of the forty choices the agent gave, and nothing said so.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const forty = Array.from({ length: 40 }, (_, i) => ({ label: `Région ${i + 1}`, description: `zone ${i + 1}` }));
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_form",
      questions: [{ id: "regions", text: "Lesquelles ?", options: forty, multiSelect: true, allowOther: false, secret: false }],
    });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row!.questions![0]!.options).toEqual(forty);
    expect(MAX_OPTIONS).toBe(64);
    expect(MAX_ANSWER_VALUES).toBe(MAX_OPTIONS + 1);
    // Every option picked: accepted whole, labels restored exactly.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId: res.id!,
        answers: [{ id: "regions", values: forty.map((o) => o.label) }],
      });
    expect(out).toMatchObject({ ok: true });
    expect((await t.run((ctx) => ctx.db.get(res.id!)))!.answers).toEqual([
      { id: "regions", values: forty.map((o) => o.label) },
    ]);
  });

  test("every option of a 64-option question AND its free answer: the card's 65 values pass and reach the bridge whole", async () => {
    // OpenClaw bounds the OPTIONS (64), never the answer (`QuestionAnswersSchema`:
    // `Type.Array(Type.String())`; question-manager.ts `validateAnswers` only requires
    // an `isOther` question's values to be non-empty). The card can produce every option
    // plus the one "other" field.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const options = Array.from({ length: MAX_OPTIONS }, (_, i) => ({ label: `Région ${i + 1}` }));
    const question = { id: "regions", text: "Lesquelles ?", options, multiSelect: true, allowOther: true, secret: false };
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_all_and_other",
      questions: [question],
    });
    expect(res.id).not.toBeNull();
    const drafted = answersFromDrafts([question], {
      regions: { selected: options.map((o) => o.label), other: "  Ailleurs  " },
    });
    if (!drafted.ok) throw new Error("the card refused its own draft");
    expect(drafted.answers[0]!.values).toHaveLength(MAX_OPTIONS + 1);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: res.id!, answers: drafted.answers });
    expect(out).toMatchObject({ ok: true });
    const expected = [{ id: "regions", values: [...options.map((o) => o.label), "Ailleurs"] }];
    expect(sentBody().answers).toEqual(expected);
    expect((await t.run((ctx) => ctx.db.get(res.id!)))!.answers).toEqual(expected);
    // The free answer is ONE: a closed question gains nothing, and a second free value
    // on top of every option is past what the card can produce.
    const closed = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_all_closed",
      questions: [{ ...question, allowOther: false }],
    });
    const refused = (requestId: Id<"agentRequests">, values: string[]) =>
      t
        .withIdentity({ subject: `${userId}|session` })
        .action(api.agentRequests.answer, { requestId, answers: [{ id: "regions", values }] });
    expect(await refused(closed.id!, [...options.map((o) => o.label), "Ailleurs"])).toEqual({
      ok: false,
      reason: "AGENT_REQUEST_INVALID_ANSWER:too_many:regions",
    });
    const second = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_two_others",
      questions: [question],
    });
    expect(await refused(second.id!, [...options.map((o) => o.label), "Ailleurs", "Encore"])).toEqual({
      ok: false,
      reason: "AGENT_REQUEST_INVALID_ANSWER:too_many:regions",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a question past the option bound, or past the option-text budget, is REFUSED whole — never recorded short", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const ask = (providerRequestId: string, options: Array<{ label: string; description?: string }>) =>
      t.mutation(internal.agentRequests.upsertFromBridge, {
        chatId,
        boundInstanceName: INSTANCE,
        ...ASK,
        providerRequestId,
        questions: [{ id: "q", text: "?", options, multiSelect: false, allowOther: false, secret: false }],
      });
    const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `o${i}` }));
    expect((await ask("ask_64", labels(64))).id).not.toBeNull();
    expect((await ask("ask_65", labels(65))).id).toBeNull();
    // Sixty-four long labels would not fit a document: bounded as a whole, refused past it.
    const long = (chars: number) => Array.from({ length: 16 }, (_, i) => ({ label: `${i}-${"x".repeat(chars)}` }));
    expect(boundQuestions([{ id: "q", text: "?", options: long(7000), allowOther: false }])).not.toBeNull();
    expect(MAX_OPTIONS_TEXT).toBe(120_000);
    expect(boundQuestions([{ id: "q", text: "?", options: long(7600), allowOther: false }])).toBeNull();
    expect((await ask("ask_heavy", long(7600))).id).toBeNull();
  });

  test("an OpenClaw request without its generation is not recorded — its id alone cannot tell it from another", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const { providerCreatedAt: _unused, ...noGeneration } = ASK;
    void _unused;
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...noGeneration,
      providerRequestId: "ask_nogen",
    });
    expect(res.id).toBeNull();
  });

  test("a question and an approval sharing an id are two requests, each settled on its own", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const q = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "shared" });
    const a = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId, boundInstanceName: INSTANCE, source: "openclaw.exec", providerCreatedAt: 1, providerRequestId: "shared",
      approvalKind: "exec", approval: { command: "ls", decisions: ["allow-once", "deny"] },
    });
    expect(a.created).toBe(true);
    expect(a.id).not.toEqual(q.id);
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: "shared", providerCreatedAt: 1, family: "approval", status: "denied", decision: "deny",
    });
    const [qRow, aRow] = await t.run((ctx) => Promise.all([ctx.db.get(q.id!), ctx.db.get(a.id!)]));
    expect([qRow!.status, aRow!.status]).toEqual(["pending", "denied"]);
  });

  test("two gateways of one chat using the same id are two requests", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const other = await t.run(async (ctx) =>
      ctx.db.insert("agentRequests", {
        chatId,
        userId: (await ctx.db.get(chatId))!.userId,
        instanceName: "another-gateway",
        source: "openclaw.ask_user",
        kind: "question",
        providerRequestId: "deploy",
        providerCreatedAt: 1,
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: Date.now() + 60_000,
      }),
    );
    const mine = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "deploy", providerCreatedAt: 2 });
    expect(mine.created).toBe(true);
    // However many generations the OTHER gateway piles up under that id, this one's
    // row stays reachable (the page is per instance).
    await t.run(async (ctx) => {
      const userId = (await ctx.db.get(chatId))!.userId;
      for (let i = 0; i < 25; i += 1) {
        await ctx.db.insert("agentRequests", {
          chatId, userId, instanceName: "another-gateway", source: "openclaw.ask_user", kind: "question",
          providerRequestId: "deploy", providerCreatedAt: 100 + i, status: "cancelled", createdAt: 100 + i, updatedAt: 100 + i, expiresAt: 1,
        });
      }
    });
    const replay = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "deploy", providerCreatedAt: 2 });
    expect(replay).toEqual({ id: mine.id, created: false });
    // The other gateway's request is neither superseded nor settled by this one.
    await t.mutation(internal.agentRequests.settleFromBridge, { chatId, boundInstanceName: INSTANCE, providerRequestId: "deploy", providerCreatedAt: 2, family: "question", status: "cancelled" });
    expect((await t.run((ctx) => ctx.db.get(other)))!.status).toBe("pending");
  });

  test("a provider id is stored VERBATIM — two ids differing by a space are two requests", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const a = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: " q" });
    const b = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "q" });
    expect(b.created).toBe(true);
    expect(a.id).not.toEqual(b.id);
    const rowA = await t.run((ctx) => ctx.db.get(a.id!));
    expect(rowA!.providerRequestId).toBe(" q");
    // Too long to keep whole: refused, never shortened into another id.
    const long = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x".repeat(513) });
    expect(long.id).toBeNull();
  });

  test("the same provider id asked AGAIN later is a new request; a replay of the old one is not", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const first = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x", providerCreatedAt: 1 });
    await t.mutation(internal.agentRequests.settleFromBridge, { chatId, boundInstanceName: INSTANCE, providerRequestId: "x", status: "answered" });
    // The gateway forgot it and the agent asks again under the same id: a NEW card.
    const again = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x", providerCreatedAt: 2 });
    expect(again.created).toBe(true);
    expect(again.id).not.toEqual(first.id);
    // An older generation left OPEN (its settle was lost) is closed when the new one
    // arrives: it can never be answered in the new one's place.
    const stale = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "y", providerCreatedAt: 1 });
    const fresh = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "y", providerCreatedAt: 2 });
    expect(fresh.created).toBe(true);
    const staleRow = await t.run((ctx) => ctx.db.get(stale.id!));
    expect(staleRow!.status).toBe("cancelled");
    // A LATE settle of the older generation (a retried POST) never closes the newer one.
    const lateOld = await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: "x", providerCreatedAt: 1, status: "expired",
    });
    expect(lateOld.settled).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(again.id!)))!.status).toBe("pending");
    // A row with NO generation (an imported archive drops it) is an older request too.
    const imported = await t.run(async (ctx) =>
      ctx.db.insert("agentRequests", {
        chatId,
        userId: (await ctx.db.get(chatId))!.userId,
        instanceName: INSTANCE,
        source: "openclaw.ask_user",
        kind: "question",
        providerRequestId: "z",
        status: "expired",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 1,
      }),
    );
    const afterImport = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "z", providerCreatedAt: 2 });
    expect(afterImport.created).toBe(true);
    expect(afterImport.id).not.toEqual(imported);
    // A LATE re-emission of an OLDER generation never supersedes the newer one.
    const older = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x", providerCreatedAt: 1 });
    expect(older).toEqual({ id: again.id, created: false });
    expect((await t.run((ctx) => ctx.db.get(again.id!)))!.status).toBe("pending");
    // …and the next settle lands on the NEW one.
    await t.mutation(internal.agentRequests.settleFromBridge, { chatId, boundInstanceName: INSTANCE, providerRequestId: "x", status: "cancelled" });
    const rows = await t.run((ctx) => Promise.all([ctx.db.get(first.id!), ctx.db.get(again.id!)]));
    expect(rows.map((r) => r!.status)).toEqual(["answered", "cancelled"]);
  });

  test("an id asked again after its settle is a new request even under a frozen or stepped-back clock (codex P2, pass 28)", async () => {
    // A `pending` sighting of a settled id cannot be the old request: its `resolved`
    // came first on the same socket, and the replays list pending requests only.
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const first = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x", providerCreatedAt: 100, providerSeenSeq: 10 });
    await t.mutation(internal.agentRequests.settleFromBridge, { chatId, boundInstanceName: INSTANCE, providerRequestId: "x", status: "answered" });
    const frozen = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x", providerCreatedAt: 100, providerSeenSeq: 11 });
    expect(frozen.created).toBe(true);
    expect(frozen.id).not.toEqual(first.id);
    await t.mutation(internal.agentRequests.settleFromBridge, { chatId, boundInstanceName: INSTANCE, providerRequestId: "x", providerCreatedAt: 100, status: "answered" });
    const back = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x", providerCreatedAt: 99, providerSeenSeq: 12 });
    expect(back.created).toBe(true);
    // Its settle lands on the NEW row, not the settled one.
    await t.mutation(internal.agentRequests.settleFromBridge, { chatId, boundInstanceName: INSTANCE, providerRequestId: "x", providerCreatedAt: 99, status: "cancelled" });
    expect((await t.run((ctx) => ctx.db.get(back.id!)))!.status).toBe("cancelled");
    // …but a sighting already past its deadline is the one Atrium swept early, not a
    // new request: nothing new is recorded.
    const swept = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "w", providerCreatedAt: 5, providerSeenSeq: 20 });
    await t.run((ctx) => ctx.db.patch(swept.id!, { status: "expired" }));
    const late = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "w", providerCreatedAt: 5, providerSeenSeq: 21, expiresAt: Date.now() - 1 });
    expect(late).toEqual({ id: swept.id, created: false });
  });

  test("a sighting seen EARLIER is never a newer generation, whatever its creation time (codex, 0.21.5 pass 21)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const first = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "s", providerCreatedAt: 200, providerSeenSeq: 1000 });
    // The id comes back after a gateway clock step-back, seen later: the new generation.
    const second = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "s", providerCreatedAt: 100, providerSeenSeq: 2000 });
    expect(second.created).toBe(true);
    // A late retry of the FIRST sighting (newer creation time, earlier sighting): history.
    const retry = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "s", providerCreatedAt: 200, providerSeenSeq: 1000 });
    expect(retry).toEqual({ id: second.id, created: false });
    expect((await t.run((ctx) => ctx.db.get(second.id!)))!.status).toBe("pending");
    expect((await t.run((ctx) => ctx.db.get(first.id!)))!.status).toBe("cancelled");
  });

  test("a late settle never closes a LATER generation alike in time and shape (codex, 0.21.5 pass 22)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const q = [{ id: "confirm", text: "Continue?", options: [{ label: "Yes" }], multiSelect: false, allowOther: false, secret: false }];
    const a = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "g", providerCreatedAt: 100, providerSeenSeq: 10, questions: q });
    await t.run((ctx) => ctx.db.patch(a.id!, { status: "answered" }));
    // Asked again under the same id, same creation time, same question — seen later.
    const b = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "g", providerCreatedAt: 100, providerSeenSeq: 20, questions: q });
    expect(b.created).toBe(true);
    const settle = (seq: number) =>
      t.mutation(internal.agentRequests.settleFromBridge, {
        chatId,
        boundInstanceName: INSTANCE,
        providerRequestId: "g",
        providerCreatedAt: 100,
        family: "question",
        questionShape: questionShape(q)!,
        providerSeenSeq: seq,
        status: "cancelled",
      });
    // A's settle, late: about the generation seen by seq 10 — A, already closed.
    expect(await settle(10)).toEqual({ settled: false, outcome: "none" });
    expect((await t.run((ctx) => ctx.db.get(b.id!)))!.status).toBe("pending");
    // B's own settle closes B.
    expect(await settle(20)).toEqual({ settled: true, outcome: "settled" });
  });

  test("a late settle closes the generation it is ABOUT when two share a creation time (codex, 0.21.5 pass 21)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const q = (text: string) => [
      { id: "confirm", text, options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false, secret: false },
    ];
    const staging = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "r", providerCreatedAt: 100, providerSeenSeq: 10, questions: q("Delete staging data?") });
    const production = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "r", providerCreatedAt: 100, providerSeenSeq: 11, questions: q("Delete production data?") });
    expect(production.created).toBe(true);
    // The staging question's settle arrives late: it names what it settles.
    const late = await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      providerRequestId: "r",
      providerCreatedAt: 100,
      family: "question",
      questionShape: questionShape(q("Delete staging data?"))!,
      status: "answered",
      answers: [{ id: "confirm", values: ["Yes"] }],
    });
    expect(late).toEqual({ settled: false, outcome: "none" }); // the staging row was already closed
    const row = (await t.run((ctx) => ctx.db.get(production.id!)))!;
    expect(row.status).toBe("pending");
    expect(row.answers).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(staging.id!)))!.status).toBe("cancelled");
    // Its own settle does close it.
    const own = await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      providerRequestId: "r",
      providerCreatedAt: 100,
      family: "question",
      questionShape: questionShape(q("Delete production data?"))!,
      status: "cancelled",
    });
    expect(own).toEqual({ settled: true, outcome: "settled" });
  });

  test("a LATE write of a request that has since settled raises no phantom card (codex, 0.21.5 pass 20)", async () => {
    // Rolling deploy: the new bridge recorded and settled it; the old one's write of an
    // earlier sighting lands after. Not seen later than the settled row: history, not a reuse.
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const row = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "v", providerCreatedAt: 100, providerSeenSeq: 2000, providerSeenEpoch: "proc-B" });
    await t.mutation(internal.agentRequests.settleFromBridge, { chatId, boundInstanceName: INSTANCE, providerRequestId: "v", providerCreatedAt: 100, status: "answered" });
    const late = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "v", providerCreatedAt: 100, providerSeenSeq: 1000, providerSeenEpoch: "proc-A" });
    expect(late).toEqual({ id: row.id, created: false });
    expect((await t.run((ctx) => ctx.db.get(row.id!)))!.status).toBe("answered");
  });

  test("an observation refused as unrecordable leaves the open request as it was (codex, 0.21.5 pass 20)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const q = (id: string) => ({ id, text: "?", options: [], multiSelect: false, allowOther: true, secret: false });
    const open = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "u", providerCreatedAt: 100, providerSeenSeq: 10, questions: [q("a")] });
    // Same id and creation time, seen later, but past the question bound: refused…
    const refused = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "u", providerCreatedAt: 100, providerSeenSeq: 11, questions: ["a", "b", "c", "d", "e", "f"].map(q) });
    expect(refused).toEqual({ id: null, created: false });
    // …and the request the provider still waits on is still shown.
    expect((await t.run((ctx) => ctx.db.get(open.id!)))!.status).toBe("pending");
  });

  test("a reused id SEEN LATER supersedes the open row even if the gateway clock stepped back (codex, 0.21.5 pass 8)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const old = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x", providerCreatedAt: 200, providerSeenSeq: 1000 });
    // Its resolution was missed; the id comes back with an EARLIER creation time, seen later.
    const reused = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x", providerCreatedAt: 100, providerSeenSeq: 2000 });
    expect(reused.created).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(old.id!)))!.status).toBe("cancelled");
    // …while a late retried write of an OLDER sighting supersedes nothing.
    const late = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "x", providerCreatedAt: 50, providerSeenSeq: 500 });
    expect(late).toEqual({ id: reused.id, created: false });
  });

  test("ANOTHER bridge process is ordered by the shared clock, not later by construction (codex, 0.21.5 passes 9 and 19)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const old = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "y", providerCreatedAt: 200, providerSeenSeq: 2000, providerSeenEpoch: "proc-A" });
    // Same process, smaller seq: a late retried write — supersedes nothing.
    const late = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "y", providerCreatedAt: 100, providerSeenSeq: 1000, providerSeenEpoch: "proc-A" });
    expect(late).toEqual({ id: old.id, created: false });
    // A rolling deploy: the OLD process's late write lands after the new one recorded a
    // newer generation — it must not close it (pass 19).
    const recent = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "y2", providerCreatedAt: 200, providerSeenSeq: 2000, providerSeenEpoch: "proc-B" });
    const stale = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "y2", providerCreatedAt: 100, providerSeenSeq: 1000, providerSeenEpoch: "proc-A" });
    expect(stale).toEqual({ id: recent.id, created: false });
    expect((await t.run((ctx) => ctx.db.get(recent.id!)))!.status).toBe("pending");
    // A restarted bridge that SAW it later on the shared clock: a new generation (pass 9).
    const restarted = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "y", providerCreatedAt: 100, providerSeenSeq: 3000, providerSeenEpoch: "proc-B" });
    expect(restarted.created).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(old.id!)))!.status).toBe("cancelled");
  });

  test("the question shape is pinned — bridge/src/core/agent-requests.ts must produce the same string", () => {
    expect(
      questionShape([
        {
          id: "token",
          header: "  Jeton  ",
          text: `  ${"x".repeat(4100)}`,
          secret: true,
          multiSelect: false,
          options: [],
          url: "javascript:alert(1)",
          store: { name: "API_KEY", allowedHosts: ["api.example"], reason: " pour l'API " },
        },
        {
          id: "fmt",
          text: "Format ?",
          secret: false,
          multiSelect: true,
          options: [{ label: "  PDF ", description: " lisible " }, { label: "Word" }],
          url: "https://docs.example/fmt",
        },
      ]),
    ).toBe(
      JSON.stringify([
        ["token", true, false, [], ["API_KEY", ["api.example"]], ["Jeton", `${"x".repeat(3999)}…`, [], null, "pour l'API"]],
        ["fmt", false, true, ["  PDF ", "Word"], null, [null, "Format ?", ["lisible", null], "https://docs.example/fmt", null]],
      ]),
    );
  });

  test("the SAME creation time asking ANOTHER question, seen later, is a new generation (codex, 0.21.5 pass 15)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const ordinary = [{ id: "token", text: "Jeton ?", options: [], multiSelect: false, allowOther: true, secret: false }];
    const secret = [{ id: "token", text: "Jeton ?", options: [], multiSelect: false, allowOther: true, secret: true }];
    const old = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "z", providerCreatedAt: 100, providerSeenSeq: 10, providerSeenEpoch: "p", questions: ordinary });
    // A replay of the SAME question (same shape) stays the same row.
    const replay = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "z", providerCreatedAt: 100, providerSeenSeq: 11, providerSeenEpoch: "p", questions: ordinary });
    expect(replay).toEqual({ id: old.id, created: false });
    // Another question under the same id and time, seen later: its own row, with ITS secret.
    const reused = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, source: "openclaw.secret", providerRequestId: "z", providerCreatedAt: 100, providerSeenSeq: 12, providerSeenEpoch: "p", questions: secret });
    expect(reused.created).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(old.id!)))!.status).toBe("cancelled");
    // …and the card tells the bridge WHICH question it shows.
    await t.withIdentity({ subject: `${userId}|session` }).action(api.agentRequests.answer, {
      requestId: reused.id!,
      answers: [{ id: "token", values: ["S3CR3T"] }],
    });
    expect(sentBody().questionShape).toBe('[["token",true,false,[],null,[null,"Jeton ?",[],null,null]]]');
  });

  test("the same question sending its secret ELSEWHERE is another question (codex, 0.21.5 pass 16)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const q = (name: string, host: string) => [
      { id: "token", text: "Jeton ?", options: [], multiSelect: false, allowOther: true, secret: true, store: { name, allowedHosts: [host] } },
    ];
    const old = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, source: "openclaw.secret", providerRequestId: "w2", providerCreatedAt: 100, providerSeenSeq: 10, providerSeenEpoch: "p", questions: q("SAFE_KEY", "safe.example") });
    const moved = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, source: "openclaw.secret", providerRequestId: "w2", providerCreatedAt: 100, providerSeenSeq: 11, providerSeenEpoch: "p", questions: q("OTHER_KEY", "other.example") });
    expect(moved.created).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(old.id!)))!.status).toBe("cancelled");
  });

  test("the same id and time asking something ELSE under the same answers is another question (codex, 0.21.5 pass 17)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const q = (text: string) => [
      { id: "confirm", text, options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false, secret: false },
    ];
    const old = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "w3", providerCreatedAt: 100, providerSeenSeq: 10, providerSeenEpoch: "p", questions: q("Delete staging data?") });
    const other = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "w3", providerCreatedAt: 100, providerSeenSeq: 11, providerSeenEpoch: "p", questions: q("Delete production data?") });
    expect(other.created).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(old.id!)))!.status).toBe("cancelled");
    // A text Convex clips is still the SAME question when replayed: the shape reads it as shown.
    const long = `${"y".repeat(5000)}`;
    const first = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "w4", providerCreatedAt: 100, providerSeenSeq: 20, providerSeenEpoch: "p", questions: q(long) });
    const replay = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: "w4", providerCreatedAt: 100, providerSeenSeq: 21, providerSeenEpoch: "p", questions: q(long) });
    expect(replay).toEqual({ id: first.id, created: false });
  });

  test("a cascade larger than one transaction finishes in scheduled steps", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const { chatId, messageId } = await seed(t);
      await t.run(async (ctx) => {
        for (let i = 0; i < 205; i += 1) {
          await ctx.db.insert("agentRequests", {
            chatId,
            userId: (await ctx.db.get(chatId))!.userId,
            messageId,
            instanceName: INSTANCE,
            source: "openclaw.ask_user",
            kind: "question",
            providerRequestId: `bulk_${i}`,
            status: "answered",
            createdAt: i,
            updatedAt: i,
            expiresAt: i,
          });
        }
      });
      await t.run((ctx) => deleteMessageAgentRequests(ctx, [messageId]));
      const count = () =>
        t.run((ctx) => ctx.db.query("agentRequests").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect());
      expect((await count()).length).toBe(5);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await count()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("deleting a turn removes EVERY request of it, and one left over cannot be answered", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await seed(t);
    for (let i = 0; i < 101; i += 1) {
      await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, messageId, ...ASK, providerRequestId: `ask_many_${i}` });
    }
    await t.run((ctx) => deleteMessageAgentRequests(ctx, [messageId]));
    const left = await t.run((ctx) =>
      ctx.db.query("agentRequests").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect(),
    );
    expect(left).toHaveLength(0);
    // A request whose message is gone (cascade missed, restore…) is not answerable.
    const orphan = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, messageId, ...ASK, providerRequestId: "ask_orphan" });
    await t.run((ctx) => ctx.db.delete(messageId));
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: orphan.id!, answers: [{ id: "format", values: ["PDF"] }] });
    expect(out).toEqual({ ok: false, reason: "AGENT_REQUEST_NOT_PENDING" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a race lost in flight is recorded as the WINNER's answer, not ours", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const mk = async (id: string) => {
      const r = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: id });
      // What prepareAnswer leaves while our POST is on the wire.
      await t.run((ctx) =>
        ctx.db.patch(r.id!, { status: "submitting", answers: [{ id: "format", values: ["PDF"] }], resolvedByUserId: userId }),
      );
      return r.id!;
    };
    const lost = await mk("ask_lost");
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: "ask_lost", providerCreatedAt: 1, status: "answered",
      answers: [{ id: "format", values: ["Word"] }],
    });
    const lostRow = await t.run((ctx) => ctx.db.get(lost));
    expect(lostRow).toMatchObject({ status: "answered", resolvedElsewhere: true, answers: [{ id: "format", values: ["Word"] }] });
    expect(lostRow!.resolvedByUserId).toBeUndefined();
    // An approval won by another reviewer with a DIFFERENT decision is theirs.
    const ap = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId, boundInstanceName: INSTANCE, source: "openclaw.exec", providerCreatedAt: 1, providerRequestId: "ap_race",
      approvalKind: "exec", approval: { command: "x", decisions: ["allow-once", "allow-always", "deny"] },
    });
    await t.run((ctx) => ctx.db.patch(ap.id!, { status: "submitting", decision: "allow-once", resolvedByUserId: userId }));
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: "ap_race", providerCreatedAt: 1, status: "allowed", decision: "allow-always",
    });
    const apRow = await t.run((ctx) => ctx.db.get(ap.id!));
    expect(apRow).toMatchObject({ status: "allowed", decision: "allow-always", resolvedElsewhere: true });
    expect(apRow!.resolvedByUserId).toBeUndefined();
    // The SAME answer won by another client: the broadcast names no author, so it is
    // taken for ours — until our own RPC reports the request already settled.
    const twin = await mk("ask_twin");
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: "ask_twin", providerCreatedAt: 1, status: "answered",
      answers: [{ id: "format", values: ["PDF"] }],
    });
    await t.mutation(internal.agentRequests.completeAnswer, { requestId: twin, status: "answered", elsewhere: true });
    const twinRow = await t.run((ctx) => ctx.db.get(twin));
    expect(twinRow!.resolvedElsewhere).toBe(true);
    expect(twinRow!.resolvedByUserId).toBeUndefined();
    // The broadcast of OUR answer beating our own settle: still ours.
    const won = await mk("ask_won");
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: "ask_won", providerCreatedAt: 1, status: "answered",
      answers: [{ id: "format", values: ["PDF"] }],
    });
    const wonRow = await t.run((ctx) => ctx.db.get(won));
    expect(wonRow!.resolvedElsewhere).not.toBe(true);
    expect(wonRow!.resolvedByUserId).toBe(userId);
  });

  test("a settled row is never reopened — a later pending sighting of its id is its own row", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const first = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerSeenSeq: 1,
    });
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      providerRequestId: ASK.providerRequestId,
      status: "expired",
    });
    const again = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerSeenSeq: 2,
    });
    // The replays (question.list / approval.get) list PENDING requests only, so a
    // pending sighting after the settle is a new request under a reused id (codex P2,
    // pass 28) — recorded as its own row; the settled one stays as it was.
    expect(again.created).toBe(true);
    expect(again.id).not.toEqual(first.id);
    const row = await t.run((ctx) => ctx.db.get(first.id!));
    expect(row!.status).toBe("expired");
  });

  test("another gateway cannot write a request into this conversation", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await expect(
      t.mutation(internal.agentRequests.upsertFromBridge, {
        chatId,
        boundInstanceName: "someone-else",
        ...ASK,
      }),
    ).rejects.toThrow(/forbidden: cross-instance/);
  });

  test("without a named turn, the request anchors to the newest assistant bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
    });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row!.messageId).toBe(messageId);
  });

  test("an approval always offers deny, and one that names nothing is refused", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const ok = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.exec",
      providerCreatedAt: 1,
      providerRequestId: "appr-1",
      approvalKind: "exec",
      approval: { command: "rm -rf build", decisions: ["allow-once"] },
    });
    const row = await t.run((ctx) => ctx.db.get(ok.id!));
    expect(row!.approval!.decisions).toEqual(["allow-once", "deny"]);

    const empty = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.plugin",
      providerCreatedAt: 1,
      providerRequestId: "appr-2",
      approval: { decisions: ["allow-once", "deny"] },
    });
    expect(empty).toEqual({ id: null, created: false });
  });
});

describe("the person answers", () => {
  async function pendingQuestion(t: ReturnType<typeof convexTest>) {
    const seeded = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId: seeded.chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
    });
    return { ...seeded, requestId: res.id! };
  }

  test("a valid answer reaches the bridge in canonical form and settles the row", async () => {
    const t = convexTest(schema, modules);
    const { userId, requestId } = await pendingQuestion(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const out = await as.action(api.agentRequests.answer, {
      requestId,
      answers: [{ id: "format", values: ["  PDF "] }],
    });
    expect(out).toEqual({ ok: true, status: "answered" });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BRIDGE_URL}/agent-request/respond`);
    expect(sentBody()).toMatchObject({
      provider: "openclaw",
      source: "openclaw.ask_user",
      providerCreatedAt: 1,
      providerRequestId: ASK.providerRequestId,
      sessionKey: ASK.sessionKey,
      instanceName: INSTANCE,
      answers: [{ id: "format", values: ["PDF"] }],
    });
    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row).toMatchObject({ status: "answered", resolvedByUserId: userId });
    expect(row!.answers).toEqual([{ id: "format", values: ["PDF"] }]);
    const note = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first(),
    );
    expect(note!.readAt).toBeTypeOf("number");
  });

  test("an answer outside the options is refused BEFORE anything is sent", async () => {
    const t = convexTest(schema, modules);
    const { userId, requestId } = await pendingQuestion(t);
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId,
        answers: [{ id: "format", values: ["Markdown"] }],
      });
    expect(out).toEqual({
      ok: false,
      reason: "AGENT_REQUEST_INVALID_ANSWER:unknown_option:format",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row!.status).toBe("pending");
  });

  test("a bridge that cannot be reached puts the request back, answerable again", async () => {
    const t = convexTest(schema, modules);
    const { userId, requestId } = await pendingQuestion(t);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId,
        answers: [{ id: "format", values: ["PDF"] }],
      });
    expect(out).toEqual({ ok: false, reason: "unreachable" });
    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row).toMatchObject({ status: "pending", failureCode: "unreachable" });
    expect(row!.answers).toBeUndefined();
  });

  test("a request the gateway no longer holds takes the gateway's verdict", async () => {
    const t = convexTest(schema, modules);
    const { userId, requestId } = await pendingQuestion(t);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, error: { code: "request_gone", status: "answered" } }),
        { status: 409 },
      ),
    );
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId,
        answers: [{ id: "format", values: ["PDF"] }],
      });
    expect(out).toEqual({ ok: false, reason: "request_gone" });
    const row = await t.run((ctx) => ctx.db.get(requestId));
    // Answered by SOMEONE ELSE: our attempted answer must not be shown as theirs.
    expect(row).toMatchObject({ status: "answered", resolvedElsewhere: true });
    expect(row!.answers).toBeUndefined();
    expect(row!.resolvedByUserId).toBeUndefined();
  });

  test("a stranger cannot answer", async () => {
    const t = convexTest(schema, modules);
    const { requestId } = await pendingQuestion(t);
    const other = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "bob" });
      return uid as Id<"users">;
    });
    const out = await t
      .withIdentity({ subject: `${other}|session` })
      .action(api.agentRequests.answer, {
        requestId,
        answers: [{ id: "format", values: ["PDF"] }],
      });
    expect(out.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an expired request is refused and settled, not sent — past its deadline and the sweep's grace", async () => {
    const t = convexTest(schema, modules);
    const { userId, requestId } = await pendingQuestion(t);
    await t.run((ctx) => ctx.db.patch(requestId, { expiresAt: Date.now() - EXPIRY_SWEEP_GRACE_MS - 1 }));
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId,
        answers: [{ id: "format", values: ["PDF"] }],
      });
    expect(out).toEqual({ ok: false, reason: "AGENT_REQUEST_EXPIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row!.status).toBe("expired");
  });

  test("…within that grace, refused and not sent all the same, but left pending: the gateway may still wait (codex, integrated review of 0.103.5, pass 3)", async () => {
    const t = convexTest(schema, modules);
    const { userId, requestId } = await pendingQuestion(t);
    await t.run((ctx) => ctx.db.patch(requestId, { expiresAt: Date.now() - 1 }));
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId,
        answers: [{ id: "format", values: ["PDF"] }],
      });
    expect(out).toEqual({ ok: false, reason: "AGENT_REQUEST_EXPIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = (await t.run((ctx) => ctx.db.get(requestId)))!;
    expect(row.status).toBe("pending");
    expect(row.expiredLocally).toBeUndefined();
  });

  test("skipping a question tells the agent to carry on without an answer", async () => {
    const t = convexTest(schema, modules);
    const { userId, requestId } = await pendingQuestion(t);
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId, skip: true });
    expect(out).toEqual({ ok: true, status: "cancelled" });
    expect(sentBody()).toMatchObject({ skip: true });
    expect(sentBody().answers).toBeUndefined();
  });
});

describe("approvals and credentials", () => {
  test("a decision the agent did not offer is refused", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.system_agent",
      providerCreatedAt: 1,
      providerRequestId: "sys-1",
      approvalKind: "system-agent",
      approval: { title: "Restart gateway", decisions: ["allow-once", "deny"] },
    });
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: res.id!, decision: "allow-always" });
    expect(out).toEqual({ ok: false, reason: "AGENT_REQUEST_DECISION_NOT_OFFERED" });
  });

  test("a blast radius keeps its risk facts, each only where it belongs", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const record = async (id: string, scope: Record<string, unknown>) => {
      const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
        chatId,
        boundInstanceName: INSTANCE,
        source: "openclaw.exec",
        providerCreatedAt: 1,
        providerRequestId: id,
        approvalKind: "exec",
        approval: { command: "x", scope, decisions: ["allow-once", "allow-always", "deny"] },
      });
      return (await t.run((ctx) => ctx.db.get(res.id!)))!.approval!.scope;
    };
    expect(await record("s1", { kind: "message-send", summary: "liste · ×9", external: true })).toEqual({
      kind: "message-send",
      summary: "liste · ×9",
      external: true,
    });
    expect(await record("s2", { kind: "standing-grant", summary: "nightly · a.sh", grantDays: 30 })).toEqual({
      kind: "standing-grant",
      summary: "nightly · a.sh",
      grantDays: 30,
    });
    // Out of upstream's bounds (1..3650), or on the wrong kind: dropped.
    expect(await record("s3", { kind: "standing-grant", summary: "n · b", grantDays: 0 })).toEqual({ kind: "standing-grant", summary: "n · b" });
    expect(await record("s4", { kind: "payment", summary: "5 EUR", external: true, grantDays: 3 })).toEqual({ kind: "payment", summary: "5 EUR" });
  });

  test("an approval is sent with the provider's kind and settles as allowed", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.exec",
      providerCreatedAt: 1,
      providerRequestId: "exec-9",
      approvalKind: "exec",
      approval: { command: "npm publish", decisions: ["allow-once", "allow-always", "deny"] },
    });
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: res.id!, decision: "allow-once" });
    expect(out).toEqual({ ok: true, status: "allowed" });
    expect(sentBody()).toMatchObject({ approvalKind: "exec", decision: "allow-once" });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row).toMatchObject({ status: "allowed", decision: "allow-once" });
  });

  test("Hermes approvals are answered oldest first — its responder takes the head of the queue", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const base = {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      sessionKey: "20260922_101010_abcd",
      approval: { command: "rm x", decisions: ["allow-once", "allow-session", "deny"] },
    };
    await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:1",
      seq: 1,
    });
    const second = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:2",
      seq: 2,
    });
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: second.id!, decision: "deny" });
    expect(out).toEqual({ ok: false, reason: "AGENT_REQUEST_ANSWER_OLDEST_FIRST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("…and an earlier answer still ON THE WIRE blocks the next one too (POSTs are not ordered)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const base = {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      sessionKey: "20260922_101010_abcd",
      approval: { command: "rm x", decisions: ["allow-once", "allow-session", "deny"] },
    };
    const first = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:1",
      seq: 1,
    });
    const second = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:2",
      seq: 2,
    });
    // A's answer is in flight: the row is `submitting`, no longer `pending`.
    await t.run((ctx) => ctx.db.patch(first.id!, { status: "submitting" }));
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: second.id!, decision: "deny" });
    expect(out).toEqual({ ok: false, reason: "AGENT_REQUEST_ANSWER_OLDEST_FIRST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("…and no amount of OTHER open requests in the chat can hide the earlier one", async () => {
    // Codex pass 2's trace: 50 foreign rows before A, 100 after, then B. A page read
    // then filtered missed A, so B was accepted — and Hermes, answering by session,
    // would have applied B's decision to A.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const foreign = async (n: number, from: number) => {
      for (let i = 0; i < n; i += 1) {
        await t.mutation(internal.agentRequests.upsertFromBridge, {
          chatId,
          boundInstanceName: INSTANCE,
          ...ASK,
          providerRequestId: `ask_foreign_${from + i}`,
        });
      }
    };
    const base = {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      sessionKey: "20260922_101010_abcd",
      approval: { command: "rm x", decisions: ["allow-once", "allow-session", "deny"] },
    };
    await foreign(50, 0);
    await t.mutation(internal.agentRequests.upsertFromBridge, { ...base, providerRequestId: "hermes-approval:A", seq: 1 });
    await foreign(100, 50);
    const b = await t.mutation(internal.agentRequests.upsertFromBridge, { ...base, providerRequestId: "hermes-approval:B", seq: 2 });
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: b.id!, decision: "allow-once" });
    expect(out).toEqual({ ok: false, reason: "AGENT_REQUEST_ANSWER_OLDEST_FIRST" });
    expect(fetchMock).not.toHaveBeenCalled();
    // …and the head the person must answer first is ON SCREEN, however far back it was
    // asked: the list's page bounds the history, never what still waits (codex P2).
    const listed = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.agentRequests.listForChat, { chatId });
    const ids = (listed as Array<{ source: string; seq: number | null }>)
      .filter((r) => r.source === "hermes.approval")
      .map((r) => r.seq);
    expect(ids.sort()).toEqual([1, 2]);
  });

  test("an earlier TURN's approval whose close was lost no longer blocks the next turn's (codex P2, pass 26)", async () => {
    // Turn N's approval A was recorded, its close lost. Turn N+1 (Hermes resumes the
    // SAME runtime session) raises B: A headed the queue here and refused B oldest-first
    // for up to 24 h. B's write names the bound — N+1 was ACKed `streaming`, so Hermes
    // was idle and A is over — and closes A in the same write.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const base = {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      sessionKey: "20260922_101010_abcd",
      approval: { command: "rm x", decisions: ["allow-once", "allow-session", "deny"] },
    };
    const a = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:A",
      seq: 1_000_001,
    });
    const b = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:B",
      seq: 5_000_001,
      supersedesBeforeSeq: 5_000_000,
    });
    const rowA = await t.run((ctx) => ctx.db.get(a.id!));
    expect(rowA?.status).toBe("cancelled");
    const noteA = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user_dedupe", (q) =>
          q.eq("userId", userId).eq("dedupeKey", `agent_request:${String(a.id)}`),
        )
        .first(),
    );
    expect(noteA?.readAt, "its notification is cleared with it").toBeTypeOf("number");
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: b.id!, decision: "deny" });
    expect(out).toEqual({ ok: true, status: "denied" });
  });

  test("…while the SAME turn's earlier approval and another instance's row stay open", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const base = {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      sessionKey: "20260922_101010_abcd",
      approval: { command: "rm x", decisions: ["allow-once", "allow-session", "deny"] },
    };
    const inFlight = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:flight",
      seq: 1_000_001,
    });
    await t.run((ctx) => ctx.db.patch(inFlight.id!, { status: "submitting" }));
    const sameTurn = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:same-turn",
      seq: 5_000_001,
      supersedesBeforeSeq: 5_000_000,
    });
    const foreignId = await t.run(async (ctx) => {
      const chat = await ctx.db.get(chatId);
      return await ctx.db.insert("agentRequests", {
        chatId,
        userId: chat!.userId,
        instanceName: "other",
        source: "hermes.approval",
        kind: "approval",
        providerRequestId: "hermes-approval:foreign",
        sessionKey: "20260922_101010_abcd",
        seq: 1_000_002,
        approval: { command: "ls", decisions: ["deny"] },
        status: "pending",
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        updatedAt: 1,
      } as never);
    });
    await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:same-turn-2",
      seq: 5_000_002,
      supersedesBeforeSeq: 5_000_000,
    });
    const statuses = await t.run(async (ctx) => [
      (await ctx.db.get(inFlight.id!))?.status,
      (await ctx.db.get(sameTurn.id!))?.status,
      (await ctx.db.get(foreignId))?.status,
    ]);
    // An earlier turn's answer still in flight is closed too: the approval no longer
    // waits, and a lost action's row must not come back to `pending` (codex P2, pass 28).
    expect(statuses).toEqual(["cancelled", "pending", "pending"]);
  });

  test("another gateway's approval with the same session id is another queue — it blocks nothing (codex P2, pass 27)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("agentRequests", {
        chatId,
        userId,
        instanceName: "other",
        source: "hermes.approval",
        kind: "approval",
        providerRequestId: "hermes-approval:foreign",
        sessionKey: "20260922_101010_abcd",
        seq: 1,
        approval: { command: "ls", decisions: ["deny"] },
        status: "pending",
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        updatedAt: 1,
      } as never);
    });
    const b = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      sessionKey: "20260922_101010_abcd",
      providerRequestId: "hermes-approval:B",
      seq: 2,
      approval: { command: "rm x", decisions: ["allow-once", "deny"] },
    });
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: b.id!, decision: "deny" });
    expect(out).toEqual({ ok: true, status: "denied" });
    const listed = (await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.agentRequests.listForChat, { chatId })) as Array<{ queueKey: string | null }>;
    expect(new Set(listed.map((r) => r.queueKey)).size, "two queues, not one").toBe(2);
  });

  test("an earlier turn's answer lost IN FLIGHT cannot come back at the head of the queue (codex P2, pass 28)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const base = {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      sessionKey: "20260922_101010_abcd",
      approval: { command: "rm x", decisions: ["allow-once", "deny"] },
    };
    const a = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:A",
      seq: 1_000_001,
    });
    // A's answer went out and its action died before settling.
    await t.run((ctx) =>
      ctx.db.patch(a.id!, { status: "submitting", updatedAt: Date.now() - 10 * 60_000 }),
    );
    const b = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:B",
      seq: 5_000_001,
      supersedesBeforeSeq: 5_000_000,
    });
    await t.mutation(internal.agentRequests.reapExpired, {});
    expect((await t.run((ctx) => ctx.db.get(a.id!)))?.status).toBe("cancelled");
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: b.id!, decision: "deny" });
    expect(out).toEqual({ ok: true, status: "denied" });
  });

  test("the list names a Hermes queue with an OPAQUE label, never the gateway's session key (codex P2, pass 28)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const base = {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      approval: { command: "rm x", decisions: ["allow-once", "deny"] },
    };
    await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      sessionKey: "20260922_101010_abcd",
      providerRequestId: "hermes-approval:1",
      seq: 1,
    });
    await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      sessionKey: "20260922_101010_abcd",
      providerRequestId: "hermes-approval:2",
      seq: 2,
    });
    await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      sessionKey: "20260922_202020_efgh",
      providerRequestId: "hermes-approval:3",
      seq: 3,
    });
    const listed = (await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.agentRequests.listForChat, { chatId })) as Array<{ queueKey: string | null }>;
    expect(JSON.stringify(listed)).not.toContain("20260922_");
    expect(JSON.stringify(listed)).not.toContain(INSTANCE);
    const keys = listed.map((r) => r.queueKey);
    expect(new Set(keys).size, "one label per queue").toBe(2);
  });

  test("a Hermes approval answered BY ID (server→client request) is bound by no queue order", async () => {
    // Hermes 0.21.3+ asks with a JSON-RPC request addressed by its own `srq-…` id and
    // decides exactly that approval (`request_id`): oldest-first would only block the person.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const base = {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      sessionKey: "20260922_101010_abcd",
      answerById: true,
      approval: { command: "rm x", decisions: ["allow-once", "deny"] },
    };
    await t.mutation(internal.agentRequests.upsertFromBridge, { ...base, providerRequestId: "srq-000000000001", seq: 1 });
    const later = await t.mutation(internal.agentRequests.upsertFromBridge, { ...base, providerRequestId: "srq-000000000002", seq: 2 });
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: later.id!, decision: "deny" });
    expect(out).toEqual({ ok: true, status: "denied" });
    // …and the bridge is told how to answer it.
    expect(sentBody()).toMatchObject({ providerRequestId: "srq-000000000002", answerById: true });
    const listed = (await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.agentRequests.listForChat, { chatId })) as Array<{ answerById: boolean }>;
    expect(listed.every((r) => r.answerById)).toBe(true);
  });

  test("a CLOSED question whose only options cannot be shown is refused, never turned into free text (codex, 0.21.5 pass 14)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const closed = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_long_opt",
      questions: [{ id: "pick", text: "Laquelle ?", options: [{ label: "x".repeat(8001) }], multiSelect: false, allowOther: false, secret: false }],
    });
    expect(closed.id).toBeNull();
    // Free text as ASKED stays free text.
    const open = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_long_opt_other",
      questions: [{ id: "pick", text: "Laquelle ?", options: [{ label: "x".repeat(8001) }], multiSelect: false, allowOther: true, secret: false }],
    });
    expect(open.created).toBe(true);
  });

  test("a Hermes batch of five questions is kept whole; six are refused, never cut", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const q = (i: number) => ({ id: `q${i}`, text: `Q${i} ?`, options: [], multiSelect: false, allowOther: true, secret: false });
    const five = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.clarify",
      providerRequestId: "srq-00000000000f",
      answerById: true,
      questions: [0, 1, 2, 3, 4].map(q),
    });
    expect((await t.run((ctx) => ctx.db.get(five.id!)))!.questions).toHaveLength(5);
    const six = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.clarify",
      providerRequestId: "srq-000000000010",
      answerById: true,
      questions: [0, 1, 2, 3, 4, 5].map(q),
    });
    expect(six.id).toBeNull();
  });

  test("a Hermes approval without its session or its order is not recorded — it could not be placed in the queue", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const base = {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.approval" as const,
      approval: { command: "rm x", decisions: ["allow-once", "deny"] },
    };
    const noSeq = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:noseq",
      sessionKey: "20260922_101010_abcd",
    });
    const noSession = await t.mutation(internal.agentRequests.upsertFromBridge, {
      ...base,
      providerRequestId: "hermes-approval:nosession",
      seq: 3,
    });
    expect([noSeq.id, noSession.id]).toEqual([null, null]);
  });

  test("an option label is the ANSWER: kept byte for byte, never shortened", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const long = `${"x".repeat(250)} fin`;
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_long_label",
      questions: [
        { id: "choix", text: "Lequel ?", options: [{ label: long }, { label: "court" }], multiSelect: false, allowOther: false, secret: false },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    // Shortened, it would be sent back as an option the gateway does not know.
    expect(row!.questions![0]!.options.map((o) => o.label)).toEqual([long, "court"]);
  });

  test("a request mixing a secret and an ordinary question masks ONLY the secret", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      source: "openclaw.secret",
      providerCreatedAt: 1,
      providerRequestId: "ask_mixed",
      questions: [
        { id: "region", text: "Région ?", options: [], multiSelect: false, allowOther: true, secret: false },
        { id: "token", text: "Jeton ?", options: [], multiSelect: false, allowOther: true, secret: true },
      ],
    });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row!.questions!.map((q) => [q.id, q.secret])).toEqual([
      ["region", false],
      ["token", true],
    ]);
    // A "secret" source that carries no secret at all is not what it claims.
    const none = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      source: "openclaw.secret",
      providerCreatedAt: 1,
      providerRequestId: "ask_no_secret",
      questions: [{ id: "region", text: "Région ?", options: [], multiSelect: false, allowOther: true, secret: false }],
    });
    expect(none.id).toBeNull();
  });

  test("an approval too long to show whole can only be refused (codex P1, pass 28)", async () => {
    // OpenClaw's commandText has no length bound: a cut command shown under an allow
    // button authorises the part nobody saw.
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const long = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.exec",
      providerCreatedAt: 1,
      providerRequestId: "exec_long",
      approval: {
        command: "a".repeat(20_000) + "\nrm -rf /srv",
        decisions: ["allow-once", "allow-always", "deny"],
      },
    });
    const row = await t.run((ctx) => ctx.db.get(long.id!));
    expect(row!.approval).toMatchObject({ decisions: ["deny"], clipped: true });
    // A command the gateway shows whole (its own display bound is 16 KiB) is not cut.
    const shown = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.exec",
      providerCreatedAt: 1,
      providerRequestId: "exec_16k",
      approval: { command: "b".repeat(16_000), decisions: ["allow-once", "deny"] },
    });
    const ok = await t.run((ctx) => ctx.db.get(shown.id!));
    expect(ok!.approval!.decisions).toEqual(["allow-once", "deny"]);
    expect(ok!.approval!.clipped).toBeUndefined();
    expect(ok!.approval!.command).toHaveLength(16_000);
  });

  test("an exec keeps the NODE it runs on and a plugin keeps its id — both shown on the card (codex P1, pass 30)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.exec",
      providerCreatedAt: 1,
      providerRequestId: "exec_node",
      approval: { command: "deploy", host: "node", nodeId: "prod-eu-west", pluginId: "untrusted-publisher", decisions: ["allow-once", "deny"] },
    });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row!.approval).toMatchObject({ nodeId: "prod-eu-west", pluginId: "untrusted-publisher" });
  });

  test("…and so does one whose TOOL, PLUGIN or HOST name is cut (codex P1, pass 29)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    for (const [i, field] of (["toolName", "pluginId", "host", "nodeId"] as const).entries()) {
      const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
        chatId,
        boundInstanceName: INSTANCE,
        source: "openclaw.plugin",
        providerCreatedAt: 1,
        providerRequestId: `plugin_long_${i}`,
        approval: {
          title: "Publier",
          [field]: "x".repeat(240) + "-dangerous-operation",
          decisions: ["allow-once", "deny"],
        },
      });
      const row = await t.run((ctx) => ctx.db.get(res.id!));
      expect(row!.approval, field).toMatchObject({ decisions: ["deny"], clipped: true });
    }
  });

  test("a sudo credential keeps the command it unlocks; a secret has none to keep", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const sudo = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.sudo",
      providerRequestId: "srq-0000000000ee",
      answerById: true,
      credential: { command: "apt install x" },
    });
    expect((await t.run((ctx) => ctx.db.get(sudo.id!)))!.credential).toEqual({
      mode: "password",
      command: "apt install x",
    });
    const secret = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.secret",
      providerRequestId: "srq-0000000000ef",
      answerById: true,
      credential: { prompt: "Clé ?", command: "curl evil" },
    });
    expect((await t.run((ctx) => ctx.db.get(secret.id!)))!.credential).toEqual({
      mode: "secret",
      prompt: "Clé ?",
    });
  });

  test("a SKIP carries no answer into the mutation — not even a secret one (codex, 0.21.5 pass 8)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.secret",
      providerCreatedAt: 1,
      providerRequestId: "ask_skip_secret",
      questions: [{ id: "token", text: "Jeton ?", options: [], multiSelect: false, allowOther: true, secret: true }],
    });
    // The mutation itself refuses a raw secret, skip or not…
    await expect(
      t.mutation(internal.agentRequests.prepareAnswer, {
        requestId: res.id!,
        skip: true,
        answers: [{ id: "token", values: ["TOP_SECRET"] }],
      }),
    ).rejects.toThrow();
    // …so the action must not hand it one: the skip succeeds, and nothing secret travels.
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId: res.id!,
        skip: true,
        answers: [{ id: "token", values: ["TOP_SECRET"] }],
      });
    expect(out).toEqual({ ok: true, status: "cancelled" });
    expect(JSON.stringify(sentBody())).not.toContain("TOP_SECRET");
  });

  test("a sudo command too long to show whole: the password cannot be given, only skipped (codex, 0.21.5 pass 8)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.sudo",
      providerRequestId: "srq-0000000000c1",
      answerById: true,
      credential: { command: "x".repeat(20_000) + "; hidden-tail" },
    });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row!.credential).toMatchObject({ mode: "password", clipped: true });
    const give = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: res.id!, secret: "hunter2" });
    expect(give).toEqual({ ok: false, reason: "AGENT_REQUEST_CLIPPED" });
    expect(fetchMock).not.toHaveBeenCalled();
    const skip = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: res.id!, skip: true });
    expect(skip).toEqual({ ok: true, status: "cancelled" });
  });

  test("a sudo prompt that names NO command (Hermes <= 0.19) cannot take the password either (codex, 0.21.5 pass 9)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.sudo",
      providerRequestId: "u1",
      credential: {},
    });
    expect((await t.run((ctx) => ctx.db.get(res.id!)))!.credential).toMatchObject({
      mode: "password",
      commandMissing: true,
    });
    const give = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: res.id!, secret: "hunter2" });
    expect(give).toEqual({ ok: false, reason: "AGENT_REQUEST_CLIPPED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("answers to a question the request does not ask never reach a mutation (codex, 0.21.5 pass 10)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.secret",
      providerRequestId: "srq-00000000c0c1",
      answerById: true,
      credential: { prompt: "Clé ?", envVar: "API_KEY" },
    });
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId: res.id!,
        secret: "TOP_SECRET",
        answers: [{ id: "unused", values: ["TOP_SECRET"] }],
      });
    expect(out).toEqual({ ok: false, reason: "AGENT_REQUEST_INVALID_ANSWER:unknown_question:unused" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await t.run((ctx) => ctx.db.get(res.id!)))!.status).toBe("pending");
  });

  test("an answer with more values than the bridge relays is refused, never cut (codex, 0.21.5 pass 10)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_many",
      questions: [{ id: "tags", text: "Tags ?", options: [], multiSelect: true, allowOther: true, secret: false }],
    });
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId: res.id!,
        // One more than the most options a question may carry (64, OpenClaw 2026.10.33).
        answers: [{ id: "tags", values: Array.from({ length: 65 }, (_, i) => `v${i}`) }],
      });
    expect(out).toEqual({ ok: false, reason: "AGENT_REQUEST_INVALID_ANSWER:too_many:tags" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a credential travels to the bridge and is NEVER written to the table", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "hermes.secret",
      providerRequestId: "a1b2c3d4",
      credential: { prompt: "Clé API OpenWeather", envVar: "OPENWEATHER_KEY" },
    });
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, { requestId: res.id!, secret: "sk-live-123" });
    expect(out).toEqual({ ok: true, status: "answered" });
    expect(sentBody().secret).toBe("sk-live-123");
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(JSON.stringify(row)).not.toContain("sk-live-123");
    expect(row!.credential).toEqual({
      mode: "secret",
      prompt: "Clé API OpenWeather",
      envVar: "OPENWEATHER_KEY",
    });
  });

  test("a secret QUESTION keeps its id and drops its value", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.secret",
      providerCreatedAt: 1,
      providerRequestId: "ask_secret",
      questions: [{ id: "token", text: "Jeton GitHub", options: [], multiSelect: false, allowOther: true, secret: true }],
    });
    await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId: res.id!,
        answers: [{ id: "token", values: ["ghp_verysecret"] }],
      });
    expect(sentBody().answers).toEqual([{ id: "token", values: ["ghp_verysecret"] }]);
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row!.answers).toEqual([{ id: "token", values: [] }]);
    expect(JSON.stringify(row)).not.toContain("ghp_verysecret");
  });

  test("a secret answer never crosses into a mutation — it goes from the action to the bridge (codex P1, pass 28)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      source: "openclaw.secret",
      providerCreatedAt: 1,
      providerRequestId: "ask_mixed_secret",
      questions: [
        { id: "region", text: "Région ?", options: [], multiSelect: false, allowOther: true, secret: false },
        { id: "token", text: "Jeton ?", options: [], multiSelect: false, allowOther: true, secret: true },
      ],
    });
    // The mutation refuses to hold one: a value that reaches it is a value that crossed.
    await expect(
      t.mutation(internal.agentRequests.prepareAnswer, {
        requestId: res.id!,
        answers: [
          { id: "region", values: ["eu"] },
          { id: "token", values: ["TOP_SECRET"] },
        ],
      }),
    ).rejects.toThrow();
    // …and the action withholds it: the answer still succeeds, the bridge gets the
    // value, the mutation only ever saw the placeholder.
    const out = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId: res.id!,
        answers: [
          { id: "region", values: ["eu"] },
          { id: "token", values: ["TOP_SECRET"] },
        ],
      });
    expect(out).toEqual({ ok: true, status: "answered" });
    expect(sentBody().answers).toEqual([
      { id: "region", values: ["eu"] },
      { id: "token", values: ["TOP_SECRET"] },
    ]);
    // A placeholder is not an answer to an ordinary question either.
    const other = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_plain_placeholder",
      questions: [{ id: "note", text: "Note ?", options: [], multiSelect: false, allowOther: true, secret: false }],
    });
    const forged = await t
      .withIdentity({ subject: `${userId}|session` })
      .action(api.agentRequests.answer, {
        requestId: other.id!,
        answers: [{ id: "note", values: ["\u0000atrium-secret-withheld"] }],
      });
    expect(forged.ok).toBe(false);
  });
});

describe("settled elsewhere, swept, deleted", () => {
  test("another client's answer past our bounds is never cut into a match with ours (codex, 0.21.5 pass 11)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      providerRequestId: "ask_race",
      questions: [{ id: "tags", text: "Tags ?", options: [], multiSelect: true, allowOther: true, secret: false }],
    });
    // The most values an answer may carry (MAX_ANSWER_VALUES).
    const eight = Array.from({ length: MAX_ANSWER_VALUES }, (_, i) => `v${i}`);
    // Our answer at the bound is on the wire…
    await t.run((ctx) =>
      ctx.db.patch(res.id!, { status: "submitting", resolvedByUserId: userId, answers: [{ id: "tags", values: eight }] }),
    );
    // …and another client wins with the same values plus one more.
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      providerRequestId: "ask_race",
      status: "answered",
      answers: [{ id: "tags", values: [...eight, "i"] }],
    });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row).toMatchObject({ status: "answered", resolvedElsewhere: true });
    expect(row!.resolvedByUserId).toBeUndefined();
    // Not storable as given, so not stored — and ours does not stand in for it.
    expect(row!.answers).toBeUndefined();
  });

  test("an observed answer to a question we did not ask, or an unreadable one, is never ours (codex, 0.21.5 pass 12)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const mk = async (id: string) => {
      const res = await t.mutation(internal.agentRequests.upsertFromBridge, { chatId, boundInstanceName: INSTANCE, ...ASK, providerRequestId: id });
      await t.run((ctx) =>
        ctx.db.patch(res.id!, { status: "submitting", resolvedByUserId: userId, answers: [{ id: "format", values: ["PDF"] }] }),
      );
      return res.id!;
    };
    const extra = await mk("ask_extra");
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: "ask_extra", status: "answered",
      answers: [{ id: "format", values: ["PDF"] }, { id: "unknown", values: ["x"] }],
    });
    const unreadable = await mk("ask_unreadable");
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: "ask_unreadable", status: "answered", answersUnreadable: true,
    });
    for (const id of [extra, unreadable]) {
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row).toMatchObject({ status: "answered", resolvedElsewhere: true });
      expect(row!.resolvedByUserId).toBeUndefined();
      expect(row!.answers).toBeUndefined();
    }
  });

  test("an answer given in another client is recorded as such", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
    });
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      providerRequestId: ASK.providerRequestId,
      status: "answered",
      answers: [{ id: "format", values: ["Word"] }],
    });
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row).toMatchObject({ status: "answered", resolvedElsewhere: true });
    expect(row!.answers).toEqual([{ id: "format", values: ["Word"] }]);
  });

  test("the sweep expires an open request past its deadline", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
    });
    await t.run((ctx) => ctx.db.patch(res.id!, { expiresAt: Date.now() - 5 * 60_000 }));
    const out = await t.mutation(internal.agentRequests.reapExpired, {});
    expect(out.expired).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row!.status).toBe("expired");
  });

  test("a submitting row whose action was lost becomes answerable again", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
    });
    await t.run((ctx) =>
      ctx.db.patch(res.id!, { status: "submitting", updatedAt: Date.now() - 10 * 60_000 }),
    );
    const out = await t.mutation(internal.agentRequests.reapExpired, {});
    expect(out.unstuck).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row).toMatchObject({ status: "pending", failureCode: "stalled" });
  });

  test("deleting the chat deletes its requests", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
    });
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.chats.deleteChat, { chatId });
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.trash.purgeChat, { chatId });
    const left = await t.run((ctx) => ctx.db.query("agentRequests").collect());
    expect(left).toHaveLength(0);
    // …with their bell entries: none left, unread forever, linking to a deleted chat.
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.filter((n) => n.kind === "agent_request")).toHaveLength(0);
  });

  test("the sidebar sees which conversations wait, and nothing once answered", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    expect(await as.query(api.agentRequests.pendingByChat, {})).toMatchObject([
      { chatId, count: 1, kinds: ["question"] },
    ]);
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      providerRequestId: ASK.providerRequestId,
      status: "expired",
    });
    expect(await as.query(api.agentRequests.pendingByChat, {})).toEqual([]);
  });
});

// An approval's verdict can reach Convex BEFORE its card: an older socket's write still in
// flight while the new socket read the request already decided (agent-request-observer's
// terminal snapshot). The verdict is kept for the card, which is then recorded in it.
describe("a verdict that reaches Convex before its card", () => {
  const EXEC = {
    source: "openclaw.exec" as const,
    providerRequestId: "ap_early",
    providerCreatedAt: 100,
    approvalKind: "exec" as const,
    sessionKey: "agent:denis:atrium:chat:alice:c1",
    approval: { command: "rm -rf build", decisions: ["allow-once", "allow-always", "deny"] },
  };
  type T = ReturnType<typeof convexTest>;
  const settleEarly = (t: T, chatId: Id<"chats">, over: Record<string, unknown> = {}) =>
    t.mutation(internal.agentRequests.settleFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      providerRequestId: EXEC.providerRequestId,
      providerCreatedAt: EXEC.providerCreatedAt,
      family: "approval" as const,
      status: "allowed" as const,
      decision: "allow-once" as const,
      ...over,
    });
  const record = (t: T, chatId: Id<"chats">, over: Record<string, unknown> = {}) =>
    t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...EXEC,
      expiresAt: Date.now() + 15 * 60_000,
      ...over,
    });
  const keptVerdicts = (t: T) => t.run((ctx) => ctx.db.query("agentRequestResolutions").collect());
  const agentRequestNotes = async (t: T) =>
    (await t.run((ctx) => ctx.db.query("notifications").collect())).filter((n) => n.kind === "agent_request");

  test("it is kept, and the card created late is recorded in it — never pending, nobody notified", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    expect(await settleEarly(t, chatId)).toEqual({ settled: false, outcome: "kept" });
    expect(await keptVerdicts(t)).toMatchObject([
      { chatId, instanceName: INSTANCE, providerRequestId: "ap_early", providerCreatedAt: 100, status: "allowed", decision: "allow-once" },
    ]);
    const res = await record(t, chatId);
    expect(res.created).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(res.id!));
    expect(row).toMatchObject({ kind: "approval", status: "allowed", resolvedElsewhere: true, decision: "allow-once" });
    expect(row!.resolvedAt).toBeTypeOf("number");
    expect(row!.resolvedByUserId).toBeUndefined();
    // Not taken by that creation: the generation's terminal mark for its whole window.
    expect(await keptVerdicts(t)).toHaveLength(1);
    expect(await agentRequestNotes(t)).toEqual([]);
    expect(await t.withIdentity({ subject: `${userId}|session` }).query(api.agentRequests.pendingByChat, {})).toEqual([]);
    // A replay of the creation is that same settled card.
    expect(await record(t, chatId)).toEqual({ id: res.id, created: false });
  });

  test("an expiry kept is the card's outcome, decided by nobody", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    expect(await settleEarly(t, chatId, { status: "expired", decision: undefined })).toEqual({ settled: false, outcome: "kept" });
    const row = await t.run(async (ctx) => ctx.db.get((await record(t, chatId)).id!));
    expect(row).toMatchObject({ status: "expired" });
    expect(row!.resolvedElsewhere).toBeUndefined();
    expect(row!.decision).toBeUndefined();
  });

  test("a second settle changes nothing: the first verdict is kept once, and nothing once the card is closed", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    expect(await settleEarly(t, chatId)).toEqual({ settled: false, outcome: "kept" });
    expect(await settleEarly(t, chatId)).toEqual({ settled: false, outcome: "kept" });
    // Even another verdict for that generation: the first stands, as on a closed card.
    expect(await settleEarly(t, chatId, { status: "denied", decision: "deny" })).toEqual({ settled: false, outcome: "kept" });
    expect(await keptVerdicts(t)).toMatchObject([{ status: "allowed", decision: "allow-once" }]);
    const res = await record(t, chatId);
    expect(await settleEarly(t, chatId, { status: "denied", decision: "deny" })).toEqual({ settled: false, outcome: "none" });
    expect(await t.run((ctx) => ctx.db.get(res.id!))).toMatchObject({ status: "allowed", decision: "allow-once" });
    // Nothing more kept by a settle that found its card closed: the first verdict, alone.
    expect(await keptVerdicts(t)).toMatchObject([{ status: "allowed", decision: "allow-once" }]);
  });

  test("two creations of one generation still in flight when its verdict was kept: ONE card, decided, nobody notified — the one seen later included (codex, lot « trames 1 » pass 6)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    // Two sockets read it pending before it was decided; its verdict lands first.
    expect(await settleEarly(t, chatId)).toEqual({ settled: false, outcome: "kept" });
    const first = await record(t, chatId, { providerSeenSeq: 10 });
    expect(first.created).toBe(true);
    // The other socket's write, seen LATER (a higher sighting seq): that same card.
    expect(await record(t, chatId, { providerSeenSeq: 20 })).toEqual({ id: first.id, created: false });
    const rows = await t.run((ctx) => ctx.db.query("agentRequests").collect());
    expect(rows.map((r) => [r.providerCreatedAt, r.status])).toEqual([[100, "allowed"]]);
    expect(await agentRequestNotes(t)).toEqual([]);
    expect(await t.withIdentity({ subject: `${userId}|session` }).query(api.agentRequests.pendingByChat, {})).toEqual([]);
  });

  test("a late write of a generation recorded and settled since is that card — never a new pending one, whatever it saw later", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const open = await record(t, chatId, { providerSeenSeq: 10 });
    expect(await settleEarly(t, chatId)).toEqual({ settled: true, outcome: "settled" });
    expect(await record(t, chatId, { providerSeenSeq: 20 })).toEqual({ id: open.id, created: false });
    const rows = await t.run((ctx) => ctx.db.query("agentRequests").collect());
    expect(rows.map((r) => r.status)).toEqual(["allowed"]);
    expect(await agentRequestNotes(t)).toHaveLength(1);
  });

  // Hypothetical upstream (an approval id names one request, bridge/src/providers/openclaw/
  // approval-identity.ts): pins that another generation is never taken for this one's card.
  test("a REAL reuse — the id given again under another generation — is a new pending card, asked anew", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const old = await record(t, chatId, { providerSeenSeq: 10 });
    expect(await settleEarly(t, chatId)).toEqual({ settled: true, outcome: "settled" });
    const reused = await record(t, chatId, { providerCreatedAt: 400, providerSeenSeq: 20 });
    expect(reused.created).toBe(true);
    expect(reused.id).not.toEqual(old.id);
    expect((await t.run((ctx) => ctx.db.get(reused.id!)))!.status).toBe("pending");
    expect((await t.run((ctx) => ctx.db.get(old.id!)))!.status).toBe("allowed");
    // Each request asked for its own answer.
    expect(await agentRequestNotes(t)).toHaveLength(2);
  });

  test("another generation under the same id is not touched", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const open = await record(t, chatId, { providerSeenSeq: 10 });
    // The verdict of a LATER request reusing the id: not this card's.
    expect(await settleEarly(t, chatId, { providerCreatedAt: 200 })).toEqual({ settled: false, outcome: "kept" });
    expect((await t.run((ctx) => ctx.db.get(open.id!)))!.status).toBe("pending");
    // The open card's replay neither takes it nor changes.
    expect(await record(t, chatId, { providerSeenSeq: 10 })).toEqual({ id: open.id, created: false });
    expect((await t.run((ctx) => ctx.db.get(open.id!)))!.status).toBe("pending");
    expect(await keptVerdicts(t)).toMatchObject([{ providerCreatedAt: 200, status: "allowed" }]);
    // …and neither does a card of yet another generation.
    const third = await record(t, chatId, { providerCreatedAt: 300, providerSeenSeq: 30 });
    expect((await t.run((ctx) => ctx.db.get(third.id!)))!.status).toBe("pending");
    expect(await keptVerdicts(t)).toHaveLength(1);
  });

  test("nothing is kept for a question, nor without a generation or a family", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    expect(await settleEarly(t, chatId, { family: "question", status: "cancelled", decision: undefined })).toEqual({ settled: false, outcome: "none" });
    expect(await settleEarly(t, chatId, { providerCreatedAt: undefined })).toEqual({ settled: false, outcome: "none" });
    expect(await settleEarly(t, chatId, { family: undefined })).toEqual({ settled: false, outcome: "none" });
    expect(await keptVerdicts(t)).toEqual([]);
    const res = await record(t, chatId);
    expect((await t.run((ctx) => ctx.db.get(res.id!)))!.status).toBe("pending");
  });

  test("the sweep forgets a verdict whose card never came, and only once it has lapsed", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await settleEarly(t, chatId);
    expect((await t.mutation(internal.agentRequests.reapExpired, {})).resolutionsPurged).toBe(0);
    expect(await keptVerdicts(t)).toHaveLength(1);
    await t.run(async (ctx) => {
      for (const k of await ctx.db.query("agentRequestResolutions").collect()) {
        await ctx.db.patch(k._id, { expiresAt: Date.now() - 1 });
      }
    });
    expect((await t.mutation(internal.agentRequests.reapExpired, {})).resolutionsPurged).toBe(1);
    expect(await keptVerdicts(t)).toEqual([]);
  });
});

// A socket away, or Atrium's own clock, is never a VERDICT on a request: only the gateway's
// word closes a card for good (lot « trames 1 », pass 8). An answer given while the
// conversation's socket is away is refused retryable (the bridge's `session_unavailable`);
// a card closed by our clock is reopened by the sighting the gateway says still waits.
describe("only the gateway's word closes a card for good", () => {
  const EXEC = {
    source: "openclaw.exec" as const,
    providerRequestId: "ap_offline",
    providerCreatedAt: 500,
    approvalKind: "exec" as const,
    sessionKey: "agent:denis:atrium:chat:alice:c1",
    approval: { command: "make deploy", decisions: ["allow-once", "deny"] },
  };
  type T = ReturnType<typeof convexTest>;
  const record = (t: T, chatId: Id<"chats">, over: Record<string, unknown> = {}) =>
    t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...EXEC,
      expiresAt: Date.now() + 15 * 60_000,
      ...over,
    });
  const answer = (t: T, userId: Id<"users">, requestId: Id<"agentRequests">) =>
    t.withIdentity({ subject: `${userId}|session` }).action(api.agentRequests.answer, { requestId, decision: "allow-once" });
  const bridgeSays = (status: number, error: Record<string, unknown>) =>
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error }), { status }));
  const sweepNow = async (t: T, id: Id<"agentRequests">) => {
    await t.run((ctx) => ctx.db.patch(id, { expiresAt: Date.now() - 5 * 60_000 }));
    await t.mutation(internal.agentRequests.reapExpired, {});
  };

  test("an answer while the conversation's socket is away: the card stays pending, the error retryable — and the next try goes through", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId);
    bridgeSays(503, { code: "session_unavailable" });
    expect(await answer(t, userId, id!)).toEqual({ ok: false, reason: "session_unavailable" });
    const row = await t.run((ctx) => ctx.db.get(id!));
    expect(row).toMatchObject({ status: "pending", failureCode: "session_unavailable" });
    expect(row!.decision).toBeUndefined();
    expect(await answer(t, userId, id!)).toEqual({ ok: true, status: "allowed" });
  });

  test("a card our clock expired is reopened by the replay the gateway says still waits — answerable, until the deadline it gives now", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    await sweepNow(t, id!);
    expect(await t.run((ctx) => ctx.db.get(id!))).toMatchObject({ status: "expired", expiredLocally: true });
    // The reconnection's replay: `approval.get` said pending, so the bridge writes it again.
    const later = Date.now() + 20 * 60_000;
    expect(await record(t, chatId, { providerSeenSeq: 20, expiresAt: later })).toEqual({ id, created: false });
    const row = await t.run((ctx) => ctx.db.get(id!));
    expect(row).toMatchObject({ status: "pending", expiresAt: later });
    expect(row!.expiredLocally).toBeUndefined();
    expect(row!.resolvedAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("agentRequests").collect())).toHaveLength(1);
    expect(await answer(t, userId, id!)).toEqual({ ok: true, status: "allowed" });
  });

  test("…and so is one an answer found past its deadline and the sweep's grace", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId);
    await t.run((ctx) => ctx.db.patch(id!, { expiresAt: Date.now() - EXPIRY_SWEEP_GRACE_MS - 1 }));
    expect(await answer(t, userId, id!)).toEqual({ ok: false, reason: "AGENT_REQUEST_EXPIRED" });
    expect(await t.run((ctx) => ctx.db.get(id!))).toMatchObject({ status: "expired", expiredLocally: true });
    await record(t, chatId, { providerSeenSeq: 20 });
    expect((await t.run((ctx) => ctx.db.get(id!)))!.status).toBe("pending");
  });

  test("…while within that grace, the refused answer leaves the card open (pass 3)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId);
    await t.run((ctx) => ctx.db.patch(id!, { expiresAt: Date.now() - 1 }));
    expect(await answer(t, userId, id!)).toEqual({ ok: false, reason: "AGENT_REQUEST_EXPIRED" });
    const row = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(row.status).toBe("pending");
    expect(row.expiredLocally).toBeUndefined();
    expect(row.resolvedByUserId).toBeUndefined();
  });

  test("…and one whose deadline and grace passed while the refused answer was on the wire", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId);
    fetchMock.mockImplementationOnce(async () => {
      // The deadline and its grace pass by OUR clock while the bridge is asked.
      await t.run((ctx) => ctx.db.patch(id!, { expiresAt: Date.now() - EXPIRY_SWEEP_GRACE_MS - 1 }));
      return new Response(JSON.stringify({ ok: false, error: { code: "session_unavailable" } }), { status: 503 });
    });
    expect(await answer(t, userId, id!)).toEqual({ ok: false, reason: "session_unavailable" });
    expect(await t.run((ctx) => ctx.db.get(id!))).toMatchObject({ status: "expired", expiredLocally: true });
    await record(t, chatId, { providerSeenSeq: 20 });
    expect((await t.run((ctx) => ctx.db.get(id!)))!.status).toBe("pending");
  });

  test("…while one whose deadline passed on the wire, within the grace, is back to pending, not closed (pass 3)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId);
    fetchMock.mockImplementationOnce(async () => {
      await t.run((ctx) => ctx.db.patch(id!, { expiresAt: Date.now() - 1 }));
      return new Response(JSON.stringify({ ok: false, error: { code: "session_unavailable" } }), { status: 503 });
    });
    expect(await answer(t, userId, id!)).toEqual({ ok: false, reason: "session_unavailable" });
    const row = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(row).toMatchObject({ status: "pending", failureCode: "session_unavailable" });
    expect(row.expiredLocally).toBeUndefined();
    expect(row.resolvedByUserId).toBeUndefined();
  });

  for (const status of ["cancelled", "expired"] as const) {
    test(`the gateway's word "${status}" while our answer is on the wire, then the reply lost: closed with that word, never back to pending (codex, integrated review of 0.103.5, pass 4)`, async () => {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seed(t);
      const { id } = await record(t, chatId, { providerSeenSeq: 10 });
      let inFlight: unknown;
      fetchMock.mockImplementationOnce(async () => {
        inFlight = await t.mutation(internal.agentRequests.settleFromBridge, {
          chatId, boundInstanceName: INSTANCE, providerRequestId: EXEC.providerRequestId, providerCreatedAt: 500, family: "approval", status,
        });
        return new Response(JSON.stringify({ ok: false, error: { code: "session_unavailable" } }), { status: 503 });
      });
      expect(await answer(t, userId, id!)).toEqual({ ok: false, reason: "session_unavailable" });
      // Held by Convex: the bridge writes it no more.
      expect(inFlight).toEqual({ settled: false, outcome: "kept" });
      const row = (await t.run((ctx) => ctx.db.get(id!)))!;
      expect(row).toMatchObject({ status, closedByGateway: true });
      for (const gone of ["resolvedByUserId", "decision", "expiredLocally"] as const) {
        expect(row[gone], gone).toBeUndefined();
      }
      // A verdict: no replay reopens it.
      await record(t, chatId, { providerSeenSeq: 20 });
      expect((await t.run((ctx) => ctx.db.get(id!)))!.status).toBe(status);
    });
  }

  test("…but the answer's own reply, when it comes, still settles the card", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    fetchMock.mockImplementationOnce(async () => {
      await t.mutation(internal.agentRequests.settleFromBridge, {
        chatId, boundInstanceName: INSTANCE, providerRequestId: EXEC.providerRequestId, providerCreatedAt: 500, family: "approval", status: "cancelled",
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    expect(await answer(t, userId, id!)).toMatchObject({ ok: true });
    expect(await t.run((ctx) => ctx.db.get(id!))).toMatchObject({ status: "allowed", resolvedByUserId: userId });
  });

  test("the stall reaper only ever meets a dead answer: its POST is bounded far below the stall, so no reply can follow a closure (codex, integrated review of 0.103.5, pass 5)", () => {
    // Twice the POST bound leaves room for the body read and both mutations of the action.
    expect(2 * ANSWER_POST_TIMEOUT_MS).toBeLessThan(SUBMIT_STALL_MS);
  });

  test("an answer stalled on the wire after the gateway's word: the reaper closes it with that word, not back to pending", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    // The answer's action died after marking the card in flight.
    await t.run((ctx) =>
      ctx.db.patch(id!, { status: "submitting", updatedAt: Date.now() - 10 * 60_000, resolvedByUserId: userId, decision: "allow-once" }),
    );
    expect(
      await t.mutation(internal.agentRequests.settleFromBridge, {
        chatId, boundInstanceName: INSTANCE, providerRequestId: EXEC.providerRequestId, providerCreatedAt: 500, family: "approval", status: "cancelled",
      }),
    ).toEqual({ settled: false, outcome: "kept" });
    await t.mutation(internal.agentRequests.reapExpired, {});
    const row = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(row).toMatchObject({ status: "cancelled", closedByGateway: true });
    expect(row.resolvedByUserId).toBeUndefined();
  });

  // The gateway's own expiry, settled from its stream, lands only on a `pending` row (never
  // over our answer in flight): no answerer on it, in 0.103.4 as now — it stays closed.
  test("a REAL expiry — the gateway's own — stays: its replay is that card, closed", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: EXEC.providerRequestId, providerCreatedAt: 500, family: "approval", status: "expired",
    });
    expect(await record(t, chatId, { providerSeenSeq: 20 })).toEqual({ id, created: false });
    const row = await t.run((ctx) => ctx.db.get(id!));
    expect(row!.status).toBe("expired");
    expect(row!.expiredLocally).toBeUndefined();
  });

  // Codex, pass 10: an OLD socket read `approval.get` still pending, then lost its socket while
  // its write was retried; meanwhile an answer got the gateway's `request_gone` (expired), and
  // the expiry's broadcast was missed. The late write must not reopen the card.
  test("a pending snapshot, then an expiry the gateway confirmed in answer to ours, then that snapshot's late write: the card stays expired, its deadline untouched", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    bridgeSays(409, { code: "request_gone", status: "expired", saidBy: "gateway" });
    expect(await answer(t, userId, id!)).toEqual({ ok: false, reason: "request_gone" });
    const closed = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(closed).toMatchObject({ status: "expired", closedByGateway: true });
    // The snapshot's deadline: past by now (it expired)…
    expect(await record(t, chatId, { providerSeenSeq: 11, expiresAt: Date.now() - 1_000 })).toEqual({ id, created: false });
    // …or still ahead when it was read: the gateway's word stands either way.
    expect(await record(t, chatId, { providerSeenSeq: 12, expiresAt: Date.now() + 10 * 60_000 })).toEqual({ id, created: false });
    const row = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(row.status).toBe("expired");
    expect(row.expiresAt).toBe(closed.expiresAt);
  });

  test("a sighting whose own deadline is past reopens nothing — and no default deadline stands in for it", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    // A card Atrium closed itself (a 0.103.4 bridge's `request_gone`: no gateway word)…
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    bridgeSays(409, { code: "request_gone", status: "expired" });
    await answer(t, userId, id!);
    const closed = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(closed.closedByGateway).toBeUndefined();
    // …and a write whose deadline is past, and its grace, or that names none: still closed,
    // deadline kept.
    await record(t, chatId, { providerSeenSeq: 11, expiresAt: Date.now() - EXPIRY_SWEEP_GRACE_MS - 1_000 });
    await record(t, chatId, { providerSeenSeq: 12, expiresAt: undefined });
    const row = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(row.status).toBe("expired");
    expect(row.expiresAt).toBe(closed.expiresAt);
    // One whose deadline is ahead does reopen it, until that deadline (the upgrade, below).
    const ahead = Date.now() + 10 * 60_000;
    await record(t, chatId, { providerSeenSeq: 13, expiresAt: ahead });
    expect(await t.run((ctx) => ctx.db.get(id!))).toMatchObject({ status: "pending", expiresAt: ahead });
  });

  test("…as for a card our clock expired", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    await sweepNow(t, id!);
    await record(t, chatId, { providerSeenSeq: 11, expiresAt: Date.now() - EXPIRY_SWEEP_GRACE_MS - 1_000 });
    expect(await t.run((ctx) => ctx.db.get(id!))).toMatchObject({ status: "expired", expiredLocally: true });
  });

  test("a sighting within the grace past its deadline reopens a card Atrium closed — pending, not answerable, holding the jobs — never one the gateway closed (pass 3)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    await sweepNow(t, id!);
    const deadline = Date.now() - 1_000;
    await record(t, chatId, { providerSeenSeq: 11, expiresAt: deadline });
    const row = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(row).toMatchObject({ status: "pending", expiresAt: deadline });
    expect(row.expiredLocally).toBeUndefined();
    // Not offered to anyone: its deadline has passed.
    expect(await t.withIdentity({ subject: `${userId}|session` }).query(api.agentRequests.pendingByChat, {})).toEqual([]);
    // The gateway's own word, once given, is never undone by such a sighting.
    await t.mutation(internal.agentRequests.settleFromBridge, {
      chatId, boundInstanceName: INSTANCE, providerRequestId: EXEC.providerRequestId, providerCreatedAt: 500, family: "approval", status: "expired",
    });
    await record(t, chatId, { providerSeenSeq: 12, expiresAt: Date.now() - 500 });
    expect((await t.run((ctx) => ctx.db.get(id!)))!.status).toBe("expired");
  });

  // UPGRADE FROM 0.103.4: its bridge answered `request_gone` for a socket absent or closed,
  // without asking the gateway, and completeAnswer (unchanged since) closed the card
  // `expired`, with no `expiredLocally` — but still naming who answered (closedByAtrium).
  test("upgrade from 0.103.4: a card its answer path closed is reopened by the write that follows a pending `approval.get` — the failed answer forgotten, answerable again", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    bridgeSays(409, { code: "request_gone", status: "expired" });
    expect(await answer(t, userId, id!)).toEqual({ ok: false, reason: "request_gone" });
    const closed = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(closed).toMatchObject({ status: "expired", resolvedByUserId: userId, decision: "allow-once" });
    expect(closed.expiredLocally).toBeUndefined();
    // After the upgrade, the reconnection's replay: `approval.get` still pending.
    const later = Date.now() + 20 * 60_000;
    expect(await record(t, chatId, { providerSeenSeq: 20, expiresAt: later })).toEqual({ id, created: false });
    const row = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(row).toMatchObject({ status: "pending", expiresAt: later });
    for (const gone of ["resolvedByUserId", "decision", "resolvedAt", "expiredLocally"] as const) {
      expect(row[gone], gone).toBeUndefined();
    }
    expect(await answer(t, userId, id!)).toEqual({ ok: true, status: "allowed" });
  });

  test("upgrade from 0.103.4: so is a stuck answer its sweep closed", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    // 0.103.4's sweep of a `submitting` row past its deadline: expired, the answerer kept.
    await t.run((ctx) =>
      ctx.db.patch(id!, { status: "expired", resolvedAt: Date.now(), resolvedByUserId: userId, decision: "allow-once" }),
    );
    await record(t, chatId, { providerSeenSeq: 20 });
    expect((await t.run((ctx) => ctx.db.get(id!)))!.status).toBe("pending");
  });

  test("a verdict that landed first is never overwritten by the reopening", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const { id } = await record(t, chatId, { providerSeenSeq: 10 });
    bridgeSays(409, { code: "request_gone", status: "expired" });
    await answer(t, userId, id!);
    // The gateway's own verdict reaches Convex before the replay: it is the card's…
    expect(
      await t.mutation(internal.agentRequests.settleFromBridge, {
        chatId, boundInstanceName: INSTANCE, providerRequestId: EXEC.providerRequestId, providerCreatedAt: 500, family: "approval", status: "denied", decision: "deny",
      }),
    ).toEqual({ settled: true, outcome: "settled" });
    // …its author not the answer that failed…
    const settled = (await t.run((ctx) => ctx.db.get(id!)))!;
    expect(settled).toMatchObject({ status: "denied", decision: "deny", resolvedElsewhere: true });
    expect(settled.resolvedByUserId).toBeUndefined();
    // …and a late replay does not reopen it.
    await record(t, chatId, { providerSeenSeq: 20 });
    expect((await t.run((ctx) => ctx.db.get(id!)))!.status).toBe("denied");
  });

  test("the gateway's verdict, coming after our clock closed the card, is the card's", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const { id } = await record(t, chatId);
    await sweepNow(t, id!);
    expect(
      await t.mutation(internal.agentRequests.settleFromBridge, {
        chatId, boundInstanceName: INSTANCE, providerRequestId: EXEC.providerRequestId, providerCreatedAt: 500, family: "approval", status: "allowed", decision: "allow-once",
      }),
    ).toEqual({ settled: true, outcome: "settled" });
    const row = await t.run((ctx) => ctx.db.get(id!));
    expect(row).toMatchObject({ status: "allowed", decision: "allow-once", resolvedElsewhere: true });
    expect(row!.expiredLocally).toBeUndefined();
  });
});

describe("a sighting already past its deadline (codex, integrated review of 0.103.5)", () => {
  const EXEC = {
    source: "openclaw.exec" as const,
    providerRequestId: "ap_late",
    providerCreatedAt: 700,
    approvalKind: "exec" as const,
    sessionKey: "agent:denis:atrium:chat:alice:c1",
    approval: { command: "make deploy", decisions: ["allow-once", "deny"] },
  };
  type T = ReturnType<typeof convexTest>;
  const record = (t: T, chatId: Id<"chats">, over: Record<string, unknown> = {}) =>
    t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...EXEC,
      ...over,
    });
  const agentRequestNotes = async (t: T) =>
    (await t.run((ctx) => ctx.db.query("notifications").collect())).filter((n) => n.kind === "agent_request");

  test("past its deadline and the sweep's grace: recorded expired on our clock, with that deadline — never pending, nobody notified", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const deadline = Date.now() - EXPIRY_SWEEP_GRACE_MS - 1_000;
    const res = await record(t, chatId, { expiresAt: deadline });
    expect(res.created).toBe(true);
    const row = (await t.run((ctx) => ctx.db.get(res.id!)))!;
    expect(row).toMatchObject({ kind: "approval", status: "expired", expiredLocally: true, expiresAt: deadline });
    expect(row.resolvedAt).toBeTypeOf("number");
    expect(await agentRequestNotes(t)).toEqual([]);
    expect(await t.withIdentity({ subject: `${userId}|session` }).query(api.agentRequests.pendingByChat, {})).toEqual([]);
    // Another write of that sighting, its deadline still past, reopens nothing.
    expect(await record(t, chatId, { expiresAt: deadline, providerSeenSeq: 20 })).toEqual({ id: res.id, created: false });
    expect((await t.run((ctx) => ctx.db.get(res.id!)))!.status).toBe("expired");
  });

  test("within the grace — our clock may run ahead of the gateway's (pass 2): pending with that deadline, nobody notified, then swept like any card", async () => {
    vi.useFakeTimers();
    try {
      const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
      vi.setSystemTime(T0);
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seed(t);
      const deadline = T0 - 1_000;
      const res = await record(t, chatId, { expiresAt: deadline });
      const row = (await t.run((ctx) => ctx.db.get(res.id!)))!;
      expect(row).toMatchObject({ status: "pending", expiresAt: deadline });
      expect(row.expiredLocally).toBeUndefined();
      expect(await agentRequestNotes(t)).toEqual([]);
      // Not offered to anyone: its deadline has passed.
      expect(await t.withIdentity({ subject: `${userId}|session` }).query(api.agentRequests.pendingByChat, {})).toEqual([]);
      // Still within the grace: the sweep leaves it…
      vi.setSystemTime(deadline + EXPIRY_SWEEP_GRACE_MS - 1);
      await t.mutation(internal.agentRequests.reapExpired, {});
      expect((await t.run((ctx) => ctx.db.get(res.id!)))!.status).toBe("pending");
      // …and closes it once the grace has passed, as any card.
      vi.setSystemTime(deadline + EXPIRY_SWEEP_GRACE_MS + 1);
      await t.mutation(internal.agentRequests.reapExpired, {});
      expect(await t.run((ctx) => ctx.db.get(res.id!))).toMatchObject({ status: "expired", expiredLocally: true });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a question too", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const res = await t.mutation(internal.agentRequests.upsertFromBridge, {
      chatId,
      boundInstanceName: INSTANCE,
      ...ASK,
      expiresAt: Date.now() - EXPIRY_SWEEP_GRACE_MS - 1,
    });
    expect(await t.run((ctx) => ctx.db.get(res.id!))).toMatchObject({
      kind: "question",
      status: "expired",
      expiredLocally: true,
    });
    expect(await agentRequestNotes(t)).toEqual([]);
  });

  test("a deadline still ahead is the card's, and a sighting that names none gets the default", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const ahead = Date.now() + 60_000;
    const a = await record(t, chatId, { expiresAt: ahead });
    expect(await t.run((ctx) => ctx.db.get(a.id!))).toMatchObject({ status: "pending", expiresAt: ahead });
    const before = Date.now();
    const b = await record(t, chatId, { providerRequestId: "ap_no_deadline" });
    const row = (await t.run((ctx) => ctx.db.get(b.id!)))!;
    expect(row.status).toBe("pending");
    expect(row.expiredLocally).toBeUndefined();
    expect(row.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_REQUEST_TTL_MS);
    expect(await agentRequestNotes(t)).toHaveLength(2);
  });

  test("a verdict kept for it outranks the lapse: the card carries the gateway's verdict", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    expect(
      await t.mutation(internal.agentRequests.settleFromBridge, {
        chatId, boundInstanceName: INSTANCE, providerRequestId: EXEC.providerRequestId, providerCreatedAt: EXEC.providerCreatedAt, family: "approval", status: "allowed", decision: "allow-once",
      }),
    ).toEqual({ settled: false, outcome: "kept" });
    const res = await record(t, chatId, { expiresAt: Date.now() - EXPIRY_SWEEP_GRACE_MS - 1_000 });
    const row = (await t.run((ctx) => ctx.db.get(res.id!)))!;
    expect(row).toMatchObject({ status: "allowed", resolvedElsewhere: true, decision: "allow-once" });
    expect(row.expiredLocally).toBeUndefined();
  });
});
