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

/** Union of the four chat event schemas' top-level payload fields. */
export const KNOWN_CHAT_FIELDS: ReadonlySet<string> = new Set([
  // shared event base
  "runId",
  "sessionKey",
  "agentId",
  "spawnedBy",
  "seq",
  "state",
  // delta
  "message",
  "deltaText",
  "replace",
  "usage",
  // final / aborted / error extras
  "stopReason",
  "errorMessage",
  "errorKind",
]);

/** AgentEventSchema's top-level payload fields. */
export const KNOWN_AGENT_FIELDS: ReadonlySet<string> = new Set([
  "runId",
  "seq",
  "stream",
  "ts",
  "spawnedBy",
  "isHeartbeat",
  "data",
  // NOT in AgentEventSchema but present on every observed wire frame (the
  // gateway stamps the routing envelope onto agent events too — live capture
  // 2026-07-03); listed so a baseline install reports zero drift.
  "sessionKey",
  "sessionId",
  "agentId",
  // SESSION/RUN METADATA the gateway flattens onto agent events on live
  // deployments (observed on dev 2026-07-04, x248 per field — names only, per
  // the SOC2 contract). Same family as the envelope above: metadata about the
  // session, not conversation content. The usage members (inputTokens/
  // outputTokens/totalTokens/estimatedCostUsd) are CONSUMED defensively by the
  // normalizer to enrich the per-turn pressure trace with real usage.
  "session",
  "updatedAt",
  "kind",
  "channel",
  "chatType",
  "origin",
  "deliveryContext",
  "verboseLevel",
  "systemSent",
  "lastChannel",
  "totalTokens",
  "totalTokensFresh",
  "goal",
  "estimatedCostUsd",
  "modelProvider",
  "model",
  "status",
  // CONFIG-DEPENDENT session metadata: stamped onto agent events ONLY when the
  // gateway's chat defaults define them (observed on a deployment right after
  // the admin set Réflexion/Vitesse par défaut, 2026-07-06 — names only). A
  // deployment without those defaults never emits them, which is why two
  // same-version gateways can differ here. Benign: consumed nowhere.
  "thinkingLevel",
  "fastMode",
  // Spawn statics on child frames (observed on the 2026.6.11 bench during the
  // sub-agent work): parameters of the spawn itself, not content.
  "spawnedWorkspaceDir",
  "spawnDepth",
  "startedAt",
  "abortedLastRun",
  "inputTokens",
  "outputTokens",
  "contextTokens",
  // SUB-AGENT metadata the 2026.6.11 gateway flattens onto agent events on live
  // prod (Ataraxis 2026-07-10, x43 per field — names only, per the SOC2 contract):
  // the child's role/scope, its parent's session key, its runtime, and the parent's
  // child-session list. Same family as the spawn statics above — session/sub-agent
  // METADATA, not conversation content; consumed nowhere (the sub-agent observer
  // derives the parent↔child link from `spawnedBy`, not from these). Listed so a
  // 2026.6.11 install reports zero drift.
  "subagentRole",
  "subagentControlScope",
  "parentSessionKey",
  "runtimeMs",
  "childSessions",
  // 2026.7.1 session-config metadata (bench capture 2026-07-11, beta.2): the
  // gateway's per-response usage accounting MODE ("off"/…), flattened onto
  // agent events like thinkingLevel/fastMode. Config vocabulary, not content;
  // consumed nowhere. The ONLY new protocol field 2026.6.11 → 2026.7.1.
  "effectiveResponseUsage",
  // Spawn/agent-identity statics flattened onto agent events (live ataraxis
  // 2026-07-19 — the prod "3 unknown field(s)" badge: spawnedCwd ×617,
  // label/displayName ×270). Same family as spawnedWorkspaceDir/goal: config
  // vocabulary, not content; consumed nowhere.
  "spawnedCwd",
  "label",
  "displayName",
  // Run-registry terminal timestamp flattened onto agent events (live
  // ataraxis 2026-07-22 — the prod "1 unknown field(s)" badge, ×5). Upstream
  // stamps it at run close (run.endedAt, Date.now()) and derives durationMs
  // from it (acp-spawn). Same session/run-metadata family as updatedAt:
  // an epoch number, not content; consumed nowhere (our per-turn timing
  // comes from the pressure trace + finalizedAt).
  "endedAt",
]);

/**
 * Coverage summary of the vendored protocol surface — the operator-facing
 * matrix ("what does this bridge support against its validated gateway
 * version"). Like the known-field sets above, these numbers are NOT
 * hand-trusted: the drift test asserts they equal a recount of
 * `protocol/openclaw/coverage/<newest version>.json`, which the coverage ratchet
 * pins against the vendored TypeBox schemas.
 *
 * Vendoring `sessions.ts` + `plugins.ts`, then `cron.ts` + `tasks.ts` (2026-07-27),
 * took the examined surface from 94 entries to 363: the `sessions.*` lane — 6 of the bridge's 26 RPC calls, the
 * busiest family after chat — is now under contract, and nine more gaps became
 * VISIBLE rather than merely absent.
 *
 * Vendoring 2026.7.1 added three DECLARED gaps (W10): two outbound fields the bridge
 * does not send (`ChatSendParams`/`ChatAbortParams` are `additionalProperties:false`,
 * so the floor gateway would reject them), and `ChatAbortedEvent.errorMessage`, which
 * a first pass wrongly classified as handled — the aborted branch returns before the
 * read that serves `state === "error"`. All three are now visible in the operator
 * matrix instead of being invisible omissions.
 */
export const COVERAGE_SUMMARY = {
  handled: 107,
  ignored: 241,
  gaps: 15,
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
  ] as string[],
} as const;

export interface DriftEntry {
  /** `chat.<field>` or `agent.<field>` — schema vocabulary only. */
  shape: string;
  count: number;
}

// Bounds: a pathological gateway must not grow memory or spam logs.
const MAX_TRACKED_SHAPES = 100;

class ProtocolDriftRegistry {
  private counters = new Map<string, number>();
  private overflowed = false;

  /** Observe one raw inbound frame (chat/agent events only; anything else is
   *  outside the vendored surface and deliberately not judged). Never throws. */
  observe(frame: unknown): void {
    try {
      if (typeof frame !== "object" || frame === null) return;
      const f = frame as Record<string, unknown>;
      if (f.type !== "event") return;
      const known =
        f.event === "chat"
          ? KNOWN_CHAT_FIELDS
          : f.event === "agent"
            ? KNOWN_AGENT_FIELDS
            : null;
      if (known === null) return;
      const payload = f.payload;
      if (typeof payload !== "object" || payload === null) return;
      for (const key of Object.keys(payload as Record<string, unknown>)) {
        if (known.has(key)) continue;
        const shape = `${String(f.event)}.${key}`;
        const current = this.counters.get(shape);
        if (current === undefined) {
          if (this.counters.size >= MAX_TRACKED_SHAPES) {
            if (!this.overflowed) {
              this.overflowed = true;
              console.error(
                "[protocol-drift] tracked-shape cap reached — further NEW shapes uncounted (bound, not silence: this line is the signal)",
              );
            }
            continue;
          }
          // One log per NEW shape (field name only — never a value).
          console.log(
            `[protocol-drift] unknown protocol field: ${shape} (gateway newer than vendored ${DRIFT_VENDORED_VERSION}?)`,
          );
          this.counters.set(shape, 1);
        } else {
          this.counters.set(shape, current + 1);
        }
      }
    } catch {
      // Observe-only: a malformed frame must never break the feed path.
    }
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
  }
}

/** Process-wide singleton: drift is a per-build observation, not per-session. */
export const protocolDrift = new ProtocolDriftRegistry();
