import { randomBytes } from "node:crypto";

// Protocol DRIFT detector (Inc 2 of docs/design/protocol-contract.md).
//
// Observe-only: classifies inbound chat/agent event frames against the KNOWN
// per-version protocol surface and counts unknown payload fields — the
// early-warning for "the gateway was updated past what this bridge build
// understands" (the NAS updates OpenClaw before the bridge image). NEVER
// rejects or mutates a frame; unknown fields keep flowing exactly as before.
//
// SOC2: only protocol FIELD NAMES are counted/logged (schema vocabulary),
// never values, never conversation content.
//
// The known-field sets below are the vendored schema surface of the bridge's
// maxValidated gateway version. They are NOT hand-trusted: the protocol
// coverage ratchet test asserts a BIJECTION between these sets and the
// per-field entries of protocol/openclaw/coverage/<version>.json — which is itself
// ratcheted against the vendored TypeBox schemas. One chain, no drift:
//   vendored schema <-> coverage/<version>.json <-> these runtime sets.

// 2026.7.1 — the schema set now vendored under protocol/openclaw/ and ratcheted by
// coverage/2026.7.1.json.
//
// CORRECTED 2026-07-26 (W10/G-74): this said the 7.1 bench had observed "EXACTLY ONE
// addition" over 6.11, and therefore that 6.11 plus that field WAS the 7.1 surface.
// Vendoring the published 2026.7.1 schemas falsified it — the diff carries at least
// `ChatAbortedEvent.errorMessage`, `ChatSendParams.expectedSessionRoutingContract` and
// `ChatAbortParams.preserveSideRuns`. A BENCH observes the fields a scenario happens
// to exercise; it cannot enumerate a contract. That is what the vendored schema is
// for, and inferring "the surface" from a bench run is the exact mistake the ratchet
// exists to make impossible.
export const DRIFT_VENDORED_VERSION = "2026.7.1";

/** Chat payload fields PER STATE, not their union.
 *
 *  The union was the whole weakness: `ChatEventSchema` is a DISCRIMINATED union of four
 *  state shapes, and checking a frame against the union means a field that belongs to
 *  another state passes unnoticed. An `aborted` frame carrying `deltaText`, or a `final`
 *  carrying `errorKind`, is a contract deviation the detector reported as zero — and those
 *  are exactly the shapes that break a turn, because the reader branches on `state`.
 *
 *  Asserted against the vendored per-state schemas by `protocol-drift.test.ts`, so this
 *  cannot drift from the contract the way the hand-kept agent list did.
 */
export const KNOWN_CHAT_FIELDS_BY_STATE: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  delta: new Set([
    "agentId",
    "deltaText",
    "message",
    "replace",
    "runId",
    "seq",
    "sessionKey",
    "spawnedBy",
    "state",
    "usage",
  ]),
  final: new Set([
    "agentId",
    "message",
    "runId",
    "seq",
    "sessionKey",
    "spawnedBy",
    "state",
    "stopReason",
    "usage",
  ]),
  aborted: new Set([
    "agentId",
    "errorMessage",
    "message",
    "runId",
    "seq",
    "sessionKey",
    "spawnedBy",
    "state",
    "stopReason",
  ]),
  error: new Set([
    "agentId",
    "errorKind",
    "errorMessage",
    "message",
    "runId",
    "seq",
    "sessionKey",
    "spawnedBy",
    "state",
    "stopReason",
    "usage",
  ]),
};

/** The UNION, kept for one purpose: a frame whose `state` is not one of the four cannot be
 *  judged per state, and counting all its fields as unknown would be noise, not signal.
 *  Such a frame is reported once under `chat.«unknown-state».<digest>` instead — the
 *  digest distinguishes one new state from another without disclosing the wire value. */
export const KNOWN_CHAT_FIELDS: ReadonlySet<string> = new Set(
  Object.values(KNOWN_CHAT_FIELDS_BY_STATE).flatMap((s) => [...s]),
);

/** Every field name an `agent` event can carry, DERIVED from three enumerable sources.
 *
 *  This used to be a list of PRODUCTION OBSERVATIONS, and the comments said so: "prod
 *  badge 3 unknown fields, 2026-07-19", "2026-07-22 endedAt". The loop was: a field
 *  appears in the operator's unknown-field badge, someone reads the badge, someone patches
 *  this list. Fourteen fields upstream demonstrably emits were still missing when the
 *  derivation was written — including `lastTo`, which prod reported TWENTY-FOUR times on
 *  2026-07-19 and which nobody added. A known-set maintained by incident is a known-set
 *  that is always one incident behind.
 *
 *  The three sources, and why each is needed:
 *   1. `session-event-snapshot.json` — the return shape of the gateway's
 *      `buildSessionEventSnapshot`, derived at vendoring time from upstream source. The
 *      gateway FLATTENS this onto agent events, which is why so many session fields turn
 *      up on a frame that declares none of them.
 *   2. `AgentEventSchema`'s own top-level fields — the published contract.
 *   3. The ROUTING ENVELOPE the gateway stamps on every broadcast (`sessionKey`,
 *      `agentId`). Declared here because it is in neither of the above: the schema does
 *      not mention it and it is not part of the session row.
 *
 *  `protocol-drift.test.ts` asserts this set EQUALS that union, so the next field upstream
 *  adds turns the ratchet red at vendoring time instead of appearing in a customer's
 *  badge. The literal stays because this runs on the turn path and must not read a file.
 */
export const AGENT_ROUTING_ENVELOPE_FIELDS: readonly string[] = [
  // Stamped on every broadcast, in no schema and in no session row.
  "sessionKey",
  "agentId",
];

export const KNOWN_AGENT_FIELDS: ReadonlySet<string> = new Set([
  "abortedLastRun",
  "activeRunIds",
  "agentId",
  "channel",
  "chatType",
  "childSessions",
  "contextTokens",
  "data",
  "deliveryContext",
  "displayName",
  "effectiveResponseUsage",
  "elevatedLevel",
  "endedAt",
  "estimatedCostUsd",
  "fastMode",
  "forkedFromParent",
  "goal",
  "groupChannel",
  "hasActiveRun",
  "inputTokens",
  "isHeartbeat",
  "kind",
  "label",
  "lastAccountId",
  "lastChannel",
  "lastThreadId",
  "lastTo",
  "model",
  "modelProvider",
  "origin",
  "outputTokens",
  "parentSessionKey",
  "reasoningLevel",
  "responseUsage",
  "runId",
  "runtimeMs",
  "sendPolicy",
  "seq",
  "session",
  "sessionId",
  "sessionKey",
  "space",
  "spawnDepth",
  "spawnedBy",
  "spawnedCwd",
  "spawnedWorkspaceDir",
  "startedAt",
  "status",
  "stream",
  "subagentControlScope",
  "subagentRole",
  "subject",
  "systemSent",
  "thinkingLevel",
  "totalTokens",
  "totalTokensFresh",
  "traceLevel",
  "ts",
  "updatedAt",
  "verboseLevel",
]);

/**
 * Coverage summary of the vendored protocol surface — the operator-facing
 * matrix ("what does this bridge support against its validated gateway
 * version"). Like the known-field sets above, these numbers are NOT
 * hand-trusted: the drift test asserts they equal a recount of
 * `protocol/openclaw/coverage/<newest version>.json`, which the coverage ratchet
 * pins against the vendored TypeBox schemas.
 *
 * Vendoring `sessions.ts` + `plugins.ts`, then `cron.ts` + `tasks.ts`, then
 * `config.ts` + `agents-models-skills.ts`, then `channels.ts` (all 2026-07-27) took the
 * examined surface from 94 entries to 596. EVERY RPC family the bridge calls is now
 * under contract; what remains uncovered is uncovered BY CONSTRUCTION, because upstream
 * publishes no params schema for it (`sessions.get`, `usage.status`, three `tts.*`).
 * Each round of classification made gaps VISIBLE rather than merely absent — and each
 * one found a real defect, which is the whole argument for reading a schema field by
 * field instead of trusting a bench.
 *
 * Vendoring 2026.7.1 added three DECLARED gaps (W10): two outbound fields the bridge
 * does not send (`ChatSendParams`/`ChatAbortParams` are `additionalProperties:false`,
 * so the floor gateway would reject them), and `ChatAbortedEvent.errorMessage`, which
 * a first pass wrongly classified as handled — the aborted branch returns before the
 * read that serves `state === "error"`. All three are now visible in the operator
 * matrix instead of being invisible omissions.
 */
export const COVERAGE_SUMMARY = {
  handled: 158,
  ignored: 420,
  gaps: 18,
  /** The declared gaps, by schema path — the actionable part of the matrix. */
  gapList: [
    "ChatAbortedEvent.errorMessage",
    "ChatSendParams.expectedSessionRoutingContract",
    "ChatAbortParams.preserveSideRuns",
    // The whole `session.operation` event: the gateway's own account of a compaction,
    // unreachable from the turn socket by decision (subscribing there cost announce
    // frames — measured 2026-07-26). Its cause IS retrievable on demand through
    // `sessions.compaction.list`; what the event alone gives is the cause AT THE
    // MOMENT it happens, attachable to the turn. `handleSessionOperation` is the
    // ready, unfed reader.
    "SessionOperationEvent.operationId",
    "SessionOperationEvent.operation",
    "SessionOperationEvent.phase",
    "SessionOperationEvent.sessionKey",
    "SessionOperationEvent.agentId",
    "SessionOperationEvent.ts",
    "SessionOperationEvent.completed",
    "SessionOperationEvent.reason",
    // We reset sessions without telling the gateway why. Corrected after review: the
    // field admits only "new" | "reset", so it never identifies the CLIENT — it only
    // separates a reset from a fresh session in the gateway's own accounting.
    "SessionsResetParams.reason",
    // Three the cron/tasks classification surfaced (2026-07-27), all user-facing:
    // a recurring job's COST is on every run entry and the Scheduled tab shows
    // duration and status only; a job that has failed twenty times in a row looks
    // exactly like one that failed once; and a running task publishes a progress line
    // while the activity indicator shows a bare spinner.
    "CronJobState.consecutiveErrors",
    "CronRunLogEntry.usage",
    "TaskSummary.progressSummary",
    // The voice lane (2026-07-27): the result carries an identifier for the consult and
    // the bridge keeps only `runId`. Stated as the verifiable fact after two corrections —
    // there is no param to quote the key back on, and what it identifies inside the
    // gateway is not something this repo establishes.
    "TalkClientToolCallResult.idempotencyKey",
    // The voice credential states when it dies and nothing reads it: the UI discovers
    // expiry from an HTTP 401 on the SDP offer instead of declining to open a session
    // whose secret has already lapsed.
    "TalkClientCreateResult.expiresAt",
    // The session may require extra headers on the SDP offer; the projection drops them
    // and the browser sends Authorization + Content-Type only. A gateway that starts
    // requiring one fails voice at the handshake with a bare sdp_<status>.
    "TalkClientCreateResult.offerHeaders",
    // NOT listed here, deliberately: "no hole detection on the PAYLOAD seq". It is a real
    // shortcoming (the envelope `frame.seq` is checked by frame-seq.ts, the payload one is
    // not, and a payload hole means an agent event lost INSIDE a run) — but this list is a
    // mechanical recount of the manifest's `gap` fields, and `AgentEvent.seq` is `handled`:
    // it IS read, and it decides which dedup rule applies. Inventing a path to make the
    // list look complete would break the one chain this file rests on. The shortcoming is
    // stated in that field's own note, which is where the manifest puts nuance.
  ] as string[],
} as const;

export interface DriftEntry {
  /** `chat.<field>` or `agent.<field>` — schema vocabulary only. */
  shape: string;
  count: number;
}

// Bounds: a pathological gateway must not grow memory or spam logs.
const MAX_TRACKED_SHAPES = 100;

/** Namespace for the detector's OWN failures. Not protocol vocabulary: the guillemets
 *  cannot appear in a field name (they fail the discriminant charset), so a gateway can
 *  never forge a shape that impersonates one. */
const DETECTOR_FAILURE_PREFIX = "«detector-failure».";

/** Per-PROCESS random salt for the unknown-state id.
 *
 *  Without it the id was a plain 32-bit FNV-1a of the value: one-way in form only, since
 *  anyone holding the reported shape could confirm a guess by hashing it — `AliceMartin`,
 *  an e-mail address, any candidate from a dictionary (raised in review). A salt nobody
 *  outside this process holds makes the id underivable, at the cost of one property that
 *  was not worth much: the same unknown state on two bridges now reads as two findings
 *  rather than one. Over-reporting a new state is the safe direction.
 *
 *  NEVER logged, never reported, never persisted. */
const UNKNOWN_STATE_SALT = randomBytes(16).toString("hex");

/** FNV-1a, 32 bits, hex, over the SALTED value — for wire values that must be
 *  DISTINGUISHED without being disclosed or guessed. */
function shortDigest(s: string): string {
  let h = 0x811c9dc5;
  const salted = `${UNKNOWN_STATE_SALT}\u0000${s}`;
  for (let i = 0; i < salted.length; i++) {
    h ^= salted.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

class ProtocolDriftRegistry {
  private counters = new Map<string, number>();
  private overflowed = false;
  private overflowCounter = 0;

  /** Observe one raw inbound frame (chat/agent events only; anything else is
   *  outside the vendored surface and deliberately not judged). Never throws. */
  observe(frame: unknown): void {
    try {
      if (typeof frame !== "object" || frame === null) return;
      const f = frame as Record<string, unknown>;
      if (f.type !== "event") return;
      if (f.event !== "chat" && f.event !== "agent") return;
      const payload = f.payload;
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Record<string, unknown>;
      // PER STATE for chat (the union hid cross-state fields, see above). An
      // unrecognised state cannot be judged field by field, so it is reported ONCE as
      // itself rather than as a wall of unknown fields.
      let known: ReadonlySet<string>;
      let prefix: string;
      if (f.event === "chat") {
        const state = typeof p.state === "string" ? p.state : "";
        // `Object.hasOwn`, not a bare index: `state: "toString"` returned a FUNCTION from
        // the prototype, `known.has` threw, and the observe-only catch swallowed it — so a
        // frame with a prototype-named state produced no drift at all. A detector that can
        // be silenced by the value it is inspecting is worse than none.
        const perState = Object.hasOwn(KNOWN_CHAT_FIELDS_BY_STATE, state)
          ? KNOWN_CHAT_FIELDS_BY_STATE[state]
          : undefined;
        if (perState === undefined) {
          // DISTINGUISHED, not named. An unrecognised state has to be distinguishable — a
          // single bucket hides whether one new state appeared or five — but it is an
          // UNVALIDATED wire value, and this shape is stored and displayed. A charset
          // filter was the first attempt and it proves nothing: `AliceMartin` passes it.
          // A one-way digest keeps every property an operator needs (stable across frames,
          // comparable across bridges, one id per distinct state) and carries no value, so
          // the non-leak is structural rather than a promise about what a gateway sends.
          // The name itself is recoverable where it belongs — the vendored schema diff of
          // the version that introduced it.
          this.bump(`chat.«unknown-state».${shortDigest(state)}`);
          return;
        }
        known = perState;
        prefix = `chat.${state}`;
      } else {
        known = KNOWN_AGENT_FIELDS;
        prefix = "agent";
      }
      for (const key of Object.keys(p)) {
        if (known.has(key)) continue;
        this.bump(`${prefix}.${key}`);
      }
    } catch (err) {
      // Observe-only: a malformed frame must never break the feed path — but a detector
      // that fails SILENTLY is the blindness it exists to remove, exactly like the
      // prototype-named state above. The failure is counted as a shape of its own, so it
      // travels the pipeline that is already bounded, reported and rendered; nothing new
      // has to be plumbed for an operator to see that the detector itself gave up.
      // The error CLASS only — never `err.message`, which can quote frame content (SOC2).
      try {
        const cls = err instanceof Error ? err.constructor.name : typeof err;
        const safe = /^[a-zA-Z][a-zA-Z0-9._-]{0,47}$/.test(cls) ? cls : "«unprintable»";
        this.bump(`${DETECTOR_FAILURE_PREFIX}${safe}`);
      } catch {
        // Truly nothing left to do: the detector must not be able to break the feed.
      }
    }
  }

  /** Count one shape, or count the OVERFLOW when the cap is reached.
   *
   *  `overflowCount` exists because the cap used to be a `console.error` in the container's
   *  stdout and nothing else: the report said "here is the drift" while silently omitting
   *  everything past 512 shapes. A bound is legitimate; a bound nobody downstream can see
   *  is the same silence the bound was supposed to replace. */
  private bump(shape: string): void {
    const current = this.counters.get(shape);
    if (current !== undefined) {
      this.counters.set(shape, current + 1);
      return;
    }
    if (this.counters.size >= MAX_TRACKED_SHAPES) {
      this.overflowCounter += 1;
      if (!this.overflowed) {
        this.overflowed = true;
        console.error(
          "[protocol-drift] tracked-shape cap reached — further NEW shapes counted in overflowCount, not named",
        );
      }
      return;
    }
    // One log per NEW shape (field name only — never a value). A detector failure rides
    // the same counters but is NOT an unknown field: logging it under the drift wording
    // would send an operator looking for a gateway change that never happened.
    console.log(
      shape.startsWith(DETECTOR_FAILURE_PREFIX)
        ? `[protocol-drift] detector failed on a frame: ${shape} (error class only — the frame is unreadable to this build)`
        : `[protocol-drift] unknown protocol field: ${shape} (gateway newer than vendored ${DRIFT_VENDORED_VERSION}?)`,
    );
    this.counters.set(shape, 1);
  }

  /** How many observations fell past the tracked-shape cap. Reported, not just logged. */
  overflowCount(): number {
    return this.overflowCounter;
  }

  /** Current drift, largest counts first (bounded by MAX_TRACKED_SHAPES). */
  report(): DriftEntry[] {
    return [...this.counters.entries()]
      .map(([shape, count]) => ({ shape, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Test seam. */
  resetForTests(): void {
    this.counters.clear();
    this.overflowed = false;
    this.overflowCounter = 0;
  }
}

/** Process-wide singleton: drift is a per-build observation, not per-session. */
export const protocolDrift = new ProtocolDriftRegistry();
