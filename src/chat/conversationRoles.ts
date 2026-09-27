// Room roles as the conversation panel offers them. Pure (no React, no Convex) so
// the offer is unit-tested; the SERVER is the authority (convex/chatParticipants.ts
// `mayChangeRole`) and these helpers only mirror it so no control is shown that the
// server would refuse.

export type MemberRole = "viewer" | "member" | "manager";
export type RoomRole = "owner" | MemberRole;

/** Display order of the roles a participant can hold, least to most. */
export const MEMBER_ROLES: readonly MemberRole[] = ["viewer", "member", "manager"];

/** Does this reader manage the room (invite people, add agents)? */
export function managesRoom(viewer: RoomRole | undefined): boolean {
  return viewer === "owner" || viewer === "manager";
}

/**
 * Which roles `viewer` may give to a participant currently holding `target` —
 * empty when they may not change that person at all. A manager runs the room but
 * never touches another manager and never makes one; the owner decides the rest.
 * Nobody but the owner changes their own role.
 */
export function assignableRoles(
  viewer: RoomRole | undefined,
  target: MemberRole,
  isSelf: boolean,
): MemberRole[] {
  if (viewer === "owner") return [...MEMBER_ROLES];
  if (viewer !== "manager" || isSelf || target === "manager") return [];
  return MEMBER_ROLES.filter((r) => r !== "manager");
}

/** May `viewer` remove a participant holding `target`? Leaving is separate. */
export function mayRemove(
  viewer: RoomRole | undefined,
  target: MemberRole,
  isSelf: boolean,
): boolean {
  if (isSelf) return false;
  if (viewer === "owner") return true;
  return viewer === "manager" && target !== "manager";
}

/** May `viewer` remove this person from the room — the rule for a roster row, the
 *  owner included (never removable; they own the conversation). One rule for the
 *  conversation panel and the composer's quick list. */
export function mayRemoveMember(
  viewer: RoomRole | undefined,
  member: { roomRole: RoomRole; isSelf: boolean },
): boolean {
  if (member.roomRole === "owner") return false;
  return mayRemove(viewer, member.roomRole, member.isSelf);
}

/** The roles an INVITATION may carry for this viewer. */
export function invitableRoles(viewer: RoomRole | undefined): MemberRole[] {
  if (viewer === "owner") return [...MEMBER_ROLES];
  if (viewer === "manager") return ["viewer", "member"];
  return [];
}

/**
 * The role an invitation actually carries: the one picked, when THIS reader may
 * grant it in THIS room, else "member". The pick is UI state that survives a
 * switch to another conversation, where the reader may stand lower (owner here,
 * manager there) — sent as is, the server would refuse it.
 */
export function arrivalRoleFor(picked: MemberRole, viewer: RoomRole | undefined): MemberRole {
  return invitableRoles(viewer).includes(picked) ? picked : "member";
}
