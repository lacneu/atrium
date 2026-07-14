import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  EXPORT_CHAR_CAP,
  EXPORT_MESSAGE_CAP,
  stripReferenceLabel,
} from "./chatExport";

const modules = import.meta.glob("./**/*.ts");

// Cross-conversation references. Discriminating properties:
//   - the export is OWNER-scoped and resolution is SILENT (null, no
//     existence leak) for foreign/malformed references;
//   - an env-labeled reference (`dev-<id>`) resolves like the bare id;
//   - messages export in the CONVERSATION order, system rows excluded;
//   - over-cap conversations keep the newest window and SAY they truncated.

type T = ReturnType<typeof convexTest>;

async function seedChat(t: T, canonical: string, messages = 3) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "alice",
      title: "Météo Montréal",
    });
    for (let i = 0; i < messages; i++) {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        status: "complete" as const,
        text: `msg-${i}`,
        updatedAt: 1000 + i,
      });
    }
    return { userId, chatId };
  });
}

describe("stripReferenceLabel", () => {
  test("strips an env-label prefix, keeps bare ids intact", () => {
    expect(stripReferenceLabel("dev-abc123")).toBe("abc123");
    expect(stripReferenceLabel("preprod_2.1-abc123")).toBe("abc123");
    expect(stripReferenceLabel("abc123")).toBe("abc123");
    expect(stripReferenceLabel("  dev-abc123  ")).toBe("abc123");
  });
});

describe("chatExport", () => {
  test("getChatReference returns the caller's chat id (bare when no env label) and rejects foreign chats", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedChat(t, "alice");
    const intruder = await seedChat(t, "mallory");
    const asOwner = t.withIdentity({ subject: `${owner.userId}|s` });
    const asIntruder = t.withIdentity({ subject: `${intruder.userId}|s` });

    const ref = await asOwner.query(api.chatExport.getChatReference, {
      chatId: owner.chatId,
    });
    expect(ref).toBe(owner.chatId);
    await expect(
      asIntruder.query(api.chatExport.getChatReference, {
        chatId: owner.chatId,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("exportByReference resolves bare AND labeled references to a chronological markdown export", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t, "alice", 4);
    const as = t.withIdentity({ subject: `${userId}|s` });

    const res = await as.query(api.chatExport.exportByReference, {
      reference: chatId,
    });
    expect(res).not.toBeNull();
    expect(res!.filename).toBe(`conversation-${chatId}.md`);
    expect(res!.markdown).toContain("Météo Montréal");
    expect(res!.markdown).toContain("Assistant (alice)");
    // Conversation order preserved.
    const i0 = res!.markdown.indexOf("msg-0");
    const i3 = res!.markdown.indexOf("msg-3");
    expect(i0).toBeGreaterThan(-1);
    expect(i3).toBeGreaterThan(i0);
    // A labeled paste (from another deployment's habit) resolves identically.
    const labeled = await as.query(api.chatExport.exportByReference, {
      reference: `dev-${chatId}`,
    });
    // Identical content modulo the export timestamp line (each call stamps
    // its own clock).
    const stripDate = (md: string) =>
      md.replace(/- Exportée le : [^\n]+\n/, "");
    expect(stripDate(labeled!.markdown)).toBe(stripDate(res!.markdown));
  });

  test("resolution is SILENT for foreign chats and malformed ids (no existence leak)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedChat(t, "alice");
    const intruder = await seedChat(t, "mallory");
    const asIntruder = t.withIdentity({ subject: `${intruder.userId}|s` });

    expect(
      await asIntruder.query(api.chatExport.exportByReference, {
        reference: owner.chatId,
      }),
    ).toBeNull();
    expect(
      await asIntruder.query(api.chatExport.exportByReference, {
        reference: "dev-notarealid123456789",
      }),
    ).toBeNull();
  });

  test("a chat of EXACTLY the message cap does not claim truncation", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t, "alice", 0);
    await t.run(async (ctx) => {
      for (let i = 0; i < EXPORT_MESSAGE_CAP; i++) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user" as const,
          status: "complete" as const,
          text: `m-${i}`,
          updatedAt: 1000 + i,
        });
      }
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    const res = await as.query(api.chatExport.exportByReference, {
      reference: chatId,
    });
    expect(res!.markdown).not.toContain("tronquée");
    expect(res!.markdown).toContain(`m-${EXPORT_MESSAGE_CAP - 1}`);
  });

  test("a reply whose routed user turn fell OUTSIDE the window gets a bare Assistant label", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t, "alice", 0);
    await t.run(async (ctx) => {
      // Window starts on an assistant reply (its routed user turn is older
      // than everything collected below on a ROUTED chat).
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "réponse orpheline de routage",
        updatedAt: 1000,
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "question pour bob",
        routedAgentId: "bob",
        updatedAt: 2000,
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "réponse de bob",
        updatedAt: 3000,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    const res = await as.query(api.chatExport.exportByReference, {
      reference: chatId,
    });
    const md = res!.markdown;
    // The pre-routing reply is honestly unattributed; the routed one is not.
    const orphan = md.indexOf("### Assistant —");
    const routed = md.indexOf("### Assistant (bob)");
    expect(orphan).toBeGreaterThan(-1);
    expect(routed).toBeGreaterThan(orphan);
    expect(md).not.toContain("Assistant (alice)");
  });

  test("pre-routing turns of a later-routed chat are attributed to the PRIMARY agent", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t, "alice", 0);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "premier tour non route",
        updatedAt: 1000,
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "reponse du primaire",
        updatedAt: 1001,
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "question pour bob",
        routedAgentId: "bob",
        updatedAt: 2000,
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "reponse de bob",
        updatedAt: 2001,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    const res = await as.query(api.chatExport.exportByReference, {
      reference: chatId,
    });
    const md = res!.markdown;
    const primary = md.indexOf("Assistant (alice)");
    const routed = md.indexOf("Assistant (bob)");
    expect(primary).toBeGreaterThan(-1);
    expect(routed).toBeGreaterThan(primary);
  });

  test("queued follow-ups sharing the order sentinel export in FIFO order (compareOrder tie-break)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t, "alice", 1);
    await t.run(async (ctx) => {
      for (const label of ["premier-queued", "second-queued"]) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user" as const,
          status: "complete" as const,
          text: label,
          orderTime: 8.64e15, // QUEUED_ORDER_SENTINEL
          updatedAt: 5000,
        });
      }
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    const res = await as.query(api.chatExport.exportByReference, {
      reference: chatId,
    });
    const first = res!.markdown.indexOf("premier-queued");
    const second = res!.markdown.indexOf("second-queued");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  test("replies are attributed to the ROUTED agent of their turn, not the chat primary", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t, "alice", 0);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "question pour bob",
        routedAgentId: "bob",
        updatedAt: 1000,
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "réponse de bob",
        updatedAt: 1001,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    const res = await as.query(api.chatExport.exportByReference, {
      reference: chatId,
    });
    expect(res!.markdown).toContain("Assistant (bob)");
    expect(res!.markdown).not.toContain("Assistant (alice)");
  });

  test("a still-streaming turn exports its LIVE text (streamingText), flagged in-progress", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t, "alice", 1);
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 2000,
      });
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        userId,
        text: "réponse partielle en cours",
        updatedAt: 2001,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    const res = await as.query(api.chatExport.exportByReference, {
      reference: chatId,
    });
    expect(res!.markdown).toContain("réponse partielle en cours");
    expect(res!.markdown).toContain("réponse en cours au moment de l'export");
  });

  test("a single message larger than the char cap is ITSELF truncated (never an empty export)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t, "alice", 0);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "DEBUT-" + "x".repeat(EXPORT_CHAR_CAP + 50_000),
        updatedAt: 1000,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    const res = await as.query(api.chatExport.exportByReference, {
      reference: chatId,
    });
    expect(res).not.toBeNull();
    expect(res!.markdown).toContain("DEBUT-");
    expect(res!.markdown).toContain("message tronqué");
    expect(res!.markdown).toContain("tronquée");
    expect(res!.markdown.length).toBeLessThanOrEqual(EXPORT_CHAR_CAP + 2_000);
  });

  test("system rows are excluded; an over-cap conversation keeps the newest window and says it truncated", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t, "alice", 2);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "system" as const,
        status: "complete" as const,
        text: "internal-system-row",
        updatedAt: 1500,
      });
      for (let i = 0; i < EXPORT_MESSAGE_CAP + 10; i++) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user" as const,
          status: "complete" as const,
          text: `filler-${i}`,
          updatedAt: 2000 + i,
        });
      }
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    const res = await as.query(api.chatExport.exportByReference, {
      reference: chatId,
    });
    expect(res).not.toBeNull();
    expect(res!.markdown).not.toContain("internal-system-row");
    expect(res!.markdown).toContain("tronquée");
    // The newest message survives; the oldest fell out of the window.
    expect(res!.markdown).toContain(`filler-${EXPORT_MESSAGE_CAP + 9}`);
    expect(res!.markdown).not.toContain("msg-0");
  });
});
