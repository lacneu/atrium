import { m } from "@/paraglide/messages.js";
import {
  runStatusKind,
  messageHasText as sharedMessageHasText,
  maskCredentialId,
  type RunStatusKind,
  withoutOperatorValues,
} from "../../convex/lib/chatRenderState";

// Thin localization wrapper over the SHARED pure derivation
// (convex/lib/chatRenderState). The status->kind mapping lives in that one
// module so the key-authed /api/v1/chat-state diagnostic reproduces the client's
// derived render-state from the IDENTICAL logic (no projection drift — the bug
// the API is meant to expose can't hide behind a second implementation). Here we
// only attach the FR/EN labels:
//   thinking   = streaming, no text yet              -> typing indicator
//   generating = streaming, with text                -> "still writing"
//   error      = the run failed                       -> error card
//   aborted    = the user stopped it                  -> "Interrompu"
//   (complete or unknown)                             -> null (no chip)

export type { RunStatusKind };

export interface RunStatusView {
  kind: RunStatusKind;
  /** French/EN, user-facing. */
  label: string;
  /** TRUE when the label is a PHASE-specific detail (Tools ON): callers must
   *  not replace it with the generic long-wait reassurance. */
  phased?: boolean;
}

const LABEL: Record<RunStatusKind, () => string> = {
  thinking: m.runstatus_thinking,
  generating: m.runstatus_generating,
  error: m.runstatus_error,
  aborted: m.runstatus_aborted,
};

// Live processing-phase labels: what the turn is ACTUALLY doing while silent,
// instead of the generic "thinking". Unknown wire values fall back to the
// generic label (forward-compat with newer bridges). Since the ChatGPT-style
// run representation, these are ALWAYS shown (no Tools gate) — the working
// label is conversation-level info, not tool telemetry.
const PHASE_LABEL: Record<string, () => string> = {
  processing_history: m.runstatus_phase_processing_history,
  compacting: m.runstatus_phase_compacting,
  querying_gateway: m.runstatus_phase_querying_gateway,
  awaiting_subagents: m.runstatus_phase_awaiting_subagents,
  // The gateway finished producing and is closing the turn out (deferred
  // terminal): the reader sees progress instead of an unexplained silence.
  post_processing: m.runstatus_phase_post_processing,
  // A tool is waiting on the person's approval (G-21) — answerable in the card.
  awaiting_approval: m.runstatus_phase_awaiting_approval,
  // The agent asked the person a question or for a credential, and waits.
  awaiting_input: m.runstatus_phase_awaiting_input,
  // The provider is rate-limiting and the gateway is backing off. The counter
  // is supplied separately (see `phaseRetry`): this entry is the fallback for a
  // back-off frame that arrived without one, which the wire allows.
  retrying: m.runstatus_phase_retrying,
};

/** Coarse tool families for the working label (and the lot-C flow summaries):
 *  a stable, provider-agnostic bucketing of tool NAMES. */
export type ToolFamily = "read" | "exec" | "search" | "fetch" | "write" | "other";

const FAMILY_RE: Array<[ToolFamily, RegExp]> = [
  ["read", /^(read|read_file|cat|open|view|notebook_read)$/i],
  ["exec", /^(exec|bash|shell|run|command|terminal)$/i],
  ["search", /^(web_search|search|grep|find|glob|rg)$/i],
  ["fetch", /^(web_fetch|fetch|browser|http_get)$/i],
  ["write", /^(write|write_file|apply_patch|edit|str_replace|notebook_edit)$/i],
];

export function toolFamily(toolName: string): ToolFamily {
  for (const [family, re] of FAMILY_RE) if (re.test(toolName)) return family;
  return "other";
}

const TOOL_FAMILY_LABEL: Record<ToolFamily, (name: string) => string> = {
  read: () => m.runstatus_tool_read(),
  exec: () => m.runstatus_tool_exec(),
  search: () => m.runstatus_tool_search(),
  fetch: () => m.runstatus_tool_fetch(),
  write: () => m.runstatus_tool_write(),
  other: (name) => m.runstatus_tool_other({ tool: name }),
};

export interface ActiveTool {
  name: string;
  family: ToolFamily;
}

/** The tool currently RUNNING in this turn, from the message's tool parts —
 *  or null when none is live. Today's wire appends start and completed as
 *  SEPARATE parts (no upsert yet), so a "started" part is live only while no
 *  LATER terminal part of the same tool name exists. Providers that never emit
 *  starts (OpenClaw pre-lot-B) simply yield null — honest degradation. */
export function activeToolFromParts(
  parts:
    | ReadonlyArray<{ toolName: string; phase?: string; toolCallId?: string }>
    | undefined,
): ActiveTool | null {
  if (!parts || parts.length === 0) return null;
  // Terminal matching keys on the CALL id when present (two concurrent calls
  // of the same tool: the second finishing must not mask the first, still-live
  // one — codex P2); parts without an id (legacy wire) fall back to the name.
  const key = (p: { toolName: string; toolCallId?: string }) =>
    p.toolCallId ?? p.toolName;
  const terminalSeen = new Set<string>();
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    const ph = p.phase ?? "completed";
    if (ph === "completed" || ph === "error") {
      terminalSeen.add(key(p));
      continue;
    }
    // The wire writes "start" (OpenClaw + Hermes normalizers); "started"/
    // "running" are the client-side ToolPhase aliases — accept all three.
    if (
      (ph === "start" || ph === "started" || ph === "running") &&
      !terminalSeen.has(key(p))
    ) {
      return { name: p.toolName, family: toolFamily(p.toolName) };
    }
  }
  return null;
}

export function runStatusView(
  status: string | undefined,
  hasText: boolean,
  /** Live phase of the in-flight turn (always honored — no Tools gate). */
  phase?: string | null,
  /** The tool currently running, if any — beats the phase (it is the more
   *  specific "what is happening now"), on thinking AND generating. */
  activeTool?: ActiveTool | null,
  /** The user stopped the conversation while this block's delegated work ran.
   *  A settled block then reads as interrupted (see runStatusKind). */
  interrupted?: boolean,
  /** The back-off counter that belongs to `phase: "retrying"`. Passed alongside
   *  the phase rather than folded into it: the bounded "2/10" is the whole
   *  value — an unbounded "retrying" says no more than the silence it replaces. */
  phaseRetry?: { attempt: number; maxAttempts: number } | null,
): RunStatusView | null {
  const kind = runStatusKind(status, hasText, interrupted ?? false);
  if (kind === null) return null;
  if (kind === "thinking" || kind === "generating") {
    if (activeTool) {
      return {
        kind,
        label: TOOL_FAMILY_LABEL[activeTool.family](activeTool.name),
        phased: true,
      };
    }
    if (phase === "retrying" && phaseRetry) {
      return {
        kind,
        label: m.runstatus_phase_retrying_attempt({
          attempt: String(phaseRetry.attempt),
          maxAttempts: String(phaseRetry.maxAttempts),
        }),
        phased: true,
      };
    }
    if (phase && PHASE_LABEL[phase]) {
      return { kind, label: PHASE_LABEL[phase](), phased: true };
    }
  }
  return { kind, label: LABEL[kind]() };
}

/**
 * The HONEST in-flight label when the chat's gateway is unreachable (the routed
 * instance's target is in error while the bridge itself is up): an active turn is
 * not "processing" — it is waiting on a dead gateway and will most likely time
 * out. Returns the outage label ONLY for the in-flight kinds (thinking/generating)
 * while degraded; null otherwise (the caller keeps the normal label). Pure.
 */
export function runStatusOutageLabel(
  kind: RunStatusKind,
  gatewayDegraded: boolean,
): string | null {
  if (!gatewayDegraded) return null;
  if (kind !== "thinking" && kind !== "generating") return null;
  return m.runstatus_gateway_unreachable();
}

/**
 * Actionable error presentation: maps the message's STABLE failure class — the
 * gateway's own `errorKind`, a class the bridge's text classifier minted from the
 * sentence, or a curated dispatch/watchdog code — to a localized, user-actionable
 * headline; the gateway's error text stays as the technical detail underneath (never
 * the primary line when a classification exists), MASKED of any credential id.
 * Pure — testable without React.
 *
 *   context_length -> the HARD un-recovered overflow (the context-overflow
 *                     initiative's user-facing end): explain + suggest recovery
 *   rate_limit / timeout / refusal -> honest, specific one-liners
 *   stream_orphaned -> the stuck-stream watchdog's code (kept from RunStatus)
 */
export interface ErrorDetailView {
  /** Localized headline (actionable) — null when the code is unknown. */
  headline: string | null;
  /** Technical detail: the gateway's own text, MASKED of any credential id — null
   *  when empty or redundant. */
  detail: string | null;
  /** The class this view RESOLVED to, including the text-phrasing fallback. The
   *  card keys its wired actions on THIS, not on the raw `errorCode`: an overflow
   *  recognized only by its phrasing used to get the right headline and no way out
   *  — a dead end on the one failure the app can act on itself. */
  code: string | null;
}

/** The overflow FAMILY: every class whose remedy is the same two actions (compact
 *  the session, or branch a fresh one). Exported so the card and the view stay in
 *  agreement — a new member added to one and forgotten in the other would show the
 *  right headline with no way to act on it. */
export const CONTEXT_OVERFLOW_CODES: ReadonlySet<string> = new Set([
  // The gateway's own hard overflow, mid-turn.
  "context_length",
  // The same, on a turn whose session had just been compacted (retried once).
  "context_length_compacted",
  // The bridge WITHHELD the send: measured not to fit, compaction did not shrink it.
  "context_length_presend",
]);

/** Classes whose gateway sentence instructs the reader to run a command \u2014 the
 *  headline carries the whole answer and the raw prose is suppressed on the card.
 *  Adding a code here is a promise that its headline is self-sufficient. */
export const HEADLINE_REPLACES_DETAIL: ReadonlySet<string> = new Set([
  // Upstream's preflight-compaction wrapper ends in "/compact" and "/new".
  "session_gone",
  // `Session "<key>" is archived. Restore it before starting new work.` Two
  // reasons, either of which is enough:
  //   1. It hands the reader an action Atrium now performs by itself on every
  //      send, reset and voice consult. Our headline says exactly that, so the
  //      sentence underneath CONTRADICTS it — and the whole product decision on
  //      archiving is that the user never touches the concept.
  //   2. `<key>` is `agent:<agent>:atrium:chat:<canonical>:<chatId>`: the raw
  //      prose is the one place a reader's own identifier and the chat id show
  //      up in the chat surface.
  // The sentence stays on the message row, the exports and the feedback reports
  // for the operator — that is where it is useful.
  "session_archived",
  // Same sentence, same suppression — see ERROR_CODE_LABEL for why the copy differs.
  "session_archived_historic",
]);

export const ERROR_CODE_LABEL: Record<string, () => string> = {
  context_length: m.runstatus_error_context_length,
  context_length_compacted: m.runstatus_error_context_length_compacted,
  context_length_presend: m.runstatus_error_context_length_presend,
  rate_limit: m.runstatus_error_rate_limit,
  timeout: m.runstatus_error_timeout,
  refusal: m.runstatus_error_refusal,
  stream_orphaned: m.runstatus_error_orphaned,
  connection_lost: m.runstatus_error_connection_lost,
  // A named connection end: the gateway said it was restarting, or it hung up on
  // us for being too slow to read. Both used to arrive as `connection_lost`.
  gateway_restarting: m.runstatus_error_gateway_restarting,
  connection_saturated: m.runstatus_error_connection_saturated,
  // The same two ends can also kill a send BEFORE the turn streams (failDispatch
  // stores the CURATED uppercase code then). SAME text, deliberately: the delivery
  // state is UNKNOWN at both moments, so no reader-facing wording may separate
  // them. Pre-ack does not prove nothing ran — a response frame can race ahead of
  // the `chat.send` ack (performSend handles exactly that) — and post-ack recovery
  // is not guaranteed either, since an announced absence longer than the recovery
  // budget closes the turn with no poll left (codex P1 ×2). Telling the user
  // "nothing ran, resend" would duplicate accepted agent work.
  GATEWAY_RESTARTING: m.runstatus_error_gateway_restarting,
  CONNECTION_SATURATED: m.runstatus_error_connection_saturated,
  // The agent kept working past the recovery budget (recv-silence self-heal
  // exhausted) — the turn is closed but the agent may still finish gateway-side.
  response_timeout: m.runstatus_error_response_timeout,
  compaction_timeout: m.runstatus_error_compaction_timeout,
  // The turn finished but delivered nothing usable (no text, failed file).
  empty_response: m.runstatus_error_empty_response,
  // The reply went out through a message-tool call whose arguments we could not
  // read. A NAMED cause: the fault is ours, and the label says so rather than
  // implying the agent had nothing to say.
  msgtool_args_unreadable: m.runstatus_error_msgtool_unreadable,
  // Blocked on a command approval: the missing feature is named, and the label
  // tells the reader what they CAN do — never a workaround for a defect.
  awaiting_approval: m.runstatus_error_awaiting_approval,
  // Zero-work clean close (silent NO_REPLY / end-of-run grace): auto-retried
  // by the backend; this label shows when the bounded retries also came back
  // empty.
  empty_response_silent: m.runstatus_error_empty_silent,
  unclassified_error: m.runstatus_error_unclassified,
  // Transient upstream failure (provider 5xx / overload / network cut) —
  // auto-retried (turnRetry); the card shows the countdown while scheduled.
  provider_internal: m.runstatus_error_provider_internal,
  // The gateway's transient session-init OCC conflict — Convex auto-retries the
  // turn (turnRetry.ts); this card shows during the short backoff window and, if
  // the bounded retries exhaust, stays as the honest final state.
  session_init_conflict: m.runstatus_error_session_init_conflict,
  session_write_conflict: m.runstatus_error_session_write_conflict,
  // The gateway's state database refused the write. Split by what the reader can DO: a busy
  // database is contention they can re-send through; a full, read-only or failing disk is the
  // gateway host, where only an operator can help. Neither is auto-retried.
  // The gateway had paused the auth profile and refused to use it for THIS candidate,
  // which therefore never reached the provider. A model-scoped pause does not apply to
  // another model — which is what the sentence tells the reader, conditionally.
  // Shown as soon as the turn fails, ALONGSIDE the retry countdown — the card is not
  // deferred until the retry is exhausted (RunStatus.tsx renders headline, detail and
  // countdown together), so the sentence must be true at both moments and never claim
  // an attempt that has not happened yet. It never tells the reader to type a command,
  // and the gateway prose that does is suppressed (HEADLINE_REPLACES_DETAIL).
  session_gone: m.runstatus_error_session_gone,
  // The gateway had archived an idle conversation and refused the turn. The sentence
  // never asks the reader to do anything about it — Atrium restores the session on
  // every send, and this card means that repair itself failed, which is ours to fix,
  // not theirs. It is shown alongside the retry countdown, so it must be true both
  // before and after the retry.
  session_archived: m.runstatus_error_session_archived,
  // The SAME cause, recognised from the sentence on a row stored before the class
  // existed. A separate copy because the difference is load-bearing: the other one
  // states that a second attempt is under way, and that is only true when the
  // RETRYABLE class was stored — `retryDecision` keys on the stored `errorKind`
  // (convex/turnRetry.ts), so a row written as `unclassified_error` never scheduled
  // one. Reusing the copy would have put a false operational promise on the card.
  session_archived_historic: m.runstatus_error_session_archived_historic,
  auth_profile_cooldown: m.runstatus_error_auth_profile_cooldown,
  gateway_storage_busy: m.runstatus_error_gateway_storage_busy,
  gateway_storage_unavailable: m.runstatus_error_gateway_storage_unavailable,
  // Dispatch-failure codes (failDispatch stores the CODE; localized here in the
  // reader's language — formerly pre-rendered French sentences).
  not_configured: m.runstatus_error_not_configured,
  no_agent: m.runstatus_error_no_agent,
  agent_restricted: m.runstatus_error_agent_restricted,
  send_failed: m.runstatus_error_send_failed,
  // The dispatch never reported back and was reconciled. The generic "send failed"
  // headline would tell the reader to just retry — but delivery is UNKNOWN here,
  // and a blind retry can duplicate a turn the agent already accepted.
  DISPATCH_STALLED: m.runstatus_error_dispatch_unknown,
  ATTACHMENT_TOO_LARGE: m.runstatus_error_attachment_too_large,
  ATTACHMENT_REJECTED: m.runstatus_error_attachment_rejected,
  // The BRIDGE refused the file, so the turn was never sent. The reader's answer is
  // the same for the three causes — the message is intact, the file is what could
  // not be taken, and retrying changes nothing until the instance is fixed — so
  // they share one sentence; the operator surfaces tell them apart.
  attachment_name_too_long: m.runstatus_error_attachment_name_too_long,
  attachment_path_refused: m.runstatus_error_attachment_staging,
  attachment_staging_failed: m.runstatus_error_attachment_staging,
  attachment_cleanup_unconfirmed: m.runstatus_error_attachment_staging,
};

// Defense-in-depth: overflow phrasings the UI recognizes CLIENT-side, so a bare
// overflow error string with no errorCode still gets the actionable card even if
// the bridge classifier ever misses a novel provider phrasing (the bridge is the
// primary classifier; this is the backstop).
/** The gateway's preflight-compaction wrapper, recognized from the TEXT ALONE.
 *
 *  Every row already persisted — including the one that opened this lot, stored with no
 *  errorCode at all — and every row a pre-class bridge writes during a rolling deploy
 *  carries the sentence and nothing else. Keyed on the class alone, the headline and the
 *  detail suppression both stayed inactive for exactly those rows, so reopening Denis's
 *  own conversation still showed him `/compact` and `/new` (codex).
 *
 *  The reason list and its clause-ending rule MIRROR `SESSION_GONE_REASON_RE` in
 *  bridge/src/core/failure-classifier.ts — same sentence, one read by the classifier for
 *  new rows, one read here for rows stored before the class existed. They must stay in step.
 *
 *  Placed before the overflow test, defensively — the wrapper opens with "Context is too
 *  large", and an overflow vocabulary that grew to cover that phrasing would otherwise win
 *  and put compact/branch actions on a session that no longer exists. Today's
 *  OVERFLOW_TEXT_RE does NOT match it, so the order changes nothing yet: neutralizing it
 *  leaves the suite green, and that is the honest state of it. */
const SESSION_GONE_TEXT_RE = new RegExp(
  // The clause opener is BOUND to the compaction clause — `failed:` inside it, or
  // `Reason:` opening the next sentence. Accepting an opener anywhere after the wrapper
  // still reached the second one of a composite diagnostic (codex).
  String.raw`(?:auto-compaction|preflight compaction)(?:[^\n.!?;,:—-]{0,200}?failed\s*:\s*|[^\n.!?;,:—-]{0,200}?[.!?]\s*reason\s*:\s*)(?:no conversation found|conversation (?:not found|does not exist|expired|invalid)|session (?:not found|does not exist|expired|invalid)|no such session|invalid session|(?:session|conversation) id not found)(?=[.,;:!)\]]|\s*$|\s+(?:for|on|in|with)\b|\s+[—-]\s)`,
  "i",
);

/** THE SAME REFUSAL, READ FROM ITS TEXT.
 *
 *  `session_archived` became a stored class only in 0.84.18. Keyed on the class
 *  alone, both the headline AND the detail suppression stay inactive for every row
 *  written before that — and for any row written during a rolling deploy, where
 *  Convex and the front can be ahead of the bridge image. Those rows keep showing
 *  the gateway's raw sentence, which is exactly what the suppression exists to
 *  prevent: an instruction to restore the conversation yourself (Atrium does it),
 *  and the session key, which spells out the reader's canonical id and the chat id.
 *
 *  This is the lesson `session_gone` already paid for, in the comment just above:
 *  "Keyed on the class alone, the headline and the detail suppression both stayed
 *  inactive for exactly those rows." Two readers, one sentence — the bridge's
 *  `SESSION_ARCHIVED_RE` (core/failure-classifier.ts) for new rows, this one here
 *  for rows stored before the class existed. They must stay in step.
 *
 *  Quoted spans are blanked first, mirroring the bridge's `withoutOperatorData`: a
 *  session key is operator data and must never be able to mint the class by itself. */
const SESSION_ARCHIVED_TEXT_RE =
  /is archived\.?\s*restore it before starting new work/i;

/** Operator-chosen values live inside double quotes in every upstream sentence of
 *  this family; blanking them keeps a key or a title from deciding a class. */
function withoutQuotedSpans(text: string): string {
  return text.replace(/"[^"]*"/g, '""');
}

const OVERFLOW_TEXT_RE =
  /context overflow|prompt too large|maximum context length|context[- ]length exceeded|request_too_large|request too large|input (?:token count )?exceeds the maximum number of (?:input )?tokens|input is too long for the model|too many tokens/i;

// Error-STRING codes (a stable code stored in `error` rather than `errorCode`):
// the bridge finalizes some infrastructure ends with the code as the error text
// (stream_orphaned watchdog, connection_lost socket drop). Recognized here so a
// message carrying only the string still gets its actionable headline.
const ERROR_STRING_CODES = new Set([
  "stream_orphaned",
  "connection_lost",
  "gateway_restarting",
  "connection_saturated",
  "response_timeout",
  // failDispatch stores the code string in `error` too (raw === code -> the
  // detail line is suppressed, only the localized headline shows).
  "not_configured",
  "no_agent",
  "agent_restricted",
  "send_failed",
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_REJECTED",
  "attachment_path_refused",
  "attachment_name_too_long",
  "attachment_staging_failed",
  "attachment_cleanup_unconfirmed",
]);

export function errorDetailView(
  error: string | null | undefined,
  errorCode: string | null | undefined,
): ErrorDetailView {
  // TWO readings of the text, and they are not the same one. What is SHOWN goes
  // through the display mask; what DECIDES goes through the classification normalizer,
  // which removes every operator-chosen value, not only a credential id — otherwise a
  // quoted value could still win the overflow fallback below and put context actions
  // on a failure that has nothing to do with context (codex).
  const shown = maskCredentialId((error ?? "").trim());
  const raw0 = withoutOperatorValues(shown);
  // Prefer a MAPPED errorCode; a curated-but-unmapped one (e.g.
  // BRIDGE_UNREACHABLE, kept for diagnostics) falls through to the error
  // STRING code (the localizable reason failDispatch stores), then the
  // overflow phrasing fallback, then the raw errorCode (headline null).
  // THE ONE STORED CODE THAT YIELDS TO THE TEXT.
  //
  // `unclassified_error` does not name a cause — it asserts the ABSENCE of one, in
  // so many words: "nothing gave its cause, neither the gateway nor the failure
  // text". When a text rule below does recognise the sentence, that stored code is
  // simply false, and letting it win keeps the reader staring at a card that says
  // we know nothing about a failure we can name. Every other stored code states a
  // fact and still wins outright. Nothing is lost when no rule matches: the final
  // fallback returns `errorCode` unchanged.
  const code =
    errorCode && ERROR_CODE_LABEL[errorCode] && errorCode !== "unclassified_error"
      ? errorCode
      : ERROR_STRING_CODES.has(raw0)
        ? raw0
        : SESSION_GONE_TEXT_RE.test(raw0)
          ? "session_gone"
          : SESSION_ARCHIVED_TEXT_RE.test(withoutQuotedSpans(raw0))
            ? "session_archived_historic"
            : OVERFLOW_TEXT_RE.test(raw0)
              ? "context_length"
              : (errorCode ?? null);
  const headline = code !== null ? (ERROR_CODE_LABEL[code]?.() ?? null) : null;
  // Already masked above; `raw0` is the single reading of the text in this function.
  const detail0 =
    raw0 && raw0 !== code && !ERROR_STRING_CODES.has(raw0) ? raw0 : null;
  // BELT, behind the boundary mask in `stream.finalize`.
  //
  // Keyed on the TEXT, never on the class: the very message that opened this lot was
  // stored with NO errorCode — which cost it the actionable headline, not the whole
  // card: the raw sentence still rendered as a detail line (codex) — so a
  // code-keyed mask left it, and every row persisted before the boundary mask existed,
  // showing the credential id in full (codex).
  // …and the detail line is the SHOWN text, never the normalized one: blanking a
  // session key would cost the reader the only identifier in the sentence.
  //
  // EXCEPT where the gateway's own prose tells the reader to type a command. The card
  // renders headline AND detail together (RunStatus.tsx), so a headline that carefully
  // avoids instructing the user is worth nothing while the sentence underneath still
  // says "/compact or /new" — commands Atrium has no prompt for (codex). For those
  // classes the headline is the whole answer; the raw sentence stays where it belongs,
  // on the message row — and in the exports and feedback reports built from it — for the
  // operator. NOT in the trace: that path deliberately carries `errorCode` only
  // (convex/stream.ts).
  const detail =
    shown &&
    shown !== code &&
    !ERROR_STRING_CODES.has(shown) &&
    !(code !== null && HEADLINE_REPLACES_DETAIL.has(code))
      ? shown
      : null;
  void detail0;
  return { headline, detail, code };
}

/** Re-exported from the shared module so existing importers (RunStatus) are
 *  unchanged while the implementation stays single-source. */
export const messageHasText = sharedMessageHasText;
