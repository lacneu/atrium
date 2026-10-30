/// <reference types="vite/client" />
//
// SHOWING THE MODEL'S REASONING (0.103.0) — the three repros of the first review pass,
// exactly as reported, end to end (projection → view → what the reader's block shows).
// Each one reads what the READER gets, whatever carries it: a block's own text, or the row
// it names (`getRowReasoning`), so the same test states the defect and its absence.
//   1. a window of reasoning rows (100 turns × 30 reasonings × 6 000 chars) must not make
//      the conversation unreadable — neither while it shows reasoning, nor once it stops,
//      nor for the diagnostic state (Convex's 16 MiB read limit, enforced here);
//   2. a reasoning past the view's 8 KiB field cap (9 000 chars), seen while the run goes
//      on, must still be there — whole — once the run has settled;
//   3. a corrected reasoning (same answer, same structure) is the one the reader gets.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";

const modules = import.meta.glob("../../convex/**/*.ts");
type T = TestConvex<typeof schema>;
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
type Ids = { userId: Id<"users">; chatId: Id<"chats"> };

async function seed(t: T): Promise<Ids> {
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
      showReasoningDefault: true,
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

const settled = (runId: string): Row => ({ terminals: [{ runId, status: "completed", at: Date.now() }], hasActiveRun: false });

async function assistants(t: T, ids: Ids): Promise<ConvexMessageView[]> {
  const all = (await t
    .withIdentity({ subject: ids.userId })
    .query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as ConvexMessageView[];
  return all.filter((m) => m.role === "assistant");
}

/** What the reader's reasoning blocks of a bubble show, opened: the block's own text, or
 *  the text of the row it names. */
async function readerReasoning(t: T, ids: Ids, message: ConvexMessageView): Promise<string[]> {
  const content = convertConvexMessage(message).content as unknown as Array<{
    type: string;
    data?: { text?: string; row?: { messageId: string; entryId: string } };
  }>;
  const out: string[] = [];
  for (const c of content) {
    if (c.type !== "data-thinking") continue;
    const row = c.data?.row;
    if (row === undefined) {
      out.push(c.data?.text ?? "");
      continue;
    }
    const read = await t
      .withIdentity({ subject: ids.userId })
      .query(api.messages.getRowReasoning, { messageId: row.messageId as Id<"messages">, entryId: row.entryId });
    out.push(read?.text ?? "");
  }
  return out;
}

describe("codex pass 1 on 0.103.0 — the exact repros", () => {
  test("1. 100 turns × 30 reasonings × 6 000 chars: the conversation and its diagnostic state stay readable", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const ids = await seed(t);
    const thought = (turn: number, n: number) => `T${turn}.${n} `.padEnd(6000, "x");
    for (let turn = 0; turn < 100; turn++) {
      const runId = `run-${turn}`;
      const base = turn * 100;
      const rows: Row[] = [];
      // A bridge page holds at most 40 rows with text (transcriptProjection.ts): one turn's
      // 30 reasoning rows and its answer fit in one.
      for (let n = 0; n < 30; n++) {
        rows.push(
          assistantRow(runId, `r${turn}-${n}`, base + n + 1, {
            thinking: thought(turn, n),
            blocks: [{ type: "tool", toolCallId: `t${turn}-${n}`, name: "exec", status: "call" }],
          }),
        );
      }
      rows.push(
        assistantRow(runId, `r${turn}-end`, base + 99, {
          text: `Réponse ${turn}.`,
          stopReason: "stop",
          blocks: [{ type: "text", text: `Réponse ${turn}.` }],
        }),
      );
      const res = (await apply(t, ids.chatId, rows, settled(runId))) as { ok: boolean };
      expect(res.ok).toBe(true);
    }
    // What was stored is what the repro needs: 3 000 kept reasonings, 17 MiB of them.
    // (Counted a page at a time: reading them all at once is itself past the limit.)
    let kept = 0;
    let keptBytes = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: { n: number; bytes: number; next: string | null } = await t.run(async (ctx) => {
        const p = await ctx.db.query("transcriptRowReasoning").paginate({ cursor, numItems: 500 });
        const withThinking = p.page;
        return {
          n: withThinking.length,
          bytes: withThinking.reduce((sum, d) => sum + d.text.length, 0),
          next: p.isDone ? null : p.continueCursor,
        };
      });
      kept += page.n;
      keptBytes += page.bytes;
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(kept).toBe(3000);
    expect(keptBytes).toBeGreaterThan(16 * 1024 * 1024);

    // Once the conversation stops showing reasoning (the repro: turning it off did not help)…
    const knob = (showReasoning: boolean) =>
      t.withIdentity({ subject: ids.userId }).mutation(api.chats.setSessionKnob, { chatId: ids.chatId, showReasoning });
    await knob(false);
    const hidden = await assistants(t, ids);
    expect(hidden).toHaveLength(100);
    expect(await readerReasoning(t, ids, hidden[99]!)).toEqual([]);
    // …the diagnostic state, which reads the same view…
    const state = (await t.query(internal.messages.chatStateInternal, { chatId: ids.chatId as string })) as { ok: boolean };
    expect(state.ok).toBe(true);
    // …and while it shows reasoning again, every one of them still reachable.
    await knob(true);
    const shown = await assistants(t, ids);
    expect(shown).toHaveLength(100);
    expect(await readerReasoning(t, ids, shown[0]!)).toHaveLength(30);
    expect((await readerReasoning(t, ids, shown[99]!))[29]).toBe(thought(99, 29));
  });

  test("2. a 9 000-char reasoning seen while the run goes on is still there, whole, once it settled", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const RUN = "run-long";
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId: ids.chatId,
        userId: ids.userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: RUN,
        turnSessionKey: SK,
        boundInstance: "prod",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("streamingText", {
        messageId: id,
        chatId: ids.chatId,
        userId: ids.userId,
        generation: RUN,
        boundInstance: "prod",
        text: "",
        updatedAt: Date.now(),
      });
    });
    const long = "Je pèse les options. ".repeat(450).slice(0, 9000);
    expect(long.length).toBe(9000);
    const rows: Row[] = [
      assistantRow(RUN, "a1", 2, { thinking: long, blocks: [{ type: "tool", toolCallId: "t1", name: "exec", status: "call" }] }),
      assistantRow(RUN, "a2", 3, { role: "toolresult", blocks: [{ type: "tool", toolCallId: "t1", name: "exec", status: "result" }] }),
    ];
    await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: [RUN] });
    const [during] = await assistants(t, ids);
    expect(during!.status).toBe("streaming");
    expect(await readerReasoning(t, ids, during!)).toEqual([long]);

    const answer = assistantRow(RUN, "a3", 4, { text: "Voilà.", stopReason: "stop", blocks: [{ type: "text", text: "Voilà." }] });
    await apply(t, ids.chatId, [...rows, answer], settled(RUN));
    const [after] = await assistants(t, ids);
    expect(after!.status).toBe("complete");
    expect(await readerReasoning(t, ids, after!)).toEqual([long]);
  });

  test("3. two reads, same answer and structure, the reasoning corrected: the reader gets the correction", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const RUN = "run-fix";
    const rowsWith = (thinking: string): Row[] => [
      assistantRow(RUN, "a1", 2, { thinking, blocks: [{ type: "tool", toolCallId: "t1", name: "exec", status: "call" }] }),
      assistantRow(RUN, "a2", 3, { role: "toolresult", blocks: [{ type: "tool", toolCallId: "t1", name: "exec", status: "result" }] }),
      assistantRow(RUN, "a3", 4, { text: "Voilà.", stopReason: "stop", blocks: [{ type: "text", text: "Voilà." }] }),
    ];
    await apply(t, ids.chatId, rowsWith("FIRST THOUGHT"), settled(RUN));
    const [first] = await assistants(t, ids);
    expect(await readerReasoning(t, ids, first!)).toEqual(["FIRST THOUGHT"]);
    await apply(t, ids.chatId, rowsWith("CORRECTED THOUGHT"), settled(RUN));
    const source = await t.run(async (ctx) => (await ctx.db.query("transcriptRowReasoning").collect()).map((d) => d.text));
    expect(source).toEqual(["CORRECTED THOUGHT"]);
    const [second] = await assistants(t, ids);
    expect(await readerReasoning(t, ids, second!)).toEqual(["CORRECTED THOUGHT"]);
  });
});
