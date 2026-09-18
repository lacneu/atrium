/// <reference types="vite/client" />
//
// A SNAPSHOT freezes the sentence, so it outlives the row it was copied from.
//
// That is why the two report tables are not like the others: fixing the live rows
// leaves a feedback report and a sub-agent report holding the credential id forever,
// and a report created while the migration is still walking the tables copies a row it
// has not reached yet (codex). The incident that opened this lot was found IN one of
// these snapshots.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const RAW =
  'Auth profile "openai:olivier@lacneu.com" is temporarily unavailable for openai/x.';

describe("a report never freezes the credential id", () => {
  test("a feedback snapshot stores the masked sentence", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "error" as const,
        text: "",
        // A row written BEFORE the migration reached it.
        error: RAW,
        updatedAt: 1,
      });
      return { userId, chatId, messageId };
    });

    const asUser = t.withIdentity({ subject: `${userId}|session` });
    await asUser.mutation(api.feedback.submitFeedback, {
      chatId,
      messageId,
      category: "api_error",
    });

    const rows = await t.run((ctx) => ctx.db.query("feedback").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.snapshot.messageError).toBe('Auth profile "…');
  });

  test("a sub-agent report snapshot stores the masked sentence", async () => {
    const t = convexTest(schema, modules);
    const { userId, subAgentId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const subAgentId = await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "c1",
        status: "error" as const,
        errorMessage: RAW,
        updatedAt: 1,
        createdAt: 1,
      });
      return { userId, subAgentId };
    });

    const asUser = t.withIdentity({ subject: `${userId}|session` });
    await asUser.mutation(api.subAgentReports.createSubAgentReport, {
      subAgentId,
      category: "other",
    });

    const rows = await t.run((ctx) => ctx.db.query("subAgentReports").collect());
    expect(rows).toHaveLength(1);
    const child = rows[0]?.snapshot.children.find((c) => c.childSessionKey === "c1");
    expect(child?.errorMessage).toBe('Auth profile "…');
  });
});
