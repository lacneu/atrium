// Realtime voice ("talk") — the AGENT-CONSULT relay's coordination core.
//
// The browser relays the voice model's `openclaw_agent_consult` tool call to
// the gateway (talk.client.toolCall -> {runId}); the gateway runs a REAL agent
// turn on the chat's session. The /talk-toolcall route drives that run through
// the SAME RunManager/TurnSink/normalizer pipeline as a typed turn (tool
// cards, reasoning, media, finalize — one implementation, zero drift), using
// `observeFinalize` to capture the terminal for the VOICE reply.

import type { ConvexWriter, FinalizeStatus } from "../convex-writer.js";

/**
 * Talk realtime agent-consult runs: the gateway keys them
 * `talk-<callId>-<uuid>` (the idempotencyKey shape, measured in the 2026.7.1
 * dist — the gateway substitutes the agent command's own runId only when that
 * command returns one, which keeps the same key in practice). Admitted into
 * the spontaneous-turn machinery so a consult triggered by ANOTHER client
 * (e.g. the Control UI) still lands in the thread; consults relayed by THIS
 * bridge are claimed below and driven first-class by the relay instead.
 */
export function isTalkConsultRunId(runId: string | null | undefined): boolean {
  return typeof runId === "string" && runId.startsWith("talk-");
}

/**
 * Observe a writer's terminal: delegates EVERYTHING to the real writer and
 * reports finalize's (status, text, error) — the voice reply needs the turn's
 * outcome without duplicating any pipeline logic.
 */
export function observeFinalize(
  writer: ConvexWriter,
  onFinal: (status: FinalizeStatus, text: string, error: string | null) => void,
): ConvexWriter {
  return new Proxy(writer, {
    get(target, prop, receiver) {
      if (prop === "finalize") {
        return async (
          messageId: string,
          status: FinalizeStatus,
          text: string,
          error: string | null,
          errorKind?: string | null,
        ) => {
          onFinal(status, text, error);
          return target.finalize(messageId, status, text, error, errorKind);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as ConvexWriter;
}

// ---------------------------------------------------------------------------
// Relay ownership — WHO writes the consult turn into the thread.
//
// The /talk-toolcall relay drives the run first-class (voice-first chats have
// NO warm session — a freshly restarted bridge, or a chat never typed in,
// would otherwise never show the turn). A WARM chat session sees the same
// frames through the spontaneous-turn machinery; without coordination both
// would write a bubble. The relay CLAIMS the runId here; the run-manager
// admission skips claimed runs. Terminal runs stay claimed
// (retransmit-proofing) in a size-bounded set.
// ---------------------------------------------------------------------------

const relayOwnedTalkRuns = new Set<string>();
const MAX_CLAIMED_TALK_RUNS = 500;

export function claimTalkRun(runId: string): void {
  relayOwnedTalkRuns.add(runId);
  if (relayOwnedTalkRuns.size > MAX_CLAIMED_TALK_RUNS) {
    // Sets iterate in insertion order — drop the oldest claim.
    const oldest = relayOwnedTalkRuns.values().next().value;
    if (oldest !== undefined) relayOwnedTalkRuns.delete(oldest);
  }
}

export function releaseTalkRun(runId: string): void {
  relayOwnedTalkRuns.delete(runId);
}

export function isRelayOwnedTalkRun(runId: string): boolean {
  return relayOwnedTalkRuns.has(runId);
}
