import { createContext } from "react";

// Codex-style QUEUE DOCK: the mid-turn messages parked in the outbox, surfaced
// as editable/cancellable cards above the composer (QueuedDock.tsx consumes).
// Its own module (lot 29): the dock is laid out and followed in a real browser by
// its guard (queueReserve.test.ts) without the whole conversation view.
export interface QueuedTurnView {
  messageId: string;
  text: string;
  pending: boolean;
  /** Written by the reader: only its author takes it back to edit. */
  mine: boolean;
  /** The reader may withdraw it (its author, or the conversation's owner). */
  canCancel: boolean;
  /** Phase 6: an input the GATEWAY holds in its own queue (2026.9.7+), not Atrium's. */
  gateway?: boolean;
}
export interface QueueDockValue {
  queuedTurns: QueuedTurnView[];
  cancelQueued: (messageId: string) => Promise<boolean>;
  /** Withdraw an input the gateway queues (`chat.abort {discardPendingInput}`). */
  withdrawGatewayQueued?: (messageId: string) => Promise<boolean>;
  /** The gateway can withdraw a queued input (capability `discardPendingInput`). */
  canWithdrawGateway?: boolean;
  /** Inputs the gateway queues that are not this conversation's own messages. */
  gatewayOthers?: number;
}
export const QueueDockContext = createContext<QueueDockValue | null>(null);
