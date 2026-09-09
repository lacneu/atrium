/// <reference types="vite/client" />
//
// Pure shared render-state + PHI-redaction helpers (convex/lib/chatRenderState).
// These are the SINGLE SOURCE for both the frontend run-status chip and the
// key-authed diagnostic projection, so pinning them here pins both.

import { describe, expect, test } from "vitest";
import {
  runStatusKind,
  textLenBucket,
  normalizeMessageErrorCode,
  mimeTypeBase,
  summarizeToolActivity,
} from "./lib/chatRenderState";

describe("runStatusKind (shared client/API derivation)", () => {
  test("maps every lifecycle state the client renders", () => {
    expect(runStatusKind(undefined, false)).toBe("thinking"); // optimistic placeholder
    expect(runStatusKind("streaming", false)).toBe("thinking");
    expect(runStatusKind("streaming", true)).toBe("generating");
    expect(runStatusKind("error", false)).toBe("error");
    expect(runStatusKind("aborted", false)).toBe("aborted");
    expect(runStatusKind("complete", true)).toBeNull();
    expect(runStatusKind("weird", false)).toBeNull();
  });
});

describe("textLenBucket (no exact length leaves)", () => {
  test("coarse buckets", () => {
    expect(textLenBucket(0)).toBe("0");
    expect(textLenBucket(50)).toBe("1-100");
    expect(textLenBucket(100)).toBe("1-100");
    expect(textLenBucket(500)).toBe("101-1k");
    expect(textLenBucket(1000)).toBe("101-1k");
    expect(textLenBucket(5000)).toBe("1k+");
  });
});

describe("normalizeMessageErrorCode (raw gateway text never leaves)", () => {
  test("known codes pass; anything else collapses to 'unknown'", () => {
    expect(normalizeMessageErrorCode("stream_orphaned")).toBe("stream_orphaned");
    expect(normalizeMessageErrorCode("gateway_timeout")).toBe("gateway_timeout");
    // Newly allowlisted infra + gateway-errorKind classes reach the obs MCP.
    expect(normalizeMessageErrorCode("connection_lost")).toBe("connection_lost");
    expect(normalizeMessageErrorCode("context_length")).toBe("context_length");
    expect(normalizeMessageErrorCode("rate_limit")).toBe("rate_limit");
    expect(normalizeMessageErrorCode("Patient Jean Dupont not found at /records")).toBe(
      "unknown",
    );
    expect(normalizeMessageErrorCode(null)).toBeNull();
    expect(normalizeMessageErrorCode("")).toBeNull();
  });
});

describe("mimeTypeBase (strips the filename-leaking name= param)", () => {
  test("keeps the base type only", () => {
    expect(mimeTypeBase('application/pdf; name="jean_dupont_biopsy.pdf"')).toBe(
      "application/pdf",
    );
    expect(mimeTypeBase("image/png")).toBe("image/png");
    expect(mimeTypeBase(null)).toBeNull();
    expect(mimeTypeBase(undefined)).toBeNull();
  });
});

describe("summarizeToolActivity (the repetition shape of one turn)", () => {
  const tool = (name: string, phase = "completed") => ({
    kind: "tool",
    name,
    phase,
  });

  test("a turn that called no tool has NO aggregate, not a zero-filled one", () => {
    // An absent aggregate says "no tool activity". Zeros would read as "tools
    // that did nothing", which is a different fact.
    expect(summarizeToolActivity([])).toBeNull();
    expect(
      summarizeToolActivity([{ kind: "reasoning" }, { kind: "plan" }]),
    ).toBeNull();
  });

  test("counts calls, errors and DISTINCT tools", () => {
    const got = summarizeToolActivity([
      tool("web_search"),
      tool("web_search", "error"),
      tool("web_fetch"),
      { kind: "media" }, // not a tool
    ]);
    expect(got).toMatchObject({ calls: 3, errors: 1, distinctTools: 2 });
  });

  test("only tools called MORE THAN ONCE are named, most repeated first", () => {
    const got = summarizeToolActivity([
      tool("read"),
      tool("web_search"),
      tool("web_search", "error"),
      tool("web_search"),
      tool("exec"),
      tool("exec"),
    ]);
    // `read` ran once — it is not a repetition and does not clutter the list.
    expect(got?.repeatedTools).toEqual([
      { name: "web_search", calls: 3, errors: 1 },
      { name: "exec", calls: 2, errors: 0 },
    ]);
    expect(got?.repeatedToolsTruncated).toBe(false);
  });

  test("the same COUNTS over a different order are not the same turn", () => {
    // This is what a per-name count cannot say, and it is the loop signal:
    // four calls of one tool back to back, versus the same four alternating.
    const inARow = summarizeToolActivity([
      tool("web_search"),
      tool("web_search"),
      tool("web_search"),
      tool("web_search"),
      tool("read"),
    ]);
    const alternating = summarizeToolActivity([
      tool("web_search"),
      tool("read"),
      tool("web_search"),
      tool("read"),
      tool("web_search"),
    ]);
    expect(inARow?.longestSameToolRun).toEqual({
      name: "web_search",
      length: 4,
    });
    expect(alternating?.longestSameToolRun).toEqual({
      name: "web_search",
      length: 1,
    });
  });

  test("a long repeated list is CUT and says so", () => {
    // A silent truncation would let a caller read the list as exhaustive.
    const parts = [];
    for (let i = 0; i < 10; i++) {
      parts.push(tool(`tool_${i}`), tool(`tool_${i}`));
    }
    const got = summarizeToolActivity(parts);
    expect(got?.repeatedTools).toHaveLength(8);
    expect(got?.repeatedToolsTruncated).toBe(true);
    // The counts stay TOTAL even though the list is cut.
    expect(got).toMatchObject({ calls: 20, distinctTools: 10 });
  });

  test("the prod shape it exists for: 60 calls over two tools", () => {
    // Anomaly 2026-08-24: an agent ran 60 tool calls against an instruction
    // capping it at 25, dominated by repeated web_search with failing fetches —
    // and nothing reported the shape. No threshold is asserted here: what counts
    // as too much belongs to the agent's instructions, not to this projection.
    const parts = [];
    for (let i = 0; i < 55; i++) parts.push(tool("web_search"));
    for (let i = 0; i < 5; i++) parts.push(tool("web_fetch", "error"));
    const got = summarizeToolActivity(parts);
    expect(got).toMatchObject({
      calls: 60,
      errors: 5,
      distinctTools: 2,
      longestSameToolRun: { name: "web_search", length: 55 },
    });
  });
});
