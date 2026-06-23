import { describe, expect, it } from "vitest";
import { m } from "@/paraglide/messages.js";
import {
  formatToolResult,
  toolActivitySummary,
  toolOutcomeLabel,
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

describe("formatToolResult", () => {
  it("classifies a bare exec envelope as an OUTCOME (the stdout is not sent)", () => {
    // The verified 2026.6.5/2026.6.8 bash result: envelope-only, no stdout.
    const v = formatToolResult({
      status: "completed",
      exitCode: 0,
      durationMs: 15,
    });
    expect(v).toEqual({
      kind: "outcome",
      status: "completed",
      exitCode: 0,
      durationMs: 15,
    });
  });

  it("treats a string result as real text output", () => {
    expect(formatToolResult("hello\nworld")).toEqual({
      kind: "text",
      text: "hello\nworld",
    });
  });

  it("keeps a RICH object (web_search) as full JSON, never an outcome", () => {
    const v = formatToolResult({
      status: "completed",
      query: "x",
      queries: ["x"],
    });
    expect(v.kind).toBe("json");
    // Delete the discriminator -> the non-envelope key still forces json (proves
    // the test isn't passing on the `status` key alone).
    expect(formatToolResult({ queries: ["x"] }).kind).toBe("json");
  });

  it("does NOT treat a non-exec result lacking exitCode as an outcome (renders its JSON)", () => {
    // A non-exec tool whose result merely happens to be {status} / {status,
    // durationMs} must show its real JSON, NOT a misleading exec outcome.
    expect(formatToolResult({ status: "completed" }).kind).toBe("json");
    expect(
      formatToolResult({ status: "completed", durationMs: 5 }).kind,
    ).toBe("json");
    // ...but the real exec envelope (with exitCode) IS an outcome.
    expect(
      formatToolResult({ status: "completed", exitCode: 0, durationMs: 5 }).kind,
    ).toBe("outcome");
  });

  it("is forward-compatible: an envelope WITH stdout shows it (json), not an outcome", () => {
    // If a FUTURE gateway adds the stdout alongside the envelope, the extra key
    // must surface the real output rather than collapse to the outcome line.
    const v = formatToolResult({
      status: "completed",
      exitCode: 0,
      durationMs: 15,
      output: "the real stdout",
    });
    expect(v.kind).toBe("json");
    expect(v.kind === "json" && v.text.includes("the real stdout")).toBe(true);
  });
});

// Assert via the i18n functions (not accented literals) so the source stays
// ASCII (the i18n ratchet) AND the test is locale-independent: it pins the BRANCH
// (completed vs failed head) + the inclusion/omission of exit & duration, not the
// French spelling (which the messages/ files + the parity test already cover).
describe("toolOutcomeLabel", () => {
  it("SUCCESS branch: completed head + exit + duration, in order", () => {
    const label = toolOutcomeLabel({
      status: "completed",
      exitCode: 0,
      durationMs: 15,
    });
    expect(label.startsWith(m.tools_outcome_completed())).toBe(true);
    expect(label).not.toContain(m.tools_outcome_failed());
    expect(label).toContain(m.tools_outcome_exit({ code: 0 })); // "exit 0"
    expect(label).toContain(m.tools_outcome_ms({ ms: 15 })); // "15 ms"
  });

  it("FAILURE branch (status failed, exit != 0): failed head, null duration omitted", () => {
    const label = toolOutcomeLabel({
      status: "failed",
      exitCode: 1,
      durationMs: null,
    });
    expect(label.startsWith(m.tools_outcome_failed())).toBe(true);
    expect(label).toContain(m.tools_outcome_exit({ code: 1 }));
    expect(label).not.toContain(" ms"); // duration omitted when null
  });

  it("exitCode 0 forces SUCCESS even when status is not 'completed'", () => {
    const label = toolOutcomeLabel({ status: "x", exitCode: 0, durationMs: 3 });
    expect(label.startsWith(m.tools_outcome_completed())).toBe(true);
  });

  it("a NON-ZERO exitCode is FAILURE even when status is 'completed' (the call finished, the command failed)", () => {
    const label = toolOutcomeLabel({
      status: "completed",
      exitCode: 1,
      durationMs: 3,
    });
    expect(label.startsWith(m.tools_outcome_failed())).toBe(true);
  });

  it("falls back to status only when there is NO exitCode", () => {
    expect(
      toolOutcomeLabel({
        status: "completed",
        exitCode: null,
        durationMs: null,
      }).startsWith(m.tools_outcome_completed()),
    ).toBe(true);
    expect(
      toolOutcomeLabel({
        status: "failed",
        exitCode: null,
        durationMs: null,
      }).startsWith(m.tools_outcome_failed()),
    ).toBe(true);
  });
});
