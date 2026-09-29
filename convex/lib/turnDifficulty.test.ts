// The live-turn difficulty rules, pinned on the production SHAPES that motivated them
// (ataraxis, read 2026-09-28): tool NAME + failure pattern of real turns, nothing else.
// "x" = a failed call, "." = a successful one.

import { describe, expect, test } from "vitest";
import {
  DIFFICULTY_MIN_FAILURES,
  STALL_AFTER_FAILURE_MS,
  failedThenQuietTool,
  repeatedFailureFacts,
  turnDifficultyRecheckAt,
  turnDifficultyVerdict,
  type DifficultyToolPart,
} from "./turnDifficulty";

/** Build tool parts from a pattern and the tool names, one per character. */
function shape(pattern: string, names: string[] | string): DifficultyToolPart[] {
  return [...pattern].map((c, i) => ({
    name: typeof names === "string" ? names : (names[i] ?? "exec"),
    phase: c === "x" ? "error" : c === "r" ? "start" : "completed",
  }));
}

/** Every prefix of a turn — the live turn as the reader saw it, call after call. */
function flaggedPrefixes(parts: DifficultyToolPart[]): number[] {
  const hits: number[] = [];
  for (let i = 1; i <= parts.length; i++) {
    if (repeatedFailureFacts(parts.slice(0, i)) !== null) hits.push(i);
  }
  return hits;
}

describe("healthy production turns are never flagged, at any moment", () => {
  test.each([
    ["63 calls, no error", ".".repeat(63)],
    ["60 calls, no error", ".".repeat(60)],
    ["41 calls, no error", ".".repeat(41)],
    // Isolated failures in turns that ended well: never three in a row.
    ["25 calls, 3 errors (2 in a row at most)", ".....xx..x..............."],
    ["45 calls, 1 error", "..x.........................................."],
    ["31 calls, 4 errors", "...x.xx....x..................."],
    ["20 calls, 2 errors", "..xx................"],
    ["image_generate failing twice then answering", ".xx"],
  ])("%s", (_label, pattern) => {
    expect(flaggedPrefixes(shape(pattern, "exec"))).toEqual([]);
  });

  test("a failure then an alternating recovery (browser x.x) is not a loop", () => {
    const names = ["read", "progress_card", "browser", "web_fetch", "browser", "browser", "browser", "browser", "browser"];
    // x x x (flagged — a real streak) . x : once browser succeeded, one more failure
    // is not three of the same tool without a success.
    const parts = shape("....xxx.x", names);
    expect(repeatedFailureFacts(parts)).toBeNull();
  });
});

describe("rule 1: three failed calls in a row", () => {
  test("six sessions_history refusals: flagged from the third, cleared by the next success", () => {
    const names = ["read", ...Array(6).fill("sessions_history"), "exec", "progress_card", "sessions_spawn"];
    const parts = shape(".xxxxxx...", names);
    expect(flaggedPrefixes(parts)).toEqual([4, 5, 6, 7]);
    expect(repeatedFailureFacts(parts.slice(0, 7))).toEqual({
      kind: "repeated_failures",
      tool: "sessions_history",
      failures: 6,
      sameTool: true,
    });
  });

  test("MIXED tools: counted together, named by the last, sameTool false", () => {
    const names = ["read", "sessions_search", "view_image", "sessions_history", "sessions_history", "sessions_history"];
    expect(repeatedFailureFacts(shape("..xxxx", names))).toEqual({
      kind: "repeated_failures",
      tool: "sessions_history",
      failures: 4,
      sameTool: false,
    });
  });

  test("a retry still RUNNING neither clears nor extends the streak", () => {
    const parts = shape("xxxr", "view_image");
    expect(repeatedFailureFacts(parts)).toEqual({
      kind: "repeated_failures",
      tool: "view_image",
      failures: 3,
      sameTool: true,
    });
  });

  test("two failures are not enough (the threshold is exactly 3)", () => {
    expect(DIFFICULTY_MIN_FAILURES).toBe(3);
    expect(repeatedFailureFacts(shape("xx", "web_fetch"))).toBeNull();
    expect(repeatedFailureFacts(shape("xxx", "web_fetch"))).not.toBeNull();
  });
});

describe("rule 2: the same tool keeps failing between other successes", () => {
  const names = ["view_image", "read", "view_image", "read", "view_image"];

  test("view_image x, read ., view_image x, read ., view_image x → flagged", () => {
    expect(repeatedFailureFacts(shape("x.x.x", names))).toEqual({
      kind: "repeated_failures",
      tool: "view_image",
      failures: 3,
      sameTool: true,
    });
  });

  test("the agent MOVED ON (the latest call succeeded): cleared", () => {
    expect(
      repeatedFailureFacts(shape("x.x.x.", [...names, "exec"])),
    ).toBeNull();
  });

  test("a success of that tool in between resets its count", () => {
    // view_image x, view_image ., view_image x, read ., view_image x — only 2
    // failures since view_image last succeeded.
    const n = ["view_image", "view_image", "view_image", "read", "view_image"];
    expect(repeatedFailureFacts(shape("x.x.x", n))).toBeNull();
  });

  test("failures older than the 8-call window do not count", () => {
    // view_image failed at call 1 and 10, 12; the first is outside the last 8.
    const n = ["view_image", ...Array(8).fill("read"), "view_image", "read", "view_image"];
    expect(repeatedFailureFacts(shape("x........x.x", n))).toBeNull();
  });
});

describe("rule 3: a failure, then silence", () => {
  test("the 2026-09-11 turn: ONE failed view_image and nothing after it", () => {
    expect(failedThenQuietTool(shape("x", "view_image"))).toBe("view_image");
  });

  test("not a candidate while a tool runs, or when the last call succeeded", () => {
    expect(failedThenQuietTool(shape("xr", ["view_image", "exec"]))).toBeNull();
    expect(failedThenQuietTool(shape("x.", ["view_image", "exec"]))).toBeNull();
    expect(failedThenQuietTool([])).toBeNull();
  });

  test("the verdict appears only after 2 minutes of silence, and says how long", () => {
    const facts = { kind: "failed_then_quiet" as const, tool: "view_image", quietSince: 1_000_000 };
    expect(turnDifficultyVerdict(facts, 1_000_000 + STALL_AFTER_FAILURE_MS - 1)).toBeNull();
    expect(turnDifficultyVerdict(facts, 1_000_000 + STALL_AFTER_FAILURE_MS)).toEqual({
      kind: "quiet_after_failure",
      tool: "view_image",
      quietMs: STALL_AFTER_FAILURE_MS,
    });
    expect(turnDifficultyRecheckAt(facts)).toBe(1_000_000 + STALL_AFTER_FAILURE_MS);
  });
});

describe("the verdict", () => {
  test("repeated failures need no clock; nothing yields nothing", () => {
    const facts = { kind: "repeated_failures" as const, tool: "browser", failures: 3, sameTool: true };
    expect(turnDifficultyVerdict(facts, 0)).toEqual(facts);
    expect(turnDifficultyRecheckAt(facts)).toBeNull();
    expect(turnDifficultyVerdict(null, 0)).toBeNull();
  });
});
