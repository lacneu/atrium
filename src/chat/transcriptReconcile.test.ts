/// <reference types="vite/client" />
//
// CODEX REVIEW 6 — the meeting of the live parts and what the rows say, as ONE rule
// (convex/lib/viewReconcile.ts): a row's word is final for what it says from the moment it
// is received; the live stream keeps only what no row says yet. End to end, through the real
// mutations (`startAssistant`, `addPart`, `applyTranscript`, `finalizeCopy`) to the rendering
// (`listByChat` → `convertConvexMessage`): the three forms Codex reproduced, then a GENERATED
// property — whatever the arrival order between the live parts and the rows, on an active
// bubble then a settled one, the view is the same, and it is the rows-only view for all the
// rows cover.

import { convexTest, type TestConvex } from "convex-test";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { parseHistoryReply } from "../../bridge/src/providers/openclaw/transcript-rows";
import { convertConvexMessage } from "./convertMessage";
import { toolCardDisplay } from "./toolActivityView";
import type { ConvexMessageView } from "./convexTypes";

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
const R = "run-x";
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
  // One apply's text bound: chunks of 32 rows, the session state on the last one.
  const chunks = rows.length === 0 ? [[]] : Array.from({ length: Math.ceil(rows.length / 32) }, (_, k) => rows.slice(k * 32, k * 32 + 32));
  for (const [k, chunk] of chunks.entries()) {
    clock += 10;
    await t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "delta",
      deltaCursor: `c:${clock}`,
      readAt: clock,
      rows: chunk as never,
      terminals: [],
      unidentified: 0,
      ...(k === chunks.length - 1 ? extra : { hasActiveRun: true, activeRunIds: [R] }),
    } as never);
  }
}
const active = { hasActiveRun: true, activeRunIds: [R] };
const over = { terminals: [{ runId: R, status: "completed", at: 5_000 }], hasActiveRun: false };
async function sha256Hex(bytes: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The bubble as the SPA builds it: `listByChat`, with the live text of `getStreamingText`
 *  overlaid on a streaming bubble (src/chat/useConvexChatRuntime.ts). */
async function bubble(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }): Promise<ConvexMessageView | undefined> {
  const as = t.withIdentity({ subject: ids.userId });
  const all = (await as.query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as ConvexMessageView[];
  const live = (await as.query(api.messages.getStreamingText, { chatId: ids.chatId as string })) as Array<{ messageId: string; text: string }>;
  const m = all.find((x) => x.role === "assistant");
  const overlay = m?.status === "streaming" ? live.find((r) => String(r.messageId) === String(m._id)) : undefined;
  return m === undefined || overlay === undefined ? m : { ...m, text: overlay.text };
}
async function stream(t: T, m: Id<"messages">, text: string) {
  await t.mutation(internal.stream.setSnapshot, { messageId: m, text, expectedRunId: R, boundInstanceName: "prod" } as never);
}
/** The cards a reader SEES: under their rows (`__turn_flow__`) or in the grouped block. */
function shownCards(m: ConvexMessageView | undefined): string[] {
  if (m === undefined) return [];
  const out = convertConvexMessage(m);
  const inline = (out.content as ReadonlyArray<{ type: string; toolName?: string; args?: { parts?: Array<{ toolCallId: string }> } }>)
    .filter((p) => p.type === "tool-call" && p.toolName === "__turn_flow__")
    .flatMap((p) => (p.args?.parts ?? []).map((x) => x.toolCallId));
  const grouped = (out.metadata?.custom as { toolParts: Array<{ toolCallId: string }> }).toolParts.map((x) => x.toolCallId);
  return [...inline, ...grouped].sort();
}
const texts = (m: ConvexMessageView | undefined) =>
  ((m === undefined ? [] : convertConvexMessage(m).content) as ReadonlyArray<{ type: string; text?: string }>)
    .filter((p) => p.type === "text" && (p.text ?? "").trim() !== "")
    .map((p) => p.text!.trim());
/** The view a reader gets: each card's phase, then the files rendered (in order). */
function seen(m: ConvexMessageView | undefined) {
  if (m === undefined) return null;
  const out = convertConvexMessage(m);
  const custom = out.metadata?.custom as { allToolParts: Array<{ toolCallId: string; phase?: string }> };
  const cards = Object.fromEntries(custom.allToolParts.map((p) => [p.toolCallId, p.phase]));
  const files = (out.content as ReadonlyArray<{ type: string; filename?: string; data?: string; remote?: boolean; unavailable?: string }>)
    .filter((p) => p.type === "file")
    .map((p) => (p.remote ? `remote:${p.data}` : p.unavailable !== undefined ? `unavailable:${p.unavailable}:${p.filename}` : `copied:${p.filename}`));
  return { cards, files };
}
async function startLive(t: T, chatId: Id<"chats">) {
  return (await t.mutation(internal.stream.startAssistant, { chatId, runId: R, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
}
async function liveTool(t: T, m: Id<"messages">, toolCallId: string, phase: string) {
  await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "tool", name: "exec", phase, toolCallId, input: { n: toolCallId } }, boundInstanceName: "prod" } as never);
}
async function liveMedia(t: T, m: Id<"messages">, bytes: string) {
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
  await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "media", storageId, filename: "a.txt", mimeType: "text/plain" }, boundInstanceName: "prod" } as never);
}
async function copyAll(t: T) {
  const records = await t.run((ctx) => ctx.db.query("transcriptFiles").collect());
  for (const rec of records) {
    if (rec.state !== "pending") continue;
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["SAME"])));
    await t.mutation(internal.transcriptFiles.finalizeCopy, { boundInstanceName: "prod", fileId: rec._id, storageId, sha256: await sha256Hex("SAME"), sizeBytes: 4, mimeType: "text/plain" });
  }
}

describe("the three forms Codex reproduced", () => {
  test("1. a tool's ERROR in the transcript wins over its live `started` part (ui/src/lib/chat/tool-cards.ts)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    await liveTool(t, m, "c1", "started");
    const rows: Row[] = [
      { entryId: "a1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, toolCallIds: ["c1"], blocks: [{ type: "tool", toolCallId: "c1", name: "exec", status: "call" }] },
      { entryId: "t1", seq: 4, role: "toolresult", runId: R, hidden: false, visible: true, toolCallIds: ["c1"], blocks: [{ type: "tool", toolCallId: "c1", name: "exec", status: "error" }] },
      { entryId: "a2", seq: 5, role: "assistant", runId: R, hidden: false, visible: true, text: "Échec.", blocks: [{ type: "text", text: "Échec." }] },
    ];
    // At once, on the active bubble…
    await apply(t, ids.chatId, rows, active);
    expect(seen(await bubble(t, ids))!.cards).toEqual({ c1: "error" });
    // …and once settled.
    await apply(t, ids.chatId, rows, over);
    expect(seen(await bubble(t, ids))!.cards).toEqual({ c1: "error" });
  });

  test("2. a remote https file is shown on the active bubble at once (chat-message-attachments.ts)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await startLive(t, ids.chatId);
    await apply(
      t,
      ids.chatId,
      [{ entryId: "a1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, text: "Voici.", blocks: [{ type: "text", text: "Voici." }, { type: "file", kind: "image", remote: true, url: "https://example.com/x.png", label: "x.png", mimeType: "image/png" }] }],
      active,
    );
    const b = await bubble(t, ids);
    expect(b!.status).toBe("streaming");
    expect(seen(b)!.files).toEqual(["remote:https://example.com/x.png"]);
  });

  test("3. 65 tool cards before the files: R4 still sees every rendered piece (two copies, one shown)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    for (let i = 0; i < 65; i++) await liveTool(t, m, `k${i}`, "completed");
    await liveMedia(t, m, "SAME");
    await liveMedia(t, m, "SAME");
    const files = seen(await bubble(t, ids))!.files;
    expect(files).toEqual(["copied:a.txt"]);
  });
});

// CODEX REVIEW 7 — the TEXT of an active bubble: the rows already received, at their place,
// plus the message still being written (the live cumulative text minus the rows' prefix —
// src/chat/streamTail.ts, ui/src/pages/chat/stream-causal-boundary.ts).
describe("codex review 7 — an active bubble shows its rows' text now, and only the message in progress live", () => {
  test("a delivery mirror received while the run goes on is shown BEFORE any terminal (chat-pane-reply-invalidation.test.ts)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    await stream(t, m, "Je continue le travail.");
    await apply(
      t,
      ids.chatId,
      [{ entryId: "mirror", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, deliveryMirror: true, text: "Synthetic audit complete: three checks passed.", blocks: [{ type: "text", text: "Synthetic audit complete: three checks passed." }] }],
      active,
    );
    const b = await bubble(t, ids);
    expect(b!.status).toBe("streaming");
    expect(texts(b)).toEqual(["Synthetic audit complete: three checks passed.", "Je continue le travail."]);
  });

  test("codex review 9: a persisted commentary segment \"A\", then the cumulative \"A\\n\\nB\": shown [A, B]", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    await apply(
      t,
      ids.chatId,
      [{ entryId: "c1:segment:item-a", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, streamSegment: true, text: "A", blocks: [{ type: "text", text: "A" }] }],
      active,
    );
    await stream(t, m, "A\n\nB");
    expect(texts(await bubble(t, ids))).toEqual(["A", "B"]);
  });

  test("streamed text, then that message's row, then new streamed text: no duplicate, no gap", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    await stream(t, m, "Premier message.");
    expect(texts(await bubble(t, ids))).toEqual(["Premier message."]);
    await apply(t, ids.chatId, [{ entryId: "p1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, text: "Premier message.", blocks: [{ type: "text", text: "Premier message." }] }], active);
    expect(texts(await bubble(t, ids))).toEqual(["Premier message."]);
    await stream(t, m, "Premier message.\n\nSecond message en cours");
    expect(texts(await bubble(t, ids))).toEqual(["Premier message.", "Second message en cours"]);
  });
});

// CODEX REVIEW 8.
describe("codex review 8 — the view of an active bubble does not depend on when it opened, and keeps the text as written", () => {
  test("rows, then the copy, then the bubble opens, then the same read: the file is shown copied and the widget at once", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const rows: Row[] = [
      { entryId: "f1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, text: "Voici.", blocks: [{ type: "text", text: "Voici." }, { type: "file", kind: "document", artifactId: "artifact_managed_media_1", label: "a.txt", mimeType: "text/plain" }] },
      { entryId: "w1", seq: 4, role: "toolresult", runId: R, hidden: false, visible: true, toolCallIds: ["w1"], blocks: [{ type: "tool", toolCallId: "w1", name: "show_widget", status: "result" }, { type: "widget", viewId: "cv_early", origin: "tool" }] },
    ];
    await apply(t, ids.chatId, rows, active);
    await copyAll(t);
    await startLive(t, ids.chatId);
    await apply(t, ids.chatId, rows, active);
    const b = await bubble(t, ids);
    expect(b!.status).toBe("streaming");
    expect(seen(b)!.files).toEqual(["copied:a.txt"]);
    expect(widgetsOf(b)).toEqual(["cv_early"]);
  });

  test("an indented example after a row: kept as written live, then once its row is stored", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    const intro: Row = { entryId: "i1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, text: "Intro.", blocks: [{ type: "text", text: "Intro." }] };
    await apply(t, ids.chatId, [intro], active);
    const example = '    [embed ref="cv_x" /]';
    await stream(t, m, `Intro.\n\n${example}`);
    const raw = (v: ConvexMessageView | undefined) =>
      (convertConvexMessage(v!).content as ReadonlyArray<{ type: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text);
    // Live: the tail exactly as the resolver returns it — its indentation is Markdown.
    expect(raw(await bubble(t, ids))).toEqual(["Intro.", `\n\n${example}`]);
    await apply(t, ids.chatId, [intro, { entryId: "i2", seq: 4, role: "assistant", runId: R, hidden: false, visible: true, text: example, blocks: [{ type: "text", text: example }] }], active);
    // Stored: the row's text as written, and nothing left live.
    expect(raw(await bubble(t, ids))).toEqual(["Intro.", example]);
  });
});

// CODEX REVIEW 9 — every path that opens or reopens a live bubble takes up what the run's
// rows already said (convex/stream.ts: `startAssistant` → `catchUpLiveBubbleFromRows`, and
// `splitSegment`). Checked before any terminal and after an identical re-read.
describe("codex review 9 — one opening point for every live bubble", () => {
  const steerRows = (viewId: string): Row[] => [
    { entryId: "a1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, text: "Avant.", blocks: [{ type: "text", text: "Avant." }] },
    { entryId: "u4", seq: 4, role: "user", runId: "send-steer", sendId: "send-steer", steerTargetRunId: R, hidden: false, visible: true, text: "Et aussi ?" },
    { entryId: "w5", seq: 5, role: "toolresult", runId: R, hidden: false, visible: true, toolCallIds: ["w5"], blocks: [{ type: "tool", toolCallId: "w5", name: "show_widget", status: "result" }, { type: "widget", viewId, origin: "tool" }] },
  ];
  const segmentBubble = async (t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }, id: Id<"messages">) => {
    const as = t.withIdentity({ subject: ids.userId });
    const all = (await as.query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as ConvexMessageView[];
    return all.find((x) => String(x._id) === String(id));
  };
  type Step = "rows" | "split";
  test.each([
    [["rows", "split"]],
    [["split", "rows"]],
  ] as Array<[Step[]]>)("a steer and its show_widget result, then the segment cut (order %j): the new segment shows the widget", async (order) => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m0 = await startLive(t, ids.chatId);
    let seg1: Id<"messages"> | null = null;
    for (const step of order) {
      if (step === "rows") await apply(t, ids.chatId, steerRows("cv_seg"), active);
      else seg1 = (await t.mutation(internal.stream.splitSegment, { messageId: m0, text: "Avant.", boundInstanceName: "prod" } as never)) as Id<"messages">;
    }
    const b = await segmentBubble(t, ids, seg1!);
    expect(b!.status).toBe("streaming");
    expect(widgetsOf(b)).toEqual(["cv_seg"]);
    // An identical re-read changes nothing.
    await apply(t, ids.chatId, steerRows("cv_seg"), active);
    expect(widgetsOf(await segmentBubble(t, ids, seg1!))).toEqual(["cv_seg"]);
  });

  // The order property, over a STEER: the rows (before the cut, the steer, after it — a
  // widget, a file), the copies, the bubble opening and the segment cut, in every order the
  // run allows (the cut needs the open bubble, the copies their rows). The new segment's
  // view is the same in all of them, before any terminal and after an identical re-read.
  type SEv = "start" | "rows" | "copies" | "split";
  const STEER_ORDERS: SEv[][] = [
    ["start", "rows", "copies", "split"],
    ["start", "rows", "split", "copies"],
    ["start", "split", "rows", "copies"],
    ["rows", "copies", "start", "split"],
    ["rows", "start", "split", "copies"],
  ];
  const steerAll = (): Row[] => [
    ...steerRows("cv_cut"),
    { entryId: "f6", seq: 6, role: "assistant", runId: R, hidden: false, visible: true, text: "Après.", blocks: [{ type: "text", text: "Après." }, { type: "file", kind: "document", artifactId: "artifact_managed_media_9", label: "b.txt", mimeType: "text/plain" }] },
  ];
  async function steerRun(order: readonly SEv[]) {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    let m0: Id<"messages"> | undefined;
    let seg1: Id<"messages"> | undefined;
    for (const ev of order) {
      if (ev === "start") m0 = await startLive(t, ids.chatId);
      else if (ev === "rows") await apply(t, ids.chatId, steerAll(), active);
      else if (ev === "copies") await copyAll(t);
      else seg1 = (await t.mutation(internal.stream.splitSegment, { messageId: m0!, text: "Avant.", boundInstanceName: "prod" } as never)) as Id<"messages">;
    }
    const view = async () => {
      const b = await segmentBubble(t, ids, seg1!);
      return { status: b!.status, texts: texts(b), files: seen(b)!.files, widgets: widgetsOf(b) };
    };
    const before = await view();
    await apply(t, ids.chatId, steerAll(), active);
    return { before, reread: await view() };
  }
  test("PROPERTY over a steer: the new segment's view in every arrival order, before any terminal and after a re-read", async () => {
    const [first, ...others] = STEER_ORDERS;
    const a = await steerRun(first!);
    expect(a.before).toEqual({ status: "streaming", texts: ["Après."], files: ["copied:b.txt"], widgets: ["cv_cut"] });
    expect(a.reread).toEqual(a.before);
    for (const order of others) expect({ order, view: await steerRun(order) }).toEqual({ order, view: a });
  }, 120_000);

  // …and the REOPENING in the order property: the replay's rows before or after the failure,
  // then the reopening — the same view, before any terminal and after an identical re-read.
  test.each([[["fail", "rows"]], [["rows", "fail"]]] as Array<[Array<"fail" | "rows">]>)(
    "a delivery bubble settled in error and its replay's rows (order %j), then the reopening: the widget is taken up",
    async (order) => {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const W = "announce:requester-settle:main:agent:main:atrium:chat:u:c1:742ca132-060c-4cf8-8c0a-3f1377095ea3:yield-1";
      const first = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: W, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
      const rows: Row[] = [
        { entryId: "dw1", seq: 3, role: "toolresult", runId: W, hidden: false, visible: true, toolCallIds: ["dw1"], blocks: [{ type: "tool", toolCallId: "dw1", name: "show_widget", status: "result" }, { type: "widget", viewId: "cv_again", origin: "tool" }] },
      ];
      const read = () =>
        t.mutation(internal.transcriptProjection.applyTranscript, {
          chatId: ids.chatId, boundInstanceName: "prod", sessionKey: SK, sessionId: "s-1", kind: "delta", deltaCursor: `c:${(clock += 10)}`, readAt: clock, rows, terminals: [], unidentified: 0, hasActiveRun: true, activeRunIds: [W],
        } as never);
      for (const step of order) {
        if (step === "fail") await t.mutation(internal.stream.finalize, { messageId: first, status: "error", error: "boom", boundInstanceName: "prod" } as never);
        else await read();
      }
      const reopened = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: W, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
      const b = await segmentBubble(t, ids, reopened);
      expect(b!.status).toBe("streaming");
      expect(widgetsOf(b)).toEqual(["cv_again"]);
      await read();
      expect(widgetsOf(await segmentBubble(t, ids, reopened))).toEqual(["cv_again"]);
    },
  );
});

// CODEX REVIEW 10 — several segments of ONE row (same id, seq and position), in the items'
// order chat.history lists them (`projectAssistantCommentaryFallbacks`): shown in that order,
// active and settled, and after an identical re-read — never in their identity's order.
describe("codex review 10 — the segments of one row are shown in chat.history's order", () => {
  test("Premier. then Deuxième. (whose identity hash sorts first), then the owner", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await startLive(t, ids.chatId);
    const meta = { id: "row-1", seq: 3, runId: R, transcriptPosition: { source: "S", rawSeq: 9 } };
    const seg = (itemId: string, text: string) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      openclawStreamFallback: { source: "segment", itemId, replacementText: text },
      __openclaw: meta,
    });
    const rows = parseHistoryReply(
      { sessionKey: SK, messages: [seg("msg_a", "Premier."), seg("msg_b", "Deuxième."), { role: "assistant", content: [{ type: "text", text: "Suite." }], stopReason: "stop", __openclaw: meta }] },
      { sessionKey: SK },
    )!.rows as unknown as Row[];
    await apply(t, ids.chatId, rows, active);
    expect(texts(await bubble(t, ids))).toEqual(["Premier.", "Deuxième.", "Suite."]);
    await apply(t, ids.chatId, rows, over);
    expect(texts(await bubble(t, ids))).toEqual(["Premier.", "Deuxième.", "Suite."]);
    await apply(t, ids.chatId, rows, over);
    expect(texts(await bubble(t, ids))).toEqual(["Premier.", "Deuxième.", "Suite."]);
  });

  test("posted live one at a time, before any read: their arrival order, kept by the later read", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await startLive(t, ids.chatId);
    const segRow = (itemHash: string, text: string, order?: number): Row => ({
      entryId: `row-1:segment:${itemHash}`, seq: 3, role: "assistant", runId: R, hidden: false, visible: true, streamSegment: true, text, blocks: [{ type: "text", text }],
      ...(order !== undefined ? { segmentOrder: order } : {}),
    });
    const live = (row: Row) =>
      t.mutation(internal.transcriptProjection.applyTranscript, {
        chatId: ids.chatId, boundInstanceName: "prod", sessionKey: SK, sessionId: "s-1", kind: "live", rows: [row], terminals: [], unidentified: 0, readAt: (clock += 10),
      } as never);
    // "zz…" sorts after "aa…": arrival order is the reverse of the identity order.
    await live(segRow("zz", "Premier."));
    await live(segRow("aa", "Deuxième."));
    expect(texts(await bubble(t, ids))).toEqual(["Premier.", "Deuxième."]);
    await apply(t, ids.chatId, [segRow("zz", "Premier.", 0), segRow("aa", "Deuxième.", 1)], over);
    expect(texts(await bubble(t, ids))).toEqual(["Premier.", "Deuxième."]);
  });
});

// CODEX REVIEW 11 — a card rebuilt from the transcript carries its arguments and its result,
// as the Control UI's `extractToolCards` reads them from persisted rows (tool-cards.ts:353).
// The corpus run missed during a disconnection: rows seq 2-3 of chat-history-tail.json, no
// live part at all.
describe("codex review 11 — a rebuilt tool card has its arguments and result", () => {
  const corpus = JSON.parse(
    readFileSync(new URL("../../bridge/test/fixtures/transcript-2026.9.33/chat-history-tail.json", import.meta.url), "utf8"),
  ) as { reply: { messages: Array<Record<string, unknown>> } };
  const cardsOf = (m: ConvexMessageView | undefined) =>
    (convertConvexMessage(m!).metadata?.custom as { allToolParts: Array<{ toolCallId: string; args?: unknown; result?: unknown; phase?: string; argsText?: string }> }).allToolParts;

  test("corpus seq 2-3, no live part: the exec card shows its args and its result, active then settled", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const [, call, result] = corpus.reply.messages;
    const runId = ((call!.__openclaw as { runId?: string }) ?? {}).runId ?? R;
    const reread = parseHistoryReply({ sessionKey: SK, messages: [call, result] }, { sessionKey: SK })!.rows.map((r) => ({ ...r, runId: r.runId ?? runId })) as unknown as Row[];
    const callId = (call!.content as Array<{ id: string }>)[0]!.id;
    const read = (extra: Row) =>
      t.mutation(internal.transcriptProjection.applyTranscript, {
        chatId: ids.chatId, boundInstanceName: "prod", sessionKey: SK, sessionId: "s-1", kind: "delta", deltaCursor: `c:${(clock += 10)}`, readAt: clock, rows: reread, terminals: [], unidentified: 0, ...extra,
      } as never);
    await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId, turnSessionKey: SK, boundInstanceName: "prod" } as never);
    await read({ hasActiveRun: true, activeRunIds: [runId] });
    const check = (m: ConvexMessageView | undefined) => {
      const card = cardsOf(m).find((c) => c.toolCallId === callId)!;
      expect(card).toBeDefined();
      expect(card.args).toMatchObject({ title: "Find delegation and delivery tools" });
      expect(card.phase).toBe("completed");
      // The result is this run's 10 KB catalogue dump: over the window read's cap
      // (PART_FIELD_CAP, convex/messages.ts), elided with its size — exactly as the live
      // part of the same call is.
      const part = m!.parts.find((p) => p.kind === "tool" && p.toolCallId === callId) as { outputOmitted?: boolean; outputBytes?: number };
      expect(part.outputOmitted).toBe(true);
      expect(part.outputBytes).toBeGreaterThan(8192);
    };
    check(await bubble(t, ids));
    await read({ terminals: [{ runId, status: "completed", at: 5_000 }], hasActiveRun: false });
    const settled = await bubble(t, ids);
    expect(settled!.status).toBe("complete");
    check(settled);
    // Stored with the card, not only drawn by the view.
    const stored = (await t.run((ctx) => ctx.db.query("messageParts").collect())).find((p) => p.part.kind === "tool" && (p.part as { toolCallId?: string }).toolCallId === callId)!;
    expect((stored.part as { input?: unknown }).input).toMatchObject({ title: "Find delegation and delivery tools" });
    expect(JSON.stringify((stored.part as { output?: unknown }).output)).toContain("completed");
  });

  test("a live card keeps its own payloads when it has them; one without gets the rows'", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "tool", name: "exec", phase: "completed", toolCallId: "own", input: { live: true }, output: "live result" }, boundInstanceName: "prod" } as never);
    await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "tool", name: "exec", phase: "started", toolCallId: "bare" }, boundInstanceName: "prod" } as never);
    const rows: Row[] = [
      { entryId: "c1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, toolCallIds: ["own", "bare"], blocks: [
        { type: "tool", toolCallId: "own", name: "exec", status: "call", input: { row: true } },
        { type: "tool", toolCallId: "bare", name: "exec", status: "call", input: { row: "bare" } },
      ] },
      { entryId: "r1", seq: 4, role: "toolresult", runId: R, hidden: false, visible: true, toolCallIds: ["bare"], blocks: [{ type: "tool", toolCallId: "bare", name: "exec", status: "result", output: { content: [{ type: "text", text: "row result" }] } }] },
    ];
    for (const extra of [active, over]) {
      await apply(t, ids.chatId, rows, extra);
      const cards = cardsOf(await bubble(t, ids));
      expect(cards.find((c) => c.toolCallId === "own")).toMatchObject({ args: { live: true }, result: "live result" });
      expect(cards.find((c) => c.toolCallId === "bare")).toMatchObject({ args: { row: "bare" }, result: { content: [{ type: "text", text: "row result" }] }, phase: "completed" });
    }
  });

  test("over the row's content budget: the card stays, its result marked cut with its size", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await startLive(t, ids.chatId);
    const big = "x".repeat(800 * 1024);
    const rows: Row[] = [
      { entryId: "c1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, toolCallIds: ["huge"], blocks: [{ type: "tool", toolCallId: "huge", name: "exec", status: "call", input: { cmd: "cat" } }] },
      { entryId: "r1", seq: 4, role: "toolresult", runId: R, hidden: false, visible: true, toolCallIds: ["huge"], blocks: [{ type: "tool", toolCallId: "huge", name: "exec", status: "result", output: { content: [{ type: "text", text: big }] } }] },
    ];
    await apply(t, ids.chatId, rows, over);
    const part = (await bubble(t, ids))!.parts.find((p) => p.kind === "tool" && p.toolCallId === "huge") as { input?: unknown; outputOmitted?: boolean; outputBytes?: number };
    expect(part.input).toEqual({ cmd: "cat" });
    expect(part.outputOmitted).toBe(true);
    expect(part.outputBytes).toBeGreaterThan(800 * 1024);
  });
});

describe("codex reviews 12-15 — a rebuilt card shows what the Control UI shows, and knows every call's id", () => {
  // The gateway stores its transcript masked (src/agents/transcript-redact.ts:721); the Control
  // UI masks a history card's argument preview and input again AT DISPLAY with
  // ui/src/lib/browser-redact.ts (tool-cards.ts:328, chat-transcript-feed.ts:176/:181), and
  // renders the output as stored (chat-tool-content.ts). Atrium does the same, in
  // `toolCardDisplay` (vendored browser-redact), for an input that came from a row.
  const SECRET = "sk-or-v1-abcdef0123456789";
  type Card = { toolCallId: string; args?: unknown; result?: unknown; argsText?: string; phase?: string; inputFromTranscript?: boolean };
  const cardsOf = (m: ConvexMessageView | undefined) =>
    (convertConvexMessage(m!).metadata?.custom as { allToolParts: Card[] }).allToolParts;
  const shown = (card: Card) => toolCardDisplay(card);
  const history = (messages: Row[]) =>
    parseHistoryReply({ sessionKey: SK, messages }, { sessionKey: SK })!.rows as unknown as Row[];
  const at = (seq: number, id: string) => ({ __openclaw: { runId: R, id, seq } });

  test("recovery after a disconnection, rows only: the input shows masked, active then settled", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const rows = history([
      { role: "assistant", content: [{ type: "toolCall", id: "k1", name: "exec", arguments: { command: `OPENROUTER_API_KEY=${SECRET} ./run.sh` } }], ...at(2, "e-call") },
      { role: "toolResult", toolCallId: "k1", toolName: "exec", content: [{ type: "text", text: "done" }], ...at(3, "e-res") },
    ]);
    await startLive(t, ids.chatId);
    for (const extra of [active, over]) {
      await apply(t, ids.chatId, rows, extra);
      const card = cardsOf(await bubble(t, ids)).find((c) => c.toolCallId === "k1")!;
      expect(card.inputFromTranscript).toBe(true);
      const { inputText, preview } = shown(card);
      for (const text of [inputText, preview]) {
        expect(text).not.toContain(SECRET);
        expect(text).toContain("OPENROUTER_API_KEY=");
      }
    }
  });

  test("Codex's two values — a short Bearer token and a Cookie header — show as `[redacted]`", async () => {
    // browser-redact.ts SENSITIVE_TEXT_PATTERNS: `(Authorization|Cookie|Set-Cookie)\s*:` and
    // `Bearer\s+[…]{12,}` — rules of the Control UI's display, not of the agent sanitizers.
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const BEARER = "curl -H 'Bearer abcdefghijkl' https://example.com";
    const COOKIE = "Cookie: auth=fixturecookievalue";
    await startLive(t, ids.chatId);
    await apply(t, ids.chatId, history([
      { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "exec", arguments: { command: BEARER } }], ...at(2, "e-b1") },
      { role: "assistant", content: [{ type: "toolCall", id: "b2", name: "exec", arguments: { command: COOKIE } }], ...at(3, "e-b2") },
    ]), over);
    const cards = cardsOf(await bubble(t, ids));
    const b1 = shown(cards.find((c) => c.toolCallId === "b1")!);
    const b2 = shown(cards.find((c) => c.toolCallId === "b2")!);
    expect(b1.preview).toBe("curl -H 'Bearer [redacted]' https://example.com");
    expect(b1.inputText).toContain("Bearer [redacted]");
    expect(b1.inputText).not.toContain("abcdefghijkl");
    expect(b2.preview).toBe("Cookie: [redacted]");
    expect(b2.inputText).not.toContain("fixturecookievalue");
  });

  test("a live part is shown as the gateway sent it: no masking is added to live data (codex review 14)", async () => {
    // Upstream masks live payloads before emitting them (…handlers.tools.start.ts:541); an
    // off/shadow conversation and every live part read exactly as before this lot.
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    const sent = { command: "OPENROUTER_API_KEY=sk-or-…6789 ./run.sh" };
    await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "tool", name: "exec", phase: "completed", toolCallId: "live", input: sent, output: "done" }, boundInstanceName: "prod" } as never);
    const card = cardsOf(await bubble(t, ids)).find((c) => c.toolCallId === "live")!;
    expect(card.args).toEqual(sent);
    expect(card.result).toBe("done");
    expect(card.inputFromTranscript).toBeUndefined();
    // Not masked at display either: a live Bearer header shows as the gateway sent it.
    expect(shown({ ...card, args: { command: "curl -H 'Bearer abcdefghijkl'" }, argsText: undefined }).preview).toContain("abcdefghijkl");
  });

  test("the output of a rebuilt card is shown as stored, as the Control UI renders it", async () => {
    // chat-tool-content.ts renders `outputText` unmasked: the gateway stored it masked.
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await startLive(t, ids.chatId);
    await apply(t, ids.chatId, history([
      { role: "toolResult", toolCallId: "o1", toolName: "exec", content: [{ type: "text", text: "OPENROUTER_API_KEY=sk-or-…6789" }], ...at(2, "e-o1") },
    ]), over);
    const card = cardsOf(await bubble(t, ids)).find((c) => c.toolCallId === "o1")!;
    expect(card.result).toEqual({ content: [{ type: "text", text: "OPENROUTER_API_KEY=sk-or-…6789" }] });
  });

  test("a settled bubble rebuilt from a legacy `tool_use` named only by `callId` has its arguments", async () => {
    // chat-tool-cards.node.test.ts:421 — the shape; tool-cards.ts:224 `resolveToolCallId`.
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const rows = history([
      { role: "assistant", content: [{ type: "tool_use", callId: "legacy-call-id", name: "bash", input: { command: "pwd" } }], ...at(2, "l-call") },
      { role: "toolResult", toolCallId: "legacy-call-id", toolName: "bash", content: [{ type: "text", text: "/tmp" }], ...at(3, "l-res") },
    ]);
    await startLive(t, ids.chatId);
    await apply(t, ids.chatId, rows, active);
    await apply(t, ids.chatId, rows, over);
    const settled = await bubble(t, ids);
    expect(settled!.status).toBe("complete");
    expect(cardsOf(settled).find((c) => c.toolCallId === "legacy-call-id")).toMatchObject({ args: { command: "pwd" }, phase: "completed" });
    const stored = (await t.run((ctx) => ctx.db.query("messageParts").collect())).find((p) => p.part.kind === "tool" && (p.part as { toolCallId?: string }).toolCallId === "legacy-call-id")!;
    expect((stored.part as { input?: unknown }).input).toEqual({ command: "pwd" });
  });

  test("a row whose reported index missed a block's id is indexed by the block's own id", async () => {
    // The index and the blocks are one identity: a row stored with the call in its blocks
    // but not in `toolCallIds` was a row the payload reader skipped (lib/rowParts.ts).
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await startLive(t, ids.chatId);
    const rows: Row[] = [
      { entryId: "c1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, blocks: [{ type: "tool", toolCallId: "legacy-call-id", name: "bash", status: "call", input: { command: "pwd" } }] },
      { entryId: "r1", seq: 4, role: "toolresult", runId: R, hidden: false, visible: true, blocks: [{ type: "tool", toolCallId: "legacy-call-id", name: "bash", status: "result", output: { content: [{ type: "text", text: "/tmp" }] } }] },
    ];
    await apply(t, ids.chatId, rows, over);
    const stored = await t.run((ctx) => ctx.db.query("transcriptRows").collect());
    expect(stored.filter((r) => r.entryId === "c1" || r.entryId === "r1").map((r) => r.toolCallIds)).toEqual([["legacy-call-id"], ["legacy-call-id"]]);
    const part = (await t.run((ctx) => ctx.db.query("messageParts").collect())).find((p) => p.part.kind === "tool" && (p.part as { toolCallId?: string }).toolCallId === "legacy-call-id")!;
    expect(part.part).toMatchObject({ input: { command: "pwd" }, output: { content: [{ type: "text", text: "/tmp" }] } });
  });
});

describe("codex review 13/14 — calls without an identity, and a gateway's own masking patterns", () => {
  const cardsOf = (m: ConvexMessageView | undefined) =>
    (convertConvexMessage(m!).metadata?.custom as { allToolParts: Array<{ toolCallId: string; args?: unknown; result?: unknown; argsText?: string; phase?: string }> }).allToolParts;
  const at = (seq: number, id: string) => ({ __openclaw: { runId: R, id, seq } });
  const history = (messages: Row[]) =>
    parseHistoryReply({ sessionKey: SK, messages }, { sessionKey: SK })!.rows as unknown as Row[];

  test("`logging.redactPatterns` is the gateway's: what chat.history serves masked stays masked; nothing unmasks it", async () => {
    // Upstream stores the transcript masked with its defaults AND the operator's patterns
    // (src/agents/transcript-redact.ts:721; logging.redactPatterns "replace the default
    // string list for log/transcript output", schema.help.core.ts:76), so a row arrives as
    // `printf ***`. Atrium keeps no policy of its own: no state, restart included, can
    // bring the value back. A value the gateway stored BEFORE the pattern existed reads as
    // the Control UI shows it (browser-redact.ts masks with the defaults only).
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await startLive(t, ids.chatId);
    await apply(t, ids.chatId, history([
      { role: "assistant", content: [{ type: "toolCall", id: "p1", name: "exec", arguments: { command: "printf ***" } }], ...at(2, "e-p1") },
      { role: "assistant", content: [{ type: "toolCall", id: "p2", name: "exec", arguments: { command: "printf acme-private-924713" } }], ...at(3, "e-p2") },
    ]), over);
    const cards = cardsOf(await bubble(t, ids));
    expect(cards.find((c) => c.toolCallId === "p1")?.args).toEqual({ command: "printf ***" });
    expect(cards.find((c) => c.toolCallId === "p2")?.args).toEqual({ command: "printf acme-private-924713" });
  });

  test("a settled bubble rebuilt from id-less calls keeps both cards, stable across reads", async () => {
    // chat-tool-cards.node.test.ts:438 — paired by name and content order.
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const nameless = () =>
      history([
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "browser.open", input: { url: "https://example.com/a" } },
            { type: "tool_result", name: "browser.open", text: "Opened A" },
            { type: "tool_use", name: "browser.open", input: { url: "https://example.com/b" } },
            { type: "tool_result", name: "browser.open", text: "Opened B" },
          ],
          ...at(2, "e-nameless"),
        },
      ]);
    await startLive(t, ids.chatId);
    await apply(t, ids.chatId, nameless(), active);
    await apply(t, ids.chatId, nameless(), over);
    await apply(t, ids.chatId, nameless(), over);
    const settled = await bubble(t, ids);
    expect(settled!.status).toBe("complete");
    const cards = cardsOf(settled);
    expect(cards.map((c) => c.toolCallId).sort()).toEqual(["e-nameless#browser.open:0", "e-nameless#browser.open:2"]);
    expect(cards.find((c) => c.toolCallId === "e-nameless#browser.open:0")).toMatchObject({ args: { url: "https://example.com/a" }, phase: "completed" });
    expect(cards.find((c) => c.toolCallId === "e-nameless#browser.open:2")).toMatchObject({ args: { url: "https://example.com/b" }, phase: "completed" });
    const stored = (await t.run((ctx) => ctx.db.query("messageParts").collect())).filter((p) => p.part.kind === "tool");
    expect(stored).toHaveLength(2);
  });
});

// ── The property ─────────────────────────────────────────────────────────────────────────
type Tool = { id: string; live: "started" | "completed" | null; row: "call" | "result" | "error" | null };
type Scenario = { tools: Tool[]; remote: boolean; copies: number; liveCopy: boolean; code: boolean; widget: boolean; segments: boolean };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function scenario(seed: number): Scenario {
  const r = rng(seed);
  const pick = <X,>(xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;
  const n = pick([1, 3, 8, 70]);
  const tools: Tool[] = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    live: pick(["started", "completed", null] as const),
    row: pick(["call", "result", "error", null] as const),
  }));
  const copies = pick([0, 1, 2]);
  const remote = r() < 0.5;
  const liveCopy = copies > 0 && r() < 0.7;
  // Codex review 8: text whose spaces are Markdown (an indented block, blank lines), and a
  // widget the run's own show_widget made.
  const code = r() < 0.5;
  const widget = r() < 0.5;
  // Codex review 10: several segments of one row, listed in their items' order.
  return { tools, remote, copies, liveCopy, code, widget, segments: r() < 0.5 };
}
const IN_PROGRESS = "Je continue le travail";
const CODE_TEXT = "Exemple :\n\n    [embed ref=\"cv_x\" /]\n    indenté\n\n\nfin";
const rowTexts = (rows: Row[]) => rows.flatMap((r) => (typeof r.text === "string" ? [r.text] : []));
function rowsOf(s: Scenario): Row[] {
  const rows: Row[] = [];
  let seq = 3;
  for (const tool of s.tools) {
    if (tool.row === null) continue;
    // The rows carry the call's arguments and the result (codex review 11).
    rows.push({ entryId: `call-${tool.id}`, seq: seq++, role: "assistant", runId: R, hidden: false, visible: true, toolCallIds: [tool.id], blocks: [{ type: "tool", toolCallId: tool.id, name: "exec", status: "call", input: { row: tool.id } }] });
    if (tool.row !== "call") {
      rows.push({ entryId: `res-${tool.id}`, seq: seq++, role: "toolresult", runId: R, hidden: false, visible: true, toolCallIds: [tool.id], blocks: [{ type: "tool", toolCallId: tool.id, name: "exec", status: tool.row, output: { content: [{ type: "text", text: `résultat ${tool.id}` }] } }] });
    }
  }
  for (let k = 0; k < s.copies; k++) {
    rows.push({ entryId: `file-${k}`, seq: seq++, role: "assistant", runId: R, hidden: false, visible: true, text: `Envoi ${k}`, blocks: [{ type: "text", text: `Envoi ${k}` }, { type: "file", kind: "document", artifactId: `artifact_managed_media_${k}`, label: "a.txt", mimeType: "text/plain" }] });
  }
  if (s.remote) {
    rows.push({ entryId: "remote", seq: seq++, role: "assistant", runId: R, hidden: false, visible: true, text: "Lien.", blocks: [{ type: "text", text: "Lien." }, { type: "file", kind: "image", remote: true, url: "https://example.com/r.png", label: "r.png", mimeType: "image/png" }] });
  }
  if (s.segments) {
    const at = seq++;
    // Identity order (zz > aa) is the reverse of the listed order.
    rows.push({ entryId: "multi:segment:zz", seq: at, role: "assistant", runId: R, hidden: false, visible: true, streamSegment: true, segmentOrder: 0, text: "Segment un.", blocks: [{ type: "text", text: "Segment un." }] });
    rows.push({ entryId: "multi:segment:aa", seq: at, role: "assistant", runId: R, hidden: false, visible: true, streamSegment: true, segmentOrder: 1, text: "Segment deux.", blocks: [{ type: "text", text: "Segment deux." }] });
    rows.push({ entryId: "multi", seq: at, role: "assistant", runId: R, hidden: false, visible: true, text: "Après segments.", blocks: [{ type: "text", text: "Après segments." }] });
  }
  if (s.code) {
    rows.push({ entryId: "code", seq: seq++, role: "assistant", runId: R, hidden: false, visible: true, text: CODE_TEXT, blocks: [{ type: "text", text: CODE_TEXT }] });
  }
  if (s.widget) {
    rows.push({
      entryId: "widget",
      seq: seq++,
      role: "toolresult",
      runId: R,
      hidden: false,
      visible: true,
      toolCallIds: ["w1"],
      blocks: [{ type: "tool", toolCallId: "w1", name: "show_widget", status: "result" }, { type: "widget", viewId: "cv_prop", title: "Tableau", origin: "tool" }],
    });
  }
  rows.push({ entryId: "final", seq: seq++, role: "assistant", runId: R, hidden: false, visible: true, text: "Réponse.", blocks: [{ type: "text", text: "Réponse." }] });
  return rows;
}

type Ev = "start" | "rows" | "copies" | "live";
/** Every arrival order the run allows: the bubble opens (`startAssistant`), the rows come,
 *  the copies finish (after their rows), the live parts and text come (into the open
 *  bubble) — in any interleaving (codex review 8). */
const ORDERS: Ev[][] = [
  ["start", "live", "rows", "copies"],
  ["start", "rows", "live", "copies"],
  ["start", "rows", "copies", "live"],
  ["rows", "start", "live", "copies"],
  ["rows", "start", "copies", "live"],
  ["rows", "copies", "start", "live"],
];

/** One run: the events in `order`; the view is read while active (no terminal), then after
 *  the terminal. `live: false` = the rows alone. */
async function run(s: Scenario, order: readonly Ev[], live = true) {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const rows = rowsOf(s);
  let m: Id<"messages"> | undefined;
  for (const ev of order) {
    if (ev === "start") m = await startLive(t, ids.chatId);
    else if (ev === "rows") await apply(t, ids.chatId, rows, active);
    else if (ev === "copies") await copyAll(t);
    else if (live) {
      for (const tool of s.tools) if (tool.live !== null) await liveTool(t, m!, tool.id, tool.live);
      if (s.liveCopy) await liveMedia(t, m!, "SAME");
      // The run's cumulative text: every row's text, then the message still being written.
      await stream(t, m!, [...rowTexts(rows), IN_PROGRESS].join("\n\n"));
    }
  }
  const b = await bubble(t, ids);
  const activeView = { ...seen(b)!, texts: texts(b), shownCards: shownCards(b), widgets: widgetsOf(b), payloads: payloadsOf(b) };
  // An identical re-read changes nothing of it (the segments' order included).
  await apply(t, ids.chatId, rows, active);
  expect(texts(await bubble(t, ids))).toEqual(activeView.texts);
  await apply(t, ids.chatId, rows, over);
  const settled = await bubble(t, ids);
  const settledView = { ...seen(settled)!, widgets: widgetsOf(settled), texts: texts(settled), payloads: payloadsOf(settled) };
  return { activeView, settledView };
}
/** Each card's arguments and result, as the reader gets them. */
const payloadsOf = (m: ConvexMessageView | undefined) =>
  Object.fromEntries(
    (convertConvexMessage(m!).metadata?.custom as { allToolParts: Array<{ toolCallId: string; args?: unknown; result?: unknown }> }).allToolParts.map((c) => [
      c.toolCallId,
      { args: c.args, result: c.result },
    ]),
  );
const widgetsOf = (m: ConvexMessageView | undefined) =>
  ((m === undefined ? [] : convertConvexMessage(m).content) as ReadonlyArray<{ type: string; data?: { viewId?: string } }>)
    .filter((p) => p.type === "data-widget")
    .map((p) => p.data!.viewId);

/** What the rows cover: the cards whose outcome a row states, and the rows' files. */
function covered(s: Scenario, v: ReturnType<typeof seen>) {
  const said = new Set(s.tools.filter((x) => x.row === "result" || x.row === "error").map((x) => x.id));
  return {
    cards: Object.fromEntries(Object.entries(v!.cards).filter(([id]) => said.has(id))),
    files: v!.files,
  };
}

describe("PROPERTY — the view does not depend on the arrival order between the live parts and the rows", () => {
  const SEEDS = [1, 2, 3, 4, 6, 7, 13, 20, 30, 44];
  test("the generated cases cover the family: many cards, errors over live phases, local and remote files, sha256 twins", () => {
    const all = SEEDS.map(scenario);
    expect(all.some((s) => s.tools.length >= 65)).toBe(true);
    expect(all.some((s) => s.tools.some((x) => x.row === "error" && x.live !== null))).toBe(true);
    expect(all.some((s) => s.tools.some((x) => x.row === "result" && x.live === "started"))).toBe(true);
    expect(all.some((s) => s.tools.some((x) => x.row === null && x.live !== null))).toBe(true);
    expect(all.some((s) => s.remote)).toBe(true);
    expect(all.some((s) => s.copies === 2 && s.liveCopy)).toBe(true);
    expect(all.some((s) => s.code)).toBe(true);
    expect(all.some((s) => s.widget)).toBe(true);
    expect(all.some((s) => s.segments)).toBe(true);
  });
  test.each(SEEDS)("seed %i: the same view in every arrival order (bubble opening, rows, copies, live), active then settled; equal to the rows-only view for what the rows cover", async (seed) => {
    const s = scenario(seed);
    const [first, ...others] = ORDERS;
    const a = await run(s, first!);
    for (const order of others) expect({ order, view: await run(s, order) }).toEqual({ order, view: a });
    const alone = await run(s, ["start", "rows", "copies"], false);
    if (s.widget) expect(a.activeView.widgets).toEqual(["cv_prop"]);
    expect(alone.activeView.widgets).toEqual(a.activeView.widgets);
    expect(covered(s, a.activeView)).toEqual(covered(s, alone.activeView));
    // The TEXT of the active bubble: the rows' texts, at their place, plus only the message
    // still being written — whatever the order.
    expect(alone.activeView.texts).toEqual(rowTexts(rowsOf(s)));
    expect(a.activeView.texts).toEqual([...rowTexts(rowsOf(s)), IN_PROGRESS]);
    expect(covered(s, a.settledView)).toEqual(covered(s, alone.settledView));
    // Settled: the rows' texts in the order they were listed (segments included).
    expect(a.settledView.texts).toEqual(rowTexts(rowsOf(s)));
    // A card the transcript does not hold yet stays shown while the run goes on.
    for (const tool of s.tools) if (tool.row === null && tool.live !== null) expect(a.activeView.shownCards).toContain(tool.id);
    // HYDRATION (codex review 11): a live card keeps its own arguments; any card without a
    // result gets the row's; a card only the rows name has both — in every order, active and
    // settled.
    for (const view of [a.activeView, a.settledView]) {
      for (const tool of s.tools) {
        const got = view.payloads[tool.id];
        if (tool.live !== null) expect(got?.args).toEqual({ n: tool.id });
        else if (tool.row !== null) expect(got?.args).toEqual({ row: tool.id });
        if (tool.row === "result" || tool.row === "error") expect(got?.result).toEqual({ content: [{ type: "text", text: `résultat ${tool.id}` }] });
      }
    }
    // Every card a row names, with its outcome when the row states one.
    for (const tool of s.tools) {
      if (tool.row === "result") expect(a.settledView!.cards[tool.id]).toBe("completed");
      if (tool.row === "error") expect(a.settledView!.cards[tool.id]).toBe("error");
    }
  }, 120_000);
});

// CODEX REVIEW 1 OF 0.101.1 — a live card of the ITEM lane (a delivery run's only tool
// telemetry: name, outcome and, since the fix, the call's `toolCallId` — no args, no result)
// and the same call brought by the rows: ONE card, in every arrival order, while the run is
// still being written (after the rows are received, before any terminal), then settled.
describe("PROPERTY — an item-lane live card and the same call from the rows are one card", () => {
  async function itemLaneCard(t: T, m: Id<"messages">, toolCallId: string | undefined) {
    await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "tool", name: "exec", phase: "completed", ...(toolCallId === undefined ? {} : { toolCallId }) }, boundInstanceName: "prod" } as never);
  }
  const rows: Row[] = [
    { entryId: "call-x", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, toolCallIds: ["call_x|fc_1"], blocks: [{ type: "tool", toolCallId: "call_x|fc_1", name: "exec", status: "call", input: { command: "ls" } }] },
    { entryId: "res-x", seq: 4, role: "toolresult", runId: R, hidden: false, visible: true, toolCallIds: ["call_x|fc_1"], blocks: [{ type: "tool", toolCallId: "call_x|fc_1", name: "exec", status: "result", output: { content: [{ type: "text", text: "ok" }] } }] },
  ];
  const cardsOf = (m: ConvexMessageView | undefined) =>
    (convertConvexMessage(m!).metadata?.custom as { allToolParts: Array<{ toolCallId: string; toolName?: string; phase?: string }> }).allToolParts.map((c) => [c.toolCallId, c.phase]);
  async function runOrder(order: readonly Ev[]) {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    let m: Id<"messages"> | undefined;
    for (const ev of order) {
      if (ev === "start") m = await startLive(t, ids.chatId);
      else if (ev === "rows") await apply(t, ids.chatId, rows, active);
      else if (ev === "live") await itemLaneCard(t, m!, "call_x|fc_1");
    }
    const b = await bubble(t, ids);
    expect(b!.status).toBe("streaming");
    const activeCards = { cards: cardsOf(b), shown: shownCards(b) };
    await apply(t, ids.chatId, rows, over);
    return { activeCards, settledCards: cardsOf(await bubble(t, ids)) };
  }
  const ITEM_ORDERS: Ev[][] = [
    ["start", "live", "rows"],
    ["start", "rows", "live"],
    ["rows", "start", "live"],
  ];
  test.each(ITEM_ORDERS)("order %s, %s, %s: one exec card, active then settled", async (...order) => {
    const view = await runOrder(order as Ev[]);
    expect(view.activeCards.cards).toEqual([["call_x|fc_1", "completed"]]);
    expect(view.activeCards.shown).toEqual(["call_x|fc_1"]);
    expect(view.settledCards).toEqual([["call_x|fc_1", "completed"]]);
  }, 60_000);
  test("the anonymous card the item lane wrote before the fix is the extra `exec` Codex saw", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    await itemLaneCard(t, m, undefined);
    await apply(t, ids.chatId, rows, active);
    expect(cardsOf(await bubble(t, ids))).toHaveLength(2);
  });
});

// ── Codex review 17: what an `on` conversation shows survives export, import and fork ──────
/** Every assistant bubble of a conversation, as the SPA renders it (convertConvexMessage),
 *  with what names THIS deployment removed: ids, urls, storage, clocks, attribution. */
async function viewOf(t: T, userId: Id<"users">, chatId: Id<"chats">) {
  const as = t.withIdentity({ subject: userId });
  const all = (await as.query(api.messages.listByChat, { chatId: chatId as string })) as unknown as ConvexMessageView[];
  const local = /^(_id|_creationTime|id|messageId|chatId|fileId|transcriptFileId|storageId|updatedAt|createdAt|sentAt|settledAt|ageSeconds|agent|agentLabel|importedAgentLabel|routedAgentId|routedInstanceName|authorLabel|authorName|forkedFrom)$/;
  const scrub = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(scrub);
    if (typeof v === "string") {
      if (/^(https?:|blob:)/.test(v) && !v.startsWith("https://example.com")) return "<url>";
      // A document id inside a synthetic key (`flow:<messageId>:row:…`).
      return v.replace(/\d{16,}[A-Za-z_]+/g, "<id>");
    }
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!local.test(k)) out[k] = scrub(x);
    return out;
  };
  return all
    .filter((m) => m.role === "assistant")
    .map((m) => {
      const c = convertConvexMessage(m);
      const custom = (c.metadata?.custom ?? {}) as Record<string, unknown>;
      return scrub({ status: m.status, content: c.content, allToolParts: custom.allToolParts, toolParts: custom.toolParts, displayHidden: m.displayHidden ?? [] });
    });
}

/** Export the conversation through the archive queries, then import it as the same user
 *  (the bytes re-uploaded and registered, as the browser does — lib/chatArchive.ts). */
async function exportImport(t: T, userId: Id<"users">, chatId: Id<"chats">): Promise<Id<"chats">> {
  const as = t.withIdentity({ subject: userId });
  const manifest = await as.action(api.archiveExport.exportManifest, {});
  expect(manifest.formatVersion).toBe(4);
  const chatRow = await as.query(api.archiveExport.exportChat, { chatId });
  const sections: Record<string, Record<string, unknown>[]> = {};
  const keys = new Set<string>();
  for (const section of manifest.sections) {
    let cursor: string | null = null;
    sections[section] = [];
    do {
      const page = (await as.query(api.archiveExport.exportChatSection, { chatId, section: section as "messages", cursor })) as {
        rows: Record<string, unknown>[];
        blobs: Array<{ key: string }>;
        cursor: string | null;
      };
      sections[section]!.push(...page.rows);
      for (const b of page.blobs) keys.add(b.key);
      cursor = page.cursor;
    } while (cursor !== null);
  }
  const blobs: Array<{ key: string; storageId: Id<"_storage"> }> = [];
  for (const key of keys) {
    const storageId = await t.run(async (ctx) => {
      const file = await ctx.db.get(key as Id<"files">);
      const bytes = file === null ? null : await ctx.storage.get(file.storageId);
      const id = await ctx.storage.store(bytes ?? new Blob([""]));
      await ctx.db.insert("uploads", { storageId: id, userId });
      return id;
    });
    blobs.push({ key, storageId });
  }
  const importId = await as.mutation(api.archiveImport.beginImport, { manifest: { formatVersion: manifest.formatVersion, origin: manifest.origin } });
  await as.mutation(api.archiveImport.importBatch, { importId, section: "chats", rows: [chatRow] });
  for (const section of manifest.sections) {
    const rows = sections[section] ?? [];
    for (let i = 0; i < rows.length; i += 100) {
      await as.mutation(api.archiveImport.importBatch, { importId, section: section as "messages", rows: rows.slice(i, i + 100), blobs });
    }
  }
  for (let i = 0; i < 20; i++) if ((await as.mutation(api.archiveImport.finishImport, { importId })).done) break;
  const chats = await t.run((ctx) => ctx.db.query("chats").collect());
  return chats.filter((c) => c._id !== chatId && c.forkedFromChatId === undefined).at(-1)!._id;
}

async function forkOf(t: T, userId: Id<"users">, chatId: Id<"chats">): Promise<Id<"chats">> {
  const last = (await t.run((ctx) => ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect())).at(-1)!;
  const { chatId: forkId } = await t.withIdentity({ subject: userId }).mutation(api.chatFork.forkChat, { branchMessageId: last._id });
  return forkId;
}

describe("codex review 17 — an `on` conversation shows the same after export, import and fork", () => {
  test("Codex's reproduction: a `MEDIA:https://…/report.pdf` attachment survives as a remote reference", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await startLive(t, ids.chatId);
    await apply(t, ids.chatId, [
      { entryId: "m1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, text: "Le rapport.", blocks: [{ type: "text", text: "Le rapport." }, { type: "file", kind: "document", remote: true, url: "https://example.com/report.pdf", label: "report.pdf", mimeType: "application/pdf" }] },
    ], over);
    const before = await viewOf(t, ids.userId, ids.chatId);
    expect(JSON.stringify(before)).toContain("https://example.com/report.pdf");
    expect(await viewOf(t, ids.userId, await exportImport(t, ids.userId, ids.chatId))).toEqual(before);
    expect(await viewOf(t, ids.userId, await forkOf(t, ids.userId, ids.chatId))).toEqual(before);
  });

  test("copied, gone and refused files keep their state, reason and bytes", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await startLive(t, ids.chatId);
    const fileRow = (k: number) => ({ entryId: `f${k}`, seq: 3 + k, role: "assistant", runId: R, hidden: false, visible: true, text: `Envoi ${k}`, blocks: [{ type: "text", text: `Envoi ${k}` }, { type: "file", kind: "document", artifactId: `artifact_managed_media_${k}`, label: `f${k}.txt`, mimeType: "text/plain" }] });
    await apply(t, ids.chatId, [fileRow(0), fileRow(1), fileRow(2), fileRow(3)], active);
    const records = await t.run((ctx) => ctx.db.query("transcriptFiles").collect());
    const byEntry = (e: string) => records.find((r) => r.entryId === e)!;
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["SAME"])));
    await t.mutation(internal.transcriptFiles.finalizeCopy, { boundInstanceName: "prod", fileId: byEntry("f0")._id, storageId, sha256: await sha256Hex("SAME"), sizeBytes: 4, mimeType: "text/plain" });
    await t.mutation(internal.transcriptFiles.noteCopyFailure, { boundInstanceName: "prod", fileId: byEntry("f1")._id, outcome: "gone", reason: "artifact_expired" });
    await t.mutation(internal.transcriptFiles.noteCopyFailure, { boundInstanceName: "prod", fileId: byEntry("f2")._id, outcome: "refused", reason: "too_large" });
    // f3 stays pending: shown as pending, and so it is in every copy.
    await apply(t, ids.chatId, [fileRow(0), fileRow(1), fileRow(2), fileRow(3)], over);
    const before = await viewOf(t, ids.userId, ids.chatId);
    const shown = JSON.stringify(before);
    for (const fact of ['"unavailable":"gone"', '"unavailable":"refused","reason":"too_large"', '"unavailable":"pending"', '"filename":"f0.txt"']) {
      expect(shown).toContain(fact);
    }
    const imported = await exportImport(t, ids.userId, ids.chatId);
    expect(await viewOf(t, ids.userId, imported)).toEqual(before);
    expect(await viewOf(t, ids.userId, await forkOf(t, ids.userId, ids.chatId))).toEqual(before);
    // The copies' pending record has no due time: never handed to a gateway.
    const copies = (await t.run((ctx) => ctx.db.query("transcriptFiles").collect())).filter((r) => r.chatId !== ids.chatId);
    expect(copies.filter((r) => r.state === "pending").map((r) => r.nextAttemptAt)).toEqual([undefined, undefined]);
    const leased = await t.mutation(internal.transcriptFiles.leaseDueForResume, {});
    const handed = leased.flatMap((g: { files: Array<{ fileId: string }> }) => g.files.map((f) => f.fileId));
    for (const r of copies) expect(handed).not.toContain(r._id);
  });

  test("the display group a bubble belongs to travels, remapped to the copy's own head", async () => {
    // R4 decides by display group (lib/displayDedup.ts): the group id is its head's id.
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await startLive(t, ids.chatId);
    await apply(t, ids.chatId, [{ entryId: "g1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, text: "Un.", blocks: [{ type: "text", text: "Un." }] }], over);
    await t.run((ctx) => ctx.db.patch(m, { displayGroupId: String(m) }));
    for (const copy of [await exportImport(t, ids.userId, ids.chatId), await forkOf(t, ids.userId, ids.chatId)]) {
      const [bubbleCopy] = (await t.run((ctx) => ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", copy)).collect())).filter((x) => x.role === "assistant");
      expect(bubbleCopy!.displayGroupId).toBe(String(bubbleCopy!._id));
      expect(bubbleCopy!.rowLayout).toEqual((await t.run((ctx) => ctx.db.get(m)))!.rowLayout);
    }
  });

  const SEEDS = [1, 2, 3, 6, 7, 13, 20, 44];
  test.each(SEEDS)("PROPERTY seed %i: view before = view after export then import = view of the fork", async (n) => {
    const s = scenario(n);
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const rows = rowsOf(s);
    const m = await startLive(t, ids.chatId);
    for (const tool of s.tools) if (tool.live !== null) await liveTool(t, m, tool.id, tool.live);
    if (s.liveCopy) await liveMedia(t, m, "SAME");
    await stream(t, m, [...rowTexts(rows), IN_PROGRESS].join("\n\n"));
    await apply(t, ids.chatId, rows, active);
    await copyAll(t);
    await apply(t, ids.chatId, rows, over);
    const before = await viewOf(t, ids.userId, ids.chatId);
    expect(await viewOf(t, ids.userId, await exportImport(t, ids.userId, ids.chatId))).toEqual(before);
    expect(await viewOf(t, ids.userId, await forkOf(t, ids.userId, ids.chatId))).toEqual(before);
  }, 120_000);
});
