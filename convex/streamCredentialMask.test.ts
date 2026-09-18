/// <reference types="vite/client" />
//
// The credential id must not enter the row.
//
// The gateway's sentence for a paused auth profile NAMES the profile — upstream lets
// an operator call it anything, and the one that reached a user was an email address.
// That sentence is stored on the message, served to every reader of the chat
// (messages.ts), copied with the bubble, and written into an archive export. Masking it
// at the VIEW only hides it on screen: the value is already in the row and in every
// client's copy of it (codex). So it is masked at the boundary, here, and this is what
// proves it — the view mask is a belt for rows persisted before this existed.

import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const RAW =
  'Auth profile "openai:olivier@lacneu.com" is temporarily unavailable for openai/gpt-5.6-terra.';

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
    return { messageId };
  });
}

describe("stream.finalize — the credential id stops at the door", () => {
  test("an auth-profile sentence is stored WITHOUT the profile id", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingMessage(t);

    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: RAW,
      errorKind: "auth_profile_cooldown",
    });

    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.error, "the credential id was stored on the message").not.toContain(
      "olivier@lacneu.com",
    );
    // The redaction is TOTAL — the provider and the model go with the id, because a
    // partial redaction of an operator-chosen string is not winnable (codex). What the
    // reader needs is on the localized card; what the operator needs is on the gateway.
    expect(msg?.error).toBe('Auth profile "…');
    // The class is untouched: masking the sentence must not cost the card its headline.
    expect(msg?.errorCode).toBe("auth_profile_cooldown");
  });

  test("it does not depend on the CLASS — the reported row carried none", async () => {
    // The message that opened this lot was stored with no errorCode at all, which is
    // why it had no actionable headline. A mask keyed on the class would have let that
    // very row through.
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingMessage(t);

    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: RAW,
    });

    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.error).not.toContain("olivier@lacneu.com");
  });

  test("the CLASS reaches the trace, which is what makes the cause countable", async () => {
    // The detector test seeds a trace carrying the code directly, so it stays green if
    // `finalize` stops putting the class ON the trace (codex). This is that hop: one
    // finalize, then the `assistant.stream` row it wrote.
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingMessage(t);

    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: RAW,
      errorKind: "auth_profile_cooldown",
    });

    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    const finalize = traces.find(
      (e) =>
        e.kind === "assistant.stream" &&
        typeof e.meta === "string" &&
        e.meta.includes("finalize"),
    );
    expect(finalize, "no assistant.stream finalize trace was written").toBeDefined();
    expect(String(finalize?.meta)).toContain("auth_profile_cooldown");
    // …and the sentence itself never rides along: the trace carries metadata only.
    expect(String(finalize?.meta)).not.toContain("olivier@lacneu.com");
    expect(String(finalize?.meta)).not.toContain("temporarily unavailable");
  });

  test("the HTTP relay and the chat query both carry the error and its class", async () => {
    // Two hops nothing pinned. The writer test stops at the POST body and this file's
    // other cases call the mutation directly, so deleting `error`/`errorKind` from the
    // ingest relay, or either field from `listByChat`, left every one of them green
    // while the real card lost its detail or its headline (codex). Read as source,
    // comments stripped: an end-to-end HTTP test here would prove less, not more —
    // it cannot see which field name carried the value.
    const strip = (f: string) =>
      readFileSync(new URL(f, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");

    const ingest = strip("./bridge_ingest.ts");
    expect(ingest).toMatch(
      /runMutation\(internal\.stream\.finalize, \{[\s\S]{0,240}?error: body\.error \?\? undefined,\s*errorKind: body\.errorKind \?\? undefined,/,
    );

    const messages = strip("./messages.ts");
    // The chat query MASKS on the way out now, for rows the operator-invoked backfill
    // has not reached; the pin follows that, still adjacent to the class beside it.
    expect(messages).toMatch(
      /error: maskCredentialId\(message\.error\),\s*errorCode: message\.errorCode,/,
    );
  });

  test("every other failure sentence is stored exactly as the gateway wrote it", async () => {
    // The mask runs on EVERY finalize. One that nibbles at unrelated errors would be a
    // worse defect than the one it fixes: those sentences are how an operator tells a
    // full disk from a read-only one.
    const t = convexTest(schema, modules);
    const untouched =
      "⚠️ Agent run failed: the Gateway state database was full (SQLite: database or disk is full).";
    const { messageId } = await seedStreamingMessage(t);

    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: untouched,
      errorKind: "gateway_storage_unavailable",
    });

    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.error).toBe(untouched);
  });
});
