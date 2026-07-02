import { describe, expect, it } from "vitest";
import { isStaleChunkError, shouldAutoReloadForStaleChunk } from "./staleChunk";

// Stale-chunk self-heal (the prod "Une erreur est survenue" on Settings ▸ Traces
// after a deploy): a lazy route's hashed chunk vanished under the session.

describe("isStaleChunkError", () => {
  it.each([
    // Chromium
    "TypeError: Failed to fetch dynamically imported module: https://x/assets/TracesTab-abc.js",
    // Firefox
    "TypeError: error loading dynamically imported module",
    // Safari
    "TypeError: Importing a module script failed.",
    // Vite CSS preload
    "Error: Unable to preload CSS for /assets/TracesTab-abc.css",
  ])("recognizes %s", (msg) => {
    expect(isStaleChunkError(new Error(msg.replace(/^\w+Error?: /, "")))).toBe(
      true,
    );
  });

  it("does NOT flag ordinary route errors (they must keep the error screen)", () => {
    expect(isStaleChunkError(new Error("Forbidden: chat not owned by user"))).toBe(
      false,
    );
    expect(isStaleChunkError(new Error("network timeout"))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
    expect(isStaleChunkError("plain string")).toBe(false);
  });
});

describe("shouldAutoReloadForStaleChunk (once-per-window loop guard)", () => {
  const fakeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  it("first failure -> reload; a second within the window -> NO reload (no loop)", () => {
    const s = fakeStorage();
    expect(shouldAutoReloadForStaleChunk(1_000_000, s)).toBe(true);
    expect(shouldAutoReloadForStaleChunk(1_000_500, s)).toBe(false);
  });

  it("after the guard window a fresh deploy can self-heal again", () => {
    const s = fakeStorage();
    expect(shouldAutoReloadForStaleChunk(1_000_000, s)).toBe(true);
    expect(shouldAutoReloadForStaleChunk(1_000_000 + 61_000, s)).toBe(true);
  });

  it("no storage available -> never auto-reload (no unguarded loops)", () => {
    expect(shouldAutoReloadForStaleChunk(1_000_000, null)).toBe(false);
  });
});
