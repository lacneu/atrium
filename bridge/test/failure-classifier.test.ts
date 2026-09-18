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

  it("names the AUTH PROFILE COOLDOWN — the sentence that reached a user as an empty bubble", () => {
    // Verbatim from production (feedback prod-ms7ed3bn…), and the shape upstream
    // composes at src/agents/runtime-plan/prepare-auth.ts in v2026.9.4.
    expect(
      classifyFailureText(
        'Auth profile "openai:olivier@lacneu.com" is temporarily unavailable for openai/gpt-5.6-terra.',
      ),
    ).toBe("auth_profile_cooldown");
    // An id containing a QUOTE still classifies: upstream requires only a non-empty
    // string, and a lazy `"[^"]*"` stopped recognizing the sentence entirely — no
    // class, which is the exact failure this rule exists to end (codex).
    expect(
      classifyFailureText(
        'Auth profile "openai:team"someone@example.com" is temporarily unavailable for openai/gpt-5.6-sol.',
      ),
    ).toBe("auth_profile_cooldown");
    // …and one containing a NEWLINE. Same reason, and the classifier fails CLOSED
    // there — no class at all — which is the failure this rule exists to end (codex).
    expect(
      classifyFailureText(
        'Auth profile "openai:line1\nline2@example.com" is temporarily unavailable for openai/gpt-5.6-sol.',
      ),
    ).toBe("auth_profile_cooldown");
    // The other producer names the provider without a model
    // (src/agents/provider-model-route-auth.ts).
    expect(
      classifyFailureText('Auth profile "anthropic:team" is temporarily unavailable for anthropic.'),
    ).toBe("auth_profile_cooldown");
  });

  it("is NOT a provider blip, though it says 'temporarily unavailable'", () => {
    // `provider_internal` is auto-retried (RETRYABLE_KINDS). Upstream refuses this
    // candidate BEFORE calling the provider (isProfileInCooldown,
    // src/agents/auth-profiles/usage-state.ts), and whether a later attempt is let
    // through as a probe depends on the reason that opened the window — which this
    // sentence does not name.
    const text = 'Auth profile "openai:someone" is temporarily unavailable for openai/gpt-5.6-sol.';
    expect(classifyFailureText(text)).not.toBe("provider_internal");
    // …and a 5xx marker riding the same sentence does not turn it into one.
    expect(classifyFailureText(`internal server error — ${text}`)).toBe(
      "auth_profile_cooldown",
    );
  });

  it("an id carrying the TAIL cannot turn its SIBLING into a cooldown", () => {
    // The id is operator-controlled, so it can contain the very words this rule keys
    // on. A profile named `openai:x" is temporarily unavailable` made the permanent
    // `type mismatch` sentence match, showing a misconfiguration as a transient pause
    // (codex). The tail must now run to the END with no further quote after it.
    expect(
      classifyFailureText(
        'Auth profile "openai:x" is temporarily unavailable" type mismatch for secrets.openai.',
      ),
    ).not.toBe("auth_profile_cooldown");
    // …while the real sentence, with an id containing a quote, still classifies.
    expect(
      classifyFailureText(
        'Auth profile "openai:team"someone@example.com" is temporarily unavailable for openai/gpt-5.6-sol.',
      ),
    ).toBe("auth_profile_cooldown");
  });

  it("a profile NAME cannot choose the class — the worst one of all", () => {
    // The id is whatever an operator called the profile, and it travels inside the
    // sentence every rule reads. Verified: `database or disk is full` became a full
    // disk, `prompt too large` a context overflow, and the writer-rebound phrase a
    // session conflict — which the normalizer can upgrade to the class the bounded
    // AUTO-RETRY keys on, so a profile name could buy itself re-dispatches (codex).
    for (const name of [
      "prompt too large",
      "database or disk is full",
      "database is locked",
      "session writer claim changed before transcript persistence",
      "fetch failed",
    ]) {
      expect(
        classifyFailureText(
          `Auth profile "${name}" is temporarily unavailable for openai/gpt-5.6-sol.`,
        ),
        name,
      ).toBe("auth_profile_cooldown");
    }
    // …and neither can the MODEL ID, which the tail names and an operator also chooses
    // (codex): the sentence's fixed words are all that survives the strip.
    for (const model of [
      "prompt too large",
      "database or disk is full",
      "timeout",
      "session file changed while embedded prompt lock",
      // …including one containing a QUOTE. The tail used to require that no quote
      // followed it, so this fell to the truncated form and lost its class (codex).
      'x"neutral',
    ]) {
      expect(
        classifyFailureText(
          `Auth profile "openai:someone" is temporarily unavailable for openai/${model}.`,
        ),
        model,
      ).toBe("auth_profile_cooldown");
    }
    // …and a name cannot steal a class for a sentence that is NOT a cooldown either.
    expect(
      classifyFailureText('Auth profile "database or disk is full" type mismatch for x.'),
    ).toBeNull();
  });

  it("NOTHING quoted reaches a rule — whichever operator string it is", () => {
    // `MCP server "<name>" references auth profile "<id>"` puts an operator string
    // BEFORE the credential word, so keying on `profile "` still let a server called
    // `reply session initialization conflicted` buy an automatic re-dispatch (codex).
    // A classification is never made from quoted content now.
    for (const hostile of [
      "reply session initialization conflicted",
      "prompt too large",
      "database or disk is full",
      "database is locked",
    ]) {
      expect(
        classifyFailureText(
          `MCP server "${hostile}" references auth profile "someone@example.com" which is missing.`,
        ),
        hostile,
      ).toBeNull();
    }
    // …including an UNQUOTED operator value: upstream interpolates `${provider}` into
    // these sentences too, and a provider named after a conflict phrase produced
    // `session_init_conflict`, which the bounded auto-retry keys on (codex).
    for (const hostile of [
      "reply session initialization conflicted",
      "prompt too large",
      "database or disk is full",
    ]) {
      expect(
        classifyFailureText(
          `Per-entry apiKey profile "neutral" has no usable credentials for ${hostile}.`,
        ),
        hostile,
      ).toBeNull();
    }
    // `API key` with a space is the same family — upstream writes
    // `No API key found for provider "<provider>"` and `apikey` missed it (codex).
    expect(
      classifyFailureText(
        'No API key found for provider "reply session initialization conflicted".',
      ),
    ).toBeNull();
    // …and an EARLIER operator segment cannot win the cooldown exception by carrying
    // its phrase: the exception applies only when the first quote is the cooldown's own.
    expect(
      classifyFailureText(
        'MCP server "Auth profile \u0022x\u0022 is temporarily unavailable for y" references auth profile "real" which is missing.',
      ),
    ).not.toBe("auth_profile_cooldown");
    // …and a quote INJECTED into the id cannot shift the pairing to expose a phrase:
    // the sentence is cut at its FIRST quote, so nothing after it is read at all.
    expect(
      classifyFailureText(
        'Auth profile "x"reply session initialization conflicted" type mismatch for y.',
      ),
    ).toBeNull();
    // …and a sentence that does NOT name a credential keeps its shape, so the gateway's
    // own words after a quoted value still classify — cutting there would have thrown
    // the class away, which is why the two rules differ.
    expect(
      classifyFailureText(
        'Session "agent:reply session initialization conflicted:x" was deleted while starting work. Retry.',
      ),
    ).toBe("session_init_conflict");
    // …while the operator value inside those quotes still cannot pick one.
    expect(
      classifyFailureText('Session "database or disk is full" is fine.'),
    ).toBeNull();
    // …and the gateway's OWN unquoted words still classify, which is the whole point.
    expect(
      classifyFailureText(
        '⚠️ Agent run failed: the Gateway state database was full (SQLite: database or disk is full).',
      ),
    ).toBe("gateway_storage_unavailable");
  });

  it("names the conversation the gateway says is GONE — the message Denis met", () => {
    // Verbatim from production (prod-ms7ctxqf…). Upstream composes it when preflight
    // compaction is required and cannot run, and classifies the same family as
    // `session_expired`, whose own helper says a failover "PROVES the provider-side
    // conversation can no longer be resumed". Atrium kept re-sending into it, so every
    // retry met the same dead conversation and the only way out shown to the reader was
    // the gateway's `/new`.
    expect(
      classifyFailureText(
        "⚠️ Context is too large and auto-compaction could not recover this turn. Reason: no conversation found for session. Try again, use /compact, or use /new to start a fresh session.",
      ),
    ).toBe("session_gone");
    // The other reason spellings, INSIDE the same wrapper.
    for (const reason of [
      "session expired",
      "conversation not found",
      "no such session",
      "session id not found",
    ]) {
      expect(
        classifyFailureText(`Preflight compaction required but failed: ${reason}`),
        reason,
      ).toBe("session_gone");
    }
  });

  it("a compaction failure that is NOT a gone conversation keeps its own class", () => {
    // The reason has to END its clause. The bare alternatives matched mid-sentence, so a
    // compaction problem whose conversation is ALIVE read as a gone session — and this
    // class drops the session and re-runs the turn (codex).
    for (const text of [
      "Preflight compaction required but failed: invalid session settings for compaction",
      "Preflight compaction required but failed: session invalid parameters supplied",
    ]) {
      expect(classifyFailureText(text), text).not.toBe("session_gone");
    }
  });

  it("a COMPOSITE diagnostic does not pair two unrelated sentences into the class", () => {
    expect(
      classifyFailureText(
        "Preflight compaction required but failed: invalid session settings. Diagnostic: no conversation found for session.",
      ),
    ).not.toBe("session_gone");
  });

  it("a SECOND clause opener, belonging to another diagnostic, is not ours", () => {
    // The wrapper is present and an opener follows it — but that opener belongs to an
    // unrelated cleanup sentence. Requiring an opener anywhere after the wrapper reached it
    // (codex).
    expect(
      classifyFailureText(
        "Preflight compaction required but failed: invalid session settings. Session cleanup failed: session not found.",
      ),
    ).not.toBe("session_gone");
    // …and a semicolon, a comma and an ASCII dash open one just as a full stop does.
    for (const text of [
      "Preflight compaction succeeded; session cleanup failed: session not found.",
      "Preflight compaction required but failed: invalid session settings, but session cleanup failed: session not found.",
      "Preflight compaction succeeded - session cleanup failed: session not found.",
      "Preflight compaction succeeded: session cleanup failed: session not found.",
    ]) {
      expect(classifyFailureText(text), text).not.toBe("session_gone");
    }
  });

  it("an em dash ends the reason's clause", () => {
    expect(
      classifyFailureText(
        "\u26a0\ufe0f auto-compaction could not recover this turn. Reason: session expired \u2014 provider state missing.",
      ),
    ).toBe("session_gone");
  });

  it("does NOT claim the wider session-expired family — it may have generated", () => {
    // The class drives an automatic re-dispatch, so it may only be minted where nothing
    // can have run. The upstream family is raised elsewhere too, including where a turn
    // HAS produced something — upstream refuses to invalidate the session there
    // (`hasNewGeneratedMediaTask`), and claiming it would let a detached media task lose
    // the session it still needs, and re-run work already billed (codex P1).
    for (const text of [
      "conversation not found",
      "no such session",
      "session expired",
      "Agent run failed: session id not found",
    ]) {
      expect(classifyFailureText(text), text).not.toBe("session_gone");
    }
  });

  it("does NOT confuse a session being STARTED with one that is gone", () => {
    // They ask for opposite things: a bounded retry into the same session, versus
    // dropping the session first. The init conflict must keep its own class.
    expect(classifyFailureText("Session 7f3a already has an active turn claim")).toBe(
      "session_init_conflict",
    );
    expect(
      classifyFailureText(
        'Session "agent:alice:x" changed while starting work. Retry.',
      ),
    ).toBe("session_init_conflict");
    // …and a storage failure riding the same text still wins, as the contract says.
    expect(
      classifyFailureText(
        "database or disk is full — no conversation found for session",
      ),
    ).toBe("gateway_storage_unavailable");
  });

  it("a FULL DISK wins over the cooldown sentence riding the same text", () => {
    // The contract above is that the graver class wins, and the cooldown rule was
    // placed before both storage rules — so a gateway whose disk is full, emitting both
    // sentences, was named a credential pause and the only operator-actionable fact
    // disappeared (codex).
    expect(
      classifyFailureText(
        'database or disk is full — Auth profile "openai:x" is temporarily unavailable for openai/m.',
      ),
    ).toBe("gateway_storage_unavailable");
    expect(
      classifyFailureText(
        'database is locked — Auth profile "openai:x" is temporarily unavailable for openai/m.',
      ),
    ).toBe("gateway_storage_busy");
  });

  it("does not claim the PERMANENT credential failures that sit beside it upstream", () => {
    // Same file upstream, different fact: no usable credentials at all. A cooldown
    // sentence tells the reader to wait or switch model; this one would be a lie —
    // nothing elapses. It stays unclassified rather than borrowing a class.
    expect(
      classifyFailureText(
        'Per-entry apiKey profile "openai:x" has no usable credentials for openai.',
      ),
    ).not.toBe("auth_profile_cooldown");
    // …and an id inside ANY upstream sentence that quotes one cannot pick a class
    // either. Swept from the pinned sources: about thirty compose such a sentence, and
    // three review passes added one opening at a time while more remained (codex).
    for (const opening of [
      "Per-entry apiKey profile",
      "Per-entry apiKey",
      "No credentials found for profile",
      "Provider auth profile",
      "Selected auth profile",
      "unknown auth profile",
      // …and an opening that puts ANOTHER operator string BEFORE the credential word:
      // keying on `profile "` was still a guess about where the operator's text sits
      // (codex). Nothing quoted reaches a rule now.
      'MCP server "x" references auth profile',
    ]) {
      expect(
        classifyFailureText(
          `${opening} "reply session initialization conflicted" has no usable credentials for openai.`,
        ),
        opening,
      ).not.toBe("session_init_conflict");
      expect(
        classifyFailureText(`${opening} "prompt too large" has no usable credentials.`),
        opening,
      ).not.toBe("context_length");
    }
    expect(
      classifyFailureText('Auth profile "openai:x" type mismatch for secrets.openai.'),
    ).not.toBe("auth_profile_cooldown");
  });

  it("OVERFLOW wins over a co-occurring 5xx marker (the class that is actionable)", () => {
    expect(
      classifyFailureText("internal server error: prompt too large for the model"),
    ).toBe("context_length");
  });
});
