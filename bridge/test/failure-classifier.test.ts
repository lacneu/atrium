// The SHARED failure-text classifier (W2 / G-11).
//
// Real gateways often ship no structured `errorKind`, so the class has to come
// from the TEXT. Extracted from the normalizer so the SUB-AGENT path — the one
// place that never classified at all — uses the same rules. These cases are the
// documented phrasings from the production reports, plus the fail-safe boundary.

import { describe, expect, it } from "vitest";
import { classifyFailureText } from "../src/core/failure-classifier.js";

describe("classifyFailureText", () => {
  it("pins every documented OVERFLOW phrasing to context_length", () => {
    // Report 2026-07: 4 of 6 phrasings were missed before the regex was widened.
    for (const t of [
      "context overflow",
      "prompt too large",
      "maximum context length exceeded",
      "request_too_large",
      "input token count exceeds the maximum number of input tokens",
      "input is too long for the model",
      "ollama error: context length exceeded",
      "Please reduce the length of the messages",
    ]) {
      expect(classifyFailureText(t), t).toBe("context_length");
    }
  });

  it("pins the gateway's session-init OCC conflicts to session_init_conflict", () => {
    expect(classifyFailureText("reply session initialization conflicted")).toBe(
      "session_init_conflict",
    );
    expect(
      classifyFailureText("session file changed while embedded prompt lock held"),
    ).toBe("session_init_conflict");
  });

  it("the writer rebound gets its OWN class, whatever cause rides the text", () => {
    // Upstream throws it before generation and at commits after the model ran, with the
    // same message. The TEXT names neither moment, so the classifier returns the class
    // sized for the worse case; the normalizer, which sees the stream, upgrades a proven
    // pre-generation one (writer-rebound-before-generation.test.ts). Sharing
    // `session_init_conflict` here put every rebound in RETRYABLE_KINDS (codex).
    // Two renderings: bare (most throw sites pass no refusal) and with a refusal cause,
    // which ws-log.ts renders after ` <- ` as JSON.stringify of an object of hashes.
    expect(
      classifyFailureText(
        'SessionTranscriptWriterClaimReboundError: session writer claim changed before transcript persistence <- {"actualSessionIdHash":"a1b2","agentIdHash":"c3d4","code":"session-rebound","expectedSessionIdHash":"e5f6","sessionKeyHash":"0789"}',
      ),
    ).toBe("session_write_conflict");
    expect(
      classifyFailureText(
        "SessionTranscriptWriterClaimReboundError: session writer claim changed before transcript persistence",
      ),
    ).toBe("session_write_conflict");
  });

  it("the gateway's USER-FACING rendering of the same rebound gets the same class", () => {
    // What reaches the wire when the rebound ends a generating run on 2026.9.3+ (read at v2026.9.4): the
    // storage-failure copy (upstream assistant-request-failure-copy.ts:24-25,52), verbatim,
    // as the lifecycle `error` preview and the chat error's `errorMessage`.
    const copy =
      "⚠️ Agent run failed: the transcript writer no longer owned this session. Retry in the current session; if it repeats, check Gateway logs.";
    expect(classifyFailureText(copy)).toBe("session_write_conflict");
    // Its own "Retry" never lets it fall into a retryable class.
    expect(classifyFailureText(copy)).not.toBe("session_init_conflict");
    expect(classifyFailureText(copy)).not.toBe("provider_internal");
  });

  it("pins the 2026.8.1+ / 2026.9.1 session COORDINATION errors to the same transient class", () => {
    // The file lock of 7.x is gone; these are what the SQLite generation says
    // instead (upstream anchors in failure-classifier.ts). Wire forms carry the
    // error class as a prefix.
    expect(classifyFailureText("Session 7f3a already has an active turn claim")).toBe(
      "session_init_conflict",
    );
    expect(
      classifyFailureText('SessionWorkStartChangedError: Session "agent:alice:atrium:chat:u-1" was deleted while starting work. Retry.'),
    ).toBe("session_init_conflict");
    expect(
      classifyFailureText('Session "agent:alice:atrium:chat:u-1" changed while starting work. Retry.'),
    ).toBe("session_init_conflict");
    // The sessions.files variant is a different API and must NOT match.
    expect(classifyFailureText("session file changed since it was read")).toBeNull();
  });
  it("pins transient provider failures to provider_internal", () => {
    for (const t of [
      "The AI service returned an internal error. Please try again.",
      "The AI service is temporarily overloaded",
      "HTTP 503",
      "fetch failed",
      "ECONNRESET",
    ]) {
      expect(classifyFailureText(t), t).toBe("provider_internal");
    }
  });

  it("FAIL-SAFE: a never-transient failure is NEVER provider_internal", () => {
    // Retrying an auth/entitlement failure burns quota and shows a misleading
    // label — the exclusion guard is checked FIRST, on purpose.
    for (const t of [
      "HTTP 401 unauthorized",
      "invalid_api_key",
      "rate limit exceeded (HTTP 500-ish wording)",
      "quota exceeded, internal server error",
      "billing problem: internal server error",
    ]) {
      expect(classifyFailureText(t), t).not.toBe("provider_internal");
    }
  });

  it("the gateway's STORAGE failures get named classes, split by what they ask of the reader", () => {
    // The five siblings of the writer-fenced copy above, same upstream file
    // (assistant-request-failure-copy.ts:13-26,52), verbatim as they reach the wire. A
    // contention the reader can simply re-send is NOT the same event as a host whose disk
    // is full: one class for both would make every label half wrong.
    for (const copy of [
      "⚠️ Agent run failed: the Gateway state database was busy (SQLite: database is locked). Retry; if it repeats, check Gateway storage health.",
      "⚠️ Agent run failed: the Gateway state database was locked (SQLite: database table is locked). Retry; if it repeats, check Gateway storage health.",
    ]) {
      expect(classifyFailureText(copy), copy).toBe("gateway_storage_busy");
    }
    for (const copy of [
      "⚠️ Agent run failed: the Gateway state database was full (SQLite: database or disk is full). Free disk space on the Gateway host and retry.",
      "⚠️ Agent run failed: the Gateway state database was read-only (SQLite: attempt to write a readonly database). Check Gateway storage permissions and retry.",
      "⚠️ Agent run failed: the Gateway state database had an I/O error (SQLite: disk I/O error). Check Gateway storage health and filesystem access before retrying.",
    ]) {
      expect(classifyFailureText(copy), copy).toBe("gateway_storage_unavailable");
    }
  });

  it("the RAW SQLite messages classify too, copy or no copy", () => {
    // The copy is rendered only when the gateway classified the failure itself
    // (sqlite-error-diagnostics.ts:4-11). The bare driver message can reach us instead,
    // and it names the same event.
    expect(classifyFailureText("SqliteError: database is locked")).toBe("gateway_storage_busy");
    expect(classifyFailureText("database table is locked")).toBe("gateway_storage_busy");
    expect(classifyFailureText("SqliteError: database or disk is full")).toBe(
      "gateway_storage_unavailable",
    );
    expect(classifyFailureText("attempt to write a readonly database")).toBe(
      "gateway_storage_unavailable",
    );
    expect(classifyFailureText("disk I/O error")).toBe("gateway_storage_unavailable");
  });

  it("a storage failure is NEVER provider_internal, whatever else rides the text", () => {
    // Its own "Retry" must not buy it an automatic re-dispatch: the run had already
    // started working when the write failed, exactly like the writer rebound above.
    const full =
      "⚠️ Agent run failed: the Gateway state database was full (SQLite: database or disk is full). Free disk space on the Gateway host and retry.";
    expect(classifyFailureText(full)).not.toBe("provider_internal");
    expect(classifyFailureText(full)).not.toBe("session_init_conflict");
    // A 5xx marker in the same sentence does not turn a full disk into a provider blip.
    expect(
      classifyFailureText(`internal server error — ${full}`),
    ).toBe("gateway_storage_unavailable");
  });

  it("FAIL-SAFE: unrecognized or empty text yields NO class", () => {
    expect(classifyFailureText("le sous-agent a rendu quelque chose d'étrange")).toBeNull();
    expect(classifyFailureText("")).toBeNull();
    expect(classifyFailureText(null)).toBeNull();
    expect(classifyFailureText(undefined)).toBeNull();
  });

  it("OVERFLOW wins over a co-occurring 5xx marker (the class that is actionable)", () => {
    expect(
      classifyFailureText("internal server error: prompt too large for the model"),
    ).toBe("context_length");
  });
});
