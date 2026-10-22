/// <reference types="vite/client" />
//
// "DID THIS DELIVERY ALREADY ANSWER?" — 0.96.0's rule (`batchAnswered`), still applied when
// a `:retry-N` replays a batch 0.96.0 merged into a bubble: text from where this delivery's
// generation begins, parts this delivery stamped, a file only while its blob resolves,
// storage failure counted as answered. The differential below requires the same decision
// AND the same reads as the v0.96.0 code. A delivery's OWN bubble is never reused by a
// retry since 0.102.0 (each run has its bubble), so no probe is asked of one.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import { legacyBatchAnswered } from "./stream";
import { legacyV096BatchAnswered } from "./fixtures/batchAnsweredV096.test";
import { TransactionMetricsTracker } from "convex-test/dist/transactionMetrics.js";

// Documents read, as convex-test charges them (the same tracker the invariance harness uses).
let reads = 0;
const proto = TransactionMetricsTracker.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const originalTrackRead = proto.trackRead!;
proto.trackRead = function (this: unknown, ...args: unknown[]) {
  reads++;
  return originalTrackRead.apply(this, args);
};

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
  vi.useFakeTimers();
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  vi.useRealTimers();
});

const SK = "agent:main:atrium:chat:u:c1";
const CR = "742ca132-060c-4cf8-8c0a-3f1377095ea3";
const W = `announce:requester-settle:main:${SK}:${CR}:yield-1`;
const WR = `${W}:retry-1`;
const KEY = `settle:${CR}`;
const PREFIX = "Je délègue.";
const AT = PREFIX.length + 2;

type PartSpec =
  | { kind: "tool"; stamp?: string; big?: boolean }
  | { kind: "file"; stamp?: string; blob: "ok" | "gone" };
type State = { name: string; text: string; parts: PartSpec[]; storageDown?: boolean; expected: boolean };

const STATES: State[] = [
  { name: "inherited text only (nothing new)", text: "", parts: [], expected: false },
  { name: "an answer in text", text: "SYNTHESE: fini.", parts: [], expected: true },
  { name: "tool cards only", text: "", parts: [{ kind: "tool", stamp: W }, { kind: "tool", stamp: W }], expected: false },
  { name: "a file whose blob resolves", text: "", parts: [{ kind: "file", stamp: W, blob: "ok" }], expected: true },
  { name: "a file whose blob is gone", text: "", parts: [{ kind: "file", stamp: W, blob: "gone" }], expected: false },
  { name: "a file while storage is down", text: "", parts: [{ kind: "file", stamp: W, blob: "ok" }], storageDown: true, expected: true },
  { name: "large tool outputs", text: "", parts: Array.from({ length: 6 }, () => ({ kind: "tool" as const, stamp: W, big: true })), expected: false },
  {
    name: "a file beyond the first page",
    text: "",
    parts: [...Array.from({ length: 70 }, () => ({ kind: "tool" as const, stamp: W })), { kind: "file", stamp: W, blob: "ok" }],
    expected: true,
  },
  { name: "a file of ANOTHER delivery (inherited)", text: "", parts: [{ kind: "file", stamp: "announce:v1:agent:files:subagent:a:run-a", blob: "ok" }], expected: false },
  {
    name: "an answer in text beside large tool outputs (no part is read)",
    text: "SYNTHESE: fini.",
    parts: Array.from({ length: 6 }, () => ({ kind: "tool" as const, stamp: W, big: true })),
    expected: true,
  },
];

async function bubble(t: T, chatId: Id<"chats">, userId: Id<"users">, s: State, own: "fresh" | null) {
  return t.run(async (ctx) => {
    const merged = own !== "fresh";
    const id = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: merged ? `${PREFIX}\n\n${s.text}` : s.text,
      runId: W,
      turnSessionKey: SK,
      boundInstance: "prod",
      ...(merged ? { announcePrefix: PREFIX, continuations: [{ at: AT, childRunIds: [CR] }], mergedAnnounceRuns: [W] } : {}),
      ...(own !== null ? { deliveryOwnBubble: true, deliveryKey: KEY } : {}),
      updatedAt: 1,
    } as never);
    let order = 0;
    for (const p of s.parts) {
      if (p.kind === "tool") {
        await ctx.db.insert("messageParts", {
          messageId: id,
          order: order++,
          ...(p.stamp !== undefined ? { announceRun: p.stamp } : {}),
          part: { kind: "tool", name: "exec", phase: "result", toolCallId: `c${order}`, ...(p.big ? { output: "x".repeat(700 * 1024) } : {}) },
        } as never);
      } else {
        const storageId = await ctx.storage.store(new Blob(["pdf"]));
        if (p.blob === "gone") await ctx.storage.delete(storageId);
        await ctx.db.insert("messageParts", {
          messageId: id,
          order: order++,
          ...(p.stamp !== undefined ? { announceRun: p.stamp } : {}),
          part: { kind: "file", storageId, filename: "r.pdf", mimeType: "application/pdf" },
        } as never);
      }
    }
    return id;
  });
}

const withStorage = (ctx: MutationCtx, down: boolean): MutationCtx =>
  down
    ? ({
        ...ctx,
        db: ctx.db,
        scheduler: ctx.scheduler,
        storage: { ...ctx.storage, getUrl: async () => { throw new Error("storage down"); } },
      } as unknown as MutationCtx)
    : ctx;

async function chat(t: T) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
    return { userId, chatId };
  });
}

describe("the merged-bubble decision ≡ 0.96.0's batchAnswered", () => {
  for (const s of STATES) {
    test(s.name, async () => {
      const t = convexTest({ schema, modules });
      const { chatId, userId } = await chat(t);
      const legacy = await bubble(t, chatId, userId, s, null);
      const decide = async (fn: (ctx: MutationCtx, doc: Doc<"messages">) => Promise<boolean | null>, id: Id<"messages">) => {
        const doc = (await t.run((ctx) => ctx.db.get(id))) as Doc<"messages">;
        reads = 0;
        const answer = await t.run((raw) => fn(withStorage(raw, s.storageDown === true), doc));
        return { answer, reads };
      };
      // THE REAL v0.96.0 CODE (extracted from the tag), and its reads.
      const v096 = await decide((ctx, doc) => legacyV096BatchAnswered(ctx, doc, doc._id, { at: AT, childRunIds: [CR] }), legacy);
      const now = await decide((ctx, doc) => legacyBatchAnswered(ctx, doc, [CR], WR), legacy);
      expect(v096.answer).toBe(s.expected);
      // 0.96.0's merge path: same decision AND the same reads as the tag's code.
      expect(now).toEqual(v096);
    }, 60_000);
  }
});

// ── Codex pass 10 repros ─────────────────────────────────────────────────────────────

async function projected(t: T) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "main", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main", transcriptSeenAt: 1 } as never);
    return { userId, chatId };
  });
}
const startRun = (t: T, chatId: Id<"chats">, runId: string) =>
  t.mutation(internal.stream.startAssistant, { chatId, runId, turnSessionKey: SK, boundInstanceName: "prod" }) as Promise<Id<"messages"> | null>;

describe("codex phase 5 pass 10 — the repro that holds", () => {
  // FINAL DESIGN STEP 4: a retry is another run with its own bubble — never the earlier
  // attempt's, even one that answered nothing.
  test("a retry opens its own bubble, the probe is never asked", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await projected(t);
    const mW = await bubble(t, chatId, userId, { name: "", text: "", parts: [{ kind: "file", stamp: W, blob: "gone" }], expected: false }, "fresh");
    const mR = await startRun(t, chatId, WR);
    expect(mR).not.toBe(mW);
    expect((await t.run((ctx) => ctx.db.get(mW)))!.status).toBe("complete");
  });

});
