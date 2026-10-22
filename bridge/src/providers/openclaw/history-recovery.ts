// Positional readers of a `sessions.get` transcript payload, for the `/lossless`
// maintenance route only (server.ts): it sends one command into a fresh, single-use
// session and reads the reply back. No conversation turn reads the transcript this way —
// a conversation's rows are read by identity (`chat.history`, transcript-shadow.ts).

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: Json): v is string {
  return typeof v === "string";
}

/** Every string carried by a transcript entry's `content` (string or parts). */
function contentStrings(content: Json): string[] {
  if (isString(content)) return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (isString(part)) {
      out.push(part);
    } else if (isObject(part)) {
      if (isString(part.text)) out.push(part.text);
      else if (isString(part.content)) out.push(part.content);
    }
  }
  return out;
}

/**
 * The assistant reply of the CURRENT turn of a `sessions.get` payload: scans backwards
 * to the latest `user` entry (the turn boundary) collecting `assistant` texts; empty
 * string while the run hasn't answered yet (the caller keeps polling).
 */
export function extractLatestAssistantReply(payload: Json): string {
  const messages = isObject(payload) && Array.isArray(payload.messages)
    ? payload.messages
    : [];
  const collected: string[] = [];
  // Has an assistant entry ANSWERED since the newest restart-recovery resume prompt? Scanning
  // backwards, everything seen before that prompt came after it. Only an explicit terminal
  // stopReason counts (see below): a `toolUse` fragment means the run is still working, and a
  // shape with no stopReason proves nothing.
  let answered = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (!isObject(entry)) continue;
    const role = entry.role;
    // Current-turn boundary — except the gateway's restart-recovery resume prompt, which
    // continues THIS turn: the resumed reply follows it, and whatever the interrupted run
    // had already committed precedes it (isRestartRecoveryResumeEntry).
    if (role === "user") {
      // The resume prompt continues THIS turn — but only once the resumed run has ANSWERED.
      // Crossed earlier, a text committed before the restart (a `toolUse` fragment; upstream
      // keeps such a visible assistant message in front of the resume,
      // main-session-restart-recovery.test.ts:5995) — or the resumed run's own mid-run
      // fragment — would be taken as the answer and finalize the turn, and the real reply
      // landing seconds later would be dropped (codex, twice). Until that proof exists the
      // turn has NO recoverable text at all: returning the fragment would finalize it just
      // the same, since a socket_drop recovery accepts the first non-empty text it reads.
      if (isRestartRecoveryResumeEntry(entry)) {
        if (!answered) return "";
        continue;
      }
      // An INTER-SESSION entry ends the turn — a subagent announce or settle, a media or
      // harness completion. Whatever was collected above it came AFTER it, so it belongs to
      // whatever that entry started, and this reader cannot tell which: the completion the
      // gateway steers INTO a live run and the delivery that is a turn of its own carry the
      // same provenance, and the key that separates them is built by prefixing a
      // CALLER-SUPPLIED announce id ($UP/src/agents/announce-idempotency.ts:19; the harness
      // takes that id as a free string, $UP/src/plugin-sdk/agent-harness-task-runtime.ts:184),
      // so a suffix proves the STRING, never its producer (codex pass 9, reproduced with
      // `announce:harness:job:active-wake`). Fail-closed, the turn has no recoverable text:
      // the recovery spends its deadline instead of delivering another turn's words.
      if (isInterSessionEntry(entry)) return "";
      break;
    }
    if (role !== "assistant") continue;
    // A FAILED attempt, never a reply. Since 2026.9.3 (read at v2026.9.4; absent from the
    // v2026.9.1 and v2026.9.2 sources), when a run fails the gateway appends that attempt's
    // partial text to the transcript as an assistant entry with `stopReason: "error"`
    // (upstream src/agents/assistant-error-transcript.ts:26-72 records it, :105-113
    // persists it under `<runId>:terminal-error`), and sessions.get returns the stored
    // message with its `content` and `stopReason` intact (session-transcript-readers.ts:158,167
    // → projectTranscriptEntryMessage, which only attaches `__openclaw` metadata). Read as a
    // reply, a resumed run that failed would be delivered as a COMPLETE answer made of its
    // truncated attempt. Skipped, that entry is never taken as the reply: another valid
    // reply or message-tool delivery of the turn still comes back, and with none the
    // recovery keeps polling and settles with its honest cause.
    if (entry.stopReason === "error") continue;
    const text = contentStrings(entry.content).join("").trim();
    if (text) collected.push(text);
    // ANSWERED only on an EXPLICIT terminal stopReason. Absent, null or unknown is not proof
    // (fail-closed, codex): the runtime enum is "stop"|"length"|"toolUse"|"error"|"aborted"
    // ($UP/packages/llm-core/src/types.ts:354) and raw provider values such as `end_turn` pass
    // through; `error` never reaches here (skipped above) and `aborted` is an interruption, not
    // an answer. A shape carrying no stopReason is one we cannot read as finished, and reading
    // it as the answer would finalize the turn on a fragment.
    if (
      entry.stopReason === "stop" ||
      entry.stopReason === "length" ||
      entry.stopReason === "end_turn"
    ) {
      answered = true;
    }
  }
  collected.reverse();
  return collected.join("\n\n");
}

/**
 * The gateway's own RESUME prompt of a main-session restart recovery — not a turn of the
 * conversation. After a gateway restart interrupts a running turn, 2026.9.4 relaunches it by
 * appending a `user` entry "[System] Your previous turn was interrupted by a gateway restart…"
 * with `provenance {kind: "internal_system", sourceTool: "main_session_restart_recovery"}`
 * (upstream main-session-restart-dispatch.ts:50,521-548; recognized by
 * sessions/input-provenance.ts:90-97, whose normalization this mirrors), and the resumed reply
 * follows it. Measured on the bench after a forced restart mid-reply: user, resume entry, then
 * the complete reply. The resume entry does not carry the user's text, so reading it as the
 * turn boundary made every anchored recovery wait out its deadline while the answer sat in the
 * transcript.
 */
export function isRestartRecoveryResumeEntry(entry: unknown): boolean {
  if (!isObject(entry) || entry.role !== "user") return false;
  const provenance = entry.provenance;
  if (!isObject(provenance) || provenance.kind !== "internal_system") return false;
  return (
    typeof provenance.sourceTool === "string" &&
    provenance.sourceTool.trim().toLowerCase() === "main_session_restart_recovery"
  );
}

/**
 * An entry the gateway handed to this session from ANOTHER one — a subagent announce or
 * settle, a media generation or harness completion, an inter-session send. Upstream marks them
 * all with `{kind:"inter_session"}` ($UP/src/sessions/input-provenance.ts, enum
 * $UP/packages/gateway-protocol/src/schema/primitives.ts:20), and they are user-role entries in
 * the transcript, so they end a turn just as the user's own message does.
 *
 * WHY THIS IS NOT SPLIT FINER (codex passes 5 to 9, each reproduced). Some of these entries are
 * steered INTO the running turn and would be safe to cross; others START a delivery turn of
 * their own, whose reply must never be read as this turn's answer. The transcript does not
 * separate them: the provenance is identical, and the idempotency key that differs is composed
 * by prefixing a CALLER-SUPPLIED announce id ($UP/src/agents/announce-idempotency.ts:19 — the
 * harness takes that id as a plain string, $UP/src/plugin-sdk/agent-harness-task-runtime.ts:184),
 * so `…:active-wake` is a shape anyone can produce, not a producer's signature. Telling them
 * apart needs a marker upstream would have to add; until then this reader crosses none of them.
 */
function isInterSessionEntry(entry: Json): boolean {
  if (!isObject(entry) || entry.role !== "user") return false;
  const provenance = entry.provenance;
  return isObject(provenance) && provenance.kind === "inter_session";
}

/** Number of transcript entries in a `sessions.get` payload (0 when malformed): the
 *  baseline `/lossless` compares against to see its reply land. */
export function transcriptEntryCount(payload: Json): number {
  return isObject(payload) && Array.isArray(payload.messages)
    ? payload.messages.length
    : 0;
}
