// WHO MAY ACT ON A SESSION, AND WITH WHAT PERMISSIONS — as the gateway reports it.
//
// Read from the `sessions.describe` row Atrium already asks for on every send (v2026.9.6
// sources): the session's VISIBILITY and the caller's SHARING ROLE
// (session-row-presentation.ts, viewer()), and its PERMISSION MODE
// (session-utils-row.ts, materializeSessionRow). Atrium reads them to SHOW them — it
// never decides anything on them: the gateway enforces both, and a value read here
// can only be as fresh as the last describe.

/** `SessionPermissionModeSchema` (packages/gateway-protocol sessions-row.ts). */
export const SESSION_PERMISSION_MODES = ["read-only", "guarded", "workspace", "full"] as const;
export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

/** `SessionVisibilitySchema` (sessions-sharing-values.ts). */
export const SESSION_VISIBILITIES = ["shared", "read-only", "suggest", "draft"] as const;
export type SessionVisibility = (typeof SESSION_VISIBILITIES)[number];

/** `SessionSharingRoleSchema` (sessions-sharing-values.ts). */
export const SESSION_SHARING_ROLES = ["admin", "owner", "member", "viewer"] as const;
export type SessionSharingRole = (typeof SESSION_SHARING_ROLES)[number];

export function isSessionPermissionMode(v: unknown): v is SessionPermissionMode {
  return typeof v === "string" && (SESSION_PERMISSION_MODES as readonly string[]).includes(v);
}

function oneOf<T extends string>(values: readonly T[], v: unknown): T | undefined {
  return typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : undefined;
}

export interface SessionAccessReport {
  visibility?: SessionVisibility;
  sharingRole?: SessionSharingRole;
  /** `null` = the session sets NO mode (the agent's or the gateway's default applies);
   *  absent = not reported (a gateway that does not project it). */
  permissionMode?: SessionPermissionMode | null;
  permissionModePending?: boolean;
  sessionRoot?: string;
}

/**
 * The access facts of one described session row.
 *
 * An UNSET mode is told apart from an UNREPORTED one by `permissionModePending`: the
 * row carries that boolean whenever it projects permissions at all
 * (materializeSessionRow always sets it), while `permissionMode` itself is simply
 * absent when the session has none. A value outside the vendored enums is dropped,
 * never passed on — a future value reads as "not reported", not as a mode.
 */
export function readSessionAccess(sess: Record<string, unknown>): SessionAccessReport {
  const pending = typeof sess.permissionModePending === "boolean" ? sess.permissionModePending : undefined;
  const mode = oneOf(SESSION_PERMISSION_MODES, sess.permissionMode);
  const out: SessionAccessReport = {};
  const visibility = oneOf(SESSION_VISIBILITIES, sess.visibility);
  if (visibility !== undefined) out.visibility = visibility;
  const role = oneOf(SESSION_SHARING_ROLES, sess.sharingRole);
  if (role !== undefined) out.sharingRole = role;
  if (mode !== undefined) out.permissionMode = mode;
  else if (pending !== undefined && sess.permissionMode === undefined) out.permissionMode = null;
  if (pending !== undefined) out.permissionModePending = pending;
  if (typeof sess.sessionRoot === "string" && sess.sessionRoot.length > 0) {
    out.sessionRoot = sess.sessionRoot;
  }
  return out;
}

/**
 * `session.sharing` / `session.sharing.evidence` — the gateway's notice that a session's
 * visibility or members changed (v2026.9.6, sessions-sharing.ts `publishSharingChange`;
 * schema SessionSharingEventSchema / SessionSharingEvidenceEventSchema). READ-scoped and
 * delivered WITHOUT a subscription (not in SESSION_SUBSCRIPTION_EVENTS), so the
 * conversation's socket hears a change made in the Control UI. Only the session key is
 * read: the refresh re-describes, and the describe is the authority on what changed.
 */
export function readSessionSharingKey(frame: unknown): string | null {
  const f = frame as { type?: unknown; event?: unknown; payload?: unknown } | null;
  if (f?.type !== "event") return null;
  if (f.event !== "session.sharing" && f.event !== "session.sharing.evidence") return null;
  const key = (f.payload as { sessionKey?: unknown } | null)?.sessionKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}
