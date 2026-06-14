/**
 * raceWithTimeout — the per-frame receive-timeout race in the session loop.
 *
 * Regression guard (Codex review P2): when a FRAME wins the race, the timeout's
 * setTimeout must be CLEARED, not left armed for the full timeoutMs. During
 * active streaming this runs once per frame, so an un-cleared timer would pile up
 * thousands of live timers over a long response. We assert the timer count
 * returns to zero after the frame wins.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { raceWithTimeout } from "../src/session.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("raceWithTimeout", () => {
  it("clears the timeout timer when a FRAME wins the race (P2 — no leak)", async () => {
    vi.useFakeTimers();
    const frame: Promise<IteratorResult<number>> = Promise.resolve({
      done: false,
      value: 42,
    });
    const result = await raceWithTimeout(frame, 60_000);
    expect(result).toEqual({ kind: "frame", done: false, value: 42 });
    // The frame won; the 60s timer must have been cleared, not left armed.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves to timeout when the frame is slow, then leaves no timer armed", async () => {
    vi.useFakeTimers();
    // A frame promise that never resolves within the test.
    const never = new Promise<IteratorResult<number>>(() => {});
    const raced = raceWithTimeout(never, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await raced).toEqual({ kind: "timeout" });
    expect(vi.getTimerCount()).toBe(0); // timer fired + cleared, none left
  });

  it("null timeout waits forever (no timer created)", async () => {
    vi.useFakeTimers();
    const frame: Promise<IteratorResult<number>> = Promise.resolve({
      done: true,
      value: undefined,
    });
    const result = await raceWithTimeout(frame, null);
    expect(result).toEqual({ kind: "frame", done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });
});
