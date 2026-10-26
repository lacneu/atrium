// HOW A SEND LANDS WHILE THE AGENT WORKS — the Control UI's own resolution, ported
// (transcript redesign phase 3, design §3.1).
//
// Upstream (v2026.9.8):
//   - `normalizeQueueMode` — src/auto-reply/reply/queue/normalize.ts:7-25 (identical at
//     v2026.8.2 and v2026.9.6): aliases `interrupts`/`abort` → `interrupt`, `steering` →
//     `steer`, `follow-ups`/`followups` → `followup`, `coalesce` → `collect`.
//   - `resolveControlUiServerQueueMode` — ui/src/lib/chat/follow-up-mode.ts:21-48: the
//     session's own mode first, then (config) → `effectiveMode` → `"steer"`.
//   - `resolveControlUiFollowUpMode` — follow-up-mode.ts:51-56: the user's explicit choice
//     (`queue` | `steer`, ui/src/app/settings.ts:123-130) wins over the server's mode.
//   - the run policy — ui/src/pages/chat/chat-send-submit.ts:548-562: `queueMode` is sent
//     only while a run is active on the session (or history could not be read), and never
//     for the client-side `queue` choice.
//
// ONE DEVIATION, stated: the Control UI also reads the gateway's runtime config snapshot
// (`messages.queue.byChannel.webchat ?? messages.queue.mode`). The bridge does not hold
// that snapshot; it reads the session row the gateway projects into `chat.history`
// `sessionInfo`, whose `effectiveQueueMode` is the gateway's OWN resolution of the same
// config for the same channel (src/gateway/session-utils-row.ts:553-557 at v2026.9.8,
// `resolveQueueSettingsCore({cfg, channel: INTERNAL_MESSAGE_CHANNEL, sessionEntry})`;
// :537-541 at v2026.8.2, :566-570 at v2026.9.6). Upstream's own branch for "no config,
// effective mode known" returns exactly `effectiveMode` (follow-up-mode.ts:44-47), and
// with neither known the field is omitted so `chat.send` resolves it — the same answer.

/** The gateway's queue modes (packages/gateway-protocol/src/schema/logs-chat.ts
 *  `QUEUE_MODES`: :207 at v2026.8.2, :271 at v2026.9.6, :277 at v2026.9.8). */
export const GATEWAY_QUEUE_MODES = ["steer", "followup", "collect", "interrupt"] as const;
export type GatewayQueueMode = (typeof GATEWAY_QUEUE_MODES)[number];

/** What the PERSON chose for a send made while the agent works. `queue` is a CLIENT mode
 *  (Atrium keeps the message until the conversation is idle, like the Control UI's
 *  durable outbox); `steer` and `interrupt` go to the gateway at once. Absent = the
 *  gateway's own mode ("server"). */
export type FollowUpChoice = "queue" | "steer" | "interrupt";

export function isFollowUpChoice(v: unknown): v is FollowUpChoice {
  return v === "queue" || v === "steer" || v === "interrupt";
}

/** Upstream `normalizeQueueMode`, verbatim in behaviour. */
export function normalizeQueueMode(raw: unknown): GatewayQueueMode | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === "") return undefined;
  if (cleaned === "interrupt" || cleaned === "interrupts" || cleaned === "abort") return "interrupt";
  if (cleaned === "steer" || cleaned === "steering") return "steer";
  if (cleaned === "followup" || cleaned === "follow-ups" || cleaned === "followups") {
    return "followup";
  }
  if (cleaned === "collect" || cleaned === "coalesce") return "collect";
  return undefined;
}

/** The session facts `chat.history` projects (`sessionInfo`), as far as the send reads
 *  them. Every field optional: an absent field is "not known", never a default. */
export interface SessionRunFacts {
  /** The session's own override (`sessionInfo.queueMode`). */
  queueMode?: unknown;
  /** The gateway's resolution for this session (`sessionInfo.effectiveQueueMode`). */
  effectiveQueueMode?: unknown;
  /** `sessionInfo.hasActiveRun` (chat-history-handler.ts:374-381 at v2026.9.8). */
  hasActiveRun?: boolean;
  /** `sessionInfo.activeRunIds`. */
  activeRunIds?: string[];
  /** `inFlightRun.runId` of the reply. */
  inFlightRunId?: string | null;
}

/** `resolveControlUiServerQueueMode` without a runtime-config snapshot (see the header):
 *  the session's mode, else the gateway's effective mode, else unknown. `null` facts =
 *  the session metadata could not be loaded (upstream `sessionMetadataLoaded === false`). */
export function resolveServerQueueMode(
  facts: Pick<SessionRunFacts, "queueMode" | "effectiveQueueMode"> | null,
): GatewayQueueMode | undefined {
  if (facts === null) return undefined;
  const sessionMode = normalizeQueueMode(facts.queueMode);
  if (sessionMode !== undefined) return sessionMode;
  return normalizeQueueMode(facts.effectiveQueueMode);
}

/** `resolveControlUiFollowUpMode`: an explicit choice wins, else the server's mode. */
export function resolveFollowUpMode(
  choice: FollowUpChoice | undefined,
  serverMode: GatewayQueueMode | undefined,
): FollowUpChoice | GatewayQueueMode | undefined {
  return choice ?? serverMode;
}

/** The `queueMode` a `chat.send` carries (chat-send-submit.ts:548-562): only when the run
 *  policy applies, and never the client-side `queue`. */
export function explicitQueueMode(args: {
  followUpMode: FollowUpChoice | GatewayQueueMode | undefined;
  applyRunPolicy: boolean;
}): GatewayQueueMode | undefined {
  const m = args.followUpMode;
  if (!args.applyRunPolicy || m === undefined || m === "queue") return undefined;
  return m;
}

/** Bound on the `activeRunIds` read off a reply: a list at the bound may have been cut. */
export const MAX_FACT_RUN_IDS = 50;

/** Read `sessionInfo` + `inFlightRun` off a `chat.history` reply (any shape; never throws). */
export function readSessionRunFacts(payload: unknown): SessionRunFacts | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { sessionInfo?: unknown; inFlightRun?: unknown };
  const info =
    typeof p.sessionInfo === "object" && p.sessionInfo !== null
      ? (p.sessionInfo as Record<string, unknown>)
      : null;
  const inFlight =
    typeof p.inFlightRun === "object" && p.inFlightRun !== null
      ? (p.inFlightRun as { runId?: unknown })
      : null;
  if (info === null && inFlight === null) return null;
  const ids = Array.isArray(info?.activeRunIds)
    ? (info!.activeRunIds as unknown[]).filter(
        (x): x is string => typeof x === "string" && x.length > 0 && x.length <= 256,
      ).slice(0, MAX_FACT_RUN_IDS)
    : undefined;
  return {
    ...(info?.queueMode !== undefined ? { queueMode: info.queueMode } : {}),
    ...(info?.effectiveQueueMode !== undefined
      ? { effectiveQueueMode: info.effectiveQueueMode }
      : {}),
    ...(typeof info?.hasActiveRun === "boolean" ? { hasActiveRun: info.hasActiveRun } : {}),
    ...(ids !== undefined ? { activeRunIds: ids } : {}),
    inFlightRunId:
      typeof inFlight?.runId === "string" && inFlight.runId !== "" ? inFlight.runId : null,
  };
}

/**
 * Do the gateway's session facts PROVE this run over (0.102.1, Codex pass 1)? Only two
 * facts do, the ones the Control UI ends a run on (ui/src/pages/chat/chat-history-stream.ts
 * :187-215 at v2026.9.33 — a terminal status AND `hasActiveRun !== true`):
 *   - the session is not active (`hasActiveRun: false`, which the gateway states only once
 *     the run's terminal row is queryable — chat-history-handler.ts:364-381);
 *   - an EXACT active set that does not name it. The gateway publishes `activeRunIds` only
 *     when its identities are complete, and omits it otherwise — a terminal still being
 *     persisted, an embedded or projected run (src/gateway/server-methods/
 *     session-active-runs.ts:273-283). A list at our read bound may have been cut.
 * Anything else — active with no exact set, no `hasActiveRun` at all — proves nothing:
 * the run may be the one the gateway did not name.
 */
export function runProvenOver(facts: SessionRunFacts, runId: string): boolean {
  if (liveRunIds(facts).includes(runId)) return false;
  if (facts.hasActiveRun === false) return true;
  return facts.activeRunIds !== undefined && facts.activeRunIds.length < MAX_FACT_RUN_IDS;
}

/** The gateway's runs of the session that are not terminal, as the reply names them: the
 *  in-flight run first, then `activeRunIds` (deduplicated). */
export function liveRunIds(facts: SessionRunFacts | null): string[] {
  if (facts === null) return [];
  const out: string[] = [];
  if (facts.inFlightRunId) out.push(facts.inFlightRunId);
  for (const id of facts.activeRunIds ?? []) if (!out.includes(id)) out.push(id);
  return out;
}
