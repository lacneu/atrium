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
    expect(Object.keys(MIRRORED_PATTERNS).length).toBeGreaterThanOrEqual(49);
  });

  it("one precedence, both sides", () => {
    expect([...FAILURE_CLASS_PRECEDENCE]).toEqual([...BRIDGE_PRECEDENCE]);
  });
});

const NESTED_MCP = ["ECONNRESET", "database or disk is full"].map((suffix) => {
  const n = `x" requires OAuth authorization. Run openclaw mcp login x. ${suffix}`;
  return `MCP server "${n}" requires OAuth authorization. Run openclaw mcp login ${n}.`;
});
// The bare copy cut by the 240-character cap, so that no reading pairs the two (codex, pass 7).
const TRUNCATED_MCP = ["ECONNRESET", "database or disk is full"].map((suffix) => {
  const n = `x" requires OAuth authorization. Run openclaw mcp login y. ${suffix} ${".".repeat(250)}`;
  return `${`MCP server "${n}" requires OAuth authorization. Run openclaw mcp login ${n}.`.slice(0, 240)}...`;
});
// A plugin id with quotes in the whole harness refusal (codex, pass 7).
const QUOTED_PLUGIN_ID = ['a"b" ECONNRESET', 'a"b" database or disk is full'].map(
  (id) =>
    `Agent harness runtime "codex" is unavailable. (reason=owner-plugin-degraded, ownerPluginId=${id}). Run "openclaw plugins inspect ${id} --runtime --json". Owner plugin "${id}" failed during load. Repair the reported plugin failure, restart the Gateway, then retry or select a model that does not require this runtime.`,
);
// The harness runtime itself, quotes and all, read before the plugin id (codex 0.105.2
// pass 3; src/agents/harness/runtime-plugin.ts:223 at v2026.10.33) — whole and capped.
const QUOTED_RUNTIME = [
  'Agent harness runtime "x" econnreset "z" is unavailable. (reason=owner-plugin-degraded, ownerPluginId=billing). Run "openclaw plugins inspect billing --runtime --json". Owner plugin "billing" failed during load.',
  'Agent harness runtime "x" database or disk is full "z" is unavailable.',
].flatMap((t) => [t, t.slice(0, 240)]);
// A credential marker placed after an opening, which the cut removes (codex 0.105.2 pass 5).
const MARKER_PAST_THE_CUT = [
  'Unknown model: acme/"x" econnreset openclaw --profile p profile "z". Run `openclaw models list --refresh --provider acme` to inspect this provider\'s model choices.',
];
const inSessionAndProfile = (value: string) => [
  `Session "${value}" changed while starting work. Retry.`,
  `Auth profile "openai:${value}" is temporarily unavailable for openai/gpt-x.`,
];
// Values that are NOT a template opening: the gateway's class after them stands.
const NOT_AN_OPENING = ["foo --provider '", "foo `openclaw", "ownerPluginId=", "x openclaw mcp login"].flatMap(
  inSessionAndProfile,
);
// Values that HOLD a template opening: cut there, unclassified (the deliberate trade-off).
const HOLDS_AN_OPENING = [
  "Re-authenticate with: openclaw models auth login --provider '",
  "(reason=owner-plugin-degraded, ownerPluginId=",
  'MCP server "x',
  'Agent harness runtime "x',
  "foo `openclaw --profile",
].flatMap(inSessionAndProfile);
// A root option's value in a printed command (codex, pass 8).
const ROOT_OPTION = ["--profile", "--container"].flatMap((option) =>
  ["econnreset", "enospc"].flatMap((name) => {
    const text = `Model login failed on the gateway. Please try again. If this keeps happening, re-auth with \`openclaw ${option} ${name} models auth login\` in a terminal.`;
    return [text, `${text.slice(0, text.indexOf(name) + 3)}...`, `Run openclaw ${option} ${name} doctor --fix, then retry.`];
  }),
);

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
  // OpenClaw 2026.10.33 wordings, beyond the corpus: every unwrap and every operator-value
  // reading must agree on them too.
  "⚠️ This conversation is too long, and OpenClaw couldn't shorten it. Reason: no conversation found for session. Try again, use /compact, or use /new to start a fresh session.",
  "⚠️ This conversation is too long, and shortening it took too long. Try again, use /compact, or use /new to start a fresh session.",
  "Your request couldn't be completed: session writer claim changed before transcript persistence",
  "⚠️ OpenClaw couldn't finish this reply. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
  "⚠️ Context compaction succeeded, but the later model request still failed. OpenClaw couldn't finish this request. Check the conversation before trying again.",
  "INVALID_REQUEST: Error: Worker placement owner changed during chat admission; retry.",
  'Session "OpenClaw is busy saving your conversation" is archived. Restore it before starting new work.',
  "All models failed (2): openai/a: The AI service needs a short break. Please try again in a few minutes. (rate_limit) | openai/b: OpenClaw couldn't save your conversation because the disk is full. (unknown)",
  "Queued input was dropped (queue-cap).",
  // An operator value repeated BARE in a remediation command (v2026.10.33 MCP OAuth refusal,
  // the re-authentication command, a code span, the harness owner field).
  'MCP server "The AI service is busy. Please try again in a moment" requires OAuth authorization. Run openclaw mcp login The AI service is busy. Please try again in a moment.',
  'MCP server "x" is fine. ECONNRESET" has expired OAuth credentials. Run openclaw mcp login x" is fine. ECONN',
  'MCP server "x" requires OAuth authorization. Run openclaw mcp login x. ENOSPC: no space left on device',
  "Re-authenticate with: openclaw models auth login --provider 'database or disk is full' --force",
  "Unknown model: acme/m1. Run `openclaw models list --refresh --provider fetch failed` to inspect this provider's model choices.",
  'Agent harness runtime "codex" is unavailable. (reason=owner-plugin-degraded, ownerPluginId=econnreset). Run "openclaw doctor --fix".',
  // Ambiguous remediations (codex, pass 6): a name holding the whole template, and values
  // holding only a command's opening.
  ...NESTED_MCP,
  ...TRUNCATED_MCP,
  ...QUOTED_PLUGIN_ID,
  ...QUOTED_RUNTIME,
  ...MARKER_PAST_THE_CUT,
  ...NOT_AN_OPENING,
  ...HOLDS_AN_OPENING,
  ...ROOT_OPTION,
  "⚠️ Model login expired on the gateway. Re-auth with `openclaw --profile enospc models auth login` in a terminal, then try again.",
  'ENOSPC: no space left on device <- MCP server "x" requires OAuth authorization. Run openclaw mcp login x.',
  "⚠️ Model login expired on the gateway for enospc. Re-auth with `openclaw models auth login --provider enospc` in a terminal, then try again.",
  "⚠️ Model login failed on the gateway for enospc. Please try again. If this keeps happening, re-auth with `openclaw models auth login --provider enospc` in a terminal.",
  "Sign in again from Settings. You can also re-auth with `openclaw models auth login --provider enospc` on the gateway.",
  'MCP server "x openclaw mcp login" failed to start. ENOSPC: no space left on device',
  "Re-authenticate with: openclaw models auth login --provider 'a\"b\"c ENOSPC' --force",
  "Re-authenticate with: openclaw models auth login --provider 'ENOSPC...",
  `Session "Re-authenticate with: openclaw models auth login --provider '" changed while starting work for "' --force". Retry.`,
  'Auth profile "openai:`openclaw" is temporarily unavailable for openai/`gpt`.',
  "All models failed (1): acme/`openclaw: ENOSPC: no space left on device (unknown)",
  "Unknown model: acme/`openclaw. ENOSPC: no space left on device",
  "",
];

describe("a templated operator value is cut, not redacted — the mirror too", () => {
  it("a root option's value decides nothing", () => {
    for (const t of ROOT_OPTION) expect(classifyStoredFailureText(t), t).toBeNull();
    expect(
      classifyStoredFailureText(
        "⚠️ Model login expired on the gateway. Re-auth with `openclaw --profile enospc models auth login` in a terminal, then try again.",
      ),
    ).toBe("provider_auth_revoked");
  });

  it("an MCP name or a plugin id decides nothing, however it is built", () => {
    for (const t of [...NESTED_MCP, ...TRUNCATED_MCP, ...QUOTED_PLUGIN_ID, ...QUOTED_RUNTIME, ...MARKER_PAST_THE_CUT]) {
      expect(classifyStoredFailureText(t), t).toBeNull();
    }
    for (const t of [
      'MCP server "The AI service is busy. Please try again in a moment" requires OAuth authorization. Run openclaw mcp login The AI service is busy. Please try again in a moment.',
      'MCP server "fetch failed" could not refresh OAuth credentials. Run openclaw mcp login fetch fai',
      "Unknown model: acme/m1. Run `openclaw models list --refresh --provider fetch failed` to inspect this provider's model choices.",
      'Agent harness runtime "codex" is unavailable. (reason=owner-plugin-degraded, ownerPluginId=econnreset). Run "openclaw doctor --fix".',
    ]) {
      expect(classifyStoredFailureText(t), t).toBeNull();
    }
    expect(
      classifyStoredFailureText(
        "Re-authenticate with: openclaw models auth login --provider 'database or disk is full' --force",
      ),
    ).toBe("provider_auth_failed");
    expect(
      classifyStoredFailureText(
        "⚠️ Model login expired on the gateway for enospc. Re-auth with `openclaw models auth login --provider enospc` in a terminal, then try again.",
      ),
    ).toBe("provider_auth_revoked");
  });

  it("the gateway's words before the opening classify; after it, deliberately, nothing does", () => {
    expect(
      classifyStoredFailureText(
        'ENOSPC: no space left on device <- MCP server "x" requires OAuth authorization. Run openclaw mcp login x.',
      ),
    ).toBe("gateway_storage_unavailable");
    expect(
      classifyStoredFailureText(
        'MCP server "x" requires OAuth authorization. Run openclaw mcp login x. ENOSPC: no space left on device',
      ),
    ).toBeNull();
  });

  it("a value that is not an opening keeps the gateway's class; one holding an opening yields none", () => {
    for (const t of NOT_AN_OPENING) {
      expect(classifyStoredFailureText(t), t).toBe(
        t.startsWith("Session") ? "session_init_conflict" : "auth_profile_cooldown",
      );
    }
    for (const t of HOLDS_AN_OPENING) expect(classifyStoredFailureText(t), t).toBeNull();
  });
});

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
