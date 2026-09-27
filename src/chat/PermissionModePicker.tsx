// The conversation's EXECUTION PERMISSIONS — the composer's picker ("composer") and
// the same choice in the header's "Advanced" popover ("section"). Every decision lives
// in permissionModeView.ts (pure, unit-tested); this file only renders it and sends the
// owner's pick to `permissionMode.setPermissionMode`.
//
// Mirrors the OpenClaw Control UI composer picker (upstream v2026.9.6
// chat-permission-picker.ts): the button shows the current mode's icon and name, the menu
// is titled "Execution permissions" with a "Learn more" link, five options (icon, title,
// one-line description, shortcut 1-5 while the menu is open), full access in alert red.

import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Check,
  ChevronDown,
  Lock,
  ShieldAlert,
  ShieldCheck,
  ShieldCog,
  ShieldEllipsis,
} from "lucide-react";
import { m } from "@/paraglide/messages.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import { useInstanceCapabilities } from "./useInstanceCapabilities";
import {
  PERMISSION_MODES_DOCS_URL,
  isPermissionChoice,
  permissionControlView,
  shortcutChoice,
  shouldSubmitChoice,
  type PermissionChoice,
  type PermissionControlView,
  type PermissionIcon,
  type PermissionTarget,
} from "./permissionModeView";

/** Upstream's `shieldLock` (a shield with a padlock): lucide has no such glyph. */
function ShieldLockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 9.807V6a1 1 0 0 0-1-1c-2 0-4.49-1.19-6.24-2.72a1.17 1.17 0 0 0-1.52 0C9.5 3.8 7 5 5 5a1 1 0 0 0-1 1v7c0 3.88 2.107 6.254 5 7.796" />
      <path d="M19 17v-2a2 2 0 0 0-4 0v2" />
      <rect x="13" y="17" width="8" height="5" rx="1" />
    </svg>
  );
}

function ModeIcon({ icon, size = 14 }: { icon: PermissionIcon; size?: number }): ReactNode {
  switch (icon) {
    case "ellipsis":
      return <ShieldEllipsis size={size} aria-hidden />;
    case "lock":
      return <ShieldLockIcon size={size} />;
    case "cog":
      return <ShieldCog size={size} aria-hidden />;
    case "alert":
      return <ShieldAlert size={size} aria-hidden />;
    default:
      return <ShieldCheck size={size} aria-hidden />;
  }
}

/** The data behind the picker, and the owner's pick. Null while nothing is known. */
function usePermissionControl(
  chatId: ConvexId<"chats">,
  routedAgent: { instanceName: string; agentId: string } | null,
  multiAgent: boolean,
): { view: PermissionControlView; choice: PermissionChoice | null; pick: (v: PermissionChoice) => void } | null {
  const ctl = useQuery(api.permissionMode.permissionControl, {
    chatId: chatId as Id<"chats">,
    ...(routedAgent ? { routedAgent } : {}),
  });
  const meta = useQuery(api.messages.getSessionMeta, { chatId: chatId as string });
  const caps = useInstanceCapabilities(chatId, routedAgent);
  const setMode = useMutation(api.permissionMode.setPermissionMode);
  const toast = useToast();
  const pickRaw = useCallback(
    (mode: PermissionChoice) => {
      void setMode({ chatId: chatId as Id<"chats">, mode }).catch((err: unknown) => {
        toast.error(m.chat_perm_failed({ reason: m.chat_perm_reason_other() }), err);
      });
    },
    [chatId, setMode, toast],
  );
  if (ctl == null) return null;
  // Where the next message goes: fail CLOSED while capabilities are unknown — a control
  // that appears only when the snapshot lands never flashes and then vanishes.
  const target: PermissionTarget = caps.loading || !caps.resolved
    ? "unknown"
    : caps.provider === "hermes"
      ? "hermes"
      : caps.can("permissionModes")
        ? "openclaw"
        : "unsupported";
  const sm = (meta?.sessionMeta ?? null) as {
    permissionMode?: string | null;
    permissionModePending?: boolean;
    sessionRoot?: string;
  } | null;
  const choice = isPermissionChoice(ctl.choice) ? ctl.choice : null;
  const view = permissionControlView({
    viewerRole: ctl.viewerRole,
    viewerIsAdmin: ctl.viewerIsAdmin,
    choice,
    apply: ctl.apply,
    sessionMode: sm?.permissionMode,
    sessionModePending: sm?.permissionModePending === true,
    sessionRoot: typeof sm?.sessionRoot === "string" ? sm.sessionRoot : null,
    agentDefault: ctl.agentDefault,
    target,
    multiAgent,
    managed: ctl.managed,
    anyManaged: ctl.anyManaged,
  });
  const pick = (value: PermissionChoice) => {
    if (shouldSubmitChoice(value, view, choice)) pickRaw(value);
  };
  return { view, choice, pick };
}

function OptionBody({ item }: { item: PermissionControlView["items"][number] }) {
  return (
    <>
      <span className="oc-perm__opt-icon" aria-hidden>
        <ModeIcon icon={item.icon} />
      </span>
      <span className="oc-perm__opt-copy">
        <span className="oc-perm__opt-title">{item.label}</span>
        <span className="oc-perm__opt-desc">{item.description}</span>
        {item.disabledReason !== null ? (
          <span className="oc-perm__opt-reason">{item.disabledReason}</span>
        ) : null}
      </span>
      <span className="oc-perm__opt-state" aria-hidden>
        {item.selected && item.disabledReason === null ? (
          <Check size={14} />
        ) : item.disabledReason !== null ? (
          <Lock size={13} />
        ) : (
          <span className="oc-perm__shortcut">{item.shortcut}</span>
        )}
      </span>
    </>
  );
}

function Heading() {
  return (
    <div className="oc-perm__heading">
      <span>{m.chat_perm_label()}</span>
      <a
        className="oc-perm__learn"
        href={PERMISSION_MODES_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        {m.chat_perm_learn_more()}
      </a>
    </div>
  );
}

/**
 * The composer's button + menu. Rendered for every reader (participants see the mode);
 * only the owner's items are enabled, `full` only for an Atrium administrator.
 */
export function PermissionModePicker({
  chatId,
  routedAgent,
  multiAgent,
}: {
  chatId: ConvexId<"chats">;
  /** The agent the next message goes to (null = the chat's own resolution). */
  routedAgent: { instanceName: string; agentId: string } | null;
  /** A per-turn routed conversation: the choice spans several agents. */
  multiAgent: boolean;
}) {
  const ctl = usePermissionControl(chatId, routedAgent, multiAgent);
  const [open, setOpen] = useState(false);
  if (ctl === null || ctl.view.hidden) return null;
  const { view, pick } = ctl;
  // Shortcuts only while the menu is OPEN (upstream handlePermissionPickerKeydown).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const value = shortcutChoice(e.key, view.items);
    if (value === null) return;
    e.preventDefault();
    e.stopPropagation();
    pick(value);
    setOpen(false);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`oc-composer__perm${view.alert ? " is-alert" : ""}${
            view.pending ? " is-pending" : ""
          }${ctl.choice === null ? " is-default" : ""}`}
          title={view.title}
          aria-label={view.ariaLabel}
          data-permission-mode={view.current}
        >
          <ModeIcon icon={view.icon} size={15} />
          <span className="oc-composer__perm-label">{view.label}</span>
          <ChevronDown size={13} aria-hidden className="oc-composer__perm-chev" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="oc-perm__menu w-80"
        onKeyDown={onKeyDown}
      >
        <Heading />
        {view.items.map((item) => (
          <DropdownMenuItem
            key={item.value}
            className={`oc-perm__opt${item.selected ? " is-selected" : ""}${
              item.value === "full" ? " is-full" : ""
            }`}
            role="menuitemradio"
            aria-checked={item.selected}
            aria-keyshortcuts={String(item.shortcut)}
            disabled={item.disabled}
            title={item.disabledReason ?? undefined}
            data-permission-option={item.value}
            onSelect={() => pick(item.value)}
          >
            <OptionBody item={item} />
          </DropdownMenuItem>
        ))}
        {view.status !== null ? (
          <p
            className={`oc-perm__status${view.statusIsError ? " is-error" : ""}`}
            role={view.statusIsError ? "alert" : "status"}
          >
            {view.status}
          </p>
        ) : null}
        {view.lockReason !== null ? <p className="oc-perm__note">{view.lockReason}</p> : null}
        {view.note !== null ? <p className="oc-perm__note">{view.note}</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The same choice inside the header's "Advanced" popover (owner-only surface): a radio
 * group, since a popover — unlike a menu — stays open while one adjusts it.
 */
export function PermissionModeSection({
  chatId,
  routedAgent,
  multiAgent,
}: {
  chatId: ConvexId<"chats">;
  routedAgent: { instanceName: string; agentId: string } | null;
  multiAgent: boolean;
}) {
  const ctl = usePermissionControl(chatId, routedAgent, multiAgent);
  if (ctl === null || ctl.view.hidden) return null;
  const { view, pick } = ctl;
  return (
    <section className="oc-perm__section" aria-label={m.chat_perm_label()} title={view.title}>
      <Heading />
      <div role="radiogroup" aria-label={m.chat_perm_label()} className="oc-perm__list">
        {view.items.map((item) => (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={item.selected}
            disabled={item.disabled}
            title={item.disabledReason ?? undefined}
            className={`oc-perm__opt${item.selected ? " is-selected" : ""}${
              item.value === "full" ? " is-full" : ""
            }`}
            data-permission-option={item.value}
            onClick={() => pick(item.value)}
          >
            <OptionBody item={item} />
          </button>
        ))}
      </div>
      {view.status !== null ? (
        <p
          className={`oc-perm__status${view.statusIsError ? " is-error" : ""}`}
          role={view.statusIsError ? "alert" : "status"}
        >
          {view.status}
        </p>
      ) : null}
      {view.lockReason !== null ? <p className="oc-perm__note">{view.lockReason}</p> : null}
      {view.note !== null ? <p className="oc-perm__note">{view.note}</p> : null}
    </section>
  );
}
