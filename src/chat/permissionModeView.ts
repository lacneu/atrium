// THE CONVERSATION'S EXECUTION PERMISSIONS — the composer's picker and the "Advanced"
// section, decided here and only rendered by React.
//
// Mirrors the OpenClaw Control UI composer picker (upstream v2026.9.6
// ui/src/pages/chat/components/chat-permission-picker.ts): five options in a fixed order
// with the shortcuts 1-5, "Default (<agent's mode>)" when the agent's configured mode is
// known, the full-access alert, the docs link. Atrium's own rules (convex/permissionMode.ts):
// only the conversation OWNER chooses, `full` only as an Atrium administrator, Hermes has
// no modes, and the choice belongs to the CONVERSATION — every OpenClaw session it uses
// gets it before its first turn.
//
// Pure module (no React): every branch — parameterized messages included — is unit-tested
// without a DOM (GC-P5 lesson).

import { m } from "@/paraglide/messages.js";
import {
  isSessionPermissionMode,
  type SessionPermissionMode,
} from "../../convex/lib/sessionAccess";

/** The upstream picker's own link (chat-permission-picker.ts:11). */
export const PERMISSION_MODES_DOCS_URL = "https://docs.openclaw.ai/gateway/permission-modes";

/** The five options, in the upstream order — which is also their shortcut (1-5). */
export const PERMISSION_CHOICES = [
  "default",
  "read-only",
  "guarded",
  "workspace",
  "full",
] as const;
export type PermissionChoice = (typeof PERMISSION_CHOICES)[number];

export function isPermissionChoice(v: unknown): v is PermissionChoice {
  return typeof v === "string" && (PERMISSION_CHOICES as readonly string[]).includes(v);
}

/** Which icon a choice carries (upstream modeIcon): the default and the four modes. */
export type PermissionIcon = "check" | "ellipsis" | "lock" | "cog" | "alert";

export function permissionIcon(choice: PermissionChoice): PermissionIcon {
  switch (choice) {
    case "read-only":
      return "ellipsis";
    case "guarded":
      return "lock";
    case "workspace":
      return "cog";
    case "full":
      return "alert";
    default:
      return "check";
  }
}

export function permissionModeLabel(mode: SessionPermissionMode): string {
  switch (mode) {
    case "read-only":
      return m.chat_perm_mode_read_only();
    case "guarded":
      return m.chat_perm_mode_guarded();
    case "workspace":
      return m.chat_perm_mode_workspace();
    case "full":
      return m.chat_perm_mode_full();
  }
}

function modeDescription(mode: SessionPermissionMode): string {
  switch (mode) {
    case "read-only":
      return m.chat_perm_mode_read_only_desc();
    case "guarded":
      return m.chat_perm_mode_guarded_desc();
    case "workspace":
      return m.chat_perm_mode_workspace_desc();
    case "full":
      return m.chat_perm_mode_full_desc();
  }
}

/** A choice's name: "Default (Full Access)" when the agent's mode is known (upstream
 *  modeLabel), else plain "Default". */
export function choiceLabel(
  choice: PermissionChoice,
  agentDefault: SessionPermissionMode | null,
): string {
  if (choice !== "default") return permissionModeLabel(choice);
  return agentDefault === null
    ? m.chat_perm_default()
    : m.chat_perm_default_with_mode({ mode: permissionModeLabel(agentDefault) });
}

/** Where the next message goes, as far as permissions are concerned. */
export type PermissionTarget =
  | "openclaw" // a gateway that has modes
  | "unsupported" // an OpenClaw gateway older than the modes
  | "hermes" // no modes at all
  | "unknown"; // capabilities not resolved yet

/** The failure vocabulary the bridge and Convex record (closed; anything else reads
 *  as a generic refusal — never raw gateway prose). */
function reasonText(reason: string | undefined): string {
  switch (reason) {
    case "scope_refused":
      return m.chat_perm_reason_scope_refused();
    case "active_run":
      return m.chat_perm_reason_active_run();
    case "unsupported_gateway":
      return m.chat_perm_reason_unsupported_gateway();
    case "full_not_authorized":
      return m.chat_perm_reason_full_not_authorized();
    case "session_not_established":
      return m.chat_perm_reason_session_not_established();
    case "bridge_unreachable":
      return m.chat_perm_reason_bridge_unreachable();
    case "no_agent":
      return m.chat_perm_reason_no_agent();
    case "not_managed":
      return m.chat_perm_reason_not_managed();
    case "reapply_exhausted":
      return m.chat_perm_reason_reapply_exhausted();
    default:
      return m.chat_perm_reason_other();
  }
}

export type PermissionControlInput = {
  /** The reader's standing (undefined while loading). */
  viewerRole: "owner" | "participant" | undefined;
  viewerIsAdmin: boolean;
  /** The owner's stored choice (null = never chosen). */
  choice: PermissionChoice | null;
  /** The last on-the-spot apply of a choice. */
  apply: { mode: string; status: string; reason?: string } | null;
  /** What the described session holds (`null` none, undefined not reported). */
  sessionMode: string | null | undefined;
  sessionModePending: boolean;
  sessionRoot: string | null;
  /** The next target agent's configured mode, when stated. */
  agentDefault: string | null;
  target: PermissionTarget;
  /** A per-turn routed conversation (several agents may answer). */
  multiAgent: boolean;
  /** Atrium manages permissions on the instance the next message goes to
   *  (`instances.managePermissionModes`)… */
  managed: boolean;
  /** …and on at least one OpenClaw instance of the conversation. */
  anyManaged: boolean;
};

export type PermissionItemView = {
  value: PermissionChoice;
  label: string;
  description: string;
  icon: PermissionIcon;
  /** 1-5, the upstream order. */
  shortcut: number;
  selected: boolean;
  disabled: boolean;
  /** Why this item cannot be picked, when disabled for a reason of its own. */
  disabledReason: string | null;
};

export type PermissionControlView = {
  /** Nothing to show (a Hermes-only conversation with no choice, capabilities loading). */
  hidden: boolean;
  /** What the button shows. */
  current: PermissionChoice;
  label: string;
  icon: PermissionIcon;
  /** Full access is in force (chosen, or the default resolving to it). */
  alert: boolean;
  /** A change is being applied — the menu takes no other choice meanwhile. */
  pending: boolean;
  /** The whole menu is read-only for this reader / this target. */
  locked: boolean;
  /** Why it is read-only (owner only, a gateway without modes, Hermes), or null. */
  lockReason: string | null;
  /** A standing note shown under the options (the next message goes to Hermes, a
   *  change is being applied), or null. */
  note: string | null;
  /** Short state line under the options (a failure, a deferral), or null. */
  status: string | null;
  /** The status is a failure (rendered as such). */
  statusIsError: boolean;
  /** The button's tooltip. */
  title: string;
  ariaLabel: string;
  items: PermissionItemView[];
};

/**
 * The picker, from what Convex and the gateway say. The CURRENT value is the owner's
 * choice when there is one (the conversation's property — the bridge applies it before
 * each turn), else what the described session holds.
 */
export function permissionControlView(input: PermissionControlInput): PermissionControlView {
  const agentDefault = isSessionPermissionMode(input.agentDefault) ? input.agentDefault : null;
  const described: PermissionChoice =
    isSessionPermissionMode(input.sessionMode) ? input.sessionMode : "default";
  // Where Atrium manages permissions, the conversation's choice IS the mode (absent =
  // "default", enforced before every turn). Elsewhere the gateway's operator decides:
  // what the session holds is shown, whatever was chosen.
  const current: PermissionChoice = input.managed ? (input.choice ?? "default") : described;
  const label = choiceLabel(current, agentDefault);
  const alert = current === "full" || (current === "default" && agentDefault === "full");
  const isOwner = input.viewerRole === "owner";

  // Hidden only when there is genuinely nothing to show. While capabilities are not
  // resolved the control STAYS, read-only: the header chip is gone, and the next send
  // may still carry the mode the reader was shown as its guard — so it must be shown.
  const hidden =
    input.viewerRole === undefined ||
    // A conversation that only ever talks to Hermes, where nobody chose anything: a
    // control that can never do anything is noise.
    (input.target === "hermes" && !input.multiAgent && input.choice === null) ||
    // Capabilities unknown AND nothing described nor chosen (a Hermes chat has no mode
    // in its meta): nothing to show yet.
    (input.target === "unknown" &&
      input.choice === null &&
      !isSessionPermissionMode(input.sessionMode) &&
      input.sessionMode !== null);

  const applying =
    input.choice !== null &&
    input.apply !== null &&
    input.apply.mode === input.choice &&
    input.apply.status === "pending";
  const pending = applying || input.sessionModePending;

  // Why the WHOLE menu is read-only, most decisive first.
  let lockReason: string | null = null;
  if (!input.anyManaged) lockReason = m.chat_perm_operator_managed();
  else if (!isOwner) lockReason = m.chat_perm_owner_only();
  else if (input.target === "unknown") lockReason = m.chat_perm_checking();
  else if (input.target === "unsupported") lockReason = m.chat_perm_unsupported();
  else if (input.target === "hermes" && !input.multiAgent) lockReason = m.chat_perm_hermes();
  const locked = lockReason !== null;

  const items: PermissionItemView[] = PERMISSION_CHOICES.map((value, index) => {
    const fullLocked = value === "full" && !input.viewerIsAdmin;
    return {
      value,
      label: choiceLabel(value, agentDefault),
      description:
        value === "default" ? m.chat_perm_default_desc() : modeDescription(value),
      icon: permissionIcon(value),
      shortcut: index + 1,
      selected: value === current,
      disabled: locked || pending || fullLocked,
      disabledReason: fullLocked ? m.chat_perm_full_requires_admin() : null,
    };
  });

  let status: string | null = null;
  let statusIsError = false;
  if (isOwner && input.choice === "full" && !input.viewerIsAdmin) {
    status = m.chat_perm_full_revoked();
    statusIsError = true;
  } else if (
    input.choice !== null &&
    input.apply !== null &&
    input.apply.mode === input.choice
  ) {
    if (input.apply.status === "failed") {
      status = m.chat_perm_failed({ reason: reasonText(input.apply.reason) });
      statusIsError = true;
    } else if (input.apply.status === "deferred") {
      status = m.chat_perm_deferred();
    } else if (input.apply.status === "applied" && input.apply.reason === "saved_not_applied") {
      status = m.chat_perm_saved_not_applied();
    }
  }

  const lines = [`${m.chat_perm_label()}: ${label}`];
  lines.push(lockReason ?? m.chat_perm_help());
  if (input.multiAgent) lines.push(m.chat_perm_conversation_note());
  if (input.target === "hermes" && input.multiAgent) lines.push(m.chat_perm_next_hermes());
  if (input.anyManaged && !input.managed && input.target !== "hermes") {
    lines.push(m.chat_perm_next_not_managed());
  }
  if (alert) lines.push(m.chat_perm_full_warning());
  if (pending) lines.push(m.chat_perm_pending());
  if (status !== null) lines.push(status);
  if (input.sessionRoot) lines.push(m.chat_perm_root({ root: input.sessionRoot }));

  const note = pending
    ? m.chat_perm_pending()
    : input.target === "hermes" && input.multiAgent
      ? m.chat_perm_next_hermes()
      : input.anyManaged && !input.managed && input.target !== "hermes"
        ? m.chat_perm_next_not_managed()
        : null;

  return {
    hidden,
    current,
    label,
    icon: permissionIcon(current),
    alert,
    pending,
    locked,
    lockReason,
    note,
    status,
    statusIsError,
    title: lines.join("\n"),
    ariaLabel: m.chat_perm_button_aria({ label: m.chat_perm_label(), mode: label }),
    items,
  };
}

/**
 * The option a digit picks while the menu is OPEN (upstream handlePermissionPickerKeydown:
 * `1`-`5`, only when that option is enabled). Null for anything else — the key is then
 * left to the menu.
 */
export function shortcutChoice(
  key: string,
  items: readonly PermissionItemView[],
): PermissionChoice | null {
  if (!/^[1-5]$/.test(key)) return null;
  const item = items.find((i) => i.shortcut === Number(key));
  return item && !item.disabled ? item.value : null;
}

/** Whether picking `value` should reach the server: an enabled option that is not
 *  already the stored choice (upstream: `mode !== (params.mode ?? null)`). A mode changed
 *  behind Atrium's back needs no re-pick: the bridge restores the choice before the next
 *  turn. */
export function shouldSubmitChoice(
  value: PermissionChoice,
  view: Pick<PermissionControlView, "items">,
  storedChoice: PermissionChoice | null,
): boolean {
  const item = view.items.find((i) => i.value === value);
  if (!item || item.disabled) return false;
  return value !== storedChoice;
}
