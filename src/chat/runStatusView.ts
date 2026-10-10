import { m } from "@/paraglide/messages.js";
import {
  runStatusKind,
  messageHasText as sharedMessageHasText,
  maskCredentialId,
  type RunStatusKind,
} from "../../convex/lib/chatRenderState";
import { classifyStoredFailureText, unwrapGatewayFailure } from "../../convex/lib/failureText";
import { turnDifficultyLabel, type TurnDifficulty } from "./turnDifficultyView";

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
  /** TRUE when the label is the live turn's DIFFICULTY (convex/lib/turnDifficulty):
   *  the chip takes its warning tone — the same state the sidebar bar shows. */
  struggling?: boolean;
}

/** Phases that ask the READER to act: their label stays on the chip even when the
 *  turn is struggling — "answer the question" is the one thing the reader can do. */
const READER_ACTION_PHASES: ReadonlySet<string> = new Set([
  "awaiting_approval",
  "awaiting_input",
]);

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
  /** The live turn's difficulty, when the agent is struggling (the verdict of
   *  convex/lib/turnDifficulty, judged by the caller at its clock). Beats the running
   *  tool and the phase: "working on view_image" is exactly the sentence that hid a
   *  fourth failed view_image. Only a phase that asks the reader to act beats it. */
  difficulty?: TurnDifficulty | null,
): RunStatusView | null {
  const kind = runStatusKind(status, hasText, interrupted ?? false);
  if (kind === null) return null;
  if (kind === "thinking" || kind === "generating") {
    if (difficulty && !(phase && READER_ACTION_PHASES.has(phase))) {
      return {
        kind,
        label: turnDifficultyLabel(difficulty),
        phased: true,
        struggling: true,
      };
    }
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
   *  when empty, redundant, suppressed, or moved to `rawDetail`. */
  detail: string | null;
  /** The gateway's raw text for a collapsible "Details" with a copy button (the Control
   *  UI's own pattern: headline first, the full text one click away) — set instead of
   *  `detail` when the text is upstream's GENERIC wrapper ("Context is too large …",
   *  "Something went wrong …") or a cause the headline already states, so the wrapper's
   *  words never sit under the headline as if they were the cause. */
  rawDetail: string | null;
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
  // The provider-review pause quotes the same session key (OpenClaw 2026.9.6).
  "session_paused_review",
  // An agent-database refusal tells the reader to stop the gateway and run
  // `openclaw doctor --fix`, and its reason can name a database path on the gateway
  // host (src/state/agent-database-admission.ts:56-57 and :81 at v2026.9.6). Neither
  // belongs on the reader's card; the sentence stays on the row for the operator.
  "gateway_agent_db_closed",
  // A revoked provider credential arrives wrapped in upstream's "Context is too large …
  // Try again, use /compact, or use /new" — three instructions that cannot help, under a
  // headline that says only an administrator can — plus the gateway's re-authentication
  // command. Neither belongs on the reader's card; the sentence stays on the row.
  "provider_auth_revoked",
  // The two other credential refusals carry the same wrapper and the same command.
  "provider_permission_denied",
  "provider_auth_failed",
]);

/** Classes whose gateway text belongs in the collapsible Details rather than under the
 *  headline: the headline already states the cause, and the text is upstream's copy written
 *  for the gateway's own operator ("Check your provider's billing dashboard and top up …",
 *  "Check the model id …") or, for the no-cause classes, the generic wrapper itself. */
const DETAIL_IN_DISCLOSURE: ReadonlySet<string> = new Set([
  "provider_billing",
  "model_not_found",
  "compaction_failed_no_cause",
  "run_failed_no_cause",
  "compaction_timeout",
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
  // The gateway paused the conversation after a provider refusal (OpenClaw 2026.9.6).
  // Stated as it is: no retry is under way, and none would help.
  session_paused_review: m.runstatus_error_session_paused_review,
  // The gateway refused the send on the session's own rules (OpenClaw 2026.9.6), before
  // anything ran. Both reach the card only as dispatch failures, whose stored `error` is
  // the reason code (`send_failed`) — so the raw upstream sentence never shows under the
  // headline, and neither needs a text rule or HEADLINE_REPLACES_DETAIL. Neither is
  // retried: the visibility refuses the same person the same way until its owner changes
  // it, and a changed permission mode is for the reader to look at before sending again.
  session_visibility_refused: m.runstatus_error_session_visibility_refused,
  session_settings_changed: m.runstatus_error_session_settings_changed,
  // The BRIDGE withheld the turn: the owner's chosen permission mode could not be put on
  // the session it would run on (refused, not authorized, or a gateway without modes).
  // Stored as a dispatch code like the two above; never retried.
  permission_mode_not_applied: m.runstatus_error_permission_mode_not_applied,
  // The BRIDGE withheld the turn: the owner's choice of knowledge sources for this agent
  // could not be put on the session (the plugin refused it or is gone, or the bridge
  // cannot apply it). Stored as a dispatch code; never retried.
  knowledge_policy_not_applied: m.runstatus_error_knowledge_policy_not_applied,
  // The BRIDGE refused the turn: the instance's gateway runs a version below the
  // supported minimum (2026.8.2). Only an administrator can act (upgrade the gateway);
  // stored as a dispatch code, never retried.
  gateway_version_unsupported: m.runstatus_error_gateway_version_unsupported,
  auth_profile_cooldown: m.runstatus_error_auth_profile_cooldown,
  // The model provider refused the agent's credential (revoked or expired). Nothing is
  // retried (convex/turnRetry.ts) and nothing the reader does helps: the copy says an
  // administrator must reconnect the agent, and that resending changes nothing until then.
  provider_auth_revoked: m.runstatus_error_provider_auth_revoked,
  // A 403 / `auth_permanent`: the account lacks a right or is blocked. Reconnecting the same
  // account does not help — the one thing the revoked-credential copy would have suggested.
  provider_permission_denied: m.runstatus_error_provider_permission_denied,
  // An auth refusal nothing qualifies (upstream's re-authentication hint alone): the copy
  // claims neither an expiry nor a permission, only that an administrator must look.
  provider_auth_failed: m.runstatus_error_provider_auth_failed,
  provider_billing: m.runstatus_error_provider_billing,
  model_not_found: m.runstatus_error_model_not_found,
  // An operator logged the provider out on the gateway, which aborted the run
  // (`stopReason: "auth-revoked"`) — never the reader's own Stop.
  provider_access_removed: m.runstatus_error_provider_access_removed,
  // Upstream's generic wrapper with no cause inside: a neutral headline that says so, no
  // compaction or branching advice, and the gateway's words in the Details.
  compaction_failed_no_cause: m.runstatus_error_compaction_failed_no_cause,
  run_failed_no_cause: m.runstatus_error_run_failed_no_cause,
  // The gateway dropped the admitted input: another reply was being written at the same
  // moment. Nothing ran, and no retry is scheduled (convex/turnRetry.ts) — the copy says
  // so by asking the reader to send again, and claims no attempt of its own. It holds
  // for rows stored before the class existed too, so the text fallback below shares it.
  pending_input_dropped: m.runstatus_error_pending_input_dropped,
  gateway_storage_busy: m.runstatus_error_gateway_storage_busy,
  gateway_storage_unavailable: m.runstatus_error_gateway_storage_unavailable,
  // The gateway closed the agent's database to new work (OpenClaw 2026.9.5+). Not retried.
  gateway_agent_db_closed: m.runstatus_error_gateway_agent_db_closed,
  // Dispatch-failure codes (failDispatch stores the CODE; localized here in the
  // reader's language — formerly pre-rendered French sentences).
  not_configured: m.runstatus_error_not_configured,
  no_agent: m.runstatus_error_no_agent,
  agent_restricted: m.runstatus_error_agent_restricted,
  // The turn was addressed to a room agent taken out of the room before it could
  // be sent (the `agent_restricted` refusal, finer code): nobody's access changed,
  // so the generic "your access changed" headline would send the reader looking
  // for the wrong cause.
  AGENT_LEFT_ROOM: m.runstatus_error_agent_left_room,
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
  // The bridge refused a send too large for the gateway's frame: the reader shortens
  // the text or sends fewer or smaller files.
  message_too_large: m.runstatus_error_message_too_large,
  // A sub-agent's reply is still owed on the conversation's socket: send again soon.
  subagent_reply_pending: m.runstatus_error_subagent_reply_pending,
};

// THE STORED TEXT, READ LIKE THE BRIDGE READS A FRESH ONE.
//
// A row stored before its class existed — or by an older bridge during a rolling deploy —
// carries only the gateway's sentence. It is classified by the front's MIRROR of the bridge's
// classifier (convex/lib/failureText.ts: same patterns, same unwrapping, same precedence,
// held to the bridge's verdicts by a parity test), so a stored row renders as a fresh one.
// Only the classes whose copy holds for a HISTORIC row become its code: a copy that promises
// a retry (`provider_internal`, the session conflicts) would be false there, since the retry
// policy keys on the STORED errorKind (convex/turnRetry.ts) and never scheduled one.

const FALLBACK_SUMMARY_TEXT_RE = /^\s*all (?:[a-z][\w -]{0,60}? )?models failed \(\d+\):\s*/i;
const FALLBACK_ATTEMPT_PREFIX_TEXT_RE = /^[^\s/|]+\/\S+?:\s+/;
const PENDING_INPUT_DROPPED_TEXT_RE =
  /pending input is no longer active in its admitted transcript/i;

/** Does this text prove the input was dropped AND nothing ran? A model-fallback summary
 *  qualifies only when EVERY attempt lost its input, because an attempt that failed any
 *  other way may have streamed or run a tool first, and the card promises "nothing was
 *  processed". Stricter than the bridge's rule, which also accepts a candidate refused at
 *  preparation for a credential cooldown: a stored text cannot prove that one, since the
 *  credential mask cuts it at the profile id's quote. */
function droppedInputWithNothingRun(text: string): boolean {
  const head = FALLBACK_SUMMARY_TEXT_RE.exec(text);
  if (head === null) return PENDING_INPUT_DROPPED_TEXT_RE.test(text);
  const attempts = text
    .slice(head[0].length)
    .split(" | ")
    .map((segment) => segment.trim())
    .filter((segment) => FALLBACK_ATTEMPT_PREFIX_TEXT_RE.test(segment))
    .map((segment) => segment.replace(FALLBACK_ATTEMPT_PREFIX_TEXT_RE, ""));
  return (
    attempts.length > 0 && attempts.every((a) => PENDING_INPUT_DROPPED_TEXT_RE.test(a))
  );
}

/** The classes a STORED text may name on the card — each one's copy is true for a row whose
 *  class was never stored, and promises no retry that never ran. */
const TEXT_DERIVABLE_CODES: ReadonlySet<string> = new Set([
  "session_gone",
  "session_paused_review",
  "provider_auth_revoked",
  "provider_permission_denied",
  "provider_auth_failed",
  "provider_billing",
  "model_not_found",
  "rate_limit",
  "context_length",
  "compaction_timeout",
  "compaction_failed_no_cause",
  "run_failed_no_cause",
]);

const CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "provider_auth_revoked",
  "provider_permission_denied",
  "provider_auth_failed",
]);

/** The card code a stored text names, or null. */
function codeFromStoredText(shown: string): string | null {
  const cls = classifyStoredFailureText(shown);
  if (cls === null) return null;
  // The archived refusal keeps a copy of its own for a stored row: the class's copy states
  // that a second attempt is under way, true only when the RETRYABLE class was stored.
  if (cls === "session_archived") return "session_archived_historic";
  if (cls === "pending_input_dropped") {
    return droppedInputWithNothingRun(shown) ? "pending_input_dropped" : null;
  }
  return TEXT_DERIVABLE_CODES.has(cls) ? cls : null;
}

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
  "message_too_large",
  "subagent_reply_pending",
  // The bridge stores the provider-logout abort under its code, as its text too.
  "provider_access_removed",
]);

export function errorDetailView(
  error: string | null | undefined,
  errorCode: string | null | undefined,
): ErrorDetailView {
  // What is SHOWN goes through the display mask; what DECIDES goes through the mirror
  // classifier, which removes every operator-chosen value itself, not only a credential id —
  // otherwise a quoted value could still choose a class (codex).
  const shown = maskCredentialId((error ?? "").trim());
  const fromText = shown === "" ? null : codeFromStoredText(shown);
  // Prefer a MAPPED errorCode; a curated-but-unmapped one (e.g. BRIDGE_UNREACHABLE, kept for
  // diagnostics) falls through to the error STRING code (the localizable reason failDispatch
  // stores), then the text's own class, then the raw errorCode (headline null).
  //
  // `unclassified_error` is the ONE stored code that yields to the text: it does not name a
  // cause, it asserts the ABSENCE of one, and a text rule that recognises the sentence makes
  // it false. Every other stored code states a fact and wins — with one exception: 0.91.2
  // stored `provider_auth_revoked` for upstream's re-authentication hint ALONE, which also
  // follows a 403, a region or a deactivated workspace. Where the stored text itself names
  // one of the other two credential classes, that row's code was wrong, and the "access
  // expired, reconnect" card on a permission refusal is the very advice this removes.
  let code: string | null;
  if (errorCode && ERROR_CODE_LABEL[errorCode] && errorCode !== "unclassified_error") {
    code =
      errorCode === "provider_auth_revoked" &&
      fromText !== null &&
      fromText !== errorCode &&
      CREDENTIAL_CODES.has(fromText)
        ? fromText
        : errorCode;
  } else if (ERROR_STRING_CODES.has(shown)) {
    code = shown;
  } else {
    code = fromText ?? errorCode ?? null;
  }
  const headline = code !== null ? (ERROR_CODE_LABEL[code]?.() ?? null) : null;
  // The text is redundant when it IS the code (the curated codes stored as `error`).
  const isCodeText = shown === "" || shown === code || ERROR_STRING_CODES.has(shown);
  // Where the gateway's prose tells the reader to type a command (`/compact`, `/new`, a
  // re-authentication command) or names an identifier that is not theirs to see, the
  // headline is the whole answer: the card renders headline AND detail together
  // (RunStatus.tsx), so a careful headline is worth nothing under that sentence (codex). The
  // sentence stays on the message row — and in the exports and feedback reports built from
  // it — for the operator. NOT in the trace: that path carries `errorCode` only.
  const suppressed = code !== null && HEADLINE_REPLACES_DETAIL.has(code);
  // A GENERIC upstream wrapper never sits under the headline as if it were the cause: with a
  // cause found inside it, the headline names that cause; without one, the headline says the
  // gateway withheld it. Either way the gateway's own words move to the Details.
  const disclosed =
    !isCodeText &&
    !suppressed &&
    (unwrapGatewayFailure(shown).wrapper !== null ||
      (code !== null && DETAIL_IN_DISCLOSURE.has(code)));
  const detail = isCodeText || suppressed || disclosed ? null : shown;
  const rawDetail = disclosed ? shown : null;
  return { headline, detail, rawDetail, code };
}

/** Re-exported from the shared module so existing importers (RunStatus) are
 *  unchanged while the implementation stays single-source. */
export const messageHasText = sharedMessageHasText;

/** What became of an automatic retry whose error card SURVIVED it (turnRetry's
 *  `autoRetryOutcome`). A retry that ran deletes its card, so these are the only
 *  outcomes a reader can see. */
export type AutoRetryOutcome = {
  outcome: "stood_down" | "exhausted";
  reason?: string;
  attempt: number;
  maxAttempts: number;
};

/** turnRetry stand-down reasons that mean the conversation moved on past this turn.
 *  `chat_busy` qualifies because turnRetry emits it only for a row PROVEN not to be
 *  this card's own dispatch; its own still-unsettled dispatch stands down as
 *  `own_dispatch_unsettled`, which takes the neutral line (no newer turn exists). */
const MOVED_ON_REASONS: ReadonlySet<string> = new Set([
  "chat_busy",
  "not_last_message",
  "no_preceding_user_turn",
]);

/**
 * The one line an error card says about its automatic retry, from the stored fact
 * only — never from the class. The class says a retry is ALLOWED; whether one ran is
 * a separate event, and a card that asserted it from the class told a reader "it was
 * retried" about a retry that stood down because another reply was streaming (prod
 * 2026-09-28). Null = no retry fact: the card claims nothing.
 */
export function autoRetryOutcomeLine(
  outcome: AutoRetryOutcome | null | undefined,
): string | null {
  if (outcome === null || outcome === undefined) return null;
  if (outcome.outcome === "exhausted") {
    return m.runstatus_retry_exhausted({
      attempt: String(outcome.attempt),
      max: String(outcome.maxAttempts),
    });
  }
  if (outcome.reason === "another_turn_streaming") {
    return m.runstatus_retry_stood_down_streaming();
  }
  if (outcome.reason === "delegated_work") {
    return m.runstatus_retry_stood_down_delegated();
  }
  if (outcome.reason === "concurrent_writer") {
    return m.runstatus_retry_stood_down_concurrent();
  }
  if (outcome.reason !== undefined && MOVED_ON_REASONS.has(outcome.reason)) {
    return m.runstatus_retry_stood_down_moved_on();
  }
  return m.runstatus_retry_stood_down();
}
