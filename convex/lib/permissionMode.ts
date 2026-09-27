/**
 * THE CONVERSATION'S EXECUTION-PERMISSION CHOICE — who may make it, and what a turn
 * carries of it (OpenClaw 2026.9.6 `sessions.patch.permissionMode`).
 *
 * The OWNER chooses; everyone else sees. `full` only for an Atrium administrator: the
 * bridge acts on the gateway as an administrator (token mode, or the admin socket a
 * `full` patch is routed to), so the gateway's own `operator.admin` gate would let ANY
 * owner lift the operator's restrictions — Atrium's role is the gate that matters.
 * "default" (the agent's configured policy) is always allowed: it is the operator's own
 * configuration, even when that resolves to full access.
 *
 * Pure (no Convex runtime import) except the typed ctx helper at the bottom.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getProfile, roleOf } from "./access";

export const PERMISSION_MODE_CHOICES = [
  "default",
  "read-only",
  "guarded",
  "workspace",
  "full",
] as const;
export type PermissionModeChoice = (typeof PERMISSION_MODE_CHOICES)[number];

export function isPermissionModeChoice(v: unknown): v is PermissionModeChoice {
  return (
    typeof v === "string" && (PERMISSION_MODE_CHOICES as readonly string[]).includes(v)
  );
}

/** Why a choice is refused to this person, or null when they may make it. */
export function permissionChoiceRefusal(input: {
  choice: PermissionModeChoice;
  isOwner: boolean;
  isAdmin: boolean;
  /** At least one OpenClaw instance of the conversation is managed by Atrium. */
  anyManaged: boolean;
}): "not_owner" | "not_managed" | "full_requires_admin" | null {
  if (!input.isOwner) return "not_owner";
  if (!input.anyManaged) return "not_managed";
  if (input.choice === "full" && !input.isAdmin) return "full_requires_admin";
  return null;
}

/**
 * What a /send carries of the conversation's choice, or null when Atrium applies
 * nothing to this target: its instance does not have Atrium manage execution
 * permissions (`instances.managePermissionModes` off — the gateway's operator decides,
 * exactly as before), or it is not OpenClaw (Hermes has no modes). On a MANAGED
 * instance an absent choice is "default": Atrium is authoritative there, so a mode set
 * behind its back (the Control UI) is cleared before the turn.
 *
 * `fullAuthorized` is re-decided AT DISPATCH on the owner's role NOW: an owner who chose
 * `full` as an administrator and has since lost the role does not keep it — the bridge
 * then refuses the turn by name (`permission_mode_not_applied`) rather than Atrium
 * silently switching the conversation to another mode.
 */
export function dispatchPermissionChoice(input: {
  choice: PermissionModeChoice | undefined;
  provider: string;
  managed: boolean;
  ownerIsAdmin: boolean;
}): { choice: PermissionModeChoice; fullAuthorized: boolean } | null {
  if (!input.managed || input.provider !== "openclaw") return null;
  const choice = input.choice ?? "default";
  return {
    choice,
    fullAuthorized: choice === "full" && input.ownerIsAdmin,
  };
}

/** Does Atrium manage execution permissions on this instance? Off unless an admin
 *  explicitly turned it on. */
export function instanceManagesPermissions(
  instance: { managePermissionModes?: boolean } | null | undefined,
): boolean {
  return instance?.managePermissionModes === true;
}

/** Is this user an Atrium administrator (their own profile role)? */
export async function isAdminUser(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<boolean> {
  return roleOf(await getProfile(ctx, userId)) === "admin";
}

/** The chat's stored choice, typed. */
export function storedChoice(chat: Doc<"chats">): PermissionModeChoice | undefined {
  const c = chat.permissionModeChoice;
  return isPermissionModeChoice(c) ? c : undefined;
}
