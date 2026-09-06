// setSessionMeta rebuilds `sessionMeta` whole, so the ordering rules live HERE and
// nowhere in the publishers: an omitted roster keeps the one on screen for the same
// owner (a publisher whose `models.list` failed must not wipe the picker — nor inherit
// another agent's); the knob fields are ordered by the describe's observation time (a
// describe held across a slow ask must not overwrite a knob the user patched meanwhile);
// and the roster by ITS OWN stamp, the gateway's answer time — the two clocks are kept
// apart; a roster reported ALONE rides an unstamped meta under the same rule. The
// roster's owner is the owner of the latest knobs write accepted, and a roster counts
// for that owner only.
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

async function seedChat(t: T) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://prod" });
    return await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod" });
  });
}
const metaOf = (t: T, chatId: Awaited<ReturnType<typeof seedChat>>) =>
  t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);

describe("setSessionMeta — an OMITTED roster keeps the previous one", () => {
  test("a publish without availableModels leaves the picker as it was", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "gpt-5.5", availableModels: [{ id: "gpt-5.5", label: "GPT-5.5" }], observedAt: 10 },
      }),
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "gpt-5.5", totalTokens: 42, observedAt: 20 }, // the ask failed: no roster in hand
      }),
    );
    const meta = await metaOf(t, chatId);
    expect(meta?.availableModels?.map((m) => m.id)).toEqual(["gpt-5.5"]);
    expect(meta?.totalTokens).toBe(42);
  });
});

describe("setSessionMeta — the knob fields are ordered by observation time", () => {
  test("a describe stamped OLDER than the knobs on record does not overwrite them", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    // A slow send: its describe (t=10) is published AFTER a knob patch (t=30) landed.
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { thinkingLevel: "high", model: "b", observedAt: 30 } }),
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { thinkingLevel: "low", model: "a", totalTokens: 7, observedAt: 10 },
      }),
    );
    const meta = await metaOf(t, chatId);
    expect([meta?.thinkingLevel, meta?.model], "the patched knobs stay").toEqual(["high", "b"]);
    expect(meta?.knobsAt).toBe(30);
  });
  test("a NEWER describe moves the knobs and the watermark", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { thinkingLevel: "low", observedAt: 10 } }));
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { thinkingLevel: "high", observedAt: 20 } }));
    const meta = await metaOf(t, chatId);
    expect(meta?.thinkingLevel).toBe("high");
    expect(meta?.knobsAt).toBe(20);
  });
  test("an unstamped write applies as before (no ordering claimed)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { thinkingLevel: "high", observedAt: 30 } }));
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { thinkingLevel: "low" } }));
    expect((await metaOf(t, chatId))?.thinkingLevel).toBe("low");
  });
});

describe("setSessionMeta — the roster is ordered too, and an identical meta is not rewritten", () => {
  test("a roster stamped OLDER than the one on record does not overwrite it (a late turn meta after a config refresh)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { availableModels: [{ id: "a", label: "a" }, { id: "b", label: "b" }], observedAt: 30 },
      }),
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { availableModels: [{ id: "a", label: "a" }], totalTokens: 1, observedAt: 10 } }),
    );
    expect((await metaOf(t, chatId))?.availableModels?.map((m) => m.id)).toEqual(["a", "b"]);
  });
  test("a duplicate delivery does not bump the chat row", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    const meta = { model: "gpt-5.5", availableModels: [{ id: "gpt-5.5", label: "GPT-5.5" }], observedAt: 10 };
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta }));
    const first = (await metaOf(t, chatId))?.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta }));
    const second = await metaOf(t, chatId);
    expect(second?.updatedAt, "same content: the row is not rewritten").toBe(first);
  });
});

describe("setSessionMeta — only a write carrying ordered fields moves their watermark", () => {
  test("a later-stamped usage snapshot without knobs does not make an older knob write stale", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { totalTokens: 500, observedAt: 20 } })); // usage first
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { model: "b", thinkingLevel: "high", observedAt: 10 } })); // the knob write lands late
    const meta = await metaOf(t, chatId);
    expect([meta?.model, meta?.thinkingLevel], "the knobs apply: nothing newer carried them").toEqual(["b", "high"]);
    expect(meta?.knobsAt).toBe(10);
  });
});

describe("setSessionMeta — the roster has ITS OWN clock, the knobs the describe's", () => {
  test("a refresh whose describe was held across a slow ask: the knobs lose to a later describe, the roster wins by its answer time", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    // A send described at 20 and served the OLD roster (answered at 5).
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { thinkingLevel: "high", availableModels: [{ id: "old", label: "old" }], availableModelsOwner: "alice", observedAt: 20, rosterObservedAt: 5 },
      }),
    );
    // The config refresh: described at 10, then waited for the post-change roster, answered at 30.
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { thinkingLevel: "low", availableModels: [{ id: "new", label: "new" }], availableModelsOwner: "alice", observedAt: 10, rosterObservedAt: 30 },
      }),
    );
    const meta = await metaOf(t, chatId);
    expect([meta?.thinkingLevel, meta?.knobsAt], "the older describe did not overwrite the knobs").toEqual(["high", 20]);
    expect([meta?.availableModels?.map((m) => m.id), meta?.rosterAt], "…and the newer roster landed").toEqual([["new"], 30]);
  });

  test("an omitted roster with the SAME owner is kept — the owner alone does not carry the roster group", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "a-model", availableModels: [{ id: "a-model", label: "A" }], availableModelsOwner: "alice", observedAt: 10, rosterObservedAt: 10 },
      }),
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "a-model", availableModelsOwner: "alice", observedAt: 20 }, // the re-ask failed: nothing in hand
      }),
    );
    const meta = await metaOf(t, chatId);
    expect([meta?.availableModels?.map((m) => m.id), meta?.availableModelsOwner, meta?.rosterAt]).toEqual([["a-model"], "alice", 10]);
  });

  test("an omitted roster is kept for the SAME owner only: a turn routed to another agent starts without one", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "a-model", availableModels: [{ id: "a-model", label: "A" }], availableModelsOwner: "alice", observedAt: 10, rosterObservedAt: 10 },
      }),
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "b-model", availableModelsOwner: "bob", observedAt: 20 }, // bob's ask failed: nothing in hand
      }),
    );
    const meta = await metaOf(t, chatId);
    expect([meta?.model, meta?.availableModels, meta?.availableModelsOwner], "alice's list is not offered under bob's model").toEqual(["b-model", undefined, "bob"]);
    expect(meta?.rosterAt, "a new owner starts from a clean slate").toBeUndefined();
  });
});

describe("the roster's owner is the owner of the latest KNOBS write accepted", () => {
  const rosterOf = (models: string[]) => models.map((id) => ({ id, label: id }));
  test("an OLDER knobs write from another agent switches nothing: neither the owner nor the roster", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "b-model", availableModels: rosterOf(["b-model"]), availableModelsOwner: "bob", observedAt: 30, rosterObservedAt: 30 },
      }),
    );
    // A replayed publish for alice, described before bob's turn, with no roster in hand.
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "a-model", availableModelsOwner: "alice", observedAt: 10 },
      }),
    );
    const meta = await metaOf(t, chatId);
    expect([meta?.model, meta?.availableModelsOwner, meta?.availableModels?.map((m) => m.id), meta?.rosterAt]).toEqual(["b-model", "bob", ["b-model"], 30]);
  });

  test("a describe with no knob field still declares its owner: the next agent does not inherit its roster", async () => {
    // A session the gateway describes with no model set (a fresh one, a provider that
    // reports none) publishes a roster and no knob field at all. Its owner must still
    // become the current one, or the roster sits on record ownerless and the next
    // agent's publish sees no owner to differ from.
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { availableModels: rosterOf(["a-model"]), availableModelsOwner: "alice", observedAt: 10, rosterObservedAt: 10 },
      }),
    );
    expect((await metaOf(t, chatId))?.availableModelsOwner).toBe("alice");
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "b-model", availableModelsOwner: "bob", observedAt: 20 }, // bob's ask failed
      }),
    );
    const meta = await metaOf(t, chatId);
    expect([meta?.availableModelsOwner, meta?.availableModels], "alice's models are not offered under bob").toEqual(["bob", undefined]);
  });

  test("a roster from ANOTHER agent landing late is ignored whatever its stamp; the current owner's roster stays", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "b-model", availableModels: rosterOf(["b-model"]), availableModelsOwner: "bob", observedAt: 30, rosterObservedAt: 30 },
      }),
    );
    // Alice's slow re-ask, reported alone (unstamped meta) after the chat moved to bob.
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { availableModels: rosterOf(["a-model"]), availableModelsOwner: "alice", rosterObservedAt: 40 },
      }),
    );
    const meta = await metaOf(t, chatId);
    expect([meta?.availableModelsOwner, meta?.availableModels?.map((m) => m.id), meta?.rosterAt]).toEqual(["bob", ["b-model"], 30]);
  });
});

describe("a roster reported ALONE (an unstamped meta) — its own stamp, nothing else touched", () => {
  test("a newer answer applies, an older one is fenced, the same answer again is not written, and the counters stay", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "m", totalTokens: 7, estimatedCostUsd: 0.5, availableModels: [{ id: "a", label: "a" }], availableModelsOwner: "alice", observedAt: 10, rosterObservedAt: 10 },
      }),
    );
    const alone = (ids: string[], at: number) =>
      t.run((ctx) =>
        ctx.runMutation(internal.stream.setSessionMeta, {
          chatId,
          meta: { availableModels: ids.map((id) => ({ id, label: id })), availableModelsOwner: "alice", rosterObservedAt: at },
        }),
      );
    await alone(["a", "b"], 30);
    let meta = await metaOf(t, chatId);
    expect(
      [meta?.availableModels?.map((m) => m.id), meta?.rosterAt, meta?.model, meta?.totalTokens, meta?.estimatedCostUsd, meta?.knobsAt, meta?.estimateAt],
      "applied; the rest of the meta and its watermarks untouched",
    ).toEqual([["a", "b"], 30, "m", 7, 0.5, 10, 10]);
    await alone(["c"], 20);
    meta = await metaOf(t, chatId);
    expect(meta?.availableModels?.map((m) => m.id), "older than the record: fenced").toEqual(["a", "b"]);
    const stamp = meta?.updatedAt;
    await new Promise((r) => setTimeout(r, 3)); // a write would carry a later `updatedAt`
    await alone(["a", "b"], 30);
    expect((await metaOf(t, chatId))?.updatedAt, "the same answer again is not a write").toBe(stamp);
  });
});

describe("the ESTIMATE block is one ordered group, the cost figure included", () => {
  test("an older describe landing late does not overwrite a newer cost", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { model: "m", totalTokens: 100, estimatedCostUsd: 0.15, observedAt: 20 } }));
    await t.run((ctx) => ctx.runMutation(internal.stream.setSessionMeta, { chatId, meta: { model: "m", totalTokens: 50, estimatedCostUsd: 0.1, observedAt: 10 } }));
    const meta = await metaOf(t, chatId);
    expect([meta?.totalTokens, meta?.estimatedCostUsd, meta?.estimateAt]).toEqual([100, 0.15, 20]);
  });
});
