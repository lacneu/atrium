// WHO MAY ACT ON THIS CONVERSATION'S GATEWAY SESSION — the header's visibility chip,
// decided here and only rendered by the header. (The session's permission mode is no
// longer a header chip: the composer's execution-permissions picker carries it, see
// permissionModeView.ts.)
//
// The facts come from the session's `sessions.describe` row (OpenClaw 2026.9.6, see
// convex/lib/sessionAccess.ts). Atrium shows them; the gateway enforces them. A value
// is only as fresh as the last describe (every send, every knob change, every sharing
// notice).
//
// Pure module (no React): every branch — including the parameterized messages — is
// unit-tested without a DOM (GC-P5 lesson).

import { m } from "@/paraglide/messages.js";
import {
  isSessionSharingRole,
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
