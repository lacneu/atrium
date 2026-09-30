// View helpers for the group "Manage" dialog (GroupsTab). Extracted so the
// filter / sort / hide / label / selection logic is unit-testable: typecheck +
// build never exercise it, and the dialog can only be reached live with admin
// data, so this is the only reliable guard against an ordering, filter or label
// inversion.

import { m } from "@/paraglide/messages.js";
import {
  ADMIN_RESTRICTION_WOULD_APPLY,
  ADMIN_RESTRICTION_WOULD_LIFT,
} from "../../../convex/lib/groupMembers";

// Minimal shapes the helpers need (kept structural so the real Convex row types
// satisfy them without coupling to convexApi).
export type MemberCandidate = {
  userId: string;
  email?: string | null;
  name?: string | null;
  canonical?: string | null;
};

export type AgentCandidate = {
  agentId: string;
  displayName?: string | null;
  source?: string | null;
};

// Filter users by a free-text query (email / name / canonical, case-insensitive)
// then list snapshot-members FIRST. The ordering uses a frozen snapshot set, not
// the live membership, so a row does not jump after a toggle commits. Array sort
// is stable, so ties keep the incoming (server) order.
export function filterSortMembers<T extends MemberCandidate>(
  users: readonly T[],
  query: string,
  orderSnapshot: ReadonlySet<string>,
): T[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? users.filter((u) =>
        [u.email, u.name, u.canonical].some(
          (v) => v != null && v.toLowerCase().includes(q),
        ),
      )
    : users.slice();
  return [...matched].sort((a, b) => {
    const am = orderSnapshot.has(a.userId) ? 0 : 1;
    const bm = orderSnapshot.has(b.userId) ? 0 : 1;
    return am - bm;
  });
}

// The discovered agents of one instance matching a query (displayName / agentId,
// case-insensitive). Only "discovered" agents are assignable, so non-discovered
// rows are dropped first.
export function filterInstanceAgents<T extends AgentCandidate>(
  agents: readonly T[],
  query: string,
): T[] {
  const discovered = agents.filter((a) => a.source === "discovered");
  const q = query.trim().toLowerCase();
  if (!q) return discovered;
  return discovered.filter(
    (a) =>
      (a.displayName ?? a.agentId).toLowerCase().includes(q) ||
      a.agentId.toLowerCase().includes(q),
  );
}

// A human label + secondary identifier for a user row. A user with neither name
// nor email has only a generated handle (e.g. `u-q576vvxyqp`); rather than leak
// it as a bare row id we present it as an `@handle` so it reads as an identity.
export type UserDisplay = { primary: string; secondary: string | null };

export function userDisplayParts(u: MemberCandidate): UserDisplay {
  const name = u.name?.trim() ?? "";
  const email = u.email?.trim() ?? "";
  const handle = u.canonical?.trim() || `u-${u.userId.slice(0, 8)}`;
  if (name) return { primary: name, secondary: email || `@${handle}` };
  if (email) return { primary: email, secondary: null };
  return { primary: `@${handle}`, secondary: null };
}

// Localized label for a built-in role; a custom role renders its raw key.
export function roleLabel(role: string): string {
  switch (role) {
    case "admin":
      return m.role_admin();
    case "user":
      return m.role_user();
    case "pending":
      return m.role_pending();
    default:
      return role;
  }
}

// Tri-state of a "select all" checkbox over a (possibly filtered) set.
export type SelectionState = "all" | "some" | "none";

export function selectionState<T>(
  items: readonly T[],
  isSelected: (item: T) => boolean,
): SelectionState {
  if (items.length === 0) return "none";
  let selected = 0;
  for (const it of items) if (isSelected(it)) selected++;
  if (selected === 0) return "none";
  return selected === items.length ? "all" : "some";
}

// Slice a list into one page. `page` is clamped to [1, pageCount] (pageCount is
// at least 1, so an empty list yields page 1 of 1 with no items) — this makes
// pagination a PURE RENDERING concern: select-all / counts keep operating on the
// full filtered set, only the rendered rows are paged.
export type Paged<T> = { pageItems: T[]; page: number; pageCount: number };

export function paginate<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): Paged<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const clamped = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const start = (clamped - 1) * pageSize;
  return {
    pageItems: items.slice(start, start + pageSize),
    page: clamped,
    pageCount,
  };
}

// ---------------------------------------------------------------------------
// Delegated management (claim / reservation / per-member restriction).

// What a row of the group's agent list lets the viewer do:
//   - "claim"  : a new agent nobody decided on — reserve it for this group;
//   - "toggle" : share / unshare (an assigned agent is always removable);
//   - "locked" : listed but greyed (gone, not enabled, or — for a manager — an
//                agent outside the group's scope, which the server refuses).
export type AgentRowFlags = {
  assigned: boolean;
  claimable: boolean;
  reservedForGroup: boolean;
  enabled: boolean;
  present: boolean;
};
export type AgentRowControl = "claim" | "toggle" | "locked";

export function agentRowControl(
  f: AgentRowFlags,
  viewerIsAdmin: boolean,
): AgentRowControl {
  if (f.assigned) return "toggle";
  if (f.claimable) return "claim";
  if (!f.present || !f.enabled) return "locked";
  return viewerIsAdmin || f.reservedForGroup ? "toggle" : "locked";
}

// A stable key for an (instance, agent) pair — length-prefixed so an instance
// name containing "/" can never collide with another pair.
export function agentPairKey(instanceName: string, agentId: string): string {
  return `${instanceName.length}:${instanceName}/${agentId}`;
}

// The allowed set a member restriction becomes after toggling ONE agent. An
// unrestricted member starts from the whole group; the result keeps the group's
// order. Returned as keys (the caller maps them back to agent refs).
export function nextMemberAllowance(
  groupKeys: readonly string[],
  allowed: ReadonlySet<string>,
  restricted: boolean,
  key: string,
): string[] {
  const next = new Set(restricted ? allowed : groupKeys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return groupKeys.filter((k) => next.has(k));
}

// Localized status of an invitation request.
export function inviteStatusLabel(
  status: "pending" | "approved" | "rejected",
): string {
  switch (status) {
    case "pending":
      return m.groups_invite_status_pending();
    case "approved":
      return m.groups_invite_status_approved();
    case "rejected":
      return m.groups_invite_status_rejected();
  }
}

// The server's typed refusals (ConvexError data, convex/lib/groupMembers.ts): a
// manager's unshare or member removal would LIFT an administrator's restriction on
// a member, or a share would APPLY one. Localized here; any other error is passed
// through for the toast to render as-is.
export function groupErrorDetail(err: unknown): unknown {
  const data = (err as { data?: unknown } | null)?.data;
  if (typeof data !== "object" || data === null) return err;
  const { code, agent } = data as { code?: unknown; agent?: unknown };
  const name = typeof agent === "string" ? agent : null;
  if (code === ADMIN_RESTRICTION_WOULD_LIFT) {
    return name !== null
      ? m.groups_error_admin_restriction_agent({ agent: name })
      : m.groups_error_admin_restriction();
  }
  if (code === ADMIN_RESTRICTION_WOULD_APPLY) {
    return m.groups_error_admin_restriction_apply({ agent: name ?? "?" });
  }
  return err;
}
