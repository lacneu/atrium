/**
 * Dropping a chat's stored PROVIDER session — the one rule, in the one place.
 *
 * Two callers need it and they must not drift: `/reset`, which discards a session on the
 * user's behalf, and a turn that ended on SILENCE, which cannot vouch for the run it was
 * watching. Both mean the same thing — nothing about the stored session can be trusted —
 * and both must bump the reset EPOCH so an in-flight bind stands down instead of writing
 * the discarded id back into a freshly cleared slot.
 *
 * The id-SHAPE guard is what bounds the blast radius, and it is the reason this is safe to
 * call from a reaper as well as from a turn: the slot is shared, and it holds a Hermes
 * session id only for Hermes chats. An OpenClaw routing segment (`turn:…`) or a rotation
 * nonce is left exactly where it is — clearing those would break routing to fix a session
 * that was never stored there.
 *
 * A CONSEQUENCE worth stating, observed on the local bench (2026-07-30): a chat using PER-TURN
 * ROUTING keeps a `turn:…` segment in this slot, never the Hermes session id. So on those chats
 * the durable clear is a deliberate no-op — the shape guard declines it — and what actually
 * stops the next turn resuming an untrusted session is the bridge's in-process eviction
 * (`registry.forgetChat`). The two layers are not redundant: which one does the work depends on
 * the chat's routing mode.
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
  // EMPTY slot is not — it is our own bind still in flight, and the bump is what makes
  // it stand down instead of writing the suspect id back into a freshly cleared chat.
  if (
    expected !== undefined &&
    isStoredProviderSessionId(current) &&
    current !== expected
  ) {
    return {};
  }
  return isStoredProviderSessionId(current)
    ? { openclawChatId: undefined, ...bumped }
    : bumped;
}
