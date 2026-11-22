/// <reference types="vite/client" />
//
// A LATE FINAL IS WRITTEN ONCE, HOWEVER MANY TIMES IT IS ASKED.
//
// A "late final" (CU-8) is a `chat final` of a run whose turn is already settled. When the
// run left no bubble, the write OPENS one — and a repeat of that write could not be told
// from another turn's late final (two turns can re-use one run id and say the same thing),
// so it was asked once: one transient failure lost the text.
//
// The bridge now names each WRITE (a key it mints once per late final and keeps across
// its retries). Convex remembers which bubble a key opened: a repeat is answered with that
// bubble, another key opens its own.
//
// The real writer (bridge/src/convex-writer.ts) against the real ingest handler, with the
// failures placed between them.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { HttpConvexWriter } from "../bridge/src/convex-writer";
import { cascadeDeleteChat } from "./chats";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

const RUN = "webchat-" + "a".repeat(64);
const SK = "agent:main:atrium:chat:u:c1";

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function seed(t: T) {
  const seeded = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" as const });
    const instanceId = await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://prod" });
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    // A projected conversation: its first transcript read set the marker.
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", transcriptSeenAt: 1 });
    return { admin, instanceId, userId, chatId };
  });
  const minted = await t
    .withIdentity({ subject: `${seeded.admin}|session` })
    .action(api.bridgeAuth.mintBridgeSecret, { instanceId: seeded.instanceId });
  return { ...seeded, secret: minted.plaintext };
}

/** What stands between the writer and Convex for one POST. */
type Fault =
  | "ok"
  /** Convex never gets the request: the edge answers 503. */
  | "503"
  /** Convex commits the write and its answer is lost on the way back. */
  | "lost-answer"
  /** A Convex from before this op: the request is answered as an unknown op. */
  | "old-convex";

/** The real writer, its POSTs sent to the real handler through `faults` (the last one
 *  repeats). Records each op posted, in order. */
function writerThrough(t: T, secret: string, faults: Fault[]) {
  const posted: Array<Record<string, unknown>> = [];
  let n = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posted.push(body);
    const fault = faults[Math.min(n++, faults.length - 1)] ?? "ok";
    if (fault === "503") return new Response("upstream unavailable", { status: 503 });
    if (fault === "old-convex" && body.op === "appendLateFinalKeyed") {
      return new Response(JSON.stringify({ ok: false, error: "unknown op" }), { status: 400 });
    }
    const res = await t.fetch("/bridge/ingest", { method: "POST", headers: init?.headers as Record<string, string>, body: String(init?.body) });
    if (fault === "lost-answer") throw new TypeError("fetch failed");
    return res;
  }) as unknown as typeof fetch;
  const writer = new HttpConvexWriter({ convexHttpActionsUrl: "http://convex.test", ingestSecret: secret, instanceName: "prod", fetchImpl });
  return { writer, posted };
}

const bubbles = (t: T, chatId: Id<"chats">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter((m) => m.role === "assistant"),
  );

const lateFinal = (chatId: Id<"chats">, writeKey: string, text = "Hello", messageId: string | null = null) => ({
  chatId: String(chatId),
  runId: RUN,
  messageId,
  text,
  sessionKey: SK,
  writeKey,
});

/** The writer's own back-off between two attempts is real time here (0.5 s, then 2 s). */
const settled = <R>(p: Promise<R>): Promise<R> => p;

describe("a late final that opens a bubble is written once", () => {
  test("the answer is lost after the commit, the writer asks again: ONE bubble, and the writer gets it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, secret } = await seed(t);
    const { writer, posted } = writerThrough(t, secret, ["lost-answer", "ok"]);
    const id = await settled(writer.appendLateFinal(lateFinal(chatId, "key-1")));
    const all = await bubbles(t, chatId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ text: "Hello", runId: RUN, status: "complete" });
    expect(id).toBe(String(all[0]!._id));
    expect(posted.map((b) => [b.op, b.writeKey])).toEqual([
      ["appendLateFinalKeyed", "key-1"],
      ["appendLateFinalKeyed", "key-1"],
    ]);
  });

  test("two DISTINCT late finals, same run id, same text: two bubbles", async () => {
    const t = convexTest(schema, modules);
    const { chatId, secret } = await seed(t);
    const { writer } = writerThrough(t, secret, ["ok"]);
    const first = await writer.appendLateFinal(lateFinal(chatId, "key-1"));
    const second = await writer.appendLateFinal(lateFinal(chatId, "key-2"));
    expect(first).not.toBe(second);
    expect((await bubbles(t, chatId)).map((m) => m.text)).toEqual(["Hello", "Hello"]);
    // …and each key still answers ITS bubble.
    expect(await writer.appendLateFinal(lateFinal(chatId, "key-1"))).toBe(first);
    expect(await writer.appendLateFinal(lateFinal(chatId, "key-2"))).toBe(second);
    expect(await bubbles(t, chatId)).toHaveLength(2);
  });

  test("a transient 503, then success: written, once", async () => {
    const t = convexTest(schema, modules);
    const { chatId, secret } = await seed(t);
    const { writer, posted } = writerThrough(t, secret, ["503", "ok"]);
    const id = await settled(writer.appendLateFinal(lateFinal(chatId, "key-1")));
    expect(id).not.toBeNull();
    expect(await bubbles(t, chatId)).toHaveLength(1);
    expect(posted).toHaveLength(2);
  });

  test("a failure that does not pass: bounded (three attempts), and the caller is told", async () => {
    const t = convexTest(schema, modules);
    const { chatId, secret } = await seed(t);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { writer, posted } = writerThrough(t, secret, ["503"]);
    await expect(settled(writer.appendLateFinal(lateFinal(chatId, "key-1")))).rejects.toThrow(/HTTP 503/);
    expect(posted).toHaveLength(3);
    expect(await bubbles(t, chatId)).toHaveLength(0);
  });

  test("a repeat that carries a LONGER view of the same text (the debt's text grew): the bubble it opened takes it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, secret } = await seed(t);
    const { writer } = writerThrough(t, secret, ["lost-answer", "ok"]);
    await settled(writer.appendLateFinal(lateFinal(chatId, "key-1", "Hello")).catch(() => undefined));
    const id = await writer.appendLateFinal(lateFinal(chatId, "key-1", "Hello world"));
    const all = await bubbles(t, chatId);
    expect(all.map((m) => m.text)).toEqual(["Hello world"]);
    expect(id).toBe(String(all[0]!._id));
  });

  test("the bubble a key opened was deleted since: nothing is opened again", async () => {
    const t = convexTest(schema, modules);
    const { chatId, secret } = await seed(t);
    const { writer } = writerThrough(t, secret, ["ok"]);
    const id = (await writer.appendLateFinal(lateFinal(chatId, "key-1")))!;
    await t.run((ctx) => ctx.db.delete(id as Id<"messages">));
    expect(await writer.appendLateFinal(lateFinal(chatId, "key-1"))).toBeNull();
    expect(await bubbles(t, chatId)).toHaveLength(0);
  });

  test("a key of ANOTHER chat is not this chat's", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, secret } = await seed(t);
    const other = await t.run((ctx) => ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", transcriptSeenAt: 1 }));
    const { writer } = writerThrough(t, secret, ["ok"]);
    const a = await writer.appendLateFinal(lateFinal(chatId, "key-1"));
    const b = await writer.appendLateFinal(lateFinal(other, "key-1"));
    expect(a).not.toBe(b);
    expect(await bubbles(t, other)).toHaveLength(1);
  });
});

describe("a late final that JOINS a bubble", () => {
  test("is still joined once: a repeat finds its text there, keyed or not", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, secret } = await seed(t);
    const into = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Reply.", runId: RUN, boundInstance: "prod", updatedAt: 1 }),
    );
    const { writer } = writerThrough(t, secret, ["lost-answer", "ok"]);
    expect(await settled(writer.appendLateFinal(lateFinal(chatId, "key-1", "And more.", String(into))))).toBe(String(into));
    expect((await bubbles(t, chatId)).map((m) => m.text)).toEqual(["Reply.\n\nAnd more."]);
    // The join's key is kept with the bubble it wrote into, once (the repeat adds none).
    expect((await t.run((ctx) => ctx.db.query("lateFinalWrites").collect())).map((r) => [r.writeKey, String(r.messageId)])).toEqual([["key-1", String(into)]]);
  });

  test("its answer is lost, its reader DELETES the bubble, the writer asks again: nothing is recreated", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, secret } = await seed(t);
    const into = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Reply.", runId: RUN, boundInstance: "prod", updatedAt: 1 }),
    );
    // The write commits, its answer is lost; the bubble is deleted before the retry.
    const { writer, posted } = writerThrough(t, secret, ["lost-answer", "ok"]);
    const real = writer as unknown as { doPost: (body: unknown) => Promise<unknown> };
    const post = real.doPost.bind(writer);
    let attempts = 0;
    real.doPost = async (body) => {
      if (attempts++ === 1) await t.run((ctx) => ctx.db.delete(into));
      return post(body);
    };
    expect(await settled(writer.appendLateFinal(lateFinal(chatId, "key-1", "And more.", String(into))))).toBeNull();
    expect(posted).toHaveLength(2);
    expect(await bubbles(t, chatId)).toEqual([]);
  });

  test("a join in a conversation WITHOUT the transcript marker gives it the marker: its key goes with the conversation", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId } = await seed(t);
    await t.run((ctx) => ctx.db.patch(chatId, { transcriptSeenAt: undefined }));
    const into = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Reply.", runId: RUN, boundInstance: "prod", updatedAt: 1 }),
    );
    await t.mutation(internal.stream.appendLateFinal, { chatId, runId: RUN, messageId: into, text: "And more.", turnSessionKey: SK, boundInstanceName: "prod", writeKey: "key-1" } as never);
    expect((await t.run((ctx) => ctx.db.get(chatId)))?.transcriptSeenAt).toBeDefined();
    expect(await t.run((ctx) => ctx.db.query("lateFinalWrites").collect())).toHaveLength(1);
  });
});

describe("mixed deployments", () => {
  test("an OLDER bridge (no key): today's behaviour — each call opens a bubble, nothing is remembered", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const args = { chatId, runId: RUN, text: "Hello", turnSessionKey: SK, boundInstanceName: "prod" } as never;
    const first = await t.mutation(internal.stream.appendLateFinal, args);
    const second = await t.mutation(internal.stream.appendLateFinal, args);
    expect(first).not.toEqual(second);
    expect(await t.run((ctx) => ctx.db.query("lateFinalWrites").collect())).toEqual([]);
  });

  test("a NEWER bridge on an older Convex: the keyed op is refused, the write is asked ONCE without a key", async () => {
    const t = convexTest(schema, modules);
    const { chatId, secret } = await seed(t);
    const { writer, posted } = writerThrough(t, secret, ["old-convex", "ok"]);
    const id = await writer.appendLateFinal(lateFinal(chatId, "key-1"));
    expect(id).not.toBeNull();
    expect(posted.map((b) => [b.op, "writeKey" in b])).toEqual([
      ["appendLateFinalKeyed", true],
      ["appendLateFinal", false],
    ]);
    expect(await bubbles(t, chatId)).toHaveLength(1);
  });

  test("…and when that single unkeyed attempt fails, it is NOT repeated — the error says it was asked once", async () => {
    const t = convexTest(schema, modules);
    const { chatId, secret } = await seed(t);
    const { writer, posted } = writerThrough(t, secret, ["old-convex", "lost-answer"]);
    const err = await settled(writer.appendLateFinal(lateFinal(chatId, "key-1"))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { askedOnce?: unknown }).askedOnce).toBe(true);
    expect(posted.map((b) => b.op)).toEqual(["appendLateFinalKeyed", "appendLateFinal"]);
    // The old Convex committed it: one bubble, not two.
    expect(await bubbles(t, chatId)).toHaveLength(1);
  });
});

describe("the keys kept are bounded, and go with their conversation", () => {
  test("a key older than its retention is forgotten when a later write of the chat is recorded", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const open = (writeKey: string) =>
      t.mutation(internal.stream.appendLateFinal, { chatId, runId: RUN, text: "Hello", turnSessionKey: SK, boundInstanceName: "prod", writeKey } as never);
    await open("old-1");
    await open("old-2");
    vi.setSystemTime(1_000_000 + 25 * 3600_000);
    await open("new-1");
    expect((await t.run((ctx) => ctx.db.query("lateFinalWrites").collect())).map((r) => r.writeKey)).toEqual(["new-1"]);
  });

  test("a conversation WITHOUT the transcript marker (its reads failed so far): the answer is lost, the writer asks again — ONE bubble all the same", async () => {
    const t = convexTest(schema, modules);
    const { userId, secret } = await seed(t);
    const plain = await t.run((ctx) => ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod" }));
    const { writer, posted } = writerThrough(t, secret, ["lost-answer", "ok"]);
    const id = await writer.appendLateFinal(lateFinal(plain, "key-1"));
    expect(posted).toHaveLength(2);
    const all = await bubbles(t, plain);
    expect(all.map((m) => m.text)).toEqual(["Hello"]);
    expect(id).toBe(String(all[0]!._id));
    // The key was recorded with the bubble, and the conversation now says the projection
    // wrote something for it: that mark is what its deletion reads to purge the key.
    expect((await t.run((ctx) => ctx.db.query("lateFinalWrites").collect())).map((r) => r.writeKey)).toEqual(["key-1"]);
    expect((await t.run((ctx) => ctx.db.get(plain)))?.transcriptSeenAt).toBeTypeOf("number");
    vi.useFakeTimers();
    await t.run(async (ctx) => {
      await cascadeDeleteChat(ctx, plain);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("lateFinalWrites").collect())).toEqual([]);
  });

  test("deleting the conversation deletes its keys", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await t.mutation(internal.stream.appendLateFinal, { chatId, runId: RUN, text: "Hello", turnSessionKey: SK, boundInstanceName: "prod", writeKey: "k" } as never);
    vi.useFakeTimers();
    await t.run(async (ctx) => {
      await cascadeDeleteChat(ctx, chatId);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(chatId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("lateFinalWrites").collect())).toEqual([]);
  });
});
