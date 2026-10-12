/// <reference types="vite/client" />
//
// "DID THIS DELIVERY ALREADY ANSWER?" — ONE predicate (codex phase 5 pass 10). Phase 5's
// own delivery bubbles decide a `:retry-N` with the SAME rule 0.96.0's merge path applies
// (`batchAnswered`): text from where this delivery's generation begins, parts this
// delivery stamped, a file only while its blob resolves, storage failure counted as
// answered. The differential below builds each bubble state twice — as 0.96.0's merged
// bubble and as a phase 5 own bubble — and requires the same decision; then Codex's three
// repros stay as regressions (after a rollback, in `on`, under the real read limits).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import { legacyBatchAnswered, ownBubbleAnswered } from "./stream";
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

describe("own-bubble decision ≡ 0.96.0's batchAnswered", () => {
  for (const s of STATES) {
    test(s.name, async () => {
      const t = convexTest({ schema, modules });
      const { chatId, userId } = await chat(t);
      const legacy = await bubble(t, chatId, userId, s, null);
      const ownFresh = await bubble(t, chatId, userId, s, "fresh");
      const decide = async (fn: (ctx: MutationCtx, doc: Doc<"messages">) => Promise<boolean | null>, id: Id<"messages">) => {
        const doc = (await t.run((ctx) => ctx.db.get(id))) as Doc<"messages">;
        reads = 0;
        const answer = await t.run((raw) => fn(withStorage(raw, s.storageDown === true), doc));
        return { answer, reads };
      };
      // THE REAL v0.96.0 CODE (extracted from the tag), and its reads.
      const v096 = await decide((ctx, doc) => legacyV096BatchAnswered(ctx, doc, doc._id, { at: AT, childRunIds: [CR] }), legacy);
      const now = await decide((ctx, doc) => legacyBatchAnswered(ctx, doc, [CR], WR), legacy);
      const fresh = await decide((ctx, doc) => ownBubbleAnswered(ctx, doc, WR), ownFresh);
      expect(v096.answer).toBe(s.expected);
      // 0.96.0's merge path: same decision AND the same reads as the tag's code.
      expect(now).toEqual(v096);
      // Phase 5's own bubble: the same decision. (An own bubble another delivery merged into
      // no longer exists — §14.26 — so there is no "merged own" variant to compare.)
      expect(fresh.answer).toBe(s.expected);
    }, 60_000);
  }
});

// ── Codex pass 10 repros ─────────────────────────────────────────────────────────────

async function projected(t: T, mode: "on" | "shadow") {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "main", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: mode } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main", transcriptSeenAt: 1 } as never);
    return { userId, chatId };
  });
}
const startRun = (t: T, chatId: Id<"chats">, runId: string) =>
  t.mutation(internal.stream.startAssistant, { chatId, runId, turnSessionKey: SK, boundInstanceName: "prod" }) as Promise<Id<"messages"> | null>;

describe("codex phase 5 pass 10 — the repros", () => {
  test("#1 after a rollback: B's batch, joined to A's own bubble, is never merged there — nor is its retry (§14.26)", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await projected(t, "shadow");
    const mA = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "résultat A", runId: "announce:v1:agent:files:subagent:a:run-a", turnSessionKey: SK, boundInstance: "prod", deliveryOwnBubble: true, deliveryKey: "run:announce:v1:agent:files:subagent:a:run-a", updatedAt: 1 } as never),
    );
    await t.run((ctx) =>
      ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: mA, anchorExact: true, childSessionKey: "agent:files:subagent:b", childRunId: CR, kind: "subagent" as const, status: "done" as const, createdAt: 1, updatedAt: 1 }),
    );
    const mB = (await startRun(t, chatId, W))!;
    expect(mB).not.toBe(mA);
    await t.mutation(internal.stream.finalize, { messageId: mB, status: "complete", expectedRunId: W } as never);
    const retried = (await startRun(t, chatId, WR))!;
    expect(retried).not.toBe(mA);
    await t.mutation(internal.stream.appendDelta, { messageId: retried, text: "B recovered answer", expectedRunId: WR } as never);
    await t.mutation(internal.stream.finalize, { messageId: retried, status: "complete", text: "B recovered answer", expectedRunId: WR } as never);
    expect((await t.run((ctx) => ctx.db.get(mA)))!.text).toBe("résultat A");
    expect((await t.run((ctx) => ctx.db.get(retried)))!.text).toBe("B recovered answer");
  });

  test("#2 in `on`: a file whose blob is gone does not refuse the retry that can repair it", async () => {
    const t = convexTest({ schema, modules });
    const { chatId, userId } = await projected(t, "on");
    const mW = await bubble(t, chatId, userId, { name: "", text: "", parts: [{ kind: "file", stamp: W, blob: "gone" }], expected: false }, "fresh");
    expect(await startRun(t, chatId, WR)).toBe(mW);
    expect((await t.run((ctx) => ctx.db.get(mW)))!.status).toBe("streaming");
  });

  test("#3 under the real read limits: 19 tool outputs of 900 KiB — the probe stays bounded, the retry resumes", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { chatId, userId } = await projected(t, "on");
    const mW = await bubble(t, chatId, userId, { name: "", text: "", parts: [], expected: false }, "fresh");
    for (let i = 0; i < 19; i++) {
      await t.run((ctx) =>
        ctx.db.insert("messageParts", { messageId: mW, order: i, announceRun: W, part: { kind: "tool", name: "exec", phase: "result", toolCallId: `c${i}`, output: "x".repeat(900 * 1024) } } as never),
      );
    }
    expect(await startRun(t, chatId, WR)).toBe(mW);
    expect((await t.run((ctx) => ctx.db.get(mW)))!.status).toBe("streaming");
  }, 120_000);
});
