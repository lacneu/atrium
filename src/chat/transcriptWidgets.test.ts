/// <reference types="vite/client" />
//
// INLINE WIDGETS OF A REPLY REBUILT FROM THE TRANSCRIPT (projection `on`). The Control UI
// shows the canvas blocks the gateway appends to a history row
// (chat-display-projection.canvas.ts `augmentChatHistoryWithCanvasBlocks`) and the `[embed]`
// shortcodes of its text (message-normalizer.ts:398). The gateway's `canvas.document.view`
// serves ANY document to any operator socket, so Atrium decides who a document belongs to
// (convex/widgets.ts): a view is registered to a conversation only from a `show_widget`
// RESULT row of that conversation's own session; any other carrier — a canvas block (the
// gateway projects one from ANY canvas-shaped tool result), a shortcode (model text) — is
// shown only for a view already registered to it. End to end: bridge `toTranscriptRow` →
// `applyTranscript` → `listByChat` → `convertConvexMessage`, and the reader's fetch
// authorization (`authorizeWidgetView`).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { syncBubbleRowParts } from "../../convex/lib/rowParts";
import { toTranscriptRow } from "../../bridge/src/providers/openclaw/transcript-rows";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";

const modules = import.meta.glob("../../convex/**/*.ts");
type T = TestConvex<typeof schema>;
type Raw = Record<string, unknown>;

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

const doc = (id: string) => `/__openclaw__/canvas/documents/${id}/index.html`;
const canvasJson = (id: string, title = "Tableau") =>
  JSON.stringify({ kind: "canvas", view: { id, url: doc(id) }, presentation: { target: "assistant_message", title, sandbox: "scripts" } });
const canvasBlock = (id: string) => ({
  type: "canvas",
  preview: { kind: "canvas", surface: "assistant_message", render: "url", viewId: id, url: doc(id), title: "Tableau" },
  rawText: canvasJson(id),
});

type Chat = { userId: Id<"users">; chatId: Id<"chats">; sk: string };

async function seedInstance(t: T) {
  await t.run(async (ctx) => {
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
  });
}
let clock = 1_000;
async function newChat(t: T, name: string, extra: Raw = {}): Promise<Chat> {
  const sk = `agent:main:atrium:chat:u:${name}`;
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: `u-${name}` });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main", ...extra });
    return { userId, chatId };
  });
  await read(t, { ...ids, sk }, [], { kind: "page" });
  return { ...ids, sk };
}
function read(t: T, c: Chat, raws: Raw[], extra: Raw = {}) {
  clock += 10;
  const rows = raws.map((m) => toTranscriptRow(m, undefined, { sessionKey: c.sk })!);
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId: c.chatId,
    boundInstanceName: "prod",
    sessionKey: c.sk,
    sessionId: `s-${c.sk}`,
    kind: "delta",
    deltaCursor: `c:${clock}`,
    readAt: clock,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}
const over = (...runs: string[]) => ({ terminals: runs.map((runId) => ({ runId, status: "completed", at: Date.now() })), hasActiveRun: false });
async function bubbles(t: T, c: Chat): Promise<ConvexMessageView[]> {
  const all = (await t.withIdentity({ subject: c.userId }).query(api.messages.listByChat, { chatId: c.chatId as string })) as unknown as ConvexMessageView[];
  return all.filter((m) => m.role === "assistant");
}
const rendered = (m: ConvexMessageView) =>
  (convertConvexMessage(m).content as ReadonlyArray<{ type: string; text?: string; data?: { viewId?: string } }>).flatMap((p) =>
    p.type === "text" ? [`text:${p.text}`] : p.type === "data-widget" ? [`widget:${p.data!.viewId}`] : [],
  );
const registered = (t: T, chatId: Id<"chats">) =>
  t.run(async (ctx) => (await ctx.db.query("widgetViews").collect()).filter((r) => r.chatId === chatId).map((r) => r.viewId));

/** One run: the show_widget call, its RESULT (when `proof`), then the reply that shows it
 *  (the canvas block the gateway appends, and the agent's own shortcode). */
function widgetRun(runId: string, viewId: string, opts: { proof: "show_widget" | "exec" | null }): Raw[] {
  const rows: Raw[] = [
    { role: "assistant", content: [{ type: "toolCall", id: `${runId}-w`, name: opts.proof === "exec" ? "exec" : "show_widget", arguments: {} }], __openclaw: { id: `${runId}-a1`, seq: 3, runId } },
  ];
  if (opts.proof !== null) {
    rows.push({ role: "toolResult", toolCallId: `${runId}-w`, toolName: opts.proof, content: canvasJson(viewId), __openclaw: { id: `${runId}-t1`, seq: 4, runId } });
  }
  rows.push({
    role: "assistant",
    content: [{ type: "text", text: `Voici le tableau.\n[embed ref="${viewId}" /]` }, canvasBlock(viewId)],
    stopReason: "stop",
    __openclaw: { id: `${runId}-a2`, seq: 5, runId },
  });
  return rows;
}

describe("a reply rebuilt from the transcript shows its widget, as the Control UI does", () => {
  test("the session's own show_widget result registers the view; the reply shows it once, its shortcode hidden", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const a = await newChat(t, "a");
    await read(t, a, widgetRun("run-w", "cv_mine", { proof: "show_widget" }), over("run-w"));
    expect(await registered(t, a.chatId)).toEqual(["cv_mine"]);
    const [b] = await bubbles(t, a);
    expect(b!.parts.filter((p) => p.kind === "widget").map((p) => (p as { viewId: string }).viewId)).toEqual(["cv_mine"]);
    // The shortcode is hidden beside its widget (src/chat/widgets/shortcodes.ts), as live.
    expect(rendered(b!)).toEqual(["text:Voici le tableau.\n", "widget:cv_mine"]);
    // The reader may fetch it.
    const auth = await t.withIdentity({ subject: a.userId }).query(internal.widgets.authorizeWidgetView, {
      chatId: a.chatId as string,
      messageId: b!._id as string,
      viewId: "cv_mine",
    });
    expect(auth.ok).toBe(true);
    // A second read of the same rows changes nothing.
    await read(t, a, widgetRun("run-w", "cv_mine", { proof: "show_widget" }), over("run-w"));
    const [again] = await bubbles(t, a);
    expect(again!.parts.filter((p) => p.kind === "widget")).toHaveLength(1);
  });

  test("widgets off for the conversation: nothing registered, nothing shown", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const a = await newChat(t, "off", { widgetsDisabled: true });
    await read(t, a, widgetRun("run-off", "cv_off", { proof: "show_widget" }), over("run-off"));
    expect(await registered(t, a.chatId)).toEqual([]);
    const [b] = await bubbles(t, a);
    expect(b!.parts.some((p) => p.kind === "widget")).toBe(false);
  });
});

describe("IDOR — a document another session made, cited in a row, is neither registered nor shown", () => {
  test("registered to conversation B: A's canvas block, shortcode and even its own show_widget-shaped result claim nothing", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const b = await newChat(t, "b");
    await read(t, b, widgetRun("run-b", "cv_other", { proof: "show_widget" }), over("run-b"));
    expect(await registered(t, b.chatId)).toEqual(["cv_other"]);
    const a = await newChat(t, "a");
    await read(t, a, widgetRun("run-a", "cv_other", { proof: "show_widget" }), over("run-a"));
    expect(await registered(t, a.chatId)).toEqual([]);
    const [bubble] = await bubbles(t, a);
    expect(bubble!.parts.some((p) => p.kind === "widget")).toBe(false);
    // The shortcode stays visible text: no widget stands for it.
    expect(rendered(bubble!)).toEqual(['text:Voici le tableau.\n[embed ref="cv_other" /]']);
    const auth = await t.withIdentity({ subject: a.userId }).query(internal.widgets.authorizeWidgetView, {
      chatId: a.chatId as string,
      messageId: bubble!._id as string,
      viewId: "cv_other",
    });
    expect(auth).toEqual({ ok: false, reason: "not_a_widget" });
  });

  test("registered nowhere, named by another tool's canvas-shaped text (upstream projects it all the same): nothing", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const a = await newChat(t, "a");
    await read(t, a, widgetRun("run-x", "cv_ghost", { proof: "exec" }), over("run-x"));
    await read(t, a, widgetRun("run-y", "cv_ghost2", { proof: null }).map((r) => ({ ...r, __openclaw: { ...(r.__openclaw as Raw), id: `y-${(r.__openclaw as Raw).id}`, seq: Number((r.__openclaw as Raw).seq) + 10 } })), over("run-y"));
    expect(await registered(t, a.chatId)).toEqual([]);
    for (const m of await bubbles(t, a)) expect(m.parts.some((p) => p.kind === "widget")).toBe(false);
  });
});

describe("a derived widget follows the rows", () => {
  test("a widget part the current rows no longer name is removed; a live one is never touched", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const a = await newChat(t, "a");
    await read(t, a, widgetRun("run-w", "cv_mine", { proof: "show_widget" }), over("run-w"));
    const [b] = await bubbles(t, a);
    const mid = b!._id as unknown as Id<"messages">;
    await t.run(async (ctx) => {
      // A live widget part, and the rows' layout no longer naming any widget.
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 99,
        part: { kind: "widget", provider: "openclaw", viewId: "cv_live", sandbox: "scripts" },
        widgetViewId: "cv_live",
      });
      const m = await ctx.db.get(mid);
      await ctx.db.patch(mid, { rowLayout: m!.rowLayout!.map(({ widgets: _w, ...r }) => r) });
      await syncBubbleRowParts(ctx, mid);
    });
    const [after] = await bubbles(t, a);
    expect(after!.parts.filter((p) => p.kind === "widget").map((p) => (p as { viewId: string }).viewId)).toEqual(["cv_live"]);
  });
});

describe("the proof is a row of the reply's OWN session", () => {
  test("a show_widget result row of another session registers nothing", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const a = await newChat(t, "a");
    await read(t, a, widgetRun("run-w", "cv_mine", { proof: "show_widget" }), over("run-w"));
    const [b] = await bubbles(t, a);
    const mid = b!._id as unknown as Id<"messages">;
    await t.run(async (ctx) => {
      await ctx.db.insert("transcriptRows", {
        chatId: a.chatId,
        instanceName: "prod",
        sessionKey: "agent:main:atrium:chat:u:elsewhere",
        sessionId: "s-x",
        entryId: "foreign",
        seq: 9,
        role: "toolresult",
        runId: "run-w",
        hidden: false,
        visible: true,
        updatedAt: 1,
      });
      const m = await ctx.db.get(mid);
      await ctx.db.patch(mid, {
        rowLayout: [...m!.rowLayout!, { entryId: "foreign", start: 0, end: 0, widgets: [{ viewId: "cv_foreign", origin: "tool" as const }] }],
      });
      await syncBubbleRowParts(ctx, mid);
    });
    expect(await registered(t, a.chatId)).toEqual(["cv_mine"]);
    const [after] = await bubbles(t, a);
    expect(after!.parts.filter((p) => p.kind === "widget").map((p) => (p as { viewId: string }).viewId)).toEqual(["cv_mine"]);
  });
});

// Codex review 4, finding 1: a `show_widget` nested in code mode, rebuilt with NO live part.
// The row is chat.history's own shape at v2026.9.33 — `prepareChatHistoryRecoveryMessages`
// (src/gateway/chat-display-projection.core.ts:424-459) keeps the `custom` /
// `openclaw.nested-tool.v1` row with content `[call, result]` (`nestedToolActivityContent`,
// src/sessions/nested-tool-activity.ts:73-87).
function nestedRun(runId: string, viewId: string): Raw[] {
  const result = { kind: "canvas", view: { id: viewId, url: doc(viewId) }, presentation: { target: "assistant_message", title: "Code", sandbox: "scripts" } };
  const callId = "tool_search_code:outer:show_widget:1";
  return [
    { role: "assistant", content: [{ type: "toolCall", id: "tool_search_code:outer", name: "tool_search_code", arguments: {} }], __openclaw: { id: `${runId}-a1`, seq: 3, runId } },
    {
      role: "custom",
      customType: "openclaw.nested-tool.v1",
      display: true,
      excludeFromContext: true,
      runId,
      timestamp: 1,
      content: [
        { type: "toolCall", id: callId, runId, name: "show_widget", arguments: {}, parentToolCallId: "tool_search_code:outer", timestamp: 1 },
        {
          runId,
          scopeId: "scope-1",
          afterEntryId: null,
          startOrder: 0,
          parentToolCallId: "tool_search_code:outer",
          toolCallId: callId,
          toolName: "show_widget",
          isError: false,
          startedAt: 1,
          timestamp: 2,
          content: [{ type: "text", text: JSON.stringify(result) }],
          type: "toolResult",
          role: "toolResult",
        },
      ],
      __openclaw: { id: `${runId}-n1`, seq: 4, runId },
    },
    { role: "assistant", content: [{ type: "text", text: "Le widget est prêt." }], stopReason: "stop", __openclaw: { id: `${runId}-a2`, seq: 5, runId } },
  ];
}

describe("a widget made in code mode, rebuilt from the transcript alone", () => {
  test("the nested show_widget row registers the view; the reply shows the widget", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const a = await newChat(t, "a");
    await read(t, a, nestedRun("run-code", "cv_code"), over("run-code"));
    expect(await registered(t, a.chatId)).toEqual(["cv_code"]);
    const [b] = await bubbles(t, a);
    expect(rendered(b!)).toEqual(["text:Le widget est prêt.", "widget:cv_code"]);
  });

  test("a nested show_widget naming a view registered to another conversation claims nothing", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const other = await newChat(t, "b");
    await read(t, other, widgetRun("run-b", "cv_taken", { proof: "show_widget" }), over("run-b"));
    const a = await newChat(t, "a");
    await read(t, a, nestedRun("run-code", "cv_taken"), over("run-code"));
    expect(await registered(t, a.chatId)).toEqual([]);
    const [b] = await bubbles(t, a);
    expect(rendered(b!)).toEqual(["text:Le widget est prêt."]);
  });
});

// Codex review 4, finding 3: a shortcode EXAMPLE inside code quoted in a block quote, naming
// a view this conversation registered earlier — a literal example (CommonMark, as upstream
// src/chat/canvas-render.ts reads it): no widget, and the SPA leaves the example as written.
describe("a quoted code example of a shortcode is never a widget", () => {
  test("a fence inside a block quote, the view already registered: no widget, the example intact", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const a = await newChat(t, "a");
    await read(t, a, widgetRun("run-w", "cv_old", { proof: "show_widget" }), over("run-w"));
    expect(await registered(t, a.chatId)).toEqual(["cv_old"]);
    const example = '> ~~~text\n> [embed ref="cv_old" /]\n> ~~~';
    await read(
      t,
      a,
      [{ role: "assistant", content: `Exemple :\n\n${example}`, stopReason: "stop", __openclaw: { id: "ex-1", seq: 20, runId: "run-ex" } }],
      over("run-ex"),
    );
    const ex = (await bubbles(t, a)).find((m) => m.runId === "run-ex")!;
    expect(ex.parts.some((p) => p.kind === "widget")).toBe(false);
    expect(rendered(ex)).toEqual([`text:Exemple :\n\n${example}`]);
  });
});

// Codex review 6: a row's widget shows on the ACTIVE bubble from the moment the row exists.
describe("a widget a row names, on the active bubble at once", () => {
  test("the show_widget result row arrives before the terminal: the live bubble shows the widget", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);
    const a = await newChat(t, "a");
    await t.mutation(internal.stream.startAssistant, { chatId: a.chatId, runId: "run-act", turnSessionKey: a.sk, boundInstanceName: "prod" } as never);
    await read(t, a, widgetRun("run-act", "cv_now", { proof: "show_widget" }), { hasActiveRun: true, activeRunIds: ["run-act"] });
    expect(await registered(t, a.chatId)).toEqual(["cv_now"]);
    const [b] = await bubbles(t, a);
    expect(b!.status).toBe("streaming");
    expect(rendered(b!)).toContain("widget:cv_now");
  });
});
