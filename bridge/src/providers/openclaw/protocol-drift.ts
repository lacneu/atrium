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
// per-field entries of protocol/openclaw/coverage.json — which is itself
// ratcheted against the vendored TypeBox schemas. One chain, no drift:
//   vendored schema <-> coverage.json <-> these runtime sets.

// Stays 2026.6.11: that is the schema set actually vendored under
// protocol/openclaw/ (and what coverage.json ratchets against). The 2026.7.1
// bench observed EXACTLY ONE addition over it (`agent.effectiveResponseUsage`,
// listed below), so 6.11 + that field IS the 7.1 surface; bump this only when
// the published 2026.7.1 schemas are vendored and re-audited.
export const DRIFT_VENDORED_VERSION = "2026.6.11";

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
 * protocol/openclaw/coverage.json, which the coverage ratchet pins against
 * the vendored TypeBox schemas.
 */
export const COVERAGE_SUMMARY = {
  handled: 41,
  ignored: 50,
  gaps: 0,
  /** The declared gaps, by schema path — the actionable part of the matrix. */
  gapList: [] as string[],
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
