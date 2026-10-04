// ERROR LABELS, STRUCTURED FIRST (0.91.3).
//
// A failure's class comes from what the gateway STRUCTURED first — `errorKind`, the
// provider observation (`errorDetail` / lifecycle `errorObservation`), the `(<reason>)`
// suffix of each fallback attempt — and from prose last. A generic upstream wrapper never
// becomes the label, and a credential refusal is split three ways (revoked / permission /
// unnamed) because only one of them is "your access expired".
//
// The corpus (fixtures/failure-text-corpus.json) is composed exactly as OpenClaw v2026.9.6
// composes each text, with its template cited; the front's mirror reads the same file.

import { describe, expect, it } from "vitest";
import corpus from "./fixtures/failure-text-corpus.json" with { type: "json" };
import {
  classifyErrorDetail,
  classifyFailureText,
  classifyStructuredFailure,
  FAILURE_CLASS_PRECEDENCE,
  parseFallbackSummary,
  providerCredentialTextClass,
  unwrapGatewayFailure,
  withoutOperatorData,
} from "../src/core/failure-classifier.js";

type Case = { id: string; source: string; text: string; expected: string | null };
const CASES = (corpus as { cases: Case[] }).cases;

describe("the v2026.9.6 corpus — every template gets the class its cause names", () => {
  for (const c of CASES) {
    it(`${c.id} (${c.source})`, () => {
      expect(classifyFailureText(c.text)).toBe(c.expected);
    });
  }

  it("the corpus covers every generic wrapper, verbose off, the 240-character cap, mixed summaries, 403 and TPM", () => {
    const ids = new Set(CASES.map((c) => c.id));
    for (const id of [
      "preflight-verbose-off",
      "prod-revoked-truncated-240",
      "summary-mixed-cooldown-then-401",
      "summary-403-region",
      "summary-auth-permanent",
      "summary-tpm-rate-limit",
      "bedrock-throttling-too-many-tokens",
      "something-went-wrong",
      "agent-failed-before-reply-unknown",
      "turn-ended-before-reply",
      "post-compaction-unknown",
      "json-body-401-revoked",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    const truncated = CASES.find((c) => c.id === "prod-revoked-truncated-240")!;
    expect(truncated.text.endsWith("...")).toBe(true);
    expect(truncated.text).not.toContain("Re-authenticate");
  });
});

describe("a generic wrapper is peeled off, never read as the cause", () => {
  it("the preflight headline alone is NOT a context fact", () => {
    const t =
      "⚠️ Context is too large and auto-compaction could not recover this turn. Try again, use /compact, or use /new to start a fresh session.";
    expect(unwrapGatewayFailure(t)).toEqual({ wrapper: "preflight_compaction", inner: null });
    const cls = classifyFailureText(t);
    expect(cls).toBe("compaction_failed_no_cause");
    expect(cls).not.toBe("context_length");
  });

  it("wrappers nest: the outermost names the fallback, the innermost cause decides", () => {
    const t =
      "⚠️ Context compaction succeeded, but the later model request still failed. Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
    expect(unwrapGatewayFailure(t)).toEqual({ wrapper: "run_failure", inner: null });
    expect(classifyFailureText(t)).toBe("run_failed_no_cause");
  });

  it("text that is not wrapped comes back whole", () => {
    expect(unwrapGatewayFailure("database is locked")).toEqual({
      wrapper: null,
      inner: "database is locked",
    });
  });
});

describe("structured facts — errorDetail / errorObservation — decide before any prose", () => {
  it("maps each FailoverReason that names an action (failover-reasons.ts)", () => {
    const by = (failoverReason: string, httpStatus?: number) =>
      classifyErrorDetail({ failoverReason, ...(httpStatus ? { httpStatus } : {}) });
    expect(by("auth", 401)).toBe("provider_auth_revoked");
    expect(by("auth", 403)).toBe("provider_permission_denied");
    expect(by("auth")).toBe("provider_auth_failed");
    expect(by("auth_permanent")).toBe("provider_permission_denied");
    expect(by("auth_permanent", 401)).toBe("provider_permission_denied");
    expect(by("billing")).toBe("provider_billing");
    expect(by("rate_limit")).toBe("rate_limit");
    expect(by("overloaded")).toBe("provider_internal");
    expect(by("server_error")).toBe("provider_internal");
    expect(by("timeout")).toBe("provider_internal");
    expect(by("context_overflow")).toBe("context_length");
    expect(by("model_not_found")).toBe("model_not_found");
    for (const silent of [
      "format",
      "tls_certificate",
      "session_expired",
      "empty_response",
      "no_error_details",
      "unclassified",
      "unknown",
    ]) {
      expect(by(silent), silent).toBeNull();
    }
  });

  it("the runtime kind is read first where it is narrower (provider-runtime-failure.ts)", () => {
    expect(
      classifyErrorDetail({
        failoverReason: "invalid_grant",
        providerRuntimeFailureKind: "auth_refresh",
        provider: "openai-codex",
      }),
    ).toBe("provider_auth_revoked");
    // Without a reason upstream says "Model login failed … Please try again": no class.
    expect(classifyErrorDetail({ providerRuntimeFailureKind: "auth_refresh" })).toBeNull();
    expect(
      classifyErrorDetail({
        failoverReason: "auth",
        providerRuntimeFailureKind: "auth_invalid_token",
      }),
    ).toBe("provider_auth_revoked");
    expect(
      classifyErrorDetail({ failoverReason: "auth", providerRuntimeFailureKind: "auth_scope" }),
    ).toBe("provider_permission_denied");
    expect(
      classifyErrorDetail({ providerRuntimeFailureKind: "auth_html", httpStatus: 403 }),
    ).toBe("provider_permission_denied");
    expect(classifyErrorDetail({ providerRuntimeFailureKind: "rate_limit" })).toBe("rate_limit");
  });

  it("operator values and provider prose never choose (provider, model, preview)", () => {
    expect(
      classifyErrorDetail({
        provider: "auth_permanent",
        model: "rate_limit",
        providerErrorType: "billing",
        providerErrorMessagePreview: "401 token revoked",
      }),
    ).toBeNull();
    expect(classifyErrorDetail(null)).toBeNull();
    expect(classifyErrorDetail("auth")).toBeNull();
    expect(classifyErrorDetail({ failoverReason: "made_up" })).toBeNull();
  });

  it("a bare status still names the transient and rate classes", () => {
    expect(classifyErrorDetail({ httpStatus: 429 })).toBe("rate_limit");
    expect(classifyErrorDetail({ httpStatus: 503 })).toBe("provider_internal");
    expect(classifyErrorDetail({ httpStatus: 401 })).toBeNull();
  });

  it("the gateway's terminal facts (timeout, refusal) outrank the observation; its other kinds yield to it", () => {
    const detail = { failoverReason: "auth", httpStatus: 401 };
    expect(classifyStructuredFailure({ errorKind: "timeout", errorDetail: detail })).toBe("timeout");
    expect(classifyStructuredFailure({ errorKind: "refusal", errorDetail: detail })).toBe("refusal");
    expect(
      classifyStructuredFailure({
        errorKind: "rate_limit",
        errorDetail: { failoverReason: "overloaded" },
      }),
    ).toBe("provider_internal");
    expect(classifyStructuredFailure({ errorKind: "rate_limit" })).toBe("rate_limit");
    expect(classifyStructuredFailure({ errorKind: "unknown", errorDetail: {} })).toBeNull();
  });

  it("v2026.9.7 `state_contention` is the storage-busy class, ahead of any observation", () => {
    // The gateway's own classification of a typed SQLite BUSY/LOCKED on the chat.send
    // path (session-run-error-presentation.ts:10-17); its text names no storage fact.
    expect(classifyStructuredFailure({ errorKind: "state_contention" })).toBe(
      "gateway_storage_busy",
    );
    expect(
      classifyStructuredFailure({
        errorKind: "state_contention",
        errorDetail: { failoverReason: "overloaded", httpStatus: 503 },
      }),
    ).toBe("gateway_storage_busy");
  });

  it("an errorKind naming an inherited object property is no class (falls back, never a function)", () => {
    for (const errorKind of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(classifyStructuredFailure({ errorKind }), errorKind).toBeNull();
      expect(
        classifyStructuredFailure({ errorKind, errorDetail: { httpStatus: 429 } }),
        errorKind,
      ).toBe("rate_limit");
    }
  });
});

describe("the fallback summary's machine-written parts", () => {
  it("splits each attempt's `(<reason>)` suffix and the remediation off", () => {
    const parsed = parseFallbackSummary(
      "All models failed (2): openai/a: 401: invalidated oauth token (auth) | openai/b: boom (server_error). Re-authenticate with: openclaw models auth login --provider 'openai' --force",
    );
    expect(parsed).toEqual({
      attempts: [
        { text: "401: invalidated oauth token", reason: "auth" },
        { text: "boom", reason: "server_error" },
      ],
      authHint: true,
    });
    // A parenthesis that is not a FailoverReason stays the attempt's own words.
    expect(
      parseFallbackSummary("All models failed (2): openai/a: oops (deadbeef) | openai/b: x")
        ?.attempts[0],
    ).toEqual({ text: "oops (deadbeef)", reason: null });
  });

  it("R5: a cooldown attempt no longer swallows a later attempt's 401", () => {
    const t =
      'All models failed (2): openai/a: Auth profile "openai:x" is temporarily unavailable for openai/a (rate_limit) | openai/b: 401: Encountered invalidated oauth token for user (auth)';
    expect(classifyFailureText(t)).toBe("provider_auth_revoked");
    // The cooldown alone keeps its class.
    expect(
      classifyFailureText(
        'All models failed (2): openai/a: Auth profile "openai:x" is temporarily unavailable for openai/a (rate_limit) | openai/b: Auth profile "openai:y" is temporarily unavailable for openai/b (rate_limit)',
      ),
    ).toBe("auth_profile_cooldown");
  });

  it("one precedence, graver first: storage, then the provider account, then the retried", () => {
    expect(FAILURE_CLASS_PRECEDENCE.indexOf("gateway_storage_unavailable")).toBe(0);
    const idx = (c: string) => FAILURE_CLASS_PRECEDENCE.indexOf(c);
    expect(idx("provider_auth_revoked")).toBeLessThan(idx("auth_profile_cooldown"));
    expect(idx("provider_auth_revoked")).toBeLessThan(idx("context_length"));
    expect(idx("provider_permission_denied")).toBeLessThan(idx("provider_auth_failed"));
    expect(idx("rate_limit")).toBeLessThan(idx("provider_internal"));
  });
});

describe("R7 — the overflow rule carries upstream's exclusions", () => {
  it("TPM, rate limits and Bedrock throttling are not a context overflow", () => {
    for (const t of [
      "ThrottlingException: Too many tokens, please wait before trying again.",
      "Too many tokens per day, please wait before trying again.",
      "413 Request too large: too many tokens per minute (TPM), please slow down.",
      "request too large: rate limit reached for tokens",
      "too many tokens: insufficient_quota",
    ]) {
      expect(classifyFailureText(t), t).not.toBe("context_length");
    }
  });

  it("a real overflow still is — and a request bigger than the whole TPM bucket too", () => {
    expect(classifyFailureText("maximum context length exceeded")).toBe("context_length");
    expect(
      classifyFailureText(
        "413 Request too large for model `x` on tokens per minute (TPM): Limit 6000, Requested 9000.",
      ),
    ).toBe("context_length");
  });
});

describe("R3 — a provider's JSON body is the provider's words, not an operator value", () => {
  it("exposes a status-anchored body before the quote blanking", () => {
    expect(
      withoutOperatorData(
        '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked."}}',
      ),
    ).toBe("401 error authentication_error OAuth token has been revoked.");
  });

  it("but an operator value is still blanked — no status anchors it", () => {
    expect(
      classifyFailureText('MCP server "{\\"message\\":\\"401: token has been revoked\\"}" failed'),
    ).toBeNull();
    expect(
      classifyFailureText('Session "401 {"message":"token has been revoked"}" changed while starting work. Retry.'),
    ).not.toBe("provider_auth_revoked");
  });
});

describe("R4 — 401 versus 403: the credential split", () => {
  it("names each credential class from fixed phrases only", () => {
    expect(providerCredentialTextClass("401: Encountered invalidated oauth token for user")).toBe(
      "provider_auth_revoked",
    );
    expect(providerCredentialTextClass("403 Forbidden: this organization is not allowed")).toBe(
      "provider_permission_denied",
    );
    expect(providerCredentialTextClass("Your API key has been deactivated: api_key_deactivated")).toBe(
      "provider_permission_denied",
    );
    expect(
      providerCredentialTextClass(
        "Re-authenticate with: openclaw models auth login --provider 'openai' --force",
      ),
    ).toBe("provider_auth_failed");
    expect(providerCredentialTextClass("HTTP 401: Unauthorized")).toBeNull();
  });

  it("a 403 beside the hint is a permission, never the expired-access card", () => {
    const t =
      "All models failed (2): openai/a: 403 Forbidden (auth) | openai/b: 403 Forbidden (auth). Re-authenticate with: openclaw models auth login --provider 'openai' --force";
    expect(classifyFailureText(t)).toBe("provider_permission_denied");
  });
});

describe("the new rules stay linear on hostile input (the bridge has frozen on a regex before)", () => {
  it("each adversarial text classifies well under a second", () => {
    const inputs = [
      "tpm " + "limit ".repeat(5000),
      "401 " + "{".repeat(20000),
      "403 " + "a".repeat(50000),
      '401 {"message":"' + "\\\\".repeat(20000),
      "All models failed (2): " + "a/b: x (auth) | ".repeat(3000),
      ". ".repeat(20000) + "...",
      " (".repeat(10000) + "auth)" + " ".repeat(10000),
      "⚠️ Agent failed before reply: " + ".".repeat(30000),
      "This turn ended before a reply: ".repeat(2000),
    ];
    for (const t of inputs) {
      const started = performance.now();
      classifyFailureText(t);
      withoutOperatorData(t);
      expect(performance.now() - started, t.slice(0, 30)).toBeLessThan(1000);
    }
  });
});
