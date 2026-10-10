/// <reference types="vite/client" />
//
// A GATEWAY COMMAND leaves exactly as typed (prod 2026-09-27: `/knowledge` answered
// "unknown subcommand: [livraison]"). Convex adds its own text to a turn too — the
// quoted-reply preamble in front, a chained step's earlier replies — and a command must
// carry none of it. A command with files is refused at the send, visibly.

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { COMMAND_WITH_ATTACHMENTS, isGatewayCommandText } from "./lib/gatewayCommand";
import { shouldReportRehydrateMissed } from "./lib/rehydrateTrace";

const modules = import.meta.glob("./**/*.ts");

/** Dispatch one outbox row and return the `text` the bridge was POSTed. */
async function dispatchedText(row: { text: string; quotedExcerpts?: string[] }) {
  const t = convexTest(schema, modules);
  const prevUrl = process.env.BRIDGE_URL;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_URL = "http://127.0.0.1:0";
  process.env.BRIDGE_SHARED_SECRET = "test-secret";
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  try {
    const outboxId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "primary",
        agentId: "alice",
        isDefault: true,
        source: "manual",
        createdAt: now,
      });
      const chatId = await ctx.db.insert("chats", { userId, archived: false, updatedAt: now });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        status: "complete",
        text: row.text,
        updatedAt: now,
      });
      return await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: `cmid-${row.text.length}`,
        messageId,
        text: row.text,
        attachmentIds: [],
        status: "pending",
        ...(row.quotedExcerpts ? { quotedExcerpts: row.quotedExcerpts } : {}),
      });
    });
    await t.action(internal.bridge.dispatch, { outboxId });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    return (JSON.parse(String(init.body)) as { text: string }).text;
  } finally {
    globalThis.fetch = origFetch;
    if (prevUrl === undefined) delete process.env.BRIDGE_URL;
    else process.env.BRIDGE_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
    else process.env.BRIDGE_SHARED_SECRET = prevSecret;
  }
}

describe("a gateway command, on the Convex side", () => {
  test("is the gateways' token grammar, the bridge's copy (bridge/src/core/gateway-command.ts)", () => {
    expect(isGatewayCommandText("  /knowledge once graph ")).toBe(true);
    expect(isGatewayCommandText("/compact: keep it short")).toBe(true);
    expect(isGatewayCommandText("bonjour /new")).toBe(false);
    expect(isGatewayCommandText("/tmp/x.txt regarde ce fichier")).toBe(false);
    expect(isGatewayCommandText("/new.md")).toBe(false);
  });

  test("a message OPENING with a path keeps its quoted-reply preamble", async () => {
    const text = await dispatchedText({
      text: "/tmp/x.txt regarde ce fichier",
      quotedExcerpts: ["a passage"],
    });
    expect(text).toContain("a passage");
    expect(text.endsWith("/tmp/x.txt regarde ce fichier")).toBe(true);
  });

  test("a QUOTED reply's preamble is not put in front of a command", async () => {
    expect(
      await dispatchedText({ text: "/knowledge once graph", quotedExcerpts: ["a passage"] }),
    ).toBe("/knowledge once graph");
  });

  test("…while an ordinary quoted reply keeps it", async () => {
    const text = await dispatchedText({ text: "et ça ?", quotedExcerpts: ["a passage"] });
    expect(text).toContain("a passage");
    expect(text.endsWith("et ça ?")).toBe(true);
  });

  test("a command with FILES is refused at the send, before anything is written", async () => {
    const t = convexTest(schema, modules);
    const { asUser, chatId, storageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user",
        canonical: "olivier",
        name: "olivier",
        email: "olivier@example.com",
      });
      const chatId = await ctx.db.insert("chats", { userId, archived: false, updatedAt: 1 });
      const storageId = await ctx.storage.store(new Blob(["x"]));
      await ctx.db.insert("uploads", { storageId, userId });
      return { asUser: userId, chatId, storageId };
    });
    const as = t.withIdentity({ subject: asUser });
    await expect(
      as.mutation(api.send.sendMessage, {
        chatId,
        text: "/knowledge once graph",
        clientMessageId: "cm-cmd-files",
        attachments: [{ storageId, filename: "f.txt", mimeType: "text/plain" }],
      }),
    ).rejects.toThrow(COMMAND_WITH_ATTACHMENTS);
    const written = await t.run((ctx) => ctx.db.query("outbox").collect());
    expect(written).toHaveLength(0);
    // A message OPENING WITH A PATH is an ordinary message: its file is accepted.
    await as.mutation(api.send.sendMessage, {
      chatId,
      text: "/tmp/x.txt regarde ce fichier",
      clientMessageId: "cm-path-file",
      attachments: [{ storageId, filename: "f.txt", mimeType: "text/plain" }],
    });
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("outbox").collect()) await ctx.db.delete(r._id);
    });
    // The same command WITHOUT files is accepted, as typed.
    await as.mutation(api.send.sendMessage, {
      chatId,
      text: "/knowledge once graph",
      clientMessageId: "cm-cmd-bare",
    });
    const accepted = await t.run((ctx) => ctx.db.query("outbox").collect());
    expect(accepted.map((r) => r.text)).toEqual(["/knowledge once graph"]);
  });

  test("a QUEUED turn carrying files cannot be rewritten into a command", async () => {
    const t = convexTest(schema, modules);
    const { asUser, chatId, storageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user",
        canonical: "olivier",
        name: "olivier",
        email: "olivier@example.com",
      });
      const chatId = await ctx.db.insert("chats", { userId, archived: false, updatedAt: 1 });
      // A turn in flight, so the next send is QUEUED behind it.
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "busy",
        text: "x",
        attachmentIds: [],
        status: "pending",
      });
      const storageId = await ctx.storage.store(new Blob(["x"]));
      await ctx.db.insert("uploads", { storageId, userId });
      return { asUser: userId, chatId, storageId };
    });
    const as = t.withIdentity({ subject: asUser });
    const { messageId } = await as.mutation(api.send.sendMessage, {
      chatId,
      text: "voici le fichier",
      clientMessageId: "cm-queued-file",
      attachments: [{ storageId, filename: "f.txt", mimeType: "text/plain" }],
    });
    await expect(
      as.mutation(api.send.updateQueuedMessage, { messageId: messageId!, text: "/new" }),
    ).rejects.toThrow(COMMAND_WITH_ATTACHMENTS);
    // An ordinary rewrite still goes through.
    await as.mutation(api.send.updateQueuedMessage, { messageId: messageId!, text: "le voici" });
  });

  test("a command skipping history on a routed switch is not a missed rehydration", () => {
    const base = { routedSwitch: true, freshSession: true, prependedTurns: 0 };
    expect(shouldReportRehydrateMissed({ ...base, decision: "skip_command" })).toBe(false);
    expect(shouldReportRehydrateMissed({ ...base, decision: "skip_attachment" })).toBe(true);
  });
});
