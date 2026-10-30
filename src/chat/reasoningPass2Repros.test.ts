/// <reference types="vite/client" />
//
// SHOWING THE MODEL'S REASONING (0.103.0) — the repros of the second review pass, exactly
// as reported, from what is stored or read to what the reader is shown.
//   3. a steer segment whose only content is a work note stays visible when tool work is
//      hidden (before 0.103.0 the note was text, and visible);
//   4. a work note the gateway cut, whose full version could not be read, says it is cut
//      (as a text segment does), without becoming answer text.
//   1. an ACTIVE bubble of rows that each carry a long reasoning must not make the
//      conversation unreadable (its rows' texts are read whole by the view);
//   2. a reasoning the gateway cut says it is cut, and its full row replaces it (the bridge
//      half is in bridge/test/transcript-capped-rows.test.ts).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fromThreadMessageLike } from "@assistant-ui/react";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";
import { steerSegmentSilent } from "./steerSegmentView";

const NOTE = "Je relance la commande avec un autre chemin.";

function noteBubble(extra: { capped?: boolean; steerSegment?: boolean } = {}): ConvexMessageView {
  return {
    _id: "m1",
    _creationTime: 0,
    chatId: "c1",
    role: "assistant",
    status: "complete",
    text: NOTE,
    updatedAt: 1,
    ...(extra.steerSegment === true ? { steerSegment: true } : {}),
    rowLayout: [
      {
        entryId: "r4:segment:k1",
        start: 0,
        end: NOTE.length,
        commentary: true,
        blocks: true,
        items: [{ kind: "text", start: 0, end: NOTE.length, ...(extra.capped === true ? { capped: true } : {}) }],
      },
    ],
    parts: [],
  } as unknown as ConvexMessageView;
}

/** The content as the thread holds it (assistant-ui's own conversion: `data-x` → data). */
function threadContent(message: ConvexMessageView) {
  const like = convertConvexMessage(message);
  return fromThreadMessageLike(like, "m1", { type: "complete", reason: "unknown" }).content as unknown as ReadonlyArray<{
    type?: string;
    text?: unknown;
    name?: string;
    data?: { capped?: boolean; text?: string };
  }>;
}

describe("codex pass 2 on 0.103.0 — front repros", () => {
  test("3. a steer segment that holds only a work note is not silent: it stays shown when tools are hidden", () => {
    const content = threadContent(noteBubble({ steerSegment: true }));
    expect(content.some((p) => p.type === "data" && p.name === "commentary")).toBe(true);
    expect(steerSegmentSilent(true, content)).toBe(false);
    // …and a reasoning block alone is something shown too.
    expect(steerSegmentSilent(true, [{ type: "data", name: "thinking" }])).toBe(false);
    // A segment of tool work only is still silent (CU-20).
    expect(steerSegmentSilent(true, [{ type: "tool-call" }])).toBe(true);
  });

  test("4. a cut work note says so — as a note, never as answer text", () => {
    const content = threadContent(noteBubble({ capped: true }));
    const note = content.find((p) => p.type === "data" && p.name === "commentary");
    expect(note?.data).toMatchObject({ text: NOTE, capped: true });
    // No answer text was added for it.
    expect(content.filter((p) => p.type === "text")).toEqual([]);
    // Uncut: no mark.
    const whole = threadContent(noteBubble()).find((p) => p.type === "data" && p.name === "commentary");
    expect(whole?.data?.capped).toBeUndefined();
  });
});

// ── Findings 1 and 2: Convex ─────────────────────────────────────────────────────────

const modules = import.meta.glob("../../convex/**/*.ts");
type T = TestConvex<typeof schema>;
type Ids = { userId: Id<"users">; chatId: Id<"chats"> };
vi.setConfig({ testTimeout: 300_000 });

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

const SK = "agent:alice:atrium:chat:u:c1";

async function seed(t: T, showReasoning: boolean): Promise<Ids> {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    await ctx.db.insert("agents", {
      instanceName: "prod",
      agentId: "alice",
      source: "discovered",
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
      enabled: true,
      ...(showReasoning ? { showReasoningDefault: true } : {}),
    });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "alice" });
    return { userId, chatId };
  });
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}

type Row = Record<string, unknown>;
const assistantRow = (runId: string, entryId: string, seq: number, extra: Row = {}): Row => ({
  entryId,
  seq,
  role: "assistant",
  runId,
  hidden: false,
  visible: true,
  ...extra,
});

function apply(t: T, chatId: Id<"chats">, rows: Row[], extra: Row = {}) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${Math.random()}`,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}

async function liveBubble(t: T, ids: Ids, runId: string): Promise<Id<"messages">> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("messages", {
      chatId: ids.chatId,
      userId: ids.userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId,
      turnSessionKey: SK,
      boundInstance: "prod",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("streamingText", {
      messageId: id,
      chatId: ids.chatId,
      userId: ids.userId,
      generation: runId,
      boundInstance: "prod",
      text: "",
      updatedAt: Date.now(),
    });
    return id;
  });
}

const assistants = async (t: T, ids: Ids) =>
  ((await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as ConvexMessageView[]).filter(
    (m) => m.role === "assistant",
  );

describe("codex pass 2 on 0.103.0 — Convex repros", () => {
  test("1. an ACTIVE bubble of 260 rows of 64 KiB reasoning: the conversation and its diagnostic state stay readable", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t, true);
    const RUN = "run-active";
    await liveBubble(t, ids, RUN);
    // Just under the row bound (64 KiB): 260 of them are past Convex's 16 MiB read limit.
    const thought = (n: number) => `R${n} `.padEnd(64 * 1024 - 64, "y");
    for (let page = 0; page < 260 / 20; page++) {
      const rows: Row[] = [];
      for (let k = 0; k < 20; k++) {
        const n = page * 20 + k;
        rows.push(
          assistantRow(RUN, `a${n}`, n + 2, {
            thinking: thought(n),
            blocks: [{ type: "tool", toolCallId: `t${n}`, name: "exec", status: "call" }],
          }),
        );
      }
      const res = (await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: [RUN] })) as { ok: boolean };
      expect(res.ok).toBe(true);
    }
    // While shown…
    const [shown] = await assistants(t, ids);
    expect(shown!.status).toBe("streaming");
    expect(shown!.rowLayout!.filter((r) => r.thinking === true)).toHaveLength(260);
    // …once hidden (the repro: turning it off did not help)…
    await t.withIdentity({ subject: ids.userId }).mutation(api.chats.setSessionKnob, { chatId: ids.chatId, showReasoning: false });
    const [hidden] = await assistants(t, ids);
    expect(hidden!.rowLayout!.some((r) => r.thinking === true)).toBe(false);
    // …and the diagnostic state, which reads the same view.
    const state = (await t.query(internal.messages.chatStateInternal, { chatId: ids.chatId as string })) as { ok: boolean };
    expect(state.ok).toBe(true);
    // One row's reasoning is still read whole when its block opens.
    await t.withIdentity({ subject: ids.userId }).mutation(api.chats.setSessionKnob, { chatId: ids.chatId, showReasoning: true });
    const read = await t
      .withIdentity({ subject: ids.userId })
      .query(api.messages.getRowReasoning, { messageId: shown!._id as Id<"messages">, entryId: "a259" });
    expect(read?.text).toBe(thought(259));
  });

  test("2. a reasoning the gateway cut is read as cut; its full row replaces it; a later preview never does", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, true);
    const RUN = "run-cut";
    const head = "Pensée. ".repeat(1000);
    const whole = head + "Suite et fin.";
    const rows = (thinking: string, truncated: boolean): Row[] => [
      assistantRow(RUN, "a1", 2, {
        thinking,
        ...(truncated ? { thinkingTruncated: true } : {}),
        blocks: [{ type: "tool", toolCallId: "t1", name: "exec", status: "call" }],
      }),
      assistantRow(RUN, "a2", 3, { text: "Voilà.", stopReason: "stop", blocks: [{ type: "text", text: "Voilà." }] }),
    ];
    const settled = { terminals: [{ runId: RUN, status: "completed", at: Date.now() }], hasActiveRun: false };
    const read = async () => {
      const [bubble] = await assistants(t, ids);
      return t.withIdentity({ subject: ids.userId }).query(api.messages.getRowReasoning, { messageId: bubble!._id as Id<"messages">, entryId: "a1" });
    };
    await apply(t, ids.chatId, rows(head, true), settled);
    expect(await read()).toEqual({ text: head, truncated: true });
    await apply(t, ids.chatId, rows(whole, false), settled);
    expect(await read()).toEqual({ text: whole });
    // The same row version read capped again (a bridge that lost its completion): kept whole.
    await apply(t, ids.chatId, rows(head, true), settled);
    expect(await read()).toEqual({ text: whole });
  });
});
