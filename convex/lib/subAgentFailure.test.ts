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

  // A REAPER's verdict is not a timeout. Convex's stale-row reaper and the bridge's sweep
  // give up on a child they saw NOTHING from — a frozen bridge, a reconnect, or a child
  // that never started — and say so with a stored code. Prod 2026-09-28 (chat mh7d6db7…,
  // child fb081174): published `timeout` for a child nobody ever saw time out.
  it("a reaper's NO-ACTIVITY code is its own category, whatever its prose says", () => {
    expect(
      classifySubAgentError(
        "error",
        "Sous-agent expiré — aucune activité, observateur probablement perdu",
        "subagent_no_activity",
      ),
    ).toBe("no_activity");
    expect(
      classifySubAgentError(
        "error",
        "Sub-agent timed out: no activity for 900s and the gateway never reported it finishing.",
        "subagent_no_activity",
      ),
    ).toBe("no_activity");
    // A limit the GATEWAY enforced stays a timeout.
    expect(classifySubAgentError("error", "Run timed out after 600s", "timeout")).toBe(
      "timeout",
    );
    // A row reaped BEFORE the code existed keeps the category it was published under:
    // nothing on it says which it was, and prose is exactly what the code replaces.
    expect(
      classifySubAgentError(
        "error",
        "Sous-agent expiré — aucune activité, observateur probablement perdu",
      ),
    ).toBe("timeout");
  });

  // Production 2026-09-23: two spawns the gateway refused ("child session patch
  // failed…") were registered as running, then a watchdog wrote "timed out" over
  // them and the diagnostic published `timeout`. The row's stable class decides,
  // whatever the prose says.
  it("a refused spawn is `spawn_refused`, even under a timeout-sounding sentence", () => {
    expect(
      classifySubAgentError(
        "error",
        "Sub-agent timed out: no activity for 900s and the gateway never reported it finishing.",
        "spawn_refused",
      ),
    ).toBe("spawn_refused");
    expect(
      toSubAgentFailureStructure([
        {
          childSessionKey: "agent:a:subagent:0000",
          status: "error",
          errorMessage: "child session patch failed: synthetic",
          errorCode: "spawn_refused",
        },
      ]).errorCategories,
    ).toEqual(["spawn_refused"]);
  });

  // Production 2026-09-28: children the gateway retired with "Agent database execution
  // admission is closed" were published `unknown`; and a full gateway disk's staging
  // sentence says "free disk space/quota", which `quota` alone read as an API error.
  it("names the two gateway-side refusals, by the row's class first", () => {
    expect(classifySubAgentError("error", "anything", "gateway_agent_db_closed")).toBe(
      "gateway_agent_db_closed",
    );
    expect(classifySubAgentError("error", "rate limit 429", "gateway_storage_unavailable")).toBe(
      "gateway_storage_unavailable",
    );
  });

  it("…and by the text for a row stored before the class existed", () => {
    expect(classifySubAgentError("error", "Agent database execution admission is closed")).toBe(
      "gateway_agent_db_closed",
    );
    expect(
      classifySubAgentError(
        "error",
        'Agent alice has not completed startup inspection and preparation. x\nSessions remain unavailable until background inspection and preparation finish. If they cannot complete, stop the Gateway, run "openclaw doctor --fix", and restart.',
      ),
    ).toBe("gateway_agent_db_closed");
    expect(
      classifySubAgentError(
        "error",
        "SQLite read-only worker failed while creating its private snapshot: ENOSPC: no space left on device, mkdtemp '[path]'; snapshot staging root [path]: free disk space/quota or set XDG_CACHE_HOME to a writable filesystem (code=ENOSPC)",
      ),
    ).toBe("gateway_storage_unavailable");
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

describe("a profile NAME cannot choose the category", () => {
  it("the operator-chosen id is stripped before the patterns run", () => {
    // A row written before the masker existed still holds the id, and the id is
    // whatever an operator called the profile. Without the strip, a profile named
    // `timeout` picked the category published in the anomaly and the diagnostic — the
    // same family as the bridge classifier's defect (codex).
    for (const [name, expected] of [
      ["timeout", "unknown"],
      ["rate limit exceeded", "unknown"],
      ["tool failed", "unknown"],
    ] as const) {
      expect(
        classifySubAgentError(
          "error",
          `Auth profile "${name}" is temporarily unavailable for openai/m.`,
        ),
        name,
      ).toBe(expected);
    }
    // …and a quoted value in ANY sentence, not only a credential one: the display mask
    // left every other one free to pick the category (codex).
    expect(
      classifySubAgentError("error", 'Session "agent:timeout:x" was deleted.'),
    ).toBe("unknown");
    // …while a real timeout, with no profile name in it, still classifies.
    expect(classifySubAgentError("error", "the child timed out after 100 tool calls")).toBe(
      "timeout",
    );
  });
});
