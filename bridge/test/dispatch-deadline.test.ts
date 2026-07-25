/**
 * The pre-send deadline — the last line of defense for one-turn-per-session.
 *
 * Aborting Convex's `/send` POST does not cancel the handler it started. A handler
 * stuck upstream of the send can wake up after `outboxReconcile` settled its row,
 * told the user, and released the next queued turn. Submitting then would run a
 * turn Convex has already closed, next to a second turn on the same session.
 */

import { describe, expect, it } from "vitest";

import {
  PRE_SEND_DEADLINE_MS,
  assertBeforeSendDeadline,
} from "../src/core/dispatch-deadline.js";

describe("assertBeforeSendDeadline", () => {
  it("lets an ordinary (even slow) handler through", () => {
    const started = 1_000_000;
    expect(() => assertBeforeSendDeadline(started, started)).not.toThrow();
    expect(() =>
      assertBeforeSendDeadline(started, started + PRE_SEND_DEADLINE_MS),
    ).not.toThrow();
  });

  it("refuses to send once the row is no longer this handler's", () => {
    const started = 1_000_000;
    expect(() =>
      assertBeforeSendDeadline(started, started + PRE_SEND_DEADLINE_MS + 1),
    ).toThrow(/deadline exceeded before send/i);
  });

  it("counts the age the dispatch ALREADY had when Convex posted it", () => {
    // A POST arriving one minute before reconciliation must not get a fresh full
    // budget: the age that matters is the DISPATCH's, not this handler's. Convex
    // reports it as a duration, so no clock is shared across the boundary.
    const started = 1_000_000;
    expect(() =>
      assertBeforeSendDeadline(started, started + 60_000, PRE_SEND_DEADLINE_MS),
    ).toThrow(/deadline exceeded before send/i);
    // …and an unreported age (an older Convex) degrades to the local budget only.
    expect(() =>
      assertBeforeSendDeadline(started, started + 60_000),
    ).not.toThrow();
  });

  it("stays under the reconciler's bound, which is the whole point", () => {
    // convex/outboxReconcile.STALLED_PENDING_MS = 15 min. The handler must give up
    // BEFORE Convex takes the row away, or the guard buys nothing.
    expect(PRE_SEND_DEADLINE_MS).toBeLessThan(15 * 60_000);
  });
});
