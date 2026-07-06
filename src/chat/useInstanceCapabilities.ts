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

export function useInstanceCapabilities(chatId: ConvexId<"chats"> | null): {
  can: (key: CapabilityKey) => boolean;
  loading: boolean;
  /** False when the bridge/snapshot did not resolve capabilities (legacy
   *  bridge, unknown instance during an upgrade) — gates that would REMOVE a
   *  long-standing affordance should fail OPEN on unresolved. */
  resolved: boolean;
  gatewayVersion: string | null;
} {
  const res = useQuery(
    api.compat.forChat,
    chatId !== null ? { chatId: chatId as Id<"chats"> } : "skip",
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
  };
}
