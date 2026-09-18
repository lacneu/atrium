/**
 * Dropping a chat's stored PROVIDER session — the one rule, in the one place.
 *
 * FIVE call sites need it and they must not drift: `/reset` (bridge.ts), which discards a
 * session on the user's behalf; a turn's terminal (stream.ts), whether it ended on SILENCE
 * and cannot vouch for the run it was watching or on a class that PROVES the conversation
 * is gone; and the three stuck-stream reapers (stuckStreams.ts), which settle a turn nobody
 * is watching any more. They all mean the same thing — nothing about the stored session can
 * be trusted — and they must all bump the reset EPOCH so an in-flight bind stands down
 * instead of writing the discarded id back into a freshly cleared slot.
 *
 * What bounds the blast radius depends on whether the caller can NAME the session.
 *
 * NAMED (a turn that knows the id it was watching): the name is the whole guard. It clears
 * that id and nothing else, whatever its shape — a Hermes session, an OpenClaw UUID, a
 * routing segment — and a slot holding anything ELSE is a newer turn's binding, so neither
 * the slot nor the epoch moves. An EMPTY slot is not a mismatch: it is our own bind still
 * in flight, and the bump is what makes it stand down.
 *
 * UNNAMED (the legacy flag, and `/reset` on a shared slot): there is no id to match, so the
 * id-SHAPE guard is the only evidence that the slot holds a provider session at all. An
 * OpenClaw routing segment (`turn:…`) or a rotation nonce is left exactly where it is —
 * clearing those blind would break routing to fix a session that was never stored there.
 *
 * PER-TURN ROUTING keeps its `turn:…` segment in `chats.routingSegment`, a DIFFERENT field
 * from the shared slot this function patches. A named clear of a routed segment is handled
 * by the caller that knows about that field (`dropUntrustedProviderSession`), and it is a
 * real, durable clear — not the no-op an earlier version of this note described.
 */

/** The two Hermes session shapes: REST (`api_<ts>_<hex>`) and WS (`YYYYMMDD_HHMMSS_<hex>`,
 *  the stored_session_id). A reset must clear whichever transport persisted it. */
export function isStoredProviderSessionId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (/^api_[0-9]+_[0-9a-f]+$/i.test(value) ||
      /^[0-9]{8}_[0-9]{6}_[0-9a-f]+$/i.test(value))
  );
}

/** The patch a clear applies to a chat row: always the epoch bump, plus the slot itself
 *  when it actually holds a provider session.
 *
 *  The epoch bumps EVEN when the slot is empty (nothing to clear): the empty case is a
 *  not-yet-bound first turn, and an in-flight bind landing afterwards must see the
 *  mismatch and stand down.
 *
 *  `expected` NARROWS the clear to the session the caller was actually watching, and it
 *  is what makes a LATE clear safe. A turn that ends on silence can have its terminal
 *  land after the chat was released and the next turn bound a session of its own —
 *  clearing then would drop a binding that is working, and bumping the epoch would make
 *  that newer turn's own bind stand down. So a MISMATCH does nothing at all, epoch
 *  included: the same reasoning already written for the `expectedRunId` skip.
 *
 *  Callers that pass NO `expected` are the reapers and `/reset`, and the omission is not
 *  laziness: those paths select rows that are still `streaming`, so the chat is still
 *  busy and nothing newer can have bound. They mean "whatever is in there is unowned",
 *  which is exactly the unconditional form.
 *
 *  `onlyExactMatch` is the LATE writer's form, and the split is deliberate: a finalize
 *  that transitions the turn OWNS it, and may bump a chat whose slot is empty to make its
 *  own in-flight bind stand down. A finalize that transitions nothing is late — a retry,
 *  or a terminal that lost the race to a user Stop — and may only remove what it
 *  recognizes. Bumping blindly there would fire twice on a retry and could make a NEWER
 *  turn's in-flight bind stand down for nothing (raised in review). */
export function providerSessionClearPatch(
  current: unknown,
  resetCount: number | undefined,
  opts: { expected?: string; onlyExactMatch?: boolean } = {},
): { openclawChatId?: undefined; providerResetCount?: number } {
  const { expected, onlyExactMatch } = opts;
  const bumped = { providerResetCount: (resetCount ?? 0) + 1 };
  if (onlyExactMatch === true) {
    // No id, or not the binding we were watching → nothing at all. This is also what
    // retires the LEGACY boolean on this path: with no id there is no match, so an old
    // bridge's late terminal can no longer wipe a session that is not the one it meant.
    return expected !== undefined && current === expected
      ? { openclawChatId: undefined, ...bumped }
      : {};
  }
  // A DIFFERENT provider session is a newer turn's binding: neither drop nor bump. An
  // EMPTY slot is not — it is a bind of OUR OWN still in flight, and the bump is what makes
  // it stand down instead of writing the suspect id back into a freshly cleared chat.
  //
  // That empty case is also what reaches a binding nothing has PERSISTED yet. A switch's
  // ephemeral segment lives in the dispatch alone until `confirmTurnRouting` writes it, and
  // on a per-turn chat the slot below is empty by design — so a terminal naming that segment
  // finds nothing to clear, and only the epoch can stop the confirmation from writing in a
  // session already declared dead (codex).
  //
  // The mismatch test does NOT look at the id's shape: it recognizes the two Hermes shapes
  // only, while a real OpenClaw session is a UUID and a routed segment is `turn:<turnId>`.
  if (
    expected !== undefined &&
    typeof current === "string" &&
    current !== "" &&
    current !== expected
  ) {
    return {};
  }
  if (expected !== undefined && current === expected) {
    return { openclawChatId: undefined, ...bumped };
  }
  // UNNAMED (legacy flag): no id to match, so the shape is the only evidence that the slot
  // holds a provider session at all rather than a routing segment we must not touch.
  return isStoredProviderSessionId(current)
    ? { openclawChatId: undefined, ...bumped }
    : bumped;
}
