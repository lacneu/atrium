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
