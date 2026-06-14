// Audit trail writer for the impersonation module.
//
// Every cross-identity action (an admin doing something WHILE impersonating a
// user) is recorded with both identities, so the trail answers "who really did
// this, and as whom?". PHI rule: we record the action verb + the resource
// kind/id ONLY — never message text, titles, or other user content.

import type { MutationCtx } from "../_generated/server";
import type { Actor } from "./access";

type AuditTarget = { resource?: string; resourceId?: string };

/** Unconditionally write an audit row (used for impersonation start/stop). */
export async function recordAudit(
  ctx: MutationCtx,
  actor: Actor,
  action: string,
  target?: AuditTarget,
): Promise<void> {
  await ctx.db.insert("auditLog", {
    at: Date.now(),
    action,
    realUserId: actor.realUserId,
    effectiveUserId: actor.effectiveUserId,
    impersonated: actor.impersonating,
    resource: target?.resource,
    resourceId: target?.resourceId,
  });
}

/**
 * Record a user-data write ONLY when it ran under impersonation — i.e. the
 * cross-identity actions that actually need attribution. A user acting as
 * themselves is a no-op, keeping the log focused on sensitive operations.
 */
export async function auditImpersonated(
  ctx: MutationCtx,
  actor: Actor,
  action: string,
  target?: AuditTarget,
): Promise<void> {
  if (actor.impersonating) await recordAudit(ctx, actor, action, target);
}
