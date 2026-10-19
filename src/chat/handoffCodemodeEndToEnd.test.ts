/// <reference types="vite/client" />
//
// PROD REPORT prod-ms7dc0ne72c203df18yfc24sr58gg78e, END TO END (0.101.1).
//
// Olivier's resume test — delegate, yield, send the file with the `message` tool, write a
// synthesis — in projection `on`, on the shape the live bench gave on 2026.9.33 (r6):
// `fixtures/handoff-codemode-2026.9.33.json`, the session's real `chat.history` rows. Code
// mode: every tool call is an `exec`, and the tools its code calls are nested-activity rows
// carrying `parentToolCallId`. The path a real row takes: bridge `toTranscriptRow` →
// `applyTranscript` → `listByChat` → `convertConvexMessage` → `activityBlock` /
// `assistantEmptyState`, as the chat renders them. The report said:
//   1. a wall of cards, one per tool  → ONE activity block per run of tool rows;
//   2. a waiting note that ended on a 3-minute delay, then the child's raw reply ("fichier
//      prêt") pasted in the parent bubble → the note ends on the resume, a fact of the
//      transcript, and the child's reply is never shown;
//   3. nested calls beside their `exec` → under it;
//   4. no card twice.

import { convexTest, type TestConvex } from "convex-test";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { toTranscriptRow } from "../../bridge/src/providers/openclaw/transcript-rows";
import { activityBlock } from "./activityBlock";
import { assistantEmptyState } from "./assistantEmptyState";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";
import { resumeIndexOf, type HandOffFacts } from "./handOffFacts";
import type { SubAgentRow } from "./subAgentActivityView";
import type { ToolActivityPart } from "./toolActivityView";

const modules = import.meta.glob("../../convex/**/*.ts");
type T = TestConvex<typeof schema>;

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/handoff-codemode-2026.9.33.json", import.meta.url), "utf8")) as {
  sessionKey: string;
  messages: Array<Record<string, unknown> & { __openclaw: { runId?: string } }>;
};
const SK = FIXTURE.sessionKey;
const PARENT_RUN = FIXTURE.messages[0]!.__openclaw.runId!;
const SETTLE_RUN = FIXTURE.messages.find((m) => (m.__openclaw.runId ?? "").startsWith("announce:requester-settle:"))!.__openclaw.runId!;
const CHILD_RUN = "248d41ff-bb53-458f-9e2c-28d676bc5fdc";
const CHILD_KEY = "agent:files:subagent:7098a805-98c1-48c1-aad5-3837c53bac0d";

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

let clock = 1_000;
function apply(t: T, chatId: Id<"chats">, runId: string, status: "yielded" | "completed") {
  clock += 10;
  const rows = FIXTURE.messages
    .filter((m) => m.__openclaw.runId === runId)
    .map((m) => toTranscriptRow(m, undefined, { sessionKey: SK }))
    .filter((r) => r !== null);
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${clock}`,
    readAt: clock,
    rows: rows as never,
    terminals: [{ runId, status, at: clock }],
    hasActiveRun: false,
    unidentified: 0,
  } as never);
}

async function seed(t: T) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    // NO projection set: an OpenClaw instance runs `on` by default since 0.101.1.
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: {} as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "alice" });
    return { userId, chatId };
  });
  clock += 10;
  await t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId: ids.chatId, boundInstanceName: "prod", sessionKey: SK, sessionId: "s-1", kind: "page",
    deltaCursor: `c:${clock}`, readAt: clock, rows: [], terminals: [], unidentified: 0,
  } as never);
  return ids;
}

async function list(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }): Promise<ConvexMessageView[]> {
  return (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as ConvexMessageView[];
}

type Converted = { content: ReadonlyArray<Record<string, unknown>>; metadata?: { custom?: Record<string, unknown> } };
function render(all: ConvexMessageView[], msg: ConvexMessageView): Converted {
  return convertConvexMessage(msg, null, null, null, resumeIndexOf(all)) as unknown as Converted;
}
const blocks = (c: Converted) =>
  c.content.filter((p) => p.type === "tool-call" && p.toolName === "__turn_flow__").map((p) => (p.args as { parts: ToolActivityPart[]; rows?: boolean }));
const noteOf = (c: Converted, subAgents: SubAgentRow[], messageId: string) => {
  const custom = c.metadata?.custom ?? {};
  const handOff = custom.handOff as HandOffFacts | undefined;
  return assistantEmptyState(
    {
      status: "complete",
      hasText: c.content.some((p) => p.type === "text" && String(p.text ?? "").trim() !== ""),
      hasMedia: false,
      ...(handOff !== undefined ? { ...handOff } : {}),
    },
    (custom.allToolParts as ToolActivityPart[]) ?? [],
    subAgents,
    messageId,
    Date.now(),
  );
};

describe("prod-ms7dc0ne: a code-mode delegation and its resume, in projection `on` by default", () => {
  test("one block per run of tool rows, nested calls under their exec, the note ends on the resume", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    // THE HAND-OFF: the parent's run delegates (an exec whose code calls sessions_spawn),
    // then yields.
    await apply(t, ids.chatId, PARENT_RUN, "yielded");
    let all = await list(t, ids);
    const handOff = all.find((m) => m.role === "assistant" && m.runId === PARENT_RUN)!;
    expect(handOff.rowLayout).toBeDefined();
    const child: SubAgentRow = {
      _id: "sa1",
      parentMessageId: handOff._id,
      childSessionKey: CHILD_KEY,
      childRunId: CHILD_RUN,
      kind: "subagent",
      taskName: "test-reprise",
      status: "done",
      resultText: "fichier prêt",
      createdAt: 1,
      updatedAt: 2,
    };
    const first = render(all, handOff);
    // 1. ONE block for the bubble's tool rows (exec, exec, yield — one row each).
    const [block, ...more] = blocks(first);
    expect(more).toEqual([]);
    expect(block!.rows).toBe(true);
    expect(block!.parts.map((p) => p.toolName)).toEqual(["exec", "exec", "sessions_spawn", "sessions_yield"]);
    // 3. sessions_spawn ran inside the second exec: it sits under it, and that exec — a
    //    completed wrapper — is not counted.
    const view = activityBlock(block!.parts, true);
    expect(view.roots.map((n) => [n.part.toolName, n.children.map((c) => c.part.toolName)])).toEqual([
      ["exec", []],
      ["exec", ["sessions_spawn"]],
      ["sessions_yield", []],
    ]);
    expect(view.visible.map((p) => p.toolName)).toEqual(["exec", "sessions_spawn", "sessions_yield"]);
    expect(view.summary).toBe("1 commande · 2 autres opérations");
    // 2. The child is done and no resume names it yet: one quiet note, with no deadline.
    expect(noteOf(first, [child], handOff._id)).toEqual({ kind: "composing", taskName: "test-reprise" });

    // THE RESUME: the requester-settle run, which names the child's run.
    await apply(t, ids.chatId, SETTLE_RUN, "completed");
    all = await list(t, ids);
    const handOffAfter = all.find((m) => m._id === handOff._id)!;
    // 2. …the note ends on that fact, and the child's raw reply is never shown.
    expect(noteOf(render(all, handOffAfter), [child], handOff._id)).toEqual({ kind: "none" });
    for (const m of all.filter((x) => x.role === "assistant")) {
      const c = render(all, m);
      expect(c.content.some((p) => String(p.text ?? "").includes("fichier prêt"))).toBe(false);
    }

    const resume = all.find((m) => m.role === "assistant" && m.runId === SETTLE_RUN)!;
    const settled = render(all, resume);
    // 1. The resume's tool rows form one block per run of rows, broken only by what it
    //    shows (the delivered message and its file).
    const resumeBlocks = blocks(settled);
    expect(resumeBlocks.map((b) => b.parts.map((p) => p.toolName))).toEqual([
      ["exec", "exec", "message"],
      ["exec", "message"],
    ]);
    // 3. Each `message` sent from an exec's code is under that exec.
    for (const b of resumeBlocks) {
      const tree = activityBlock(b.parts, true).roots;
      const withChild = tree.filter((n) => n.children.length > 0);
      expect(withChild.map((n) => [n.part.toolName, n.children.map((c) => c.part.toolName)])).toEqual([["exec", ["message"]]]);
    }
    // 4. No card twice, across the whole group.
    const ids2 = [...blocks(first), ...resumeBlocks].flatMap((b) => b.parts.map((p) => p.toolCallId));
    expect(new Set(ids2).size).toBe(ids2.length);
  });

  test("the conversation going on ends the note too, even with no resume", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, PARENT_RUN, "yielded");
    const handOff = (await list(t, ids)).find((m) => m.role === "assistant")!;
    const child: SubAgentRow = { _id: "sa1", parentMessageId: handOff._id, childSessionKey: CHILD_KEY, childRunId: CHILD_RUN, status: "done", createdAt: 1, updatedAt: 2 };
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", { chatId: ids.chatId, userId: ids.userId, role: "user" as const, status: "complete" as const, text: "Et alors ?", updatedAt: 99 });
    });
    const all = await list(t, ids);
    expect(noteOf(render(all, all.find((m) => m._id === handOff._id)!), [child], handOff._id)).toEqual({ kind: "none" });
  });
});
