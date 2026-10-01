/// <reference types="vite/client" />
//
// Inline widgets, Convex side: the part (assistant-only, bounded, one per view), the
// reader's fetch authorization (closes the gateway's docId-only IDOR), the two switches
// and the dispatch decision they produce, and the relay's answer mapping.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { relayWidgetView, WIDGET_VIEW_DOCUMENT_HEADERS, WIDGET_VIEW_MAX_BYTES } from "./lib/widgetView";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

const VIEW = "cv_87c3b1326a2c47028d93b4c38e242832";
const OTHER_VIEW = "cv_3eca04c48b4847638952336f6b09bdc2";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function seed(t: T, opts: { kind?: "openclaw" | "hermes"; ownerRole?: "user" | "admin" } = {}) {
  return t.run(async (ctx) => {
    const mkUser = async (canonical: string, role: "user" | "admin") => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: id,
        role,
        canonical,
        name: canonical,
        email: `${canonical}@example.com`,
      });
      return id;
    };
    const owner = await mkUser("owner", opts.ownerRole ?? "user");
    const guest = await mkUser("guest", "user");
    const stranger = await mkUser("stranger", "user");
    const admin = await mkUser("admin", "admin");
    const instanceId = await ctx.db.insert("instances", {
      name: "alpha",
      gatewayUrl: "ws://gw",
      ...(opts.kind === "hermes" ? { kind: "hermes" as const } : {}),
    });
    await ctx.db.insert("agents", {
      instanceName: "alpha",
      agentId: "alice",
      displayName: "Alice",
      enabled: true,
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
    const chatId = await ctx.db.insert("chats", {
      userId: owner,
      updatedAt: 1,
      instanceName: "alpha",
      agentId: "alice",
    });
    await ctx.db.insert("chatParticipants", {
      chatId,
      userId: guest,
      role: "member",
      addedBy: owner,
      addedAt: 1,
    } as never);
    const assistant = await ctx.db.insert("messages", {
      chatId,
      userId: owner,
      role: "assistant",
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
    const user = await ctx.db.insert("messages", {
      chatId,
      userId: owner,
      role: "user",
      status: "complete" as const,
      text: "montre-moi un widget",
      updatedAt: 1,
    });
    const otherChat = await ctx.db.insert("chats", { userId: stranger, updatedAt: 1, instanceName: "alpha" });
    const foreign = await ctx.db.insert("messages", {
      chatId: otherChat,
      userId: stranger,
      role: "assistant",
      status: "complete" as const,
      text: "",
      updatedAt: 1,
    });
    return { owner, guest, stranger, admin, instanceId, chatId, assistant, user, otherChat, foreign };
  });
}

/** As the bridge sends it. `origin: "tool"` = the conversation's own show_widget
 *  result, the one carrier that registers a view. */
const widgetPart = (
  viewId = VIEW,
  extra: Record<string, unknown> = {},
  origin: "tool" | "canvas" | "shortcode" = "tool",
) => ({
  kind: "widget" as const,
  provider: "openclaw" as const,
  origin,
  viewId,
  title: "Counter",
  sandbox: "scripts" as const,
  ...extra,
});

const partsOf = (t: T, messageId: Id<"messages">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messageParts").collect())
      .filter((p) => p.messageId === messageId)
      .map((p) => p.part),
  );

describe("the widget part", () => {
  test("lands on an assistant message, once per view", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(OTHER_VIEW) });
    expect((await partsOf(t, s.assistant)).map((p) => (p as { viewId: string }).viewId)).toEqual([VIEW, OTHER_VIEW]);
  });

  test("is DROPPED on a user message", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.user, part: widgetPart() });
    expect(await partsOf(t, s.user)).toEqual([]);
  });

  test("is DROPPED when the view id is not a managed widget document", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (const bad of ["../../etc/passwd", "board-x", "cv_", "cv_a/b"]) {
      await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(bad) });
    }
    expect(await partsOf(t, s.assistant)).toEqual([]);
  });

  test("its title and height are re-bounded", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, {
      messageId: s.assistant,
      part: widgetPart(VIEW, { title: "t".repeat(500), preferredHeight: 99999 }),
    });
    const [p] = (await partsOf(t, s.assistant)) as Array<{ title: string; preferredHeight: number }>;
    expect(p!.title.length).toBe(200);
    expect(p!.preferredHeight).toBe(1200);
  });

  test("reaches the conversation view as a descriptor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    const view = await t.withIdentity({ subject: s.owner }).query(api.messages.listByChat, { chatId: s.chatId });
    const msgs = (Array.isArray(view) ? view : (view as { messages: unknown[] }).messages) as Array<{
      _id: string;
      parts: unknown[];
    }>;
    const reply = msgs.find((m) => m._id === s.assistant)!;
    // Stored as a DESCRIPTOR: the carrier is an ingest fact, not part of the part.
    const { origin: _o, ...stored } = widgetPart();
    expect(reply.parts).toEqual([stored]);
  });
});

describe("who may read a widget document (the gateway scopes nothing)", () => {
  const authorize = (t: T, who: Id<"users">, args: { chatId: string; messageId: string; viewId: string }) =>
    t.withIdentity({ subject: who }).query(internal.widgets.authorizeWidgetView, args);

  test("the owner and a participant, for a view that IS one of the message's widget parts", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    for (const who of [s.owner, s.guest]) {
      expect(await authorize(t, who, { chatId: s.chatId, messageId: s.assistant, viewId: VIEW })).toMatchObject({
        ok: true,
        instanceName: "alpha",
      });
    }
  });

  test("a reader of another chat is refused (throws -> 403)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    await expect(
      authorize(t, s.stranger, { chatId: s.chatId, messageId: s.assistant, viewId: VIEW }),
    ).rejects.toThrow();
  });

  test("a view id that is not one of THIS message's widget parts is refused — the IDOR", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    // A real document of the gateway, known to the reader, but not shown in this chat.
    await t.mutation(internal.stream.addPart, { messageId: s.foreign, part: widgetPart(OTHER_VIEW) });
    expect(
      await authorize(t, s.owner, { chatId: s.chatId, messageId: s.assistant, viewId: OTHER_VIEW }),
    ).toEqual({ ok: false, reason: "not_a_widget" });
    // Nor by naming the other chat's message under this chat.
    expect(
      await authorize(t, s.owner, { chatId: s.chatId, messageId: s.foreign, viewId: OTHER_VIEW }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  test("a per-turn routed conversation: the document is asked of the gateway that wrote the reply", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "beta", gatewayUrl: "ws://gw2" });
      await ctx.db.patch(s.chatId, { instanceName: undefined, perTurnRouting: true, lastRoutedInstanceName: "alpha" });
      await ctx.db.patch(s.assistant, { boundInstance: "beta" });
    });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    expect(await authorize(t, s.owner, { chatId: s.chatId, messageId: s.assistant, viewId: VIEW })).toMatchObject({
      ok: true,
      instanceName: "beta",
    });
  });

  test("malformed ids and a user message are refused", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    expect(await authorize(t, s.owner, { chatId: s.chatId, messageId: s.assistant, viewId: "../x" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await authorize(t, s.owner, { chatId: "nope", messageId: s.assistant, viewId: VIEW })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await authorize(t, s.owner, { chatId: s.chatId, messageId: s.user, viewId: VIEW })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("the two switches", () => {
  test("the conversation override is the owner's", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.withIdentity({ subject: s.owner }).mutation(api.widgets.setChatWidgets, { chatId: s.chatId, enabled: false });
    expect((await t.run((ctx) => ctx.db.get(s.chatId)))!.widgetsDisabled).toBe(true);
    await expect(
      t.withIdentity({ subject: s.guest }).mutation(api.widgets.setChatWidgets, { chatId: s.chatId, enabled: true }),
    ).rejects.toThrow();
    await t.withIdentity({ subject: s.owner }).mutation(api.widgets.setChatWidgets, { chatId: s.chatId, enabled: true });
    expect((await t.run((ctx) => ctx.db.get(s.chatId)))!.widgetsDisabled).toBeUndefined();
  });

  test("the instance switches are an administrator's, audited, and refused on Hermes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      t.withIdentity({ subject: s.owner }).mutation(api.widgets.setInstanceWidgets, {
        instanceId: s.instanceId,
        enabled: false,
      }),
    ).rejects.toThrow(/Forbidden/);
    await t.withIdentity({ subject: s.admin }).mutation(api.widgets.setInstanceWidgets, {
      instanceId: s.instanceId,
      enabled: false,
      promptConfirm: true,
    });
    const inst = await t.run((ctx) => ctx.db.get(s.instanceId));
    expect(inst!.config).toEqual({ widgetsEnabled: false, widgetPromptConfirm: true });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((a) => [a.action, a.resourceId])).toEqual([["instance.widgets", s.instanceId]]);
    // Back to the defaults: stored as absence.
    await t.withIdentity({ subject: s.admin }).mutation(api.widgets.setInstanceWidgets, {
      instanceId: s.instanceId,
      enabled: true,
      promptConfirm: false,
    });
    expect((await t.run((ctx) => ctx.db.get(s.instanceId)))!.config).toEqual({});

    const h = convexTest(schema, modules);
    const hs = await seed(h, { kind: "hermes" });
    await expect(
      h.withIdentity({ subject: hs.admin }).mutation(api.widgets.setInstanceWidgets, {
        instanceId: hs.instanceId,
        enabled: true,
      }),
    ).rejects.toThrow(/Hermes/);
  });

  test("what the conversation view reads", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const read = (who: Id<"users">) =>
      t.withIdentity({ subject: who }).query(api.widgets.widgetConfigForChat, { chatId: s.chatId });
    expect(await read(s.owner)).toEqual({
      provider: "openclaw",
      instanceEnabled: true,
      chatDisabled: false,
      effective: true,
      promptConfirm: false,
      canToggle: true,
    });
    expect((await read(s.guest)).canToggle).toBe(false);
    await expect(read(s.stranger)).rejects.toThrow();
  });
});

describe("the dispatch decision (last gate)", () => {
  const gateFor = async (t: T, s: Awaited<ReturnType<typeof seed>>) => {
    const { outboxId } = await t.withIdentity({ subject: s.owner }).mutation(api.send.sendMessage, {
      chatId: s.chatId,
      text: "bonjour",
      clientMessageId: `w-${Math.random()}`,
    });
    const out = await t.mutation(internal.bridge.lastGateBeforeSend, {
      outboxId,
      target: { instanceName: "alpha", agentId: "alice" },
    });
    return out.kind === "send" ? out.inlineWidgets : out.kind;
  };

  test("ON by default, OFF by the instance, OFF by the conversation, never on Hermes", async () => {
    // The scheduled dispatch must not run and consume the row before the gate is read.
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // An idle conversation: the send is dispatched now, not parked behind a reply.
    await t.run((ctx) => ctx.db.patch(s.assistant, { status: "complete" }));
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    expect(await gateFor(t, s)).toBe(true);
    await t.run((ctx) => ctx.db.patch(s.chatId, { widgetsDisabled: true }));
    await t.run(async (ctx) => {
      for (const o of await ctx.db.query("outbox").collect()) await ctx.db.delete(o._id);
    });
    expect(await gateFor(t, s)).toBe(false);
    await t.run((ctx) => ctx.db.patch(s.chatId, { widgetsDisabled: undefined }));
    await t.run((ctx) => ctx.db.patch(s.instanceId, { config: { widgetsEnabled: false } }));
    await t.run(async (ctx) => {
      for (const o of await ctx.db.query("outbox").collect()) await ctx.db.delete(o._id);
    });
    expect(await gateFor(t, s)).toBe(false);
    await t.run((ctx) => ctx.db.patch(s.instanceId, { config: {}, kind: "hermes" }));
    await t.run(async (ctx) => {
      for (const o of await ctx.db.query("outbox").collect()) await ctx.db.delete(o._id);
    });
    expect(await gateFor(t, s)).toBe(false);
  });
});

describe("the relay (GET /api/v1/widget-view)", () => {
  const ok = (body: unknown, status = 200) => async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  const base = { bridgeUrl: "http://bridge.test/", sharedSecret: "s3cret", instanceName: "alpha", viewId: VIEW };

  test("asks the instance's bridge for exactly that view, with the shared secret", async () => {
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const out = await relayWidgetView({
      ...base,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ ok: true, html: "<p>x</p>" }) };
      },
    });
    expect(out).toEqual({ ok: true, html: "<p>x</p>" });
    expect(calls[0]!.url).toBe("http://bridge.test/canvas-view");
    expect(calls[0]!.init.headers.Authorization).toBe("s3cret");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ instanceName: "alpha", viewId: VIEW });
  });

  test("maps the gateway's UNAVAILABLE to a retryable 'widget unavailable', anything else to a bridge error", async () => {
    expect(
      await relayWidgetView({ ...base, fetchImpl: ok({ ok: false, error: { code: "widget_unavailable" } }, 404) }),
    ).toEqual({ ok: false, status: 404, code: "widget_unavailable" });
    expect(await relayWidgetView({ ...base, fetchImpl: ok({ ok: false }, 502) })).toEqual({
      ok: false,
      status: 502,
      code: "bridge_error",
    });
    expect(
      await relayWidgetView({
        ...base,
        fetchImpl: async () => {
          throw new Error("down");
        },
      }),
    ).toEqual({ ok: false, status: 502, code: "bridge_error" });
    expect(await relayWidgetView({ ...base, bridgeUrl: null, fetchImpl: ok({}) })).toEqual({
      ok: false,
      status: 503,
      code: "not_configured",
    });
  });

  test("bounds the document; the response is never rendered on the Convex origin", async () => {
    const big = "x".repeat(WIDGET_VIEW_MAX_BYTES + 1);
    expect(await relayWidgetView({ ...base, fetchImpl: ok({ ok: true, html: big }) })).toEqual({
      ok: false,
      status: 502,
      code: "too_large",
    });
    expect(WIDGET_VIEW_DOCUMENT_HEADERS["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(WIDGET_VIEW_DOCUMENT_HEADERS["Content-Security-Policy"]).toMatch(/^sandbox/);
    expect(WIDGET_VIEW_DOCUMENT_HEADERS["Cache-Control"]).toBe("no-store");
  });
});

describe("the HTTP route end to end (authorization before any bridge call)", () => {
  test("a stranger gets 403 and the bridge is never asked", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true, html: "<p>x</p>" }), { status: 200 });
    });
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    const url = `/api/v1/widget-view?chatId=${s.chatId}&messageId=${s.assistant}&viewId=${VIEW}`;
    const denied = await t.withIdentity({ subject: s.stranger }).fetch(url, { method: "GET" });
    expect(denied.status).toBe(403);
    expect(calls).toEqual([]);
    const owned = await t.withIdentity({ subject: s.owner }).fetch(url, { method: "GET" });
    expect(owned.status).toBe(200);
    expect(await owned.text()).toBe("<p>x</p>");
    expect(owned.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(calls).toEqual(["http://bridge.test/canvas-view"]);
    const foreignView = await t
      .withIdentity({ subject: s.owner })
      .fetch(`/api/v1/widget-view?chatId=${s.chatId}&messageId=${s.assistant}&viewId=${OTHER_VIEW}`, { method: "GET" });
    expect(foreignView.status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});

describe("ownership: a view belongs to the conversation whose show_widget produced it", () => {
  const authorize = (t: T, who: Id<"users">, args: { chatId: string; messageId: string; viewId: string }) =>
    t.withIdentity({ subject: who }).query(internal.widgets.authorizeWidgetView, args);
  const registry = (t: T) => t.run((ctx) => ctx.db.query("widgetViews").collect());

  test("the show_widget result registers the view; the other carriers only follow it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // A shortcode or canvas part first, for a view nobody registered: not stored.
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(VIEW, {}, "shortcode") });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(VIEW, {}, "canvas") });
    expect(await partsOf(t, s.assistant)).toEqual([]);
    expect(await registry(t)).toEqual([]);
    // The authoritative result: registered to THIS conversation, part stored.
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    const rows = await registry(t);
    expect(rows.map((r) => [r.instanceName, r.viewId, r.chatId, r.source])).toEqual([["alpha", VIEW, s.chatId, "gateway"]]);
    expect(await partsOf(t, s.assistant)).toHaveLength(1);
  });

  test("a FORGED shortcode naming another conversation's document is not stored, and cannot be fetched", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // Alice's conversation produced OTHER_VIEW (the stranger's chat plays Alice here).
    await t.mutation(internal.stream.addPart, { messageId: s.foreign, part: widgetPart(OTHER_VIEW) });
    // In the owner's chat, the model writes [embed ref="OTHER_VIEW"] (or a tool prints a
    // canvas-shaped JSON the gateway projects as a canvas part).
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(OTHER_VIEW, {}, "shortcode") });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(OTHER_VIEW, {}, "canvas") });
    expect(await partsOf(t, s.assistant)).toEqual([]);
    expect(await authorize(t, s.owner, { chatId: s.chatId, messageId: s.assistant, viewId: OTHER_VIEW })).toEqual({
      ok: false,
      reason: "not_a_widget",
    });
  });

  test("first writer wins: a second conversation's own result cannot take a registered view", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.foreign, part: widgetPart(OTHER_VIEW) });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(OTHER_VIEW) });
    expect(await partsOf(t, s.assistant)).toEqual([]);
    expect((await registry(t)).map((r) => r.chatId)).toEqual([s.otherChat]);
  });

  test("an IMPORTED widget part (no registration) is refused: unavailable, never fetched", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.foreign, part: widgetPart(OTHER_VIEW) });
    // What archiveImport re-inserts: the part, verbatim — and nothing else.
    await t.run((ctx) =>
      ctx.db.insert("messageParts", {
        messageId: s.assistant,
        order: 0,
        part: { kind: "widget", provider: "openclaw", viewId: OTHER_VIEW, sandbox: "scripts" },
      }),
    );
    expect(await authorize(t, s.owner, { chatId: s.chatId, messageId: s.assistant, viewId: OTHER_VIEW })).toEqual({
      ok: false,
      reason: "not_registered",
    });
  });

  test("a fork inherits the ownership of the replies it copies", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.assistant, { status: "complete" }));
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    const { chatId: forkId } = await t
      .withIdentity({ subject: s.owner })
      .mutation(api.chatFork.forkChat, { branchMessageId: s.assistant });
    const forked = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.chatId === forkId && m.role === "assistant"),
    );
    expect(forked).toBeDefined();
    expect(await partsOf(t, forked!._id)).toHaveLength(1);
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked!._id, viewId: VIEW })).toMatchObject({ ok: true });
    expect((await registry(t)).map((r) => [r.chatId, r.source]).sort()).toEqual(
      [[s.chatId, "gateway"], [forkId, "fork"]].sort(),
    );
  });

  test("an EX-guest keeps the id but can no longer read the document", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    expect(await authorize(t, s.guest, { chatId: s.chatId, messageId: s.assistant, viewId: VIEW })).toMatchObject({ ok: true });
    await t.run(async (ctx) => {
      for (const p of await ctx.db.query("chatParticipants").collect()) await ctx.db.delete(p._id);
    });
    await expect(authorize(t, s.guest, { chatId: s.chatId, messageId: s.assistant, viewId: VIEW })).rejects.toThrow();
  });

  test("widgets OFF for the conversation at ingest: nothing is stored", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.chatId, { widgetsDisabled: true }));
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    expect(await partsOf(t, s.assistant)).toEqual([]);
    expect(await registry(t)).toEqual([]);
  });

  test("a deleted conversation takes its ownership rows with it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    await t.run((ctx) => ctx.db.patch(s.assistant, { status: "complete" }));
    const as = t.withIdentity({ subject: s.owner });
    await as.mutation(api.chats.deleteChat, { chatId: s.chatId });
    await as.mutation(api.trash.purgeChat, { chatId: s.chatId });
    expect(await registry(t)).toEqual([]);
  });
});

describe("the reader's rate limit", () => {
  test("past the per-minute budget the route answers 429 and the bridge is not asked", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true, html: "<p>x</p>" }), { status: 200 });
    });
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    await t.run(async (ctx) => {
      const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
      await ctx.db.insert("apiRateLimits", { principalId: `widget-view:${s.owner}`, windowStart, count: 60 });
    });
    const res = await t
      .withIdentity({ subject: s.owner })
      .fetch(`/api/v1/widget-view?chatId=${s.chatId}&messageId=${s.assistant}&viewId=${VIEW}`, { method: "GET" });
    expect(res.status).toBe(429);
    expect(calls).toEqual([]);
  });

  test("the bridge's concurrency refusal is a retryable 503", async () => {
    expect(
      await relayWidgetView({
        bridgeUrl: "http://b.test",
        sharedSecret: "x",
        instanceName: "alpha",
        viewId: VIEW,
        fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error: { code: "busy" } }) }),
      }),
    ).toEqual({ ok: false, status: 503, code: "busy" });
  });
});

describe("review pass 2: per-message decision, bounded reads, reported outcomes", () => {
  const authorize = (t: T, who: Id<"users">, args: { chatId: string; messageId: string; viewId: string }) =>
    t.withIdentity({ subject: who }).query(internal.widgets.authorizeWidgetView, args);
  const registry = (t: T) => t.run((ctx) => ctx.db.query("widgetViews").collect());

  test("widgets switched OFF after the part landed: the document is no longer served", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    const args = { chatId: s.chatId, messageId: s.assistant, viewId: VIEW };
    expect(await authorize(t, s.owner, args)).toMatchObject({ ok: true });
    await t.run((ctx) => ctx.db.patch(s.chatId, { widgetsDisabled: true }));
    expect(await authorize(t, s.owner, args)).toEqual({ ok: false, reason: "widgets_off" });
    await t.run((ctx) => ctx.db.patch(s.chatId, { widgetsDisabled: undefined }));
    await t.run((ctx) => ctx.db.patch(s.instanceId, { config: { widgetsEnabled: false } }));
    expect(await authorize(t, s.owner, args)).toEqual({ ok: false, reason: "widgets_off" });
  });

  test("a per-turn routed conversation decides PER MESSAGE, by the instance that wrote the reply", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const beta = await t.run(async (ctx) => {
      const id = await ctx.db.insert("instances", { name: "beta", gatewayUrl: "ws://gw2" });
      await ctx.db.patch(s.chatId, { instanceName: undefined, perTurnRouting: true, lastRoutedInstanceName: "alpha" });
      await ctx.db.patch(s.assistant, { boundInstance: "beta" });
      return id;
    });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    const perMessage = () =>
      t.withIdentity({ subject: s.owner }).query(api.widgets.widgetConfigForMessage, {
        chatId: s.chatId,
        messageId: s.assistant,
      });
    expect(await perMessage()).toEqual({ effective: true, promptConfirm: false });
    // beta (the reply's instance) turns widgets off; alpha (the last route) keeps them.
    await t.run((ctx) => ctx.db.patch(beta, { config: { widgetsEnabled: false } }));
    expect(await perMessage()).toEqual({ effective: false, promptConfirm: false });
    // The chat-level answer still reads alpha — which is why the card must not use it.
    expect(
      (await t.withIdentity({ subject: s.owner }).query(api.widgets.widgetConfigForChat, { chatId: s.chatId }))
        .effective,
    ).toBe(true);
    expect(await authorize(t, s.owner, { chatId: s.chatId, messageId: s.assistant, viewId: VIEW })).toEqual({
      ok: false,
      reason: "widgets_off",
    });
    // The confirmation setting is the reply's instance's too.
    await t.run((ctx) => ctx.db.patch(beta, { config: { widgetPromptConfirm: true } }));
    expect(await perMessage()).toEqual({ effective: true, promptConfirm: true });
    // A stranger is refused; a malformed id answers "off", never throws on shape.
    await expect(
      t.withIdentity({ subject: s.stranger }).query(api.widgets.widgetConfigForMessage, {
        chatId: s.chatId,
        messageId: s.assistant,
      }),
    ).rejects.toThrow();
    expect(
      await t.withIdentity({ subject: s.owner }).query(api.widgets.widgetConfigForMessage, {
        chatId: s.chatId,
        messageId: "nope",
      }),
    ).toEqual({ effective: false, promptConfirm: false });
  });

  test("ownership is an EXACT lookup: a view inherited by more than 64 forks still opens in the 65th", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    await t.run(async (ctx) => {
      for (let i = 0; i < 70; i++) {
        const chat = await ctx.db.insert("chats", { userId: s.stranger, updatedAt: 1, instanceName: "alpha" });
        const msg = await ctx.db.insert("messages", {
          chatId: chat,
          userId: s.stranger,
          role: "assistant",
          status: "complete" as const,
          text: "",
          updatedAt: 1,
        });
        await ctx.db.insert("widgetViews", {
          instanceName: "alpha",
          viewId: OTHER_VIEW,
          chatId: chat,
          messageId: msg,
          source: "fork",
          createdAt: 1,
        });
      }
      // The owner's conversation inherits OTHER_VIEW last (the 71st row of the view).
      await ctx.db.insert("widgetViews", {
        instanceName: "alpha",
        viewId: OTHER_VIEW,
        chatId: s.chatId,
        messageId: s.assistant,
        source: "fork",
        createdAt: 2,
      });
      await ctx.db.insert("messageParts", {
        messageId: s.assistant,
        order: 5,
        part: { kind: "widget", provider: "openclaw", viewId: OTHER_VIEW, sandbox: "scripts" },
      });
    });
    expect(await authorize(t, s.owner, { chatId: s.chatId, messageId: s.assistant, viewId: OTHER_VIEW })).toMatchObject({
      ok: true,
    });
  });

  test("a fork of the NEWEST replies of a long conversation inherits their registrations", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // 900 older registrations in the source (more than any whole-registry window).
    await t.run(async (ctx) => {
      for (let i = 0; i < 900; i++) {
        await ctx.db.insert("widgetViews", {
          instanceName: "alpha",
          viewId: `cv_old${i}`,
          chatId: s.chatId,
          messageId: s.user,
          source: "gateway",
          createdAt: 1,
        });
      }
    });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    await t.run((ctx) => ctx.db.patch(s.assistant, { status: "complete" }));
    const { chatId: forkId } = await t
      .withIdentity({ subject: s.owner })
      .mutation(api.chatFork.forkChat, { branchMessageId: s.assistant });
    const forked = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.chatId === forkId && m.role === "assistant"),
    );
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked!._id, viewId: VIEW })).toMatchObject({ ok: true });
    // Only the copied reply's view rides — not the 900 the fork does not show.
    expect((await registry(t)).filter((r) => r.chatId === forkId).map((r) => r.viewId)).toEqual([VIEW]);
  });

  test("a fork inherits a view registered by a reply it does NOT copy, when a copied reply shows it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.assistant, { status: "complete" });
      // Registered by a later reply (outside the branch), shown by the copied one.
      const later = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "",
        updatedAt: 2,
      });
      await ctx.db.insert("widgetViews", {
        instanceName: "alpha",
        viewId: VIEW,
        chatId: s.chatId,
        messageId: later,
        source: "gateway",
        createdAt: 1,
      });
    });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(VIEW, {}, "shortcode") });
    expect(await partsOf(t, s.assistant)).toHaveLength(1);
    const { chatId: forkId } = await t
      .withIdentity({ subject: s.owner })
      .mutation(api.chatFork.forkChat, { branchMessageId: s.assistant });
    const forked = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.chatId === forkId && m.role === "assistant"),
    );
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked!._id, viewId: VIEW })).toMatchObject({ ok: true });
  });

  test("addPart REPORTS the widget outcome, and a stale run registers nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.assistant, { runId: "run-now" }));
    // A stale generation's own show_widget result: refused, and no ownership claimed.
    expect(
      await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(), expectedRunId: "run-old" }),
    ).toEqual({ accepted: false, reason: "stale_generation" });
    expect(await registry(t)).toEqual([]);
    // A model-written carrier for an unregistered view.
    expect(
      await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(VIEW, {}, "shortcode") }),
    ).toEqual({ accepted: false, reason: "widget_not_registered" });
    // The current run's result lands; a repeat is the same widget.
    expect(
      await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(), expectedRunId: "run-now" }),
    ).toEqual({ accepted: true });
    expect(
      await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(), expectedRunId: "run-now" }),
    ).toEqual({ accepted: true, reason: "duplicate" });
    expect((await registry(t)).map((r) => r.chatId)).toEqual([s.chatId]);
    // On a user message, or with widgets off: refused, said so.
    expect(await t.mutation(internal.stream.addPart, { messageId: s.user, part: widgetPart(OTHER_VIEW) })).toEqual({
      accepted: false,
      reason: "widget_refused",
    });
    await t.run((ctx) => ctx.db.patch(s.chatId, { widgetsDisabled: true }));
    expect(await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart(OTHER_VIEW) })).toEqual({
      accepted: false,
      reason: "widgets_off",
    });
  });

  test("the REAL ingest route passes the widget outcome back to the bridge", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const secret = (await t
      .withIdentity({ subject: `${s.admin}|session` })
      .action(api.bridgeAuth.mintBridgeSecret, { instanceId: s.instanceId })) as { plaintext: string };
    const post = async (part: Record<string, unknown>) => {
      const res = await t.fetch("/bridge/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret.plaintext}` },
        body: JSON.stringify({ op: "addPart", messageId: s.assistant, part }),
      });
      expect(res.status).toBe(200);
      return await res.json();
    };
    expect(await post(widgetPart(VIEW, {}, "shortcode"))).toEqual({
      ok: true,
      accepted: false,
      reason: "widget_not_registered",
    });
    expect(await post(widgetPart())).toEqual({ ok: true, accepted: true });
  });
});

describe("a FORK of a per-turn routed conversation: the copy carries no instance of its own", () => {
  const authorize = (t: T, who: Id<"users">, args: { chatId: string; messageId: string; viewId: string }) =>
    t.withIdentity({ subject: who }).query(internal.widgets.authorizeWidgetView, args);
  const perMessage = (t: T, who: Id<"users">, chatId: string, messageId: string) =>
    t.withIdentity({ subject: who }).query(api.widgets.widgetConfigForMessage, { chatId, messageId });

  /** A two-instance, per-turn routed conversation whose reply was written by beta (its
   *  `boundInstance`; no `routedInstanceName`, no chat instance), forked at that reply.
   *  The fork copies the reply WITHOUT `boundInstance` (it drives ingest barriers) and
   *  inherits the view's registration — which carries beta. */
  async function forkedPerTurn(t: T) {
    const s = await seed(t);
    const beta = await t.run(async (ctx) => {
      const id = await ctx.db.insert("instances", { name: "beta", gatewayUrl: "ws://gw2" });
      await ctx.db.patch(s.chatId, { instanceName: undefined, perTurnRouting: true, lastRoutedInstanceName: "alpha" });
      await ctx.db.patch(s.assistant, { boundInstance: "beta", status: "complete" });
      return id;
    });
    await t.mutation(internal.stream.addPart, { messageId: s.assistant, part: widgetPart() });
    const { chatId: forkId } = await t
      .withIdentity({ subject: s.owner })
      .mutation(api.chatFork.forkChat, { branchMessageId: s.assistant });
    const { forked, forkChat, rows } = await t.run(async (ctx) => ({
      forked: (await ctx.db.query("messages").collect()).find((m) => m.chatId === forkId && m.role === "assistant")!,
      forkChat: (await ctx.db.get(forkId))!,
      rows: await ctx.db.query("widgetViews").collect(),
    }));
    // The premise, stated: nothing on the copy or its conversation names an instance,
    // and two instances exist — `widgetInstanceFor` alone resolves none. The fork's
    // own registry row is the one carrier of the instance.
    expect(forked.boundInstance).toBeUndefined();
    expect(forked.routedInstanceName).toBeUndefined();
    expect(forkChat.instanceName).toBeUndefined();
    expect(forkChat.lastRoutedInstanceName).toBeUndefined();
    expect(rows.map((r) => [r.chatId, r.instanceName, r.viewId, r.source]).sort()).toEqual(
      [
        [s.chatId, "beta", VIEW, "gateway"],
        [forkId, "beta", VIEW, "fork"],
      ].sort(),
    );
    return { s, beta, forkId, forked };
  }

  test("the fork's own registry row supplies the instance: the widget opens, on beta", async () => {
    const t = convexTest(schema, modules);
    const { s, forkId, forked } = await forkedPerTurn(t);
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked._id, viewId: VIEW })).toMatchObject({
      ok: true,
      instanceName: "beta",
    });
    expect(await perMessage(t, s.owner, forkId, forked._id)).toEqual({ effective: true, promptConfirm: false });
  });

  test("the fallback answers with the row's instance switches (beta off -> off)", async () => {
    const t = convexTest(schema, modules);
    const { s, beta, forkId, forked } = await forkedPerTurn(t);
    await t.run((ctx) => ctx.db.patch(beta, { config: { widgetsEnabled: false } }));
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked._id, viewId: VIEW })).toEqual({
      ok: false,
      reason: "widgets_off",
    });
    expect(await perMessage(t, s.owner, forkId, forked._id)).toEqual({ effective: false, promptConfirm: false });
  });

  test("NO row in the requesting conversation (only the parent's): still unavailable", async () => {
    const t = convexTest(schema, modules);
    const { s, forkId, forked } = await forkedPerTurn(t);
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("widgetViews").collect()) {
        if (r.chatId === forkId) await ctx.db.delete(r._id);
      }
    });
    // The parent still holds beta's row for exactly this view: never borrowed.
    expect((await t.run((ctx) => ctx.db.query("widgetViews").collect())).map((r) => r.chatId)).toEqual([s.chatId]);
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked._id, viewId: VIEW })).toEqual({
      ok: false,
      reason: "not_openclaw",
    });
    expect(await perMessage(t, s.owner, forkId, forked._id)).toEqual({ effective: false, promptConfirm: false });
  });

  test("a row for ANOTHER view of the same conversation is not this view's instance", async () => {
    const t = convexTest(schema, modules);
    const { s, forkId } = await forkedPerTurn(t);
    // A second unnamed reply in the fork shows OTHER_VIEW, which the fork never
    // registered (the fork's only row is VIEW's, on beta).
    const other = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId: forkId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "",
        updatedAt: 3,
      });
      await ctx.db.insert("messageParts", {
        messageId: id,
        order: 0,
        part: { kind: "widget", provider: "openclaw", viewId: OTHER_VIEW, sandbox: "scripts" },
      });
      return id;
    });
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: other, viewId: OTHER_VIEW })).toEqual({
      ok: false,
      reason: "not_openclaw",
    });
    expect(await perMessage(t, s.owner, forkId, other)).toEqual({ effective: false, promptConfirm: false });
  });

  test("a message whose instance IS resolvable keeps it, whatever the row says", async () => {
    const t = convexTest(schema, modules);
    const { s, forkId, forked } = await forkedPerTurn(t);
    // The copy now names alpha (resolvable); the fork's row says beta.
    await t.run(async (ctx) => {
      await ctx.db.patch(forked._id, { routedInstanceName: "alpha" });
      await ctx.db.patch(s.instanceId, { config: { widgetsEnabled: false } });
    });
    // Decided by alpha: off for the card; and alpha never registered the view here.
    expect(await perMessage(t, s.owner, forkId, forked._id)).toEqual({ effective: false, promptConfirm: false });
    await t.run((ctx) => ctx.db.patch(s.instanceId, { config: {} }));
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked._id, viewId: VIEW })).toEqual({
      ok: false,
      reason: "not_registered",
    });
  });

  test("a message that NAMES an instance which no longer exists is not rescued by the row", async () => {
    const t = convexTest(schema, modules);
    const { s, forkId, forked } = await forkedPerTurn(t);
    await t.run((ctx) => ctx.db.patch(forked._id, { routedInstanceName: "gamma" }));
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked._id, viewId: VIEW })).toEqual({
      ok: false,
      reason: "not_openclaw",
    });
    expect(await perMessage(t, s.owner, forkId, forked._id)).toEqual({ effective: false, promptConfirm: false });
  });

  test("rows of the conversation naming TWO instances for the view: ambiguous, refused", async () => {
    const t = convexTest(schema, modules);
    const { s, forkId, forked } = await forkedPerTurn(t);
    await t.run((ctx) =>
      ctx.db.insert("widgetViews", {
        instanceName: "alpha",
        viewId: VIEW,
        chatId: forkId,
        messageId: forked._id,
        source: "fork",
        createdAt: 4,
      }),
    );
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked._id, viewId: VIEW })).toEqual({
      ok: false,
      reason: "not_openclaw",
    });
    expect(await perMessage(t, s.owner, forkId, forked._id)).toEqual({ effective: false, promptConfirm: false });
  });

  test("the row is read by (conversation, view): many instances change nothing", async () => {
    const t = convexTest(schema, modules);
    const { s, forkId, forked } = await forkedPerTurn(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) await ctx.db.insert("instances", { name: `extra${i}`, gatewayUrl: "ws://x" });
    });
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked._id, viewId: VIEW })).toMatchObject({
      ok: true,
      instanceName: "beta",
    });
  });

  test("a row naming an instance that no longer exists answers nothing", async () => {
    const t = convexTest(schema, modules);
    const { s, beta, forkId, forked } = await forkedPerTurn(t);
    // Two instances remain, so the single-instance rule cannot answer either.
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "gamma", gatewayUrl: "ws://gw3" });
      await ctx.db.delete(beta);
    });
    expect(await authorize(t, s.owner, { chatId: forkId, messageId: forked._id, viewId: VIEW })).toEqual({
      ok: false,
      reason: "not_openclaw",
    });
  });

  test("a FORK OF A FORK inherits the registration, and the widget opens there too", async () => {
    const t = convexTest(schema, modules);
    const { s, forkId, forked } = await forkedPerTurn(t);
    // F1's copy names no instance; F2 is forked from it.
    const { chatId: fork2Id } = await t
      .withIdentity({ subject: s.owner })
      .mutation(api.chatFork.forkChat, { branchMessageId: forked._id });
    const { forked2, rows } = await t.run(async (ctx) => ({
      forked2: (await ctx.db.query("messages").collect()).find((m) => m.chatId === fork2Id && m.role === "assistant")!,
      rows: await ctx.db.query("widgetViews").collect(),
    }));
    expect(forked2.boundInstance).toBeUndefined();
    expect(rows.filter((r) => r.chatId === fork2Id).map((r) => [r.instanceName, r.viewId, r.source])).toEqual([
      ["beta", VIEW, "fork"],
    ]);
    expect(await authorize(t, s.owner, { chatId: fork2Id, messageId: forked2._id, viewId: VIEW })).toMatchObject({
      ok: true,
      instanceName: "beta",
    });
    expect(await perMessage(t, s.owner, fork2Id, forked2._id)).toEqual({ effective: true, promptConfirm: false });
  });

  test("a stranger is still refused by the fork, before any fallback", async () => {
    const t = convexTest(schema, modules);
    const { s, forkId, forked } = await forkedPerTurn(t);
    await expect(authorize(t, s.stranger, { chatId: forkId, messageId: forked._id, viewId: VIEW })).rejects.toThrow();
    await expect(perMessage(t, s.stranger, forkId, forked._id)).rejects.toThrow();
  });
});
