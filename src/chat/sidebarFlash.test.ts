// The flash store's EXPAND contract: only "locate me" flashes (a branch just
// landed) may unfold the section holding the chat — an arrival heads-up must
// leave a user-folded project folded (the folded aggregate carries the
// signal). A regression here silently re-opens folders on every reply.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearSidebarFlash,
  flashSidebarChat,
  getSidebarFlash,
} from "./sidebarFlash";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sidebarFlash expand contract", () => {
  test("default flash (arrival) does NOT ask to expand", () => {
    flashSidebarChat("chat-1");
    expect(getSidebarFlash()).toEqual({ chatId: "chat-1", expand: false });
    clearSidebarFlash("chat-1");
  });

  test("branch flash asks to expand", () => {
    flashSidebarChat("chat-2", { expand: true });
    expect(getSidebarFlash()).toEqual({ chatId: "chat-2", expand: true });
    clearSidebarFlash("chat-2");
  });

  test("clear is guarded: a stale row cannot clear a newer flash", () => {
    flashSidebarChat("old");
    flashSidebarChat("new", { expand: true });
    clearSidebarFlash("old"); // stale animation end
    expect(getSidebarFlash()).toEqual({ chatId: "new", expand: true });
    clearSidebarFlash("new");
    expect(getSidebarFlash()).toBeNull();
  });

  test("a flash whose row never mounts SELF-EXPIRES (folded folder)", () => {
    // The row's animation-end never fires when its section stays folded — the
    // TTL must clear the store so the flash can't fire minutes later when the
    // user finally unfolds the project.
    flashSidebarChat("hidden-chat");
    expect(getSidebarFlash()).not.toBeNull();
    vi.advanceTimersByTime(5_000);
    expect(getSidebarFlash()).toBeNull();
  });

  test("a re-flash resets the expiry window", () => {
    flashSidebarChat("a");
    vi.advanceTimersByTime(3_000);
    flashSidebarChat("b"); // new flash → fresh TTL
    vi.advanceTimersByTime(3_000); // 6s after "a", 3s after "b"
    expect(getSidebarFlash()).toEqual({ chatId: "b", expand: false });
    vi.advanceTimersByTime(2_000);
    expect(getSidebarFlash()).toBeNull();
  });
});
