// A rebuilt card's error outcome, read as the Control UI reads a history result (0.101.2
// audit; ui/src/pages/chat/components/chat-tool-cards.outcome.test.ts:270, :291;
// src/chat/tool-content.ts:59-116).
import { describe, expect, it } from "vitest";
import { rowBlocks } from "../src/providers/openclaw/row-blocks.js";
import {
  historyToolResultFailed,
  isToolErrorOutput,
  isToolResultError,
} from "../src/providers/openclaw/tool-error.js";

const SK = "agent:main:atrium:chat:u:c1";
const statusOf = (message: unknown) =>
  rowBlocks(message, SK).blocks.filter((b) => b.type === "tool").map((b) => (b as { status?: string }).status);

describe("isToolErrorOutput (upstream tool-content.ts:72-116)", () => {
  it("the literal 'Tool not found' and the JSON error shapes", () => {
    expect(isToolErrorOutput("Tool not found")).toBe(true);
    expect(isToolErrorOutput("tool not found.")).toBe(true);
    expect(isToolErrorOutput(JSON.stringify({ status: "error" }))).toBe(true);
    expect(isToolErrorOutput(JSON.stringify({ status: "Timeout" }))).toBe(true);
    expect(isToolErrorOutput(JSON.stringify({ error: "Cannot connect to the service" }))).toBe(true);
    expect(isToolErrorOutput(JSON.stringify({ error: "" }))).toBe(false);
    expect(isToolErrorOutput(JSON.stringify({ is_error: true }))).toBe(true);
    expect(isToolErrorOutput(JSON.stringify({ isError: false, status: "error" }))).toBe(false);
    expect(isToolErrorOutput("all good")).toBe(false);
    expect(isToolErrorOutput(JSON.stringify({ status: "completed" }))).toBe(false);
  });
  it("the result's flag, else its message's, else the output text", () => {
    expect(historyToolResultFailed({ is_error: true }, {})).toBe(true);
    expect(historyToolResultFailed({}, { isError: true })).toBe(true);
    expect(historyToolResultFailed({ isError: false, content: "Tool not found" }, {})).toBe(false);
    expect(historyToolResultFailed({ content: [{ type: "text", text: "Tool not found" }] }, {})).toBe(true);
  });
});

// Upstream src/agents/tool-result-error.test.ts:18-39, as is.
describe("isToolResultError", () => {
  it("keeps completed results with nonzero exit codes nonfatal", () => {
    expect(isToolResultError({ details: { status: "completed", exitCode: 1 } })).toBe(false);
    expect(isToolResultError({ details: { status: "completed", exitCode: 2 } })).toBe(false);
    expect(isToolResultError({ details: { status: "completed", exitCode: 0 } })).toBe(false);
  });

  it("keeps real failures fatal even with a completed status", () => {
    expect(isToolResultError({ details: { status: "completed", timedOut: true } })).toBe(true);
    expect(isToolResultError({ details: { status: "completed", error: "spawn failed" } })).toBe(
      true,
    );
    expect(isToolResultError({ details: { ok: false, status: "completed" } })).toBe(true);
  });

  it("keeps failure statuses and statusless nonzero exits fatal", () => {
    expect(isToolResultError({ details: { status: "failed", exitCode: 1 } })).toBe(true);
    expect(isToolResultError({ details: { status: "failed", exitCode: 127 } })).toBe(true);
    expect(isToolResultError({ details: { status: "killed", exitCode: 137 } })).toBe(true);
    expect(isToolResultError({ details: { exitCode: 1 } })).toBe(true);
  });
});

describe("structured details decide; the text only when there are none (final review)", () => {
  it("an exec that exits 0 printing an error-shaped JSON is a success", () => {
    expect(
      statusOf({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "exec",
        content: [{ type: "text", text: JSON.stringify({ error: "rate limited" }) }],
        details: { status: "completed", exitCode: 0 },
      }),
    ).toEqual(["result"]);
  });
  it("a refused sessions_send (details.status forbidden), ok:false, timedOut: failures", () => {
    for (const details of [{ status: "forbidden" }, { status: "blocked" }, { status: "denied" }, { status: "unavailable" }, { ok: false }, { timedOut: true }, { error: "no" }]) {
      expect(
        statusOf({ role: "toolResult", toolCallId: "c1", toolName: "sessions_send", content: "refused", details }),
        JSON.stringify(details),
      ).toEqual(["error"]);
    }
  });
  it("a flag that says failed always wins", () => {
    expect(historyToolResultFailed({ isError: true, details: { status: "completed" } }, {})).toBe(true);
  });
});

describe("a rebuilt card's status", () => {
  it("a toolresult row: `is_error` (the legacy spelling), a status-only payload, 'Tool not found'", () => {
    expect(statusOf({ role: "toolResult", toolCallId: "c1", toolName: "exec", is_error: true, content: "boom" })).toEqual(["error"]);
    expect(statusOf({ role: "toolResult", toolCallId: "c1", toolName: "sessions_spawn", content: JSON.stringify({ status: "error" }) })).toEqual(["error"]);
    expect(statusOf({ role: "toolResult", toolCallId: "c1", toolName: "Unknown", content: "Tool not found" })).toEqual(["error"]);
    expect(statusOf({ role: "toolResult", toolCallId: "c1", toolName: "exec", content: "ok" })).toEqual(["result"]);
  });
  it("an assistant row's result item: its own flag, else the message's", () => {
    const msg = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      role: "assistant",
      ...extra,
      content: [
        { type: "toolCall", id: "c1", name: "read", arguments: {} },
        { type: "toolResult", id: "c1", name: "read", ...item },
      ],
    });
    expect(statusOf(msg({ is_error: true, content: "x" }))).toEqual(["call", "error"]);
    expect(statusOf(msg({ content: "x" }, { isError: true }))).toEqual(["call", "error"]);
    expect(statusOf(msg({ content: JSON.stringify({ error: { code: 1 } }) }))).toEqual(["call", "error"]);
    expect(statusOf(msg({ content: "x" }))).toEqual(["call", "result"]);
  });
});
