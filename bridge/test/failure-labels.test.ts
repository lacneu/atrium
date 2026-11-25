// ERROR LABELS, STRUCTURED FIRST (0.91.3).
//
// A failure's class comes from what the gateway STRUCTURED first — `errorKind`, the
// provider observation (`errorDetail` / lifecycle `errorObservation`), the `(<reason>)`
// suffix of each fallback attempt — and from prose last. A generic upstream wrapper never
// becomes the label, and a credential refusal is split three ways (revoked / permission /
// unnamed) because only one of them is "your access expired".
//
// The corpus (fixtures/failure-text-corpus.json) is composed exactly as OpenClaw composes each
// text, with its template cited — at v2026.9.6, and at v2026.10.33 for the `-1033` cases that
// word the same facts anew; the front's mirror reads the same file.

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

describe("the upstream corpus — every template gets the class its cause names", () => {
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

describe("OpenClaw 2026.10.33 — the same facts under the rewritten copies", () => {
  const HINT =
    "For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";
  const TAIL = " Try again, use /compact, or use /new to start a fresh session.";

  it("every 9.36 family has its 10.33 wording in the corpus, with the SAME class", () => {
    // 9.36 case -> its 10.33 counterpart: one fact, two generations, one verdict.
    const pairs: Array<[string, string]> = [
      ["preflight-verbose-off", "preflight-verbose-off-1033"],
      ["preflight-timed-out", "preflight-timed-out-1033"],
      ["preflight-reason-unrecognized", "preflight-reason-unrecognized-1033"],
      ["prod-revoked-verbose-on", "preflight-revoked-verbose-on-1033"],
      ["session-gone-wrapped", "session-gone-wrapped-1033"],
      ["something-went-wrong", "something-went-wrong-1033"],
      ["agent-failed-before-reply-unknown", "control-ui-agent-failure-1033"],
      ["turn-ended-before-reply", "turn-ended-before-reply-1033"],
      ["post-compaction-rate-limit", "post-compaction-rate-limit-1033"],
      ["post-compaction-billing", "post-compaction-billing-1033"],
      ["billing-copy", "billing-copy-no-label-1033"],
      ["model-not-found-copy", "model-not-found-copy-1033"],
      ["rate-limit-copy", "rate-limit-copy-1033"],
      ["hedged-401", "auth-copy-1033"],
    ];
    const byId = new Map(CASES.map((c) => [c.id, c]));
    for (const [old, now] of pairs) {
      expect(byId.get(old), old).toBeDefined();
      expect(byId.get(now), now).toBeDefined();
      expect(byId.get(now)!.expected, `${old} -> ${now}`).toBe(byId.get(old)!.expected);
      expect(byId.get(now)!.source, now).toContain("v2026.10.33");
    }
  });

  it("the rewritten preflight headline is peeled like the old one, and is not a context fact", () => {
    const head = "⚠️ This conversation is too long, and OpenClaw couldn't shorten it.";
    expect(unwrapGatewayFailure(`${head}${TAIL}`)).toEqual({ wrapper: "preflight_compaction", inner: null });
    expect(unwrapGatewayFailure(`${head} Reason: 401: Encountered invalidated oauth token for user (auth).${TAIL}`)).toEqual({
      wrapper: "preflight_compaction",
      inner: "401: Encountered invalidated oauth token for user (auth)",
    });
    expect(
      unwrapGatewayFailure(`⚠️ This conversation is too long, and shortening it took too long.${TAIL}`),
    ).toEqual({ wrapper: "compaction_timeout", inner: null });
    expect(classifyFailureText(`${head}${TAIL}`)).not.toBe("context_length");
  });

  it("the three cause-less copies are wrappers that carry nothing — never a guessed cause", () => {
    for (const text of [
      "⚠️ OpenClaw couldn't finish this request. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
      `⚠️ OpenClaw couldn't finish this reply. Check the conversation before trying again. ${HINT}`,
      `⚠️ OpenClaw couldn't finish this reply. ${HINT}`,
    ]) {
      expect(unwrapGatewayFailure(text), text).toEqual({ wrapper: "run_failure", inner: null });
      expect(classifyFailureText(text), text).toBe("run_failed_no_cause");
    }
    // The transcript row's headline keeps what follows it as the cause.
    expect(unwrapGatewayFailure("Your request couldn't be completed: database or disk is full")).toEqual({
      wrapper: "run_failure",
      inner: "database or disk is full",
    });
    expect(classifyFailureText("Your request couldn't be completed: database or disk is full")).toBe(
      "gateway_storage_unavailable",
    );
  });

  it("the storage copies keep the SPLIT: busy is a resend, the three others are the host", () => {
    const copy = (id: string) => CASES.find((c) => c.id === id)!.text;
    expect(classifyFailureText(copy("storage-busy-1033"))).toBe("gateway_storage_busy");
    for (const id of ["storage-full-1033", "storage-readonly-1033", "storage-ioerr-1033"]) {
      expect(classifyFailureText(copy(id)), id).toBe("gateway_storage_unavailable");
    }
    // The host wins when one text carries both, as on 9.36 (precedence).
    expect(classifyFailureText(`${copy("storage-busy-1033")} | ${copy("storage-full-1033")}`)).toBe(
      "gateway_storage_unavailable",
    );
  });

  it("the writer-rebound copy is NOT the two other `conversation changed` sentences", () => {
    expect(
      classifyFailureText(
        `⚠️ This conversation changed while OpenClaw was working. Check its latest messages before continuing. ${HINT}`,
      ),
    ).toBe("session_write_conflict");
    // src/auto-reply/reply/agent-runner-core.ts:401 — a restart-recovery claim.
    expect(
      classifyFailureText(
        "⚠️ This conversation changed before your message could start. Check the latest messages, then try again if needed.",
      ),
    ).toBeNull();
    // src/gateway/server-methods/chat-send-dispatch-errors.ts:55-60 — a refresh-required send.
    expect(
      classifyFailureText(
        "Your message didn't run because the conversation changed. Refresh the conversation, then send it again.",
      ),
    ).toBeNull();
  });

  it("what one sentence cannot tell apart stays without a class", () => {
    // One copy for a provider network error (auto-retried class on 9.36), a refused
    // connection and a DNS failure (no class on 9.36): src/shared/assistant-error-format.ts:256-276.
    expect(
      classifyFailureText(
        "Couldn't connect to the AI service. Check your connection, then try again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
      ),
    ).toBeNull();
    // A queue cap dropping a queued input is not the displaced-input class, whose card and
    // diagnosis describe a rewritten transcript branch.
    for (const reason of ["queue-cap", "queue-cap-old", "queue-cap-new"]) {
      expect(classifyFailureText(`Queued input was dropped (${reason}).`), reason).toBeNull();
    }
  });
});

describe("OpenClaw 2026.10.33 — the structured observation still decides first", () => {
  it("`upstream_html` names the transient class when neither the reason nor the status did", () => {
    // provider-runtime-failure.ts:131-140; carried by errorObservation / errorDetail.
    expect(classifyErrorDetail({ providerRuntimeFailureKind: "upstream_html" })).toBe("provider_internal");
    expect(classifyErrorDetail({ providerRuntimeFailureKind: "upstream_html", httpStatus: 404 })).toBe(
      "provider_internal",
    );
    expect(
      classifyStructuredFailure({ errorDetail: { providerRuntimeFailureKind: "upstream_html", failoverReason: "unknown" } }),
    ).toBe("provider_internal");
  });

  it("…and never outranks a reason or a status that already named one", () => {
    expect(
      classifyErrorDetail({ providerRuntimeFailureKind: "upstream_html", failoverReason: "auth", httpStatus: 403 }),
    ).toBe("provider_permission_denied");
    expect(
      classifyErrorDetail({ providerRuntimeFailureKind: "upstream_html", failoverReason: "model_not_found" }),
    ).toBe("model_not_found");
    expect(classifyErrorDetail({ providerRuntimeFailureKind: "upstream_html", httpStatus: 429 })).toBe("rate_limit");
  });

  it("the kinds that cannot choose a class are not read", () => {
    // `gateway_storage` is one word for busy, full, read-only, I/O and the writer rebound
    // (provider-runtime-failure.ts:102-104): it cannot choose between "resend" and "repair
    // the host". `proxy`, `dns` and `timeout` had no class by their 9.36 copy either.
    for (const kind of ["gateway_storage", "proxy", "dns", "timeout", "tls_certificate", "schema"]) {
      expect(classifyErrorDetail({ providerRuntimeFailureKind: kind }), kind).toBeNull();
    }
  });

  it("the rewritten copies no longer carry what the structured fields do: both are needed", () => {
    // The 10.33 rate-limit copy, alone and beside its observation — same class either way.
    const copy = "⚠️ The AI service needs a short break. Please try again in a few minutes.";
    expect(classifyFailureText(copy)).toBe("rate_limit");
    expect(classifyStructuredFailure({ errorKind: "rate_limit", errorDetail: { failoverReason: "rate_limit", httpStatus: 429 } })).toBe(
      "rate_limit",
    );
    // The auth copy names nothing by itself; the observation does.
    const auth = "⚠️ Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.";
    expect(classifyFailureText(auth)).toBeNull();
    expect(classifyStructuredFailure({ errorDetail: { failoverReason: "auth", httpStatus: 401 } })).toBe(
      "provider_auth_revoked",
    );
  });
});
