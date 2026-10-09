/// <reference types="vite/client" />
//
// THE TRANSCRIPT MAKES THE BUBBLES — the Convex half (transcript redesign phase 4).
//
// `applyTranscript` on a projected conversation (`transcriptProjection: "on"`): a durable
// row REPLACES the live bubble in the same message, settled in the same mutation (live
// row deleted); rows that arrive before any live frame make the bubble; the three `on`
// limitations of 0.95.0, each as a case; and `shadow` pinned unchanged next to them.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { cascadeDeleteChat } from "./chats";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { ALL_SEGMENTS, rowTextSignature, TEXT_PURGED_SIG, tombstoneHit } from "./lib/transcriptProjection";
import schema from "./schema";
import { GATEWAY_HOLDS_INPUT_REASON } from "./turnRetry";
import {
  isChatBusy,
  projectedGatewayHoldUntil,
  SESSION_ACTIVE_FRESH_MS,
} from "./lib/outboxQueue";
import { effectiveOrder } from "./lib/messageOrder";
import { newBudget, PROJECTION_BYTE_BUDGET, projectBubbles } from "./lib/bubbleProjectionStore";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Mode = "on" | "shadow";

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  vi.useRealTimers();
});

const SK = "agent:main:atrium:chat:u:c1";

type Row = {
  entryId: string;
  seq: number;
  role: string;
  runId?: string;
  sendId?: string;
  steerTargetRunId?: string;
  hidden: boolean;
  visible: boolean;
  text?: string;
  yieldAck?: string;
};

const user = (entryId: string, seq: number, sendId: string, extra: Partial<Row> = {}): Row => ({
  entryId,
  seq,
  role: "user",
  runId: sendId,
  sendId,
  hidden: false,
  visible: true,
  ...extra,
});
const said = (entryId: string, seq: number, runId: string, text: string, extra: Partial<Row> = {}): Row => ({
  entryId,
  seq,
  role: "assistant",
  runId,
  hidden: false,
  visible: true,
  text,
  ...extra,
});

/** A projected conversation with one user message (`sendA`) and a first, empty read
 *  (the floor sits at 0: everything after it is projected). */
async function seed(t: T, mode: Mode) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", {
      userId,
      instanceName: "prod",
      agentId: "main",
      isDefault: true,
      source: "manual" as const,
      createdAt: 1,
    });
    await ctx.db.insert("instances", {
      name: "prod",
      gatewayUrl: "ws://gw",
      config: { transcriptProjection: mode } as never,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    const userMessageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "question A",
      sendId: "sendA",
      updatedAt: 1,
    });
    await ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId: "a",
      messageId: userMessageId,
      text: "question A",
      attachmentIds: [],
      status: "sent",
      sendId: "sendA",
    });
    return { userId, chatId, userMessageId };
  });
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}

function apply(
  t: T,
  chatId: Id<"chats">,
  rows: Row[],
  extra: Record<string, unknown> = {},
) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${Math.random()}`,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}

const terminal = (runId: string, status = "completed") => ({ runId, status, at: Date.now() });

async function liveBubble(
  t: T,
  ids: { chatId: Id<"chats">; userId: Id<"users"> },
  runId: string,
  liveText: string,
  extra: Record<string, unknown> = {},
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("messages", {
      chatId: ids.chatId,
      userId: ids.userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId,
      turnSessionKey: SK,
      boundInstance: "prod",
      updatedAt: Date.now(),
      ...extra,
    });
    await ctx.db.insert("streamingText", {
      messageId: id,
      chatId: ids.chatId,
      userId: ids.userId,
      generation: runId,
      boundInstance: "prod",
      text: liveText,
      updatedAt: Date.now(),
    });
    return id;
  });
}

/** A stored row whose display text is known, as `applyTranscript` writes it in `on`: the
 *  identity, its text document, the signature. */
async function insertRowWithText(
  ctx: MutationCtx,
  row: Omit<Doc<"transcriptRows">, "_id" | "_creationTime" | "textSig">,
  text: string,
): Promise<Id<"transcriptRows">> {
  const rowId = await ctx.db.insert("transcriptRows", { ...row, textSig: rowTextSignature(text, undefined) });
  await ctx.db.insert("transcriptRowTexts", { chatId: row.chatId, rowId, text, updatedAt: 1 });
  return rowId;
}

/** A row as the bridge's read apply sends it once its text went ahead (texts-only posts). */
const identityOnly = (r: Row): Row => {
  const { text: _t, yieldAck: _a, ...rest } = r;
  return rest;
};

/** The bridge's chunking (providers/openclaw/transcript-shadow.ts `chunkTextRows`), in
 *  test form: texts-only `live` posts of at most `maxRows` rows and 3 MiB of text each. */
async function postTextsInChunks(t: T, chatId: Id<"chats">, rows: Row[], maxRows = 40) {
  let chunk: Row[] = [];
  let bytes = 0;
  // A refusal (`too_large`) splits the chunk in two, as the bridge does.
  const post = async (rowsOf: Row[]): Promise<void> => {
    const res = (await apply(t, chatId, rowsOf, { kind: "live", textsOnly: true })) as { ok: boolean; reason?: string };
    if (res.ok) return;
    expect(res.reason).toBe("too_large");
    expect(rowsOf.length).toBeGreaterThan(1);
    const half = Math.ceil(rowsOf.length / 2);
    await post(rowsOf.slice(0, half));
    await post(rowsOf.slice(half));
  };
  const flush = async () => {
    if (chunk.length === 0) return;
    await post(chunk);
    chunk = [];
    bytes = 0;
  };
  for (const r of rows) {
    const cost = new TextEncoder().encode((r.text ?? "") + (r.yieldAck ?? "")).length + 128;
    if (chunk.length >= maxRows || bytes + cost > 3 * 1024 * 1024) await flush();
    chunk.push(r);
    bytes += cost;
  }
  await flush();
}

/** The send's run admission (projection `on`), as `bridge.markOutbox` writes it. */
async function admit(ctx: MutationCtx, ob: Id<"outbox">) {
  const row = (await ctx.db.get(ob))!;
  await ctx.db.insert("runAdmissions", {
    chatId: row.chatId,
    outboxId: ob,
    ...(row.sendId !== undefined ? { sendId: row.sendId } : {}),
    ...(row.sentToInstance !== undefined ? { sentToInstance: row.sentToInstance } : {}),
    admittedAt: Date.now(),
  });
}
const admittedAt = (t: T, ob: Id<"outbox">) =>
  t
    .run(async (ctx) => (await ctx.db.query("runAdmissions").withIndex("by_outbox", (q) => q.eq("outboxId", ob)).first())?.admittedAt ?? null)
    .then((x) => x ?? undefined);

/** Rows seeded directly stand for rows an EARLIER read returned: its cursor saw them
 *  (an idle read settles only runs a read could have seen — codex phase 4 pass 18). */
const cursorSaw = (t: T, chatId: Id<"chats">, lastSeq: number) =>
  t.run(async (ctx) => {
    const c = (await ctx.db.query("transcriptCursors").collect()).find((x) => x.chatId === chatId)!;
    await ctx.db.patch(c._id, { lastSeq });
  });

const get = (t: T, id: Id<"messages">) => t.run((ctx) => ctx.db.get(id));
const liveRowOf = (t: T, id: Id<"messages">) =>
  t.run((ctx) =>
    ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", id)).first(),
  );
const assistants = (t: T, chatId: Id<"chats">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter(
      (m) => m.role === "assistant",
    ),
  );

describe("a durable row replaces the live bubble (CU-18)", () => {
  test("on: same message, rows' text, live row deleted in the SAME mutation, run reported over", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "Bonj");
    const res = (await apply(
      t,
      ids.chatId,
      [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Bonjour."), said("a2", 3, "sendA", "Fin.")],
      { hasActiveRun: false, activeRunIds: [] },
    )) as { settledRuns: string[] };
    const m = await get(t, b);
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("Bonjour.\n\nFin.");
    expect(m?.finalizeCause).toBe("transcript_settled");
    expect(await liveRowOf(t, b)).toBeNull();
    expect(res.settledRuns).toEqual(["sendA"]);
    expect((await assistants(t, ids.chatId)).map((x) => x._id)).toEqual([b]);
    // The live terminal that follows is a no-op: the first terminal wins, the rows' text stays.
    const late = await t.mutation(internal.stream.finalize, {
      messageId: b,
      status: "complete",
      text: "Bonj",
    });
    expect(late.transitioned).toBe(false);
    expect((await get(t, b))?.text).toBe("Bonjour.\n\nFin.");
  });

  test("on: a run still active keeps its live bubble untouched", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "Bonj");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Bonjour.")], {
      hasActiveRun: true,
      activeRunIds: ["sendA"],
    });
    expect((await get(t, b))?.status).toBe("streaming");
    expect(await liveRowOf(t, b)).not.toBeNull();
  });

  test("on: the terminal frame alone settles it (CU-7), the idle read is not needed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "x");
    await apply(t, ids.chatId, [said("a1", 2, "sendA", "Réponse.")], {
      terminals: [terminal("sendA")],
      hasActiveRun: true,
    });
    expect((await get(t, b))?.text).toBe("Réponse.");
    expect((await get(t, b))?.status).toBe("complete");
  });

  test("on: an error terminal keeps the live card (the gateway's message is the live one)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "x");
    await apply(t, ids.chatId, [said("a1", 2, "sendA", "partiel")], {
      terminals: [terminal("sendA", "error")],
    });
    expect((await get(t, b))?.status).toBe("streaming");
  });

  test("shadow: the same reads change no bubble and store no text", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "shadow");
    const b = await liveBubble(t, ids, "sendA", "Bonj");
    const res = (await apply(t, ids.chatId, [said("a1", 2, "sendA", "Bonjour.")], {
      hasActiveRun: false,
      terminals: [terminal("sendA")],
    })) as { settledRuns: string[] };
    expect(res.settledRuns).toEqual([]);
    expect((await get(t, b))?.status).toBe("streaming");
    const stored = await t.run((ctx) =>
      ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) =>
          q.eq("chatId", ids.chatId).eq("sessionKey", SK).eq("entryId", "a1"),
        )
        .first(),
    );
    expect(stored?.textSig).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect())).toHaveLength(0);
    expect(stored?.messageId).toBeUndefined();
  });
});

describe("rows that arrive before any live frame make the bubble", () => {
  test("on: born from the rows, placed right after the row before it (CU-17)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const res = (await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "runX", "Réponse X.")], {
      terminals: [terminal("runX")],
    })) as { settledRuns: string[] };
    const [born] = await assistants(t, ids.chatId);
    const u = await get(t, ids.userMessageId);
    expect(born?.text).toBe("Réponse X.");
    expect(born?.runId).toBe("runX");
    expect(born?.status).toBe("complete");
    expect(born?.boundInstance).toBe("prod");
    expect(born?.orderTime).toBe((u!.orderTime ?? u!._creationTime) + 1);
    expect(res.settledRuns).toContain("runX");
    // A late live frame of that run opens nothing new: the same bubble comes back.
    const again = await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: "runX",
      boundInstanceName: "prod",
    });
    expect(again).toBe(born!._id);
    expect(await assistants(t, ids.chatId)).toHaveLength(1);
  });

  test("on: replaying the same read (a reset, a restart) creates nothing more", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rows = [user("u1", 1, "sendA"), said("a1", 2, "runX", "R.")];
    await apply(t, ids.chatId, rows, { terminals: [terminal("runX")] });
    await apply(t, ids.chatId, rows, { terminals: [terminal("runX")], hasActiveRun: false });
    await apply(t, ids.chatId, rows, { kind: "page" });
    expect(await assistants(t, ids.chatId)).toHaveLength(1);
  });

  test("on: a deleted bubble is never re-born by a later read", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [said("a1", 2, "runX", "R.")], { terminals: [terminal("runX")] });
    const [born] = await assistants(t, ids.chatId);
    await t.run((ctx) => ctx.db.delete(born!._id));
    await apply(t, ids.chatId, [said("a1", 2, "runX", "R."), said("a2", 3, "runX", "S.")], {
      hasActiveRun: false,
    });
    expect(await assistants(t, ids.chatId)).toHaveLength(0);
  });
});

describe("the three `on` limitations of 0.95.0", () => {
  test("1. yield + message tool + a final of its own: the delivered text is in the bubble", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    // The parent run P yielded: its bubble shows its acknowledgment.
    const b = await liveBubble(t, ids, "P", "En attente du sous-agent.");
    await apply(
      t,
      ids.chatId,
      [user("u1", 1, "sendA"), { ...said("p1", 2, "P", ""), visible: false, text: undefined, yieldAck: "En attente du sous-agent." }],
      { terminals: [terminal("P", "yielded")] },
    );
    expect((await get(t, b))?.text).toBe("En attente du sous-agent.");
    // The settle run S merged into it live (stream.reopenParentForAnnounce rotates the
    // bubble's runId and records both runs), and its live text was only its last words.
    await t.run(async (ctx) => {
      await ctx.db.patch(b, { runId: "S", text: "En attente du sous-agent.\n\nTerminé." });
      await ctx.db.insert("runBubbles", { chatId: ids.chatId, runId: "S", messageId: b, createdAt: 1 });
      await ctx.db.insert("runBubbles", { chatId: ids.chatId, runId: "P", messageId: b, createdAt: 1 });
    });
    await apply(
      t,
      ids.chatId,
      [
        // The gateway's delivery-mirror row of the `message` tool, then S's own final.
        said("s1", 5, "S", "BS_PARENT_OK"),
        said("s2", 6, "S", "Terminé."),
      ],
      { terminals: [terminal("S")], hasActiveRun: false },
    );
    expect((await get(t, b))?.text).toBe("En attente du sous-agent.\n\nBS_PARENT_OK\n\nTerminé.");
    expect(await assistants(t, ids.chatId)).toHaveLength(1);
  });

  test("2. an input whose ACK was lost: its answer gets its bubble from the rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    // B was sent, its ACK never came back, the live overlay forgot it: no bubble, no turn.
    await t.run(async (ctx) => {
      const m = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "user" as const,
        status: "complete" as const,
        text: "question B",
        sendId: "sendB",
        updatedAt: 2,
      });
      await ctx.db.insert("outbox", {
        chatId: ids.chatId,
        userId: ids.userId,
        clientMessageId: "b",
        messageId: m,
        text: "question B",
        attachmentIds: [],
        status: "sent",
        sendId: "sendB",
      });
    });
    await apply(t, ids.chatId, [user("u2", 4, "sendB"), said("b1", 5, "sendB", "BS_B_OK")], {
      hasActiveRun: false,
    });
    const answers = await assistants(t, ids.chatId);
    expect(answers.map((a) => [a.runId, a.text])).toEqual([["sendB", "BS_B_OK"]]);
  });

  test("3. a resumed bubble that repeats part of its answer is recomposed from the rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "Première partie.\n\nPremière partie.\n\nSuite.");
    await apply(
      t,
      ids.chatId,
      [said("a1", 2, "sendA", "Première partie."), said("a2", 3, "sendA", "Suite.")],
      { hasActiveRun: false },
    );
    expect((await get(t, b))?.text).toBe("Première partie.\n\nSuite.");
  });
});

describe("steered inputs and ownership", () => {
  test("on: each segment of a steered run shows its own rows (CU-20)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const s0 = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "avant après (le direct avant la coupe)",
        runId: "sendA",
        finalizeCause: "steer_segment",
        boundInstance: "prod",
        updatedAt: 2,
      }),
    );
    const s1 = await liveBubble(t, ids, "sendA", "après", { runSegment: 1 });
    await apply(
      t,
      ids.chatId,
      [
        said("a1", 2, "sendA", "avant"),
        user("u2", 3, "sendB", { steerTargetRunId: "sendA" }),
        said("a2", 4, "sendA", "après"),
      ],
      { hasActiveRun: false },
    );
    expect((await get(t, s0))?.text).toBe("avant");
    expect((await get(t, s1))?.text).toBe("après");
    expect((await get(t, s1))?.status).toBe("complete");
  });

  test("on: another instance's bubble is never settled nor rewritten from here", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "x", { boundInstance: "other" });
    await apply(t, ids.chatId, [said("a1", 2, "sendA", "Réponse.")], { hasActiveRun: false });
    expect((await get(t, b))?.status).toBe("streaming");
  });

  test("I4 on: an input whose user row the projection placed is never re-sent", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "");
    await apply(t, ids.chatId, [user("u1", 1, "sendA")], { hasActiveRun: true, activeRunIds: ["sendA"] });
    // The turn then fails with a pre-admission class: the row proves the gateway held it.
    await t.run(async (ctx) => {
      const ob = await ctx.db.query("outbox").collect();
      await ctx.db.patch(b, { dispatchOutboxId: String(ob[0]!._id) });
    });
    await t.mutation(internal.stream.finalize, {
      messageId: b,
      status: "error",
      error: "x",
      errorKind: "session_init_conflict",
    });
    const m = await get(t, b);
    expect(m?.autoRetry).toBeUndefined();
    expect(m?.autoRetryOutcome).toMatchObject({ outcome: "stood_down", reason: GATEWAY_HOLDS_INPUT_REASON });
  });
});

describe("busy is the gateway's fact on a projected chat (CU-2)", () => {
  test("on: a run active at the last read holds the chat; the idle read releases it and drains", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA")], { hasActiveRun: true, activeRunIds: ["sendA"] });
    expect(await t.run((ctx) => isChatBusy(ctx, ids.chatId, "on"))).toBe(true);
    // A send the person chose to QUEUE waits behind it.
    const queued = await t.run(async (ctx) => {
      const m = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "user" as const,
        status: "complete" as const,
        text: "plus tard",
        updatedAt: 3,
      });
      return ctx.db.insert("outbox", {
        chatId: ids.chatId,
        userId: ids.userId,
        clientMessageId: "q",
        messageId: m,
        text: "plus tard",
        attachmentIds: [],
        status: "queued",
      });
    });
    // Still held while the run works: a drain attempt promotes nothing.
    await apply(t, ids.chatId, [], { hasActiveRun: true, activeRunIds: ["sendA"] });
    expect((await t.run((ctx) => ctx.db.get(queued)))?.status).toBe("queued");
    // The idle read releases the chat and drains the queue in the same mutation.
    await apply(t, ids.chatId, [said("a1", 2, "sendA", "Fini.")], { hasActiveRun: false });
    expect((await t.run((ctx) => ctx.db.get(queued)))?.status).toBe("pending");
  });

  test("on: a stale read (past the bound) holds nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [], { hasActiveRun: true, activeRunIds: ["r"] });
    await t.run(async (ctx) => {
      const c = await ctx.db.query("transcriptCursors").collect();
      await ctx.db.patch(c[0]!._id, { updatedAt: Date.now() - SESSION_ACTIVE_FRESH_MS - 1 });
    });
    expect(await t.run((ctx) => isChatBusy(ctx, ids.chatId, "on"))).toBe(false);
  });

  test("shadow: the gateway's fact is measured, never a hold", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "shadow");
    await apply(t, ids.chatId, [], { hasActiveRun: true, activeRunIds: ["r"] });
    expect(await t.run((ctx) => isChatBusy(ctx, ids.chatId, "shadow"))).toBe(false);
    expect(await t.run((ctx) => isChatBusy(ctx, ids.chatId))).toBe(false);
  });
});

// ── Codex phase 4, pass 1 ───────────────────────────────────────────────────────────

const queueSend = (t: T, ids: { chatId: Id<"chats">; userId: Id<"users"> }, text = "plus tard") =>
  t.run(async (ctx) => {
    const m = await ctx.db.insert("messages", {
      chatId: ids.chatId,
      userId: ids.userId,
      role: "user" as const,
      status: "complete" as const,
      text,
      updatedAt: 3,
    });
    return ctx.db.insert("outbox", {
      chatId: ids.chatId,
      userId: ids.userId,
      clientMessageId: `q-${text}`,
      messageId: m,
      text,
      attachmentIds: [],
      status: "queued",
    });
  });

describe("pass 1 #1 — another instance's or session's bubble is never the run's", () => {
  test("on: a bubble of instance B with the same runId gets none of A's rows, and stays as it was", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const foreign = await liveBubble(t, ids, "sendA", "chez B", {
      boundInstance: "other",
      turnSessionKey: "agent:main:atrium:chat:u:other",
    });
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "chez A")], {
      hasActiveRun: false,
    });
    expect((await get(t, foreign))?.status).toBe("streaming");
    const rowA1 = await t.run((ctx) =>
      ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) =>
          q.eq("chatId", ids.chatId).eq("sessionKey", SK).eq("entryId", "a1"),
        )
        .first(),
    );
    expect(rowA1?.messageId).toBeDefined();
    expect(rowA1?.messageId).not.toBe(foreign);
    // A's answer has a bubble of its own (born from its rows), B's is untouched.
    const own = (await assistants(t, ids.chatId)).find((m) => m._id !== foreign);
    expect(own?.text).toBe("chez A");
  });

  test("on: a row once (wrongly) assigned to another instance's bubble never pulls more rows there", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const foreign = await liveBubble(t, ids, "zzz", "chez B", { boundInstance: "other" });
    await apply(t, ids.chatId, [said("a1", 2, "sendA", "un")], { hasActiveRun: true, activeRunIds: ["sendA"] });
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) =>
          q.eq("chatId", ids.chatId).eq("sessionKey", SK).eq("entryId", "a1"),
        )
        .first();
      await ctx.db.patch(r!._id, { messageId: foreign });
    });
    await apply(t, ids.chatId, [said("a2", 3, "sendA", "deux")], { hasActiveRun: false });
    const a2 = await t.run((ctx) =>
      ctx.db
        .query("transcriptRows")
        .withIndex("by_chat_session_entry", (q) =>
          q.eq("chatId", ids.chatId).eq("sessionKey", SK).eq("entryId", "a2"),
        )
        .first(),
    );
    expect(a2?.messageId).not.toBe(foreign);
    expect((await get(t, foreign))?.text).toBe("");
  });

  test("on: rows of another scope already assigned to a bubble are never composed into it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "en direct");
    await t.run((ctx) =>
      ctx.db.insert("transcriptRows", {
        chatId: ids.chatId,
        instanceName: "other",
        sessionKey: "agent:main:atrium:chat:u:other",
        sessionId: "s-9",
        entryId: "x1",
        seq: 3,
        role: "assistant",
        runId: "sendA",
        hidden: false,
        visible: true,
        text: "INTRUS",
        messageId: b,
        updatedAt: 1,
      }),
    );
    await apply(t, ids.chatId, [said("a1", 2, "sendA", "chez A")], { hasActiveRun: false });
    const m = await get(t, b);
    expect(m?.text).not.toContain("INTRUS");
    expect(m?.status).toBe("complete");
  });
});

describe("pass 1 #2 — a run admitted by its ACK holds the chat until it shows something", () => {
  async function admitted(t: T) {
    const ids = await seed(t, "on");
    const ob = await t.run(async (ctx) => (await ctx.db.query("outbox").collect())[0]!._id);
    await t.run((ctx) => ctx.db.patch(ob, { status: "pending" }));
    await t.mutation(internal.bridge.markOutbox, { outboxId: ob, status: "sent" });
    return { ...ids, ob };
  }

  test("on: after the ACK, with the last read idle and no bubble yet, a queued send waits", async () => {
    const t = convexTest(schema, modules);
    const ids = await admitted(t);
    expect((await admittedAt(t, ids.ob))).toBeTypeOf("number");
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    expect(await t.run((ctx) => isChatBusy(ctx, ids.chatId, "on"))).toBe(true);
    const q = await queueSend(t, ids);
    await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId: ids.chatId });
    expect((await t.run((ctx) => ctx.db.get(q)))?.status).toBe("queued");
  });

  test("on: the run's bubble opening releases the marker", async () => {
    const t = convexTest(schema, modules);
    const ids = await admitted(t);
    await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: "sendA",
      dispatchOutboxId: String(ids.ob),
      boundInstanceName: "prod",
    });
    expect((await admittedAt(t, ids.ob))).toBeUndefined();
  });

  test("on: an idle read with the send's own row persisted releases it and drains", async () => {
    const t = convexTest(schema, modules);
    const ids = await admitted(t);
    const q = await queueSend(t, ids);
    await apply(t, ids.chatId, [user("u1", 1, "sendA")], { hasActiveRun: false });
    expect((await admittedAt(t, ids.ob))).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(q)))?.status).toBe("pending");
  });

  test("shadow: no marker", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "shadow");
    const ob = await t.run(async (ctx) => (await ctx.db.query("outbox").collect())[0]!._id);
    await t.run((ctx) => ctx.db.patch(ob, { status: "pending" }));
    await t.mutation(internal.bridge.markOutbox, { outboxId: ob, status: "sent" });
    expect((await admittedAt(t, ob))).toBeUndefined();
  });
});

describe("pass 1 #3 — a settled foreground run is named again by every read", () => {
  test("on: the terminal's apply lost, the next read still reports the run over", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await liveBubble(t, ids, "sendA", "x");
    const first = (await apply(t, ids.chatId, [said("a1", 2, "sendA", "R.")], {
      terminals: [terminal("sendA")],
      foregroundRunIds: ["sendA"],
    })) as { settledRuns: string[] };
    expect(first.settledRuns).toEqual(["sendA"]);
    // Its answer never reached the bridge: the next read (no terminal any more) replays it.
    const again = (await apply(t, ids.chatId, [], { foregroundRunIds: ["sendA"] })) as {
      settledRuns: string[];
    };
    expect(again.settledRuns).toEqual(["sendA"]);
    // …a live post too, and only for the runs asked about.
    const live = (await apply(t, ids.chatId, [], { kind: "live", foregroundRunIds: ["sendA", "other"] })) as {
      settledRuns: string[];
    };
    expect(live.settledRuns).toEqual(["sendA"]);
  });
});

describe("pass 1 #4 — every run marked over is projected, however many", () => {
  test("on: 23 runs settled by one idle read all get their bubble (continuation)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rows: Row[] = [];
    for (let i = 0; i < 23; i++) rows.push(said(`a${i}`, 10 + i, `run${String(i).padStart(2, "0")}`, `R${i}`));
    await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: rows.map((r) => r.runId!) });
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const texts = (await assistants(t, ids.chatId)).map((m) => m.text).sort();
    expect(texts).toHaveLength(23);
  });
});

describe("pass 1 #5 — a queue held by a gateway fact is re-checked when the fact expires", () => {
  test("on: no read ever comes; at the hold's end the queued send leaves", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [], { hasActiveRun: true, activeRunIds: ["r"] });
    const q = await queueSend(t, ids);
    await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId: ids.chatId });
    expect((await t.run((ctx) => ctx.db.get(q)))?.status).toBe("queued");
    const armed = (await t.run((ctx) => ctx.db.get(ids.chatId)))?.projectedHoldRecheckAt;
    expect(armed).toBeTypeOf("number");
    // A second blocked drain arms nothing more (one re-check per hold).
    await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId: ids.chatId });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(
      scheduled.filter((f) => f.name.includes("projectedHoldRecheck") && f.state.kind === "pending"),
    ).toHaveLength(1);
    vi.advanceTimersByTime(SESSION_ACTIVE_FRESH_MS + 5_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(q)))?.status).not.toBe("queued");
  });
});

describe("pass 1 #6 — bubbles born together are ordered by seq, not by runId", () => {
  test("on: two consecutive answers, runIds sorting the other way, keep the transcript's order", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(
      t,
      ids.chatId,
      [user("u1", 1, "sendA"), said("a1", 2, "zzz-first", "PREMIER"), said("a2", 3, "aaa-second", "SECOND")],
      { hasActiveRun: false },
    );
    const all = await t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", ids.chatId)).collect(),
    );
    const ordered = [...all].sort(
      (a, b) => effectiveOrder(a) - effectiveOrder(b) || a._creationTime - b._creationTime,
    );
    expect(ordered.map((m) => (m.role === "user" ? "U" : m.text))).toEqual(["U", "PREMIER", "SECOND"]);
    const [p, sec] = ordered.slice(1);
    expect(effectiveOrder(p!)).toBeLessThan(effectiveOrder(sec!));
  });
});

describe("pass 1 #7 — 'the agent works' has the busy check's deadline", () => {
  test("on: an active read holds until its bound, then nothing does", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [], { hasActiveRun: true, activeRunIds: ["r"] });
    const until = await t.run((ctx) => projectedGatewayHoldUntil(ctx, ids.chatId));
    expect(until).toBeTypeOf("number");
    expect(await t.run((ctx) => projectedGatewayHoldUntil(ctx, ids.chatId, until! + 1))).toBeNull();
  });
});

// ── Codex phase 4, pass 2 ───────────────────────────────────────────────────────────

const setMode = (t: T, mode: Mode) =>
  t.run(async (ctx) => {
    const inst = (await ctx.db.query("instances").collect())[0]!;
    await ctx.db.patch(inst._id, { config: { transcriptProjection: mode } as never });
  });

describe("pass 2 #1 — a scheduled projection step re-validates instance and mode when it runs", () => {
  test("a continuation scheduled before a switch back to shadow writes nothing", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rows: Row[] = [];
    for (let i = 0; i < 23; i++) rows.push(said(`a${i}`, 10 + i, `run${String(i).padStart(2, "0")}`, `R${i}`));
    await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: rows.map((r) => r.runId!) });
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    const before = (await assistants(t, ids.chatId)).length;
    expect(before).toBe(20);
    await setMode(t, "shadow");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await assistants(t, ids.chatId)).toHaveLength(before);
  });

  test("…nor after the chat was rebound to another instance", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rows: Row[] = [];
    for (let i = 0; i < 23; i++) rows.push(said(`a${i}`, 10 + i, `run${String(i).padStart(2, "0")}`, `R${i}`));
    await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: rows.map((r) => r.runId!) });
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "other",
        gatewayUrl: "ws://gw2",
        config: { transcriptProjection: "on" } as never,
      });
      await ctx.db.patch(ids.chatId, { instanceName: "other" });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await assistants(t, ids.chatId)).toHaveLength(20);
  });
});

describe("pass 2 #2 — an idle read releases only its own instance's admitted runs", () => {
  test("instance A's idle read never releases a send B received, even with B's user row on file", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const ob = await t.run(async (ctx) => (await ctx.db.query("outbox").collect())[0]!._id);
    // The send went to instance B (per-turn routing), and B's transcript holds its user row.
    await t.run(async (ctx) => {
      await ctx.db.patch(ob, { sentToInstance: "other" });
      await admit(ctx, ob);
      await ctx.db.insert("transcriptRows", {
        chatId: ids.chatId,
        instanceName: "other",
        sessionKey: "agent:main:atrium:chat:u:other",
        sessionId: "s-b",
        entryId: "ub",
        seq: 1,
        role: "user",
        runId: "sendA",
        sendId: "sendA",
        hidden: false,
        visible: true,
        updatedAt: 1,
      });
    });
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    expect((await admittedAt(t, ob))).toBeTypeOf("number");
  });

  test("a send B received stays held even when a row of the same send id shows up in A's session", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const ob = await t.run(async (ctx) => (await ctx.db.query("outbox").collect())[0]!._id);
    await t.run(async (ctx) => {
      await ctx.db.patch(ob, { sentToInstance: "other" });
      await admit(ctx, ob);
    });
    await apply(t, ids.chatId, [user("u1", 1, "sendA")], { hasActiveRun: false });
    expect((await admittedAt(t, ob))).toBeTypeOf("number");
  });

  test("…and its own send needs its own session's row (another session's row of the same send proves nothing)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const ob = await t.run(async (ctx) => (await ctx.db.query("outbox").collect())[0]!._id);
    await t.run(async (ctx) => {
      await admit(ctx, ob);
      await ctx.db.insert("transcriptRows", {
        chatId: ids.chatId,
        instanceName: "prod",
        sessionKey: "agent:main:atrium:chat:u:elsewhere",
        sessionId: "s-x",
        entryId: "ux",
        seq: 1,
        role: "user",
        runId: "sendA",
        sendId: "sendA",
        hidden: false,
        visible: true,
        updatedAt: 1,
      });
    });
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    expect((await admittedAt(t, ob))).toBeTypeOf("number");
    await apply(t, ids.chatId, [user("u1", 1, "sendA")], { hasActiveRun: false });
    expect((await admittedAt(t, ob))).toBeUndefined();
  });
});

describe("pass 2 #4 — the projection stays within Convex's transaction limits", () => {
  async function bigRuns(t: T, ids: { chatId: Id<"chats"> }, runs: number, rowsPerRun: number) {
    const big = "x".repeat(32_700);
    let seq = 10;
    for (let r = 0; r < runs; r++) {
      const runId = `big${String(r).padStart(2, "0")}`;
      await t.run(async (ctx) => {
        for (let i = 0; i < rowsPerRun; i++) {
          await insertRowWithText(ctx, {
            chatId: ids.chatId,
            instanceName: "prod",
            sessionKey: SK,
            sessionId: "s-1",
            entryId: `${runId}-${i}`,
            seq: seq++,
            role: "assistant",
            runId,
            hidden: false,
            visible: true,
            updatedAt: 1,
          }, big);
        }
        await ctx.db.insert("transcriptRuns", {
          chatId: ids.chatId,
          sessionKey: SK,
          runId,
          status: "persisted",
          firstSeq: seq - rowsPerRun,
          lastSeq: seq - 1,
          updatedAt: 1,
        });
      });
    }
    await cursorSaw(t, ids.chatId, seq - 1);
  }

  test("20 runs × 28 rows × 32 700 chars: the idle read commits (no 16 MiB rollback)", async () => {
    vi.useFakeTimers();
    // Convex's real per-transaction limits, enforced (16 MiB read / written, …).
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await bigRuns(t, ids, 20, 28);
    const res = (await apply(t, ids.chatId, [], { hasActiveRun: false })) as { ok: boolean };
    expect(res.ok).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Every run is settled; a composition over the document bound keeps no bubble born.
    const open = await t.run(async (ctx) =>
      (await ctx.db.query("transcriptRuns").collect()).filter((r) => r.settledAt === undefined),
    );
    expect(open).toHaveLength(0);
  });

  test("20 runs × 18 rows × 32 700 chars: every bubble is born, across bounded continuations", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await bigRuns(t, ids, 20, 18);
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    expect((await assistants(t, ids.chatId)).length).toBeLessThan(20);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await assistants(t, ids.chatId)).toHaveLength(20);
  });
});

describe("pass 2 #5 — one pending hold re-check per chat, however many reads move the hold", () => {
  test("100 active reads and blocked drains arm one re-check", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await queueSend(t, ids);
    for (let i = 0; i < 100; i++) {
      await apply(t, ids.chatId, [], { hasActiveRun: true, activeRunIds: ["r"] });
      await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId: ids.chatId });
    }
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => f.name.includes("projectedHoldRecheck") && f.state.kind === "pending",
      ),
    );
    expect(pending).toHaveLength(1);
  });
});

describe("pass 2 #6 — an ACK slower than the whole run holds nothing", () => {
  test("the run settled and its bubble born from rows before the ACK: no admission marker", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const ob = await t.run(async (ctx) => (await ctx.db.query("outbox").collect())[0]!._id);
    await t.run((ctx) => ctx.db.patch(ob, { status: "pending" }));
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Déjà fini.")], {
      terminals: [terminal("sendA")],
    });
    await t.mutation(internal.bridge.markOutbox, { outboxId: ob, status: "sent" });
    expect((await admittedAt(t, ob))).toBeUndefined();
    expect(await t.run((ctx) => isChatBusy(ctx, ids.chatId, "on"))).toBe(false);
  });

  test("a silent run already over (settled, no bubble): no marker either", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const ob = await t.run(async (ctx) => (await ctx.db.query("outbox").collect())[0]!._id);
    await t.run((ctx) => ctx.db.patch(ob, { status: "pending" }));
    await apply(t, ids.chatId, [said("a1", 2, "sendA", "NO_REPLY", { hidden: true })], {
      terminals: [terminal("sendA")],
    });
    expect(await assistants(t, ids.chatId)).toHaveLength(0);
    await t.mutation(internal.bridge.markOutbox, { outboxId: ob, status: "sent" });
    expect((await admittedAt(t, ob))).toBeUndefined();
  });
});

describe("pass 2 #7 — an idle read marks every open run, beyond one mutation's bound", () => {
  test("60 open runs: all settled by the read and its continuation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rows: Row[] = [];
    for (let i = 0; i < 60; i++) rows.push(said(`a${i}`, 10 + i, `open${String(i).padStart(2, "0")}`, "", { visible: false, text: undefined }));
    for (let k = 0; k < 60; k += 30) {
      await apply(t, ids.chatId, rows.slice(k, k + 30), { hasActiveRun: true });
    }
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const open = await t.run(async (ctx) =>
      (await ctx.db.query("transcriptRuns").collect()).filter((r) => r.settledAt === undefined),
    );
    expect(open).toHaveLength(0);
  });

  test("…but a newer read (active again) stops the continuation", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rows: Row[] = [];
    for (let i = 0; i < 60; i++) rows.push(said(`a${i}`, 10 + i, `open${String(i).padStart(2, "0")}`, "", { visible: false, text: undefined }));
    for (let k = 0; k < 60; k += 30) {
      await apply(t, ids.chatId, rows.slice(k, k + 30), { hasActiveRun: true });
    }
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    const afterIdle = await t.run(async (ctx) =>
      (await ctx.db.query("transcriptRuns").collect()).filter((r) => r.settledAt === undefined).length,
    );
    expect(afterIdle).toBe(10);
    await apply(t, ids.chatId, [], { hasActiveRun: true, activeRunIds: ["x"] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const open = await t.run(async (ctx) =>
      (await ctx.db.query("transcriptRuns").collect()).filter((r) => r.settledAt === undefined && r.runId.startsWith("open")),
    );
    expect(open).toHaveLength(10);
  });
});

describe("pass 2 #8 — a late live frame of a settled SEGMENT lands on that segment", () => {
  test("startAssistant(runSegment 1) returns segment 1's settled bubble, never segment 0's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(
      t,
      ids.chatId,
      [said("a1", 2, "sendA", "avant"), user("u2", 3, "sendB", { steerTargetRunId: "sendA" }), said("a2", 4, "sendA", "après")],
      { hasActiveRun: false },
    );
    const bubbles = await assistants(t, ids.chatId);
    const seg1 = bubbles.find((b) => b.runSegment === 1)!;
    const seg0 = bubbles.find((b) => b.runSegment === undefined)!;
    expect(seg0.text).toBe("avant");
    const back1 = await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: "sendA",
      runSegment: 1,
      boundInstanceName: "prod",
    });
    expect(back1).toBe(seg1._id);
    const back0 = await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: "sendA",
      boundInstanceName: "prod",
    });
    expect(back0).toBe(seg0._id);
  });
});

describe("pass 2 — a truncated active-run list is not a complete one", () => {
  test("on: more active runs than the list carries never settles the ones cut off", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rows: Row[] = [];
    for (let i = 0; i < 60; i++) rows.push(said(`a${i}`, 10 + i, `open${String(i).padStart(2, "0")}`, "", { visible: false, text: undefined }));
    await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: rows.map((r) => r.runId!) });
    const open = await t.run(async (ctx) =>
      (await ctx.db.query("transcriptRuns").collect()).filter((r) => r.settledAt === undefined),
    );
    expect(open).toHaveLength(60);
  });
});

// ── Codex phase 4, pass 3 ───────────────────────────────────────────────────────────

const admittedSend = async (t: T) => {
  const ids = await seed(t, "on");
  const ob = await t.run(async (ctx) => (await ctx.db.query("outbox").collect())[0]!._id);
  await t.run((ctx) => ctx.db.patch(ob, { status: "pending" }));
  // The ACK: the run is admitted, and the drain that runs with it finds no queue yet.
  await t.mutation(internal.bridge.markOutbox, { outboxId: ob, status: "sent" });
  return { ...ids, ob };
};

const pendingRechecks = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (f) => f.name.includes("projectedHoldRecheck") && f.state.kind === "pending",
    ),
  );

describe("pass 3 #1 — a send parked behind a projected hold is re-checked, whatever happens next", () => {
  test("on: the send queued after the ACK arms the re-check in its own transaction; it leaves at the hold's end", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await admittedSend(t);
    expect(await pendingRechecks(t)).toHaveLength(0);
    const asUser = t.withIdentity({ subject: `${ids.userId}|session` });
    const { outboxId } = await asUser.mutation(api.send.sendMessage, {
      chatId: ids.chatId,
      text: "ensuite",
      clientMessageId: "b",
      followUpMode: "queue",
    });
    expect((await t.run((ctx) => ctx.db.get(outboxId)))?.status).toBe("queued");
    // The bridge then goes away: no bubble, no read, no terminal. Only the re-check is left.
    expect(await pendingRechecks(t)).toHaveLength(1);
    vi.advanceTimersByTime(SESSION_ACTIVE_FRESH_MS + 5_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(outboxId)))?.status).not.toBe("queued");
    expect(await t.run((ctx) => isChatBusy(ctx, ids.chatId, "on"))).toBe(false);
  });

  test("shadow: a parked send arms nothing (the legacy turn-end drains own it)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "shadow");
    await liveBubble(t, ids, "sendA", "en cours");
    const asUser = t.withIdentity({ subject: `${ids.userId}|session` });
    await asUser.mutation(api.send.sendMessage, { chatId: ids.chatId, text: "ensuite", clientMessageId: "b" });
    expect(await pendingRechecks(t)).toHaveLength(0);
  });

  test("rolled back to shadow before it runs: the re-check runs the LEGACY drain (the queue leaves), and never re-arms", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [], { hasActiveRun: true, activeRunIds: ["r"] });
    const q = await queueSend(t, ids);
    await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId: ids.chatId });
    expect(await pendingRechecks(t)).toHaveLength(1);
    await setMode(t, "shadow");
    vi.advanceTimersByTime(SESSION_ACTIVE_FRESH_MS + 5_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Legacy-idle (no turn streams): the queued send was dispatched by the legacy rules.
    expect((await t.run((ctx) => ctx.db.get(q)))?.status).not.toBe("queued");
    expect(await pendingRechecks(t)).toHaveLength(0);
    const chat = await t.run((ctx) => ctx.db.get(ids.chatId));
    expect(chat?.projectedHoldRecheckId).toBeUndefined();
  });

  test("…and a legacy turn streaming at that moment keeps the queue for its own finalize", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [], { hasActiveRun: true, activeRunIds: ["r"] });
    const q = await queueSend(t, ids);
    await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId: ids.chatId });
    await setMode(t, "shadow");
    await liveBubble(t, ids, "sendA", "en cours");
    vi.advanceTimersByTime(SESSION_ACTIVE_FRESH_MS + 5_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(q)))?.status).toBe("queued");
    expect(await pendingRechecks(t)).toHaveLength(0);
  });
});

const CJK = "漢".repeat(32_700);

describe("pass 3 #2 — a row's text never rides on its identity", () => {
  async function bigRowsWrittenInOn(t: T, ids: { chatId: Id<"chats"> }, n: number) {
    for (let k = 0; k < n; k += 20) {
      await t.run(async (ctx) => {
        for (let i = k; i < Math.min(n, k + 20); i++) {
          await insertRowWithText(
            ctx,
            {
              chatId: ids.chatId,
              instanceName: "prod",
              sessionKey: SK,
              sessionId: "s-1",
              entryId: `big-${i}`,
              seq: 10 + i,
              role: "assistant",
              runId: "bigRun",
              hidden: false,
              visible: true,
              updatedAt: 1,
            },
            CJK,
          );
        }
      });
    }
  }
  const replay = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => said(`big-${i}`, 10 + i, "bigRun", "", { text: undefined }));

  test("200 rows of 32 700 CJK chars written in `on`, replayed in shadow: the read commits under the real limits", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await bigRowsWrittenInOn(t, ids, 200);
    await setMode(t, "shadow");
    const res = (await apply(t, ids.chatId, replay(200), { kind: "page" })) as { ok: boolean };
    expect(res.ok).toBe(true);
    // Nothing of what the rows say was lost by the identity replay.
    const rows = await t.run((ctx) => ctx.db.query("transcriptRows").collect());
    expect(rows.filter((r) => r.textSig === rowTextSignature(CJK, undefined))).toHaveLength(200);
  });

  test("on: one apply carrying 200 rows of that text is REFUSED whole (too_large), nothing written", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const rows = Array.from({ length: 200 }, (_, i) => said(`n-${i}`, 10 + i, "newRun", CJK));
    const res = (await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: ["newRun"] })) as {
      ok: boolean;
      reason?: string;
    };
    expect(res).toMatchObject({ ok: false, reason: "too_large" });
    expect(await t.run((ctx) => ctx.db.query("transcriptRows").collect())).toHaveLength(0);
  });

  test("on: a read that carries only the acknowledgment keeps the text read before (and the reverse)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [said("p1", 2, "P", "Texte.")], { hasActiveRun: true, activeRunIds: ["P"] });
    await apply(t, ids.chatId, [said("p1", 2, "P", "", { text: undefined, yieldAck: "Ack." })], {
      hasActiveRun: true,
      activeRunIds: ["P"],
    });
    const [doc] = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
    expect(doc).toMatchObject({ text: "Texte.", yieldAck: "Ack." });
    const row = await t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).find((r) => r.entryId === "p1"));
    expect(row?.textSig).toBe(rowTextSignature("Texte.", "Ack."));
  });

  test("the migration moves a pre-split row's text into its own document", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rowId = await t.run((ctx) =>
      ctx.db.insert("transcriptRows", {
        chatId: ids.chatId,
        instanceName: "prod",
        sessionKey: SK,
        sessionId: "s-1",
        entryId: "old",
        seq: 5,
        role: "assistant",
        runId: "R",
        hidden: false,
        visible: true,
        text: "ancien",
        updatedAt: 1,
      }),
    );
    await t.mutation(internal.migrations.moveTranscriptRowTexts, {});
    const row = await t.run((ctx) => ctx.db.get(rowId));
    expect(row?.text).toBeUndefined();
    expect(row?.textSig).toBe(rowTextSignature("ancien", undefined));
    const [doc] = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
    expect(doc).toMatchObject({ rowId, text: "ancien" });
  });

  test("the chat purge deletes the row texts", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [said("p1", 2, "P", "Texte.")], { hasActiveRun: true, activeRunIds: ["P"] });
    await t.run((ctx) => cascadeDeleteChat(ctx, ids.chatId, { inline: false }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect())).toHaveLength(0);
  });
});

describe("pass 3 #3 — every read of a projection is charged, a run's segments paginated", () => {
  test("34 steer segments, each with a 500 KB live bubble: every read commits under the real limits and every segment settles", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const SEGMENTS = 34;
    const big = "x".repeat(500_000);
    const bubbles: Id<"messages">[] = [];
    for (let k = 0; k < SEGMENTS; k++) {
      bubbles.push(await liveBubble(t, ids, "R", "…", { text: big, ...(k > 0 ? { runSegment: k } : {}) }));
    }
    const rows: Row[] = [];
    for (let k = 0; k < SEGMENTS; k++) {
      rows.push(said(`a${k}`, 2 + 2 * k, "R", `partie ${k}`));
      if (k < SEGMENTS - 1) rows.push(user(`s${k}`, 3 + 2 * k, `steer${k}`, { steerTargetRunId: "R" }));
    }
    const first = (await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: ["R"] })) as { ok: boolean };
    expect(first.ok).toBe(true);
    const idle = (await apply(t, ids.chatId, [], { hasActiveRun: false })) as { ok: boolean };
    expect(idle.ok).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (let k = 0; k < SEGMENTS; k++) {
      const m = await get(t, bubbles[k]!);
      expect(m?.status).toBe("complete");
      expect(m?.text).toBe(`partie ${k}`);
    }
  });
});

describe("pass 3 #3 (bis) — settled bubbles too: their reads are charged, not only a settle's reserve", () => {
  test("34 segments whose 500 KB bubbles are already complete: the recomposing read commits, every one rewritten", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const SEGMENTS = 34;
    const big = "y".repeat(500_000);
    const bubbles: Id<"messages">[] = [];
    for (let k = 0; k < SEGMENTS; k++) {
      bubbles.push(
        await t.run((ctx) =>
          ctx.db.insert("messages", {
            chatId: ids.chatId,
            userId: ids.userId,
            role: "assistant" as const,
            status: "complete" as const,
            text: big,
            runId: "R",
            ...(k > 0 ? { runSegment: k } : {}),
            turnSessionKey: SK,
            boundInstance: "prod",
            updatedAt: 1,
          }),
        ),
      );
    }
    const rows: Row[] = [];
    for (let k = 0; k < SEGMENTS; k++) {
      rows.push(said(`a${k}`, 2 + 2 * k, "R", `partie ${k}`));
      if (k < SEGMENTS - 1) rows.push(user(`s${k}`, 3 + 2 * k, `steer${k}`, { steerTargetRunId: "R" }));
    }
    await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: ["R"] });
    const idle = (await apply(t, ids.chatId, [], { hasActiveRun: false })) as { ok: boolean };
    expect(idle.ok).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (let k = 0; k < SEGMENTS; k++) expect((await get(t, bubbles[k]!))?.text).toBe(`partie ${k}`);
  });
});

describe("pass 3 #6 (bis) — a read's runs are projected in transcript order, whatever order it named them in", () => {
  test("25 runs named last-first: the first call projects the 20 EARLIEST, the continuation the rest", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rows: Row[] = [];
    for (let i = 24; i >= 0; i--) rows.push(said(`r${i}`, 10 + i, `run${String(i).padStart(2, "0")}`, `R${i}`));
    await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: rows.map((r) => r.runId!) });
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    const first = (await assistants(t, ids.chatId)).map((m) => Number(m.text.slice(1))).sort((a, b) => a - b);
    expect(first).toEqual(Array.from({ length: 20 }, (_, i) => i));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await assistants(t, ids.chatId)).toHaveLength(25);
  });
});

const CHILD_KEY = "agent:files:subagent:9af5b6c1-d161-4994-a5df-6e256c5b4336";
const ANNOUNCE_RUN = `announce:v1:${CHILD_KEY}:650150d5-fa3d-4c7c-825c-e6684997f82d`;

describe("pass 3 #4 — a delivery the user stopped makes no bubble from its rows either", () => {
  async function stoppedChild(t: T, ids: { chatId: Id<"chats"> }, createdAt: number) {
    await t.run(async (ctx) => {
      await ctx.db.insert("subAgents", {
        chatId: ids.chatId,
        childSessionKey: CHILD_KEY,
        status: "aborted" as const,
        createdAt,
        updatedAt: createdAt,
      });
    });
  }

  test("on: the child started before the Stop — startAssistant refuses it, and so does the projection", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await stoppedChild(t, ids, 1500);
    await t.run((ctx) => ctx.db.patch(ids.chatId, { stoppedAt: Date.now() }));
    const landed = await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: ANNOUNCE_RUN,
      boundInstanceName: "prod",
    });
    expect(landed).toBeNull();
    await apply(t, ids.chatId, [said("x1", 2, ANNOUNCE_RUN, "RÉSULTAT REFUSÉ")], {
      terminals: [terminal(ANNOUNCE_RUN)],
      hasActiveRun: false,
    });
    expect(await assistants(t, ids.chatId)).toHaveLength(0);
  });

  test("on: a child spawned AFTER the Stop still delivers (the epoch never mutes the next turn)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await t.run((ctx) => ctx.db.patch(ids.chatId, { stoppedAt: 1000 }));
    await stoppedChild(t, ids, 5000);
    await apply(t, ids.chatId, [said("x1", 2, ANNOUNCE_RUN, "RÉSULTAT")], {
      terminals: [terminal(ANNOUNCE_RUN)],
      hasActiveRun: false,
    });
    expect((await assistants(t, ids.chatId)).map((m) => m.text)).toEqual(["RÉSULTAT"]);
  });
});

describe("pass 3 #5 — an input the gateway cancelled or dropped releases its admission", () => {
  test("on: cancelled before it ran — no run, no user row — the chat is free and the queue leaves", async () => {
    const t = convexTest(schema, modules);
    const ids = await admittedSend(t);
    const q = await queueSend(t, ids);
    await apply(t, ids.chatId, [], {
      hasActiveRun: false,
      pendingInputs: { total: 1, complete: true, items: [{ runId: "sendA", state: "cancelled" }] },
    });
    expect((await admittedAt(t, ids.ob))).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(q)))?.status).toBe("pending");
  });

  test("on: dropped — asked after its ACK, never held — on an idle session", async () => {
    const t = convexTest(schema, modules);
    const ids = await admittedSend(t);
    await apply(t, ids.chatId, [], { hasActiveRun: false, inputRunIds: ["sendA"], inputAbsent: ["sendA"] });
    expect((await admittedAt(t, ids.ob))).toBeUndefined();
  });

  test("…but an input the gateway HELD and still queues keeps the chat busy", async () => {
    const t = convexTest(schema, modules);
    const ids = await admittedSend(t);
    await apply(t, ids.chatId, [], {
      hasActiveRun: false,
      pendingInputs: { total: 1, complete: true, items: [{ runId: "sendA", state: "queued" }] },
    });
    expect((await admittedAt(t, ids.ob))).toBeTypeOf("number");
  });

  test("…nor does another session's cancellation of the same send id", async () => {
    const t = convexTest(schema, modules);
    const ids = await admittedSend(t);
    await t.run((ctx) =>
      ctx.db.insert("transcriptInputs", {
        chatId: ids.chatId,
        sessionKey: "agent:main:atrium:chat:u:elsewhere",
        sendId: "sendA",
        pendingState: "cancelled",
        updatedAt: 1,
      }),
    );
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    expect((await admittedAt(t, ids.ob))).toBeTypeOf("number");
  });
});

describe("pass 3 #6 — bubbles born from rows take their transcript place, across runs and calls", () => {
  const thread = async (t: T, ids: { chatId: Id<"chats">; userId: Id<"users"> }) => {
    const view = await t
      .withIdentity({ subject: `${ids.userId}|session` })
      .query(api.messages.listByChat, { chatId: ids.chatId as string });
    return view.map((m: { role: string; text: string }) => (m.role === "user" ? "U" : m.text));
  };

  test("one idle read settles two runs named second-then-first: the thread shows them in seq order", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("s1", 3, "second", "SECOND"), said("f1", 2, "first", "FIRST")], {
      hasActiveRun: true,
      activeRunIds: ["second", "first"],
    });
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    expect(await thread(t, ids)).toEqual(["U", "FIRST", "SECOND"]);
  });

  test("the later run's bubble born first, the earlier one's in a later read: placed between its neighbours", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("f1", 2, "first", "FIRST"), said("s1", 3, "second", "SECOND")], {
      hasActiveRun: true,
      activeRunIds: ["first", "second"],
      terminals: [terminal("second")],
    });
    expect(await thread(t, ids)).toEqual(["U", "SECOND"]);
    await apply(t, ids.chatId, [], { terminals: [terminal("first")], hasActiveRun: false });
    expect(await thread(t, ids)).toEqual(["U", "FIRST", "SECOND"]);
  });
});

// ── Codex phase 4, pass 4 ───────────────────────────────────────────────────────────

const rowsOf = (t: T, chatId: Id<"chats">) =>
  t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).filter((r) => r.chatId === chatId));
const textCount = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query("transcriptRowTexts").collect()).length);

describe("pass 4 #1 — what a deleted answer said goes with it, and never comes back", () => {
  async function bornAndDeleted(t: T) {
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse secrète.")], {
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    const [bubble] = await assistants(t, ids.chatId);
    expect(bubble?.text).toBe("Réponse secrète.");
    expect(await textCount(t)).toBe(1);
    await t
      .withIdentity({ subject: `${ids.userId}|session` })
      .mutation(api.messages.deleteMessage, { messageId: bubble!._id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return { ...ids, bubbleId: bubble!._id };
  }

  test("on: deleting the answer purges its rows' texts; the identities stay as tombstones", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await bornAndDeleted(t);
    expect(await textCount(t)).toBe(0);
    const a1 = (await rowsOf(t, ids.chatId)).find((r) => r.entryId === "a1");
    expect(a1?.messageId).toBe(ids.bubbleId);
    expect(a1?.textSig).toBe(TEXT_PURGED_SIG);
  });

  test("on: a later read carrying the same rows stores no text again and re-births nothing", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await bornAndDeleted(t);
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse secrète.")], {
      kind: "page",
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    // (the deletion's own gateway realignment may leave a card of its own: only the run's count)
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA")).toHaveLength(0);
  });

  test("on: a row of the deleted answer's segment arriving afterwards is tombstoned, its text not kept", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await bornAndDeleted(t);
    await apply(t, ids.chatId, [said("a2", 3, "sendA", "Suite secrète.")], { kind: "live" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    const a2 = (await rowsOf(t, ids.chatId)).find((r) => r.entryId === "a2");
    expect(a2?.messageId).toBe(ids.bubbleId);
    expect(a2?.textSig).toBe(TEXT_PURGED_SIG);
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA")).toHaveLength(0);
  });

  test("a service conversation's sweep purges its rows' texts (indexed under the service chat)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const hidden = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: ids.userId, updatedAt: 1, kind: "summarizer" as const, instanceName: "prod", agentId: "main", transcriptSeenAt: 1 }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await insertRowWithText(
          ctx,
          {
            chatId: hidden,
            instanceName: "prod",
            sessionKey: "agent:main:summarizer",
            sessionId: "s-h",
            entryId: `h${i}`,
            seq: 1 + i,
            role: "assistant",
            runId: "sum",
            hidden: false,
            visible: true,
            updatedAt: 1,
          },
          `résumé ${i}`,
        );
      }
    });
    vi.useFakeTimers();
    await t.mutation(internal.chatSummaries.sweepHiddenChat, { hiddenChatId: hidden });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    expect((await rowsOf(t, hidden)).every((r) => r.textSig === TEXT_PURGED_SIG)).toBe(true);
  });
});

describe("pass 4 #2 → pass 6 — a read's texts reach Convex in chunks it can persist, before the read", () => {
  test("on: 100 rows of 32 700 CJK chars over 20 runs, posted texts-only in chunks, then an empty idle read: all 20 bubbles, whole", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const rows: Row[] = [];
    const runs: string[] = [];
    for (let r = 0; r < 20; r++) {
      const runId = `cjk${String(r).padStart(2, "0")}`;
      runs.push(runId);
      for (let i = 0; i < 5; i++) rows.push(said(`${runId}-${i}`, 10 + r * 5 + i, runId, CJK));
    }
    await postTextsInChunks(t, ids.chatId, rows);
    const res = (await apply(t, ids.chatId, rows.map(identityOnly), { hasActiveRun: true, activeRunIds: runs })) as { ok: boolean };
    expect(res.ok).toBe(true);
    const idle = (await apply(t, ids.chatId, [], { hasActiveRun: false })) as { ok: boolean };
    expect(idle.ok).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const bubbles = await t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", ids.chatId)).collect())
        .filter((m) => m.role === "assistant")
        .map((m) => m.text.length),
    );
    expect(bubbles).toHaveLength(20);
    for (const len of bubbles) expect(len).toBe(5 * CJK.length + 4 * 2);
  });
});
describe("pass 4 #3 — a stopped delivery gets no bubble back, not even its settled one", () => {
  test("on: the announce's aborted bubble, its run settled after the Stop: a replay gets null", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await t.run(async (ctx) => {
      await ctx.db.insert("subAgents", {
        chatId: ids.chatId,
        childSessionKey: CHILD_KEY,
        status: "aborted" as const,
        createdAt: 1500,
        updatedAt: 1500,
      });
      await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "aborted" as const,
        text: "partiel",
        runId: ANNOUNCE_RUN,
        turnSessionKey: SK,
        boundInstance: "prod",
        updatedAt: 2000,
      });
      await ctx.db.patch(ids.chatId, { stoppedAt: Date.now() });
      await ctx.db.insert("transcriptRuns", {
        chatId: ids.chatId,
        sessionKey: SK,
        runId: ANNOUNCE_RUN,
        status: "aborted",
        settledAt: Date.now() + 1,
        updatedAt: Date.now() + 1,
      });
    });
    const landed = await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: ANNOUNCE_RUN,
      turnSessionKey: SK,
      boundInstanceName: "prod",
    });
    expect(landed).toBeNull();
  });
});

describe("pass 4 #4 — every stored text a read loads is charged, reserved before it is read", () => {
  async function storedCjk(t: T, ids: { chatId: Id<"chats"> }, n: number, ack?: string) {
    for (let k = 0; k < n; k += 20) {
      await t.run(async (ctx) => {
        for (let i = k; i < Math.min(n, k + 20); i++) {
          const rowId = await ctx.db.insert("transcriptRows", {
            chatId: ids.chatId,
            instanceName: "prod",
            sessionKey: SK,
            sessionId: "s-1",
            entryId: `c-${i}`,
            seq: 10 + i,
            role: "assistant",
            runId: "cjkRun",
            hidden: false,
            visible: true,
            textSig: rowTextSignature(CJK, ack),
            updatedAt: 1,
          });
          await ctx.db.insert("transcriptRowTexts", {
            chatId: ids.chatId,
            rowId,
            text: CJK,
            ...(ack !== undefined ? { yieldAck: ack } : {}),
            updatedAt: 1,
          });
        }
      });
    }
  }

  test("on: 100 stored CJK texts, each re-read with a new text: the read commits; every text ends up new", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await storedCjk(t, ids, 100, "ack");
    const changed = "字".repeat(32_700);
    const rows = Array.from({ length: 100 }, (_, i) => said(`c-${i}`, 10 + i, "cjkRun", changed));
    await postTextsInChunks(t, ids.chatId, rows, 12);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sigs = (await rowsOf(t, ids.chatId)).filter((r) => r.entryId.startsWith("c-")).map((r) => r.textSig);
    expect(sigs.every((s) => s === rowTextSignature(changed, "ack"))).toBe(true);
  });

  test("on: a re-read that only drops the acknowledgment (merge ends unchanged) is charged too", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await storedCjk(t, ids, 200, "ack");
    const rows = Array.from({ length: 200 }, (_, i) => said(`c-${i}`, 10 + i, "cjkRun", CJK));
    await postTextsInChunks(t, ids.chatId, rows, 12);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const sigs = (await rowsOf(t, ids.chatId)).filter((r) => r.entryId.startsWith("c-")).map((r) => r.textSig);
    expect(sigs.every((s) => s === rowTextSignature(CJK, "ack"))).toBe(true);
  });
});

// ── Codex phase 4, pass 5 ───────────────────────────────────────────────────────────

describe("pass 5 #1 — a bubble deleted before its rows were projected: its segment is tombstoned", () => {
  async function deletedBeforeProjection(t: T) {
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "Secr");
    // Its row arrives while the run streams: text stored, no bubble assigned yet.
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Secret entier.")], {
      hasActiveRun: true,
      activeRunIds: ["sendA"],
    });
    expect(await textCount(t)).toBe(1);
    // The live terminal, then the person deletes the answer — before any read projects it.
    await t.mutation(internal.stream.finalize, { messageId: b, status: "complete", text: "Secret entier." });
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: b });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return { ...ids, b };
  }

  test("on: the unassigned row's text is purged, its identity tombstoned to the deleted bubble", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await deletedBeforeProjection(t);
    expect(await textCount(t)).toBe(0);
    const a1 = (await rowsOf(t, ids.chatId)).find((r) => r.entryId === "a1");
    expect(a1?.textSig).toBe(TEXT_PURGED_SIG);
    expect(a1?.messageId).toBe(ids.b);
  });

  test("on: the read that settles the run afterwards recreates nothing and stores nothing", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await deletedBeforeProjection(t);
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Secret entier."), said("a2", 3, "sendA", "Suite.")], {
      kind: "page",
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA")).toHaveLength(0);
  });

  test("…and after a rollback to shadow the text is gone too (it was purged in `on`)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await deletedBeforeProjection(t);
    await setMode(t, "shadow");
    expect(await textCount(t)).toBe(0);
  });
});

describe("pass 5 #1 (bis) — deleted before ANY of its rows was read", () => {
  async function deletedBeforeAnyRow(t: T) {
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "Secret");
    await t.mutation(internal.stream.finalize, { messageId: b, status: "complete", text: "Secret entier." });
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: b });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return { ...ids, b };
  }

  test("on: its rows, read afterwards while the run is still active, never store their text", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await deletedBeforeAnyRow(t);
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Secret entier.")], {
      hasActiveRun: true,
      activeRunIds: ["sendA"],
    });
    expect(await textCount(t)).toBe(0);
  });

  test("on: …nor, once the run is over, make the deleted answer again", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await deletedBeforeAnyRow(t);
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Secret entier.")], {
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA")).toHaveLength(0);
    const a1 = (await rowsOf(t, ids.chatId)).find((r) => r.entryId === "a1");
    expect(a1?.messageId).toBe(ids.b);
  });
});

describe("pass 5 #4 — the projection stays under Convex's index-query limit", () => {
  test("14 runs × 300 short rows (4 200 text lookups): every idle read commits (4 096 ranges), every bubble is born", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const runs: string[] = [];
    for (let r = 0; r < 14; r++) {
      const runId = `q${String(r).padStart(2, "0")}`;
      runs.push(runId);
      await t.run(async (ctx) => {
        for (let i = 0; i < 300; i++) {
          await insertRowWithText(
            ctx,
            {
              chatId: ids.chatId,
              instanceName: "prod",
              sessionKey: SK,
              sessionId: "s-1",
              entryId: `${runId}-${i}`,
              seq: 10 + r * 300 + i,
              role: "assistant",
              runId,
              hidden: false,
              visible: true,
              updatedAt: 1,
            },
            "x",
          );
        }
        await ctx.db.insert("transcriptRuns", {
          chatId: ids.chatId,
          sessionKey: SK,
          runId,
          status: "persisted",
          firstSeq: 10 + r * 300,
          lastSeq: 10 + r * 300 + 299,
          updatedAt: 1,
        });
      });
    }
    await cursorSaw(t, ids.chatId, 10 + 14 * 300);
    const idle = (await apply(t, ids.chatId, [], { hasActiveRun: false })) as { ok: boolean };
    expect(idle.ok).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const born = (await assistants(t, ids.chatId)).map((m) => m.runId).sort();
    expect(born).toEqual(runs);
  }, 120_000);
});

// ── Codex phase 4, pass 6 ───────────────────────────────────────────────────────────

const docsOfRow = (t: T, entryId: string) =>
  t.run(async (ctx) => {
    const row = (await ctx.db.query("transcriptRows").collect()).find((r) => r.entryId === entryId);
    if (row === undefined) return [];
    return ctx.db.query("transcriptRowTexts").withIndex("by_row", (q) => q.eq("rowId", row._id)).collect();
  });

describe("pass 6 B — exactly one text document per row, and a purge that deletes them all", () => {
  test("on: the same row twice in one apply (no text known yet): one document, the last text", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [said("a1", 2, "R", "premier"), said("a1", 2, "R", "second")], {
      kind: "live",
      textsOnly: true,
    });
    const docs = await docsOfRow(t, "a1");
    expect(docs.map((d) => d.text)).toEqual(["second"]);
  });

  test("on: five posts of the same row: still one document", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    for (let i = 0; i < 5; i++) {
      await apply(t, ids.chatId, [said("a1", 2, "R", `version ${i}`)], { kind: "live", textsOnly: true });
    }
    expect((await docsOfRow(t, "a1")).map((d) => d.text)).toEqual(["version 4"]);
  });

  test("a row already marked purged that still holds copies loses them all at the next purge", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "x",
        runId: "R",
        turnSessionKey: SK,
        boundInstance: "prod",
        updatedAt: 1,
      }),
    );
    await t.run(async (ctx) => {
      const rowId = await ctx.db.insert("transcriptRows", {
        chatId: ids.chatId,
        instanceName: "prod",
        sessionKey: SK,
        sessionId: "s-1",
        entryId: "a1",
        seq: 2,
        role: "assistant",
        runId: "R",
        hidden: false,
        visible: true,
        messageId: b,
        textSig: TEXT_PURGED_SIG,
        updatedAt: 1,
      });
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("transcriptRowTexts", { chatId: ids.chatId, rowId, text: `copie ${i}`, updatedAt: 1 });
      }
    });
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: b });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await docsOfRow(t, "a1")).toHaveLength(0);
  });
});

describe("pass 6 C — every path that deletes an answer tombstones its run", () => {
  test("a service chat's sweep: a late read of the swept reply's run stores nothing and makes no bubble", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const SKH = "agent:main:summarizer:h";
    const hidden = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: ids.userId, updatedAt: 1, kind: "summarizer" as const, instanceName: "prod", agentId: "main", transcriptSeenAt: 1 }),
    );
    const applyH = (rows: Row[], extra: Record<string, unknown> = {}) =>
      t.mutation(internal.transcriptProjection.applyTranscript, {
        chatId: hidden,
        boundInstanceName: "prod",
        sessionKey: SKH,
        sessionId: "s-h",
        kind: "delta",
        deltaCursor: `c:${Math.random()}`,
        rows: rows as never,
        terminals: [],
        unidentified: 0,
        ...extra,
      } as never);
    await applyH([], { kind: "page" });
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: hidden,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "résumé",
        runId: "sum1",
        turnSessionKey: SKH,
        boundInstance: "prod",
        updatedAt: 1,
      }),
    );
    await t.mutation(internal.chatSummaries.sweepHiddenChat, { hiddenChatId: hidden });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await applyH([said("h1", 2, "sum1", "résumé secret")], { kind: "live", textsOnly: true });
    await applyH([said("h1", 2, "sum1", "", { text: undefined })], { terminals: [terminal("sum1")], hasActiveRun: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    const bubbles = await t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", hidden)).collect()).filter(
        (m) => m.role === "assistant",
      ),
    );
    expect(bubbles).toHaveLength(0);
  });

  async function bubbleWith52Merges(t: T) {
    const ids = await seed(t, "on");
    const b = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "fusion",
        runId: "P",
        turnSessionKey: SK,
        boundInstance: "prod",
        updatedAt: 1,
      }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 52; i++) {
        await ctx.db.insert("runBubbles", { chatId: ids.chatId, runId: `m${i}`, messageId: b, createdAt: 1 });
        await insertRowWithText(
          ctx,
          {
            chatId: ids.chatId,
            instanceName: "prod",
            sessionKey: SK,
            sessionId: "s-1",
            entryId: `m${i}-a`,
            seq: 10 + i,
            role: "assistant",
            runId: `m${i}`,
            hidden: false,
            visible: true,
            updatedAt: 1,
          },
          `livraison ${i}`,
        );
      }
    });
    return { ...ids, b };
  }

  test("a bubble with 52 merged runs: every run is tombstoned and every unassigned text purged", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await bubbleWith52Merges(t);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: ids.b });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    const tombs = await t.run(async (ctx) => (await ctx.db.query("transcriptTombstones").collect()).length);
    expect(tombs).toBe(53);
  });

  test("…and while the tombstoning still paginates, a text for a run not reached yet is refused", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await bubbleWith52Merges(t);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: ids.b });
    // Before any scheduled step runs: only the first page of merges is tombstoned.
    await apply(t, ids.chatId, [said("m51-b", 200, "m51", "livraison tardive")], { kind: "live", textsOnly: true });
    expect(await docsOfRow(t, "m51-b")).toHaveLength(0);
  });
});

describe("pass 6 A — an apply carries no more text than it can persist; a refusal moves nothing", () => {
  const ACKED = (entryId: string, seq: number, runId: string): Row => said(entryId, seq, runId, CJK, { yieldAck: CJK });

  test("on: 28 rows of 32 700 CJK chars + acknowledgment in one apply: refused, nothing stored, nothing scheduled", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const rows = Array.from({ length: 28 }, (_, i) => ACKED(`k${i}`, 10 + i, `r${i % 7}`));
    const res = (await apply(t, ids.chatId, rows, { kind: "live", textsOnly: true })) as { ok: boolean; reason?: string };
    expect(res).toMatchObject({ ok: false, reason: "too_large" });
    expect(await t.run((ctx) => ctx.db.query("transcriptRows").collect())).toHaveLength(0);
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.state.kind === "pending"),
    );
    expect(pending).toHaveLength(0);
  });

  test("on: 140 rows (13.7 MB) over 28 runs: the oversized read is refused WITHOUT moving the cursor; chunked, every answer arrives whole", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [], { kind: "delta", deltaCursor: "before" });
    const rows: Row[] = [];
    const runs: string[] = [];
    for (let r = 0; r < 28; r++) {
      const runId = `w${String(r).padStart(2, "0")}`;
      runs.push(runId);
      for (let i = 0; i < 5; i++) rows.push(said(`${runId}-${i}`, 10 + r * 5 + i, runId, CJK));
    }
    const refused = (await apply(t, ids.chatId, rows.slice(0, 200), {
      kind: "delta",
      deltaCursor: "after",
      hasActiveRun: true,
      activeRunIds: runs,
    })) as { ok: boolean; reason?: string };
    expect(refused).toMatchObject({ ok: false, reason: "too_large" });
    const cursorAfterRefusal = await t.run(async (ctx) => (await ctx.db.query("transcriptCursors").collect())[0]);
    expect(cursorAfterRefusal?.deltaCursor).toBe("before");
    // What the bridge does instead: the texts ahead in persistable chunks, then the read.
    await postTextsInChunks(t, ids.chatId, rows);
    await apply(t, ids.chatId, rows.map(identityOnly), { kind: "delta", deltaCursor: "after", hasActiveRun: true, activeRunIds: runs });
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const lens = await t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", ids.chatId)).collect())
        .filter((m) => m.role === "assistant")
        .map((m) => m.text.length),
    );
    expect(lens).toHaveLength(28);
    for (const len of lens) expect(len).toBe(5 * CJK.length + 4 * 2);
  }, 120_000);
});

describe("pass 6 D (unit) — the projection honours the budget the transaction already spent", () => {
  test("a shared budget already past its soft bound: nothing projected here, every run handed on", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "Bonj");
    await apply(t, ids.chatId, [said("a1", 2, "sendA", "Bonjour.")], { hasActiveRun: true, activeRunIds: ["sendA"] });
    await t.run(async (ctx) => {
      const run = (await ctx.db.query("transcriptRuns").collect())[0]!;
      await ctx.db.patch(run._id, { settledAt: 1 });
    });
    const res = await t.run(async (ctx) => {
      const spent = newBudget();
      spent.bytes = PROJECTION_BYTE_BUDGET + 1;
      return projectBubbles(
        ctx,
        { chatId: ids.chatId, sessionKey: SK, sessionId: "s-1", instanceName: "prod", floorSeq: 0, gaps: [] },
        ["sendA"],
        undefined,
        spent,
      );
    });
    expect(res.remaining).toEqual(["sendA"]);
    expect((await get(t, b))?.status).toBe("streaming");
  });
});

describe("pass 6 D — one budget for the whole transaction", () => {
  test("on: merge reads of 7 stored 760 KB texts and a heavy projection in ONE apply: the projection waits for its own transaction", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    // 7 rows whose stored document holds a 380 KB text AND a 380 KB acknowledgment (a
    // row's whole budget): 7 × 760 KB to read back to merge.
    const HALF = "y".repeat(380 * 1024);
    await t.run(async (ctx) => {
      for (let i = 0; i < 7; i++) {
        const rowId = await ctx.db.insert("transcriptRows", {
          chatId: ids.chatId,
          instanceName: "prod",
          sessionKey: SK,
          sessionId: "s-1",
          entryId: `d${i}`,
          seq: 1000 + i,
          role: "assistant",
          runId: "dRun",
          hidden: false,
          visible: true,
          textSig: rowTextSignature(HALF, HALF),
          updatedAt: 1,
        });
        await ctx.db.insert("transcriptRowTexts", { chatId: ids.chatId, rowId, text: HALF, yieldAck: HALF, updatedAt: 1 });
      }
    });
    // A run with 16 steer segments of 500 KB live bubbles, about to settle.
    const big = "z".repeat(500_000);
    for (let k = 0; k < 16; k++) {
      await liveBubble(t, ids, "H", "…", { text: big, ...(k > 0 ? { runSegment: k } : {}) });
    }
    const hRows: Row[] = [];
    for (let k = 0; k < 16; k++) {
      hRows.push(said(`h${k}`, 2 + 2 * k, "H", `part ${k}`));
      if (k < 15) hRows.push(user(`hs${k}`, 3 + 2 * k, `hsteer${k}`, { steerTargetRunId: "H" }));
    }
    await postTextsInChunks(t, ids.chatId, hRows);
    await apply(t, ids.chatId, hRows.map(identityOnly), { hasActiveRun: true, activeRunIds: ["H"] });
    // The read: new texts for the 40 rows (each merge reads the stored 196 KB document)
    // AND the terminal that settles H.
    const changed = "w".repeat(380 * 1024);
    const res = (await apply(
      t,
      ids.chatId,
      Array.from({ length: 7 }, (_, i) => said(`d${i}`, 1000 + i, "dRun", changed)),
      { terminals: [terminal("H")], hasActiveRun: true, activeRunIds: ["dRun"] },
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const settled = (await assistants(t, ids.chatId)).filter((m) => m.runId === "H" && m.status === "complete");
    expect(settled).toHaveLength(16);
  }, 120_000);
});

// ── Codex phase 4, pass 7 ───────────────────────────────────────────────────────────

describe("pass 7 #1 — a deleted run segment opens no live bubble again, in any mode", () => {
  async function projectedThenDeleted(t: T) {
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, ANNOUNCE_RUN, "Résultat livré.")], {
      terminals: [terminal(ANNOUNCE_RUN)],
      hasActiveRun: false,
    });
    const [bubble] = (await assistants(t, ids.chatId)).filter((m) => m.runId === ANNOUNCE_RUN);
    expect(bubble).toBeDefined();
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: bubble!._id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return ids;
  }

  test("on: a replayed live start of the deleted announce gets nothing — no bubble, no text", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await projectedThenDeleted(t);
    const landed = await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: ANNOUNCE_RUN,
      turnSessionKey: SK,
      boundInstanceName: "prod",
    });
    expect(landed).toBeNull();
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === ANNOUNCE_RUN)).toHaveLength(0);
  });

  test("…and after a rollback to shadow too", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await projectedThenDeleted(t);
    await setMode(t, "shadow");
    const landed = await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: ANNOUNCE_RUN,
      turnSessionKey: SK,
      boundInstanceName: "prod",
    });
    expect(landed).toBeNull();
  });

  test("off: a run merged into a bubble the person deleted opens nothing either (the merge record says so)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await setMode(t, "off" as Mode);
    const parent = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "parent",
        runId: "P",
        updatedAt: 1,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("runBubbles", { chatId: ids.chatId, runId: ANNOUNCE_RUN, messageId: parent, createdAt: 1 });
      await ctx.db.delete(parent);
    });
    const landed = await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: ANNOUNCE_RUN });
    expect(landed).toBeNull();
  });
});

describe("pass 7 #2 — only a row attributed to a run keeps its text", () => {
  test("on: a producerless row (no runId) is stored as an identity, its text never", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [said("mirror", 5, "", "copie miroir", { runId: undefined })], { kind: "live", textsOnly: true });
    const row = (await rowsOf(t, ids.chatId)).find((r) => r.entryId === "mirror");
    expect(row).toBeDefined();
    expect(row?.textSig).toBeUndefined();
    expect(await textCount(t)).toBe(0);
  });

  test("the cleanup deletes text copies already stored for rows of no run", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await t.run(async (ctx) => {
      const orphan = await ctx.db.insert("transcriptRows", {
        chatId: ids.chatId,
        instanceName: "prod",
        sessionKey: SK,
        sessionId: "s-1",
        entryId: "orphan",
        seq: 9,
        role: "assistant",
        hidden: false,
        visible: true,
        textSig: rowTextSignature("vieux", undefined),
        updatedAt: 1,
      });
      await ctx.db.insert("transcriptRowTexts", { chatId: ids.chatId, rowId: orphan, text: "vieux", updatedAt: 1 });
      await insertRowWithText(
        ctx,
        { chatId: ids.chatId, instanceName: "prod", sessionKey: SK, sessionId: "s-1", entryId: "kept", seq: 10, role: "assistant", runId: "R", hidden: false, visible: true, updatedAt: 1 },
        "gardé",
      );
    });
    await t.mutation(internal.migrations.purgeUnattributedRowTexts, {});
    const texts = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
    expect(texts.map((d) => d.text)).toEqual(["gardé"]);
  });
});

describe("pass 7 #3 — deleting many answers stays within Convex's limits, whatever the mode", () => {
  async function manyAnswersWithMerges(t: T, mode: Mode | "off", projected: boolean) {
    const ids = projected ? await seed(t, mode as Mode) : await seedNoRead(t, mode);
    let first: Id<"messages"> | null = null;
    for (let a = 0; a < 20; a++) {
      await t.run(async (ctx) => {
        const u = await ctx.db.insert("messages", {
          chatId: ids.chatId,
          userId: ids.userId,
          role: "user" as const,
          status: "complete" as const,
          text: `q${a}`,
          updatedAt: 1,
        });
        if (first === null) first = u;
        const m = await ctx.db.insert("messages", {
          chatId: ids.chatId,
          userId: ids.userId,
          role: "assistant" as const,
          status: "complete" as const,
          text: `r${a}`,
          runId: `ans${a}`,
          turnSessionKey: SK,
          boundInstance: "prod",
          updatedAt: 1,
        });
        for (let i = 0; i < 50; i++) {
          await ctx.db.insert("runBubbles", { chatId: ids.chatId, runId: `ans${a}-m${i}`, messageId: m, createdAt: 1 });
        }
      });
    }
    return { ...ids, first: first! as Id<"messages"> };
  }

  async function seedNoRead(t: T, mode: Mode | "off") {
    return t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: mode } as never });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
      return { userId, chatId };
    });
  }

  const transcriptJobs = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.includes("transcriptProjection")),
    );

  test("never-on conversation (no transcript read ever): 20 answers × 50 merges deleted at once — no transcript work at all", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await manyAnswersWithMerges(t, "off", false);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: ids.first });
    expect(await transcriptJobs(t)).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptTombstones").collect()).length)).toBe(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("messages").collect()).length)).toBe(0);
  });

  test("on: the same deletion commits, schedules at most one transcript step per answer, and tombstones every merge", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await manyAnswersWithMerges(t, "on", true);
    // The session holds rows (something to purge).
    await apply(t, ids.chatId, [said("x1", 2, "ans0", "texte")], { kind: "live", textsOnly: true });
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: ids.first });
    expect((await transcriptJobs(t)).length).toBeLessThanOrEqual(20);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptTombstones").collect()).length)).toBe(20 * 51);
    expect(await textCount(t)).toBe(0);
  }, 120_000);
});

describe("pass 7 #4 — one UTF-8 budget per row, the bubble's own: a long answer the live frames missed gets its bubble", () => {
  test("on: a 32 769-character answer read from the transcript only is stored and makes its bubble", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const long = "a".repeat(32_769);
    await postTextsInChunks(t, ids.chatId, [said("a1", 2, "sendA", long)]);
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), identityOnly(said("a1", 2, "sendA", long))], {
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    const bubble = (await assistants(t, ids.chatId)).find((m) => m.runId === "sendA");
    expect(bubble?.text).toBe(long);
  });

  test("a text over a row's budget (the bubble bound) is not kept — its bubble could never be composed from it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const huge = "b".repeat(768 * 1024 + 1);
    await apply(t, ids.chatId, [said("h1", 2, "R", huge)], { kind: "live", textsOnly: true });
    expect(await textCount(t)).toBe(0);
  });
});

describe("pass 7 — what an apply must read back to merge is bounded before any write", () => {
  test("8 changed rows whose stored text is known (8 × a row's budget to read): refused; 7: accepted", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await t.run(async (ctx) => {
      for (let i = 0; i < 8; i++) {
        await insertRowWithText(
          ctx,
          { chatId: ids.chatId, instanceName: "prod", sessionKey: SK, sessionId: "s-1", entryId: `k${i}`, seq: 10 + i, role: "assistant", runId: "K", hidden: false, visible: true, updatedAt: 1 },
          "avant",
        );
      }
    });
    const changed = (n: number) => Array.from({ length: n }, (_, i) => said(`k${i}`, 10 + i, "K", "après"));
    const eight = (await apply(t, ids.chatId, changed(8), { kind: "live", textsOnly: true })) as { ok: boolean; reason?: string };
    expect(eight).toMatchObject({ ok: false, reason: "too_large" });
    const seven = (await apply(t, ids.chatId, changed(7), { kind: "live", textsOnly: true })) as { ok: boolean };
    expect(seven.ok).toBe(true);
  });
});

// ── Codex phase 4, pass 8 ───────────────────────────────────────────────────────────

const transcriptJobs8 = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.includes("transcriptProjection")),
  );

async function answersWithMerges(t: T, ids: { chatId: Id<"chats">; userId: Id<"users"> }, answers: number, merges: number) {
  let first: Id<"messages"> | null = null;
  for (let a = 0; a < answers; a += 10) {
    await t.run(async (ctx) => {
      for (let k = a; k < Math.min(answers, a + 10); k++) {
        const u = await ctx.db.insert("messages", {
          chatId: ids.chatId,
          userId: ids.userId,
          role: "user" as const,
          status: "complete" as const,
          text: `q${k}`,
          updatedAt: 1,
        });
        if (first === null) first = u;
        const m = await ctx.db.insert("messages", {
          chatId: ids.chatId,
          userId: ids.userId,
          role: "assistant" as const,
          status: "complete" as const,
          text: `r${k}`,
          runId: `ans${k}`,
          turnSessionKey: SK,
          boundInstance: "prod",
          updatedAt: 1,
        });
        for (let i = 0; i < merges; i++) {
          await ctx.db.insert("runBubbles", { chatId: ids.chatId, runId: `ans${k}-m${i}`, messageId: m, createdAt: 1 });
        }
      }
    });
  }
  return first! as Id<"messages">;
}

describe("pass 8 #1 — a deletion's tombstoning is O(1) per answer; merges and purges follow in ONE bounded chain", () => {
  for (const mode of ["on"] as const) {
    test(`${mode}: 80 answers × 50 merges (past Codex's 60 × 50) deleted at once commit under the real limits; every merge is tombstoned after`, async () => {
      vi.useFakeTimers();
      const t = convexTest({ schema, modules, transactionLimits: true });
      const ids = await seed(t, mode);
      const first = await answersWithMerges(t, ids, 80, 50);
      await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: first });
      expect((await assistants(t, ids.chatId)).filter((m) => m.runId?.startsWith("ans"))).toHaveLength(0);
      // ONE follow-up scheduled by the deletion, whatever it removed.
      expect((await transcriptJobs8(t)).filter((f) => f.name.includes("followUpDeletion"))).toHaveLength(1);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await t.run(async (ctx) => (await ctx.db.query("transcriptTombstones").collect()).length)).toBe(80 * 51);
    }, 180_000);
  }

  test("on: a deletion of 200 answers commits (the per-answer transcript cost is one tombstone)", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const first = await answersWithMerges(t, ids, 200, 0);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: first });
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId?.startsWith("ans"))).toHaveLength(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptTombstones").collect()).length)).toBe(200);
  }, 180_000);
});

describe("pass 8 #2 — a texts-only chunk before any read marks the conversation: a deletion in between still purges", () => {
  test("on: chunk → deletion → first read: the text is gone and the answer is not made again", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
      await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "main", isDefault: true, source: "manual" as const, createdAt: 1 });
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
      await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "q", sendId: "sendA", updatedAt: 1 });
      return { userId, chatId };
    });
    const b = await liveBubble(t, ids, "sendA", "Secret");
    await t.mutation(internal.stream.finalize, { messageId: b, status: "complete", text: "Secret entier." });
    // The read's texts went ahead; no read has created a cursor yet.
    await apply(t, ids.chatId, [said("a1", 2, "sendA", "Secret entier.")], { kind: "live", textsOnly: true });
    expect(await textCount(t)).toBe(1);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptCursors").collect()).length)).toBe(0);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: b });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    // The read itself arrives.
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "", { text: undefined })], {
      kind: "page",
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA")).toHaveLength(0);
  });
});

describe("pass 8 #3 — every purge and sweep of row texts is sized by bytes", () => {
  const BIG = "z".repeat(760 * 1024);
  async function bigTexts(t: T, chatId: Id<"chats">, sessionKey: string, n: number, messageId?: Id<"messages">) {
    for (let k = 0; k < n; k += 8) {
      await t.run(async (ctx) => {
        for (let i = k; i < Math.min(n, k + 8); i++) {
          await insertRowWithText(
            ctx,
            {
              chatId,
              instanceName: "prod",
              sessionKey,
              sessionId: "s-1",
              entryId: `big-${i}`,
              seq: 10 + i,
              role: "assistant",
              runId: "bigRun",
              hidden: false,
              visible: true,
              ...(messageId !== undefined ? { messageId } : {}),
              updatedAt: 1,
            },
            BIG,
          );
        }
      });
    }
  }

  test("the deleted bubble's purge: 24 texts of 760 KB, all gone, every batch under the read limit", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const b = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "x",
        runId: "bigRun",
        turnSessionKey: SK,
        boundInstance: "prod",
        updatedAt: 1,
      }),
    );
    await bigTexts(t, ids.chatId, SK, 24, b);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: b });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptRowTexts").take(1)).length)).toBe(0);
  }, 120_000);

  test("the chat purge: 24 texts of 760 KB, all gone", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await bigTexts(t, ids.chatId, SK, 24);
    await t.run((ctx) => cascadeDeleteChat(ctx, ids.chatId, { inline: false }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptRowTexts").take(1)).length)).toBe(0);
  }, 120_000);

  test("the service-chat sweep: 24 texts of 760 KB, all gone", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const hidden = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: ids.userId, updatedAt: 1, kind: "summarizer" as const, instanceName: "prod", agentId: "main", transcriptSeenAt: 1 }),
    );
    await bigTexts(t, hidden, "agent:main:summarizer", 24);
    await t.mutation(internal.chatSummaries.sweepHiddenChat, { hiddenChatId: hidden });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptRowTexts").take(1)).length)).toBe(0);
  }, 120_000);
});

describe("pass 8 #4 — a merged text document is bounded again before it is written", () => {
  test("on: a 600 KiB acknowledgment, then a 600 KiB text: the text is kept whole, the acknowledgment dropped", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const ack = "a".repeat(600 * 1024);
    const text = "t".repeat(600 * 1024);
    await apply(t, ids.chatId, [said("m1", 2, "R", "", { text: undefined, yieldAck: ack })], { kind: "live", textsOnly: true });
    await apply(t, ids.chatId, [said("m1", 2, "R", text)], { kind: "live", textsOnly: true });
    const docs = await docsOfRow(t, "m1");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.text?.length).toBe(text.length);
    expect(docs[0]!.yieldAck).toBeUndefined();
  });
});


// ── Codex phase 4, pass 9 ───────────────────────────────────────────────────────────

describe("pass 9 #1 — a conversation that never stored text pays nothing for the transcript on deletion", () => {
  test("shadow, never on: 280 turns with 50 merges each, first message deleted under the real limits — no tombstone, no step", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "shadow");
    const first = await answersWithMerges(t, ids, 280, 0);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: first });
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId?.startsWith("ans"))).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptTombstones").collect()).length)).toBe(0);
    expect(await transcriptJobs8(t)).toHaveLength(0);
  }, 300_000);

  test("on: the same 280-turn deletion adds one insert per answer and ONE step", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const first = await answersWithMerges(t, ids, 280, 0);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: first });
    expect((await transcriptJobs8(t)).filter((f) => f.name.includes("followUpDeletion"))).toHaveLength(1);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptTombstones").collect()).length)).toBe(280);
  }, 300_000);
});

describe("pass 9 #2 — row texts are purged in their own transactions, never inside a message sweep", () => {
  const BIG = "m".repeat(760 * 1024);
  async function bigMessagesAndTexts(t: T, chatId: Id<"chats">, userId: Id<"users">, sessionKey: string) {
    for (let k = 0; k < 6; k += 3) {
      await t.run(async (ctx) => {
        for (let i = k; i < k + 3; i++) {
          await ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: BIG, updatedAt: 1 });
        }
      });
    }
    for (let k = 0; k < 10; k += 5) {
      await t.run(async (ctx) => {
        for (let i = k; i < k + 5; i++) {
          await insertRowWithText(
            ctx,
            { chatId, instanceName: "prod", sessionKey, sessionId: "s-1", entryId: `t${i}`, seq: 10 + i, role: "assistant", runId: "R", hidden: false, visible: true, updatedAt: 1 },
            BIG,
          );
        }
      });
    }
  }

  test("the chat purge: 6 messages and 10 texts of 760 KB — every transaction under the read limit, all gone", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await bigMessagesAndTexts(t, ids.chatId, ids.userId, SK);
    await t.run((ctx) => cascadeDeleteChat(ctx, ids.chatId, { inline: false }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptRowTexts").take(1)).length)).toBe(0);
  }, 120_000);

  test("the service-chat sweep: the same — all gone, rows marked", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const hidden = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: ids.userId, updatedAt: 1, kind: "summarizer" as const, instanceName: "prod", agentId: "main", transcriptSeenAt: 1 }),
    );
    await bigMessagesAndTexts(t, hidden, ids.userId, "agent:main:summarizer");
    await t.mutation(internal.chatSummaries.sweepHiddenChat, { hiddenChatId: hidden });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(async (ctx) => (await ctx.db.query("transcriptRowTexts").take(1)).length)).toBe(0);
    expect((await rowsOf(t, hidden)).every((r) => r.textSig === TEXT_PURGED_SIG)).toBe(true);
  }, 120_000);
});

describe("pass 9 #3 — a tombstoned or purged row met by any write path loses its stored copy", () => {
  test("on: a segment-1 answer stored before its cut row arrived is purged once the cut row lands", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const seg1 = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "partie 2",
        runId: "R",
        runSegment: 1,
        turnSessionKey: SK,
        boundInstance: "prod",
        updatedAt: 1,
      }),
    );
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: seg1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The answer's text arrives first. Deleted while no cut of its run was known, the
    // segment's boundary resolves CONSERVATIVELY to the run's start (codex phase 4 pass
    // 27: an ordinal is never trusted against cuts that may come later): never stored.
    await apply(t, ids.chatId, [said("a2", 5, "R", "secret de la partie 2")], { kind: "live", textsOnly: true });
    expect(await textCount(t)).toBe(0);
    // The cut row arrives: the row now falls in the deleted segment.
    await apply(t, ids.chatId, [user("s1", 3, "sendS", { steerTargetRunId: "R" })], { kind: "live" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
  });

  test("on: a row marked purged that still holds a copy loses it when a read meets it again", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await t.run(async (ctx) => {
      const rowId = await ctx.db.insert("transcriptRows", {
        chatId: ids.chatId,
        instanceName: "prod",
        sessionKey: SK,
        sessionId: "s-1",
        entryId: "p1",
        seq: 4,
        role: "assistant",
        runId: "R",
        hidden: false,
        visible: true,
        textSig: TEXT_PURGED_SIG,
        updatedAt: 1,
      });
      await ctx.db.insert("transcriptRowTexts", { chatId: ids.chatId, rowId, text: "reste", updatedAt: 1 });
    });
    await apply(t, ids.chatId, [said("p1", 4, "R", "reste")], { kind: "live", textsOnly: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await docsOfRow(t, "p1")).toHaveLength(0);
  });
});

describe("pass 9 #4 — custody and assignment read under the transaction's budget", () => {
  test("on: 100 user rows, each with a big message and a 64 KB outbox: the apply commits, every row assigned after", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const body = "u".repeat(150 * 1024);
    const outText = "o".repeat(64 * 1024);
    for (let k = 0; k < 100; k += 10) {
      await t.run(async (ctx) => {
        for (let i = k; i < k + 10; i++) {
          const m = await ctx.db.insert("messages", {
            chatId: ids.chatId,
            userId: ids.userId,
            role: "user" as const,
            status: "complete" as const,
            text: body,
            sendId: `send${i}`,
            updatedAt: 1,
          });
          await ctx.db.insert("outbox", {
            chatId: ids.chatId,
            userId: ids.userId,
            clientMessageId: `c${i}`,
            messageId: m,
            text: outText,
            attachmentIds: [],
            status: "sent",
            sendId: `send${i}`,
            sentToInstance: "prod",
          });
        }
      });
    }
    const rows = Array.from({ length: 100 }, (_, i) => user(`u${i}`, 10 + i, `send${i}`));
    const res = (await apply(t, ids.chatId, rows, { kind: "live" })) as { ok: boolean };
    expect(res.ok).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const assigned = (await rowsOf(t, ids.chatId)).filter((r) => r.entryId.startsWith("u") && r.messageId !== undefined);
    expect(assigned).toHaveLength(100);
  }, 120_000);
});

// ── Codex phase 4, pass 10 ──────────────────────────────────────────────────────────

describe("pass 10 #1 — every caller that deletes a chat schedules its row texts' purge", () => {
  async function trashedOnChatWithTexts(t: T) {
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [said("a1", 2, "R", "texte gardé")], { kind: "live", textsOnly: true });
    expect(await textCount(t)).toBe(1);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.chatId, { trashedAt: 1, purgeAfter: 2 } as never);
      const admin = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: admin, role: "admin" as const, canonical: "adm" });
    });
    const admin = await t.run(async (ctx) => (await ctx.db.query("profiles").collect()).find((p) => p.canonical === "adm")!.userId);
    const profileId = await t.run(async (ctx) => (await ctx.db.query("profiles").collect()).find((p) => p.userId === ids.userId)!._id);
    return { ...ids, admin, profileId };
  }

  test("trash.purgeChat (inline sweep): the texts are purged", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const w = await trashedOnChatWithTexts(t);
    await t.withIdentity({ subject: `${w.userId}|session` }).mutation(api.trash.purgeChat, { chatId: w.chatId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
  });

  test("trash.adminPurgeChat: the texts are purged", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const w = await trashedOnChatWithTexts(t);
    await t.withIdentity({ subject: `${w.admin}|session` }).mutation(api.trash.adminPurgeChat, { chatId: w.chatId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
  });

  test("account deletion: the texts are purged", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const w = await trashedOnChatWithTexts(t);
    await t.withIdentity({ subject: `${w.admin}|session` }).mutation(api.admin.deleteUser, { profileId: w.profileId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
  });
});

describe("pass 10 #2 — new cuts beyond one apply's bound are handed on, never dropped", () => {
  test("on: 25 runs whose deleted segment 1 holds a text stored before its cut: one apply of 25 cuts purges all 25", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    for (let r = 0; r < 25; r++) {
      const seg1 = await t.run((ctx) =>
        ctx.db.insert("messages", {
          chatId: ids.chatId,
          userId: ids.userId,
          role: "assistant" as const,
          status: "complete" as const,
          text: "x",
          runId: `C${r}`,
          runSegment: 1,
          turnSessionKey: SK,
          boundInstance: "prod",
          updatedAt: 1,
        }),
      );
      await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: seg1 });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const texts: Row[] = [];
    for (let r = 0; r < 25; r++) texts.push(said(`t${r}`, 100 + r * 2 + 1, `C${r}`, `secret ${r}`));
    await apply(t, ids.chatId, texts, { kind: "live", textsOnly: true });
    // Deleted while no cut was known: resolved to each run's start (conservative, pass 27).
    expect(await textCount(t)).toBe(0);
    const cuts: Row[] = [];
    for (let r = 0; r < 25; r++) cuts.push(user(`k${r}`, 100 + r * 2, `cut${r}`, { steerTargetRunId: `C${r}` }));
    await apply(t, ids.chatId, cuts, { kind: "live" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
  });
});

describe("pass 10 #5 / pass 11 #1 — a run's cuts are read whole, or the run is never placed", () => {
  test("on: 65 cuts are read whole: the segment-65 answer gets its own bubble, at its real cut", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    const rows: Row[] = [];
    let seq = 2;
    for (let k = 0; k <= 65; k++) {
      rows.push(said(`m${k}`, seq++, "MANY", `partie ${k}`));
      if (k < 65) rows.push(user(`c${k}`, seq++, `cutsend${k}`, { steerTargetRunId: "MANY" }));
    }
    await postTextsInChunks(t, ids.chatId, rows);
    await apply(t, ids.chatId, rows.map(identityOnly), { terminals: [terminal("MANY")], hasActiveRun: false });
    const seg65 = (await assistants(t, ids.chatId)).find((m) => m.runId === "MANY" && m.runSegment === 65);
    expect(seg65?.text).toBe("partie 65");
  });

  test("on: more cuts than one read takes (1 001): no row is assigned and no bubble is born", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    await t.run(async (ctx) => {
      for (let k = 0; k < 1001; k++) {
        await ctx.db.insert("transcriptRows", {
          chatId: ids.chatId, instanceName: "prod", sessionKey: SK, sessionId: "s-1",
          entryId: `c${k}`, seq: 3 + 2 * k, role: "user", runId: `cutsend${k}`, sendId: `cutsend${k}`,
          steerTargetRunId: "MANY", hidden: false, visible: true, updatedAt: 1,
        });
      }
    });
    await postTextsInChunks(t, ids.chatId, [said("m0", 2, "MANY", "partie 0"), said("mz", 5000, "MANY", "partie z")]);
    await apply(t, ids.chatId, [identityOnly(said("m0", 2, "MANY", "x")), identityOnly(said("mz", 5000, "MANY", "x"))], {
      terminals: [terminal("MANY")],
      hasActiveRun: false,
    });
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "MANY")).toHaveLength(0);
    const placed = (await rowsOf(t, ids.chatId)).filter((r) => r.runId === "MANY" && r.role === "assistant" && r.messageId !== undefined);
    expect(placed).toHaveLength(0);
  }, 60_000);
});


// ── Codex phase 4, pass 11 ──────────────────────────────────────────────────────────

describe("pass 11 #1 — a segment past 64 is purged on deletion, even unassigned and after a rollback", () => {
  test("on → shadow: the segment-65 bubble deleted, its unassigned row's text is purged by the purge steps", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t, "on");
    // 65 cuts of run R, and a row of segment 65 whose text was stored (never assigned).
    await t.run(async (ctx) => {
      for (let k = 0; k < 65; k++) {
        await ctx.db.insert("transcriptRows", {
          chatId: ids.chatId, instanceName: "prod", sessionKey: SK, sessionId: "s-1",
          entryId: `c${k}`, seq: 3 + 2 * k, role: "user", runId: `cs${k}`, sendId: `cs${k}`,
          steerTargetRunId: "R", hidden: false, visible: true, updatedAt: 1,
        });
      }
      await insertRowWithText(
        ctx,
        { chatId: ids.chatId, instanceName: "prod", sessionKey: SK, sessionId: "s-1", entryId: "late", seq: 500, role: "assistant", runId: "R", hidden: false, visible: true, updatedAt: 1 },
        "réponse du segment 65",
      );
    });
    const bubble65 = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId, userId: ids.userId, role: "assistant" as const, status: "complete" as const,
        text: "réponse du segment 65", runId: "R", runSegment: 65, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1,
      }),
    );
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: bubble65 });
    await setMode(t, "shadow");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
  });

  test("a run with more tombstones than one read takes: every row of it counts as deleted (conservative)", () => {
    const tombs = new Map<number, Id<"messages"> | undefined>([[ALL_SEGMENTS, undefined]]);
    expect(tombstoneHit(tombs, { seqs: [], sends: [], complete: true }, 5)).toEqual({});
    expect(tombstoneHit(new Map([[3, undefined]]), { seqs: [1, 2], sends: [], complete: false }, 5)).toEqual({});
    // An ordinal past the known cuts resolves to the last one known (conservative, pass 27).
    expect(tombstoneHit(new Map([[3, undefined]]), { seqs: [1, 2], sends: [], complete: true }, 5)).toEqual({});
    expect(tombstoneHit(new Map([[1, undefined]]), { seqs: [4, 8], sends: [], complete: true }, 3)).toBeNull();
    expect(tombstoneHit(new Map(), { seqs: [], sends: [], complete: false }, 5)).toBeNull();
  });
});

describe("pass 11 #3 — a bubble born from rows keeps the run's error or timeout", () => {
  for (const status of ["error", "timeout"] as const) {
    test(`on: the transcript arrives before the live ${status} terminal: the bubble is born \`error\`, and stays so`, async () => {
      const t = convexTest(schema, modules);
      const ids = await seed(t, "on");
      await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse partielle")], {
        terminals: [terminal("sendA", status)],
        hasActiveRun: false,
      });
      const born = (await assistants(t, ids.chatId)).find((m) => m.runId === "sendA")!;
      expect(born.status).toBe("error");
      // The live terminal lands on that bubble afterwards.
      const landed = (await t.mutation(internal.stream.startAssistant, {
        chatId: ids.chatId,
        runId: "sendA",
        turnSessionKey: SK,
        boundInstanceName: "prod",
      })) as Id<"messages">;
      expect(landed).toBe(born._id);
      await t.mutation(internal.stream.finalize, { messageId: landed, status: "error", error: "provider down" } as never);
      expect((await get(t, born._id))?.status).toBe("error");
    });
  }
});

describe("pass 12 #1 — a deleted USER message takes its send's run with it, bubble or not", () => {
  const deleteUser = (t: T, ids: { userId: Id<"users">; userMessageId: Id<"messages"> }) =>
    t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: ids.userMessageId });

  test("on: a text chunk stored before the answer's bubble was born is purged, and the terminal read makes nothing", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    // The read's texts went ahead (textsOnly): stored, no bubble yet.
    await postTextsInChunks(t, ids.chatId, [user("u1", 1, "sendA", { text: "question A" }), said("a1", 2, "sendA", "Réponse secrète.")]);
    expect(await textCount(t)).toBe(2);
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA")).toHaveLength(0);
    await deleteUser(t, ids);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    // The read itself (identities), then the run's terminal: the deleted answer is not made.
    await apply(t, ids.chatId, [identityOnly(user("u1", 1, "sendA")), identityOnly(said("a1", 2, "sendA", ""))], {
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA")).toHaveLength(0);
    expect(await textCount(t)).toBe(0);
  });

  test("on: deleted before ANY row was read — its rows arriving later store nothing and make nothing", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    // The conversation stored text before (its marker is set by the first read in `on`).
    await deleteUser(t, ids);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await postTextsInChunks(t, ids.chatId, [user("u1", 1, "sendA", { text: "question A" }), said("a1", 2, "sendA", "Réponse secrète.")]);
    expect(await textCount(t)).toBe(0);
    await apply(t, ids.chatId, [identityOnly(user("u1", 1, "sendA")), identityOnly(said("a1", 2, "sendA", ""))], {
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA")).toHaveLength(0);
    expect(await textCount(t)).toBe(0);
  });

  test("on: the live door opens no bubble for the deleted send's run either", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await deleteUser(t, ids);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const opened = await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: "sendA", turnSessionKey: SK });
    expect(opened).toBeNull();
  });

  test("the tombstone is session-less and covers every segment; another send's run is untouched", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await postTextsInChunks(t, ids.chatId, [said("b1", 5, "sendB", "Autre réponse.")]);
    await deleteUser(t, ids);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const tombs = await t.run((ctx) => ctx.db.query("transcriptTombstones").collect());
    expect(tombs.map((x) => ({ sessionKey: x.sessionKey, runId: x.runId, segment: x.segment, messageId: x.messageId }))).toEqual([
      { sessionKey: "", runId: "sendA", segment: ALL_SEGMENTS, messageId: ids.userMessageId },
    ]);
    expect(await textCount(t)).toBe(1);
  });

  test("shadow: a user message deletion writes no tombstone and schedules nothing", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "shadow");
    await deleteUser(t, ids);
    expect(await t.run((ctx) => ctx.db.query("transcriptTombstones").collect())).toHaveLength(0);
    const steps = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(steps.filter((f) => /transcriptProjection/.test(f.name))).toHaveLength(0);
  });
});

describe("pass 12 #2 — a bubble is recomposed only when EVERY run it shows is assigned and known", () => {
  async function mergedPS(t: T) {
    const ids = await seed(t, "on");
    const live = "parent answer\n\nsettle conclusion (long)";
    const b = await liveBubble(t, ids, "S", live);
    await t.run(async (ctx) => {
      await ctx.db.patch(b, { status: "complete", text: live });
      await ctx.db.insert("runBubbles", { chatId: ids.chatId, runId: "P", messageId: b, createdAt: 1 });
      await ctx.db.insert("runBubbles", { chatId: ids.chatId, runId: "S", messageId: b, createdAt: 1 });
    });
    return { ...ids, b, live };
  }

  test("on: S's text over the per-row budget (identity only) — one read with P's text keeps the bubble whole", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await mergedPS(t);
    // 799 000 bytes: over the row budget, so the bridge sends S's row WITHOUT its text.
    const s1 = identityOnly(said("s1", 5, "S", "x".repeat(799_000)));
    await postTextsInChunks(t, ids.chatId, [said("p1", 2, "P", "parent answer")]);
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), identityOnly(said("p1", 2, "P", "parent answer")), s1], {
      terminals: [terminal("P"), terminal("S")],
      hasActiveRun: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await get(t, ids.b))?.text).toBe(ids.live);
    expect(await assistants(t, ids.chatId)).toHaveLength(1);
  });

  test("on: P projected in a read that does not carry S's rows yet — the bubble is not reduced to P", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await mergedPS(t);
    // S is over and its row's text is known, but the row is not assigned (as when S's
    // rows came in a read that has not projected S yet).
    await apply(t, ids.chatId, [said("s1", 5, "S", "settle conclusion")], { terminals: [terminal("S")] });
    await t.run(async (ctx) => {
      const s1 = (await ctx.db.query("transcriptRows").collect()).find((r) => r.entryId === "s1")!;
      await ctx.db.patch(s1._id, { messageId: undefined });
    });
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("p1", 2, "P", "parent answer")], {
      terminals: [terminal("P")],
      hasActiveRun: false,
    });
    expect((await get(t, ids.b))?.text).not.toBe("parent answer");
  });

  test("on: once every run's rows are assigned with their text, the bubble IS recomposed from them", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await mergedPS(t);
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("p1", 2, "P", "parent answer"), said("s1", 5, "S", "settle conclusion")], {
      terminals: [terminal("P"), terminal("S")],
      hasActiveRun: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Projected in transcript order: S, after P, completes the bubble.
    await apply(t, ids.chatId, [], { terminals: [terminal("P"), terminal("S")], hasActiveRun: false });
    expect((await get(t, ids.b))?.text).toBe("parent answer\n\nsettle conclusion");
  });
});

describe("pass 13 #1 — a deleted STEER takes the segment it started with it", () => {
  /** A second user message, steered into sendA's run (its send `sendS`). */
  const steerMessage = (t: T, ids: { chatId: Id<"chats">; userId: Id<"users"> }) =>
    t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "user" as const,
        status: "complete" as const,
        text: "et aussi ?",
        sendId: "sendS",
        updatedAt: 2,
      });
      await ctx.db.insert("outbox", {
        chatId: ids.chatId,
        userId: ids.userId,
        clientMessageId: "s",
        messageId: id,
        text: "et aussi ?",
        attachmentIds: [],
        status: "sent",
        sendId: "sendS",
        followUpMode: "steer",
      } as never);
      return id;
    });
  const deleteAs = (t: T, userId: Id<"users">, messageId: Id<"messages">) =>
    t.withIdentity({ subject: `${userId}|session` }).mutation(api.messages.deleteMessage, { messageId });
  const cut = () => user("uS", 3, "sendS", { steerTargetRunId: "sendA", text: "et aussi ?" });
  const textsOf = (t: T) =>
    t.run(async (ctx) => {
      const docs = await ctx.db.query("transcriptRowTexts").collect();
      const out: string[] = [];
      for (const d of docs) out.push((await ctx.db.get(d.rowId))!.entryId);
      return out.sort();
    });
  const terminalRead = (t: T, chatId: Id<"chats">) =>
    apply(
      t,
      chatId,
      [user("u1", 1, "sendA"), said("a1", 2, "sendA", ""), identityOnly(cut()), said("a2", 4, "sendA", "")].map(identityOnly),
      { terminals: [terminal("sendA")], hasActiveRun: false },
    );

  test("on: deleted before any bubble exists — the steered answer's text goes, the run's first answer stays, nothing is made again", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const s = await steerMessage(t, ids);
    await postTextsInChunks(t, ids.chatId, [said("a1", 2, "sendA", "Réponse A."), cut(), said("a2", 4, "sendA", "Réponse au steer.")]);
    expect(await textsOf(t)).toEqual(["a1", "a2", "uS"]);
    await deleteAs(t, ids.userId, s);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textsOf(t)).toEqual(["a1"]);
    await terminalRead(t, ids.chatId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const answers = (await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA");
    expect(answers.map((m) => [m.runSegment ?? 0, m.text])).toEqual([[0, "Réponse A."]]);
    expect(await textsOf(t)).toEqual(["a1"]);
  });

  test("on: the cut row arrives AFTER the deletion — the segment it reveals is tombstoned, its text never stored", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const s = await steerMessage(t, ids);
    await deleteAs(t, ids.userId, s);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await postTextsInChunks(t, ids.chatId, [said("a1", 2, "sendA", "Réponse A."), cut(), said("a2", 4, "sendA", "Réponse au steer.")]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textsOf(t)).toEqual(["a1"]);
    await terminalRead(t, ids.chatId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const answers = (await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA");
    expect(answers.map((m) => [m.runSegment ?? 0, m.text])).toEqual([[0, "Réponse A."]]);
  });

  test("on: a read BEFORE the deletion's follow-up ran places nothing in the steered segment", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const s = await steerMessage(t, ids);
    await postTextsInChunks(t, ids.chatId, [said("a1", 2, "sendA", "Réponse A."), cut(), said("a2", 4, "sendA", "Réponse au steer.")]);
    await deleteAs(t, ids.userId, s);
    // No scheduled step has run: only the send's own tombstone exists.
    await terminalRead(t, ids.chatId);
    const answers = (await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA");
    expect(answers.map((m) => [m.runSegment ?? 0, m.text])).toEqual([[0, "Réponse A."]]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textsOf(t)).toEqual(["a1"]);
  });

  test("on: the answer's text stored first (as segment 0), the deletion, THEN the cut row — the copy is purged", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const s = await steerMessage(t, ids);
    await postTextsInChunks(t, ids.chatId, [said("a1", 2, "sendA", "Réponse A."), said("a2", 4, "sendA", "Réponse au steer.")]);
    await deleteAs(t, ids.userId, s);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textsOf(t)).toEqual(["a1", "a2"]);
    await postTextsInChunks(t, ids.chatId, [cut()]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textsOf(t)).toEqual(["a1"]);
  });
});

describe("pass 13 #2 — a re-sent message's EARLIER sends go with it too", () => {
  const SA = `webchat-${"a".repeat(64)}`;
  const SB = `webchat-${"b".repeat(64)}`;

  test("on, then rolled back to shadow: deleting the message purges the unassigned text of its first send", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const asUser = t.withIdentity({ subject: `${ids.userId}|session` });
    // Settle seed's turn so the new send dispatches at once.
    await t.run(async (ctx) => {
      for (const o of await ctx.db.query("outbox").collect()) await ctx.db.delete(o._id);
      await ctx.db.delete(ids.userMessageId);
    });
    const { outboxId } = await asUser.mutation(api.send.sendMessage, { chatId: ids.chatId, text: "question B", clientMessageId: "b" });
    const target = { instanceName: "prod", agentId: "main" };
    await t.mutation(internal.bridge.lastGateBeforeSend, { outboxId, target, sendId: SA });
    const userMsg = (await t.run((ctx) => ctx.db.get(outboxId)))!.messageId!;
    expect((await t.run((ctx) => ctx.db.get(userMsg)))?.sendId).toBe(SA);
    // Send A ran far enough for its answer's text to be stored (unassigned).
    await postTextsInChunks(t, ids.chatId, [said("x1", 7, SA, "Réponse A secrète.")]);
    // The dispatch then failed: an error card; deleting it (it has no run) regenerates.
    await t.mutation(internal.bridge.failDispatch, { outboxId, reason: "send_failed" });
    const card = (await assistants(t, ids.chatId)).find((m) => m.status === "error");
    expect(card).toBeDefined();
    expect(card?.runId).toBeUndefined();
    await asUser.mutation(api.messages.deleteMessage, { messageId: card!._id });
    const regen = (await t.run((ctx) => ctx.db.query("outbox").collect())).find((o) => o._id !== outboxId && o.messageId === userMsg);
    expect(regen).toBeDefined();
    await t.mutation(internal.bridge.lastGateBeforeSend, { outboxId: regen!._id, target, sendId: SB });
    await t.mutation(internal.bridge.markOutbox, { outboxId: regen!._id, status: "sent", sendId: SB } as never);
    expect((await t.run((ctx) => ctx.db.get(userMsg)))?.sendId).toBe(SB);
    // Rolled back to shadow; the person deletes the message.
    await setMode(t, "shadow");
    await asUser.mutation(api.messages.deleteMessage, { messageId: userMsg });
    // In the deletion's own transaction (no read): both sends' runs are tombstoned — the
    // message kept its earlier send identity when the regenerate re-stamped it.
    const atOnce = await t.run((ctx) => ctx.db.query("transcriptTombstones").collect());
    expect(new Set(atOnce.filter((x) => x.sessionKey === "").map((x) => x.runId))).toEqual(new Set([SA, SB]));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    const tombs = await t.run((ctx) => ctx.db.query("transcriptTombstones").collect());
    expect(new Set(tombs.filter((x) => x.sessionKey === "").map((x) => x.runId))).toEqual(new Set([SA, SB]));
  });
});

describe("pass 13 #2 (bis) — sends past the inline bound are tombstoned by the follow-up", () => {
  test("on: 20 sends of one message — the 18th's stored text is purged, every send tombstoned", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("outbox", {
          chatId: ids.chatId,
          userId: ids.userId,
          clientMessageId: `r${i}`,
          messageId: ids.userMessageId,
          text: "question A",
          attachmentIds: [],
          status: "failed",
          sendId: `send-r${i}`,
        } as never);
      }
    });
    await postTextsInChunks(t, ids.chatId, [said("r17", 9, "send-r17", "Réponse d'un ancien envoi.")]);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: ids.userMessageId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    const tombs = await t.run((ctx) => ctx.db.query("transcriptTombstones").collect());
    const runs = new Set(tombs.filter((x) => x.sessionKey === "").map((x) => x.runId));
    expect(runs.size).toBe(21);
    for (let i = 0; i < 20; i++) expect(runs.has(`send-r${i}`)).toBe(true);
  });
});

describe("pass 14 #1 — the deletion's follow-up is bounded in BYTES read, outbox prompts included", () => {
  test("on then rolled back: 33 regenerated sends of a 600 000-byte prompt — the follow-up completes, the old send's text is purged", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const prompt = "p".repeat(600_000);
    for (let k = 0; k < 33; k += 4) {
      await t.run(async (ctx) => {
        for (let i = k; i < Math.min(k + 4, 33); i++) {
          await ctx.db.insert("outbox", {
            chatId: ids.chatId,
            userId: ids.userId,
            clientMessageId: `big${i}`,
            messageId: ids.userMessageId,
            text: prompt,
            attachmentIds: [],
            status: "failed",
            sendId: `send-big${i}`,
          } as never);
        }
      });
    }
    await postTextsInChunks(t, ids.chatId, [said("b30", 9, "send-big30", "Réponse d'un ancien envoi.")]);
    await setMode(t, "shadow");
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: ids.userMessageId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(0);
    const runs = new Set((await t.run((ctx) => ctx.db.query("transcriptTombstones").collect())).map((x) => x.runId));
    for (let i = 0; i < 33; i++) expect(runs.has(`send-big${i}`)).toBe(true);
  }, 120_000);
});

describe("pass 14 #3 — the live terminal of the same run tells WHY a transcript-born error bubble failed", () => {
  async function bornError(t: T) {
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse partielle")], {
      terminals: [terminal("sendA", "error")],
      hasActiveRun: false,
    });
    const born = (await assistants(t, ids.chatId)).find((m) => m.runId === "sendA")!;
    expect(born.status).toBe("error");
    expect(born.error).toBeUndefined();
    expect(born.errorCode).toBeUndefined();
    return { ...ids, born };
  }
  const liveError = async (t: T, chatId: Id<"chats">) => {
    const landed = (await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: "sendA",
      turnSessionKey: SK,
      boundInstanceName: "prod",
    })) as Id<"messages">;
    return {
      landed,
      res: (await t.mutation(internal.stream.finalize, {
        messageId: landed,
        status: "error",
        error: "insufficient credits",
        errorKind: "provider_billing",
        expectedRunId: "sendA",
        boundInstanceName: "prod",
      } as never)) as { transitioned: boolean },
    };
  };

  test("on: the bubble born first gets the cause and its code — and nothing re-runs", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await bornError(t);
    const before = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const { landed, res } = await liveError(t, ids.chatId);
    expect(landed).toBe(ids.born._id);
    expect(res.transitioned).toBe(false);
    const doc = await get(t, ids.born._id);
    expect(doc?.status).toBe("error");
    expect(doc?.text).toBe("Réponse partielle");
    expect(doc?.errorCode).toBe("provider_billing");
    expect(doc?.error).toBe("insufficient credits");
    // No side effect of a terminal ran again (no retry, no drain, no notification step).
    const after = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(after.length).toBe(before.length);
  });

  test("after a rollback to shadow: the bubble the live run already landed on gets its cause when its terminal arrives", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await bornError(t);
    // The live run landed on the born bubble while `on`…
    const landed = (await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: "sendA",
      turnSessionKey: SK,
      boundInstanceName: "prod",
    })) as Id<"messages">;
    expect(landed).toBe(ids.born._id);
    // …the instance is rolled back, then its terminal arrives.
    await setMode(t, "shadow");
    const before = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const res = (await t.mutation(internal.stream.finalize, {
      messageId: landed,
      status: "error",
      error: "insufficient credits",
      errorKind: "provider_billing",
      expectedRunId: "sendA",
      boundInstanceName: "prod",
    } as never)) as { transitioned: boolean };
    expect(res.transitioned).toBe(false);
    const doc = await get(t, landed);
    expect(doc?.errorCode).toBe("provider_billing");
    expect(doc?.error).toBe("insufficient credits");
    expect(doc?.status).toBe("error");
    const after = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(after.length).toBe(before.length);
  });

  test("on: a cause already known is never overwritten, and a bubble the LIVE stream settled is untouched", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await bornError(t);
    await liveError(t, ids.chatId);
    await t.mutation(internal.stream.finalize, {
      messageId: ids.born._id,
      status: "error",
      error: "something else",
      errorKind: "provider_internal",
    } as never);
    const doc = await get(t, ids.born._id);
    expect(doc?.errorCode).toBe("provider_billing");
    expect(doc?.error).toBe("insufficient credits");
  });
});

describe("pass 15 #2 — admissions are read without their prompts", () => {
  test("on: 20 admitted sends of a 900 000-byte prompt — the next read commits and releases what is over", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const asUser = t.withIdentity({ subject: `${ids.userId}|session` });
    const prompt = "q".repeat(900_000);
    const outboxes: Array<Id<"outbox">> = [];
    for (let i = 0; i < 20; i++) {
      const { outboxId } = await asUser.mutation(api.send.sendMessage, { chatId: ids.chatId, text: prompt, clientMessageId: `big-${i}` });
      await t.mutation(internal.bridge.markOutbox, { outboxId, status: "sent" } as never);
      outboxes.push(outboxId);
    }
    const admitted = await t.run((ctx) => ctx.db.query("runAdmissions").collect());
    expect(admitted.length).toBe(20);
    // An idle read: it commits (cursor moved) — whatever the prompts weigh.
    const res = (await apply(t, ids.chatId, [], { hasActiveRun: false })) as { ok: boolean };
    expect(res.ok).toBe(true);
    // Stale admissions are dropped by the walk too.
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await apply(t, ids.chatId, [], { hasActiveRun: false });
    expect(await t.run((ctx) => ctx.db.query("runAdmissions").collect())).toHaveLength(0);
  }, 120_000);

  test("on: an admission goes with its conversation", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const { outboxId } = await t
      .withIdentity({ subject: `${ids.userId}|session` })
      .mutation(api.send.sendMessage, { chatId: ids.chatId, text: "encore", clientMessageId: "adm" });
    await t.mutation(internal.bridge.markOutbox, { outboxId, status: "sent" } as never);
    expect(await t.run((ctx) => ctx.db.query("runAdmissions").collect())).toHaveLength(1);
    await t.run((ctx) => cascadeDeleteChat(ctx, ids.chatId, { inline: false }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("runAdmissions").collect())).toHaveLength(0);
  });
});

describe("pass 16 #1 — a finished service job's purge never touches the next job's texts", () => {
  test("on: job 1 swept, job 2 stores its text before the purge runs — only job 1's text goes", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const hidden = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: ids.userId, updatedAt: 1, kind: "summarizer" as const, instanceName: "prod", agentId: "main", transcriptSeenAt: 1 }),
    );
    const row = (entryId: string, sessionKey: string, runId: string) => ({
      chatId: hidden, instanceName: "prod", sessionKey, sessionId: "s", entryId, seq: 2, role: "assistant", runId, hidden: false, visible: true, updatedAt: 1,
    });
    await t.run((ctx) => insertRowWithText(ctx, row("j1", "agent:main:summarizer:job1", "run-1"), "Résumé du job 1."));
    // Job 1 is over: the sweep starts (later) and schedules the purge of its texts.
    vi.setSystemTime(Date.now() + 1_000);
    await t.mutation(internal.chatSummaries.sweepHiddenChat, { hiddenChatId: hidden });
    // Job 2 starts and stores its text before that purge step runs.
    vi.setSystemTime(Date.now() + 1_000);
    await t.run((ctx) => insertRowWithText(ctx, row("j2", "agent:main:summarizer:job2", "run-2"), "Résumé du job 2."));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await rowsOf(t, hidden);
    const j1 = rows.find((r) => r.entryId === "j1")!;
    const j2 = rows.find((r) => r.entryId === "j2")!;
    expect(j1.textSig).toBe(TEXT_PURGED_SIG);
    expect(j2.textSig).not.toBe(TEXT_PURGED_SIG);
    expect(await docsOfRow(t, "j1")).toHaveLength(0);
    expect((await docsOfRow(t, "j2")).map((d) => d.text)).toEqual(["Résumé du job 2."]);
  });
});

describe("pass 16 #3 — after a rollback, a live start lands on the answer already projected", () => {
  test("rolled back to shadow before the live start: no second answer, one summarize check", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse.")], {
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    const born = (await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA");
    expect(born).toHaveLength(1);
    await setMode(t, "shadow");
    const before = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length;
    const landed = await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: "sendA",
      turnSessionKey: SK,
      boundInstanceName: "prod",
    });
    expect(landed).toBe(born[0]!._id);
    await t.mutation(internal.stream.finalize, {
      messageId: landed as Id<"messages">,
      status: "complete",
      text: "Réponse.",
      expectedRunId: "sendA",
    } as never);
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "sendA")).toHaveLength(1);
    const after = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(after.length).toBe(before);
  });
});

describe("pass 18 #3 — an idle read settles only the runs it could have seen", () => {
  test("on: idle read issued → a new run starts live → the delayed idle reply leaves the new run open", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse A.")], {
      hasActiveRun: true,
      activeRunIds: ["sendA"],
      readAt: Date.now() + 100,
    });
    // The idle read is ISSUED now (readAt 200)… then the new run starts and its live rows land.
    const b = await liveBubble(t, ids, "runN", "Début de la ré");
    await apply(t, ids.chatId, [said("n1", 5, "runN", "Début de la ré")], { kind: "live" });
    // …and the delayed idle reply arrives: it saw the transcript up to seq 2 only.
    await apply(t, ids.chatId, [], { hasActiveRun: false, readAt: Date.now() + 200 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const runs = await t.run((ctx) => ctx.db.query("transcriptRuns").collect());
    expect(runs.find((r) => r.runId === "runN")?.settledAt).toBeUndefined();
    expect(runs.find((r) => r.runId === "sendA")?.settledAt).toBeTypeOf("number");
    expect((await get(t, b))?.status).toBe("streaming");
  });

  test("on: the same bound rides the continuation (60 open runs seen, one new run beyond)", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await t.run(async (ctx) => {
      for (let r = 0; r < 60; r++) {
        await ctx.db.insert("transcriptRuns", {
          chatId: ids.chatId, sessionKey: SK, runId: `old${r}`, status: "persisted", firstSeq: 10 + r, lastSeq: 10 + r, updatedAt: 1,
        });
      }
    });
    await cursorSaw(t, ids.chatId, 100);
    await apply(t, ids.chatId, [said("n1", 500, "runN", "Début")], { kind: "live" });
    await apply(t, ids.chatId, [], { hasActiveRun: false, readAt: Date.now() + 300 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const runs = await t.run((ctx) => ctx.db.query("transcriptRuns").collect());
    expect(runs.filter((r) => r.runId.startsWith("old") && r.settledAt === undefined)).toHaveLength(0);
    expect(runs.find((r) => r.runId === "runN")?.settledAt).toBeUndefined();
  });
});

describe("pass 19 #3 — an idle read releases an admission only on a row it could have seen", () => {
  test("on: idle read delayed (POST timeout) → new send admitted → its live user row → the idle reply keeps the admission", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const SB = `webchat-${"b".repeat(64)}`;
    const issuedAt = Date.now() + 100;
    // The new send is admitted after the idle read was ISSUED…
    const { outboxId } = await t
      .withIdentity({ subject: `${ids.userId}|session` })
      .mutation(api.send.sendMessage, { chatId: ids.chatId, text: "et ensuite ?", clientMessageId: "adm-b" });
    await t.mutation(internal.bridge.lastGateBeforeSend, { outboxId, target: { instanceName: "prod", agentId: "main" }, sendId: SB });
    await t.mutation(internal.bridge.markOutbox, { outboxId, status: "sent", sendId: SB } as never);
    expect(await admittedAt(t, outboxId)).toBeTypeOf("number");
    // …its user row arrives live…
    await apply(t, ids.chatId, [user("ub", 10, SB)], { kind: "live" });
    // …and the delayed idle reply lands: it saw nothing of this send.
    await apply(t, ids.chatId, [], { hasActiveRun: false, readAt: issuedAt });
    expect(await admittedAt(t, outboxId)).toBeTypeOf("number");
  });

  test("on: a user row the idle read DID see still releases its admission", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const SB = `webchat-${"b".repeat(64)}`;
    const { outboxId } = await t
      .withIdentity({ subject: `${ids.userId}|session` })
      .mutation(api.send.sendMessage, { chatId: ids.chatId, text: "et ensuite ?", clientMessageId: "adm-b2" });
    await t.mutation(internal.bridge.lastGateBeforeSend, { outboxId, target: { instanceName: "prod", agentId: "main" }, sendId: SB });
    await t.mutation(internal.bridge.markOutbox, { outboxId, status: "sent", sendId: SB } as never);
    await apply(t, ids.chatId, [user("ub", 10, SB)], { hasActiveRun: false, readAt: Date.now() + 100 });
    expect(await admittedAt(t, outboxId)).toBeUndefined();
  });
});

describe("pass 21 — the bridge finds the bubble the transcript made for a run it closed", () => {
  async function bornA(t: T) {
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse.")], {
      terminals: [terminal("sendA")],
      hasActiveRun: false,
    });
    const born = (await assistants(t, ids.chatId)).find((m) => m.runId === "sendA")!;
    return { ...ids, born };
  }
  const ask = (t: T, chatId: Id<"chats">, over: Record<string, unknown> = {}) =>
    t.query(internal.transcriptProjection.projectedBubble, {
      chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      runId: "sendA",
      segment: 0,
      ...over,
    } as never) as Promise<{ messageId: string | null }>;

  test("on: found — and ONLY for this instance, session, run and segment", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await bornA(t);
    expect((await ask(t, ids.chatId)).messageId).toBe(ids.born._id);
    expect((await ask(t, ids.chatId, { boundInstanceName: "intruder" })).messageId).toBeNull();
    expect((await ask(t, ids.chatId, { sessionKey: `${SK}:other` })).messageId).toBeNull();
    expect((await ask(t, ids.chatId, { runId: "sendB" })).messageId).toBeNull();
    expect((await ask(t, ids.chatId, { segment: 1 })).messageId).toBeNull();
    expect((await ask(t, ids.chatId, { segment: -1 })).messageId).toBeNull();
  });

  test("after a rollback to shadow: still found (the run was closed while `on`)", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await bornA(t);
    await setMode(t, "shadow");
    expect((await ask(t, ids.chatId)).messageId).toBe(ids.born._id);
  });

  test("a conversation that never stored text answers none", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "shadow");
    expect((await ask(t, ids.chatId)).messageId).toBeNull();
  });

  test("through the bridge ingest, with the instance's own secret", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await bornA(t);
    const { admin, instanceId } = await t.run(async (ctx) => {
      const admin = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: admin, role: "admin" as const });
      const instance = (await ctx.db.query("instances").collect())[0]!;
      return { admin, instanceId: instance._id };
    });
    const minted = await t
      .withIdentity({ subject: `${admin}|session` })
      .action(api.bridgeAuth.mintBridgeSecret, { instanceId });
    const res = await t.fetch("/bridge/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${minted.plaintext}` },
      body: JSON.stringify({ op: "projectedBubble", chatId: ids.chatId, sessionKey: SK, runId: "sendA", segment: 0 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { messageId: string | null }).messageId).toBe(ids.born._id);
  });
});

describe("pass 24 #2 — the run's live terminal corrects an outcome an idle read only inferred", () => {
  const liveError = (t: T, messageId: Id<"messages">) =>
    t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "insufficient credits",
      errorKind: "provider_billing",
      expectedRunId: "sendA",
      boundInstanceName: "prod",
      finalizeCause: "gateway_final",
    } as never) as Promise<{ transitioned: boolean }>;

  for (const rolledBack of [false, true]) {
    test(`live bubble closed by an idle read, then chat:error: it becomes the error${rolledBack ? " (rolled back)" : ""}`, async () => {
      vi.useFakeTimers();
      const t = convexTest({ schema, modules, transactionLimits: true });
      const ids = await seed(t, "on");
      const b = await liveBubble(t, ids, "sendA", "Réponse parti");
      await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse parti")], { hasActiveRun: false });
      const closed = await get(t, b);
      expect(closed?.status).toBe("complete");
      expect(closed?.closeInferred).toBe(true);
      if (rolledBack) await setMode(t, "shadow");
      const before = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length;
      await liveError(t, b);
      const doc = await get(t, b);
      expect(doc?.status).toBe("error");
      expect(doc?.errorCode).toBe("provider_billing");
      expect(doc?.error).toBe("insufficient credits");
      expect(doc?.text).toBe("Réponse parti");
      expect(doc?.closeInferred).toBeUndefined();
      // Nothing of a terminal re-ran.
      expect((await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length).toBe(before);
      // Idempotent: a replayed terminal changes nothing.
      await liveError(t, b);
      expect((await get(t, b))?.status).toBe("error");
    });
  }

  test("born from an idle read (no live bubble), then chat:error: corrected too", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse parti")], { hasActiveRun: false });
    const born = (await assistants(t, ids.chatId)).find((m) => m.runId === "sendA")!;
    expect(born.closeInferred).toBe(true);
    await liveError(t, born._id);
    expect((await get(t, born._id))?.status).toBe("error");
  });

  test("an EXPLICIT terminal's outcome is never overridden", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const b = await liveBubble(t, ids, "sendA", "Réponse.");
    await apply(t, ids.chatId, [user("u1", 1, "sendA"), said("a1", 2, "sendA", "Réponse.")], {
      terminals: [terminal("sendA", "completed")],
      hasActiveRun: false,
    });
    expect((await get(t, b))?.closeInferred).toBeUndefined();
    await liveError(t, b);
    expect((await get(t, b))?.status).toBe("complete");
  });
});

describe("pass 27 — a deleted span is identified by a STABLE boundary, never by an ordinal", () => {
  /** Run R: segment 0 answer (seq 20), a known cut at 30, the segment-1 answer (seq 35,
   *  assigned to its bubble), then an UNASSIGNED copy at 40 (a text chunk ahead of a read). */
  async function codexSequence(t: T, rollback: boolean) {
    const ids = await seed(t, "on");
    const seg1 = await t.run(async (ctx) => {
      const m = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "partie 1",
        runId: "R",
        runSegment: 1,
        turnSessionKey: SK,
        boundInstance: "prod",
        updatedAt: 1,
      });
      return m;
    });
    await postTextsInChunks(t, ids.chatId, [
      said("a0", 20, "R", "partie 0"),
      user("c30", 30, "sendS", { steerTargetRunId: "R" }),
      said("a1", 35, "R", "partie 1"),
      said("a1b", 40, "R", "SECRET copie 40"),
    ]);
    await t.run(async (ctx) => {
      const a1 = (await ctx.db.query("transcriptRows").collect()).find((r) => r.entryId === "a1")!;
      await ctx.db.patch(a1._id, { messageId: seg1 });
    });
    if (rollback) await setMode(t, "shadow");
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: seg1 });
    // A LATE, EARLIER cut lands before the deletion's follow-up has run.
    await apply(t, ids.chatId, [user("c10", 10, "sendT", { steerTargetRunId: "R" })], { kind: "live" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return { ...ids, seg1 };
  }
  const secretTexts = (t: T) =>
    t.run(async (ctx) => (await ctx.db.query("transcriptRowTexts").collect()).filter((d) => (d.text ?? "").includes("SECRET")).length);

  test("on: the copy stays purged and a later row recreates nothing of the deleted span", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await codexSequence(t, false);
    expect(await secretTexts(t)).toBe(0);
    // A new row of the run, then its terminal.
    await apply(t, ids.chatId, [said("a2", 50, "R", "SECRET suite 50")], { kind: "live", textsOnly: true });
    await apply(t, ids.chatId, [said("a0", 20, "R", ""), user("c10", 10, "sendT", { steerTargetRunId: "R" }), user("c30", 30, "sendS", { steerTargetRunId: "R" }), said("a1", 35, "R", ""), said("a1b", 40, "R", ""), said("a2", 50, "R", "")].map(identityOnly), {
      terminals: [terminal("R")],
      hasActiveRun: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await secretTexts(t)).toBe(0);
    const answers = (await assistants(t, ids.chatId)).filter((m) => m.runId === "R");
    expect(answers.some((m) => (m.text ?? "").includes("SECRET"))).toBe(false);
  });

  test("after a rollback to shadow: the copy's text is purged anyway", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    await codexSequence(t, true);
    expect(await secretTexts(t)).toBe(0);
  });

  test("property: random late cuts around a deleted span never bring a deleted row back", async () => {
    // Deterministic pseudo-random sequence (no flakiness).
    let state = 27;
    const rand = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (let trial = 0; trial < 40; trial++) {
      const known = [...new Set(Array.from({ length: 1 + rand(4) }, () => 10 + rand(90)))].sort((a, b) => a - b);
      const k = 1 + rand(known.length); // the deleted segment (ordinal at deletion)
      const realFrom = known[k - 1]!;
      // Resolved as the follow-up would, after 0–3 late cuts anywhere.
      const late = Array.from({ length: rand(4) }, () => 1 + rand(120));
      const now = [...new Set([...known, ...late])].sort((a, b) => a - b);
      const { tombstoneHit: hitOf, boundaryOfOrdinal } = await import("./lib/transcriptProjection");
      const from = boundaryOfOrdinal(k, { seqs: now, sends: [], complete: true });
      expect(from).toBeLessThanOrEqual(realFrom);
      const tombs = new Map<number, Id<"messages"> | undefined>([[k, undefined]]);
      // Every row of the original span (past its real start), before or after more late
      // cuts, is still a hit — through the ordinal AND through the frozen boundary.
      const more = [...new Set([...now, ...Array.from({ length: rand(4) }, () => 1 + rand(120))])].sort((a, b) => a - b);
      for (let seq = realFrom + 1; seq <= 130; seq += 1 + rand(5)) {
        expect(hitOf(tombs, { seqs: now, sends: [], complete: true }, seq)).not.toBeNull();
        expect(seq > from).toBe(true);
        expect(hitOf(tombs, { seqs: more, sends: [], complete: true }, seq)).not.toBeNull();
      }
    }
  });
});

describe("pass 27 — a resolved boundary is FROZEN: later cuts never stretch it backwards", () => {
  test("on: segment 2 deleted (cuts 30, 60) — a late cut at 45 leaves the answer at 50 alone", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await postTextsInChunks(t, ids.chatId, [
      user("c30", 30, "s30", { steerTargetRunId: "R" }),
      user("c60", 60, "s60", { steerTargetRunId: "R" }),
    ]);
    const seg2 = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: ids.chatId, userId: ids.userId, role: "assistant" as const, status: "complete" as const,
        text: "partie 2", runId: "R", runSegment: 2, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1,
      }),
    );
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: seg2 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const tomb = await t.run(async (ctx) => (await ctx.db.query("transcriptTombstones").collect()).find((x) => x.runId === "R"));
    expect(tomb?.fromSeq).toBe(60);
    // A late steer at 45 and its answer at 50: not the deleted span.
    await postTextsInChunks(t, ids.chatId, [user("c45", 45, "s45", { steerTargetRunId: "R" }), said("a50", 50, "R", "réponse au steer 45")]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await textCount(t)).toBe(1);
  });
});

describe("pass 27 — boundaries are exact where they are known", () => {
  test("on: a deleted STEER (cut 30) — a late, earlier steer (cut 10) and its answer (20) are kept", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    const s = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId: ids.chatId, userId: ids.userId, role: "user" as const, status: "complete" as const,
        text: "et aussi ?", sendId: "sendS", updatedAt: 2,
      });
      return id;
    });
    await postTextsInChunks(t, ids.chatId, [user("c30", 30, "sendS", { steerTargetRunId: "R" })]);
    await t.withIdentity({ subject: `${ids.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: s });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await postTextsInChunks(t, ids.chatId, [
      user("c10", 10, "sendT", { steerTargetRunId: "R" }),
      said("a20", 20, "R", "réponse au steer 10"),
      said("a35", 35, "R", "SECRET réponse au steer supprimé"),
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const kept = await t.run(async (ctx) => (await ctx.db.query("transcriptRowTexts").collect()).map((d) => d.text));
    expect(kept).toEqual(["réponse au steer 10"]);
  });

  test("on: the projection itself reads a stored boundary — rows past it make no bubble", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    // A boundary already resolved, and texts stored before it existed (the purge not run yet).
    await t.run(async (ctx) => {
      await ctx.db.insert("transcriptTombstones", { chatId: ids.chatId, sessionKey: SK, runId: "R", segment: 0, fromSeq: -1, createdAt: 1 });
      for (const [entryId, seq, text] of [["r1", 5, "SECRET un"], ["r2", 6, "SECRET deux"]] as const) {
        await insertRowWithText(ctx, { chatId: ids.chatId, instanceName: "prod", sessionKey: SK, sessionId: "s-1", entryId, seq, role: "assistant", runId: "R", hidden: false, visible: true, updatedAt: 1 }, text);
      }
    });
    await apply(t, ids.chatId, [said("r1", 5, "R", ""), said("r2", 6, "R", "")].map(identityOnly), { terminals: [terminal("R")], hasActiveRun: false });
    expect((await assistants(t, ids.chatId)).filter((m) => m.runId === "R")).toHaveLength(0);
  });
});

describe("pass 27 — the live door is not fooled by a stale segment count", () => {
  test("on: span from 30 deleted, a late cut at 10 — the bridge reopening its segment 1 is refused", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, "on");
    await t.run((ctx) => ctx.db.insert("transcriptTombstones", { chatId: ids.chatId, sessionKey: SK, runId: "R", segment: 30, fromSeq: 30, createdAt: 1 }));
    await postTextsInChunks(t, ids.chatId, [user("c10", 10, "sendT", { steerTargetRunId: "R" }), user("c30", 30, "sendS", { steerTargetRunId: "R" })]);
    const opened = await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: "R", turnSessionKey: SK, runSegment: 1 } as never);
    expect(opened).toBeNull();
    // The run's first segment (before the first cut) still opens.
    const first = await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: "R", turnSessionKey: SK } as never);
    expect(first).not.toBeNull();
  });
});
