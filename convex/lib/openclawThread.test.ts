// The reconstructed thread_id MUST be byte-identical to the bridge's session key
// (bridge/src/providers/openclaw/session-keys.ts) — OpenClaw tags its Opik traces
// with that exact string, so a single char off = zero correlation. These pin the
// format + sanitization so a drift on either side fails loudly.
import { describe, expect, test } from "vitest";
import { buildOpenClawThreadId, safeSessionPart } from "./openclawThread";

describe("buildOpenClawThreadId — gateway session-key contract", () => {
  test("the canonical shape: agent:<agentId>:atrium:chat:<canonical>:<chatId>", () => {
    // Same fixture the bridge documents (session-keys.ts).
    expect(
      buildOpenClawThreadId({
        agentId: "main",
        canonical: "u-testuser01",
        chatId: "own-chat",
      }),
    ).toBe("agent:main:atrium:chat:u-testuser01:own-chat");
  });

  test("matches a REAL observed OpenClaw webchat thread_id", () => {
    // Captured live from Opik (project openclaw-olivier) 2026-06-18.
    expect(
      buildOpenClawThreadId({
        agentId: "olivier",
        canonical: "olivier",
        chatId: "m97c9e745j5xq5zt5xy63q7e6s88wqf1",
      }),
    ).toBe("agent:olivier:atrium:chat:olivier:m97c9e745j5xq5zt5xy63q7e6s88wqf1");
  });

  test("any missing routing part -> null (never query with a partial/guessed key)", () => {
    expect(buildOpenClawThreadId({ agentId: null, canonical: "c", chatId: "x" })).toBeNull();
    expect(buildOpenClawThreadId({ agentId: "a", canonical: undefined, chatId: "x" })).toBeNull();
    expect(buildOpenClawThreadId({ agentId: "a", canonical: "c", chatId: "" })).toBeNull();
  });

  test("safeSessionPart sanitizes like the bridge (unsafe -> '-', strip edges, empty -> unknown)", () => {
    expect(safeSessionPart("hello world")).toBe("hello-world");
    expect(safeSessionPart("a/b:c")).toBe("a-b-c");
    expect(safeSessionPart("--edge._")).toBe("edge");
    expect(safeSessionPart("   ")).toBe("unknown");
    expect(safeSessionPart("keep_this.one-ok")).toBe("keep_this.one-ok");
  });
});
