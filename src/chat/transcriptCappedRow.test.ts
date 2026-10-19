/// <reference types="vite/client" />
//
// A ROW THE GATEWAY CAPPED FOR DISPLAY, END TO END (0.101.3): the bridge sends either the
// full row (`chat.message.get`) or the preview with its text block marked `capped`; through
// the real mutation (`applyTranscript`) to the rendering (`listByChat` → `convertConvexMessage`)
// the bubble shows the full text, or the preview followed by an honest note — never the
// gateway's in-band `...(truncated)...` sentinel. A later full version replaces a stored
// preview (the repair of a conversation stored capped before 0.101.3).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";
import { m } from "@/paraglide/messages.js";

const modules = import.meta.glob("../../convex/**/*.ts");
type T = TestConvex<typeof schema>;
type Row = Record<string, unknown>;

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
const R = "run-long";
let clock = 1_000;

async function seed(t: T) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    return { userId, chatId };
  });
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}
async function apply(t: T, chatId: Id<"chats">, rows: Row[], extra: Row = {}) {
  clock += 10;
  await t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${clock}`,
    readAt: clock,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}
async function bubble(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }): Promise<ConvexMessageView | undefined> {
  const all = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as ConvexMessageView[];
  return all.find((x) => x.role === "assistant");
}
const texts = (v: ConvexMessageView | undefined) =>
  ((v === undefined ? [] : convertConvexMessage(v).content) as ReadonlyArray<{ type: string; text?: string }>)
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "");

const FULL = Array.from({ length: 1200 }, (_, i) => `Ligne ${i} du texte long.`).join("\n");
const PREVIEW = FULL.slice(0, 8_000);
const row = (text: string, capped: boolean): Row => ({
  entryId: "e42",
  seq: 3,
  role: "assistant",
  runId: R,
  hidden: false,
  visible: true,
  text,
  blocks: [{ type: "text", text, ...(capped ? { capped: true } : {}) }],
});
const over = { terminals: [{ runId: R, status: "completed", at: 5_000 }], hasActiveRun: false };

describe("a capped row in a bubble", () => {
  test("the preview, then the honest note — never the sentinel; the full version replaces it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, [row(PREVIEW, true)], over);
    const capped = texts(await bubble(t, ids));
    expect(capped).toEqual([PREVIEW, `_${m.chat_text_capped()}_`]);
    expect(capped.join("")).not.toContain("...(truncated)...");
    // The repair: the full row of the same identity, posted later.
    await apply(t, ids.chatId, [row(FULL, false)], over);
    expect(texts(await bubble(t, ids))).toEqual([FULL]);
  });

  test("the bridge's repair path: a texts-only post of the full row updates a settled bubble", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, [row(PREVIEW, true)], over);
    expect(texts(await bubble(t, ids))).toEqual([PREVIEW, `_${m.chat_text_capped()}_`]);
    // transcript-shadow.ts `scanCappedTail` → `postTexts`: kind "live", textsOnly.
    clock += 10;
    await t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId: ids.chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "live",
      textsOnly: true,
      readAt: clock,
      rows: [row(FULL, false)] as never,
      terminals: [],
      unidentified: 0,
    } as never);
    expect(texts(await bubble(t, ids))).toEqual([FULL]);
  });

  // 0.101.3 REVIEW: a bridge that lost its completions (its session expired) and could not
  // ask again posts the preview, marked `capped` — on a read, a page read after a transient
  // failure, or a texts-only post. The whole text stored for the same row version stays.
  test("a preview never replaces a whole text of the same row version — by a read, a page, or a texts-only post", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, [row(FULL, false)], over);
    expect(texts(await bubble(t, ids))).toEqual([FULL]);
    await apply(t, ids.chatId, [row(PREVIEW, true)], over);
    expect(texts(await bubble(t, ids))).toEqual([FULL]);
    await apply(t, ids.chatId, [row(PREVIEW, true)], { ...over, kind: "page" });
    expect(texts(await bubble(t, ids))).toEqual([FULL]);
    clock += 10;
    await t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId: ids.chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "live",
      textsOnly: true,
      readAt: clock,
      rows: [row(PREVIEW, true)] as never,
      terminals: [],
      unidentified: 0,
    } as never);
    expect(texts(await bubble(t, ids))).toEqual([FULL]);
  });

  test("a new version of the row (another seq) is taken, preview or not", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, [row(FULL, false)], over);
    await apply(t, ids.chatId, [{ ...row(PREVIEW, true), seq: 4 }], over);
    expect(texts(await bubble(t, ids))).toEqual([PREVIEW, `_${m.chat_text_capped()}_`]);
  });
});

