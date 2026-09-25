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
import { deleteMessageAgentRequests } from "./agentRequests";
import { questionShape } from "./lib/agentRequests";

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
    expect(await settle(10)).toEqual({ settled: false });
    expect((await t.run((ctx) => ctx.db.get(b.id!)))!.status).toBe("pending");
    // B's own settle closes B.
    expect(await settle(20)).toEqual({ settled: true });
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
    expect(late).toEqual({ settled: false }); // the staging row was already closed
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
    expect(own).toEqual({ settled: true });
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

  test("an expired request is refused and settled, not sent", async () => {
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
    const row = await t.run((ctx) => ctx.db.get(requestId));
    expect(row!.status).toBe("expired");
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
        answers: [{ id: "tags", values: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }],
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
    const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];
    // Our 8-value answer is on the wire…
    await t.run((ctx) =>
      ctx.db.patch(res.id!, { status: "submitting", resolvedByUserId: userId, answers: [{ id: "tags", values: eight }] }),
    );
    // …and another client wins with the same eight plus a ninth.
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
