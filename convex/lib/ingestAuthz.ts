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
import { userMayAccessInstance } from "../agents";
import { resolveTargetForChat } from "../routing";

type Ctx = QueryCtx | MutationCtx;

/**
 * May the bound instance write to this chat? PROVENANCE rule:
 *   (a) primary binding matches, OR
 *   (b) perTurnRouting AND a turn here was routed to the bound instance
 *       (indexed point lookup — never a full-chat scan), re-validated against
 *       the owner's CURRENT entitlements via targeted reads, OR
 *   (c) a null-primary chat (legacy, missed by the widen-phase migration):
 *       allowed IFF the bound instance IS what dispatch would resolve for the
 *       chat; queries decide without writing, mutations SELF-HEAL (stamp the
 *       binding + drop the stale provider session, bindChatTarget semantics).
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
    if (routedHere === null) return false;
    // RE-VALIDATE against the owner's CURRENT entitlements: a stamp persisted
    // before route validation existed (or forged via a direct pre-R2
    // sendMessage), and a route whose grant was since REVOKED, are not proof
    // (codex P1). userMayAccessInstance IS the effective-grants cascade as a
    // BOUNDED membership test — same group-scope narrowing and enablement gate
    // as getEffectiveGrants (a hand-rolled decomposition here diverged on
    // both, codex P1×2), without the groupless-user all-pool collect per
    // authorization (codex P2).
    return await userMayAccessInstance(ctx, chat.userId, boundInstanceName);
  }
  // A null-primary chat is NEVER a free-for-all — but an operator may have
  // skipped the widen-phase migration (migrations:stampNullInstanceChats), and
  // a legacy chat's late announce/delivery can reach here without a fresh
  // dispatch to rebind it (codex P1). Resolve the chat exactly as dispatch and
  // the migration would; the bound instance is allowed IFF it IS that
  // resolution. Queries (the ingest BOUNDARY, rehydrationContext) decide
  // WITHOUT writing — a deny there would 403 the very mutation that could heal
  // the chat (codex P1). Mutations SELF-HEAL: stamp the binding AND drop the
  // stale provider session id — it belonged to whichever agent served the chat
  // before binding existed, exactly what bindChatTarget clears on rebind
  // (codex P1: keeping it would resume the wrong thread on the next dispatch).
  const resolution = await resolveTargetForChat(ctx, chat, chat.userId);
  if (
    resolution.target === null ||
    resolution.target.instanceName !== boundInstanceName
  )
    return false;
  if ("patch" in ctx.db) {
    await (ctx as MutationCtx).db.patch(chatId, {
      instanceName: resolution.target.instanceName,
      agentId: resolution.target.agentId,
      openclawChatId: undefined,
    });
  }
  return true;
}
