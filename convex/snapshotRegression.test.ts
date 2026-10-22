/// <reference types="vite/client" />
//
// The anti-regression guard's DIAGNOSTICS (G-14) — lib/snapshotRegression.ts.
//
// Prod 2026-10-13 (one turn, one message): 25 `snapshot_regression` traces in 9 s.
// The stored text grew 650 → 1338 while the refused snapshots grew 1 → 688 with a
// near-constant ~650 gap: one producer wrote the whole turn (accepted), another only
// the post-tool segment (refused every frame). The guard kept the full text; what was
// missing was WHICH frame produced which write, and the 25 rows said one thing 25 times.
//
// Invariance first: the guard's accept/refuse decision and the kept text are asserted
// unchanged in every case below — only the traces and the row's counters are new.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { RETIRED_SNAPSHOT_SOURCES, SNAPSHOT_SOURCES } from "./lib/snapshotRegression";
import { cascadeDeleteChat } from "./chats";
import { SNAPSHOT_SOURCES as BRIDGE_SOURCES } from "../bridge/src/core/snapshot-source";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
const URL = "/bridge/ingest";
let SECRET = "";

async function seed(t: T) {
  const seeded = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" as const });
    const instanceId = await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://prod" });
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod" });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
      runId: "run-denis",
    });
    return { admin, instanceId, chatId, messageId };
  });
  const minted = await t
    .withIdentity({ subject: `${seeded.admin}|session` })
    .action(api.bridgeAuth.mintBridgeSecret, { instanceId: seeded.instanceId });
  SECRET = minted.plaintext;
  return seeded;
}

async function post(t: T, body: Record<string, unknown>) {
  const res = await t.fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { applied?: boolean };
}

async function streamMetas(t: T) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("traceEvents").collect())
      .filter((e) => e.kind === "assistant.stream")
      .map((e) => ({ ...(JSON.parse(e.meta ?? "{}") as Record<string, unknown>), correlationId: e.correlationId })),
  );
}

const byPhase = (metas: Record<string, unknown>[], phase: string) =>
  metas.filter((m) => m.phase === phase);

async function liveRow(t: T, messageId: Id<"messages">) {
  return await t.run((ctx) =>
    ctx.db
      .query("streamingText")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .first(),
  );
}

// The prod shape: a 650-char head, then a post-tool segment growing to 688 chars.
const HEAD = "h".repeat(648) + "\n\n"; // 650
const SEP = "\n\n";
const SEGMENT = "s".repeat(688);
// 25 refused segment lengths, 1 → 688 (prod: newLen grew 1 → 688).
const STEPS = Array.from({ length: 25 }, (_, i) => (i === 24 ? 688 : 1 + i * 28));

/** Replays the prod turn: every frame of the segment producer is refused while the
 *  whole-turn producer keeps growing the row (as the bridge sends it: a suffix
 *  appendDelta for a snapshot that extends what Convex holds). */
async function replayProdTurn(t: T, messageId: Id<"messages">) {
  expect(
    await post(t, { op: "setSnapshot", messageId, text: HEAD, snapshotSource: "chat_delta" }),
  ).toMatchObject({ applied: true });
  const expected: { oldLen: number; newLen: number }[] = [];
  let shown = HEAD;
  let grown = 0;
  for (const n of STEPS) {
    const ack = await post(t, {
      op: "setSnapshot",
      messageId,
      text: SEGMENT.slice(0, n),
      snapshotSource: "agent_assistant_text",
      keptSource: "chat_delta",
    });
    expect(ack).toMatchObject({ applied: false }); // the guard's decision, unchanged
    expected.push({ oldLen: shown.length, newLen: n });
    const suffix = (grown === 0 ? SEP : "") + SEGMENT.slice(grown, n);
    await post(t, { op: "appendDelta", messageId, text: suffix });
    shown += suffix;
    grown = n;
  }
  expect(shown).toBe(HEAD + SEP + SEGMENT);
  return expected;
}

describe("snapshot regression diagnostics (G-14)", () => {
  test("the two vocabularies are the same list (Convex adds only `other` and the retired values)", () => {
    expect([...SNAPSHOT_SOURCES].sort()).toEqual(
      [...BRIDGE_SOURCES, "other", ...RETIRED_SNAPSHOT_SOURCES].sort(),
    );
    // A retired value is one the bridge no longer produces.
    for (const v of RETIRED_SNAPSHOT_SOURCES) expect(BRIDGE_SOURCES as readonly string[]).not.toContain(v);
  });

  test("prod 2026-10-13: 25 refusals → ONE snapshot_regression (first, with its producer) + ONE summary at finalize; the kept text is unchanged", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    const expected = await replayProdTurn(t, messageId);

    // Mid-stream: one trace, the FIRST refusal, naming both producers.
    let metas = await streamMetas(t);
    const firsts = byPhase(metas, "snapshot_regression");
    expect(firsts).toHaveLength(1);
    expect(firsts[0]).toMatchObject({
      streamStatus: "streaming",
      oldLen: 650,
      newLen: 1,
      snapshotSource: "agent_assistant_text",
      keptSource: "chat_delta",
    });
    expect(byPhase(metas, "snapshot_regression_summary")).toHaveLength(0);
    // The rest only counted on the live row.
    const row = await liveRow(t, messageId);
    expect(row?.snapshotRegression).toMatchObject({
      count: 25,
      sources: ["agent_assistant_text"],
      keptSources: ["chat_delta"],
      lastOldLen: expected[24].oldLen,
      lastNewLen: 688,
    });
    // refusedText keeps its meaning: the LAST refused text (finalize relies on it).
    expect(row?.refusedText).toBe(SEGMENT);

    const full = HEAD + SEP + SEGMENT;
    await post(t, { op: "finalize", messageId, status: "complete", text: full });

    const kept = await t.run(async (ctx) => (await ctx.db.get(messageId))?.text);
    expect(kept).toBe(full);
    expect(kept).toHaveLength(1340);

    metas = await streamMetas(t);
    expect(byPhase(metas, "snapshot_regression")).toHaveLength(1);
    const summaries = byPhase(metas, "snapshot_regression_summary");
    expect(summaries).toHaveLength(1);
    const maxGap = Math.max(...expected.map((e) => e.oldLen - e.newLen));
    expect(summaries[0]).toMatchObject({
      streamStatus: "complete",
      endedBy: "finalize",
      regressionCount: 25,
      maxGap,
      sources: ["agent_assistant_text"],
      keptSources: ["chat_delta"],
      lastOldLen: expected[24].oldLen,
      lastNewLen: 688,
    });
    expect(summaries[0].correlationId).toBe(firsts[0].correlationId);
    // SOC2: structure only — not one character of the reply in any trace.
    expect(JSON.stringify(metas)).not.toMatch(/hhhh|ssss/);
    // ~50 ingest round-trips: ~3 s alone, more on a loaded host.
  }, 30_000);

  test("a SINGLE refusal: one trace, no summary at finalize", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    await post(t, { op: "setSnapshot", messageId, text: "the full answer, all of it", snapshotSource: "chat_delta" });
    expect(
      await post(t, { op: "setSnapshot", messageId, text: "the full", snapshotSource: "message_tool" }),
    ).toMatchObject({ applied: false });
    await post(t, { op: "finalize", messageId, status: "complete", text: "" });

    const metas = await streamMetas(t);
    expect(byPhase(metas, "snapshot_regression")).toEqual([
      expect.objectContaining({ oldLen: 26, newLen: 8, snapshotSource: "message_tool" }),
    ]);
    expect(byPhase(metas, "snapshot_regression_summary")).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.get(messageId))?.text)).toBe(
      "the full answer, all of it",
    );
  });

  test("an UNKNOWN source is stored and traced as `other`, never as the free string", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    await post(t, { op: "setSnapshot", messageId, text: "longer text here" });
    for (const len of [3, 5]) {
      await post(t, {
        op: "setSnapshot",
        messageId,
        text: "x".repeat(len),
        snapshotSource: "a_path_from_a_newer_bridge",
        keptSource: 42,
      });
    }
    const row = await liveRow(t, messageId);
    expect(row?.snapshotRegression?.sources).toEqual(["other"]);
    expect(row?.snapshotRegression?.keptSources).toEqual([]); // non-string: dropped at ingest
    const first = byPhase(await streamMetas(t), "snapshot_regression")[0];
    expect(first.snapshotSource).toBe("other");
    expect(JSON.stringify(first)).not.toContain("newer_bridge");
  });

  test("an OLD bridge (no source fields) still works: same decision, trace without a source", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    expect(await post(t, { op: "setSnapshot", messageId, text: "the full answer" })).toMatchObject({ applied: true });
    expect(await post(t, { op: "setSnapshot", messageId, text: "the" })).toMatchObject({ applied: false });
    expect(await post(t, { op: "setSnapshot", messageId, text: "th" })).toMatchObject({ applied: false });
    // Direct call with the 0.100.0 argument shape (no snapshotSource / keptSource).
    expect(
      await t.mutation(internal.stream.setSnapshot, { messageId, text: "the full answer, grown" }),
    ).toMatchObject({ applied: true });
    const firsts = byPhase(await streamMetas(t), "snapshot_regression");
    expect(firsts).toHaveLength(1);
    expect(firsts[0]).not.toHaveProperty("snapshotSource");
    expect(firsts[0]).not.toHaveProperty("keptSource");
    expect((await liveRow(t, messageId))?.snapshotRegression).toMatchObject({
      count: 2,
      sources: [],
      keptSources: [],
    });
  });

  test("a stream ended by the WATCHDOG (no finalize) still emits its summary", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    await post(t, { op: "setSnapshot", messageId, text: "a long reply already shown" });
    await post(t, { op: "setSnapshot", messageId, text: "a", snapshotSource: "history_recovery" });
    await post(t, { op: "setSnapshot", messageId, text: "a lo", snapshotSource: "chat_final" });
    const row = await liveRow(t, messageId);
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, { updatedAt: 0 });
      await ctx.db.patch(messageId, { updatedAt: 0 });
    });
    await t.mutation(internal.stuckStreams.reconcileStuckStreams, {});

    expect(await liveRow(t, messageId)).toBeNull();
    const summaries = byPhase(await streamMetas(t), "snapshot_regression_summary");
    expect(summaries).toEqual([
      expect.objectContaining({
        endedBy: "stuck_reap",
        streamStatus: "error",
        regressionCount: 2,
        sources: ["history_recovery", "chat_final"],
        maxGap: 25,
      }),
    ]);
  });
});

describe("streams ended by a chat PURGE (codex pass 1)", () => {
  /** A live stream with `refusals` refused snapshots on it. */
  async function refused(t: T, messageId: Id<"messages">, refusals: number) {
    await post(t, { op: "setSnapshot", messageId, text: "a long reply already shown" });
    const lens = [1, 4, 9].slice(0, refusals);
    for (const len of lens) {
      await post(t, { op: "setSnapshot", messageId, text: "x".repeat(len), snapshotSource: "chat_final" });
    }
  }

  test("2+ refusals, then the chat is purged → ONE summary, endedBy chat_purge, right counters", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await refused(t, messageId, 3);
    await t.run((ctx) => cascadeDeleteChat(ctx, chatId));

    expect(await liveRow(t, messageId)).toBeNull();
    const metas = await streamMetas(t);
    expect(byPhase(metas, "snapshot_regression")).toHaveLength(1);
    expect(byPhase(metas, "snapshot_regression_summary")).toEqual([
      expect.objectContaining({
        endedBy: "chat_purge",
        streamStatus: "streaming",
        regressionCount: 3,
        maxGap: 25,
        sources: ["chat_final"],
        lastOldLen: 26,
        lastNewLen: 9,
      }),
    ]);
  });

  test("a single refusal, then the chat is purged → no summary", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await refused(t, messageId, 1);
    await t.run((ctx) => cascadeDeleteChat(ctx, chatId));
    expect(await liveRow(t, messageId)).toBeNull();
    expect(byPhase(await streamMetas(t), "snapshot_regression_summary")).toHaveLength(0);
  });

  test("the hidden service-chat sweep drops a leftover row with its summary too", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await refused(t, messageId, 2);
    // A row left behind by a turn that ended (the sweep skips streaming messages).
    await t.run((ctx) => ctx.db.patch(messageId, { status: "complete" as const }));
    await t.mutation(internal.chatSummaries.sweepHiddenChat, { hiddenChatId: chatId });

    expect(await liveRow(t, messageId)).toBeNull();
    expect(byPhase(await streamMetas(t), "snapshot_regression_summary")).toEqual([
      expect.objectContaining({ endedBy: "chat_purge", streamStatus: "complete", regressionCount: 2 }),
    ]);
  });
});
