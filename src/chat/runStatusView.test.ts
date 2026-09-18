// UI-4: unit tests for the run-status chip mapping. The states are transient
// (sub-second) so the live capture cannot reliably prove every branch — these do.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { m } from "@/paraglide/messages.js";
import {
  runStatusView,
  runStatusOutageLabel,
  errorDetailView,
  messageHasText,
  activeToolFromParts,
  toolFamily,
} from "./runStatusView";

describe("runStatusView", () => {
  it("streaming with NO text -> thinking", () => {
    expect(runStatusView("streaming", false)).toEqual({
      kind: "thinking",
      label: "Réflexion…",
    });
  });

  it("streaming WITH text -> generating", () => {
    expect(runStatusView("streaming", true)).toEqual({
      kind: "generating",
      label: "Rédaction de la réponse…",
    });
  });

  it("error -> error chip (regardless of text)", () => {
    expect(runStatusView("error", false)?.kind).toBe("error");
    expect(runStatusView("error", true)?.kind).toBe("error");
  });

  it("aborted -> aborted chip", () => {
    expect(runStatusView("aborted", true)).toEqual({
      kind: "aborted",
      label: "Interrompu",
    });
  });

  it("complete -> no chip (null), even with text", () => {
    expect(runStatusView("complete", true)).toBeNull();
    expect(runStatusView("complete", false)).toBeNull();
  });

  it("undefined status -> thinking (the core's optimistic placeholder fills the gap)", () => {
    // The assistant-ui upcoming-message placeholder carries no status; it must
    // render the SAME thinking indicator so the send->first-token gap is covered
    // and hands off seamlessly to the real streaming doc.
    expect(runStatusView(undefined, false)).toEqual({
      kind: "thinking",
      label: "Réflexion…",
    });
  });

  it("unknown (non-empty) status -> no chip", () => {
    expect(runStatusView("weird", true)).toBeNull();
  });
});

describe("messageHasText", () => {
  it("true only for a non-empty text part", () => {
    expect(messageHasText([{ type: "text", text: "hi" }])).toBe(true);
    expect(messageHasText([{ type: "text", text: "" }])).toBe(false);
    expect(messageHasText([{ type: "text", text: "   " }])).toBe(false);
  });

  it("ignores non-text parts (tool/file/reasoning)", () => {
    expect(
      messageHasText([
        { type: "tool-call", text: undefined },
        { type: "file" },
      ]),
    ).toBe(false);
  });

  it("true when a text part coexists with other parts", () => {
    expect(
      messageHasText([{ type: "tool-call" }, { type: "text", text: "ok" }]),
    ).toBe(true);
  });

  it("false for undefined / empty content", () => {
    expect(messageHasText(undefined)).toBe(false);
    expect(messageHasText([])).toBe(false);
  });
});

describe("runStatusOutageLabel (honest in-flight label on gateway outage)", () => {
  it("returns the outage label for the IN-FLIGHT kinds while degraded", () => {
    expect(runStatusOutageLabel("thinking", true)).toContain("passerelle");
    expect(runStatusOutageLabel("generating", true)).toContain("passerelle");
  });
  it("never overrides a settled kind (error/aborted keep their own presentation)", () => {
    expect(runStatusOutageLabel("error", true)).toBeNull();
    expect(runStatusOutageLabel("aborted", true)).toBeNull();
  });
  it("returns null when the gateway is healthy (normal labels untouched)", () => {
    expect(runStatusOutageLabel("thinking", false)).toBeNull();
    expect(runStatusOutageLabel("generating", false)).toBeNull();
  });
});

describe("errorDetailView (actionable error classification)", () => {
  it("context_length -> localized headline + raw gateway text demoted to detail", () => {
    const v = errorDetailView("Context window exceeded", "context_length");
    expect(v.headline).toBeTruthy();
    expect(v.headline).not.toBe("Context window exceeded");
    expect(v.detail).toBe("Context window exceeded");
  });

  it("an inbound-staging refusal reads as a FILE problem, by code and by error string", () => {
    // The bridge refuses the file and the turn is never sent, while `failDispatch`
    // stores the code in BOTH fields — so both routes must recognise it. Live prod
    // 2026-09-17: the reader got "the chat service is momentarily unavailable",
    // which was not what happened (text-only sends went through) and was not
    // actionable (no retry can place the file).
    for (const code of [
      "attachment_path_refused",
      "attachment_staging_failed",
      "attachment_cleanup_unconfirmed",
      "attachment_name_too_long",
    ]) {
      const byCode = errorDetailView("", code);
      expect(byCode.headline, code).toBeTruthy();
      expect(byCode.headline, code).not.toBe(code);
      const byString = errorDetailView(code, null);
      expect(byString.headline, code).toBe(byCode.headline);
      // The bare code is not a useful detail line for the reader.
      expect(byString.detail, code).toBeNull();
    }
  });

  it("unknown code -> no headline, raw text stays the message", () => {
    const v = errorDetailView("some gateway error", "weird_code");
    expect(v.headline).toBeNull();
    expect(v.detail).toBe("some gateway error");
  });

  it("connection_lost (error-string code, socket drop) maps to an actionable headline, not the raw code", () => {
    const v = errorDetailView("connection_lost", null);
    expect(v.headline).toBeTruthy();
    expect(v.headline).not.toBe("connection_lost");
    expect(v.detail).toBeNull(); // the bare code is not a useful detail
  });

  it("a NAMED connection end gets its own headline, not the generic lost-connection one", () => {
    // The bridge writes these as the error STRING (the socket-drop settle path), so
    // both the code and the string route must recognize them — otherwise the reader
    // sees the bare technical code.
    const generic = errorDetailView("connection_lost", null).headline;
    for (const code of ["gateway_restarting", "connection_saturated"]) {
      const viaString = errorDetailView(code, null);
      expect(viaString.headline).toBeTruthy();
      expect(viaString.headline).not.toBe(code);
      expect(viaString.headline).not.toBe(generic);
      expect(viaString.detail).toBeNull(); // the bare code is not a useful detail
      // The UPPERCASE curated code (failDispatch, pre-ack) resolves to the SAME
      // headline: a close before the ack does not prove the request was refused —
      // a response can race ahead of it — so the reader must not be told a
      // different story per moment.
      const preAck = errorDetailView("", code.toUpperCase());
      expect(preAck.headline).toBe(viaString.headline);
      // And neither wording may promise a delivery state we cannot establish.
      expect(preAck.headline ?? "").not.toMatch(/nothing ran|never reached/i);
    }
  });

  it("stream_orphaned via error string (legacy path, no errorCode) keeps its headline", () => {
    const v = errorDetailView("stream_orphaned", null);
    expect(v.headline).toBeTruthy();
    expect(v.detail).toBeNull(); // the code string is not a useful detail
  });

  it("a gone conversation gets a card that asks the reader for NOTHING", () => {
    // The gateway's own text told a non-technical reader to type `/compact` or `/new`;
    // that is exactly what this replaces (prod-ms7ctxqf…).
    //
    // The WHOLE card, not the headline alone: RunStatus renders headline AND detail
    // together, so a careful headline over the raw sentence still shows the reader the
    // two commands — which is what the first version of this test missed (codex P2).
    const gatewayText =
      "⚠️ Context is too large and auto-compaction could not recover this turn. Reason: no conversation found for session. Try again, use /compact, or use /new to start a fresh session.";
    const v = errorDetailView(gatewayText, "session_gone");
    expect(v.headline).toBeTruthy();
    expect(v.detail).toBeNull();
    const card = `${v.headline ?? ""} ${v.detail ?? ""}`;
    expect(card).not.toMatch(/\/new|\/compact/);
    // …and the sentence must be true BOTH before and after the automatic retry, which
    // the card shows a countdown for right underneath: it may not report an attempt
    // that has not happened yet.
    //
    // EVERY locale, named explicitly. The card renders in the reader's language, and a
    // view-level assertion only ever exercises the ONE locale the test run resolves to —
    // so a regression in the other sentence would sail through it (proven: neutralizing
    // the English text left this test green).
    for (const locale of ["en", "fr"] as const) {
      const sentence = m.runstatus_error_session_gone({}, { locale });
      expect(sentence, locale).not.toMatch(/\/new|\/compact/);
      expect(sentence, locale).not.toMatch(
        /did not succeed|second attempt|was started|a été ouverte|n'a pas abouti/i,
      );
      // …and it may not promise that the reader has nothing to do. The single automatic
      // attempt can be refused at schedule time or stand down when it fires (turnRetry:
      // chat busy, the message changed, content appeared); the countdown then disappears
      // and this sentence stays — in a state where re-sending IS the answer (codex).
      expect(sentence, locale).not.toMatch(
        /nothing to do|do not have to do anything|rien à faire/i,
      );
      // …nor state the recovery as a FACT. The retry can stand down at fire time (the
      // message changed, content landed, a real send is in flight), and the card stays
      // while the countdown goes (codex). Only an attempt may be claimed.
      expect(sentence, locale).not.toMatch(
        /Atrium (?:re)?opens|Atrium (?:en )?(?:r)?ouvre\b/i,
      );
      // …nor announce the history carry-over: the bridge skips rehydration when it is
      // disabled, and on any turn carrying an attachment (server.ts) — so a gone session on
      // a message with a file deliberately restarts WITHOUT the earlier history (codex).
      expect(sentence, locale).not.toMatch(
        /your history|votre historique/i,
      );
    }
    expect(card).not.toMatch(/did not succeed|second attempt|was started|a été ouverte/i);
    expect(v.headline).not.toBe(errorDetailView("fetch failed", "provider_internal").headline);
  });

  it("the SAME card on a row that carries no errorCode at all", () => {
    // The row that opened this lot was stored with no class — and a pre-class bridge keeps
    // writing such rows through a rolling deploy. Keyed on the class alone, the headline
    // and the suppression were both inactive for exactly those rows: reopening Denis's own
    // conversation still showed him the two commands (codex).
    const gatewayText =
      "\u26a0\ufe0f Context is too large and auto-compaction could not recover this turn. Reason: no conversation found for session. Try again, use /compact, or use /new to start a fresh session.";
    const v = errorDetailView(gatewayText, null);
    expect(v.code).toBe("session_gone");
    expect(v.detail).toBeNull();
    expect(`${v.headline ?? ""} ${v.detail ?? ""}`).not.toMatch(/\/new|\/compact/);
    // …and NOT the overflow card: it offers to compact or branch, on a session that no
    // longer exists. Today nothing contests this — OVERFLOW_TEXT_RE does not match the
    // wrapper's "Context is too large" — so this pins the outcome, not a precedence.
    expect(v.code).not.toBe("context_length");
  });

  it("the historical fallback covers EVERY reason the bridge classifies", () => {
    // The two vocabularies must stay in step: a reason the bridge mints the class for, on
    // a row stored before the class existed, has to reach the same card (codex).
    for (const reason of [
      "no conversation found for session",
      "conversation not found",
      "conversation does not exist",
      "conversation expired",
      "conversation invalid",
      "session not found",
      "session does not exist",
      "session expired",
      "session invalid",
      "no such session",
      "invalid session",
      "session id not found",
      "conversation id not found",
    ]) {
      const v = errorDetailView(
        `\u26a0\ufe0f Context is too large and auto-compaction could not recover this turn. Reason: ${reason}. Try again, use /compact, or use /new to start a fresh session.`,
        null,
      );
      expect(v.code, reason).toBe("session_gone");
      expect(v.detail, reason).toBeNull();
    }
  });

  it("a COMPOSITE diagnostic does not pair two unrelated sentences into the class", () => {
    // One line, two facts: a compaction settings problem, and a gone session mentioned in a
    // separate clause. The bounded window alone still joined them (codex).
    const v = errorDetailView(
      "Preflight compaction required but failed: invalid session settings. Diagnostic: no conversation found for session.",
      null,
    );
    expect(v.code).not.toBe("session_gone");
  });

  it("a SECOND clause opener, belonging to another diagnostic, is not ours", () => {
    const v = errorDetailView(
      "Preflight compaction required but failed: invalid session settings. Session cleanup failed: session not found.",
      null,
    );
    expect(v.code).not.toBe("session_gone");
    for (const text of [
      "Preflight compaction succeeded; session cleanup failed: session not found.",
      "Preflight compaction required but failed: invalid session settings, but session cleanup failed: session not found.",
      "Preflight compaction succeeded - session cleanup failed: session not found.",
      "Preflight compaction succeeded: session cleanup failed: session not found.",
    ]) {
      expect(errorDetailView(text, null).code, text).not.toBe("session_gone");
    }
  });

  it("an em dash ends the reason's clause", () => {
    // The terminator list claimed to accept a dash while requiring a word character right
    // after it — so the ordinary spaced form never matched, and nothing covered it (codex).
    const v = errorDetailView(
      "⚠️ auto-compaction could not recover this turn. Reason: session expired — provider state missing.",
      null,
    );
    expect(v.code).toBe("session_gone");
  });

  it("a compaction failure that is NOT a gone conversation keeps the gateway text", () => {
    // The reason has to end its clause; "invalid session settings" is a compaction problem
    // on a LIVE conversation, and hiding its detail would cost the reader the only thing
    // that says what went wrong.
    const v = errorDetailView(
      "Preflight compaction required but failed: invalid session settings for compaction",
      null,
    );
    expect(v.code).not.toBe("session_gone");
    expect(v.detail).toBeTruthy();
  });

  it("an ordinary overflow still gets the overflow card", () => {
    // The text fallback above is narrow: the wrapper AND a gone-session reason.
    const v = errorDetailView("maximum context length exceeded", null);
    expect(v.code).toBe("context_length");
  });

  it("suppressing the detail is SCOPED — every other class keeps the gateway text", () => {
    // The suppression is a targeted answer to prose that instructs the reader, not a
    // licence to hide what the gateway said.
    const v = errorDetailView("boom: upstream said no", "provider_internal");
    expect(v.detail).toBe("boom: upstream said no");
  });

  it("an auth-profile cooldown gets its OWN card, not the provider-blip one", () => {
    // The reported turn produced no text and no class, so the reader got the gateway's
    // English sentence and nothing else — no headline, nothing to act on (feedback
    // prod-ms7ed3bn…). The class is what supplies the headline.
    const v = errorDetailView(
      'Auth profile "openai:someone@example.com" is temporarily unavailable for openai/gpt-5.6-terra.',
      "auth_profile_cooldown",
    );
    expect(v.headline).toBeTruthy();
    expect(v.headline).not.toBe(v.detail);
    // …and it is NOT the transient-upstream card: that one promises an automatic
    // retry this class deliberately does not get.
    const providerBlip = errorDetailView("fetch failed", "provider_internal");
    expect(v.headline).not.toBe(providerBlip.headline);
  });

  it("a quoted value cannot win the overflow fallback", () => {
    // With no usable errorCode, the view falls back to phrasing. It read the DISPLAY
    // mask, which leaves every non-credential quoted value in place — so a stored row
    // could put context-overflow actions on a failure that has nothing to do with
    // context (codex). The decision reads the classification normalizer now.
    const v = errorDetailView('Session "prompt too large" was deleted.', null);
    expect(v.code).not.toBe("context_length");
    // …and a real overflow phrasing, unquoted, still gets its card.
    expect(errorDetailView("prompt too large for the model", null).code).toBe(
      "context_length",
    );
  });

  it("the cooldown detail does NOT carry the profile id to the reader", () => {
    // The detail is the gateway's own sentence, shown below the headline and copied
    // with the message. Upstream lets an operator name a profile anything; the reported
    // one was an EMAIL, and the reader of a chat is not necessarily the credential's
    // owner (codex). The whole remainder goes with it — provider and model included — because a
    // partial redaction of an operator-chosen string is not winnable; see the masker.
    // New rows never hold the id, and the one-time migration clears the old ones; the
    // operator reads it on the gateway, which is what the message tells them.
    const v = errorDetailView(
      'Auth profile "openai:olivier@example.com" is temporarily unavailable for openai/gpt-5.6-terra.',
      "auth_profile_cooldown",
    );
    expect(v.detail).toBeTruthy();
    expect(v.detail).not.toContain("olivier@example.com");
    expect(v.detail).toBe('Auth profile "…');
    // Any id, not just an email-looking one.
    expect(
      errorDetailView(
        'Auth profile "acme-prod-key-7" is temporarily unavailable for anthropic.',
        "auth_profile_cooldown",
      ).detail,
    ).not.toContain("acme-prod-key-7");
    // …and it does NOT depend on the class. The message that opened this lot was
    // stored with NO errorCode — which cost it the headline, not the detail line — so a
    // code-keyed mask would have left that very row, and every row persisted before
    // the boundary mask existed, showing the id in full (codex).
    const noCode = errorDetailView(
      'Auth profile "openai:olivier@example.com" is temporarily unavailable for openai/gpt-5.6-terra.',
      null,
    );
    expect(noCode.detail).toBeTruthy();
    expect(noCode.detail).not.toContain("olivier@example.com");
    // A sentence that is not this one keeps its text: the mask rewrites the quoted id
    // after "Auth profile", nothing else.
    expect(errorDetailView("fetch failed", "provider_internal").detail).toBe(
      "fetch failed",
    );
  });

  it("the gateway's STORAGE failures each get their own headline, detail kept", () => {
    // Two classes because the answer differs: contention the reader can re-send through, and a
    // host the reader cannot fix. The gateway's own English sentence stays BELOW the localized
    // headline — it is what names disk-full versus read-only versus I/O.
    const busy = errorDetailView(
      "⚠️ Agent run failed: the Gateway state database was busy (SQLite: database is locked). Retry; if it repeats, check Gateway storage health.",
      "gateway_storage_busy",
    );
    const unavailable = errorDetailView(
      "⚠️ Agent run failed: the Gateway state database was full (SQLite: database or disk is full). Free disk space on the Gateway host and retry.",
      "gateway_storage_unavailable",
    );
    for (const v of [busy, unavailable]) {
      expect(v.headline).toBeTruthy();
      expect(v.detail).toBeTruthy();
      expect(v.headline).not.toBe(v.detail);
    }
    // And they are not the same card: one tells the reader to resend, the other that only an
    // operator can clear it. A single shared headline would be half wrong in both cases.
    expect(busy.headline).not.toBe(unavailable.headline);
  });

  it("rate_limit / timeout / refusal all classify", () => {
    for (const code of ["rate_limit", "timeout", "refusal"]) {
      expect(errorDetailView(null, code).headline).toBeTruthy();
    }
  });

  it("compaction_timeout -> actionable headline (the #40295 deadlock class)", () => {
    const v = errorDetailView(
      "The gateway did not finish optimizing (compacting) the session in time.",
      "compaction_timeout",
    );
    expect(v.headline).toBeTruthy();
    expect(v.headline).not.toBe(v.detail);
  });

  it("CLIENT-side fallback: a bare overflow error string with NO errorCode still gets the card", () => {
    // Defense-in-depth if the bridge classifier ever misses a novel phrasing.
    for (const text of [
      "request_too_large: 300000 tokens",
      "input exceeds the maximum number of tokens",
      "input is too long for the model",
      "This model's maximum context length is 272000 tokens",
    ]) {
      const v = errorDetailView(text, null);
      expect(v.headline, `phrasing: ${text}`).toBeTruthy();
    }
  });

  it("a non-overflow bare string with no code stays generic (no false positive)", () => {
    const v = errorDetailView("some unrelated gateway hiccup", null);
    expect(v.headline).toBeNull();
  });

  it("no error, no code -> nothing", () => {
    const v = errorDetailView(null, null);
    expect(v.headline).toBeNull();
    expect(v.detail).toBeNull();
  });
});

describe("live working label (phase/tool — always on, ChatGPT-style)", () => {
  it("thinking + a known phase -> the phase label (not the generic thinking)", () => {
    const v = runStatusView("streaming", false, "awaiting_subagents");
    expect(v?.kind).toBe("thinking");
    expect(v?.label).not.toBe(runStatusView("streaming", false)?.label);
  });
  it("an UNKNOWN wire phase falls back to the generic thinking label (forward-compat)", () => {
    const v = runStatusView("streaming", false, "some_future_phase");
    expect(v?.label).toBe(runStatusView("streaming", false)?.label);
  });
  it("a phase NOW shows on generating too (the working label is not thinking-only)", () => {
    const v = runStatusView("streaming", true, "compacting");
    expect(v?.kind).toBe("generating");
    expect(v?.label).not.toBe(runStatusView("streaming", true)?.label);
    expect(v?.phased).toBe(true);
  });
  it("a phase label is flagged `phased` so the long-wait fallback never replaces it", () => {
    expect(runStatusView("streaming", false, "compacting")?.phased).toBe(true);
    expect(runStatusView("streaming", false)?.phased).toBeUndefined();
    expect(runStatusView("streaming", false, "unknown_phase")?.phased).toBeUndefined();
  });
  it("a back-off shows its BOUNDED counter, not a bare label", () => {
    // The counter is the whole value: "retrying" alone says no more than the
    // silence it replaces, while 2/10 tells the reader it is progressing and
    // will stop. Before this the turn showed the FINISHING label instead,
    // because each re-entered attempt re-emitted the deferred terminal.
    const withCount = runStatusView("streaming", false, "retrying", null, false, {
      attempt: 2,
      maxAttempts: 10,
    });
    expect(withCount?.phased).toBe(true);
    // ORDER matters: `toContain("2")` + `toContain("10")` also passed on "10/2",
    // which reads as attempt ten of two (raised in review). The pair is asserted
    // as a unit; the surrounding wording stays free to be translated.
    expect(withCount?.label).toContain("2/10");
    expect(withCount?.label).not.toContain("10/2");
    // …and it is NOT the finishing label the turn used to show.
    expect(withCount?.label).not.toBe(
      runStatusView("streaming", false, "post_processing")?.label,
    );
  });

  it("a back-off WITHOUT a counter still says what is happening", () => {
    // The wire allows it: `retry` is optional, and the frame is sent with
    // `dropIfSlow`, so an attempt can be missed entirely. Falling back to the
    // generic label beats falling back to silence.
    const bare = runStatusView("streaming", false, "retrying");
    expect(bare?.phased).toBe(true);
    expect(bare?.label).not.toBe(runStatusView("streaming", false)?.label);
  });

  it("the ACTIVE TOOL beats the phase, on thinking AND generating", () => {
    const tool = { name: "web_search", family: "search" as const };
    const thinking = runStatusView("streaming", false, "compacting", tool);
    const generating = runStatusView("streaming", true, "compacting", tool);
    expect(thinking?.phased).toBe(true);
    expect(generating?.phased).toBe(true);
    expect(thinking?.label).toBe(generating?.label);
    expect(thinking?.label).not.toBe(
      runStatusView("streaming", false, "compacting")?.label,
    );
  });
  it("an 'other'-family tool shows its own name in the label", () => {
    const v = runStatusView("streaming", false, null, {
      name: "sessions_spawn",
      family: "other",
    });
    expect(v?.label).toContain("sessions_spawn");
  });
  it("a settled turn ignores tool/phase entirely (no chip)", () => {
    expect(
      runStatusView("complete", true, "compacting", {
        name: "exec",
        family: "exec",
      }),
    ).toBeNull();
  });
});

describe("activeToolFromParts (today's append-only wire, pre-upsert)", () => {
  it("a started part with no later terminal of the same tool is LIVE", () => {
    expect(
      activeToolFromParts([{ toolName: "exec", phase: "started" }]),
    ).toEqual({ name: "exec", family: "exec" });
  });
  it("the REAL wire phase 'start' (both normalizers) is live too", () => {
    expect(
      activeToolFromParts([{ toolName: "web_search", phase: "start" }]),
    ).toEqual({ name: "web_search", family: "search" });
  });
  it("a started part FOLLOWED by its completed twin is no longer live (Hermes appends both)", () => {
    expect(
      activeToolFromParts([
        { toolName: "exec", phase: "started" },
        { toolName: "exec", phase: "completed" },
      ]),
    ).toBeNull();
  });
  it("the MOST RECENT live tool wins when two are open", () => {
    expect(
      activeToolFromParts([
        { toolName: "read", phase: "started" },
        { toolName: "web_search", phase: "started" },
      ]),
    ).toEqual({ name: "web_search", family: "search" });
  });
  it("CONCURRENT same-name calls: the second finishing must not mask the first (id-keyed)", () => {
    expect(
      activeToolFromParts([
        { toolName: "exec", phase: "start", toolCallId: "A" },
        { toolName: "exec", phase: "completed", toolCallId: "B" },
      ]),
    ).toEqual({ name: "exec", family: "exec" });
  });
  it("an error terminal also closes its tool", () => {
    expect(
      activeToolFromParts([
        { toolName: "exec", phase: "started" },
        { toolName: "exec", phase: "error" },
      ]),
    ).toBeNull();
  });
  it("coalesced completed-only parts (OpenClaw today) yield null — honest degradation", () => {
    expect(
      activeToolFromParts([
        { toolName: "exec", phase: "completed" },
        { toolName: "web_search", phase: "completed" },
      ]),
    ).toBeNull();
  });
  it("no parts / undefined -> null", () => {
    expect(activeToolFromParts(undefined)).toBeNull();
    expect(activeToolFromParts([])).toBeNull();
  });
});

describe("toolFamily bucketing", () => {
  it("maps the canonical names of each family", () => {
    expect(toolFamily("read")).toBe("read");
    expect(toolFamily("exec")).toBe("exec");
    expect(toolFamily("web_search")).toBe("search");
    expect(toolFamily("web_fetch")).toBe("fetch");
    expect(toolFamily("apply_patch")).toBe("write");
    expect(toolFamily("sessions_spawn")).toBe("other");
  });
});

describe("the two surfaces that show an error go through this view", () => {
  // The mask that protects rows persisted before the boundary mask existed lives in
  // `errorDetailView`. Testing the function alone left both CONSUMERS free to read the
  // raw error instead, which would re-expose those ids on screen and in the clipboard
  // (codex). Read as source, comments stripped, because a DOM test of either component
  // would not say which value it rendered.
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const read = (f: string) =>
    strip(readFileSync(new URL(f, import.meta.url), "utf8"));

  it("the error CARD renders what errorDetailView returned, not the raw error", () => {
    const src = read("./RunStatus.tsx");
    // …and its two inputs still come from the stored message. Pinning only the CALL
    // left `errorDetailView(null, null)` green while the real card lost both its
    // headline and its detail (codex).
    expect(src).toMatch(
      /const error = useMessage\(\(m\) => \(m\.metadata\?\.custom as RunMeta \| undefined\)\?\.error\);/,
    );
    expect(src).toMatch(
      /const errorCode = useMessage\(\s*\(m\) => \(m\.metadata\?\.custom as RunMeta \| undefined\)\?\.errorCode,/,
    );
    expect(src).toMatch(
      /const \{ headline, detail, code \} = errorDetailView\(error, errorCode\);/,
    );
    // …and the card body shows that `detail`, never the `error` it was built from.
    // TOTAL, not a window: `error` may appear nowhere in the rendered JSX. The first
    // version of this guard looked for a CSS class that does not exist
    // (`oc-error-card__detail`; the real one is `oc-error-card__msg--detail`), so it
    // was green whatever the card rendered (codex) — a guard that cannot fail.
    expect(src).toMatch(/\{detail\}/);
    const jsx = src.slice(src.indexOf('<div className="oc-error-card"'));
    expect(
      /\{\s*error\s*\}/.test(jsx),
      "the card renders the raw error text somewhere in its JSX",
    ).toBe(false);
  });

  it("COPY builds its payload from the view, not from the raw error", () => {
    const src = read("./ConvexChat.tsx");
    expect(src).toMatch(/const detail = errorDetailView\(error, errorCode\);/);
    // Same for the clipboard's own two selectors.
    expect(src).toMatch(/\)\?\.error \?\? null,/);
    expect(src).toMatch(/\)\?\.errorCode \?\? null,/);
    // The WHOLE payload expression, anchored: asserting only that the safe expression
    // exists somewhere left `error ||` free to sit in front of it (codex).
    expect(src).toMatch(
      /const payload =\s*text\.trim\(\) \|\|\s*\[detail\.headline, detail\.detail\]\.filter\(Boolean\)\.join\("\\n"\);/,
    );
  });
});
