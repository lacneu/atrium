// Phase 4b: per-gateway-instance live-stream transport. The instance config carries
// `streamTransport` (reactive | sse); getChatStreamTransport resolves a chat -> its
// instance -> the transport (default reactive). See
// openclaw-notes/docs/atrium/convex-http-streaming-transport.md.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seedUser(t: TestConvex<typeof schema>) {
  const userId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "u" });
    return uid;
  });
  return { userId, asUser: t.withIdentity({ subject: `${userId}|session` }) };
}

describe("getChatStreamTransport", () => {
  // A ROUTED chat: a DEFAULT userAgent on instance "inst1", so resolveTargetForChat (the
  // same routing dispatch uses) resolves "inst1" as the target — the query reads the routed
  // instance's transport, NOT the raw chat.instanceName.
  async function seedRouted(
    tc: TestConvex<typeof schema>,
    opts: { route: boolean; transport?: "reactive" | "sse" },
  ) {
    const { userId, asUser } = await seedUser(tc);
    const chatId = await tc.run(async (ctx) => {
      if (opts.route) {
        await ctx.db.insert("instances", {
          name: "inst1",
          gatewayUrl: "ws://x",
          ...(opts.transport ? { streamTransport: opts.transport } : {}),
        });
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: "inst1",
          agentId: "a1",
          isDefault: true,
          source: "manual",
          createdAt: 1,
        });
      }
      return await ctx.db.insert("chats", { userId, updatedAt: 1 });
    });
    return { userId, asUser, chatId };
  }

  test("returns the ROUTED instance's configured transport (sse)", async () => {
    const t = convexTest(schema, modules);
    const { asUser, chatId } = await seedRouted(t, {
      route: true,
      transport: "sse",
    });
    expect(
      await asUser.query(api.messages.getChatStreamTransport, { chatId }),
    ).toBe("sse");
  });

  test("defaults to reactive when the routed instance has no override", async () => {
    const t = convexTest(schema, modules);
    const { asUser, chatId } = await seedRouted(t, { route: true });
    expect(
      await asUser.query(api.messages.getChatStreamTransport, { chatId }),
    ).toBe("reactive");
  });

  test("defaults to reactive when the chat routes to no instance", async () => {
    const t = convexTest(schema, modules);
    const { asUser, chatId } = await seedRouted(t, { route: false });
    expect(
      await asUser.query(api.messages.getChatStreamTransport, { chatId }),
    ).toBe("reactive");
  });

  test("a non-owner gets the default, not the routed transport (no leak)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedRouted(t, { route: true, transport: "sse" });
    const intruder = await seedUser(t);
    expect(
      await intruder.asUser.query(api.messages.getChatStreamTransport, {
        chatId,
      }),
    ).toBe("reactive");
  });
});
