// The BridgeProvider abstraction boundary. OpenClaw and (later) Hermes each
// implement this; core multiplexes/selects providers without importing any
// vendor code. The guaranteed seam is EXACTLY this method surface plus the six
// normalized events in `events.ts` — nothing else (consume-loop timing,
// per-sessionKey maps, deadline ticking) is part of the contract.
//
// See docs/BRIDGE_ARCHITECTURE.md §2.2. NOTE: this interface is the P1 contract;
// the OpenClaw adapter that implements it lands in P2 (providers/openclaw/adapter.ts).

import type { NormalizedEvent } from "./events.js";

/** Non-secret routing for one turn/connection. Mirrors Convex routing metadata. */
export interface Routing {
  /** Convex chat id (durable identity core uses to address the turn). */
  chatId: string;
  /** Provider-side conversation/session id (was `openclawChatId`). */
  providerChatId: string | null;
  /** Per-user agent selection (default agent already resolved by core). */
  agentId: string | null;
  /** Operator/canonical segment (per-user). */
  canonical: string | null;
  /**
   * Optional subagent target. Pluggable but NOT wired for OpenClaw yet — the
   * subagent session-key grammar is NOT FOUND for v2026.5.19 (HONESTY rule).
   */
  subagentId?: string | null;
}

/** Opaque per-instance secrets, read from the BRIDGE secret store — never Convex. */
export interface InstanceSecrets {
  readonly [k: string]: unknown; // provider validates the shape it needs
}

/** Handle from sendMessage so core can create the streaming message up-front. */
export interface TurnHandle {
  runId: string | null; // provider ack runId, or null if none yet
}

export interface ProviderCapabilities {
  abort: boolean; // a real server-side abort RPC (vs local finalize)
  history: boolean; // getHistory backed by a real call
  listConversations: boolean;
  attachments: boolean; // accepts outbound attachments on sendMessage
  media: boolean; // emits `media` events for inbound files
  subagents: boolean; // honours Routing.subagentId
  streaming: "delta" | "snapshot" | "both";
}

export interface BridgeProvider {
  readonly kind: "openclaw" | "hermes";

  /** Open ONE long-lived connection for the instance. Idempotent per instance. */
  connect(secrets: InstanceSecrets): Promise<void>;

  /** Send a user turn. Returns the ack runId so core can begin the turn. */
  sendMessage(
    routing: Routing,
    text: string,
    clientMessageId: string,
    attachments?: unknown[],
  ): Promise<TurnHandle>;

  /** Stop an in-flight turn for one chat (server RPC if capable, else finalize). */
  abort(routing: Routing): Promise<void>;

  /** Past messages for a conversation (provider call; shape provider-specific). */
  getHistory(routing: Routing, opts?: { limit?: number }): Promise<unknown>;

  /** Provider-side conversation list for the connected user/instance. */
  listConversations(opts?: { limit?: number }): Promise<unknown>;

  /** Subscribe to normalized events; the event carries chat identity. */
  on(handler: (chatId: string, event: NormalizedEvent) => void): void;

  capabilities(): ProviderCapabilities;

  /** Close the connection and finalize any in-flight turns as aborted. */
  close(): Promise<void>;
}
