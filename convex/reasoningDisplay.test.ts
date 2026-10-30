/// <reference types="vite/client" />
//
// SHOWING THE MODEL'S REASONING (0.103.0) — the Convex links of the chain:
//   - the decision: the conversation's choice, else its agent's exception (shown or
//     hidden), else its instance's default, else no (lib/reasoningDisplay.ts), and what the
//     bridge is told (`reasoningLevel`); both defaults are read, never copied: a change
//     holds at once;
//   - storage: a row's reasoning, a Hermes reasoning part, are KEPT ONLY while the
//     conversation shows reasoning — nothing is stored otherwise;
//   - the bubble: a row's reasoning is MARKED in its row and read from the row, one at a
//     time, when the reader opens it (`getRowReasoning`) — never in the bubble's text nor in
//     the window (codex pass 1: a window of them read past 16 MiB); a work note row is marked;
//   - a message's own reasoning parts (Hermes) are bounded at write, and say when cut;
//   - the live work note: upserted by its item, anchored in the narrative;
//   - the exclusions: the archive, a fork, a feedback report, the metadata API, the view
//     of a conversation that does not show reasoning.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { composeBubble, layoutKey } from "./lib/bubbleProjection";
import { buildOpenClawThreadId } from "./lib/openclawThread";
import { bridgeSessionSettings, MESSAGE_THINKING_BYTES, reasoningLevelToApply, sessionDigest } from "./lib/reasoningDisplay";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
// A projection apply plus a view is several transactions: room under a loaded suite.
vi.setConfig({ testTimeout: 30_000 });

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
const RUN = "webchat-run-1";
const REASONING = "**Plan**\n\nLire la date puis répondre.";

async function seed(t: T, opts: { agentDefault?: boolean; instanceDefault?: boolean; chatChoice?: boolean } = {}) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", {
      name: "prod",
      gatewayUrl: "ws://gw",
      config: { transcriptProjection: "on" } as never,
      ...(opts.instanceDefault !== undefined ? { showReasoningDefault: opts.instanceDefault } : {}),
    });
    await ctx.db.insert("agents", {
      instanceName: "prod",
      agentId: "alice",
      source: "discovered",
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
      enabled: true,
      ...(opts.agentDefault !== undefined ? { showReasoningDefault: opts.agentDefault } : {}),
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "alice",
      ...(opts.chatChoice !== undefined ? { sessionSettings: { showReasoning: opts.chatChoice } } : {}),
    });
    return { userId, chatId };
  });
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}

type Row = Record<string, unknown>;
const row = (entryId: string, seq: number, extra: Row = {}): Row => ({
  entryId,
  seq,
  role: "assistant",
  runId: RUN,
  hidden: false,
  visible: true,
  ...extra,
});

/** A turn: the model thinks and calls a tool (no text), says a work note, then answers. */
function turnRows(): Row[] {
  return [
    row("r2", 2, { visible: true, thinking: REASONING, blocks: [{ type: "tool", toolCallId: "t1", name: "exec", status: "call" }] }),
    row("r3", 3, { role: "toolresult", blocks: [{ type: "tool", toolCallId: "t1", name: "exec", status: "result" }] }),
    row("r4:segment:abc", 4, { streamSegment: true, commentary: true, text: "Je lance la commande.", blocks: [{ type: "text", text: "Je lance la commande." }] }),
    row("r5", 5, { text: "Nous sommes lundi.", stopReason: "stop", blocks: [{ type: "text", text: "Nous sommes lundi." }] }),
  ];
}

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

const settle = (t: T, chatId: Id<"chats">) =>
  apply(t, chatId, turnRows(), { terminals: [{ runId: RUN, status: "completed", at: Date.now() }], hasActiveRun: false });

const storedThinking = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query("transcriptRowReasoning").collect()).map((d) => d.text));

async function view(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }) {
  const all = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as Array<{
    _id: Id<"messages">;
    role: string;
    text: string;
    rowLayout?: Array<{ entryId: string; thinking?: boolean; commentary?: boolean }>;
    parts: Array<{ kind: string; nature?: string; text?: string }>;
  }>;
  return all.filter((m) => m.role === "assistant");
}

const rowReasoning = (t: T, ids: { userId: Id<"users"> }, messageId: Id<"messages">, entryId: string) =>
  t.withIdentity({ subject: ids.userId }).query(api.messages.getRowReasoning, { messageId, entryId });

describe("the decision (lib/reasoningDisplay.ts)", () => {
  test("what the bridge is told: on when shown; off only when chosen or the session shows it", () => {
    expect(reasoningLevelToApply(true, {})).toBe("on");
    expect(reasoningLevelToApply(false, {})).toBeUndefined();
    expect(reasoningLevelToApply(false, { sessionSettings: { showReasoning: false } })).toBe("off");
    expect(reasoningLevelToApply(false, { sessionMeta: { reasoningLevel: "on" } as never })).toBe("off");
    expect(reasoningLevelToApply(false, { sessionMeta: { reasoningLevel: "off" } as never })).toBeUndefined();
    // A meta that may describe another session proves nothing about this one.
    expect(reasoningLevelToApply(false, { sessionMeta: { reasoningLevel: "off" } as never }, false)).toBe("off");
    expect(reasoningLevelToApply(false, {}, false)).toBe("off");
    expect(reasoningLevelToApply(true, {}, false)).toBe("on");
    // Atrium's own choice never reaches the gateway; the level does.
    expect(bridgeSessionSettings({ showReasoning: true, thinkingLevel: "high" }, "on")).toEqual({ thinkingLevel: "high", reasoningLevel: "on" });
    expect(bridgeSessionSettings({ showReasoning: false }, undefined)).toBeNull();
  });

  test("the per-turn routing carries it: the agent's default, the conversation's choice over it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { agentDefault: true });
    const routing = async () =>
      (await t.query(internal.bridge.getChatRouting, { chatId: ids.chatId, userId: ids.userId } as never)) as { sessionSettings: Row | null };
    expect((await routing()).sessionSettings).toEqual({ reasoningLevel: "on" });
    await t.withIdentity({ subject: ids.userId }).mutation(api.chats.setSessionKnob, { chatId: ids.chatId, showReasoning: false });
    expect((await routing()).sessionSettings).toEqual({ reasoningLevel: "off" });
    // Back to the agent's default (`null`): nothing to unset on the gateway.
    await t.withIdentity({ subject: ids.userId }).mutation(api.chats.setSessionKnob, { chatId: ids.chatId, showReasoning: null });
    expect(await t.run(async (ctx) => (await ctx.db.get(ids.chatId))?.sessionSettings)).toEqual({});
    expect((await routing()).sessionSettings).toEqual({ reasoningLevel: "on" });
  });

  // Codex passes 6 and 7: the conversation keeps ONE meta while its turns can go to several
  // sessions (a refused attempt to B, a rebind A→B). The meta skips the `off` patch only
  // for the session it names; a meta naming another session, or none, proves nothing.
  test("the off patch is skipped only on a meta that names the target session", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { agentDefault: false });
    const named = async (agentId: string, instanceName = "prod") =>
      sessionDigest(instanceName, buildOpenClawThreadId({ agentId, canonical: "u", chatId: ids.chatId })!);
    const meta = async (describedSession?: string) =>
      t.run(async (ctx) => {
        await ctx.db.patch(ids.chatId, {
          sessionMeta: { reasoningLevel: "off", ...(describedSession !== undefined ? { describedSession } : {}), updatedAt: 1 } as never,
        });
      });
    // Nothing described yet (a new conversation): unknown, so off.
    expect(await routingOf(t, ids)).toEqual({ reasoningLevel: "off" });
    await meta();
    expect(await routingOf(t, ids)).toEqual({ reasoningLevel: "off" });
    // Its own session described off: nothing to patch.
    await meta(await named("alice"));
    expect(await routingOf(t, ids)).toBeNull();
    // Another agent's session (B's describe), or the same key on another instance.
    await meta(await named("bob"));
    expect(await routingOf(t, ids)).toEqual({ reasoningLevel: "off" });
    await meta(await named("alice", "other"));
    expect(await routingOf(t, ids)).toEqual({ reasoningLevel: "off" });
    // Per-turn routing to alice: the same rule, on the routed session.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.chatId, { perTurnRouting: true, lastRoutedInstanceName: "prod", lastRoutedAgentId: "alice" });
    });
    await meta(await named("bob"));
    expect(await routingOf(t, ids)).toEqual({ reasoningLevel: "off" });
    await meta(await named("alice"));
    expect(await routingOf(t, ids)).toBeNull();
  });

  test("a describe names its session by a digest, never by the key", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const key = buildOpenClawThreadId({ agentId: "alice", canonical: "u", chatId: ids.chatId })!;
    await t.mutation(internal.stream.setSessionMeta, {
      chatId: ids.chatId,
      boundInstanceName: "prod",
      meta: { reasoningLevel: "off", describedSessionKey: key, observedAt: 10 },
    });
    const stored = await t.run(async (ctx) => (await ctx.db.get(ids.chatId))?.sessionMeta);
    expect(stored?.describedSession).toBe(await sessionDigest("prod", key));
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(await routingOf(t, ids)).toBeNull();
    // A later describe that names no session drops the provenance with the knobs.
    await t.mutation(internal.stream.setSessionMeta, {
      chatId: ids.chatId,
      boundInstanceName: "prod",
      meta: { reasoningLevel: "off", observedAt: 20 },
    });
    expect((await t.run(async (ctx) => (await ctx.db.get(ids.chatId))?.sessionMeta))?.describedSession).toBeUndefined();
  });

  test("the agent's default is an admin setting, audited", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await expect(
      t.withIdentity({ subject: ids.userId }).mutation(api.agents.setAgentReasoningDefault, { instanceName: "prod", agentId: "alice", show: true }),
    ).rejects.toThrow(/admin/i);
    expect(await t.run(async (ctx) => (await ctx.db.query("agents").first())?.showReasoningDefault ?? null)).toBeNull();
    const admin = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "admin" as const, canonical: "admin" });
      return userId;
    });
    await t.withIdentity({ subject: admin }).mutation(api.agents.setAgentReasoningDefault, { instanceName: "prod", agentId: "alice", show: true });
    expect(await t.run(async (ctx) => (await ctx.db.query("agents").first())?.showReasoningDefault)).toBe(true);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((a) => a.action)).toContain("agent.reasoning_default.show");
    const meta = (await t.withIdentity({ subject: ids.userId }).query(api.messages.getSessionMeta, { chatId: ids.chatId })) as {
      showReasoning: boolean;
      showReasoningDefault: boolean;
    };
    expect(meta).toMatchObject({ showReasoning: true, showReasoningDefault: true });
  });
});

type Meta = { showReasoning: boolean; showReasoningDefault: boolean; showReasoningDefaultSource: string };
const meta = (t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }) =>
  t.withIdentity({ subject: ids.userId }).query(api.messages.getSessionMeta, { chatId: ids.chatId }) as Promise<Meta>;
const routingOf = async (t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }) =>
  ((await t.query(internal.bridge.getChatRouting, { chatId: ids.chatId, userId: ids.userId } as never)) as { sessionSettings: Row | null })
    .sessionSettings;
async function adminOf(t: T): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "admin" as const, canonical: "admin" });
    return userId;
  });
}

describe("the instance's default and the agents' exceptions (lib/reasoningDisplay.ts)", () => {
  // Every level, first answer wins: conversation > agent exception (true or false) >
  // instance default > hidden. Each case is read by the meta (what the knob says), by the
  // bridge routing (what the session is told) and by the storage (what is kept).
  const cases: Array<{
    name: string;
    opts: { agentDefault?: boolean; instanceDefault?: boolean; chatChoice?: boolean };
    shows: boolean;
    inherited: boolean;
    source: "agent" | "instance" | "none";
  }> = [
    { name: "nothing set: hidden", opts: {}, shows: false, inherited: false, source: "none" },
    { name: "the instance shows", opts: { instanceDefault: true }, shows: true, inherited: true, source: "instance" },
    { name: "the instance hides, explicitly", opts: { instanceDefault: false }, shows: false, inherited: false, source: "instance" },
    { name: "an exception shown over an instance that hides", opts: { instanceDefault: false, agentDefault: true }, shows: true, inherited: true, source: "agent" },
    { name: "an exception hidden over an instance that shows", opts: { instanceDefault: true, agentDefault: false }, shows: false, inherited: false, source: "agent" },
    { name: "an exception hidden with no instance default", opts: { agentDefault: false }, shows: false, inherited: false, source: "agent" },
    { name: "the conversation shows over a hidden exception", opts: { instanceDefault: false, agentDefault: false, chatChoice: true }, shows: true, inherited: false, source: "agent" },
    { name: "the conversation hides over a shown exception and instance", opts: { instanceDefault: true, agentDefault: true, chatChoice: false }, shows: false, inherited: true, source: "agent" },
    { name: "the conversation hides over the instance", opts: { instanceDefault: true, chatChoice: false }, shows: false, inherited: true, source: "instance" },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const t = convexTest(schema, modules);
      const ids = await seed(t, c.opts);
      expect(await meta(t, ids)).toMatchObject({ showReasoning: c.shows, showReasoningDefault: c.inherited, showReasoningDefaultSource: c.source });
      const level = (await routingOf(t, ids))?.reasoningLevel;
      // No session described here: its state is unknown, so a hidden decision is sent.
      expect(level).toBe(c.shows ? "on" : "off");
      await settle(t, ids.chatId);
      expect(await storedThinking(t)).toEqual(c.shows ? [REASONING] : []);
    });
  }

  test("a hidden exception on a session the gateway shows: the bridge is told off", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { instanceDefault: true, agentDefault: false });
    await t.run((ctx) => ctx.db.patch(ids.chatId, { sessionMeta: { reasoningLevel: "on" } as never }));
    expect((await routingOf(t, ids))?.reasoningLevel).toBe("off");
  });

  test("an agent without a row has no exception: its instance decides", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { instanceDefault: true });
    await t.run((ctx) => ctx.db.patch(ids.chatId, { agentId: "ghost" }));
    expect(await meta(t, ids)).toMatchObject({ showReasoning: true, showReasoningDefaultSource: "instance" });
  });

  test("an unknown instance decides nothing: hidden", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { instanceDefault: true });
    await t.run((ctx) => ctx.db.patch(ids.chatId, { instanceName: "elsewhere" }));
    expect(await meta(t, ids)).toMatchObject({ showReasoning: false, showReasoningDefault: false, showReasoningDefaultSource: "none" });
  });

  test("a Hermes reasoning part follows the instance's default too", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { instanceDefault: true });
    const m = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: "h-run", boundInstanceName: "prod" } as never)) as Id<"messages">;
    await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "reasoning", nature: "thinking", text: "raisonnement" }, boundInstanceName: "prod" } as never);
    const kept = await t.run(async (ctx) => (await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", m)).collect()).length);
    expect(kept).toBe(1);
  });

  // Codex pass 4: a routed Hermes reply can complete BEFORE confirmTurnRouting moves the
  // conversation to its agent. Its reasoning is judged by the agent the turn was SENT to (its
  // outbox row), never by the previous turn's agent — in both directions.
  for (const dir of [
    { name: "previous shows, recipient hides: dropped", previous: "alice", recipient: "bob", kept: 0 },
    { name: "previous hides, recipient shows: kept", previous: "bob", recipient: "alice", kept: 1 },
  ]) {
    test(`a routed Hermes reply before the routing is confirmed — ${dir.name}`, async () => {
      const t = convexTest(schema, modules);
      const ids = await seed(t, { agentDefault: true });
      await t.run(async (ctx) => {
        await ctx.db.insert("agents", {
          instanceName: "prod",
          agentId: "bob",
          source: "discovered",
          presentInLastOk: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
          enabled: true,
          showReasoningDefault: false,
        });
        await ctx.db.patch(ids.chatId, { perTurnRouting: true, lastRoutedInstanceName: "prod", lastRoutedAgentId: dir.previous });
      });
      const outboxId = await t.run((ctx) =>
        ctx.db.insert("outbox", {
          chatId: ids.chatId,
          userId: ids.userId,
          text: "bonjour",
          status: "pending" as const,
          clientMessageId: "cm-routed",
          attachmentIds: [],
          routedAgent: { instanceName: "prod", agentId: dir.recipient },
        }),
      );
      const m = (await t.mutation(internal.stream.startAssistant, {
        chatId: ids.chatId,
        runId: "h-run",
        boundInstanceName: "prod",
        dispatchOutboxId: String(outboxId),
      } as never)) as Id<"messages">;
      await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "reasoning", nature: "thinking", text: "raisonnement" }, boundInstanceName: "prod" } as never);
      const kept = await t.run(async (ctx) => (await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", m)).collect()).length);
      expect(kept).toBe(dir.kept);
    });
  }

  test("an unrouted reply of a per-turn conversation is its primary's (the thread's attribution rule)", async () => {
    const t = convexTest(schema, modules);
    // alice (the primary) shows; the last routed agent, bob, hides.
    const ids = await seed(t, { agentDefault: true });
    await t.run(async (ctx) => {
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "bob",
        source: "discovered",
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
        enabled: true,
        showReasoningDefault: false,
      });
      await ctx.db.patch(ids.chatId, { perTurnRouting: true, lastRoutedInstanceName: "prod", lastRoutedAgentId: "bob" });
    });
    const outboxId = await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId: ids.chatId,
        userId: ids.userId,
        text: "bonjour",
        status: "pending" as const,
        clientMessageId: "cm-unrouted",
        attachmentIds: [],
      }),
    );
    const m = (await t.mutation(internal.stream.startAssistant, {
      chatId: ids.chatId,
      runId: "h-run",
      boundInstanceName: "prod",
      dispatchOutboxId: String(outboxId),
    } as never)) as Id<"messages">;
    await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "reasoning", nature: "thinking", text: "raisonnement" }, boundInstanceName: "prod" } as never);
    const kept = await t.run(async (ctx) => (await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", m)).collect()).length);
    expect(kept).toBe(1);
  });

  test("a changed instance default holds AT ONCE: the meta, the routing, the storage, the view", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const admin = await adminOf(t);
    expect(await meta(t, ids)).toMatchObject({ showReasoning: false, showReasoningDefaultSource: "none" });
    await t.withIdentity({ subject: admin }).mutation(api.agents.setInstanceReasoningDefault, { instanceName: "prod", show: true });
    expect(await meta(t, ids)).toMatchObject({ showReasoning: true, showReasoningDefault: true, showReasoningDefaultSource: "instance" });
    expect((await routingOf(t, ids))?.reasoningLevel).toBe("on");
    await settle(t, ids.chatId);
    expect(await storedThinking(t)).toEqual([REASONING]);
    const [bubble] = await view(t, ids);
    expect(bubble!.rowLayout!.find((r) => r.entryId === "r2")?.thinking).toBe(true);
    expect(await rowReasoning(t, ids, bubble!._id, "r2")).toEqual({ text: REASONING });
    // Hidden again: the view drops the mark and the read returns nothing, at once.
    await t.withIdentity({ subject: admin }).mutation(api.agents.setInstanceReasoningDefault, { instanceName: "prod", show: false });
    expect(await meta(t, ids)).toMatchObject({ showReasoning: false, showReasoningDefault: false, showReasoningDefaultSource: "instance" });
    const [after] = await view(t, ids);
    expect(after!.rowLayout!.some((r) => r.thinking === true)).toBe(false);
    expect(await rowReasoning(t, ids, after!._id, "r2")).toBeNull();
    // A session the gateway still shows is told off at the next turn.
    await t.run((ctx) => ctx.db.patch(ids.chatId, { sessionMeta: { reasoningLevel: "on" } as never }));
    expect((await routingOf(t, ids))?.reasoningLevel).toBe("off");
  });

  test("an exception wins over a later instance default, and `null` hands the agent back to it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const admin = await adminOf(t);
    const as = t.withIdentity({ subject: admin });
    await as.mutation(api.agents.setAgentReasoningDefault, { instanceName: "prod", agentId: "alice", show: false });
    await as.mutation(api.agents.setInstanceReasoningDefault, { instanceName: "prod", show: true });
    expect(await meta(t, ids)).toMatchObject({ showReasoning: false, showReasoningDefaultSource: "agent" });
    await as.mutation(api.agents.setAgentReasoningDefault, { instanceName: "prod", agentId: "alice", show: null });
    const stored = await t.run(async (ctx) => (await ctx.db.query("agents").first())!);
    expect("showReasoningDefault" in stored).toBe(false);
    expect(await meta(t, ids)).toMatchObject({ showReasoning: true, showReasoningDefaultSource: "instance" });
    const audit = (await t.run((ctx) => ctx.db.query("auditLog").collect())).map((a) => [a.action, a.resource]);
    expect(audit).toEqual([
      ["agent.reasoning_default.hide", "agent"],
      ["instance.reasoning_default.show", "instance"],
      ["agent.reasoning_default.inherit", "agent"],
    ]);
  });

  test("the card's query: the instance's default and each agent's exception (null when none)", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { instanceDefault: true, agentDefault: false });
    const admin = await adminOf(t);
    await t.run((ctx) =>
      ctx.db.insert("agents", { instanceName: "prod", agentId: "bob", source: "discovered", presentInLastOk: true, firstSeenAt: 1, lastSeenAt: 1, enabled: true }),
    );
    const list = (await t.withIdentity({ subject: admin }).query(api.agents.listAgentsForInstance, { instanceName: "prod" })) as {
      showReasoningDefault: boolean;
      agents: Array<{ agentId: string; showReasoningDefault: boolean | null }>;
    };
    expect(list.showReasoningDefault).toBe(true);
    expect(Object.fromEntries(list.agents.map((a) => [a.agentId, a.showReasoningDefault]))).toEqual({ alice: false, bob: null });
  });

  test("both settings are admin-only; unknown instance or agent is refused, nothing written", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const user = t.withIdentity({ subject: ids.userId });
    await expect(user.mutation(api.agents.setInstanceReasoningDefault, { instanceName: "prod", show: true })).rejects.toThrow(/admin/i);
    await expect(user.mutation(api.agents.setAgentReasoningDefault, { instanceName: "prod", agentId: "alice", show: null })).rejects.toThrow(/admin/i);
    const as = t.withIdentity({ subject: await adminOf(t) });
    await expect(as.mutation(api.agents.setInstanceReasoningDefault, { instanceName: "nope", show: true })).rejects.toThrow("Not found: instance");
    await expect(as.mutation(api.agents.setAgentReasoningDefault, { instanceName: "nope", agentId: "alice", show: true })).rejects.toThrow("Not found: instance");
    await expect(as.mutation(api.agents.setAgentReasoningDefault, { instanceName: "prod", agentId: "nobody", show: true })).rejects.toThrow("Not found: agent");
    const state = await t.run(async (ctx) => ({
      instance: (await ctx.db.query("instances").first())?.showReasoningDefault ?? null,
      agent: (await ctx.db.query("agents").first())?.showReasoningDefault ?? null,
      audit: (await ctx.db.query("auditLog").collect()).length,
    }));
    expect(state).toEqual({ instance: null, agent: null, audit: 0 });
  });
});

describe("a row's reasoning is stored ONLY while the conversation shows it", () => {
  test("hidden (the default): nothing of it is stored", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await settle(t, ids.chatId);
    expect(await storedThinking(t)).toEqual([]);
    const [bubble] = await view(t, ids);
    expect(bubble!.rowLayout!.some((r) => r.thinking === true)).toBe(false);
    expect(bubble!.parts.filter((p) => p.kind === "reasoning")).toEqual([]);
  });

  test("the conversation's choice over the agent's default — both ways", async () => {
    const shown = convexTest(schema, modules);
    const a = await seed(shown, { agentDefault: false, chatChoice: true });
    await settle(shown, a.chatId);
    expect(await storedThinking(shown)).toEqual([REASONING]);
    const hidden = convexTest(schema, modules);
    const b = await seed(hidden, { agentDefault: true, chatChoice: false });
    await settle(hidden, b.chatId);
    expect(await storedThinking(hidden)).toEqual([]);
  });

  test("shown: the row is marked, its reasoning read from the row — never in the bubble's text nor the window", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { agentDefault: true });
    await settle(t, ids.chatId);
    const [bubble] = await view(t, ids);
    expect(bubble!.text).not.toContain("Lire la date");
    const r2 = bubble!.rowLayout!.find((r) => r.entryId === "r2");
    expect(r2?.thinking).toBe(true);
    // Codex pass 1 (finding 1): no part carries it, the window reads none of it.
    expect(bubble!.parts.filter((p) => p.kind === "reasoning")).toEqual([]);
    expect(JSON.stringify(await view(t, ids))).not.toContain("Lire la date");
    expect(await rowReasoning(t, ids, bubble!._id, "r2")).toEqual({ text: REASONING });
    // A row that is not this bubble's, or carries none, reads nothing.
    expect(await rowReasoning(t, ids, bubble!._id, "r5")).toBeNull();
    expect(await rowReasoning(t, ids, bubble!._id, "nope")).toBeNull();
    // …and another bubble of the same session never reads this bubble's rows.
    const other = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId: ids.chatId, userId: ids.userId, role: "assistant", status: "complete", text: "Autre.", runId: "other-run", turnSessionKey: SK, updatedAt: 2 } as never),
    );
    expect(await rowReasoning(t, ids, other as Id<"messages">, "r2")).toBeNull();
    // The work note row is marked; its text stays the agent's words.
    expect(bubble!.rowLayout!.find((r) => r.entryId === "r4:segment:abc")?.commentary).toBe(true);
    expect(bubble!.text).toContain("Je lance la commande.");
  });

  // Codex pass 9: a 0.102.1 frontend (a rollback) reads the parts as they are served; a note
  // its row already shows must not be served a second time.
  test("a work note its row already shows is not served; one without its row is", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await settle(t, ids.chatId);
    const [settled] = await view(t, ids);
    await t.run(async (ctx) => {
      for (const [order, itemKey] of [[100, "abc"], [101, "zzz"]] as const) {
        await ctx.db.insert("messageParts", {
          messageId: settled!._id,
          order,
          part: { kind: "reasoning", nature: "commentary", itemKey, text: `Note ${itemKey}.`, textOffset: 0 },
        } as never);
      }
    });
    const [after] = await view(t, ids);
    expect(after!.parts.filter((p) => p.kind === "reasoning").map((p) => p.text)).toEqual(["Note zzz."]);
    // Still stored: only the view leaves it out.
    expect(await t.run(async (ctx) => (await ctx.db.query("messageParts").collect()).filter((d) => d.part.kind === "reasoning").length)).toBe(2);
  });

  test("turned off afterwards: what was kept is no longer shown — no mark, nothing read", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { agentDefault: true });
    await settle(t, ids.chatId);
    await t.withIdentity({ subject: ids.userId }).mutation(api.chats.setSessionKnob, { chatId: ids.chatId, showReasoning: false });
    const [bubble] = await view(t, ids);
    expect(bubble!.parts.filter((p) => p.kind === "reasoning")).toEqual([]);
    expect(bubble!.rowLayout!.some((r) => r.thinking === true)).toBe(false);
    expect(await rowReasoning(t, ids, bubble!._id, "r2")).toBeNull();
  });

  test("a row the view marks is a row the read returns: one decision, the view's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { agentDefault: true });
    await settle(t, ids.chatId);
    // The bubble names another agent (one that does not show reasoning): the view decides by
    // the conversation (its current agent), and so does the read.
    const [before] = await view(t, ids);
    await t.run((ctx) => ctx.db.patch(before!._id, { routedInstanceName: "prod", routedAgentId: "carol" } as never));
    const [bubble] = await view(t, ids);
    expect(bubble!.rowLayout!.find((r) => r.entryId === "r2")?.thinking).toBe(true);
    expect(await rowReasoning(t, ids, bubble!._id, "r2")).toEqual({ text: REASONING });
  });

  test("turned on afterwards: the next read stores it and marks the row — its text unchanged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await settle(t, ids.chatId);
    const [before] = await view(t, ids);
    expect(before!.rowLayout!.some((r) => r.thinking === true)).toBe(false);
    await t.withIdentity({ subject: ids.userId }).mutation(api.chats.setSessionKnob, { chatId: ids.chatId, showReasoning: true });
    // A later text post of the settled run (transcript-shadow.ts `postTexts`, which projects
    // only the runs whose rows it stored): the text is the same, the reasoning is new.
    await apply(t, ids.chatId, turnRows(), { kind: "live", textsOnly: true });
    const [after] = await view(t, ids);
    expect(after!.rowLayout!.find((r) => r.entryId === "r2")?.thinking).toBe(true);
    expect(await rowReasoning(t, ids, after!._id, "r2")).toEqual({ text: REASONING });
  });

  test("codex pass 2: the reasoning lives apart from the row's text, and goes with it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { agentDefault: true });
    await settle(t, ids.chatId);
    // Never in the text documents every reader of texts loads.
    const texts = await t.run(async (ctx) => (await ctx.db.query("transcriptRowTexts").collect()).map((d) => JSON.stringify(d)));
    expect(texts.join("")).not.toContain("Lire la date");
    expect(await storedThinking(t)).toEqual([REASONING]);
    // A deleted bubble's rows lose it, with the mark that names it.
    const [bubble] = await view(t, ids);
    await t.run((ctx) => ctx.db.delete(bubble!._id));
    await t.mutation(internal.transcriptProjection.purgeDeletedBubbleTexts, { chatId: ids.chatId, messageId: bubble!._id });
    expect(await storedThinking(t)).toEqual([]);
    const marks = await t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).filter((r) => r.thinkingSig !== undefined).length);
    expect(marks).toBe(0);
  });

  test("codex pass 2: the chat's text purge takes the rows' reasoning too, and keeps it from coming back", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { agentDefault: true });
    await settle(t, ids.chatId);
    await t.mutation(internal.transcriptProjection.purgeChatRowTexts, { chatId: ids.chatId, markPurged: true });
    expect(await storedThinking(t)).toEqual([]);
    await settle(t, ids.chatId);
    expect(await storedThinking(t)).toEqual([]);
  });

  test("codex pass 1 (finding 3): a corrected reasoning, same answer and structure, is the one read", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { agentDefault: true });
    await settle(t, ids.chatId);
    const corrected = turnRows().map((r) => (r.entryId === "r2" ? { ...r, thinking: "CORRECTED THOUGHT" } : r));
    await apply(t, ids.chatId, corrected, { terminals: [{ runId: RUN, status: "completed", at: Date.now() }], hasActiveRun: false });
    const [bubble] = await view(t, ids);
    expect(await rowReasoning(t, ids, bubble!._id, "r2")).toEqual({ text: "CORRECTED THOUGHT" });
  });

  test("codex pass 1 (finding 2): a reasoning past the window's field cap is read whole", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { agentDefault: true });
    const long = "Réflexion longue. ".repeat(500);
    const rows = turnRows().map((r) => (r.entryId === "r2" ? { ...r, thinking: long } : r));
    await apply(t, ids.chatId, rows, { terminals: [{ runId: RUN, status: "completed", at: Date.now() }], hasActiveRun: false });
    const [bubble] = await view(t, ids);
    expect(new TextEncoder().encode(long).length).toBeGreaterThan(8192);
    expect(bubble!.rowLayout!.find((r) => r.entryId === "r2")?.thinking).toBe(true);
    expect(await rowReasoning(t, ids, bubble!._id, "r2")).toEqual({ text: long });
  });
});

describe("composeBubble: a row that only reasoned is still a row; the flags travel", () => {
  test("thinking-only row, work note row, and an unchanged key for a layout from before", () => {
    const { text, layout } = composeBubble([
      { entryId: "a", seq: 1, role: "assistant", runId: "R", hidden: false, visible: false, thinking: true },
      { entryId: "b", seq: 2, role: "assistant", runId: "R", hidden: false, visible: true, text: "Note.", commentary: true },
      { entryId: "c", seq: 3, role: "assistant", runId: "R", hidden: false, visible: true, text: "Réponse." },
    ]);
    expect(text).toBe("Note.\n\nRéponse.");
    expect(layout.map((r) => [r.entryId, r.thinking ?? false, r.commentary ?? false])).toEqual([
      ["a", true, false],
      ["b", false, true],
      ["c", false, false],
    ]);
    // A hidden row's reasoning is never shown.
    expect(composeBubble([{ entryId: "h", seq: 1, role: "assistant", runId: "R", hidden: true, visible: false, thinking: true }]).layout).toEqual([]);
    // A layout without the new flags keeps the key it had (no rewrite of past bubbles).
    const plain = [{ entryId: "c", start: 0, end: 8 }];
    expect(layoutKey(plain)).toBe(JSON.stringify([["c", 0, 8, [], [], false, [], [], null]]));
  });
});

describe("Hermes' reasoning part and the live work note (stream.addPart)", () => {
  async function bubble(t: T, ids: { chatId: Id<"chats"> }) {
    return (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: "h-run", boundInstanceName: "prod" } as never)) as Id<"messages">;
  }
  const parts = (t: T, m: Id<"messages">) =>
    t.run(async (ctx) => (await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", m)).collect()).map((p) => p.part));

  test("a thinking part is dropped for a conversation that hides reasoning, kept for one that shows it", async () => {
    const hidden = convexTest(schema, modules);
    const a = await seed(hidden);
    const m1 = await bubble(hidden, a);
    await hidden.mutation(internal.stream.addPart, { messageId: m1, part: { kind: "reasoning", nature: "thinking", text: "secret" }, boundInstanceName: "prod" } as never);
    expect(await parts(hidden, m1)).toEqual([]);
    const shown = convexTest(schema, modules);
    const b = await seed(shown, { chatChoice: true });
    const m2 = await bubble(shown, b);
    await shown.mutation(internal.stream.addPart, { messageId: m2, part: { kind: "reasoning", nature: "thinking", text: "raisonnement" }, boundInstanceName: "prod" } as never);
    expect(await parts(shown, m2)).toEqual([{ kind: "reasoning", nature: "thinking", text: "raisonnement" }]);
  });

  test("a kept thinking part leaves the view once the conversation stops showing reasoning", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { chatChoice: true });
    const m = await bubble(t, ids);
    await t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "reasoning", nature: "thinking", text: "raisonnement" }, boundInstanceName: "prod" } as never);
    const shownParts = async () => ((await view(t, ids)).find((b) => b._id === m)?.parts ?? []).filter((p) => p.kind === "reasoning");
    expect(await shownParts()).toEqual([expect.objectContaining({ nature: "thinking", text: "raisonnement" })]);
    await t.withIdentity({ subject: ids.userId }).mutation(api.chats.setSessionKnob, { chatId: ids.chatId, showReasoning: false });
    expect(await shownParts()).toEqual([]);
    // Still stored: shown again once the conversation shows reasoning again.
    expect(await parts(t, m)).toHaveLength(1);
  });

  test("a work note is always kept, and upserted by its item — never stacked", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await bubble(t, ids);
    const note = (text: string, textOffset: number) =>
      t.mutation(internal.stream.addPart, {
        messageId: m,
        part: { kind: "reasoning", nature: "commentary", itemKey: "k1", text, textOffset },
        boundInstanceName: "prod",
      } as never);
    await note("Je lance.", 0);
    await note("Je lance la commande.", 12);
    expect(await parts(t, m)).toEqual([{ kind: "reasoning", nature: "commentary", itemKey: "k1", text: "Je lance la commande.", textOffset: 0 }]);
  });

  test("codex pass 1: a message's reasoning is bounded — the rest cut, and the part says so", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, { chatChoice: true });
    const m = await bubble(t, ids);
    const add = (itemKey: string, text: string) =>
      t.mutation(internal.stream.addPart, { messageId: m, part: { kind: "reasoning", nature: "thinking", itemKey, text }, boundInstanceName: "prod" } as never);
    const tenK = "a".repeat(10 * 1024);
    await add("r1", tenK);
    // Its own update never counts against itself.
    await add("r1", tenK + "b");
    await add("r2", tenK);
    const stored = (await parts(t, m)) as Array<{ itemKey: string; text: string; textCapped?: true }>;
    expect(stored.map((p) => [p.itemKey, p.text.length, p.textCapped ?? false])).toEqual([
      ["r1", 10 * 1024 + 1, false],
      ["r2", MESSAGE_THINKING_BYTES - (10 * 1024 + 1), true],
    ]);
    // The view shows a message's reasoning part whole (never elided, past the 8 KiB field
    // cap), with its mark; a block with no budget left still says it was cut.
    await add("r3", "x");
    const [shown] = await view(t, ids);
    const byKey = (k: string) => shown!.parts.find((p) => (p as { itemKey?: string }).itemKey === k) as { text?: string; textCapped?: true } | undefined;
    expect(byKey("r1")?.text).toBe(tenK + "b");
    expect(byKey("r2")).toMatchObject({ textCapped: true });
    expect(byKey("r3")).toMatchObject({ text: "", textCapped: true });
    // A later, shorter text of a cut block is whole again: the mark is the text's own.
    await add("r2", "court");
    expect(((await parts(t, m)) as Array<{ textCapped?: true }>)[1]!.textCapped).toBeUndefined();
  });
});

describe("the exclusions: the reasoning never leaves", () => {
  /** A bubble whose rows carry a reasoning, plus a reasoning part of its own (Hermes'). */
  async function shownBubble(t: T) {
    const ids = await seed(t, { agentDefault: true });
    await settle(t, ids.chatId);
    const [b] = await view(t, ids);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", { messageId: b!._id, order: 99, part: { kind: "reasoning", nature: "thinking", text: "Lire la date (part)." } });
    });
    return { ids, messageId: b!._id };
  }

  test("the metadata API states presence, nature and length — never the text", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await shownBubble(t);
    const state = JSON.stringify(await t.query(internal.messages.chatStateInternal, { chatId: ids.chatId as string }));
    expect(state).not.toContain("Lire la date");
    expect(state).toContain('"nature":"thinking"');
  });

  test("the archive does not carry it — the work note's row text travels as the bubble's text", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await shownBubble(t);
    const section = await t.withIdentity({ subject: ids.userId }).query(api.archiveExport.exportChatSection, { chatId: ids.chatId, section: "messageParts" });
    const json = JSON.stringify(section.rows);
    expect(json).not.toContain("Lire la date");
    // …nor the marks of its rows' reasoning.
    const messages = await t.withIdentity({ subject: ids.userId }).query(api.archiveExport.exportChatSection, { chatId: ids.chatId, section: "messages" });
    const layouts = (messages.rows as Array<{ rowLayout?: Array<{ thinking?: boolean }> }>).flatMap((r) => r.rowLayout ?? []);
    expect(layouts.length).toBeGreaterThan(0);
    expect(layouts.some((r) => r.thinking === true)).toBe(false);
    // …while the bubble's other parts still travel (the tool card), so the filter is not
    // an empty section.
    expect(json).toContain('"toolCallId":"t1"');
  });

  test("a fork does not carry it", async () => {
    const t = convexTest(schema, modules);
    const { ids, messageId } = await shownBubble(t);
    const fork = (await t.withIdentity({ subject: ids.userId }).mutation(api.chatFork.forkChat, { branchMessageId: messageId } as never)) as
      | Id<"chats">
      | { chatId: Id<"chats"> };
    const forkId = typeof fork === "string" ? fork : fork.chatId;
    const forkParts = await t.run(async (ctx) => {
      const msgs = await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", forkId)).collect();
      const out = [];
      for (const msg of msgs) out.push(...(await ctx.db.query("messageParts").withIndex("by_message", (q) => q.eq("messageId", msg._id)).collect()));
      return out.map((p) => p.part.kind);
    });
    expect(forkParts).not.toContain("reasoning");
    const forkLayouts = await t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", forkId)).collect()).flatMap((msg) => msg.rowLayout ?? []),
    );
    expect(forkLayouts.length).toBeGreaterThan(0);
    expect(forkLayouts.some((r) => r.thinking === true)).toBe(false);
  });

  test("a feedback report keeps its presence and length only", async () => {
    const t = convexTest(schema, modules);
    const { ids, messageId } = await shownBubble(t);
    await t.withIdentity({ subject: ids.userId }).mutation(api.feedback.submitFeedback, { chatId: ids.chatId, messageId, category: "incorrect" } as never);
    const report = await t.run((ctx) => ctx.db.query("feedback").first());
    const partsJson = (report as { snapshot?: { partsJson?: string } } | null)?.snapshot?.partsJson ?? "";
    expect(partsJson).toContain('"textLength"');
    expect(partsJson).not.toContain("Lire la date");
  });
});
