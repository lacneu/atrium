// A SILENT CONTINUATION IN THE MIDDLE OF A DELEGATION IS NOT A FAILED DELIVERY.
//
// Production, 2026-09-29 (instance ataraxis, agent denis, chat mh70qh2y…): two
// requester-settle continuations ran only bookkeeping tools — ph77vqr3v3 one `exec`,
// ph7ajwt1ej read/edit/exec — said nothing, and were closed by the bridge's
// lifecycle-end grace (`finalizeCause: lifecycle_end_timeout`). Convex's "the
// delivery brought nothing" rule painted both red (`empty_response`), though the
// chain went on for hours and upstream asks a yielded turn's continuation for its
// visible answer only "after the requested outcome is complete or genuinely blocked"
// (subagent-announce.requester-settle-message.ts:44-45 at v2026.9.6).
//
// Since 0.102.0 a delivery always opens its OWN bubble (a delivery exists only on
// OpenClaw, always projected), and the "delivered nothing" verdict is never taken on an
// own bubble: one with nothing to show is dropped (`dropIfEmpty`), one with tool cards
// keeps them. The cases below pin that a silent continuation stays a plain, unnamed
// bubble whatever the chain around it does. The verdict itself now applies only to the
// replay of a bubble 0.96.0 merged (handOffExemptionScope.test.ts, announceMerge.test.ts).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
// Under the full suite the first test of a file pays the cold module load.

const REQUESTER = "agent:denis:atrium:chat:denis.crozet:mh70qh2y70e9yg1r4vneamh0qx8f9x2t";
const settleRun = (ids: string[], suffix = ":yield-1") =>
  `announce:requester-settle:denis:${REQUESTER}:${[...ids].sort().join(",")}${suffix}`;
const RUN = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const KEY = (n: number) => `agent:denis:subagent:child-${n}`;

type T = ReturnType<typeof convexTest>;

/** The user turn: bubble A, spawn + yield, no text; its child 1 settled, exactly anchored. */
async function seed(t: T) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "denis" });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "ataraxis",
      agentId: "denis",
    });
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "Traite le dossier",
      updatedAt: 1000,
    });
    const bubble = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "",
      runId: "webchat-1635935a",
      finalizedAt: 2000,
      updatedAt: 2000,
    });
    await ctx.db.insert("subAgents", {
      chatId,
      parentMessageId: bubble,
      anchorExact: true,
      childSessionKey: KEY(1),
      childRunId: RUN(1),
      status: "done" as const,
      createdAt: 1800,
      updatedAt: 2500,
    });
    return { userId, chatId, bubble };
  });
}

async function childRow(
  t: T,
  chatId: Id<"chats">,
  n: number,
  status: "running" | "done",
  anchor?: Id<"messages">,
  extra?: { bornOfRun?: string; positional?: boolean },
) {
  await t.run((ctx) =>
    ctx.db.insert("subAgents", {
      chatId,
      ...(anchor !== undefined
        ? { parentMessageId: anchor, ...(extra?.positional === true ? {} : { anchorExact: true }) }
        : {}),
      ...(extra?.bornOfRun !== undefined ? { bornOfRun: extra.bornOfRun } : {}),
      childSessionKey: KEY(n),
      childRunId: RUN(n),
      status,
      createdAt: 2600,
      updatedAt: 2700,
    }),
  );
}

type ToolPart = { name: string; output?: unknown };

/** One continuation that ran `tools` (item-derived cards, stamped with its run),
 *  said nothing, and was closed by the lifecycle-end grace. */
async function silentContinuation(
  t: T,
  chatId: Id<"chats">,
  runId: string,
  tools: ToolPart[],
) {
  const messageId = await t.mutation(internal.stream.startAssistant, { chatId, runId });
  expect(messageId).not.toBeNull();
  for (const tool of tools) {
    await t.mutation(internal.stream.addPart, {
      messageId: messageId!,
      expectedRunId: runId,
      part: {
        kind: "tool" as const,
        name: tool.name,
        phase: "completed",
        ...(tool.output !== undefined ? { output: tool.output } : {}),
      },
    });
  }
  await t.mutation(internal.stream.finalize, {
    messageId: messageId!,
    status: "complete",
    text: "",
    expectedRunId: runId,
    finalizeCause: "lifecycle_end_timeout",
  });
  return (await t.run((ctx) => ctx.db.get(messageId!))) as Doc<"messages">;
}

const BOOKKEEPING: ToolPart[] = [{ name: "read" }, { name: "edit" }, { name: "exec" }];

describe("the chain still under way: no failure", { timeout: 30_000 }, () => {
  test("the continuation delegated again (an accepted spawn IT wrote), nothing running yet", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const m = await silentContinuation(t, chatId, settleRun([RUN(1)]), [
      { name: "exec" },
      // A continuation spawns through item frames: no result at all.
      { name: "sessions_spawn" },
    ]);
    expect(m.status).toBe("complete");
    expect(m.errorCode).toBeUndefined();
  });
});

describe("the chain ends with nothing: still no verdict on an own bubble", { timeout: 30_000 }, () => {
  // Codex pass 3 (P3): the bubble's runs are never listed under a cap; each running
  // child's birth run is looked up where it wrote.
  test("…unless more children run than the probe reads: inconclusive never names a failure", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    for (let n = 100; n < 165; n++) await childRow(t, chatId, n, "running");
    const m = await silentContinuation(t, chatId, settleRun([RUN(1)]), BOOKKEEPING);
    expect(m.status).toBe("complete");
  });

});

/** Was the verdict on `messageId`'s run taken back (the paired trace)? */
async function repaired(t: T, runId: string | undefined) {
  const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
  return traces.some(
    (e) =>
      e.kind === "assistant.stream" &&
      e.runId === runId &&
      JSON.parse(e.meta ?? "{}").phase === "finalize_repaired",
  );
}

async function statusOf(t: T, id: Id<"messages">) {
  return ((await t.run((ctx) => ctx.db.get(id))) as Doc<"messages"> | null)?.status;
}

describe("a wave NOT linked to the silent bubble", { timeout: 30_000 }, () => {
  test("never a GATEWAY's own failure, even exactly linked: only the verdict this platform stamps", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId } = await seed(t);
    const failed = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "error" as const,
        text: "",
        runId: settleRun([RUN(5)]),
        errorCode: "empty_response",
        error: "The agent returned an empty response.",
        updatedAt: 3000,
      }),
    );
    await childRow(t, chatId, 7, "done", failed);
    await t.mutation(internal.stream.startAssistant, { chatId, runId: settleRun([RUN(7)]) });
    expect(await statusOf(t, failed)).toBe("error");
  });

  // Codex pass 2 (P1): a late REPLAY of an older wave is refused by the ownership
  // gates — and must not erase, on its way out, the verdict a NEWER wave earned.
});
