/// <reference types="vite/client" />
//
// The front's mirror of the bridge's failure classifier (convex/lib/failureText.ts) must give
// the SAME verdict as the bridge on every text — a stored row and a fresh one render alike
// only if the two readers of one sentence agree. Two guards:
//   1. LOCKSTEP: each mirrored pattern equals, source and flags, the bridge's literal of the
//      same name, read from the bridge's source; the precedence lists are equal.
//   2. PARITY: both classifiers, run on the shared upstream corpus and on extra texts, return
//      the same class.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import corpus from "../../bridge/test/fixtures/failure-text-corpus.json";
import {
  classifyFailureText as bridgeClassify,
  FAILURE_CLASS_PRECEDENCE as BRIDGE_PRECEDENCE,
  providerCredentialTextClass as bridgeCredential,
  unwrapGatewayFailure as bridgeUnwrap,
  withoutOperatorData as bridgeWithoutOperatorData,
} from "../../bridge/src/core/failure-classifier";
import {
  classifyStoredFailureText,
  FAILURE_CLASS_PRECEDENCE,
  MIRRORED_PATTERNS,
  providerCredentialTextClass,
  unwrapGatewayFailure,
  withoutOperatorData,
} from "./failureText";

const BRIDGE_SOURCE = readFileSync(
  new URL("../../bridge/src/core/failure-classifier.ts", import.meta.url),
  "utf-8",
);

/** The regex literal the bridge assigns to `name`, as written. */
function bridgeLiteral(name: string): string | null {
  const at = BRIDGE_SOURCE.search(new RegExp(`^const ${name}(?::[^=]*)? =`, "m"));
  if (at === -1) return null;
  const rest = BRIDGE_SOURCE.slice(at).replace(/^const [^=]*=\s*/, "");
  const end = rest.indexOf(";\n");
  return end === -1 ? null : rest.slice(0, end).trim();
}

type Case = { id: string; text: string; expected: string | null };
const CASES = (corpus as { cases: Case[] }).cases;

describe("lockstep — the mirror's patterns ARE the bridge's", () => {
  it("every mirrored pattern equals the bridge literal of the same name", () => {
    const drift: string[] = [];
    for (const [name, re] of Object.entries(MIRRORED_PATTERNS)) {
      const literal = bridgeLiteral(name);
      if (literal !== re.toString()) drift.push(`${name}: bridge ${literal} ≠ mirror ${re}`);
    }
    expect(drift).toEqual([]);
    expect(Object.keys(MIRRORED_PATTERNS).length).toBeGreaterThanOrEqual(45);
  });

  it("one precedence, both sides", () => {
    expect([...FAILURE_CLASS_PRECEDENCE]).toEqual([...BRIDGE_PRECEDENCE]);
  });
});

const EXTRA_TEXTS = [
  "maximum context length exceeded",
  "HTTP 401: Unauthorized",
  "HTTP 429: Too Many Requests",
  "fetch failed",
  "database is locked",
  "The turn was interrupted while the server was busy. Check its status before trying again.\n\nSQLite transaction admission remained busy. Execution may have occurred; check the recorded outcome before resending.",
  "Session \"agent:alice:x\" changed while starting work. Retry.",
  'Session "agent:alice:x" is archived. Restore it before starting new work.',
  'Session "agent:alice:x" is paused as a precaution. Review the provider findings in chat before continuing.',
  "Pending input is no longer active in its admitted transcript",
  "All models failed (2): openai/a: Pending input is no longer active in its admitted transcript (unknown) | openai/b: Pending input is no longer active in its admitted transcript (unknown)",
  "session writer claim changed before transcript persistence",
  "⚠️ Agent run failed: the transcript writer no longer owned this session. Retry in the current session; if it repeats, check Gateway logs.",
  "Agent database execution admission is closed",
  "child session patch failed: SQLite read-only worker failed: ENOSPC (code=ENOSPC)",
  "Preflight compaction required but failed: no conversation found for session",
  'MCP server "Re-authenticate with: x" failed to start.',
  'Auth profile "401: invalidated token" type mismatch for x.',
  "The AI service is temporarily overloaded. Please try again in a moment.",
  "",
];

describe("parity — the two classifiers agree on every text", () => {
  for (const c of CASES) {
    it(`corpus ${c.id}`, () => {
      expect(classifyStoredFailureText(c.text)).toBe(bridgeClassify(c.text));
      expect(classifyStoredFailureText(c.text)).toBe(c.expected);
    });
  }

  it("extra texts across every rule family", () => {
    for (const t of EXTRA_TEXTS) {
      expect(classifyStoredFailureText(t), t).toBe(bridgeClassify(t));
      expect(providerCredentialTextClass(t), t).toBe(bridgeCredential(t));
      expect(withoutOperatorData(t), t).toBe(bridgeWithoutOperatorData(t));
      expect(unwrapGatewayFailure(t), t).toEqual(bridgeUnwrap(t));
    }
  });
});
