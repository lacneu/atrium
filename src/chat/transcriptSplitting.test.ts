/// <reference types="vite/client" />
//
// CODEX REVIEW 3 — finding 1. What a row shows never depends on how its posts were split
// or ordered. The REAL `TranscriptShadow` posts a read's texts first (`textsOnly` chunks),
// then the identities alone (bridge/src/providers/openclaw/transcript-shadow.ts
// `postTexts`). Property: for one transcript, `applyTranscript` gives the same bubbles
// whether the posts are grouped (one apply carrying everything), split as the shadow
// splits them, split row by row, or sent the other way round (identities first).
// Fixture: ui/src/pages/chat/chat-thread-grouping.test.ts:419 at v2026.9.33 — the answer
// followed by the unscoped delivery mirror.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { TranscriptShadow, type TranscriptApply } from "../../bridge/src/providers/openclaw/transcript-shadow";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";

const modules = import.meta.glob("../../convex/**/*.ts");
type T = TestConvex<typeof schema>;
type Reply = Record<string, unknown>;

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
const RUN = "completed-run";

/** chat-thread-grouping.test.ts:419, as `chat.history` returns it (each row with its
 *  `__openclaw` id and seq; the mirror names no run). */
const HISTORY: Reply[] = [
  { role: "user", content: "Inspect the file", timestamp: 1, __openclaw: { id: "u1", seq: 1, runId: RUN } },
  {
    role: "toolResult",
    toolCallId: "read-file",
    toolName: "exec",
    content: "File inspected",
    timestamp: 2,
    __openclaw: { id: "t1", seq: 2, runId: RUN },
  },
  {
    role: "assistant",
    content: "File verified — café 雪 🦞",
    stopReason: "stop",
    timestamp: 3,
    __openclaw: { id: "a1", seq: 3, runId: RUN, mirrorOrigin: "codex-app-server", runTerminal: true },
  },
  {
    role: "assistant",
    content: "Gateway restart config-patch ok",
    api: "openclaw-transcript",
    provider: "openclaw",
    model: "delivery-mirror",
    stopReason: "stop",
    timestamp: 4,
    __openclaw: { id: "m1", seq: 4 },
  },
];

async function seed(t: T) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    return { userId, chatId };
  });
}
const post = (t: T, chatId: Id<"chats">, p: TranscriptApply) =>
  t.mutation(internal.transcriptProjection.applyTranscript, { ...p, chatId, boundInstanceName: "prod" } as never);

/** What the conversation shows: each assistant bubble's run, rows, cache text and the
 *  rendered pieces. */
async function shown(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }) {
  const all = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, {
    chatId: ids.chatId as string,
  })) as unknown as ConvexMessageView[];
  return all
    .filter((m) => m.role === "assistant")
    .map((m) => ({
      runId: m.runId,
      rows: (m.rowLayout ?? []).map((l) => l.entryId),
      text: m.text,
      pieces: (convertConvexMessage(m).content as ReadonlyArray<{ type: string; text?: string }>)
        .filter((p) => p.type === "text")
        .map((p) => p.text),
    }));
}

/** The real shadow, `on`, reading HISTORY once after the run's final — its posts recorded
 *  and forwarded to `applyTranscript`. */
async function throughShadow(): Promise<{ posts: TranscriptApply[]; result: Awaited<ReturnType<typeof shown>> }> {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const posts: TranscriptApply[] = [];
  const shadow = new TranscriptShadow({
    chatId: ids.chatId as string,
    sessionKey: SK,
    // The pane opens on an empty session (the projection's floor), then the run's final
    // reads its rows as a delta.
    readHistory: async (cursor) =>
      cursor === null
        ? { sessionKey: SK, sessionId: "s-1", messages: [], deltaCursor: "c:1", sessionInfo: { sessionId: "s-1", hasActiveRun: false, activeRunIds: [] } }
        : {
            kind: "delta",
            deltaCursor: "c:2",
            messages: cursor === "c:1" ? HISTORY.map((message) => ({ sessionKey: SK, message })) : [],
            sessionInfo: { sessionId: "s-1", hasActiveRun: false, activeRunIds: [] },
          },
    apply: async (p) => {
      posts.push(structuredClone(p));
      return (await post(t, ids.chatId, p)) as never;
    },
    sleep: async () => {},
    now: () => 1000,
    log: () => {},
  });
  shadow.configure({ mode: "on" });
  for (let i = 0; i < 20; i++) {
    await shadow.idle();
    await new Promise((r) => setTimeout(r, 0));
  }
  shadow.observeFrame({ type: "event", event: "chat", payload: { sessionKey: SK, runId: RUN, state: "final", message: {} } });
  for (let i = 0; i < 20; i++) {
    await shadow.idle();
    await new Promise((r) => setTimeout(r, 0));
  }
  return { posts, result: await shown(t, ids) };
}

/** Replay recorded posts, in this order, on a fresh deployment. */
async function replay(posts: readonly TranscriptApply[]) {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  for (const p of posts) await post(t, ids.chatId, p);
  return shown(t, ids);
}

type Row = TranscriptApply["rows"][number];
const contentKeys = ["text", "yieldAck", "errorMessage", "blocks", "blocksTruncated"] as const;
const hasText = (r: Row) => contentKeys.some((k) => (r as unknown as Record<string, unknown>)[k] !== undefined);

/** The shadow's posts regrouped: each read carries its rows WITH their texts, no
 *  `textsOnly` post at all. */
function grouped(posts: readonly TranscriptApply[]): TranscriptApply[] {
  const out: TranscriptApply[] = [];
  let texts = new Map<string, Row>();
  for (const p of posts) {
    if (p.textsOnly === true) {
      for (const r of p.rows) if (hasText(r)) texts.set(r.entryId, r);
      continue;
    }
    out.push({ ...p, rows: p.rows.map((r) => texts.get(r.entryId) ?? r) });
    texts = new Map();
  }
  return out;
}
/** Every `textsOnly` post split into one post per row (order kept). */
const rowByRow = (posts: readonly TranscriptApply[]): TranscriptApply[] =>
  posts.flatMap((p) => (p.textsOnly === true ? p.rows.map((r) => ({ ...p, rows: [r] })) : [p]));
/** Every `textsOnly` post split into one post per row, the LAST row first: a row's text
 *  arrives before the row that owns it. */
const rowByRowLastFirst = (posts: readonly TranscriptApply[]): TranscriptApply[] =>
  posts.flatMap((p) => (p.textsOnly === true ? [...p.rows].reverse().map((r) => ({ ...p, rows: [r] })) : [p]));
/** Each read posted BEFORE the texts that went ahead of it. */
function reversed(posts: readonly TranscriptApply[]): TranscriptApply[] {
  const out: TranscriptApply[] = [];
  let pending: TranscriptApply[] = [];
  for (const p of posts) {
    if (p.textsOnly === true) {
      pending.push(p);
      continue;
    }
    out.push(p, ...pending);
    pending = [];
  }
  return [...out, ...pending];
}

describe("codex review 3, finding 1 — a row's content never depends on how its posts were split", () => {
  test("the real shadow: the answer AND the unscoped mirror, in the answer's bubble", async () => {
    const { posts, result } = await throughShadow();
    // The shadow did split them: texts first, identities after.
    expect(posts.some((p) => p.textsOnly === true)).toBe(true);
    expect(result).toEqual([
      {
        runId: RUN,
        rows: ["t1", "a1", "m1"],
        text: "File verified — café 雪 🦞\n\nGateway restart config-patch ok",
        pieces: ["File verified — café 雪 🦞", "Gateway restart config-patch ok"],
      },
    ]);
  });

  test("property: grouped, split by the shadow, split row by row, reversed — one result", async () => {
    const { posts, result } = await throughShadow();
    const variants: Record<string, TranscriptApply[]> = {
      grouped: grouped(posts),
      "as the shadow": posts,
      "row by row": rowByRow(posts),
      reversed: reversed(posts),
      "row by row, reversed": reversed(rowByRow(posts)),
      "row by row, last row first": rowByRowLastFirst(posts),
      "row by row, last row first, reversed": reversed(rowByRowLastFirst(posts)),
    };
    for (const [name, v] of Object.entries(variants)) {
      expect({ name, shown: await replay(v) }).toEqual({ name, shown: result });
    }
  });
});
