/// <reference types="vite/client" />
//
// AN OFF/SHADOW CONVERSATION READS EXACTLY AS BEFORE THIS LOT (codex review 14).
//
// The masking added for cards REBUILT from transcript rows (codex reviews 12-14) must not
// touch a conversation the projection never drove, nor any live part: upstream already
// masks live payloads (src/agents/embedded-agent-subscribe.handlers.tools.start.ts:541).
// `projectionInvariance.test.ts` pins what such a conversation COSTS; this pins what it
// SHOWS — the chat view (`listByChat` → `convertConvexMessage`), the sub-agent panel and the
// archive export — against the output of the 0.100.1 tree itself (HEAD), recorded in
// `fixtures/off-shadow-output-head.json`. The payloads include strings the masking would
// change (a fake OpenRouter key, an already-masked one, a private yield note).
//
// The fixture is produced by this very file run against an export of HEAD
// (`git archive HEAD`) with OFF_SHADOW_BASELINE_OUT set; the comparison is exact.

import { convexTest, type TestConvex } from "convex-test";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";

const modules = import.meta.glob("../../convex/**/*.ts");
type T = TestConvex<typeof schema>;
const FIXTURE = new URL("./fixtures/off-shadow-output-head.json", import.meta.url);
const OUT = process.env.OFF_SHADOW_BASELINE_OUT;

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

const SK = "agent:main:atrium:chat:u:c1";
const FAKE_KEY = "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789 ./run.sh";
const PARTS = [
  { kind: "tool", name: "exec", phase: "completed", toolCallId: "t1", input: { command: FAKE_KEY }, output: { content: [{ type: "text", text: FAKE_KEY }], details: { status: "completed" } } },
  { kind: "tool", name: "exec", phase: "completed", toolCallId: "t2", input: { command: "OPENROUTER_API_KEY=sk-or-…6789 ./run.sh" }, output: "Authorization: Bearer abcdef0123456789QWERTY=" },
  { kind: "tool", name: "sessions_yield", phase: "completed", toolCallId: "t3", input: { message: "private hand-off note", acknowledgment: "Je reviens vers toi." }, output: { details: { status: "yielded" } } },
  { kind: "tool", name: "web_search", phase: "started", toolCallId: "t4", input: { q: "token=abcdefghijklmnop1234" } },
];

/** Drops what differs between two runs and says nothing about the display. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^(_id|_creationTime|chatId|userId|messageId|id|updatedAt|createdAt|ageSeconds|at|sentAt|storageId|url|exportedAt)$/.test(k)) continue;
    out[k] = normalize(v);
  }
  return out;
}

async function world(t: T, mode: "off" | "shadow") {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: mode } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "q", updatedAt: 1 });
    const reply = await ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "r", runId: "run1", turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 });
    for (const [order, part] of PARTS.entries()) {
      await ctx.db.insert("messageParts", { messageId: reply, order, part } as never);
    }
    await ctx.db.insert("subAgentToolParts", { chatId, childSessionKey: "child-1", toolCallId: "s1", name: "exec", status: "done", argsText: JSON.stringify({ command: FAKE_KEY }), resultText: FAKE_KEY, updatedAt: 1 } as never);
    return { userId, chatId };
  });
}

async function output(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }) {
  const as = t.withIdentity({ subject: ids.userId });
  const view = (await as.query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as ConvexMessageView[];
  const converted = view.map((m) => convertConvexMessage(m));
  const panel = await as.query(api.subAgents.listSubAgentToolParts, { chatId: ids.chatId, childSessionKey: "child-1" });
  const exported = [];
  for (const section of ["messageParts", "subAgentToolParts"] as const) {
    exported.push(await as.query(api.archiveExport.exportChatSection, { chatId: ids.chatId, section, cursor: null } as never));
  }
  return normalize({ view, converted, panel, exported });
}

describe("an off/shadow conversation shows exactly what HEAD showed", () => {
  const baseline: Record<string, unknown> = OUT === undefined ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>) : {};
  const recorded: Record<string, unknown> = {};

  for (const mode of ["off", "shadow"] as const) {
    test(`${mode}: chat view, sub-agent panel and export, payloads visible as stored`, async () => {
      const t = convexTest(schema, modules);
      const got = await output(t, await world(t, mode));
      if (OUT !== undefined) {
        recorded[mode] = got;
        writeFileSync(OUT, `${JSON.stringify(recorded, null, 2)}\n`);
        return;
      }
      expect(got).toEqual(baseline[mode]);
      // And the payloads are there: nothing withheld, nothing masked anew.
      expect(JSON.stringify(got)).toContain("sk-or-v1-abcdef0123456789");
    });
  }
});
