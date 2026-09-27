// WHO MAY ACT ON THIS CONVERSATION'S GATEWAY SESSION, AND WITH WHAT PERMISSIONS —
// the two header chips, decided here and only rendered by the header.
//
// The facts come from the session's `sessions.describe` row (OpenClaw 2026.9.6, see
// convex/lib/sessionAccess.ts). Atrium shows them; the gateway enforces them. A value
// is only as fresh as the last describe (every send, every knob change, every sharing
// notice): a mode changed on the gateway meanwhile is caught by the send guard, not
// by this chip.
//
// Pure module (no React): every branch — including the parameterized messages — is
// unit-tested without a DOM (GC-P5 lesson).

import { m } from "@/paraglide/messages.js";
import {
  isSessionPermissionMode,
  isSessionSharingRole,
  type SessionPermissionMode,
  type SessionSharingRole,
} from "../../convex/lib/sessionAccess";

/** The access slice of `chats.sessionMeta` (see convex/schema.ts). */
export type SessionAccessMetaView = {
  visibility?: string;
  sharingRole?: string;
  permissionMode?: string | null;
  permissionModePending?: boolean;
  sessionRoot?: string;
};

export type PermissionChipView = {
  /** The EFFECTIVE mode; null = nobody says which (the gateway's own default). */
  mode: SessionPermissionMode | null;
  /** Where the mode comes from: set on the session, the agent's default, or unknown. */
  source: "session" | "agent" | "unknown";
  /** Full access, or a default nobody states — which, without configuration or a
   *  sandbox, is full access (upstream docs/gateway/permission-modes.md). */
  alert: boolean;
  /** A mode change is being applied on the gateway. */
  pending: boolean;
  sessionRoot: string | null;
  /** The mode's name ("Supervised", "Default"). */
  label: string;
  /** What the chip reads ("Permissions: Supervised"). */
  text: string;
  /** Short qualifier beside the label (agent default, change in progress), or null. */
  hint: string | null;
  title: string;
};

export function permissionModeLabel(mode: SessionPermissionMode): string {
  switch (mode) {
    case "read-only":
      return m.chat_access_mode_read_only();
    case "guarded":
      return m.chat_access_mode_guarded();
    case "workspace":
      return m.chat_access_mode_workspace();
    case "full":
      return m.chat_access_mode_full();
  }
}

/**
 * The permission chip, or null when nothing is known — no meta yet, a Hermes chat, a
 * gateway that does not report modes, or a value outside the vocabulary (a future mode
 * is not guessed at). `permissionMode: null` IS known: the session sets none, so the
 * agent's default applies when the gateway states it, and otherwise a default nobody
 * names — shown as such, with the warning, never hidden.
 */
export function permissionChipView(
  sm: SessionAccessMetaView | null | undefined,
  agentDefault: string | null | undefined,
): PermissionChipView | null {
  if (sm == null) return null;
  const set = sm.permissionMode;
  let mode: SessionPermissionMode | null;
  let source: PermissionChipView["source"];
  if (isSessionPermissionMode(set)) {
    mode = set;
    source = "session";
  } else if (set === null) {
    mode = isSessionPermissionMode(agentDefault) ? agentDefault : null;
    source = mode === null ? "unknown" : "agent";
  } else {
    return null;
  }
  const pending = sm.permissionModePending === true;
  const sessionRoot =
    typeof sm.sessionRoot === "string" && sm.sessionRoot.length > 0
      ? sm.sessionRoot
      : null;
  const label = mode === null ? m.chat_access_mode_default() : permissionModeLabel(mode);
  const lines = [
    source === "session"
      ? m.chat_access_mode_title_session({ mode: label })
      : source === "agent"
        ? m.chat_access_mode_title_agent({ mode: label })
        : m.chat_access_mode_title_unknown(),
  ];
  if (mode === "full") lines.push(m.chat_access_mode_full_warning());
  if (pending) lines.push(m.chat_access_mode_pending());
  if (sessionRoot !== null) lines.push(m.chat_access_mode_root({ root: sessionRoot }));
  return {
    mode,
    source,
    alert: mode === "full" || source === "unknown",
    pending,
    sessionRoot,
    label,
    text: m.chat_access_mode_chip({ mode: label }),
    // The change in progress wins the one slot: it says the label may be about to move.
    hint: pending
      ? m.chat_access_mode_pending_hint()
      : source === "agent"
        ? m.chat_access_mode_agent_hint()
        : null,
    title: lines.join("\n"),
  };
}

export type VisibilityChipView = {
  visibility: "read-only" | "suggest" | "draft";
  role: SessionSharingRole | null;
  label: string;
  title: string;
};

function sharingRoleLabel(role: SessionSharingRole): string {
  switch (role) {
    case "admin":
      return m.chat_access_role_admin();
    case "owner":
      return m.chat_access_role_owner();
    case "member":
      return m.chat_access_role_member();
    case "viewer":
      return m.chat_access_role_viewer();
  }
}

/**
 * The visibility chip — only when the session is NOT plainly shared: `shared` is the
 * default and says nothing worth a chip, and an absent or unknown value is not guessed.
 * The title names the role Atrium's connection holds on the session, when reported.
 */
export function visibilityChipView(
  sm: SessionAccessMetaView | null | undefined,
): VisibilityChipView | null {
  const visibility = sm?.visibility;
  if (visibility !== "read-only" && visibility !== "suggest" && visibility !== "draft") {
    return null;
  }
  const reported = sm?.sharingRole;
  const role = isSessionSharingRole(reported) ? reported : null;
  const [label, desc] =
    visibility === "read-only"
      ? [m.chat_access_visibility_read_only(), m.chat_access_visibility_read_only_desc()]
      : visibility === "suggest"
        ? [m.chat_access_visibility_suggest(), m.chat_access_visibility_suggest_desc()]
        : [m.chat_access_visibility_draft(), m.chat_access_visibility_draft_desc()];
  const lines = [desc];
  if (role !== null) lines.push(m.chat_access_visibility_role({ role: sharingRoleLabel(role) }));
  return { visibility, role, label, title: lines.join("\n") };
}
