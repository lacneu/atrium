// THE BACK-OFF COUNTER MUST NOT OUTLIVE ITS BACK-OFF.
//
// OpenClaw 2026.9.4 emits `ChatStatusEvent.retry` while the provider is
// rate-limiting. Atrium read nothing from it, so each re-entered attempt's
// deferred terminal showed "post-processing" — a finishing label for a turn that
// had not reached the model. `retrying` now carries `{attempt, maxAttempts}`.
//
// The counter is stored NEXT TO the phase and written on every phase change, so
// a turn that retried twice and then started producing can never still read
// "2/10". That coupling is the whole point of these tests: the label is only
// honest if the number dies with the state that produced it.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seedStreamingTurn(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", {
      userId,
      title: "t",
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId: "run-1",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("streamingText", {
      messageId,
      chatId,
      text: "",
      updatedAt: Date.now(),
    });
    return { messageId };
  });
}

const rowOf = (t: TestConvex<typeof schema>, messageId: Id<"messages">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("streamingText")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .unique(),
  );


/** An instance with its bridge secret, a chat and a live streaming turn — the shape the
 *  ingest route actually authenticates against. Mirrors bridgeIngestIsolation.test.ts,
 *  including the `boundInstance` stamp so message-scoped ops take the real barrier
 *  path rather than the row-less no-op. */
async function seedIngestChat(t: TestConvex<typeof schema>) {
  const name = "alpha";
  const admin = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: id, role: "admin" as const });
    return id;
  });
  const instanceId = await t.run((ctx) =>
    ctx.db.insert("instances", { name, gatewayUrl: `ws://${name}`, kind: "openclaw" as const }),
  );
  const secret = await t
    .withIdentity({ subject: `${admin}|session` })
    .action(api.bridgeAuth.mintBridgeSecret, { instanceId });
  const messageId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: name });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: name });
    const mId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId: "run-1",
      updatedAt: 1,
    });
    await ctx.db.insert("streamingText", {
      messageId: mId,
      chatId,
      userId,
      generation: null,
      boundInstance: name,
      text: "",
      updatedAt: 1,
    });
    return mId;
  });
  return { messageId, secret: (secret as { plaintext: string }).plaintext };
}

describe("the provider back-off counter", () => {
  test("`retrying` stores its counter", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingTurn(t);
    await t.mutation(internal.stream.setPhase, {
      messageId,
      phase: "retrying",
      retry: { attempt: 2, maxAttempts: 10 },
    });
    const row = await rowOf(t, messageId);
    expect(row?.phase).toBe("retrying");
    expect(row?.phaseRetry).toEqual({ attempt: 2, maxAttempts: 10 });
  });

  test("the NEXT phase clears it — a resumed turn never still reads 2/10", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingTurn(t);
    await t.mutation(internal.stream.setPhase, {
      messageId,
      phase: "retrying",
      retry: { attempt: 2, maxAttempts: 10 },
    });
    await t.mutation(internal.stream.setPhase, {
      messageId,
      phase: "post_processing",
    });
    const row = await rowOf(t, messageId);
    expect(row?.phase).toBe("post_processing");
    expect(row?.phaseRetry).toBeUndefined();
  });

  test("the resume signal clears phase AND counter together", async () => {
    // `generating` is the END of a phase, not a phase: it clears. The counter
    // has to go with it, or the chip keeps a number whose state is gone.
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingTurn(t);
    await t.mutation(internal.stream.setPhase, {
      messageId,
      phase: "retrying",
      retry: { attempt: 3, maxAttempts: 10 },
    });
    await t.mutation(internal.stream.setPhase, { messageId, phase: "generating" });
    const row = await rowOf(t, messageId);
    expect(row?.phase).toBeUndefined();
    expect(row?.phaseRetry).toBeUndefined();
  });

  test("a counter sent with any OTHER phase is refused, not stored", async () => {
    // Defence in depth: the bridge only attaches it to `retrying`, but this
    // mutation is the boundary and a counter under an unrelated phase would be
    // a number nothing can ever clear on its own terms.
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingTurn(t);
    await t.mutation(internal.stream.setPhase, {
      messageId,
      phase: "compacting",
      retry: { attempt: 2, maxAttempts: 10 },
    });
    const row = await rowOf(t, messageId);
    expect(row?.phase).toBe("compacting");
    expect(row?.phaseRetry).toBeUndefined();
  });

  test("`retrying` is on the allowlist — an unknown phase is still dropped", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingTurn(t);
    await t.mutation(internal.stream.setPhase, {
      messageId,
      phase: "not_a_phase",
      retry: { attempt: 1, maxAttempts: 2 },
    });
    const row = await rowOf(t, messageId);
    expect(row?.phase).toBeUndefined();
    expect(row?.phaseRetry).toBeUndefined();
  });

  test("VISIBLE TEXT clears the back-off atomically — the clear cannot be lost", () => {
    // The bridge also POSTs a `generating` clear, but that is a separate best-effort
    // request that swallows its errors and is never retried. A lost one left
    // "retrying 2/10" on screen for the whole generation — the very defect the phase
    // exists to remove (raised in review). The text write carries the clear itself.
    return (async () => {
      const t = convexTest(schema, modules);
      const { messageId } = await seedStreamingTurn(t);
      await t.mutation(internal.stream.setPhase, {
        messageId,
        phase: "retrying",
        retry: { attempt: 2, maxAttempts: 10 },
      });
      await t.mutation(internal.stream.appendDelta, { messageId, text: "bonjour" });
      const row = await rowOf(t, messageId);
      expect(row?.text).toContain("bonjour");
      expect(row?.phase).toBeUndefined();
      expect(row?.phaseRetry).toBeUndefined();
    })();
  });

  test("…but text does NOT clear a phase that is not a back-off", () => {
    // Clearing any phase here would make the label flicker on every delta: text says
    // nothing about `compacting` or `awaiting_approval`.
    return (async () => {
      const t = convexTest(schema, modules);
      const { messageId } = await seedStreamingTurn(t);
      await t.mutation(internal.stream.setPhase, { messageId, phase: "compacting" });
      await t.mutation(internal.stream.appendDelta, { messageId, text: "x" });
      const row = await rowOf(t, messageId);
      expect(row?.phase).toBe("compacting");
    })();
  });

  test("the mutation re-checks the contract's bounds — it does not trust the bridge", () => {
    // `v.number()` accepts any float and the ingest op only CASTS its JSON, so this
    // mutation is the last thing between a malformed frame and a label reading
    // "2.5/11" (raised in review). The phase still lands; only the counter is refused.
    return (async () => {
      const t = convexTest(schema, modules);
      for (const retry of [
        { attempt: 2.5, maxAttempts: 10 },
        { attempt: 0, maxAttempts: 10 },
        { attempt: 11, maxAttempts: 11 },
        { attempt: 1, maxAttempts: 11 },
        { attempt: 9, maxAttempts: 2 },
      ]) {
        const { messageId } = await seedStreamingTurn(t);
        await t.mutation(internal.stream.setPhase, { messageId, phase: "retrying", retry });
        const row = await rowOf(t, messageId);
        expect(row?.phase, JSON.stringify(retry)).toBe("retrying");
        expect(row?.phaseRetry, JSON.stringify(retry)).toBeUndefined();
      }
    })();
  });

  test("…and accepts the contract's legitimate edges", () => {
    return (async () => {
      const t = convexTest(schema, modules);
      for (const retry of [
        { attempt: 1, maxAttempts: 1 },
        { attempt: 10, maxAttempts: 10 },
        { attempt: 3, maxAttempts: 3 },
      ]) {
        const { messageId } = await seedStreamingTurn(t);
        await t.mutation(internal.stream.setPhase, { messageId, phase: "retrying", retry });
        const row = await rowOf(t, messageId);
        expect(row?.phaseRetry, JSON.stringify(retry)).toEqual(retry);
      }
    })();
  });

  test("a SCOPED clear removes the back-off and nothing else", () => {
    return (async () => {
      const t = convexTest(schema, modules);
      const { messageId } = await seedStreamingTurn(t);
      await t.mutation(internal.stream.setPhase, {
        messageId,
        phase: "retrying",
        retry: { attempt: 2, maxAttempts: 10 },
      });
      await t.mutation(internal.stream.setPhase, {
        messageId,
        phase: "generating",
        onlyIfRetrying: true,
      });
      const row = await rowOf(t, messageId);
      expect(row?.phase).toBeUndefined();
      expect(row?.phaseRetry).toBeUndefined();
    })();
  });

  test("…and leaves ANOTHER producer's phase alone", () => {
    // `generating` is shared with Hermes' resume signal and wipes whatever phase is
    // stored. A back-off clear arriving after something else published
    // `awaiting_approval` erased THAT instead — a turn waiting on a human went back to
    // looking idle (raised in review).
    return (async () => {
      const t = convexTest(schema, modules);
      const { messageId } = await seedStreamingTurn(t);
      await t.mutation(internal.stream.setPhase, { messageId, phase: "awaiting_approval" });
      await t.mutation(internal.stream.setPhase, {
        messageId,
        phase: "generating",
        onlyIfRetrying: true,
      });
      const row = await rowOf(t, messageId);
      expect(row?.phase).toBe("awaiting_approval");
    })();
  });

  test("an UNSCOPED generating still clears everything — Hermes' signal is unchanged", () => {
    return (async () => {
      const t = convexTest(schema, modules);
      const { messageId } = await seedStreamingTurn(t);
      await t.mutation(internal.stream.setPhase, { messageId, phase: "awaiting_subagents" });
      await t.mutation(internal.stream.setPhase, { messageId, phase: "generating" });
      const row = await rowOf(t, messageId);
      expect(row?.phase).toBeUndefined();
    })();
  });

  test("the REAL ingest route carries the scoped-clear flag to the mutation", () => {
    // The writer's payload field and the ingest op's pass-through had no assertion of
    // their own: dropping either left every test green while the clear silently widened
    // back to "erase whatever phase is stored" (raised in review). A first attempt at
    // this test re-implemented the pass-through inline and proved only the mutation —
    // self-fulfilling. This one POSTs the writer's actual body to the actual route.
    return (async () => {
      const t = convexTest(schema, modules);
      const seeded = await seedIngestChat(t);
      await t.mutation(internal.stream.setPhase, {
        messageId: seeded.messageId,
        phase: "awaiting_approval",
      });
      const res = await t.fetch("/bridge/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${seeded.secret}`,
        },
        body: JSON.stringify({
          op: "setPhase",
          messageId: seeded.messageId,
          phase: "generating",
          onlyIfRetrying: true,
        }),
      });
      expect(res.status).toBe(200);
      const row = await rowOf(t, seeded.messageId);
      expect(row?.phase, "a scoped clear must not touch another producer's phase").toBe(
        "awaiting_approval",
      );
    })();
  });
});
