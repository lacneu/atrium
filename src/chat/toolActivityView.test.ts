import { describe, expect, it } from "vitest";
import {
  toolActivitySummary,
  toolPreview,
  type ToolActivityPart,
} from "./toolActivityView";

// Pure-logic tests for the ToolActivity summary line (count label + running
// state). Tests run with the baseLocale ("fr" — see vitest.setup.ts), so the
// label assertions are deterministic French strings.
//
// GC-P5 lesson: a parameterized i18n message rendered behind a branch must
// have EVERY branch exercised (tsc/parity alone don't verify the rendering),
// hence explicit singular AND plural label assertions.

function part(overrides: Partial<ToolActivityPart> = {}): ToolActivityPart {
  return {
    toolCallId: "m1:run:0",
    toolName: "web_search",
    phase: "running",
    ...overrides,
  };
}

describe("toolActivitySummary label (i18n singular/plural branches)", () => {
  it("uses the SINGULAR message for exactly one tool call", () => {
    const view = toolActivitySummary([part()], "streaming");
    expect(view.count).toBe(1);
    expect(view.label).toBe("1 appel d'outil");
  });

  it("uses the PLURAL message for several tool calls", () => {
    const parts = [part(), part({ toolCallId: "m1:run:1" }), part({ toolCallId: "m1:run:2" })];
    const view = toolActivitySummary(parts, "complete");
    expect(view.count).toBe(3);
    expect(view.label).toBe("3 appels d'outils");
  });

  it("uses the PLURAL message for zero tool calls (component renders nothing anyway)", () => {
    const view = toolActivitySummary([], "streaming");
    expect(view.count).toBe(0);
    expect(view.label).toBe("0 appels d'outils");
  });
});

describe("toolActivitySummary running state", () => {
  it("is running while the message streams", () => {
    expect(toolActivitySummary([part()], "streaming").running).toBe(true);
    // Even when every tool already settled — the turn may still add more.
    expect(
      toolActivitySummary(
        [part({ phase: "completed", result: { ok: true } })],
        "streaming",
      ).running,
    ).toBe(true);
  });

  it("is settled on every terminal message status", () => {
    for (const status of ["complete", "error", "aborted"]) {
      // Last tool has NO result: the terminal message status must still win.
      expect(toolActivitySummary([part()], status).running).toBe(false);
    }
  });

  it("falls back to the last tool part when the status is unknown", () => {
    // No result + non-terminal phase -> still running.
    expect(toolActivitySummary([part()], undefined).running).toBe(true);
    // Terminal phase -> settled.
    expect(
      toolActivitySummary([part({ phase: "completed" })], undefined).running,
    ).toBe(false);
    expect(
      toolActivitySummary([part({ phase: "error" })], undefined).running,
    ).toBe(false);
    // A result present -> settled even without a terminal phase.
    expect(
      toolActivitySummary([part({ result: { ok: true } })], undefined).running,
    ).toBe(false);
  });

  it("is never running without tool parts", () => {
    expect(toolActivitySummary([], "streaming").running).toBe(false);
    expect(toolActivitySummary([], undefined).running).toBe(false);
  });
});

describe("toolPreview (one-line header preview of a tool's input)", () => {
  it("prefers a Bash/exec command", () => {
    expect(
      toolPreview({ command: "find /media/inbound -name '*.csv'", cwd: "/ws" }, undefined),
    ).toBe("find /media/inbound -name '*.csv'");
  });

  it("walks the priority keys (query > url > path …) for non-Bash tools", () => {
    expect(toolPreview({ query: "Fable 5 blocked" }, undefined)).toBe("Fable 5 blocked");
    expect(toolPreview({ url: "https://x.test/a" }, undefined)).toBe("https://x.test/a");
    expect(toolPreview({ path: "/etc/hosts" }, undefined)).toBe("/etc/hosts");
  });

  it("collapses whitespace/newlines to a single line", () => {
    expect(toolPreview({ command: "a\n  b\t c" }, undefined)).toBe("a b c");
  });

  it("falls back to argsText, then to a string arg, else empty", () => {
    expect(toolPreview({ unknownKey: 1 }, '{"x":1}')).toBe('{"x":1}');
    expect(toolPreview("raw string input", undefined)).toBe("raw string input");
    expect(toolPreview({ unknownKey: 1 }, undefined)).toBe("");
    expect(toolPreview(undefined, undefined)).toBe("");
  });
});
