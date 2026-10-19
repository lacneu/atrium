import { useEffect, useState } from "react";
import { deliveryWindowOpen, type DeliveryExpiry } from "./turnActivityAnchor";

/** The latest user turn of a thread, by its true "sent at" moment
 *  (`orderTime ?? _creationTime`, the same rule as handOffFacts `resumeIndexOf`). */
export function lastUserTurnAt(
  list: readonly { role?: string; orderTime?: number; _creationTime?: number }[] | undefined,
): number | null {
  let last: number | null = null;
  for (const msg of list ?? []) {
    if (msg.role !== "user") continue;
    const at = msg.orderTime ?? msg._creationTime;
    if (at !== undefined && (last === null || at > last)) last = at;
  }
  return last;
}

/** Projection `on`: a finished child's delivery is "being composed" only while the GATEWAY
 *  says the parent session works (`followUpState.workingUntil`, a run active at the last
 *  read or a send admitted with no bubble yet — the Control UI shows its reading indicator
 *  on the same facts, ui/src/pages/chat/chat-thread-build.ts:562-570 at v2026.9.33), and
 *  until a fact ends it: the resume naming the child (subAgents.turnActivity stops
 *  reporting it) or a newer user message. No fixed delay: a resume the agent keeps silent
 *  (`ANNOUNCE_SKIP`, no bubble) leaves no active run, so nothing stays lit. */
export function projectedDeliveryOpen(
  deliveringSince: number | null,
  lastUserAt: number | null,
  gatewayWorkingUntil: number | null,
  now: number,
): boolean {
  if (deliveringSince === null) return false;
  if (gatewayWorkingUntil === null || gatewayWorkingUntil <= now) return false;
  return !(lastUserAt !== null && lastUserAt > deliveringSince);
}

/** Whether the local 45 s window timer is armed: never in projection `on`. */
export function armsDeliveryTimer(
  projected: boolean,
  deliveringSince: number | null,
  deliveringTtlRemainingMs: number | null,
): boolean {
  return !projected && deliveringSince !== null && deliveringTtlRemainingMs !== null && deliveringTtlRemainingMs > 0;
}

/** WHETHER the thread's activity indicator is shown — the one gate ChatThread renders by.
 *
 *  Outside `on`, a finished child's delivery is bounded by the server's window (its
 *  remaining time, closed locally by a timer, deliveryWindowOpen). In `on` the window and
 *  its timer are not on this path at all (Codex review 1 of 0.101.1: the single indicator
 *  vanished at 46 s with no resume, and a new user message did not end it). */
export function useDeliveringSignal({
  chatId,
  projected,
  anyStreaming,
  runningLive,
  deliveringSince,
  deliveringTtlRemainingMs,
  lastUserAt,
  gatewayWorkingUntil,
  now = Date.now(),
}: {
  chatId: string;
  projected: boolean;
  anyStreaming: boolean;
  runningLive: boolean;
  deliveringSince: number | null;
  deliveringTtlRemainingMs: number | null;
  lastUserAt: number | null;
  gatewayWorkingUntil: number | null;
  /** Injectable for a test; the render's own clock otherwise. */
  now?: number;
}): { deliveringFresh: boolean; showTurnActivity: boolean } {
  // The LOCAL expiry: the remaining time is not a reactive dependency, so a client that
  // receives no further write closes the window on its own timer. It records WHICH
  // delivery it closed, so a fresh one is live on the render that first sees it.
  const [expired, setExpired] = useState<DeliveryExpiry | null>(null);
  useEffect(() => {
    if (!armsDeliveryTimer(projected, deliveringSince, deliveringTtlRemainingMs)) return;
    if (deliveringSince === null || deliveringTtlRemainingMs === null) return;
    const t = window.setTimeout(
      () => setExpired({ chatId, key: deliveringSince }),
      deliveringTtlRemainingMs,
    );
    return () => window.clearTimeout(t);
  }, [projected, deliveringSince, deliveringTtlRemainingMs, chatId]);
  // The gateway fact's own deadline: a query is not re-run when time passes, so the
  // signal re-renders at that instant (as useConvexChatRuntime does for `workingUntil`).
  const [, bump] = useState(0);
  useEffect(() => {
    if (!projected || gatewayWorkingUntil === null) return;
    const ms = gatewayWorkingUntil - Date.now();
    if (ms <= 0) return;
    const t = window.setTimeout(() => bump((n) => n + 1), ms + 50);
    return () => window.clearTimeout(t);
  }, [projected, gatewayWorkingUntil]);
  const deliveringFresh = projected
    ? projectedDeliveryOpen(deliveringSince, lastUserAt, gatewayWorkingUntil, now)
    : deliveryWindowOpen(chatId, deliveringSince, deliveringTtlRemainingMs, expired);
  return { deliveringFresh, showTurnActivity: !anyStreaming && (runningLive || deliveringFresh) };
}
