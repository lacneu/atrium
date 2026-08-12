// WHEN the thread's activity signal stands down for a live bubble.
//
// The regression this pins is a whole-signal blackout: the pill and the block's
// clock both read this verdict, so an answer of "something is streaming" when
// nothing is takes every indicator off the screen while work is still running.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deliveryWindowOpen, threadStreaming } from "./turnActivityAnchor";

describe("threadStreaming", () => {
  it("a message actively streaming stands the signal down", () => {
    expect(threadStreaming([{ status: "complete" }, { status: "streaming" }])).toBe(
      true,
    );
  });

  it("a thread whose messages have all settled does NOT stand it down", () => {
    expect(
      threadStreaming([{ status: "complete" }, { status: "error" }]),
    ).toBe(false);
  });

  // The blackout: a live-text row can outlive its message's terminal status
  // until the watchdog sweeps it. Asked of the MESSAGES, a swept-or-not row
  // changes nothing — every message here is terminal, so nothing is streaming.
  it("terminal messages read as settled whatever rows still exist for them", () => {
    expect(threadStreaming([{ status: "complete" }])).toBe(false);
  });

  it("a thread not loaded yet is not treated as streaming", () => {
    expect(threadStreaming(undefined)).toBe(false);
  });

  it("an empty thread is not streaming", () => {
    expect(threadStreaming([])).toBe(false);
  });

  // Forward-compat: a status this build does not know is not a stream.
  it("an unknown status is not a stream", () => {
    expect(threadStreaming([{ status: "some_future_state" }])).toBe(false);
    expect(threadStreaming([{}])).toBe(false);
  });
});

// The "a reply is being composed" window. Two rules pull in opposite directions
// and both have cost real defects: treating a long-stale value as live flashes
// a phantom "finalising" on every reopen; refusing to trust the first value
// seen makes a delivery already under way invisible when a conversation is
// opened. Neither is arbitrated here any more — the server ships the remaining
// time, so the question has one honest answer.
describe("deliveryWindowOpen", () => {
  const C = "chat_1";

  it("nothing delivering: the window is shut", () => {
    expect(deliveryWindowOpen(C, null, null, null)).toBe(false);
  });

  it("a delivery with time left holds the window open", () => {
    expect(deliveryWindowOpen(C, 1_000, 30_000, null)).toBe(true);
  });

  // The reopen case: a delivery ALREADY under way when the conversation is
  // opened must show, on the very first value observed.
  it("a delivery already under way at first sight shows immediately", () => {
    expect(deliveryWindowOpen(C, 1_000, 12_345, null)).toBe(true);
  });

  // The NO_REPLY case: a terminal row whose announce never came keeps the same
  // server timestamp for ever, and arrives with its window already spent.
  it("a value whose window has elapsed shows nothing", () => {
    expect(deliveryWindowOpen(C, 1_000, 0, null)).toBe(false);
  });

  // The remaining time is not a reactive dependency: with no further write,
  // only the client's own timer can close the window.
  it("the local timer closes the delivery it was set for", () => {
    expect(deliveryWindowOpen(C, 1_000, 30_000, { chatId: C, key: 1_000 })).toBe(
      false,
    );
  });

  // The defect a plain flag had: an expiry raised for the PREVIOUS delivery
  // outlived it, and blanked the next one on the render that first saw it.
  it("an expiry from a previous delivery does not close the NEXT one", () => {
    expect(deliveryWindowOpen(C, 2_000, 30_000, { chatId: C, key: 1_000 })).toBe(
      true,
    );
  });

  it("an expiry from another conversation never closes this one", () => {
    expect(
      deliveryWindowOpen(C, 1_000, 30_000, { chatId: "chat_2", key: 1_000 }),
    ).toBe(true);
  });

  // A build talking to a server that does not ship the remaining time must not
  // guess that the delivery is live.
  it("a delivery with no remaining time reported is not assumed live", () => {
    expect(deliveryWindowOpen(C, 1_000, null, null)).toBe(false);
  });
});

// ONE DURATION, READ BY BOTH RENDERS.
//
// The activity indicator renders in TWO places: anchored under the working bubble
// and, when that bubble is not mounted, at the bottom of the thread. Withholding
// a detached task's clock on the bottom fallback ALONE left the 47-hour clock
// exactly where production shows it — the anchored path is the normal one, since
// the bubble is mounted (codex P1, lot 0.71.8).
//
// A DERIVED guard, not a mount: this suite has no React environment, so the thing
// that can actually regress — a second, unfiltered read of `workingSince` — is
// checked against the source instead of asserted on a rendered tree.
describe("the detached-task clock is withheld on EVERY render path", () => {
  const src = readFileSync(
    new URL("./ConvexChat.tsx", import.meta.url),
    "utf8",
  );

  it("`workingSince` is read from the server value exactly once", () => {
    const raw = [...src.matchAll(/turnActivity\?\.workingSince/g)].length;
    expect(
      raw,
      "a second raw read of workingSince bypasses the detached-task filter — which is how the anchored render kept the clock",
    ).toBe(1);
  });

  it("that single read is the one guarded by detachedTask", () => {
    // The derivation and the guard must sit together; a read that drifts away
    // from its condition is the defect, not the count.
    const i = src.indexOf("const visibleWorkingSince");
    expect(i, "the single derivation was renamed or removed").toBeGreaterThan(-1);
    const block = src.slice(i, i + 400);
    expect(block).toContain("detachedTask");
    expect(block).toContain("turnActivity?.workingSince");
  });

  it("both indicators are fed from that derivation", () => {
    expect(
      [...src.matchAll(/visibleWorkingSince/g)].length,
      "one of the two render paths no longer reads the shared value",
    ).toBeGreaterThanOrEqual(3);
  });
});
