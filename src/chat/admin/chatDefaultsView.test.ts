import { describe, expect, test } from "vitest";
import {
  THINKING_DEFAULT_OPTIONS,
  parseChatDefaults,
} from "./chatDefaultsView";
import { THINKING_DEFAULTS } from "../../../convex/agentFiles";

// Defensive parsing of the bridge /config-defaults payload (relayed as
// `unknown` by the Convex action) — both plausible shapes + garbage input.

describe("parseChatDefaults", () => {
  test("reads top-level fields", () => {
    expect(
      parseChatDefaults({ thinkingDefault: "high", fastModeDefault: true }),
    ).toEqual({ thinkingDefault: "high", fastModeDefault: true });
  });

  test("reads fields nested under `defaults` (nested wins)", () => {
    expect(
      parseChatDefaults({
        ok: true,
        thinkingDefault: "low",
        defaults: { thinkingDefault: "xhigh", fastModeDefault: false },
      }),
    ).toEqual({ thinkingDefault: "xhigh", fastModeDefault: false });
  });

  test("missing / wrong-typed fields resolve to null", () => {
    expect(parseChatDefaults({})).toEqual({
      thinkingDefault: null,
      fastModeDefault: null,
    });
    expect(
      parseChatDefaults({ thinkingDefault: 3, fastModeDefault: "yes" }),
    ).toEqual({ thinkingDefault: null, fastModeDefault: null });
    expect(parseChatDefaults(null)).toEqual({
      thinkingDefault: null,
      fastModeDefault: null,
    });
    expect(parseChatDefaults("nope")).toEqual({
      thinkingDefault: null,
      fastModeDefault: null,
    });
  });

  test("an out-of-enum thinking value is kept verbatim (UI shows the truth)", () => {
    expect(parseChatDefaults({ thinkingDefault: "warp9" }).thinkingDefault).toBe(
      "warp9",
    );
  });
});

describe("THINKING_DEFAULT_OPTIONS", () => {
  test("is the bench-verified 6-level gateway enum, in order", () => {
    expect([...THINKING_DEFAULT_OPTIONS]).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("stays in LOCKSTEP with the server enum (convex/agentFiles)", () => {
    // The UI list is duplicated (the convex module is not browser-importable);
    // this pin makes any server-side enum change fail loudly here.
    expect([...THINKING_DEFAULT_OPTIONS]).toEqual([...THINKING_DEFAULTS]);
  });
});
