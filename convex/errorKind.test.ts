import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// Needed by the trace assertions below: `traceStream` swallows every failure by design
// ("never break the primary stream write on a trace error"), so without the modules loaded a
// trace that never ran would be indistinguishable from a code the allowlist dropped.
const modules = import.meta.glob("./**/*.ts");

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

  test("the gateway's STORAGE classes reach the message AND the trace", async () => {
    // The chain this defect is about: the bridge classifies the gateway's sentence, and the
    // class has to survive the trace's non-PHI allowlist to reach the per-cause anomaly plane.
    // Missing from that list, the code was dropped from the trace and the two cause classes
    // were unreachable — the failure counted only in the generic stream-error channel and the
    // diagnostic API said "unknown" (codex).
    for (const errorKind of ["gateway_storage_busy", "gateway_storage_unavailable"]) {
      const t = convexTest(schema, modules);
      const { messageId } = await seedStreamingMessage(t);
      await t.mutation(internal.stream.finalize, {
        messageId,
        status: "error",
        text: "",
        error:
          "⚠️ Agent run failed: the Gateway state database was full (SQLite: database or disk is full). Free disk space on the Gateway host and retry.",
        errorKind,
      });
      const msg = await t.run((ctx) => ctx.db.get(messageId));
      expect(msg?.errorCode, errorKind).toBe(errorKind);
      const traces = await t.run((ctx) =>
        ctx.db.query("traceEvents").collect(),
      );
      // `meta` is a JSON STRING on the row — read it the way the detector reads it
      // (anomalies.ts:283,302,347), not as an object.
      const finalize = traces.find((ev) => {
        if (typeof ev.meta !== "string") return false;
        return (JSON.parse(ev.meta) as { phase?: string }).phase === "finalize";
      });
      expect(finalize, `${errorKind}: no finalize trace`).toBeDefined();
      expect(
        (JSON.parse(finalize!.meta as string) as { errorCode?: string }).errorCode,
        errorKind,
      ).toBe(errorKind);
    }
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
