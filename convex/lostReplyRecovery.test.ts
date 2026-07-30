/// <reference types="vite/client" />
//
// A reply the gateway FINISHED must not stay lost because the transport died (lot 48 — G-47,
// the last gap of W7).
//
// THE SEQUENCE THIS TEST EXISTS TO PIN, stated before any assertion — because the first
// attempt at this lot was written, tested green, and CANCELLED for having posed an initial
// state production never produces:
//
//   1. A turn streams on provider session S, into assistant message M.
//   2. The socket dies. The bridge's terminal settles M `error` and, being unable to vouch
//      for S, clears it (lots 30/31) — so nothing resumes it and `inflight` is never read.
//      That clear is exactly what made the first design impossible.
//   3. THIS lot adds one thing to that same terminal: the cleared id is kept as a READ-ONLY
//      RECOVERY HANDLE, `{session, messageId}`, distinct from `openclawChatId` so the
//      selector can never resume it.
//   4. The next dispatch hands the handle to the bridge, which resumes S ONCE — read-only —
//      and abandons if the session is live or the turn still streaming (lot 30's own risk).
//   5. Otherwise it harvests `inflight.assistant` and gives it back to M, BY ID.
//
// No "last message" heuristic anywhere: the handle names its target, recorded at the moment
// the reply was lost. The first attempt matched on "the last message is the assistant", an
// order `send` never produces because it inserts the USER row before dispatching.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const SESSION = "20260706_212939_aee24e";

/** The world of step 1: a chat bound to S, with a streaming assistant message on it. */
async function streamingTurn(t: ReturnType<typeof convexTest>): Promise<{
  chatId: Id<"chats">;
  messageId: Id<"messages">;
}> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    // A routable chat: without an agent the dispatch resolves no target at all, so the
    // routing assertions below would pass for the wrong reason.
    await ctx.db.insert("userAgents", {
      userId,
      instanceName: "primary",
      agentId: "hermes-agent",
      isDefault: true,
      source: "manual" as const,
      createdAt: 0,
    });
    const now = Date.now();
    const chatId = await ctx.db.insert("chats", {
      userId,
      archived: false,
      updatedAt: now,
      openclawChatId: SESSION,
      instanceName: "primary",
    });
    // `send` inserts the USER row before dispatching — the order production actually
    // produces, and the one the cancelled attempt got wrong.
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "explique-moi",
      updatedAt: now,
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId: "rt-1",
      updatedAt: now,
    });
    return { chatId, messageId };
  });
}

const chatOf = (t: ReturnType<typeof convexTest>, chatId: Id<"chats">) =>
  t.run(async (ctx) => await ctx.db.get(chatId));

const messageOf = (t: ReturnType<typeof convexTest>, messageId: Id<"messages">) =>
  t.run(async (ctx) => await ctx.db.get(messageId));

describe("the terminal that clears the session keeps a way back to it", () => {
  test("a transport-lost terminal records the handle it just cleared", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await streamingTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: "Hermes WS connection lost.",
      errorKind: "connection_lost",
      clearProviderSession: SESSION,
      recoverableSession: true,
    });
    const chat = await chatOf(t, chatId);
    expect(
      chat?.openclawChatId,
      "the session is still cleared — recovery must not resurrect the resume path",
    ).toBeUndefined();
    expect(chat?.recoverableSession?.session).toBe(SESSION);
    expect(chat?.recoverableSession?.messageId).toBe(messageId);
  });

  test("a USER STOP records nothing — harvesting cancelled text is a contresens", async () => {
    // The discrimination that makes this lot a fix and not a data-hoover: the Stop path also
    // clears the session (lot 45), but the user asked for it. Bringing their cancelled reply
    // back would be the opposite of the feature.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await streamingTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "aborted",
      clearProviderSession: SESSION,
    });
    expect((await chatOf(t, chatId))?.recoverableSession).toBeUndefined();
  });

  test("a handle is not recorded for a session that was not cleared", async () => {
    // Recovery only ever applies to a session nobody will resume: recording one on a
    // healthy turn would leave a stale pointer at a session that stays in use.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await streamingTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "voilà",
      recoverableSession: true,
    });
    expect((await chatOf(t, chatId))?.recoverableSession).toBeUndefined();
  });
});

describe("the harvested reply is given back to the message that lost it", () => {
  async function lostTurn(t: ReturnType<typeof convexTest>) {
    const seeded = await streamingTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: seeded.messageId,
      status: "error",
      error: "Hermes WS connection lost.",
      errorKind: "connection_lost",
      clearProviderSession: SESSION,
      recoverableSession: true,
    });
    return seeded;
  }

  test("the error bubble becomes the reply the gateway had finished", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await lostTurn(t);
    const applied = await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: SESSION,
      text: "Voici la réponse complète que la passerelle avait terminée.",
    });
    expect(applied).toBe(true);
    const msg = await messageOf(t, messageId);
    expect(msg?.status).toBe("complete");
    expect(msg?.text).toContain("réponse complète");
    expect(msg?.error ?? null, "the error card must go with it").toBeNull();
    // …and the handle is spent, so a second dispatch does not re-harvest.
    expect((await chatOf(t, chatId))?.recoverableSession).toBeUndefined();
  });

  test("a SECOND application changes nothing — the handle is spent", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await lostTurn(t);
    await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: SESSION,
      text: "la réponse",
    });
    const again = await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: SESSION,
      text: "la réponse",
    });
    expect(again).toBe(false);
    expect((await messageOf(t, messageId))?.text).toBe("la réponse");
  });

  test("a handle naming ANOTHER session is refused", async () => {
    // The recovery is matched by id, like every other provider-session decision in this
    // programme: a harvest from a session this chat never lost must not land.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await lostTurn(t);
    const applied = await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: "20260706_999999_ffffff",
      text: "du texte d'ailleurs",
    });
    expect(applied).toBe(false);
    expect((await messageOf(t, messageId))?.status).toBe("error");
  });

  test("a message that already carries MORE text is left alone", async () => {
    // Lot 11's rule, and it is load-bearing here: the terminal may have kept a partial the
    // user already read. A harvest that is SHORTER would be a visible regression, so the
    // longer text wins and the recovery declines rather than "restoring" less.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await lostTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, {
        text: "un texte partiel déjà affiché, et plus long que la récolte",
      });
    });
    const applied = await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: SESSION,
      text: "court",
    });
    expect(applied).toBe(false);
    expect((await messageOf(t, messageId))?.text).toContain("déjà affiché");
  });

  test("a message a NEWER run has re-owned is refused", async () => {
    // The chat moved on: the user resent, a new turn is streaming on this row. Writing a
    // stale harvest into it would replace a live reply with an old one.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await lostTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "streaming", runId: "rt-2" });
    });
    const applied = await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: SESSION,
      text: "la vieille réponse",
    });
    expect(applied).toBe(false);
    expect((await messageOf(t, messageId))?.status).toBe("streaming");
  });

  test("an EMPTY harvest is not a recovery", async () => {
    // `inflight.assistant` is "" for a turn that produced nothing. Flipping the bubble to
    // `complete` with no text would turn a named failure into a silent empty answer — worse
    // than the error it replaced.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await lostTurn(t);
    const applied = await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: SESSION,
      text: "   ",
    });
    expect(applied).toBe(false);
    expect((await messageOf(t, messageId))?.status).toBe("error");
  });
});

// ── The handle belongs to the gateway that minted it ──
//
// Raised in review. A Hermes session id is GATEWAY-LOCAL, so a handle recorded by instance A
// must never be spent against instance B: a rebind, or a per-turn routing switch, would ask B
// to resume an id that is not its own — leaking it to the wrong target and, on a collision,
// attributing another conversation's text to this message.

/** The lost-turn world, without an instance stamp — the default path. */
async function lostOnDefault(t: ReturnType<typeof convexTest>) {
  const seeded = await streamingTurn(t);
  await t.mutation(internal.stream.finalize, {
    messageId: seeded.messageId,
    status: "error",
    errorKind: "connection_lost",
    clearProviderSession: SESSION,
    recoverableSession: true,
  });
  return seeded;
}

describe("a recovery handle is bound to its origin", () => {
  async function lostOn(t: ReturnType<typeof convexTest>, instance: string) {
    const seeded = await streamingTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: seeded.messageId,
      status: "error",
      errorKind: "connection_lost",
      clearProviderSession: SESSION,
      recoverableSession: true,
      boundInstanceName: instance,
    });
    return seeded;
  }

  test("the instance that produced the session is recorded", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await lostOn(t, "primary");
    expect((await chatOf(t, chatId))?.recoverableSession?.instanceName).toBe("primary");
  });

  test("the ROUTING refuses to carry it to another instance", async () => {
    // The production gate, and the one that matters: the bridge never even receives a handle
    // its instance did not produce. Asserted on `getChatRouting`, which is what builds the
    // send body — the mutation keeps an origin check of its own as defence in depth.
    const t = convexTest(schema, modules);
    const { chatId } = await lostOn(t, "primary");
    const userId = await t.run(async (ctx) => (await ctx.db.get(chatId))!.userId);
    // The chat was REBOUND: its agent now lives on another instance (revoked/deleted agent →
    // rebind, which the routing resolves). The handle still names the gateway that minted the
    // session — and that gateway is no longer the target.
    await t.run(async (ctx) => {
      const agent = await ctx.db.query("userAgents").first();
      if (agent !== null) {
        await ctx.db.patch(agent._id, { instanceName: "secondary" });
      }
      await ctx.db.patch(chatId, { instanceName: "secondary" });
    });
    const routing = await t.query(internal.bridge.getChatRouting, { chatId, userId });
    expect(
      routing?.recoverableSession ?? null,
      "a session id is gateway-local: asking another gateway to resume it is meaningless",
    ).toBeNull();
  });

  test("…and carries it when the target IS its instance", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await lostOn(t, "primary");
    const userId = await t.run(async (ctx) => (await ctx.db.get(chatId))!.userId);
    const routing = await t.query(internal.bridge.getChatRouting, { chatId, userId });
    expect(routing?.recoverableSession?.session).toBe(SESSION);
  });

  test("its own instance can still spend it", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await lostOn(t, "primary");
    const applied = await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: SESSION,
      text: "la réponse retrouvée",
      boundInstanceName: "primary",
    });
    expect(applied).toBe(true);
  });
});

// ── One shot means one shot, including when the read comes back empty ──
//
// Raised in review, and it contradicted this file's own claim: the handle was only spent when
// a harvest SUCCEEDED, so the refusals — a gateway that restarted and forgot the session, the
// ordinary case — left it standing and every later send paid another `session.resume`.

describe("an empty harvest still spends the handle", () => {
  test("a refused read is recorded as spent, so nothing re-reads", async () => {
    const t = convexTest(schema, modules);
    const seeded = await streamingTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: seeded.messageId,
      status: "error",
      errorKind: "connection_lost",
      clearProviderSession: SESSION,
      recoverableSession: true,
    });
    const applied = await t.mutation(internal.stream.recoverLostReply, {
      chatId: seeded.chatId,
      messageId: seeded.messageId,
      session: SESSION,
      text: "",
    });
    expect(applied).toBe(false);
    expect((await messageOf(t, seeded.messageId))?.status).toBe("error");
    expect(
      (await chatOf(t, seeded.chatId))?.recoverableSession,
      "a handle left standing makes every later send pay another resume",
    ).toBeUndefined();
  });
});

// ── A reset is a cancellation, and it must revoke the handle too ──
//
// Raised in review, and it contradicted this lot's own rule. The `/reset` path clears the
// provider session and bumps the epoch, but it did not touch `recoverableSession`. Real
// sequence: transport lost → handle recorded; the user resets; the next send carries the
// handle to the same instance; the harvested text replaces the error bubble the user had
// deliberately discarded — and enters the rehydrated history of the new turn.
//
// Bounded by the EPOCH rather than deleted in one more place: the handle records the reset
// count it was written under, so ANY later bump — a reset, another untrusted clear — retires
// it, and no future clearing path can forget to.

describe("a reset retires the handle", () => {
  test("the handle records the epoch it was written under", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await lostOnDefault(t);
    const chat = await chatOf(t, chatId);
    expect(chat?.recoverableSession?.resetCount).toBe(chat?.providerResetCount);
  });

  test("a later epoch bump makes the routing refuse to carry it", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await lostOnDefault(t);
    const userId = await t.run(async (ctx) => (await ctx.db.get(chatId))!.userId);
    expect((await t.query(internal.bridge.getChatRouting, { chatId, userId }))
      ?.recoverableSession?.session).toBe(SESSION);
    // The user resets: the epoch moves, and everything written under the old one is stale.
    await t.run(async (ctx) => {
      const c = (await ctx.db.get(chatId))!;
      await ctx.db.patch(chatId, {
        providerResetCount: (c.providerResetCount ?? 0) + 1,
        openclawChatId: undefined,
      });
    });
    expect(
      (await t.query(internal.bridge.getChatRouting, { chatId, userId }))
        ?.recoverableSession ?? null,
      "the user discarded this turn — bringing its reply back is the opposite of a reset",
    ).toBeNull();
  });

  test("…and the mutation refuses it too, if one ever reached the bridge", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await lostOnDefault(t);
    await t.run(async (ctx) => {
      const c = (await ctx.db.get(chatId))!;
      await ctx.db.patch(chatId, {
        providerResetCount: (c.providerResetCount ?? 0) + 1,
      });
    });
    const applied = await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: SESSION,
      text: "la réponse abandonnée",
    });
    expect(applied).toBe(false);
    expect((await messageOf(t, messageId))?.status).toBe("error");
  });
});

// ── A cancelled turn is never recovered, whatever created the handle ──
//
// Raised in the final review pass, and it is the one race the Stop test above did not reach.
// The late-terminal branch — the one that exists precisely for "a user Stop already finalized
// this message and the silence terminal is still in flight" — was passing the recovery
// directive too. So a Stop could be followed by a handle, and the harvest, which accepted any
// non-streaming row, would flip the user's cancelled turn back to `complete`.
//
// Guarded on BOTH sides: the late branch records nothing, and the mutation refuses an
// `aborted` row outright. The second is the invariant that survives a future path forgetting
// the first — a user's cancellation is not ours to undo.

describe("a Stop cannot be undone by a late terminal", () => {
  test("the in-flight silence terminal creates no handle after a Stop", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await streamingTurn(t);
    // The user pressed Stop and the interrupt was HONOURED, so nothing was cleared (lot 45):
    // the slot still holds the session. That is what makes the late terminal's id match — a
    // Stop that had cleared would empty the slot and this race would pass for the wrong
    // reason, which is how the first version of this test fooled itself.
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "aborted",
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      errorKind: "response_timeout",
      clearProviderSession: SESSION,
      recoverableSession: true,
    });
    expect(
      (await chatOf(t, chatId))?.recoverableSession,
      "a turn the user cancelled must not become recoverable by a terminal that lost the race",
    ).toBeUndefined();
  });

  test("and an ABORTED message is refused even if a handle exists", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await lostOnDefault(t);
    // However it got there, the row is now the user's cancellation.
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "aborted" });
    });
    const applied = await t.mutation(internal.stream.recoverLostReply, {
      chatId,
      messageId,
      session: SESSION,
      text: "la réponse que l'utilisateur avait annulée",
    });
    expect(applied).toBe(false);
    expect((await messageOf(t, messageId))?.status).toBe("aborted");
  });
});
