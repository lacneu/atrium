// THE CONVERSATION'S PERMISSION MODE, AS ITS OWNER CHOSE IT — applied, not only shown.
//
// Upstream (v2026.9.6): a session's execution-permission mode is set by `sessions.patch
// {key, permissionMode}`; `null` removes the override so the agent's configured policy
// applies (session-execution-settings.ts:51-55). `full` needs `operator.admin`, every
// other value `operator.write` (session-method-scopes-base.ts:107, and the handler's own
// check, server-methods/sessions-mutations.ts:124-136). A patch into a key with no
// session CREATES it (sessions-patch.ts:280-292). A change while a run is live is applied
// to that run — its pending approvals cancelled — or refused before saving when the
// runtime cannot take it (`INVALID_REQUEST`), or saved but not applied (`UNAVAILABLE`)
// (sessions-patch-permissions.runtime.ts:26-83). `sessions.reset` keeps the mode
// (session-reset-service.ts:1432-1434).
//
// In Atrium the mode is a property of the CONVERSATION (Convex `chats.permissionModeChoice`):
// every OpenClaw session Atrium opens for it — a per-turn switch, a rotated segment, a
// session recreated after it was pruned — gets it before its first `chat.send`, and the
// send's `expectedPermissionMode` guard then equals what was applied. A chat with no choice
// is left exactly as before (this module is never reached).
//
// `full` is authorized by CONVEX (the owner is an Atrium administrator), never by the
// socket that happens to carry admin: the bridge acts as a gateway administrator (token
// mode, or the admin socket `sessionPatchNeedsAdmin` routes to), so without this gate any
// owner could grant full access to an agent the operator restricted.

import { PERMISSION_MODES_SINCE, gatewayAtLeast } from "../../compat.js";
import { gatewayOwnRefusal } from "../../core/failure-classifier.js";
import { GatewayAnsweredError } from "./openclaw-client.js";
import {
  SESSION_PERMISSION_MODES,
  isSessionPermissionMode,
  type SessionPermissionMode,
} from "./session-access.js";


/** What the owner can choose: the agent's configured policy, or one mode. */
export const PERMISSION_MODE_CHOICES = ["default", ...SESSION_PERMISSION_MODES] as const;
export type PermissionModeChoice = (typeof PERMISSION_MODE_CHOICES)[number];

export function parsePermissionModeChoice(v: unknown): PermissionModeChoice | undefined {
  if (v === "default") return "default";
  return isSessionPermissionMode(v) ? v : undefined;
}

/** The `sessions.patch.permissionMode` value for a choice — `null` clears the override. */
export function patchValueFor(choice: PermissionModeChoice): SessionPermissionMode | null {
  return choice === "default" ? null : choice;
}

/** Why a choice could not be applied — one closed vocabulary, shared with Convex. */
export const PERMISSION_MODE_FAILURES = [
  // Convex did not say this instance has Atrium manage permissions (its operator does):
  // nothing is patched, whatever choice the body carries.
  "not_managed",
  // The gateway predates permission modes (a non-default choice has nothing to land on).
  "unsupported_gateway",
  // `full` without Convex's authorization — refused here, never sent.
  "full_not_authorized",
  // No session exists yet and the one the send would create cannot receive `full`
  // without being created under the bridge's identity (trusted-proxy): retried next turn.
  "session_not_established",
  // The gateway answered `missing scope` (full needs operator.admin).
  "scope_refused",
  // A live run cannot take a permission change; nothing was saved (INVALID_REQUEST).
  "active_run",
  // Any other refusal the gateway answered.
  "rejected",
] as const;
export type PermissionModeFailure = (typeof PERMISSION_MODE_FAILURES)[number];

export class PermissionModeNotAppliedError extends Error {
  constructor(
    readonly reason: PermissionModeFailure,
    detail?: string,
  ) {
    super(`permission mode not applied (${reason})${detail ? `: ${detail}` : ""}`);
    this.name = "PermissionModeNotAppliedError";
  }
}

/**
 * A `sessions.patch` refusal, by its upstream wording (the client formats an answered
 * error as `<CODE>: <message>`, openclaw-client.ts):
 *  - `FORBIDDEN: missing scope: operator.admin` (error-codes.ts missingScopeErrorShape);
 *  - `INVALID_REQUEST: This run cannot apply permissions while active…`
 *    (sessions-patch-permissions.runtime.ts:30-37);
 *  - `UNAVAILABLE: Permissions were saved, but could not be applied to the active run…`
 *    (sessions-patch-permissions.runtime.ts:80-83).
 */
export function classifyPermissionPatchError(
  err: unknown,
): PermissionModeFailure | "saved_not_applied" {
  const text = (err as Error)?.message ?? "";
  if (/missing scope/i.test(text)) return "scope_refused";
  if (/cannot apply permissions while active/i.test(text)) return "active_run";
  if (/could not be applied to the active run/i.test(text)) return "saved_not_applied";
  return "rejected";
}

export interface PermissionEnforcement {
  /** The mode the session holds now (`null` = none: the agent's configured policy). */
  mode: SessionPermissionMode | null;
  /** Whether a `sessions.patch` was sent to get there. */
  patched: boolean;
  /** The mode was SAVED, but a run live at that moment could not take it: upstream
   *  stopped that run (sessions-patch-permissions.runtime.ts:69-78) and the next one
   *  uses the saved mode. Not a failure — the session holds the choice. */
  savedNotApplied?: true;
}

/**
 * Bring ONE session to the conversation's chosen mode.
 *
 * `described` is what the session holds as last read (`null` = none set, `undefined` =
 * unknown); an equal value costs nothing — no patch, so no event, no approval cancelled.
 * `sessionAbsent` = the gateway STATED there is no session: the one about to be created
 * holds none, so "default" is already true there.
 *
 * Throws `PermissionModeNotAppliedError` when the gateway refused (or cannot receive) the
 * mode. A patch that got NO answer (socket closed, timeout) is rethrown as is: it may have
 * landed, and the caller's own classification of a lost gateway is the honest one.
 */
export async function enforcePermissionMode(args: {
  choice: PermissionModeChoice;
  fullAuthorized: boolean;
  gatewayVersion: string | null;
  sessionKey: string;
  described: SessionPermissionMode | null | undefined;
  sessionAbsent: boolean;
  /** The describe ANSWERED with a session: its existence is established. A failed,
   *  timed-out or unreadable read is not evidence either way. */
  sessionConfirmed: boolean;
  /** The patch may create the session without harm if it turns out to be absent
   *  (token mode, or a write-scoped value riding the owner's own socket). */
  mayCreateSession: boolean;
  /** Sends one `sessions.patch` on the socket its scope requires. */
  patch: (params: Record<string, unknown>) => Promise<unknown>;
}): Promise<PermissionEnforcement> {
  const target = patchValueFor(args.choice);
  if (target === "full" && !args.fullAuthorized) {
    throw new PermissionModeNotAppliedError("full_not_authorized");
  }
  if (gatewayAtLeast(args.gatewayVersion, PERMISSION_MODES_SINCE) !== true) {
    // No modes at all on this gateway: its sessions follow the agent's configuration,
    // which is exactly "default". Anything else cannot be honoured.
    if (target === null) return { mode: null, patched: false };
    throw new PermissionModeNotAppliedError("unsupported_gateway");
  }
  if (args.described === target) return { mode: target, patched: false };
  if (args.sessionAbsent && target === null) return { mode: null, patched: false };
  // Only a session KNOWN to exist may be patched where the patch could create it under
  // the wrong identity: `full` in trusted-proxy mode rides the administrative socket,
  // and a patch into an empty key creates the session as the BRIDGE's — for life
  // (claimSessionForOwner). Absent OR undecidable (the read failed): not patched.
  if (!args.sessionConfirmed && !args.mayCreateSession) {
    throw new PermissionModeNotAppliedError("session_not_established");
  }
  try {
    await args.patch({ key: args.sessionKey, permissionMode: target });
  } catch (err) {
    if (!(err instanceof GatewayAnsweredError)) throw err;
    // The gateway refused on its OWN state (the agent's database closed, its storage
    // unusable), not on the mode: passed through RAW, so the send is classified by what
    // happened (core/dispatch-errors.ts) instead of reading as a permission problem.
    if (gatewayOwnRefusal(err) !== null) throw err;
    const reason = classifyPermissionPatchError(err);
    if (reason === "saved_not_applied") {
      return { mode: target, patched: true, savedNotApplied: true };
    }
    throw new PermissionModeNotAppliedError(reason, (err as Error).message);
  }
  return { mode: target, patched: true };
}
