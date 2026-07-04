import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// Gateway errorKind persistence (the context_length hard-overflow chain):
// stream.finalize now accepts the gateway's stable failure class
// (ChatErrorEventSchema.errorKind: refusal|timeout|rate_limit|context_length)
// and persists it into the message's EXISTING `errorCode` field — the same
// field the curated dispatch codes use — so loadChatView projects it with no
// new plumbing and the UI maps it to an actionable localized headline.

async function seedStreamingMessage(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
    return { chatId, messageId };
  });
}

describe("stream.finalize errorKind -> errorCode", () => {
  test("a context_length error persists the kind as the message errorCode", async () => {
    const t = convexTest(schema);
    const { messageId } = await seedStreamingMessage(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "Context window exceeded for this model",
      errorKind: "context_length",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.error).toBe("Context window exceeded for this model");
    expect(msg?.errorCode).toBe("context_length");
  });

  test("a clean finalize leaves errorCode untouched (absent)", async () => {
    const t = convexTest(schema);
    const { messageId } = await seedStreamingMessage(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "réponse",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.errorCode).toBeUndefined();
  });
});
