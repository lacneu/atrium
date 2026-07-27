import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import { capabilityOf, type CapabilityKey } from "./capabilities";

// Per-chat capability resolution (VCOMPAT-C): subscribes to the compat
// snapshot of THE instance behind a chat (api.compat.forChat — active user,
// own chat, instance = the chat's binding or the routing resolver's pick) and
// returns a curried capability check.
//
// NO-FLASH policy: while the query is in flight, `can` applies the LEGACY
// policy (capabilityOf(null, ...) = model + thinking only). Controls can only
// APPEAR when the snapshot lands — a control never renders and then vanishes,
// which reads as breakage. `chatId: null` skips the subscription entirely
// (e.g. a closed Sheet) and behaves like loading.

export function useInstanceCapabilities(
  chatId: ConvexId<"chats"> | null,
  /** The agent the COMPOSER currently targets, when a per-turn selection exists. The
   *  capability state that matters for a banner or a control is the NEXT SEND's
   *  gateway; without this the chat's binding answers for a target the send will not
   *  use. Omitted by the capability GATES, which describe the chat as it stands. */
  routedAgent?: { instanceName: string; agentId: string } | null,
): {
  can: (key: CapabilityKey) => boolean;
  loading: boolean;
  /** False when the bridge/snapshot did not resolve capabilities (legacy
   *  bridge, unknown instance during an upgrade) — gates that would REMOVE a
   *  long-standing affordance should fail OPEN on unresolved. */
  resolved: boolean;
  gatewayVersion: string | null;
  /** The gateway is NEWER than any version the validation bench has exercised
   *  (W10 / G7). Capabilities are FROZEN at the last validated profile, so nothing is
   *  broken — but the chat says so, because a state nobody can see is a state nobody
   *  acts on. False while loading: a banner that flashes and vanishes reads as a bug. */
  beyondValidated: boolean;
} {
  const res = useQuery(
    api.compat.forChat,
    chatId !== null
      ? {
          chatId: chatId as Id<"chats">,
          // Convex dedupes the subscription with the no-selection callers when the
          // args are identical — the common case is unchanged.
          ...(routedAgent ? { routedAgent } : {}),
        }
      : "skip",
  );
  // undefined (loading/skipped) and null (legacy bridge / unknown instance)
  // both collapse to the legacy capability set.
  const caps = res == null ? null : res.capabilities;
  const can = useCallback(
    (key: CapabilityKey) => capabilityOf(caps, key),
    [caps],
  );
  return {
    can,
    resolved: caps !== null,
    loading: res === undefined,
    gatewayVersion: res?.gatewayVersion ?? null,
    beyondValidated: res?.versionBeyondValidated === true,
  };
}
