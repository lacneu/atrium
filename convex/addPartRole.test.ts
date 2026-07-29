/// <reference types="vite/client" />
//
// A SEGMENT belongs to an assistant turn, and to nothing else (lot 35).
//
// `/bridge/ingest`'s `addPart` is generic: the bridge posts any part shape through it. A
// mis-correlated `messageId` could therefore attach assistant prose to a USER message,
// where it renders inside the user's own bubble as if they had written it. The renderer
// is guarded too, but a store that accepts the write is a store that will eventually
// show it.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>, role: "user" | "assistant") {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role,
      status: role === "assistant" ? ("streaming" as const) : ("complete" as const),
      text: role === "user" ? "ma question" : "",
      updatedAt: 1,
    });
    return messageId;
  });
}

/** Count this message's parts. Collected and filtered in JS rather than through the
 *  index: the table holds two rows in this test, and the index's typed builder does not
 *  survive convex-test's generic `run` context. */
const partsOf = async (
  t: ReturnType<typeof convexTest>,
  messageId: Id<"messages">,
) =>
  await t.run(async (ctx) => {
    const all = await ctx.db.query("messageParts").collect();
    return all.filter((p) => p.messageId === messageId).length;
  });

describe("addPart(kind:reasoning) and the role boundary", () => {
  test("lands on an assistant message", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "assistant");
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "reasoning", text: "un segment" },
    });
    expect(await partsOf(t, messageId)).toBe(1);
  });

  test("is DROPPED on a user message — never rendered as something they wrote", async () => {
    const t = convexTest(schema, modules);
    const messageId = await seed(t, "user");
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "reasoning", text: "un segment" },
    });
    expect(await partsOf(t, messageId)).toBe(0);
  });
});
