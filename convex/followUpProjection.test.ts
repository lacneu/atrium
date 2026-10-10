/// <reference types="vite/client" />
//
// SEND LIKE THE CONTROL UI — the Convex half (transcript redesign phase 3).
//
// Every rule is asserted ON (`transcriptProjection: "on"`) AND OFF (`"shadow"`, the
// legacy path), so the legacy path is pinned unchanged next to each new behaviour:
//   - a busy conversation parks only an explicit `queue` send; steer / interrupt / the
//     gateway's own mode dispatch NOW;
//   - a running sub-agent no longer holds a send; the queue drains without the 2.5 s
//     pause; a pending send is never re-parked;
//   - the ACK is custody (the user bubble says `accepted`), transcript facts move it;
//   - I4: no automatic re-send of an input the gateway held, and only pre-admission
//     refusals re-run at all;
//   - a projected terminal with nothing visible leaves no bubble; a steer cuts a run's
//     bubble; a distinct late final joins it; the boot sweep asks before closing.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { isChatBusy, QUEUE_DRAIN_DELAY_MS } from "./lib/outboxQueue";
import {
  custodyOf,
  busySendParks,
  projectionModeOfChat,
  storedFollowUpMode,
} from "./lib/followUp";
import { curationSessionNonce, summarizeSessionNonce } from "./lib/rehydration";
import {
  GATEWAY_HOLDS_INPUT_REASON,
  PRE_ADMISSION_KINDS,
  RETRYABLE_KINDS,
} from "./turnRetry";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Mode = "on" | "shadow" | "off";

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  vi.useRealTimers();
});

const SK = "agent:main:atrium:chat:u:c1";

async function seed(t: T, mode: Mode) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const profileId = await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u",
    });
    await ctx.db.insert("userAgents", {
      userId,
      instanceName: "prod",
      agentId: "main",
      isDefault: true,
      source: "manual" as const,
      createdAt: 1,
    });
    await ctx.db.insert("instances", {
      name: "prod",
      gatewayUrl: "ws://gw",
      config: { transcriptProjection: mode } as never,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    return { userId, chatId, profileId };
  });
}

const outboxOf = (t: T, userId: Id<"users">, clientMessageId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("outbox")
      .withIndex("by_client_message", (q) =>
        q.eq("userId", userId).eq("clientMessageId", clientMessageId),
      )
      .unique(),
  );

const streamingAssistant = (t: T, chatId: Id<"chats">, userId: Id<"users">, extra = {}) =>
  t.run(async (ctx) => {
    const id = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId: "runA",
      turnSessionKey: SK,
      updatedAt: Date.now(),
      ...extra,
    });
    await ctx.db.insert("streamingText", {
      messageId: id,
      chatId,
      userId,
      generation: "runA",
      text: "so far",
      updatedAt: Date.now(),
    });
    return id;
  });

describe("lib/followUp — the pure rules", () => {
  test("only an explicit `queue` parks a busy send; only steer/interrupt are stored", () => {
    expect(busySendParks("queue")).toBe(true);
    for (const c of ["steer", "interrupt", undefined] as const) expect(busySendParks(c)).toBe(false);
    expect(storedFollowUpMode("queue")).toBeUndefined();
    expect(storedFollowUpMode(undefined)).toBeUndefined();
    expect(storedFollowUpMode("steer")).toBe("steer");
    expect(storedFollowUpMode("interrupt")).toBe("interrupt");
  });

  test("custody precedence: stopped > transcript row > gateway queue > ACK", () => {
    expect(custodyOf({ acked: true, row: null, queuedAtGateway: false })).toBe("accepted");
    expect(custodyOf({ acked: false, row: null, queuedAtGateway: false })).toBeUndefined();
    expect(custodyOf({ acked: true, row: null, queuedAtGateway: true })).toBe("queued");
    expect(custodyOf({ acked: true, row: {}, queuedAtGateway: true })).toBe("persisted");
    expect(custodyOf({ acked: true, row: { steerTargetRunId: "r" }, queuedAtGateway: false })).toBe(
      "steered",
    );
    expect(
      custodyOf({ acked: true, row: {}, queuedAtGateway: false, pendingState: "cancelled" }),
    ).toBe("cancelled");
    expect(
      custodyOf({ acked: true, row: {}, queuedAtGateway: false, pendingState: "interrupted" }),
    ).toBe("interrupted");
    expect(custodyOf({ acked: true, row: null, queuedAtGateway: true, receiptCancelled: true })).toBe(
      "cancelled",
    );
  });

  test("I4 classes: pre-admission refusals only, a subset of the legacy retryable set", () => {
    expect([...PRE_ADMISSION_KINDS].sort()).toEqual(
      ["session_archived", "session_gone", "session_init_conflict"].sort(),
    );
    for (const k of PRE_ADMISSION_KINDS) expect(RETRYABLE_KINDS.has(k)).toBe(true);
    expect(PRE_ADMISSION_KINDS.has("empty_response_silent")).toBe(false);
    expect(PRE_ADMISSION_KINDS.has("provider_internal")).toBe(false);
  });
});

describe("sendMessage while the agent works", () => {
  for (const [mode, choice, expected] of [
    ["on", undefined, "pending"],
    ["on", "steer", "pending"],
    ["on", "interrupt", "pending"],
    ["on", "queue", "queued"],
    ["shadow", undefined, "queued"],
    ["shadow", "steer", "queued"],
    ["off", "interrupt", "queued"],
  ] as const) {
    test(`${mode} + ${choice ?? "gateway mode"} → ${expected}`, async () => {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seed(t, mode);
      await streamingAssistant(t, chatId, userId);
      const asUser = t.withIdentity({ subject: `${userId}|session` });
      await asUser.mutation(api.send.sendMessage, {
        chatId,
        text: "B",
        clientMessageId: "b",
        ...(choice ? { followUpMode: choice } : {}),
      });
      const row = await outboxOf(t, userId, "b");
      expect(row?.status).toBe(expected);
      const stored = mode === "on" && (choice === "steer" || choice === "interrupt") ? choice : undefined;
      expect(row?.followUpMode).toBe(stored);
    });
  }

  test("on: the person's `queue` preference parks; an explicit steer overrides it", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, profileId } = await seed(t, "on");
    await t.run((ctx) => ctx.db.patch(profileId, { followUpMode: "queue" }));
    await streamingAssistant(t, chatId, userId);
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    await asUser.mutation(api.send.sendMessage, { chatId, text: "B", clientMessageId: "b" });
    await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "C",
      clientMessageId: "c",
      followUpMode: "steer",
    });
    expect((await outboxOf(t, userId, "b"))?.status).toBe("queued");
    expect((await outboxOf(t, userId, "c"))?.status).toBe("pending");
  });

  test("on: an idle conversation sends with no mode (none applies)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "A",
      clientMessageId: "a",
      followUpMode: "steer",
    });
    const row = await outboxOf(t, userId, "a");
    expect(row?.status).toBe("pending");
    expect(row?.followUpMode).toBeUndefined();
  });
});

test("a Hermes instance is never projected, whatever its switch says", async () => {
  const t = convexTest(schema, modules);
  const { userId, chatId } = await seed(t, "on");
  await t.run(async (ctx) => {
    const inst = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first();
    await ctx.db.patch(inst!._id, { kind: "hermes" });
  });
  await streamingAssistant(t, chatId, userId);
  const asUser = t.withIdentity({ subject: `${userId}|session` });
  await asUser.mutation(api.send.sendMessage, { chatId, text: "B", clientMessageId: "b", followUpMode: "steer" });
  expect((await outboxOf(t, userId, "b"))?.status).toBe("queued");
});

describe("busy, drain, re-park", () => {
  for (const [mode, busy] of [["on", false], ["shadow", true]] as const) {
    test(`${mode}: a running sub-agent ${busy ? "holds" : "does not hold"} the conversation`, async () => {
      const t = convexTest(schema, modules);
      const { chatId } = await seed(t, mode);
      await t.run((ctx) =>
        ctx.db.insert("subAgents", {
          chatId,
          childSessionKey: "agent:main:subagent:x",
          status: "running",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(busy);
    });
  }

  for (const [mode, delay] of [["on", 0], ["shadow", QUEUE_DRAIN_DELAY_MS]] as const) {
    test(`${mode}: the drained send is dispatched after ${delay} ms`, async () => {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seed(t, mode);
      await t.run((ctx) =>
        ctx.db.insert("outbox", {
          chatId,
          userId,
          clientMessageId: "q",
          text: "q",
          attachmentIds: [],
          status: "queued",
        }),
      );
      const before = Date.now();
      await t.mutation(internal.bridge.drainAfterCallRefusal, { chatId });
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      const dispatch = scheduled.find((s) => s.name.includes("dispatch"));
      expect(dispatch).toBeDefined();
      const wait = dispatch!.scheduledTime - before;
      if (delay === 0) expect(wait).toBeLessThan(500);
      else expect(wait).toBeGreaterThanOrEqual(delay - 50);
    });
  }

  for (const [mode, reparked] of [["on", false], ["shadow", true]] as const) {
    test(`${mode}: a pending send in a busy conversation is ${reparked ? "re-parked" : "never re-parked"}`, async () => {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seed(t, mode);
      await streamingAssistant(t, chatId, userId);
      const outboxId = await t.run((ctx) =>
        ctx.db.insert("outbox", {
          chatId,
          userId,
          clientMessageId: "p",
          text: "p",
          attachmentIds: [],
          status: "pending",
        }),
      );
      expect(await t.mutation(internal.bridge.reparkIfBusy, { outboxId })).toBe(reparked);
    });
  }
});

describe("custody on the user bubble", () => {
  async function sentRow(t: T, mode: Mode) {
    const { userId, chatId } = await seed(t, mode);
    const { messageId, outboxId } = await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "B",
        sendId: "sendB",
        updatedAt: 1,
      });
      const outboxId = await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "b",
        messageId,
        text: "B",
        attachmentIds: [],
        status: "pending",
        sendId: "sendB",
      });
      return { messageId, outboxId };
    });
    return { userId, chatId, messageId, outboxId };
  }

  for (const mode of ["on", "shadow"] as const) {
    test(`${mode}: the ACK ${mode === "on" ? "marks" : "does not mark"} the input accepted`, async () => {
      const t = convexTest(schema, modules);
      const { messageId, outboxId } = await sentRow(t, mode);
      await t.mutation(internal.bridge.markOutbox, { outboxId, status: "sent" });
      const m = await t.run((ctx) => ctx.db.get(messageId));
      expect(m?.custody).toBe(mode === "on" ? "accepted" : undefined);
    });
  }

  const applyRows = (
    t: T,
    chatId: Id<"chats">,
    rows: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) =>
    t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "page",
      rows: rows as never,
      terminals: [],
      unidentified: 0,
      ...extra,
    });

  test("on: a steered row → steered; a later delta without the row keeps it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await sentRow(t, "on");
    await applyRows(t, chatId, [
      { entryId: "u2", seq: 2, role: "user", runId: "sendB", sendId: "sendB", steerTargetRunId: "runA", hidden: false, visible: true },
    ]);
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.custody).toBe("steered");
    await applyRows(t, chatId, [], { kind: "delta", deltaCursor: "c2", inputRunIds: ["sendB"], inputReceipts: [{ runId: "sendB", state: "consumed" }] });
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.custody).toBe("steered");
  });

  test("on: the gateway's queue flag → queued; a cancelled item → cancelled", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await sentRow(t, "on");
    await applyRows(t, chatId, [], {
      inputRunIds: ["sendB"],
      pendingInputs: { total: 1, items: [{ runId: "sendB", state: "queued", queued: true }] },
    });
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.custody).toBe("queued");
    await applyRows(t, chatId, [], {
      kind: "delta",
      deltaCursor: "c3",
      readAt: Date.now() + 10,
      inputRunIds: ["sendB"],
      pendingInputs: { total: 1, items: [{ runId: "sendB", state: "cancelled" }] },
    });
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.custody).toBe("cancelled");
  });

  test("shadow: the same facts change no bubble (measure only)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await sentRow(t, "shadow");
    await applyRows(t, chatId, [
      { entryId: "u2", seq: 2, role: "user", runId: "sendB", sendId: "sendB", steerTargetRunId: "runA", hidden: false, visible: true },
    ]);
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.custody).toBeUndefined();
  });
});

describe("I4 — never re-send an input the gateway held", () => {
  async function erroredTurn(
    t: T,
    mode: Mode,
    errorKind: string,
    held: "none" | "receipt" | "pending" | "heldAt" | "row",
  ) {
    const { userId, chatId } = await seed(t, mode);
    const ids = await t.run(async (ctx) => {
      const userMsgId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "q",
        sendId: "sendA",
        updatedAt: 1,
      });
      const outboxId = await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "a",
        messageId: userMsgId,
        text: "q",
        attachmentIds: [],
        status: "sent",
        sendId: "sendA",
      });
      const assistantId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "sendA",
        dispatchOutboxId: String(outboxId),
        updatedAt: 2,
      });
      if (held === "receipt" || held === "pending" || held === "heldAt") {
        await ctx.db.insert("transcriptInputs", {
          chatId,
          sessionKey: SK,
          sendId: "sendA",
          ...(held === "receipt" ? { receipt: "consumed" as const } : {}),
          ...(held === "pending" ? { pendingState: "queued" as const } : {}),
          ...(held === "heldAt" ? { heldAt: 5 } : {}),
          updatedAt: 1,
        });
      }
      if (held === "row") {
        await ctx.db.insert("transcriptRows", {
          chatId,
          instanceName: "prod",
          sessionKey: SK,
          sessionId: "s",
          entryId: "u1",
          seq: 1,
          role: "user",
          runId: "sendA",
          sendId: "sendA",
          hidden: false,
          visible: true,
          updatedAt: 1,
        });
      }
      return { assistantId };
    });
    await t.mutation(internal.stream.finalize, {
      messageId: ids.assistantId,
      status: "error",
      error: "x",
      errorKind,
    });
    return t.run((ctx) => ctx.db.get(ids.assistantId));
  }

  test("on: a pre-admission refusal of an input the gateway never held re-runs once", async () => {
    const t = convexTest(schema, modules);
    const m = await erroredTurn(t, "on", "session_init_conflict", "none");
    expect(m?.autoRetry).toBeDefined();
  });

  for (const held of ["receipt", "pending", "heldAt", "row"] as const) {
    test(`on: held by the gateway (${held}) → no retry, stood down and said so`, async () => {
      const t = convexTest(schema, modules);
      const m = await erroredTurn(t, "on", "session_init_conflict", held);
      expect(m?.autoRetry).toBeUndefined();
      expect(m?.autoRetryOutcome).toMatchObject({
        outcome: "stood_down",
        reason: GATEWAY_HOLDS_INPUT_REASON,
      });
    });
  }

  for (const kind of ["empty_response_silent", "provider_internal", "context_length_compacted"]) {
    test(`on: ${kind} (after admission) never re-runs`, async () => {
      const t = convexTest(schema, modules);
      const m = await erroredTurn(t, "on", kind, "none");
      expect(m?.autoRetry).toBeUndefined();
    });
  }

  test("shadow: the legacy retry is unchanged (empty_response_silent re-runs)", async () => {
    const t = convexTest(schema, modules);
    const m = await erroredTurn(t, "shadow", "empty_response_silent", "none");
    expect(m?.autoRetry).toBeDefined();
  });

  test("PROPERTY: over random custody facts, a retry is scheduled iff the gateway held nothing", async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const kinds = ["none", "receipt", "pending", "heldAt", "row"] as const;
    for (let i = 0; i < 12; i++) {
      const held = kinds[Math.floor(rnd() * kinds.length)]!;
      const kind = [...PRE_ADMISSION_KINDS][Math.floor(rnd() * PRE_ADMISSION_KINDS.size)]!;
      const t = convexTest(schema, modules);
      const m = await erroredTurn(t, "on", kind, held);
      expect(m?.autoRetry !== undefined, `${kind} held=${held}`).toBe(held === "none");
    }
  });
});

describe("the bubble writes of the projected path", () => {
  test("finalize dropIfEmpty: nothing visible → no bubble; a part → kept", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const empty = await streamingAssistant(t, chatId, userId);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", empty)).first();
      await ctx.db.patch(row!._id, { text: "" });
    });
    await t.mutation(internal.stream.finalize, {
      messageId: empty,
      status: "complete",
      text: "",
      dropIfEmpty: true,
    });
    expect(await t.run((ctx) => ctx.db.get(empty))).toBeNull();
    const withPart = await streamingAssistant(t, chatId, userId);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", withPart)).first();
      await ctx.db.patch(row!._id, { text: "" });
      await ctx.db.insert("messageParts", {
        messageId: withPart,
        order: 0,
        part: { kind: "tool", name: "exec", phase: "completed" } as never,
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId: withPart,
      status: "complete",
      text: "",
      dropIfEmpty: true,
    });
    expect((await t.run((ctx) => ctx.db.get(withPart)))?.status).toBe("complete");
  });

  test("finalize WITHOUT dropIfEmpty keeps an empty bubble (legacy)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "shadow");
    const id = await streamingAssistant(t, chatId, userId);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", id)).first();
      await ctx.db.patch(row!._id, { text: "" });
    });
    await t.mutation(internal.stream.finalize, { messageId: id, status: "complete", text: "" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("complete");
  });

  test("splitSegment: segment 1 settles with its text, segment 2 streams after the steered message", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const a = await streamingAssistant(t, chatId, userId);
    const userB = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "B",
        orderTime: Date.now() + 60_000,
        updatedAt: 1,
      }),
    );
    const next = await t.mutation(internal.stream.splitSegment, { messageId: a, afterMessageId: userB });
    expect(next).not.toBeNull();
    const [m1, m2, u] = await t.run(async (ctx) => [
      await ctx.db.get(a),
      await ctx.db.get(next!),
      await ctx.db.get(userB),
    ]);
    expect(m1).toMatchObject({ status: "complete", text: "so far", finalizeCause: "steer_segment" });
    expect(m2).toMatchObject({ status: "streaming", runId: "runA", runSegment: 1 });
    expect(m2!.orderTime!).toBeGreaterThan(u!.orderTime!);
    // A REPEAT of the split (its answer lost after the commit) cuts nothing new: it hands
    // back the segment the first one opened, while that one streams (codex pass 4)…
    expect(await t.mutation(internal.stream.splitSegment, { messageId: a, afterMessageId: userB })).toBe(next);
    const segments = await t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", "runA")).collect(),
    );
    expect(segments).toHaveLength(2);
    // …and nothing once that segment has settled too.
    await t.mutation(internal.stream.finalize, { messageId: next!, status: "complete", text: "rest" });
    expect(await t.mutation(internal.stream.splitSegment, { messageId: a })).toBeNull();
  });

  test("splitSegment with the segment's text: that text settles it, whatever was streamed (codex pass 5)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const a = await streamingAssistant(t, chatId, userId);
    // A delta that committed but whose answer was lost, then re-sent: the stream doubled.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", a)).first();
      await ctx.db.patch(row!._id, { text: "Before.Before." });
    });
    const next = await t.mutation(internal.stream.splitSegment, { messageId: a, text: "Before." });
    expect(next).not.toBeNull();
    expect((await t.run((ctx) => ctx.db.get(a)))?.text).toBe("Before.");
    // A lost answer, retried: the same segment back, the text untouched.
    expect(await t.mutation(internal.stream.splitSegment, { messageId: a, text: "Before." })).toBe(next);
    expect((await t.run((ctx) => ctx.db.get(a)))?.text).toBe("Before.");
  });

  test("a steer during a delivery merged into the parent's bubble keeps the parent's reply (codex pass 6)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    // The delivery reopened the parent bubble: the parent's reply is parked, the stream
    // row was seeded with it, then the delivery streamed behind it.
    const a = await streamingAssistant(t, chatId, userId, {
      announcePrefix: "Parent answer.",
      runId: "announce:v1:child:run",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", a)).first();
      await ctx.db.patch(row!._id, { text: "Parent answer.\n\nDelivery part.", generation: "announce:v1:child:run" });
    });
    // With the bridge's authoritative text (the delivery's own segment)…
    const next = await t.mutation(internal.stream.splitSegment, { messageId: a, text: "Delivery part." });
    expect(next).not.toBeNull();
    const m1 = await t.run((ctx) => ctx.db.get(a));
    expect(m1?.text).toBe("Parent answer.\n\nDelivery part.");
    expect(m1?.announcePrefix).toBeUndefined();
    // …and without it (older bridge): the streamed row already carries the prefix.
    const b = await streamingAssistant(t, chatId, userId, {
      announcePrefix: "Parent B.",
      runId: "announce:v1:child:run2",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", b)).first();
      await ctx.db.patch(row!._id, { text: "Delivery only.", generation: "announce:v1:child:run2" });
    });
    await t.mutation(internal.stream.splitSegment, { messageId: b });
    expect((await t.run((ctx) => ctx.db.get(b)))?.text).toBe("Parent B.\n\nDelivery only.");
  });

  test("a lost cut answer after the 50th cut still hands back the successor (codex pass 6)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    let current = await streamingAssistant(t, chatId, userId);
    let previous = current;
    for (let i = 0; i < 55; i++) {
      const next = await t.mutation(internal.stream.splitSegment, { messageId: current, text: `s${i}` });
      expect(next).not.toBeNull();
      previous = current;
      current = next!;
    }
    // The answer of the 55th cut was lost: its repeat must name the segment it opened.
    expect(await t.mutation(internal.stream.splitSegment, { messageId: previous, text: "s54" })).toBe(current);
  });

  test("appendLateFinal: joins once (idempotent); opens a bubble when the run left none", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const id = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "widget",
        runId: "runB",
        updatedAt: 1,
      }),
    );
    const args = { chatId, runId: "runB", messageId: id, text: "fallback", boundInstanceName: "prod" };
    await t.mutation(internal.stream.appendLateFinal, args);
    await t.mutation(internal.stream.appendLateFinal, args);
    expect((await t.run((ctx) => ctx.db.get(id)))?.text).toBe("widget\n\nfallback");
    const created = await t.mutation(internal.stream.appendLateFinal, {
      chatId,
      runId: "runC",
      text: "only text",
      boundInstanceName: "prod",
    });
    expect((await t.run((ctx) => ctx.db.get(created!)))).toMatchObject({
      role: "assistant",
      status: "complete",
      text: "only text",
      runId: "runC",
    });
  });
});

describe("the boot sweep (CU-22)", () => {
  for (const mode of ["on", "shadow"] as const) {
    test(`${mode}: an orphaned live bubble is ${mode === "on" ? "first offered to the bridge to resume" : "closed connection_lost"}`, async () => {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seed(t, mode);
      const id = await streamingAssistant(t, chatId, userId);
      await t.run(async (ctx) => {
        const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", id)).first();
        await ctx.db.patch(row!._id, { updatedAt: Date.now() - 400_000, boundInstance: "prod" });
      });
      await t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod" });
      const m = await t.run((ctx) => ctx.db.get(id));
      const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      if (mode === "on") {
        expect(m?.status).toBe("streaming");
        expect(scheduled.some((s) => s.name.includes("resumeOrClose"))).toBe(true);
      } else {
        expect(m?.status).toBe("error");
        expect(scheduled.some((s) => s.name.includes("resumeOrClose"))).toBe(false);
      }
    });
  }

  test("on: when the bridge cannot resume it, the bubble closes as the sweep always did", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const id = await streamingAssistant(t, chatId, userId);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", id)).first();
      await ctx.db.patch(row!._id, { updatedAt: Date.now() - 400_000 });
    });
    await t.mutation(internal.stuckStreams.closeAfterResumeRefused, { messageId: id, instanceName: "prod" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("error");
  });

  test("on: a bubble written again since (resumed) is never closed", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const id = await streamingAssistant(t, chatId, userId);
    await t.mutation(internal.stuckStreams.closeAfterResumeRefused, { messageId: id, instanceName: "prod" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("streaming");
  });
});

describe("the shadow measure counts a cut run once (I1)", () => {
  test("two segments of one run = one bubble; a true twin is still a duplicate", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const mk = (extra: Record<string, unknown>) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          chatId,
          userId,
          role: "assistant" as const,
          status: "complete" as const,
          text: "x",
          runId: "runA",
          turnSessionKey: SK,
          updatedAt: Date.now(),
          ...extra,
        }),
      );
    // The first read sets the floor (nothing below it is measured): an empty page, so
    // the rows below are inside the measured window.
    await t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "page",
      rows: [],
      terminals: [],
      unidentified: 0,
      readAt: Date.now() - 60_000,
    });
    await mk({});
    await mk({ runSegment: 1 });
    await t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "delta",
      deltaCursor: "c:3",
      rows: [
        { entryId: "a1", seq: 1, role: "assistant", runId: "runA", hidden: false, visible: true },
        { entryId: "a2", seq: 3, role: "assistant", runId: "runA", hidden: false, visible: true },
      ],
      terminals: [],
      unidentified: 0,
    });
    const report = () =>
      t.query(internal.transcriptProjection.projectionReportInternal, { chatId });
    expect((await report())!.gaps!.i1.duplicated).toBe(0);
    await mk({});
    expect((await report())!.gaps!.i1.duplicated).toBe(1);
  });
});

describe("an adopted run keeps its bubble when a delivery merge rotates the id (I1)", () => {
  const TASK = "tool:image_generate:64ecb82b-9f73-4019-8e30-73d1ce433910";
  const DELIVERY = `image_generate:${TASK}:ok:agent-loop`;
  const ADOPTED = "a650a248-a6c4-4e1c-9e6f-d9d614c579f2";

  async function seedAdoptedBubble(t: T, mode: Mode) {
    const { userId, chatId } = await seed(t, mode);
    const bubble = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "C'est lancé.",
        // The gateway's followup run the bridge adopted (CU-9): a bare id.
        runId: ADOPTED,
        turnSessionKey: SK,
        finalizeCause: "gateway_final",
        finalizedAt: 2000,
        updatedAt: 2000,
      });
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: id,
        anchorExact: true,
        childSessionKey: `task:${TASK}`,
        kind: "task" as const,
        status: "running" as const,
        taskName: "image_generate",
        createdAt: 1500,
        updatedAt: 1500,
      });
      return id;
    });
    return { userId, chatId, bubble };
  }

  const recordsOf = (t: T, chatId: Id<"chats">, runId: string) =>
    t.run((ctx) =>
      ctx.db
        .query("runBubbles")
        .withIndex("by_chat_run", (q) => q.eq("chatId", chatId).eq("runId", runId))
        .collect(),
    );

  test("on: the rotated adopted run is recorded, and I1 still finds its bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, bubble } = await seedAdoptedBubble(t, "on");
    await t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "page",
      rows: [],
      terminals: [],
      unidentified: 0,
      readAt: 1000,
    });
    await t.mutation(internal.stream.startAssistant, { chatId, runId: DELIVERY });
    const merged = await t.run((ctx) => ctx.db.get(bubble));
    expect(merged?.runId).toBe(DELIVERY);
    const rec = await recordsOf(t, chatId, ADOPTED);
    expect(rec.map((r) => r.messageId)).toEqual([bubble]);
    await t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId,
      boundInstanceName: "prod",
      sessionKey: SK,
      sessionId: "s-1",
      kind: "delta",
      deltaCursor: "c:2",
      rows: [
        { entryId: "a1", seq: 1, role: "assistant", runId: ADOPTED, hidden: false, visible: true },
      ],
      terminals: [],
      unidentified: 0,
    });
    const report = await t.query(internal.transcriptProjection.projectionReportInternal, { chatId });
    expect(report!.gaps!.i1.transcriptOnly).toBe(0);
  });

  test("off and shadow: no record (the historical path is unchanged)", async () => {
    for (const mode of ["off", "shadow"] as const) {
      const t = convexTest(schema, modules);
      const { chatId, bubble } = await seedAdoptedBubble(t, mode);
      await t.mutation(internal.stream.startAssistant, { chatId, runId: DELIVERY });
      expect((await t.run((ctx) => ctx.db.get(bubble)))?.runId).toBe(DELIVERY);
      expect(await recordsOf(t, chatId, ADOPTED)).toEqual([]);
    }
  });
});

describe("the switch of the instance the turns go to (per-turn routed, legacy chats)", () => {
  async function chatWith(t: T, fields: Record<string, unknown>) {
    const { userId } = await seed(t, "on");
    return t.run(async (ctx) => {
      // A second instance, on the legacy path: the resolution must pick the right one.
      await ctx.db.insert("instances", {
        name: "other",
        gatewayUrl: "ws://gw2",
        config: { transcriptProjection: "shadow" } as never,
      });
      return ctx.db.insert("chats", { userId, updatedAt: 1, ...fields });
    });
  }
  const modeOf = (t: T, chatId: Id<"chats">, instanceName?: string) =>
    t.run(async (ctx) => projectionModeOfChat(ctx, await ctx.db.get(chatId), instanceName));

  test("a per-turn routed chat reads its last confirmed route, not its (absent) binding", async () => {
    const t = convexTest(schema, modules);
    const chatId = await chatWith(t, {
      perTurnRouting: true,
      lastRoutedInstanceName: "prod",
      lastRoutedAgentId: "main",
      routingSegment: "turn:x",
    });
    expect(await modeOf(t, chatId)).toBe("on");
  });

  test("the route outranks the binding of a per-turn chat", async () => {
    const t = convexTest(schema, modules);
    const chatId = await chatWith(t, {
      instanceName: "other",
      agentId: "main",
      perTurnRouting: true,
      lastRoutedInstanceName: "prod",
      lastRoutedAgentId: "main",
      routingSegment: "turn:x",
    });
    expect(await modeOf(t, chatId)).toBe("on");
  });

  test("a legacy chat (no binding, no route) reads the owner's default agent", async () => {
    const t = convexTest(schema, modules);
    const chatId = await chatWith(t, {});
    expect(await modeOf(t, chatId)).toBe("on");
  });

  test("a bound chat reads its binding; the turn's own instance decides when given", async () => {
    const t = convexTest(schema, modules);
    const chatId = await chatWith(t, { instanceName: "other", agentId: "main" });
    expect(await modeOf(t, chatId)).toBe("shadow");
    expect(await modeOf(t, chatId, "prod")).toBe("on");
  });

  test("a send on a per-turn routed chat follows the projected path (no hold behind a sub-agent)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await chatWith(t, {
      perTurnRouting: true,
      lastRoutedInstanceName: "prod",
      lastRoutedAgentId: "main",
      routingSegment: "turn:x",
    });
    await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:main:subagent:c1",
        status: "running" as const,
        createdAt: 1,
        updatedAt: Date.now(),
      }),
    );
    expect(await t.run((ctx) => isChatBusy(ctx, chatId))).toBe(false);
  });
});

describe("an empty projected reply in a SERVICE conversation still settles its job", () => {
  async function serviceTurn(t: T, kind: "summarizer" | "curator") {
    const { userId, chatId: targetChatId } = await seed(t, "on");
    return t.run(async (ctx) => {
      const createdAt = 5_000;
      let lock: Record<string, unknown>;
      let nonce: string;
      if (kind === "summarizer") {
        lock = {
          pendingSummarize: { targetChatId, watermarkTarget: 1, coveredCountTarget: 1, createdAt },
        };
        nonce = summarizeSessionNonce(String(targetChatId), createdAt);
      } else {
        const curationId = await ctx.db.insert("agentFileCurations", {
          instanceName: "prod",
          agentId: "main",
          name: "MEMORY.md",
          status: "dispatched" as const,
          baseUpdatedAtMs: null,
          beforeSize: 10,
          budgetChars: 100,
          requestedByUserId: userId,
          trigger: "manual" as const,
          createdAt,
          updatedAt: createdAt,
        });
        lock = { pendingCurate: { curationId, createdAt } };
        nonce = curationSessionNonce(String(curationId), createdAt);
      }
      const hidden = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
        kind,
        ...lock,
      } as never);
      const id = await ctx.db.insert("messages", {
        chatId: hidden,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "runS",
        turnSessionKey: `agent:main:atrium:chat:u:${nonce}`,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("streamingText", {
        messageId: id,
        chatId: hidden,
        userId,
        generation: "runS",
        text: "",
        updatedAt: Date.now(),
      });
      return { hidden, id };
    });
  }

  for (const kind of ["summarizer", "curator"] as const) {
    test(`${kind}: the bubble is kept and the job lock is released`, async () => {
      const t = convexTest(schema, modules);
      const { hidden, id } = await serviceTurn(t, kind);
      await t.mutation(internal.stream.finalize, {
        messageId: id,
        status: "complete",
        text: "",
        dropIfEmpty: true,
      });
      expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
      const chat = (await t.run((ctx) => ctx.db.get(hidden))) as Record<string, unknown> | null;
      expect(chat?.[kind === "summarizer" ? "pendingSummarize" : "pendingCurate"]).toBeUndefined();
    });
  }
});

describe("codex pass 2 — a late final never crosses instances (P1, all modes)", () => {
  test("bridge `prod` cannot append to a bubble bridge `other` settled in the same chat", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const id = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "B's reply",
        runId: "runB",
        boundInstance: "other",
        updatedAt: 1,
      }),
    );
    await expect(
      t.mutation(internal.stream.appendLateFinal, {
        chatId,
        runId: "runB",
        messageId: id,
        text: "injected",
        boundInstanceName: "prod",
      }),
    ).rejects.toThrow(/cross-instance/);
    expect((await t.run((ctx) => ctx.db.get(id)))?.text).toBe("B's reply");
  });
});

describe("codex pass 2 — a restarted bridge learns the inputs held during the bubble (P1)", () => {
  test("liveBubbleForSession carries the inputs accepted after the bubble, not the moved ones", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const before = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId, userId, role: "user" as const, status: "complete" as const, text: "old",
        sendId: "send-old", custody: "accepted" as const, updatedAt: 1,
      }),
    );
    const bubble = await streamingAssistant(t, chatId, userId, { turnSessionKey: SK });
    const mk = (sendId: string, custody: "accepted" | "queued" | "steered" | "persisted") =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          chatId, userId, role: "user" as const, status: "complete" as const, text: sendId,
          sendId, custody, updatedAt: 1,
        }),
      );
    const b = await mk("send-b", "accepted");
    await mk("send-s", "steered");
    const q = await mk("send-q", "queued");
    await mk("send-p", "persisted");
    const live = await t.query(internal.bridge.liveBubbleForSession, { chatId, sessionKey: SK });
    expect(live?.messageId).toBe(bubble);
    expect(live?.heldInputs).toEqual([
      { sendId: "send-b", messageId: b },
      { sendId: "send-q", messageId: q },
    ]);
    expect(before).toBeDefined();
    const target = await t.query(internal.stuckStreams.resumeTarget, { messageId: bubble });
    expect(target?.heldInputs.map((h) => h.sendId)).toEqual(["send-b", "send-q"]);
  });
});

describe("codex pass 2 — an immediate send only to the session at work (P2)", () => {
  async function routedChat(t: T) {
    const { userId, chatId } = await seed(t, "on");
    await t.run(async (ctx) => {
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "prod",
        agentId: "other",
        isDefault: false,
        source: "manual" as const,
        createdAt: 1,
      });
      await ctx.db.patch(chatId, {
        perTurnRouting: true,
        lastRoutedInstanceName: "prod",
        lastRoutedAgentId: "main",
        routingSegment: "turn:x",
      });
    });
    await streamingAssistant(t, chatId, userId);
    return { userId, chatId, asUser: t.withIdentity({ subject: `${userId}|session` }) };
  }

  test("the same agent's session: dispatched now", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, asUser } = await routedChat(t);
    await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "B",
      clientMessageId: "b",
      routedAgent: { instanceName: "prod", agentId: "main" },
    });
    expect((await outboxOf(t, userId, "b"))?.status).toBe("pending");
  });

  test("another agent's session: waits in the queue (the working socket is not taken)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, asUser } = await routedChat(t);
    await asUser.mutation(api.send.sendMessage, {
      chatId,
      text: "B",
      clientMessageId: "b",
      routedAgent: { instanceName: "prod", agentId: "other" },
    });
    expect((await outboxOf(t, userId, "b"))?.status).toBe("queued");
  });
});

describe("codex pass 2 — a resumed later segment knows the earlier ones (P2)", () => {
  test("liveBubbleForSession / resumeTarget carry the earlier segments' text, in order", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "on");
    const seg = (n: number | undefined, text: string) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          chatId, userId, role: "assistant" as const, status: "complete" as const, text,
          runId: "runA", turnSessionKey: SK, updatedAt: 1,
          ...(n === undefined ? {} : { runSegment: n }),
        }),
      );
    await seg(undefined, "First.");
    await seg(1, "Second.");
    const last = await streamingAssistant(t, chatId, userId, { runSegment: 2 });
    const live = await t.query(internal.bridge.liveBubbleForSession, { chatId, sessionKey: SK });
    expect(live?.messageId).toBe(last);
    expect(live?.segmentPrefix).toBe("First.\n\nSecond.");
    const target = await t.query(internal.stuckStreams.resumeTarget, { messageId: last });
    expect(target?.segmentPrefix).toBe("First.\n\nSecond.");
  });
});

describe("codex pass 3 — the switch never reads the agent catalogue (bounded, all modes)", () => {
  const CATALOGUE = 3_000;
  const LIMIT = { documentsRead: 2_000 };

  async function legacyChatWithCatalogue(mode: Mode, ownRows = 0) {
    const t = convexTest({ schema, modules, transactionLimits: LIMIT });
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
      await ctx.db.insert("instances", {
        name: "prod",
        gatewayUrl: "ws://gw",
        config: { transcriptProjection: mode } as never,
      });
      for (let i = 0; i < ownRows; i++) {
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: "prod",
          agentId: `own-${i}`,
          isDefault: i === 0,
          source: "manual" as const,
          createdAt: 1,
        });
      }
      // A legacy conversation: bound to nothing, never routed.
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      return { userId, chatId };
    });
    for (let start = 0; start < CATALOGUE; start += 1_000) {
      await t.run(async (ctx) => {
        for (let i = start; i < start + 1_000; i++) {
          await ctx.db.insert("agents", {
            instanceName: "prod",
            agentId: `a-${i}`,
            source: "discovered" as const,
            presentInLastOk: true,
            firstSeenAt: 1,
            lastSeenAt: 1,
          });
        }
      });
    }
    return { t, ...ids };
  }

  for (const mode of ["off", "shadow"] as const) {
    test(`${mode}: an unbound chat's switch reads no catalogue — the send goes through`, async () => {
      const { t, userId, chatId } = await legacyChatWithCatalogue(mode);
      expect(
        await t.run(async (ctx) => projectionModeOfChat(ctx, await ctx.db.get(chatId))),
      ).toBe("off");
      const asUser = t.withIdentity({ subject: `${userId}|session` });
      await asUser.mutation(api.send.sendMessage, { chatId, text: "hi", clientMessageId: "m1" });
      expect((await outboxOf(t, userId, "m1"))?.status).toBeDefined();
    });
  }

  test("on: an unbound chat reads the owner's own rows, bounded — beyond the bound it is off", async () => {
    const { t, chatId } = await legacyChatWithCatalogue("on", 70);
    expect(
      await t.run(async (ctx) => projectionModeOfChat(ctx, await ctx.db.get(chatId))),
    ).toBe("off");
  });

  test("on: an unbound chat whose owner names a default agent on the `on` instance reads `on`", async () => {
    const { t, chatId } = await legacyChatWithCatalogue("on", 1);
    expect(
      await t.run(async (ctx) => projectionModeOfChat(ctx, await ctx.db.get(chatId))),
    ).toBe("on");
  });
});

describe("codex pass 4 — a stale /resume is never sent (P1)", () => {
  async function orphan(t: T, mode: Mode) {
    const { userId, chatId } = await seed(t, mode);
    await t.run(async (ctx) => {
      const prod = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first();
      await ctx.db.patch(prod!._id, { bridgeUrl: "http://bridge-prod" });
      await ctx.db.insert("instances", {
        name: "other",
        gatewayUrl: "ws://gw2",
        bridgeUrl: "http://bridge-other",
        config: { transcriptProjection: "off" } as never,
      });
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "other",
        agentId: "main",
        isDefault: false,
        source: "manual" as const,
        createdAt: 1,
      });
    });
    const id = await streamingAssistant(t, chatId, userId);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("streamingText").withIndex("by_message", (q) => q.eq("messageId", id)).first();
      await ctx.db.patch(row!._id, { updatedAt: Date.now() - 400_000, boundInstance: "prod" });
    });
    return { userId, chatId, id };
  }
  let prevSecret: string | undefined;
  beforeEach(() => {
    prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_SHARED_SECRET = "s";
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
    else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    vi.unstubAllGlobals();
  });
  const stubBridge = () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ ok: true, resumed: false }), { status: 200 });
    });
    return urls;
  };

  test("the bubble's own instance still routes the chat: its bridge is asked (control)", async () => {
    const t = convexTest(schema, modules);
    const { id } = await orphan(t, "on");
    const urls = stubBridge();
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: id, instanceName: "prod" });
    expect(urls).toEqual(["http://bridge-prod/resume"]);
  });

  test("the chat moved to another instance since the sweep: no bridge is asked, the bubble closes", async () => {
    const t = convexTest(schema, modules);
    const { chatId, id } = await orphan(t, "on");
    await t.run((ctx) => ctx.db.patch(chatId, { instanceName: "other" }));
    const urls = stubBridge();
    await t.action(internal.stuckStreams.resumeOrClose, { messageId: id, instanceName: "prod" });
    expect(urls).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("error");
  });

  test("the instance left `on` since the sweep: nothing to resume", async () => {
    const t = convexTest(schema, modules);
    const { id } = await orphan(t, "on");
    await t.run(async (ctx) => {
      const prod = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first();
      await ctx.db.patch(prod!._id, { config: { transcriptProjection: "shadow" } as never });
    });
    expect(await t.query(internal.stuckStreams.resumeTarget, { messageId: id })).toBeNull();
  });
});

describe("codex pass 4 — held inputs are the RUN's, not the current segment's (P1)", () => {
  async function runWithSegments(t: T) {
    const { userId, chatId } = await seed(t, "on");
    const user = (text: string, extra = {}) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          chatId, userId, role: "user" as const, status: "complete" as const, text, updatedAt: 1, ...extra,
        }),
      );
    const outbox = (messageId: Id<"messages">, extra = {}) =>
      t.run((ctx) =>
        ctx.db.insert("outbox", {
          userId, chatId, messageId, text: "x", clientMessageId: `c-${messageId}`,
          status: "sent" as const, attachmentIds: [], ...extra,
        } as never),
      );
    // A's own input: accepted by the ACK and never moved — it started the run.
    const userA = await user("A", { sendId: "runA", custody: "accepted" as const });
    const outA = await outbox(userA, { sentToInstance: "prod" });
    // Sent while A's send awaited its ACK: before any bubble existed.
    const early = await user("early", { sendId: "send-early", custody: "accepted" as const });
    await outbox(early, { sentToInstance: "prod" });
    const seg1 = await streamingAssistant(t, chatId, userId, { dispatchOutboxId: outA, boundInstance: "prod" });
    await t.run((ctx) => ctx.db.patch(seg1, { status: "complete" as const }));
    const b = await user("B", { sendId: "send-b", custody: "queued" as const });
    await outbox(b, { sentToInstance: "prod" });
    // Another instance's input in the same conversation: not this run's session.
    const other = await user("other", { sendId: "send-other", custody: "accepted" as const });
    await outbox(other, { sentToInstance: "elsewhere" });
    await user("C", { sendId: "send-c", custody: "steered" as const });
    const seg2 = await streamingAssistant(t, chatId, userId, { runSegment: 1, boundInstance: "prod" });
    return { chatId, early, b, seg2 };
  }

  test("a restart on a later segment still restores the input queued before the cut, and the early one", async () => {
    const t = convexTest(schema, modules);
    const { chatId, early, b, seg2 } = await runWithSegments(t);
    const expected = [
      { sendId: "send-early", messageId: early },
      { sendId: "send-b", messageId: b },
    ];
    const live = await t.query(internal.bridge.liveBubbleForSession, { chatId, sessionKey: SK });
    expect(live?.messageId).toBe(seg2);
    expect(live?.heldInputs).toEqual(expected);
    const target = await t.query(internal.stuckStreams.resumeTarget, { messageId: seg2 });
    expect(target?.heldInputs).toEqual(expected);
  });
});

describe("codex pass 5 — another instance's bridge never moves an input it was not sent (P1)", () => {
  const SK_OTHER = "agent:main:atrium:chat:u:c1-other";
  async function twoInstanceChat(t: T) {
    return t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
      for (const name of ["prod", "other"]) {
        await ctx.db.insert("instances", {
          name,
          gatewayUrl: `ws://${name}`,
          config: { transcriptProjection: "on" } as never,
        });
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: name,
          agentId: "main",
          isDefault: name === "prod",
          source: "manual" as const,
          createdAt: 1,
        });
      }
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        perTurnRouting: true,
        lastRoutedInstanceName: "prod",
        lastRoutedAgentId: "main",
      } as never);
      const send = async (sendId: string, instance: string) => {
        const messageId = await ctx.db.insert("messages", {
          chatId, userId, role: "user" as const, status: "complete" as const, text: sendId,
          sendId, custody: "queued" as const, updatedAt: 1,
        });
        await ctx.db.insert("outbox", {
          chatId, userId, clientMessageId: sendId, messageId, text: sendId, attachmentIds: [],
          status: "sent", sendId, sentToInstance: instance,
          routedAgent: { instanceName: instance, agentId: "main" },
        } as never);
        return messageId;
      };
      const toProd = await send("sendB", "prod");
      await send("sendO", "other");
      return { chatId, toProd };
    });
  }
  const cancel = (t: T, chatId: Id<"chats">, instance: string, sessionKey: string) =>
    t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId,
      boundInstanceName: instance,
      sessionKey,
      sessionId: `s-${instance}`,
      kind: "page",
      rows: [],
      terminals: [],
      unidentified: 0,
      inputRunIds: ["sendB"],
      pendingInputs: { total: 1, items: [{ runId: "sendB", state: "cancelled" }] },
    });

  test("bridge `other` names prod's send id: its custody stays queued", async () => {
    const t = convexTest(schema, modules);
    const { chatId, toProd } = await twoInstanceChat(t);
    await cancel(t, chatId, "other", SK_OTHER);
    expect((await t.run((ctx) => ctx.db.get(toProd)))?.custody).toBe("queued");
  });

  test("the bridge the input was sent to moves it (control)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, toProd } = await twoInstanceChat(t);
    await cancel(t, chatId, "prod", SK);
    expect((await t.run((ctx) => ctx.db.get(toProd)))?.custody).toBe("cancelled");
  });

  test("a session key prod projected is never written by bridge `other`", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await twoInstanceChat(t);
    await t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId, boundInstanceName: "prod", sessionKey: SK, sessionId: "s-1", kind: "page",
      rows: [], terminals: [], unidentified: 0,
    });
    expect(await cancel(t, chatId, "other", SK)).toMatchObject({ ok: false, reason: "session_owned_elsewhere" });
  });
});

describe("codex pass 6 — a session reserved by its first LIVE write; refused rows aggregate nothing (P1)", () => {
  const LIVE_ROW = {
    entryId: "a1", seq: 3, role: "assistant", runId: "runA", hidden: false, visible: true,
  };
  async function chatOf(t: T) {
    const { userId, chatId } = await seed(t, "on");
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "other",
        gatewayUrl: "ws://other",
        config: { transcriptProjection: "on" } as never,
      });
      await ctx.db.patch(chatId, { perTurnRouting: true, lastRoutedInstanceName: "prod", lastRoutedAgentId: "main" } as never);
      await ctx.db.insert("userAgents", {
        userId, instanceName: "other", agentId: "main", isDefault: false, source: "manual" as const, createdAt: 1,
      });
      for (const inst of ["prod", "other"]) {
        const m = await ctx.db.insert("messages", {
          chatId, userId, role: "user" as const, status: "complete" as const, text: inst, updatedAt: 1,
        });
        await ctx.db.insert("outbox", {
          chatId, userId, clientMessageId: inst, messageId: m, text: inst, attachmentIds: [],
          status: "sent", sentToInstance: inst,
        } as never);
      }
    });
    return chatId;
  }
  const apply = (t: T, chatId: Id<"chats">, instance: string, kind: "live" | "page", rows: unknown[]) =>
    t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId, boundInstanceName: instance, sessionKey: SK, sessionId: "s-1", kind,
      rows: rows as never, terminals: [], unidentified: 0,
    });

  test("prod's live rows reserve the key: other's page is refused, prod's own page then goes through", async () => {
    const t = convexTest(schema, modules);
    const chatId = await chatOf(t);
    expect(await apply(t, chatId, "prod", "live", [LIVE_ROW])).toMatchObject({ ok: true });
    expect(await apply(t, chatId, "other", "page", [])).toMatchObject({ ok: false, reason: "session_owned_elsewhere" });
    const cursors = await t.run((ctx) => ctx.db.query("transcriptCursors").collect());
    expect(cursors).toHaveLength(0);
    expect(await apply(t, chatId, "prod", "page", [LIVE_ROW])).toMatchObject({ ok: true });
  });

  test("a row stamped by another instance under the owner's key moves no run of the apply", async () => {
    const t = convexTest(schema, modules);
    const chatId = await chatOf(t);
    expect(await apply(t, chatId, "prod", "page", [])).toMatchObject({ ok: true });
    await t.run((ctx) =>
      ctx.db.insert("transcriptRows", {
        chatId, instanceName: "other", sessionKey: SK, sessionId: "s-1", entryId: "x1", seq: 9,
        role: "assistant", runId: "runX", hidden: false, visible: true, updatedAt: 1,
      } as never),
    );
    await apply(t, chatId, "prod", "live", [{ ...LIVE_ROW, entryId: "x1", seq: 9, runId: "runZ" }]);
    const runs = await t.run((ctx) => ctx.db.query("transcriptRuns").collect());
    expect(runs.map((r) => r.runId)).not.toContain("runZ");
  });
});
