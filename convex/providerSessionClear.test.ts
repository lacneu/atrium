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
    expect(after.stored).toBe("turn:nx7abc"); // shape guard, not call site
    expect(after.epoch).toBe(1); // …but an in-flight bind must still stand down
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
