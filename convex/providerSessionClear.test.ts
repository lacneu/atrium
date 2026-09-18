/// <reference types="vite/client" />
//
// Dropping a suspect provider session ATOMICALLY with the turn's terminal (lot 31).
//
// The bridge used to clear the session in a SEPARATE write, guarded by a retry and an
// in-memory quarantine — because that write could fail on its own while the turn settled
// anyway, handing the suspect session back to the next send. The quarantine died with the
// process, so a bridge restart after a failed clear reopened the same hole.
//
// Riding the finalize removes the failure mode instead of compensating for it: either the
// finalize lands and the session is cleared, or it does not land and the turn is not
// settled, so the chat is never released and nothing can resume. This pins that, plus the
// one thing the flag must NOT do — clear on an ordinary terminal.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { providerSessionClearPatch } from "./lib/providerSession";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

async function seedStreaming(t: T, stored?: string) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 0,
      ...(stored === undefined ? {} : { openclawChatId: stored }),
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId: "hermes-run-1",
      updatedAt: 1,
    });
    return { chatId, messageId };
  });
}

const chatOf = async (t: T, chatId: unknown) =>
  await t.run(async (ctx) => {
    const c = await ctx.db.get(chatId as never);
    return {
      stored: (c as { openclawChatId?: string } | null)?.openclawChatId,
      epoch: (c as { providerResetCount?: number } | null)?.providerResetCount ?? 0,
    };
  });

describe("finalize({ clearProviderSession })", () => {
  const WS_ID = "20260706_212939_aee24e";

  test("drops the stored session and bumps the epoch, in ONE write", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t, WS_ID);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "Hermes stopped sending before the reply was complete.",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: undefined, epoch: 1 });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
  });

  test("an ORDINARY terminal never touches the session", async () => {
    // Only silence is ambiguous. A delivered answer says the run is over, and clearing
    // there would cost a rehydration on every turn.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t, WS_ID);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "voilà",
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: WS_ID, epoch: 0 });
  });

  test("an OpenClaw routing segment survives the flag", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t, "turn:nx7abc");
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
    });
    const after = await chatOf(t, chatId);
    expect(after.stored).toBe("turn:nx7abc");
    // …and the epoch does NOT move either. This expectation was 1 while the mismatch rule
    // depended on the id SHAPE: a segment did not look like a session, so the slot read as
    // EMPTY and took the "our own bind is still in flight, make it stand down" bump. It is
    // not empty — it holds a binding this terminal did not name — so the mismatch rule
    // applies in full: neither the slot nor the epoch moves, and the routed turn that owns
    // that segment keeps its bind (codex).
    expect(after.epoch).toBe(0);
  });

  test("a finalize SKIPPED by the run guard skips the clear with it", async () => {
    // The bubble now belongs to a LIVE announce run on that very session: dropping it
    // would break a turn that is working, to protect one that already lost its claim.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t, WS_ID);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
      expectedRunId: "some-other-run",
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: WS_ID, epoch: 0 });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("streaming"); // …and the turn was not settled either
  });
  test("a chat bound to a NEWER session is left ALONE — epoch included", async () => {
    // THE design pin. A silence terminal can land after a user Stop released the chat and
    // the next turn bound a session of its own. Dropping then would wipe a binding that
    // works; bumping the epoch would make that newer turn's own bind stand down. The id
    // is what tells them apart — with a bare flag there is no way to know, which is why
    // the wire carries the id and a hop that loses it clears NOTHING.
    const t = convexTest(schema, modules);
    const NEWER = "20260707_101010_bbbbbb";
    const { chatId, messageId } = await seedStreaming(t, NEWER);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID, // the OLD turn's session
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: NEWER, epoch: 0 });
  });

  test("an ALREADY-TERMINAL message still drops the session", async () => {
    // A user Stop finalizes the bubble `aborted` in Convex while the bridge's silence
    // terminal is in flight — and on a Stop the bridge writes no terminal of its own, so
    // there is nothing else to carry the drop. Tying it to winning that race left the
    // chat released with the suspect session still in the slot (raised in review).
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t, WS_ID);
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "aborted" as const });
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: undefined, epoch: 1 });
    // …and the terminal itself is still a no-op: the abort keeps the bubble.
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("aborted");
  });

  test("a LATE finalize removes only an EXACT match — no id, no clear", async () => {
    // A finalize that transitions nothing is late: a retry, or a terminal that lost the
    // race to a Stop. It may remove the binding it can NAME and nothing else. Without
    // this, an old bridge's legacy `true` arriving late would wipe whatever is in the
    // slot — which by then can be a NEWER turn's session (raised in review).
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t, WS_ID);
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "aborted" as const });
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: true, // legacy form: nothing to match on
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: WS_ID, epoch: 0 });
  });

  test("a LATE finalize on an EMPTY slot does not bump either", async () => {
    // The retry of a clear that already landed. On the OWNING path an empty slot means
    // "our own bind may still be in flight" and the epoch bumps to make it stand down —
    // but a late writer has no bind of its own left, and bumping would make a NEWER
    // turn's in-flight bind stand down for nothing (raised in review).
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t); // no stored session
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "error" as const });
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: undefined, epoch: 0 });
  });

  test("…while the OWNING path DOES bump an empty slot — its own bind may be in flight", async () => {
    // The other half of the split, and the reason it is not "exact match everywhere":
    // dropping this would let a bind still travelling write the suspect id straight back
    // into the chat this very finalize just cleared.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t); // bind not landed yet
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: undefined, epoch: 1 });
  });

  test("the LEGACY boolean is honored on the OWNING path — a rolling deploy must not wedge a turn", async () => {
    // An older bridge still posts `true`. Rejecting it at the validator would fail the
    // finalize and leave the row `streaming` until the watchdog: the very class of bug
    // this field exists to close.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t, WS_ID);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: true,
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: undefined, epoch: 1 });
  });
});

// A NAMED clear must drop the slot whatever the id LOOKS like.
//
// The patch used to gate the owning path on `isStoredProviderSessionId`, which recognizes
// the two Hermes id shapes only. A real OpenClaw session is a UUID and a routed segment is
// `turn:<turnId>` — neither matches, so the clear bumped the epoch and left the binding in
// place. The epoch only makes an in-flight bind stand down; what the NEXT turn resumes is
// the slot (bridge.ts routing) — so the dead conversation came back, turn after turn,
// which is exactly what a named clear exists to stop.
describe("providerSessionClearPatch — a named session, whatever its shape", () => {
  for (const stored of [
    "000b1aae-99f1-4836-ae45-ab9ebba7d8e8", // a real OpenClaw session id
    "turn:jd7f2k9x3m1p0q8r", // a per-turn routing segment
    "api_1700000000_deadbeef", // the Hermes shape, unchanged
  ]) {
    test(`clears ${stored}`, () => {
      const patch = providerSessionClearPatch(stored, 3, { expected: stored });
      expect(patch.openclawChatId, stored).toBeUndefined();
      expect("openclawChatId" in patch, stored).toBe(true);
      expect(patch.providerResetCount, stored).toBe(4);
    });
  }

  test("a MISMATCH still clears nothing, and an unnamed clear still needs the shape", () => {
    // Named but not what we watched: a newer turn owns the slot.
    expect(
      providerSessionClearPatch("api_1700000000_deadbeef", 3, {
        expected: "api_1700000000_cafe",
      }),
    ).toEqual({});
    // Unnamed (legacy flag) over a routing segment: the epoch moves, the slot does not.
    const legacy = providerSessionClearPatch("turn:jd7f2k9x3m1p0q8r", 3, {});
    expect("openclawChatId" in legacy).toBe(false);
    expect(legacy.providerResetCount).toBe(4);
  });
});

// Two slots, one name. The bridge keys a per-turn-routed chat on `routingSegment`, which
// `getChatRouting` sends AS `openclawChatId` — so the session the terminal NAMES can sit
// in either field. Clearing only the primary one left the dead segment bound for every
// multi-agent chat, and the next routed turn resumed it.
describe("finalize({ clearProviderSession }) — a ROUTED segment", () => {
  const SEGMENT = "turn:jd7f2k9x3m1p0q8r";
  const PRIMARY = "000b1aae-99f1-4836-ae45-ab9ebba7d8e8";

  async function seedRouted(t: T) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 0,
        perTurnRouting: true,
        routingSegment: SEGMENT,
        // BOTH slots populated, which is the real shape of a per-turn chat: it keeps its
        // primary thread while a routed turn runs on a segment. With only the segment set,
        // a return to "pick the slot that happens to be populated" would still pass (codex).
        openclawChatId: PRIMARY,
      });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "run-1",
        updatedAt: 1,
      });
      return { chatId, messageId };
    });
  }

  const routedChatOf = async (t: T, chatId: unknown) =>
    await t.run(async (ctx) => {
      const c = (await ctx.db.get(chatId as never)) as {
        routingSegment?: string;
        openclawChatId?: string;
        providerResetCount?: number;
      } | null;
      return {
        segment: c?.routingSegment,
        primary: c?.openclawChatId,
        epoch: c?.providerResetCount ?? 0,
      };
    });

  test("drops the segment the terminal named, and bumps the epoch", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedRouted(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "no conversation found for session",
      errorKind: "session_gone",
      clearProviderSession: SEGMENT,
    });
    // The segment goes, the PRIMARY thread stays: it is a different binding.
    expect(await routedChatOf(t, chatId)).toEqual({
      segment: undefined,
      primary: PRIMARY,
      epoch: 1,
    });
  });

  test("a terminal naming ANOTHER segment leaves this one alone", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedRouted(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "no conversation found for session",
      errorKind: "session_gone",
      clearProviderSession: "turn:someone-elses-turn",
    });
    expect(await routedChatOf(t, chatId)).toEqual({
      segment: SEGMENT,
      primary: PRIMARY,
      epoch: 0,
    });
  });

  test("a terminal naming the PRIMARY thread clears IT, not the segment", async () => {
    // Keying on the presence of `routingSegment` made this terminal read the segment,
    // find a mismatch and abandon its own dead binding (codex).
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedRouted(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "no conversation found for session",
      errorKind: "session_gone",
      clearProviderSession: PRIMARY,
    });
    expect(await routedChatOf(t, chatId)).toEqual({
      segment: SEGMENT,
      primary: undefined,
      epoch: 1,
    });
  });
});

// A LATE terminal names a session that is still in use.
//
// The late path (a user Stop settled the bubble first) took an exact id match as proof of
// ownership. But a gateway session is deliberately REUSED across turns: the Stop releases
// the chat, the next turn starts on the SAME session, and the old terminal then lands
// naming it. Clearing there drops a live binding and bumps the epoch under a turn that is
// working — exactly what the mismatch rule already refuses for a different id.
describe("finalize({ clearProviderSession }) — a LATE terminal under a newer turn", () => {
  const WS_ID = "20260706_212939_aee24e";

  test("clears nothing while another message is streaming on the chat", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t, WS_ID);
    // The user Stop settles this turn first; the chat is released.
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "aborted" as const });
      // …and the NEXT turn starts, on the same warm session.
      const msg = (await ctx.db.get(messageId))!;
      await ctx.db.insert("messages", {
        chatId,
        userId: msg.userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "run-2",
        updatedAt: 2,
      });
    });
    // The old turn's terminal lands now, naming the session the NEW turn is using.
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: WS_ID, epoch: 0 });
  });

  test("this turn's OWN pending outbox row does not block its clear", async () => {
    // A fast gateway error finalizes while its own outbox row is typically still `pending`
    // (live trace: the error beat the sent-flip by 190ms — the trap turnRetry.ts already
    // documents). Blocking on mere presence would skip a legitimate clear, and nothing
    // retries it after the row flips to `sent` (codex). The test is on AGE.
    const t = convexTest(schema, modules);
    // Seeded in the PRODUCTION order: sendMessage writes the outbox row, then the
    // dispatch's startAssistant creates the assistant turn. The row is therefore OLDER.
    const { chatId, messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 0,
        openclawChatId: WS_ID,
      });
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "own-row",
        text: "…",
        attachmentIds: [],
        status: "pending" as const,
        // Taken by the dispatch BEFORE the assistant message existed — this turn's own.
        pendingSince: 1,
      });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "aborted" as const, // a user Stop settled it first (the late path)
        text: "",
        runId: "run-1",
        updatedAt: 1,
      });
      return { chatId, messageId };
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: undefined, epoch: 1 });
  });

  test("a follow-up written EARLIER but taken LATER still blocks the clear", async () => {
    // The follow-up is queued during this turn's pre-ack window, so its row is OLDER than
    // this turn's assistant message; the drain promotes it after the Stop. An age-of-
    // creation test called it "ours" and cleared the session the follow-up had just
    // acquired (codex). What dates the acquisition is `pendingSince`.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 0,
        openclawChatId: WS_ID,
      });
      // Written FIRST (during the pre-ack window), while still queued.
      const followUp = await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "follow-up",
        text: "…",
        attachmentIds: [],
        status: "queued" as const,
      });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "aborted" as const,
        text: "",
        runId: "run-1",
        updatedAt: 1,
      });
      const msg = (await ctx.db.get(messageId))!;
      // …and only NOW does the drain take it: it holds the route.
      await ctx.db.patch(followUp, {
        status: "pending" as const,
        pendingSince: msg._creationTime + 1,
      });
      return { chatId, messageId };
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: WS_ID, epoch: 0 });
  });

  test("…but still clears when no newer turn took the chat", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedStreaming(t, WS_ID);
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "aborted" as const });
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "silence",
      errorKind: "response_timeout",
      clearProviderSession: WS_ID,
    });
    expect(await chatOf(t, chatId)).toEqual({ stored: undefined, epoch: 1 });
  });
});
