/// <reference types="vite/client" />
//
// SWITCHING AN INSTANCE TO `on` OVER 0.96.0's DATA (codex phase 5 pass 12, design §14.23).
// The day production switches an instance to `on`, its conversations already hold what
// 0.96.0 wrote: deliveries MERGED into their parent (no delivery key, no own-bubble
// marker), recorded continuations, parked prefixes, sub-agent anchors, no display group.
// Phase 5 changes what a NEW delivery does (its own bubble below, grouped for display);
// it must not change what happens to anything 0.96.0 already wrote.
//
// Each row of the §14.23 table is a scenario below, built from documents 0.96.0 itself
// writes, run in `on`. Its outcome is MEASURED on the 0.96.0 tree (`git archive v0.96.0`,
// this file copied in, ON_SWITCH_RECORD=<path>) into `fixtures/on-switch-v096.json`, and
// this tree must reach the same outcome — except the rows marked `phase5`, the deliberate
// change (a delivery never merged before opens its own bubble), asserted for what it is.

import { readFileSync, writeFileSync } from "node:fs";
import { convexTest, type TestConvex } from "convex-test";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  vi.useRealTimers();
});

const SK = "agent:main:atrium:chat:u:c1";
const CHILD_KEY = "agent:files:subagent:0d59e951-cbaa-44f1-92e5-33b9729d096e";
const CR = "742ca132-060c-4cf8-8c0a-3f1377095ea3";
const A = `announce:v1:${CHILD_KEY}:${CR}`;
const A2 = `announce:v1:agent:files:subagent:second:${CR}2`;
const W = `announce:requester-settle:main:${SK}:${CR}:yield-1`;
const WR = `${W}:retry-1`;
const CR2 = "842ca132-060c-4cf8-8c0a-3f1377095ea3";
const W2 = `announce:requester-settle:main:${SK}:${CR},${CR2}:yield-1`;
const TASK_ID = "bf66f802-e5a6-4394-9815-40c4bcd28dae";
const TASK = `image_generate:${TASK_ID}:ok`;
const PREFIX = "Je délègue.";

type World = { t: T; userId: Id<"users">; chatId: Id<"chats">; labels: Map<string, string>; P: Id<"messages"> };

/** An `on` conversation (the instance switched, the transcript already read once) holding
 *  three 0.96.0 turns; `P` is the last answer. `shape` lays 0.96.0's documents on it. */
async function onWorld(shape: (ctx: Parameters<Parameters<T["run"]>[0]>[0], w: Omit<World, "t" | "labels">) => Promise<Record<string, string>>, mode: "on" | "shadow" = "on"): Promise<World> {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const labels = new Map<string, string>();
  const base = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "main", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: mode } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main", transcriptSeenAt: 1 } as never);
    let P: Id<"messages"> | null = null;
    for (let i = 0; i < 3; i++) {
      const u = await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: `q${i}`, sendId: `send${i}`, updatedAt: 1 });
      const a = await ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: `r${i}`, runId: `run${i}`, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 });
      labels.set(u, `u${i}`);
      labels.set(a, i === 2 ? "P" : `a${i}`);
      P = a;
    }
    const extra = await shape(ctx, { userId, chatId, P: P! });
    for (const [id, label] of Object.entries(extra)) labels.set(id, label);
    return { userId, chatId, P: P! };
  });
  return { t, labels, ...base };
}

const start = (w: World, runId: string) =>
  w.t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId, turnSessionKey: SK, boundInstanceName: "prod" }) as Promise<Id<"messages"> | null>;

const label = (w: World, id: string | null) => (id === null ? null : (w.labels.get(id) ?? "new"));

/** What 0.96.0 decided, in terms both trees share: where the run landed, and the state of
 *  every bubble 0.96.0 knows (phase 5's own fields left out — they are asserted apart). */
async function outcome(w: World, landed: Id<"messages"> | null) {
  const messages = await w.t.run((ctx) => ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", w.chatId)).collect());
  return {
    landed: label(w, landed),
    bubbles: messages.map((m) => ({
      id: label(w, m._id),
      role: m.role,
      status: m.status,
      runId: m.runId ?? null,
      text: m.text,
      mergedAnnounceRuns: m.mergedAnnounceRuns ?? null,
      continuations: m.continuations ?? null,
      announcePrefix: m.announcePrefix ?? null,
      replayArmed: m.announceReplayArmed !== undefined,
      interrupted: m.interruptedAt !== undefined,
    })),
  };
}

const legacyMerged = (over: Record<string, unknown>) => ({ announcePrefix: "r2", mergedIntoTurn: true, ...over });

/** The §14.23 rows. `kind: "v096"` — the outcome must equal 0.96.0's, measured. */
type Outcome = Awaited<ReturnType<typeof outcome>>;
type Row = {
  /** v096: the outcome must equal 0.96.0's. phase5: the deliberate change (own bubble).
   *  fixed: 0.96.0's outcome was itself a second answer — the row says what `on` does. */
  kind: "v096" | "phase5" | "fixed";
  run: () => Promise<{ w: World; landed: Id<"messages"> | null }>;
  fixed?: (got: Outcome, v096: Outcome) => void;
  /** More to assert on this tree. */
  check?: (w: World) => Promise<void>;
};
const ROWS: Record<string, Row> = {
  // L1 — an announce 0.96.0 merged, rebroadcast: handed its bubble back (replay window armed).
  "L1 merged announce · rebroadcast": {
    kind: "v096",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.patch(b.P, legacyMerged({ runId: A, text: "r2\n\nrésultat", mergedAnnounceRuns: [A] }) as never);
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: A, messageId: b.P, createdAt: 1 });
        return {};
      });
      return { w, landed: await start(w, A) };
    },
  },
  // L2 — Codex's repro: a settle batch 0.96.0 merged, its continuation recorded, ANSWERED;
  // the gateway's `:retry-1` wake: the bubble back, nothing reopened.
  "L2 merged settle · retry, answered": {
    kind: "v096",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.patch(b.P, legacyMerged({ runId: W, text: `r2\n\nSYNTHESE: fini.`, mergedAnnounceRuns: [W], continuations: [{ at: 4, childRunIds: [CR] }] }) as never);
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: W, messageId: b.P, createdAt: 1 });
        return {};
      });
      return { w, landed: await start(w, WR) };
    },
  },
  // L3 — the same batch merged but answered NOTHING: the retry brings the answer, into
  // that bubble (0.96.0 reopens it), not into a second one.
  "L3 merged settle · retry, unanswered": {
    kind: "v096",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.patch(b.P, legacyMerged({ runId: W, text: `r2\n\n`, mergedAnnounceRuns: [W], continuations: [{ at: 4, childRunIds: [CR] }] }) as never);
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: W, messageId: b.P, createdAt: 1 });
        return {};
      });
      return { w, landed: await start(w, WR) };
    },
  },
  // L4 — a merge 0.96.0 left in ERROR (the bridge lost mid-delivery): the replay resumes
  // it from its parked prefix.
  "L4 merged announce · error, replay resumes": {
    kind: "v096",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.patch(b.P, legacyMerged({ runId: A, status: "error", error: "lost", text: "r2\n\nrésul", mergedAnnounceRuns: [A] }) as never);
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: A, messageId: b.P, createdAt: 1 });
        return {};
      });
      return { w, landed: await start(w, A) };
    },
  },
  // L5 — a bubble a LATER delivery owns now: an older one's replay is history.
  "L5 merged announce · later generation owns": {
    kind: "v096",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.patch(b.P, legacyMerged({ runId: A2, text: "r2\n\nun\n\ndeux", mergedAnnounceRuns: [A, A2] }) as never);
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: A, messageId: b.P, createdAt: 1 });
        return {};
      });
      return { w, landed: await start(w, A) };
    },
  },
  // L6 — a merge the user STOPPED: the replay lands on nothing new.
  "L6 merged announce · stopped": {
    kind: "v096",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.patch(b.P, legacyMerged({ runId: A, status: "aborted", text: "r2\n\nrés", mergedAnnounceRuns: [A], interruptedAt: 5 }) as never);
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: A, messageId: b.P, createdAt: 1 });
        return {};
      });
      return { w, landed: await start(w, A) };
    },
  },
  // L7 — a background task's delivery 0.96.0 merged, rebroadcast.
  "L7 merged task delivery · rebroadcast": {
    kind: "v096",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.patch(b.P, legacyMerged({ runId: TASK, text: "r2\n\nimage prête", mergedAnnounceRuns: [TASK] }) as never);
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: `task:${TASK_ID}`, kind: "task" as const, taskName: "image_generate", status: "done" as const, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: TASK, messageId: b.P, createdAt: 1 });
        return {};
      });
      return { w, landed: await start(w, TASK) };
    },
  },
  // L8 — a delivery 0.96.0 could NOT merge (its parent was busy) and gave a bubble of its
  // own, without any phase 5 marker: its replay. 0.96.0 merged the replay into the parent —
  // the answer twice (measured). In `on` it lands on its own bubble, the parent untouched.
  "L8 standalone 0.96.0 delivery bubble · replay": {
    kind: "fixed",
    run: async () => {
      const w = await onWorld(async (ctx, b) => standalone(ctx, b, A, { status: "complete", text: "résultat" }));
      return { w, landed: await start(w, A) };
    },
    fixed: (got, v096) => {
      expect(v096.landed).toBe("P");
      expect(got.landed).toBe("D");
      expect(got.bubbles.find((b) => b.id === "P")).toEqual({ ...v096.bubbles.find((b) => b.id === "P"), status: "complete", runId: "run2", text: "r2", mergedAnnounceRuns: null, announcePrefix: null, replayArmed: false });
      expect(got.bubbles.find((b) => b.id === "D")).toMatchObject({ status: "complete", runId: A, text: "résultat", replayArmed: true });
      expect(got.bubbles.length).toBe(v096.bubbles.length);
    },
  },
  // L8b — the same for a settle batch's bubble that ended in ERROR. FINAL DESIGN STEP 4: in
  // `on` its `:retry-1` is another run — its OWN bubble; the failed attempt's is left as it
  // is (no more `resumeOwnDelivery` across attempts in `on`).
  "L8b standalone 0.96.0 settle bubble · error, retry resumes": {
    kind: "fixed",
    run: async () => {
      const w = await onWorld(async (ctx, b) => standalone(ctx, b, W, { status: "error", text: "SYNTH" }));
      return { w, landed: await start(w, WR) };
    },
    fixed: (got, v096) => {
      expect(v096.landed).toBe("P");
      expect(got.landed).toBe("new");
      expect(got.bubbles.find((b) => b.id === "P")).toMatchObject({ status: "complete", runId: "run2", text: "r2" });
      expect(got.bubbles.find((b) => b.id === "D")).toMatchObject({ status: "error", runId: W, text: "SYNTH" });
      expect(got.bubbles.find((b) => b.id === "new")).toMatchObject({ status: "streaming", runId: WR });
      expect(got.bubbles.length).toBe(v096.bubbles.length + 1);
    },
  },
  // L8c — a settle batch's bubble ANSWERED by its first retry, then a second retry. FINAL
  // DESIGN STEP 4: in `on` the second retry is another run — its own bubble; the answer
  // stays where it was.
  "L8c standalone 0.96.0 settle bubble · answered, second retry": {
    kind: "fixed",
    run: async () => {
      const w = await onWorld(async (ctx, b) => standalone(ctx, b, WR, { status: "complete", text: "SYNTHESE: fini." }));
      return { w, landed: await start(w, `${W}:retry-2`) };
    },
    fixed: (got, v096) => {
      expect(v096.landed).toBe("P");
      expect(got.landed).toBe("new");
      expect(got.bubbles.find((b) => b.id === "P")).toMatchObject({ status: "complete", runId: "run2", text: "r2" });
      expect(got.bubbles.find((b) => b.id === "D")).toMatchObject({ status: "complete", runId: WR, text: "SYNTHESE: fini." });
      expect(got.bubbles.find((b) => b.id === "new")).toMatchObject({ status: "streaming", runId: `${W}:retry-2` });
      expect(got.bubbles.length).toBe(v096.bubbles.length + 1);
    },
  },
  // L9 — after L3's reopen, the retry ends with nothing more: 0.96.0's verdict on the
  // merged bubble (no phase 5 marker: its "delivered nothing" rule is 0.96.0's).
  "L9 merged settle · reopened retry finalizes empty": {
    kind: "v096",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.patch(b.P, legacyMerged({ runId: W, text: `r2\n\n`, mergedAnnounceRuns: [W], continuations: [{ at: 4, childRunIds: [CR] }] }) as never);
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: W, messageId: b.P, createdAt: 1 });
        return {};
      });
      const landed = await start(w, WR);
      if (landed !== null) await w.t.mutation(internal.stream.finalize, { messageId: landed, status: "complete" } as never);
      return { w, landed };
    },
  },
  // F1 — PHASE 5's deliberate change: a delivery never merged before, anchored to a 0.96.0
  // answer, opens its own bubble below it (0.96.0 reopened the answer).
  "F1 fresh announce on a 0.96.0 answer": {
    kind: "phase5",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 });
        return {};
      });
      return { w, landed: await start(w, A) };
    },
  },
  // F2 — the same for a settle batch never recorded on the 0.96.0 answer it joins.
  "F2 fresh settle on a 0.96.0 answer": {
    kind: "phase5",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        return {};
      });
      return { w, landed: await start(w, W) };
    },
  },
  // F3 — a fresh settle batch whose second member was anchored only by position: its own
  // bubble, and the positional anchor left as 0.96.0's data has it (the exact join is only
  // recorded when 0.96.0's path takes the delivery — a replay of its own merge).
  "F3 fresh settle · a positional member stays positional": {
    kind: "phase5",
    run: async () => {
      const w = await onWorld(async (ctx, b) => {
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, childSessionKey: `${CHILD_KEY}-2`, childRunId: CR2, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
        return {};
      });
      return { w, landed: await start(w, W2) };
    },
    check: async (w) => {
      const row = await w.t.run((ctx) => ctx.db.query("subAgents").filter((q) => q.eq(q.field("childRunId"), CR2)).first());
      expect(row?.anchorExact).toBeUndefined();
    },
  },
};

/** Rows on what is DISPLAYED and ANCHORED over 0.96.0's data (no delivery involved). */
const READS: Record<string, () => Promise<unknown>> = {
  // G1 — the message list: 0.96.0's bubbles carry no display group; listed as 0.96.0 did.
  "G1 list over 0.96.0 bubbles": async () => {
    const w = await mergedWorld();
    const view = (await w.t.withIdentity({ subject: `${w.userId}|session` }).query(api.messages.listByChat, { chatId: w.chatId as string })) as unknown as Array<
      Doc<"messages"> & { displayGroupId?: string }
    >;
    return view.map((m) => ({ id: label(w, m._id), status: m.status, text: m.text, runId: m.runId ?? null, group: m.displayGroupId ?? null }));
  },
  // G2 — deleting a 0.96.0 merged answer removes exactly what 0.96.0 removed.
  "G2 delete a 0.96.0 merged answer": async () => {
    const w = await mergedWorld();
    await w.t.withIdentity({ subject: `${w.userId}|session` }).mutation(api.messages.deleteMessage, { messageId: w.P });
    return (await outcome(w, null)).bubbles.map((b) => b.id);
  },
  // G3 — a report on a 0.96.0 merged answer freezes what 0.96.0 froze.
  "G3 report a 0.96.0 merged answer": async () => {
    const w = await mergedWorld();
    await w.t.withIdentity({ subject: `${w.userId}|session` }).mutation(api.feedback.submitFeedback, {
      chatId: w.chatId,
      messageId: w.P,
      category: "incorrect",
      client: { displayedText: "r2\n\nrésultat" },
    });
    const row = await w.t.run((ctx) => ctx.db.query("feedback").first());
    return relabel(w, row?.snapshot);
  },
  // S1 — a sub-agent row 0.96.0 anchored, observed again in `on`: its anchor stays.
  "S1 0.96.0 sub-agent row · observed again": async () => {
    const w = await mergedWorld();
    await w.t.mutation(internal.subAgents.upsertSubAgent, {
      chatId: w.chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      childSessionKey: CHILD_KEY,
      childRunId: CR,
      kind: "subagent",
      status: "done",
      resultText: "fini",
    });
    const row = await w.t.run((ctx) => ctx.db.query("subAgents").first());
    return { parent: label(w, row?.parentMessageId ?? null), exact: row?.anchorExact ?? null, status: row?.status, childRunId: row?.childRunId ?? null };
  },
  // S2 — a positional (inexact) 0.96.0 anchor, observed again with its run: unchanged.
  "S2 0.96.0 positional anchor · observed again": async () => {
    const w = await onWorld(async (ctx, b) => {
      await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, childSessionKey: CHILD_KEY, kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 });
      return {};
    });
    await w.t.mutation(internal.subAgents.upsertSubAgent, {
      chatId: w.chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      childSessionKey: CHILD_KEY,
      childRunId: CR,
      kind: "subagent",
      status: "running",
    });
    const row = await w.t.run((ctx) => ctx.db.query("subAgents").first());
    return { parent: label(w, row?.parentMessageId ?? null), exact: row?.anchorExact ?? null, childRunId: row?.childRunId ?? null };
  },
  // D1 — a 0.96.0 delivery bubble whose terminal is empty, with `dropIfEmpty`, in `on`:
  // 0.96.0's verdict ("delivered nothing"), its record kept — the automatic drop of an own
  // bubble (§14.24) never applies to it.
  "D1 0.96.0 delivery bubble · empty terminal with dropIfEmpty (on)": async () => {
    const { w, links } = await emptyLegacyDelivery("on");
    return { bubbles: (await outcome(w, null)).bubbles, links };
  },
  // D2 — the same after a rollback to shadow, then the run's replay: as 0.96.0.
  "D2 0.96.0 delivery bubble · empty terminal, then replay (shadow)": async () => {
    const { w, links } = await emptyLegacyDelivery("shadow");
    const landed = await start(w, A);
    return { links, ...(await outcome(w, landed)) };
  },
  // D3 — a 0.96.0 settle bubble 0.96.0 itself DROPS empty (its delegation still runs: no
  // "delivered nothing" verdict), then the run's replay: 0.96.0's record and its refusal
  // are kept exactly — only a phase 5 own bubble's drop releases its run.
  "D3 0.96.0 settle bubble dropped empty, then replay (shadow)": async () => {
    const w = await onWorld(async (ctx, b) => {
      const d = await ctx.db.insert("messages", { chatId: b.chatId, userId: b.userId, role: "assistant" as const, status: "streaming" as const, text: "", runId: W, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 });
      await ctx.db.insert("streamingText", { messageId: d, chatId: b.chatId, userId: b.userId, generation: W, boundInstance: "prod", text: "", updatedAt: 1 });
      await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: W, messageId: d, createdAt: 1 });
      await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: d, anchorExact: true, childSessionKey: `${CHILD_KEY}-next`, childRunId: CR2, kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 });
      return { [d]: "D" };
    }, "shadow");
    const D = [...w.labels].find(([, l]) => l === "D")![0] as Id<"messages">;
    await w.t.mutation(internal.stream.finalize, { messageId: D, status: "complete", text: "", dropIfEmpty: true } as never);
    const links = (await w.t.run((ctx) => ctx.db.query("runBubbles").collect())).map((l) => ({ runId: l.runId, to: label(w, l.messageId) }));
    const landed = await start(w, W);
    return { links, ...(await outcome(w, landed)) };
  },
  // U1 — a person deleted a merged answer BEFORE the switch (off: no tombstone is written);
  // then `on`: the delivery's replay and its transcript rows never bring the answer back.
  // The proof of that deletion is the run → bubble record left pointing at a bubble that no
  // longer exists — the reason a dangling reference must keep meaning "deleted" (§14.25).
  "U1 a person's deletion before the switch stays a deletion": async () => {
    const w = await mergedWorld();
    const asUser = w.t.withIdentity({ subject: `${w.userId}|session` });
    const chatDoc = (await w.t.run((ctx) => ctx.db.get(w.chatId)))!;
    await w.t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").collect())[0]!;
      await ctx.db.patch(inst._id, { config: { transcriptProjection: "off" } as never });
      await ctx.db.patch(w.chatId, { transcriptSeenAt: undefined } as never);
    });
    await asUser.mutation(api.messages.deleteMessage, { messageId: w.P });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    await w.t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").collect())[0]!;
      await ctx.db.patch(inst._id, { config: { transcriptProjection: "on" } as never });
      await ctx.db.patch(w.chatId, { transcriptSeenAt: (chatDoc as { transcriptSeenAt?: number }).transcriptSeenAt } as never);
    });
    const landed = await start(w, A);
    await w.t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId: w.chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "delta",
      deltaCursor: "c:u1",
      rows: [{ entryId: "late", seq: 40, role: "assistant", runId: A, hidden: false, visible: true, text: "résultat encore" }],
      terminals: [{ runId: A, status: "completed", at: 2 }],
      unidentified: 0,
      readAt: 5,
    } as never);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    return await outcome(w, landed);
  },
  // T1 — the first transcript read after the switch, over 0.96.0's bubbles (no launch in
  // its rows): the bubbles are 0.96.0's, and every step it schedules has run.
  "T1 first transcript read over 0.96.0 bubbles": async () => {
    const w = await mergedWorld();
    await w.t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId: w.chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "live",
      rows: [0, 1, 2].flatMap((i) => [
        { entryId: `u${i}`, seq: 1 + 2 * i, role: "user", runId: `send${i}`, sendId: `send${i}`, hidden: false, visible: true },
        { entryId: `a${i}`, seq: 2 + 2 * i, role: "assistant", runId: i === 2 ? A : `run${i}`, hidden: false, visible: true },
      ]),
      terminals: [],
      unidentified: 0,
      readAt: 5,
    } as never);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    return (await outcome(w, null)).bubbles;
  },
};

/** A bubble 0.96.0 opened for delivery `run` (its parent `P` was busy): `D`, recorded as the
 *  run's bubble, its child anchored exactly to `P`. */
async function standalone(
  ctx: Parameters<Parameters<T["run"]>[0]>[0],
  b: Omit<World, "t" | "labels">,
  run: string,
  state: { status: "complete" | "error"; text: string },
): Promise<Record<string, string>> {
  const d = await ctx.db.insert("messages", { chatId: b.chatId, userId: b.userId, role: "assistant" as const, status: state.status, text: state.text, runId: run, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 });
  await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 });
  await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: run, messageId: d, createdAt: 1 });
  return { [d]: "D" };
}

/** A delivery bubble 0.96.0 opened (no phase 5 marker), still streaming, recorded as the
 *  run's bubble: its terminal arrives EMPTY with `dropIfEmpty` (codex phase 5 pass 13). */
async function emptyLegacyDelivery(mode: "on" | "shadow") {
  const w = await onWorld(async (ctx, b) => {
    const d = await ctx.db.insert("messages", { chatId: b.chatId, userId: b.userId, role: "assistant" as const, status: "streaming" as const, text: "", runId: A, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 });
    await ctx.db.insert("streamingText", { messageId: d, chatId: b.chatId, userId: b.userId, generation: A, boundInstance: "prod", text: "", updatedAt: 1 });
    await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: A, messageId: d, createdAt: 1 });
    return { [d]: "D" };
  }, mode);
  const D = [...w.labels].find(([, l]) => l === "D")![0] as Id<"messages">;
  await w.t.mutation(internal.stream.finalize, { messageId: D, status: "complete", text: "", dropIfEmpty: true } as never);
  const links = await w.t.run((ctx) => ctx.db.query("runBubbles").collect());
  return { w, D, links: links.map((l) => ({ runId: l.runId, to: label(w, l.messageId) })) };
}

/** A 0.96.0 merged answer: `P` carries announce `A`, its child anchored exactly to it. */
function mergedWorld() {
  return onWorld(async (ctx, b) => {
    await ctx.db.patch(b.P, legacyMerged({ runId: A, text: "r2\n\nrésultat", mergedAnnounceRuns: [A] }) as never);
    await ctx.db.insert("subAgents", { chatId: b.chatId, userId: b.userId, instanceName: "prod", parentMessageId: b.P, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CR, kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 });
    await ctx.db.insert("runBubbles", { chatId: b.chatId, runId: A, messageId: b.P, createdAt: 1 });
    return {};
  });
}

function relabel(w: World, value: unknown): unknown {
  if (typeof value === "string") return w.labels.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => relabel(w, v));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, relabel(w, v)]));
  }
  return value;
}

const RECORD = process.env.ON_SWITCH_RECORD;
const BASELINE_PATH = new URL("./fixtures/on-switch-v096.json", import.meta.url);
const recorded: Record<string, unknown> = {};
const baseline: Record<string, unknown> = RECORD === undefined ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
afterAll(() => {
  if (RECORD !== undefined) writeFileSync(RECORD, JSON.stringify(recorded, null, 2) + "\n");
});

describe("switching to `on` over 0.96.0's data — the outcome 0.96.0 reaches (§14.23)", () => {
  for (const [name, row] of Object.entries(ROWS)) {
    test(name, async () => {
      const { w, landed } = await row.run();
      const got = await outcome(w, landed);
      recorded[name] = got;
      if (RECORD !== undefined) return;
      const v096 = baseline[name] as Outcome;
      // Nothing of phase 5's is written on 0.96.0's bubbles (only a new own bubble is marked).
      const marked = await w.t.run((ctx) => ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", w.chatId)).collect());
      // …except, in a `fixed` row, the 0.96.0 bubble the delivery adopted: it takes the
      // delivery's identity (§14.28), so a later replay in any mode finds it.
      expect(
        marked.filter(
          (m) => w.labels.has(m._id) && !(row.kind === "fixed" && m._id === landed) && (m.deliveryOwnBubble !== undefined || m.deliveryKey !== undefined),
        ),
      ).toEqual([]);
      if (row.kind === "fixed") expect(marked.find((m) => m._id === landed)?.deliveryOwnBubble).toBe(true);
      if (row.check !== undefined) await row.check(w);
      if (row.kind === "v096") {
        expect(got).toEqual(v096);
        return;
      }
      if (row.kind === "fixed") {
        row.fixed!(got, v096);
        return;
      }
      // phase5: 0.96.0 merged it into the answer (measured); phase 5 opens its own bubble
      // below, the 0.96.0 answer untouched.
      expect(v096.landed).toBe("P");
      expect(got.landed).toBe("new");
      expect(got.bubbles.find((b) => b.id === "P")).toMatchObject({ status: "complete", runId: "run2", text: "r2", mergedAnnounceRuns: null });
      const mine = (await w.t.run((ctx) => ctx.db.get(landed!)))!;
      expect(mine.deliveryOwnBubble).toBe(true);
    }, 60_000);
  }
  for (const [name, read] of Object.entries(READS)) {
    test(name, async () => {
      const got = await read();
      recorded[name] = got;
      if (RECORD === undefined) expect(got).toEqual(baseline[name]);
    }, 60_000);
  }
});
