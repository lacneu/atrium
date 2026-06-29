/// <reference types="vite/client" />
//
// SOC2 boundary tests for the content-free sub-agent failure projector.
//
// These pin the load-bearing invariants of the two-plane split:
//   (b) `classifySubAgentError` is an ALLOWLIST classifier — its output is ALWAYS
//       one of the fixed enum literals, NEVER a substring of the input. We feed a
//       unique sentinel into the error text and assert the sentinel never appears
//       in any classifier/projector output.
//   (a) `toSubAgentFailureStructure` emits ONLY {status enum, category enum,
//       counts, opaque id} — raw error text never crosses into the structure.
// The matching server-side test (subAgentReports.test.ts) asserts the same
// sentinel is absent from the emitted ANOMALY evidence + message.

import { describe, expect, it } from "vitest";
import {
  SUBAGENT_ERROR_CATEGORIES,
  type SubAgentErrorCategory,
  classifySubAgentError,
  isFailedStatus,
  shortChildId,
  toSubAgentFailureStructure,
} from "./subAgentFailure";

const ENUM = new Set<string>(SUBAGENT_ERROR_CATEGORIES);

describe("classifySubAgentError — allowlist classifier (never echoes input)", () => {
  it("maps aborted by STATUS alone (message ignored)", () => {
    expect(classifySubAgentError("aborted")).toBe("aborted");
    // Even an aborted child carrying a tool-failure-looking message stays aborted.
    expect(classifySubAgentError("aborted", "web_fetch failed (500)")).toBe(
      "aborted",
    );
  });

  it("maps the stale-observer reaper message (FR + EN) to timeout", () => {
    expect(
      classifySubAgentError(
        "error",
        "Sous-agent expiré — aucune activité, observateur probablement perdu",
      ),
    ).toBe("timeout");
    expect(classifySubAgentError("error", "child timed out after 120s")).toBe(
      "timeout",
    );
  });

  it("maps an HTTP status / rate-limit to api_error", () => {
    expect(classifySubAgentError("error", "request returned 429")).toBe(
      "api_error",
    );
    expect(classifySubAgentError("error", "Unauthorized (401)")).toBe(
      "api_error",
    );
    expect(classifySubAgentError("error", "rate limit exceeded")).toBe(
      "api_error",
    );
  });

  it("maps a generic tool/command failure to tool_failed", () => {
    expect(classifySubAgentError("error", "web_search failed (no results)")).toBe(
      "tool_failed",
    );
    expect(classifySubAgentError("error", "exec returned non-zero")).toBe(
      "tool_failed",
    );
  });

  it("falls back to unknown for an empty / unrecognized error", () => {
    expect(classifySubAgentError("error")).toBe("unknown");
    expect(classifySubAgentError("error", "   ")).toBe("unknown");
    expect(classifySubAgentError("error", "something inexplicable happened")).toBe(
      "unknown",
    );
  });

  it("ALWAYS returns one of the fixed enum literals (never the input)", () => {
    const SENTINEL = "PHI_LEAK_CANARY_零_42";
    const cases: { status: Parameters<typeof classifySubAgentError>[0]; msg: string }[] =
      [
        { status: "error", msg: `tool failed (500) ${SENTINEL}` },
        { status: "error", msg: `timed out ${SENTINEL}` },
        { status: "error", msg: `429 ${SENTINEL}` },
        { status: "aborted", msg: `${SENTINEL}` },
        { status: "error", msg: `${SENTINEL} only` },
      ];
    for (const c of cases) {
      const out: SubAgentErrorCategory = classifySubAgentError(c.status, c.msg);
      expect(ENUM.has(out)).toBe(true);
      // The classifier NEVER echoes the raw text.
      expect(out).not.toContain(SENTINEL);
    }
  });
});

describe("shortChildId — opaque id tail only", () => {
  it("returns the uuid segment after the last colon, truncated", () => {
    expect(shortChildId("agent:main:subagent:abcdef0123456789")).toBe(
      "abcdef012345",
    );
    expect(shortChildId("plainkey")).toBe("plainkey");
    expect(shortChildId("")).toBe("");
  });
});

describe("isFailedStatus", () => {
  it("is true only for error/aborted", () => {
    expect(isFailedStatus("error")).toBe(true);
    expect(isFailedStatus("aborted")).toBe(true);
    expect(isFailedStatus("running")).toBe(false);
    expect(isFailedStatus("done")).toBe(false);
  });
});

describe("toSubAgentFailureStructure — content-free projection", () => {
  it("projects counts + aligned per-child enums + opaque ids", () => {
    const s = toSubAgentFailureStructure([
      { childSessionKey: "agent:a:subagent:k1", status: "error", errorMessage: "429" },
      { childSessionKey: "agent:a:subagent:k2", status: "aborted" },
      { childSessionKey: "agent:a:subagent:k3", status: "done" },
    ]);
    expect(s.totalCount).toBe(3);
    expect(s.failedCount).toBe(2);
    expect(s.statuses).toEqual(["error", "aborted", "done"]);
    expect(s.errorCategories).toEqual(["api_error", "aborted", "unknown"]);
    expect(s.childIdShort).toEqual(["k1", "k2", "k3"]);
  });

  it("NEVER includes raw error text in the projected structure (sentinel absent)", () => {
    const SENTINEL = "PHI_LEAK_CANARY_零_42";
    const s = toSubAgentFailureStructure([
      {
        childSessionKey: "agent:a:subagent:k1",
        status: "error",
        errorMessage: `secret tool failure ${SENTINEL}`,
      },
    ]);
    // The entire serialized projection must be free of the raw error content.
    expect(JSON.stringify(s)).not.toContain(SENTINEL);
    expect(s.errorCategories[0]).toBe("tool_failed");
  });

  it("handles the empty set", () => {
    const s = toSubAgentFailureStructure([]);
    expect(s).toEqual({
      totalCount: 0,
      failedCount: 0,
      statuses: [],
      errorCategories: [],
      childIdShort: [],
    });
  });
});
