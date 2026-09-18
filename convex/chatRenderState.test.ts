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
  maskCredentialId,
  withoutOperatorValues,
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
    // The gateway's storage classes: curated CLASS names the bridge mints from the gateway's
    // sentence, never that sentence. Absent from the list they collapsed to "unknown" and the
    // trace filter dropped them, leaving their two per-cause anomaly classes unreachable.
    // The gateway refused to USE the credential (auth profile in cooldown). Absent
    // from the list the code collapses to "unknown" and the trace filter drops it, so
    // the cause is not countable. The reported incident had no class at ALL — the
    // bridge classifier returned null — so this list is not what left the bubble empty;
    // it is what makes a repeat countable now that the class exists.
    expect(normalizeMessageErrorCode("auth_profile_cooldown")).toBe("auth_profile_cooldown");
    expect(normalizeMessageErrorCode("gateway_storage_busy")).toBe("gateway_storage_busy");
    expect(normalizeMessageErrorCode("gateway_storage_unavailable")).toBe(
      "gateway_storage_unavailable",
    );
    // The bridge's OWN inbound-staging refusals: the turn is never sent, so no
    // gateway class can carry them. Left out of this list they collapsed
    // to "unknown", the trace filter dropped the code, and their per-cause anomaly
    // classes were unreachable — which is how "every attachment send fails" stayed
    // an unnamed generic error for five days (live prod 2026-09-17).
    for (const code of [
      "attachment_path_refused",
      "attachment_staging_failed",
      "attachment_cleanup_unconfirmed",
      "attachment_name_too_long",
    ]) {
      expect(normalizeMessageErrorCode(code), code).toBe(code);
    }
    // And the gateway's own sentence is NOT a code: it stays out, like any raw text.
    expect(
      normalizeMessageErrorCode(
        "⚠️ Agent run failed: the Gateway state database was full (SQLite: database or disk is full). Free disk space on the Gateway host and retry.",
      ),
    ).toBe("unknown");
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

describe("maskCredentialId — the id never enters the row", () => {
  test("everything from the opening quote goes, whatever the id contains", () => {
    // TOTAL by construction. Three cleverer versions were defeated in a row by the
    // same thing: the id is OPERATOR-CONTROLLED, so it can contain whatever the
    // redaction uses as a delimiter — a quote, a newline, a second sentence, and
    // finally the tail itself (codex). Each of these defeated one of them.
    for (const text of [
      'Auth profile "openai:olivier@example.com" is temporarily unavailable for openai/gpt-5.6-terra.',
      'Auth profile "openai:team"olivier@example.com" is temporarily unavailable for openai/x.',
      'Auth profile "openai:line1\nline2@example.com" is temporarily unavailable for openai/x.',
      'Auth profile "alice" is temporarily unavailable secret@example.com" is temporarily unavailable for m.',
      'Auth profile "a@x.com" is temporarily unavailable for m1. Also Auth profile "b@y.com" is temporarily unavailable for m2.',
      'Auth profile "verylongidthatgotcut@example',
      'Auth profile "…already-masked-looking@example.com" is temporarily unavailable for x.',
      'Auth profile "openai:x" type mismatch for secrets.openai.',
    ]) {
      const masked = maskCredentialId(text);
      expect(masked, text).toBe('Auth profile "…');
      expect(masked).not.toMatch(/@example\.com|@x\.com|@y\.com/);
    }
  });

  test("EVERY upstream opening that quotes a credential id, not a list of three", () => {
    // Swept from the pinned upstream sources: about thirty sentences name a quoted
    // profile id, and three review passes added one opening at a time while more
    // remained (codex). The rule is structural now — a `profile` or an `apiKey` right
    // before the quote — so a sentence upstream adds tomorrow is covered today.
    for (const opening of [
      'Auth profile "ID" is temporarily unavailable for openai/m.',
      'Per-entry apiKey profile "ID" has no usable credentials for openai.',
      'Per-entry apiKey "ID" is not a compatible bearer profile for openai.',
      'No credentials found for profile "ID".',
      'Provider auth profile "ID" is retired. Run x.',
      'Selected auth profile "ID" is not configured for openai.',
      'unknown auth profile "ID"',
      'MCP server "srv" references auth profile "ID" which is missing.',
      'Cannot create auth profile "ID" for openai without authProfileProvider.',
      'Configured setup profile "ID" belongs to x, not the selected route.',
    ]) {
      expect(maskCredentialId(opening), opening).not.toContain("ID");
    }
    // …and the cut is at the FIRST quote, so an operator value BEFORE the credential
    // word goes too — it was staying stored, served and exported (codex).
    expect(
      maskCredentialId(
        'MCP server "prod-mcp@example.com" references auth profile "secret@example.com".',
      ),
    ).toBe('MCP server "…');
  });

  test("the OTHER two openings upstream composes are masked too", () => {
    // `Per-entry apiKey profile "<id>" …` and `Per-entry apiKey "<id>" …` carry the
    // same operator-chosen id (prepare-auth.ts, model-auth-provider.ts). They were
    // passing through intact — and a case in this very file GUARANTEED that they did
    // (codex).
    for (const text of [
      'Per-entry apiKey profile "openai:someone@example.com" has no usable credentials for openai.',
      'Per-entry apiKey "openai:someone@example.com" is not a compatible bearer profile for openai.',
      'Per-entry apiKey "openai:someone@example.com" for provider "openai" references a "token" credential for provider "other", mismatched. Fix it.',
    ]) {
      const masked = maskCredentialId(text);
      expect(masked, text).not.toContain("someone@example.com");
      expect(masked.endsWith('"…'), masked).toBe(true);
    }
  });

  test("the cost is real and it is the provider, the model and the sibling's target", () => {
    // Said out loud rather than discovered later: the detail line keeps nothing after
    // the quote. The localized card carries what the reader should do, the session meta
    // names the model, and the gateway is the operator's source of truth.
    expect(
      maskCredentialId(
        'Auth profile "x" is temporarily unavailable for openai/gpt-5.6-terra.',
      ),
    ).not.toContain("gpt-5.6-terra");
  });

  test("leaves every other sentence exactly as it is", () => {
    // It runs on EVERY door, so a sentence it does not recognize must pass through
    // untouched — a masker that nibbles at unrelated errors is a worse defect than the
    // one it fixes. The trigger is a `profile` or an `apiKey` IMMEDIATELY followed by a
    // quote.
    //
    // ACCEPTED COST, stated rather than discovered later: any sentence where those
    // words precede a quoted string loses its tail, including prose that meant
    // something else by "profile". That is the price of not maintaining a list of
    // thirty upstream openings, three of which this review added one pass at a time
    // while more remained (codex).
    for (const text of [
      "fetch failed",
      "⚠️ Agent run failed: the Gateway state database was busy (SQLite: database is locked).",
      "Auth profile without a quote is untouched",
      'A quoted "value" with no profile word before it is untouched',
      "",
    ]) {
      expect(maskCredentialId(text), text).toBe(text);
    }
    expect(maskCredentialId(undefined)).toBeUndefined();
    expect(maskCredentialId(null)).toBeNull();
  });
});

describe("withoutOperatorValues — what may reach a DECISION", () => {
  test("a credential sentence is cut at its first quote", () => {
    expect(
      withoutOperatorValues(
        'MCP server "prompt too large" references auth profile "x" which is missing.',
      ),
    ).toBe('MCP server "…');
  });

  test("every other sentence keeps its shape and loses what is inside the quotes", () => {
    // Real gateway sentences put a value first and their classifying words AFTER it;
    // cutting there would throw a legitimate class away.
    expect(
      withoutOperatorValues(
        'Session "agent:timeout:x" changed while starting work. Retry.',
      ),
    ).toBe('Session "…" changed while starting work. Retry.');
  });

  test("it is NOT the display mask — that one keeps a session key the reader needs", () => {
    const sentence = 'Session "agent:alice:chat" changed while starting work.';
    expect(maskCredentialId(sentence)).toBe(sentence);
    expect(withoutOperatorValues(sentence)).not.toBe(sentence);
  });
});
