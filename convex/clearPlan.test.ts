import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { resolveCurrentPlan } from "../src/chat/planView";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const CHILD = "agent:files:subagent:aaaaaaaa-0000-4000-8000-000000000001";
const RUN = `announce:v1:${CHILD}:bbbbbbbb-0000-4000-8000-000000000002`;
const STEPS = [
  { step: "Analyser", status: "completed" as const },
  { step: "Rédiger", status: "in_progress" as const },
];

async function seed(
  t: ReturnType<typeof convexTest>,
  opts?: { withRow?: boolean },
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "Plan posé.",
      runId: "webchat-parent",
      updatedAt: 1000,
    });
    await ctx.db.insert("messageParts", {
      messageId,
      order: 0,
      part: { kind: "plan" as const, steps: STEPS },
    });
    if (opts?.withRow !== false) {
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: CHILD,
        status: "done" as const,
        parentMessageId: messageId,
        anchorExact: true,
        createdAt: 900,
        updatedAt: 950,
      });
    }
    return { chatId, messageId };
  });
}
async function planParts(t: ReturnType<typeof convexTest>, messageId: Id<"messages">) {
  return t.run(async (ctx) => {
    const rows = await ctx.db.query("messageParts").collect();
    return rows
      .filter((r) => r.messageId === messageId && r.part.kind === "plan")
      .sort((a, b) => a.order - b.order)
      .map((r) => r.part);
  });
}

describe("stream.clearPlanPart (an empty plan from a SILENT delivery run — codex P2)", () => {
  test("supersedes the anchored parent's checklist with an empty plan, run-keyed", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    const parts = await planParts(t, messageId);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ kind: "plan", steps: [] });
  });
  test("idempotent: an already-cleared plan is not cleared again", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    expect(await planParts(t, messageId)).toHaveLength(2);
  });
  test("replay dedup: a run that already cleared does not re-clear a NEWER plan (codex P2)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    // A newer run posts a real plan after the clear…
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId,
        order: 2,
        part: { kind: "plan" as const, steps: STEPS },
      });
    });
    // …then the first run is rebroadcast: it must not hide the newer plan. The plan
    // is UNSTAMPED (the parent turn's own card), so the ownership guard cannot refuse
    // it: only the tombstone can, which is what this proves.
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    const parts = await planParts(t, messageId);
    expect(parts).toHaveLength(3);
    expect(parts[2]).toEqual({ kind: "plan", steps: STEPS });
  });
  test("REFUSES a message bound to another instance, even when the CHAT admits the caller (codex P1)", async () => {
    // Owning the chat is not owning the message. The chat's primary instance is
    // "beta", so the chat-level check admits beta — but the bubble the engagement
    // anchors to is bound to "alpha". Without the per-message barrier, beta could
    // clear a plan on alpha's message.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, { instanceName: "beta" });
      await ctx.db.patch(messageId, { boundInstance: "alpha" });
    });
    await expect(
      t.mutation(internal.stream.clearPlanPart, {
        chatId,
        runId: RUN,
        boundInstanceName: "beta",
      }),
    ).rejects.toThrow();
    expect(await planParts(t, messageId)).toHaveLength(1);
  });
  test("a NON-empty row from the same run is not proof the clear landed (codex P2)", async () => {
    // The run posted a plan, then its clear write failed. The catch-up call must
    // still clear — deduplicating on any row of this run left the stale checklist.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("messageParts").collect();
      const first = rows.find((r) => r.messageId === messageId);
      if (first !== undefined) await ctx.db.patch(first._id, { announceRun: RUN });
    });
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    const parts = await planParts(t, messageId);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ kind: "plan", steps: [] });
  });
  test("a clear with nothing to supersede still leaves a TOMBSTONE (codex P2)", async () => {
    // Otherwise a replay of this run, arriving after a NEWER plan, is not
    // deduplicated and clears that newer plan.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("messageParts").collect();
      for (const r of rows) if (r.messageId === messageId) await ctx.db.delete(r._id);
    });
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    expect(await planParts(t, messageId)).toEqual([{ kind: "plan", steps: [] }]);
    // A newer run posts a real plan…
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId,
        order: 9,
        // Unstamped, so the tombstone is the only thing that can refuse the replay.
        part: { kind: "plan" as const, steps: STEPS },
      });
    });
    // …and the old run is rebroadcast: the tombstone makes it a no-op.
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    const parts = await planParts(t, messageId);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ kind: "plan", steps: STEPS });
  });
  test("a child BORN INSIDE a delivery, with no anchor of its own, still clears (codex P2)", async () => {
    const t = convexTest(schema, modules);
    // The child never opened a message: its row carries no `parentMessageId`, only
    // the run it was born inside. The anchor lives on THAT run's engagement row —
    // exactly what the announce reopen resolves, and what the clear used to miss.
    const BORN_OF = "spawn_agent:cccccccc-0000-4000-8000-000000000003:ok";
    const { chatId, messageId } = await seed(t, { withRow: false });
    await t.run(async (ctx) => {
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "task:cccccccc-0000-4000-8000-000000000003",
        kind: "task" as const,
        status: "done" as const,
        parentMessageId: messageId,
        anchorExact: true,
        createdAt: 800,
        updatedAt: 850,
      });
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: CHILD,
        status: "running" as const,
        bornOfRun: BORN_OF,
        createdAt: 900,
        updatedAt: 950,
      });
    });
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    const parts = await planParts(t, messageId);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ kind: "plan", steps: [] });
  });
  test("a GUESSED anchor never clears — direct row, and inherited carrier (codex)", async () => {
    // The observer fills `parentMessageId` with the session's last-known message when
    // no sighting correlated the child. That anchor is plausible, not proven, and the
    // reopen's positional gates do not run here: clearing on it would hide another
    // turn's checklist.
    for (const shape of ["direct", "carrier"] as const) {
      const t = convexTest(schema, modules);
      const { chatId, messageId } = await seed(t, { withRow: false });
      await t.run(async (ctx) => {
        if (shape === "direct") {
          await ctx.db.insert("subAgents", {
            chatId,
            childSessionKey: CHILD,
            status: "done" as const,
            parentMessageId: messageId, // no anchorExact -> a GUESS
            createdAt: 900,
            updatedAt: 950,
          });
        } else {
          await ctx.db.insert("subAgents", {
            chatId,
            childSessionKey: "task:cccccccc-0000-4000-8000-000000000003",
            kind: "task" as const,
            status: "done" as const,
            parentMessageId: messageId, // the CARRIER's anchor is the guess
            createdAt: 800,
            updatedAt: 850,
          });
          await ctx.db.insert("subAgents", {
            chatId,
            childSessionKey: CHILD,
            status: "running" as const,
            bornOfRun: "spawn_agent:cccccccc-0000-4000-8000-000000000003:ok",
            createdAt: 900,
            updatedAt: 950,
          });
        }
      });
      await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
      expect(await planParts(t, messageId)).toEqual([{ kind: "plan", steps: STEPS }]);
    }
  });





  test("a SILENT delivery clears a plan another run posted (codex)", async () => {
    // The main case, and the one an arrival-order rule got wrong: a delivery that opens
    // no message appears in no merge list, so ordering on that list refused every clear
    // it ever made. A run arriving for the FIRST time — no trace of its own on this
    // bubble — is later than whatever it finds there.
    const t = convexTest(schema, modules);
    const OTHER = `announce:v1:${CHILD}:aaaaaaaa-0000-4000-8000-00000000000e`;
    const { chatId, messageId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId,
        order: 2,
        part: { kind: "plan" as const, steps: STEPS },
        announceRun: OTHER,
      });
    });
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    const parts = await planParts(t, messageId);
    expect(parts[parts.length - 1]).toEqual({ kind: "plan", steps: [] });
  });




  test("carries the sink's receive stamp onto the tombstone", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await t.mutation(internal.stream.clearPlanPart, {
      chatId,
      runId: RUN,
      stamp: 4242,
    });
    const parts = await planParts(t, messageId);
    expect(parts[parts.length - 1]).toEqual({
      kind: "plan",
      steps: [],
      stamp: 4242,
    });
  });

  test("a RETRIED clear does not hide a plan posted after its cause (2026.9.1 window)", async () => {
    // The window that stayed open through five refused barriers: the clear's first
    // write is LOST, another run posts a plan, the retry (IDEMPOTENT_OPS) lands the
    // tombstone AFTER it. The tombstone is still written — nothing is refused here —
    // but it carries the instant the sink RECEIVED the empty frame, which is older
    // than the plan it landed behind, so the reader keeps that plan.
    const t = convexTest(schema, modules);
    const OTHER = `announce:v1:${CHILD}:aaaaaaaa-0000-4000-8000-00000000000f`;
    const { chatId, messageId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId,
        order: 2,
        // Published while the clear's first POST was failing.
        part: { kind: "plan" as const, steps: STEPS, stamp: 2_000 },
        announceRun: OTHER,
      });
    });
    await t.mutation(internal.stream.clearPlanPart, {
      chatId,
      runId: RUN,
      stamp: 1_000,
    });
    const parts = await planParts(t, messageId);
    expect(parts[parts.length - 1]).toEqual({ kind: "plan", steps: [], stamp: 1_000 });
    expect(resolveCurrentPlan(parts as { steps: unknown[]; stamp?: number }[])).toEqual({
      kind: "plan",
      steps: STEPS,
      stamp: 2_000,
    });
  });

  test("a clear CAUSED after the plan still hides it", async () => {
    const t = convexTest(schema, modules);
    const OTHER = `announce:v1:${CHILD}:aaaaaaaa-0000-4000-8000-000000000010`;
    const { chatId, messageId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId,
        order: 2,
        part: { kind: "plan" as const, steps: STEPS, stamp: 2_000 },
        announceRun: OTHER,
      });
    });
    await t.mutation(internal.stream.clearPlanPart, {
      chatId,
      runId: RUN,
      stamp: 3_000,
    });
    const parts = await planParts(t, messageId);
    expect(resolveCurrentPlan(parts as { steps: unknown[]; stamp?: number }[])).toBeNull();
  });

  test("no engagement row, or a run that names no child: nothing happens", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t, { withRow: false });
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: RUN });
    await t.mutation(internal.stream.clearPlanPart, { chatId, runId: "webchat-abc" });
    expect(await planParts(t, messageId)).toHaveLength(1);
  });
});

// The stamp is worthless if it does not REACH the reader: `resolveCurrentPlan`
// runs in the browser, on the parts `listByChat` ships. A previous lot lost a
// field exactly there — asserted in Convex, stripped at the boundary — so the
// crossing is tested, not assumed.
describe("the plan stamp crosses the read boundary", () => {
  test("listByChat ships it, and the reader then keeps the plan a replayed clear landed after", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const as = t.withIdentity({ subject: `${userId}|session` });
    const chatId = await t.run(async (ctx) => {
      await ctx.db.insert("profiles", {
        userId,
        role: "user",
        canonical: "alice",
      });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Plan posé.",
        updatedAt: 1000,
      });
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: { kind: "plan" as const, steps: STEPS, stamp: 2_000 },
      });
      await ctx.db.insert("messageParts", {
        messageId,
        order: 1,
        part: { kind: "plan" as const, steps: [], stamp: 1_000 },
      });
      return chatId;
    });
    const rows = await as.query(api.messages.listByChat, {
      chatId: chatId as string,
    });
    const plans = rows[0].parts.filter((p) => p.kind === "plan");
    expect(plans.map((p) => (p as { stamp?: number }).stamp)).toEqual([
      2_000, 1_000,
    ]);
    expect(
      resolveCurrentPlan(plans as { steps: unknown[]; stamp?: number }[]),
    ).toMatchObject({ steps: STEPS });
  });
});

// A rebroadcast of the SAME plan arrives with a fresh receive stamp. The replay
// dedup keys on content, so it must ignore that stamp — otherwise the plan is
// re-inserted and resurrects a checklist a later run had already cleared.
//
// The window cannot tell that rebroadcast from a genuine re-publication of an
// identical plan, and does not try to: this pins the CHOSEN reading, whose cost
// is stated at `replayKey` in convex/stream.ts (codex).
describe("the replay dedup ignores the plan's stamp", () => {
  const RUN = "announce:v1:agent:files:subagent:x:y";
  async function seedArmed(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Rapport.",
        runId: RUN,
        announceReplayArmed: Date.now() + 60_000,
        announceReplayRun: RUN,
        updatedAt: 1000,
      });
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: { kind: "plan" as const, steps: STEPS, stamp: 100 },
        announceRun: RUN,
      });
      await ctx.db.insert("messageParts", {
        messageId,
        order: 1,
        part: { kind: "plan" as const, steps: [], stamp: 200 },
        announceRun: "announce:v1:agent:files:subagent:x:later",
      });
      return { chatId, messageId };
    });
  }

  test("the same plan, re-stamped, is NOT re-inserted — the cleared checklist stays hidden", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedArmed(t);
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "plan" as const, steps: STEPS, stamp: 300 },
    });
    const parts = await planParts(t, messageId);
    expect(parts).toHaveLength(2);
    expect(
      resolveCurrentPlan(parts as { steps: unknown[]; stamp?: number }[]),
    ).toBeNull();
  });

  test("a DIFFERENT plan still lands inside the window", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedArmed(t);
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: {
        kind: "plan" as const,
        steps: [{ step: "Nouvelle étape", status: "pending" as const }],
        stamp: 300,
      },
    });
    expect(await planParts(t, messageId)).toHaveLength(3);
  });
});

// The stamp the bridge posts INSIDE a part is network input like any other.
describe("addPart refuses an unusable plan stamp", () => {
  test.each([0, -1, NaN, Infinity, -Infinity])(
    "a stamp of %s is dropped, not stored",
    async (bad) => {
      const t = convexTest(schema, modules);
      const { messageId } = await seed(t);
      await t.mutation(internal.stream.addPart, {
        messageId,
        part: { kind: "plan" as const, steps: STEPS, stamp: bad },
      });
      const parts = await planParts(t, messageId);
      expect(parts[parts.length - 1]).toEqual({ kind: "plan", steps: STEPS });
    },
  );
  test("a stamp posted in MILLISECONDS is dropped — the unit regression", async () => {
    // ~1000x the server's own seconds: it would outrank every correct stamp for
    // the life of the message and pin one plan as current forever (codex).
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "plan" as const, steps: STEPS, stamp: Date.now() },
    });
    const parts = await planParts(t, messageId);
    expect(parts[parts.length - 1]).toEqual({ kind: "plan", steps: STEPS });
  });
  test("a stamp in SECONDS, even a skewed one, is kept", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    // An hour ahead: bridge clocks drift, and refusing that costs more than
    // admitting it.
    const skewed = Date.now() / 1000 + 3_600;
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "plan" as const, steps: STEPS, stamp: skewed },
    });
    const parts = await planParts(t, messageId);
    expect(parts[parts.length - 1]).toEqual({
      kind: "plan",
      steps: STEPS,
      stamp: skewed,
    });
  });
  test("a usable stamp is kept", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    await t.mutation(internal.stream.addPart, {
      messageId,
      part: { kind: "plan" as const, steps: STEPS, stamp: 5 },
    });
    const parts = await planParts(t, messageId);
    expect(parts[parts.length - 1]).toEqual({
      kind: "plan",
      steps: STEPS,
      stamp: 5,
    });
  });
});
