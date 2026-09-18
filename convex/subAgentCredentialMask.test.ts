/// <reference types="vite/client" />
//
// The credential id must not enter a SUB-AGENT row either.
//
// `stream.finalize` is the door a turn goes through, and it masks. The sub-agent
// writers are a SECOND door that does not go through it (codex): a child's failure
// sentence and an interaction's are persisted by their own mutations, and the panel
// renders them. A cooldown sentence arriving by that route carried the profile id —
// an email address in the reported case — to every reader of the chat.

import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const RAW =
  'Auth profile "openai:olivier@lacneu.com" is temporarily unavailable for openai/gpt-5.6-terra.';
// The masker is TOTAL: everything from the opening quote goes, provider and model
// included. A partial redaction of an operator-chosen string is not winnable.
const MASKED = 'Auth profile "…';

async function seedChat(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    return { chatId };
  });
}

describe("the sub-agent doors mask the credential id too", () => {
  test("a child's failure sentence is stored without the profile id", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t);

    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "child-1",
      status: "error",
      errorMessage: RAW,
    });

    const rows = await t.run((ctx) => ctx.db.query("subAgents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.errorMessage).toBe(MASKED);
  });

  test("and on the UPDATE of an existing child, not only its creation", async () => {
    // Two separate writes in the mutation — one builds the row, one patches it — and
    // masking only the first would leave the id in every child that fails after it was
    // already known.
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t);

    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "child-1",
      status: "running",
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "child-1",
      status: "error",
      errorMessage: RAW,
    });

    const rows = await t.run((ctx) => ctx.db.query("subAgents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.errorMessage).toBe(MASKED);
  });

  test("an unrelated failure sentence is stored exactly as it arrived", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t);
    const untouched = "the child timed out after 100 tool calls";

    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "child-2",
      status: "error",
      errorMessage: untouched,
    });

    const rows = await t.run((ctx) => ctx.db.query("subAgents").collect());
    expect(rows[0]?.errorMessage).toBe(untouched);
  });
});

describe("the sub-agent INTERACTION doors mask it too", () => {
  const seedInteraction = (t: ReturnType<typeof convexTest>, chatId: unknown) =>
    t.run((ctx) =>
      ctx.db.insert("subAgentInteractions", {
        chatId: chatId as never,
        childSessionKey: "child-1",
        userText: "une question",
        status: "pending" as const,
        createdAt: 1,
        updatedAt: 1,
      }),
    );

  test("the recorded REPLY path stores no profile id", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t);
    const interactionId = await seedInteraction(t, chatId);

    await t.mutation(internal.subAgentInteractions.recordInteractionReply, {
      interactionId,
      status: "error",
      errorMessage: RAW,
    });

    const row = await t.run((ctx) => ctx.db.get(interactionId));
    expect(row?.errorMessage).toBe(MASKED);
  });

  test("the FAIL path stores no profile id either — two writers, one rule", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t);
    const interactionId = await seedInteraction(t, chatId);

    await t.mutation(internal.subAgentInteractions.failInteraction, {
      interactionId,
      errorMessage: RAW,
    });

    const row = await t.run((ctx) => ctx.db.get(interactionId));
    expect(row?.errorMessage).toBe(MASKED);
  });
});

describe("the doors with no message and no child row", () => {
  test("a settled TASK engagement stores no profile id", async () => {
    // `tasks.get` carries its own `TaskSummary.error` and settles through a writer
    // none of the cases above touch (codex).
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t);
    // The settle looks the row up by `task:<taskId>`, which is how the engagement was
    // registered.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "task:t-1",
      kind: "task",
      status: "running",
    });

    await t.mutation(internal.subAgents.settleTaskEngagement, {
      chatId,
      taskId: "t-1",
      status: "error",
      errorMessage: RAW,
    });

    const rows = await t.run((ctx) => ctx.db.query("subAgents").collect());
    expect(rows[0]?.errorMessage).toBe(MASKED);
  });
});

describe("the doors that cannot be driven from a mutation still call the masker", () => {
  // Three writers reached only through an action that talks to the bridge, or through a
  // generic copy loop. A behavioural test here would have to fake the bridge or build a
  // whole archive to assert one substitution; a source guard says the same thing and
  // says WHICH call it is. Each was a live route to the id (codex).
  const strip = (f: string) =>
    readFileSync(new URL(f, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

  test("the three RELAYS still carry the sentence to a masking door", () => {
    // Every behavioural case above calls a mutation directly, so a relay could stop
    // carrying `errorMessage` and they would all stay green while the detail vanished
    // in production — the shape of the incident this lot fixes (codex).
    const writer = readFileSync(
      new URL("../bridge/src/convex-writer.ts", import.meta.url),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    expect(writer).toMatch(/errorMessage: record\.errorMessage,/);
    expect(writer).toMatch(/errorMessage: reply\.errorMessage,/);
    // …and the task registry's own error, which reaches the settle door and nothing
    // else.
    expect(strip("./subAgents.ts")).toMatch(
      /typeof r\.error === "string" && r\.error !== ""\s*\?\s*\{ errorMessage: r\.error\.slice\(0, 400\) \}/,
    );
  });

  test("a scheduled run's history is masked before it is served", () => {
    // Both surfaces print this verbatim (CronDetailPanel, ScheduledTab), and a
    // scheduled run fails on the same cooldown as any other.
    // …and the mask runs BEFORE the clip: a long operator value could otherwise push
    // the credential trigger past the cut (codex).
    expect(strip("./scheduled.ts")).toMatch(
      /error: detailStr\(\s*typeof r\.error === "string" \? maskCredentialId\(r\.error\) : r\.error,\s*400,\s*\),/,
    );
  });

  test("the REPORT snapshot masks before it clips", () => {
    // The frozen snapshot is built by a mutation, so the behavioural case above covers
    // the masking — but not the ORDER. A long operator value could push the credential
    // trigger past the 10 KB clip, freezing the first one into the report (codex).
    expect(strip("./subAgentReports.ts")).toMatch(
      /errorMessage: clip\(maskCredentialId\(c\.errorMessage\)\),/,
    );
  });

  test("a FORK masks what it copies, message and child alike", () => {
    const src = strip("./chatFork.ts");
    expect(src).toMatch(/error: maskCredentialId\(msg\.error\)/);
    expect(src).toMatch(/errorMessage: maskCredentialId\(rest\.errorMessage\)/);
  });

  test("an IMPORT masks the two fields that carry a gateway sentence", () => {
    // It writes rows from a FILE, so nothing upstream of it has masked them — and the
    // archive may predate the masker, or come from another deployment.
    expect(strip("./archiveImport.ts")).toMatch(
      /\(key === "error" \|\| key === "errorMessage"\) && typeof value === "string"\s*\?\s*maskCredentialId\(value\)/,
    );
  });
});
