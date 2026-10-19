/// <reference types="vite/client" />
// A live tool card's nesting key (0.101.1) is stored with the part and read back with it —
// the hop from the bridge's `parentToolCallId` to the chat (src/chat/convertMessage.ts).
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

test("a nested call's part keeps its parent through addPart and listByChat", async () => {
  const t = convexTest(schema, modules);
  const { userId, chatId, messageId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
    const messageId = await ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "streaming" as const, text: "", updatedAt: 1 });
    return { userId, chatId, messageId };
  });
  await t.mutation(internal.stream.addPart, { messageId, part: { kind: "tool", name: "exec", phase: "start", toolCallId: "e1" } });
  await t.mutation(internal.stream.addPart, { messageId, part: { kind: "tool", name: "message", phase: "start", toolCallId: "n1", parentToolCallId: "e1" } });
  const list = (await t.withIdentity({ subject: userId }).query(api.messages.listByChat, { chatId: chatId as string })) as unknown as Array<{ parts: Array<{ toolCallId?: string; parentToolCallId?: string }> }>;
  const parts = list.flatMap((m) => m.parts);
  expect(parts.map((p) => [p.toolCallId, p.parentToolCallId])).toEqual([
    ["e1", undefined],
    ["n1", "e1"],
  ]);
});
