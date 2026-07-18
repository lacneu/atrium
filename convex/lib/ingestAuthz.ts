// SHARED ingest authorization: the cross-gateway write barrier's core decision,
// factored out so BOTH the boundary check (bridge_ingest.authorizeIngestTarget)
// AND the mutations that resolve rows by a GLOBAL key (subAgents.upsertSubAgent /
// upsertSubAgentToolPart) enforce the SAME rule. Boundary-only authorization is
// insufficient for global-key upserts: authorize-then-upsert are two Convex
// transactions, so a concurrent upsert of the same key can slip between them
// (TOCTOU). The mutations therefore RE-CHECK atomically via this helper.
//
// The invariant is PROVENANCE, not the chat's latest global state: a bound
// instance may write to a chat it is legitimately part of — its PRIMARY binding,
// or (for a per-turn multi-agent chat) any instance a turn was EVER routed to.
// "Ever routed" (not "the latest route") is race-free while B streams and a
// follow-up queues to C.

import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

type Ctx = QueryCtx | MutationCtx;

/**
 * May the bound instance write to this chat? PROVENANCE rule:
 *   (a) primary binding matches, OR
 *   (b) perTurnRouting AND a turn here was routed to the bound instance
 *       (indexed point lookup — never a full-chat scan), OR
 *   (c) a genuinely UNROUTED, null-primary chat (legacy) — allowed during the
 *       transition (a hardened REQUIRE_PER_BRIDGE deploy stamps every chat).
 * Everything else (a different instance's single-agent chat) is denied.
 */
export async function chatAllowsInstance(
  ctx: Ctx,
  chatId: Id<"chats">,
  boundInstanceName: string,
): Promise<boolean> {
  const chat = await ctx.db.get(chatId);
  if (chat === null) return false;
  const primary = chat.instanceName ?? null;
  if (primary === boundInstanceName) return true;
  if (chat.perTurnRouting === true) {
    const routedHere = await ctx.db
      .query("messages")
      .withIndex("by_chat_routed_instance", (q) =>
        q.eq("chatId", chatId).eq("routedInstanceName", boundInstanceName),
      )
      .first();
    return routedHere !== null;
  }
  // A per-turn chat is never a free-for-all even with a null primary (handled
  // above). A non-routed, null-primary chat (legacy / created before an agent
  // was chosen — `chats.instanceName` is OPTIONAL) gets the transition pass
  // ONLY while the shared secret is still accepted. Once the operator commits
  // to per-bridge isolation (BRIDGE_INGEST_REQUIRE_PER_BRIDGE=true), an
  // unstamped chat is NOT a free-for-all: deny it, so the "no cross-gateway
  // write" guarantee cannot be defeated through a null-primary chat. Such chats
  // must be stamped/backfilled before the flag is flipped.
  if (primary === null) {
    return process.env.BRIDGE_INGEST_REQUIRE_PER_BRIDGE !== "true";
  }
  return false;
}
