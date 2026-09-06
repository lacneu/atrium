// The people in a conversation — shown in the chat header, managed from there.
//
// A chat starts with one person and becomes a group the moment someone is added:
// no separate "group chat" object, no second creation flow. The chip is therefore
// present on every chat, and it says something useful in both states — "seul" for a
// solo conversation, the roster otherwise.
//
// WHO SEES WHAT. Everyone in the room reads the roster. Only the owner adds and
// removes; a participant gets one action, "quitter". That mirrors the Convex rules
// exactly (see convex/lib/chatAccess.ts) rather than guessing them client-side —
// the server refuses either way, and a button that always fails is worse than no
// button.

import { useMutation, useQuery } from "convex/react";
import { Users, UserPlus, LogOut, X } from "lucide-react";
import { useState } from "react";

import { api } from "./convexApi";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { m } from "../paraglide/messages";

import "./chatParticipants.css";

/** Two letters at most, from a display name — never an image request. */
export function initialsOf(name: string): string {
  const parts = name
    .split(/[\s._-]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/**
 * A stable colour per person, so the same face keeps the same badge across
 * conversations. Derived from the id, not from the name: renaming somebody must
 * not repaint them.
 */
export function avatarToneOf(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i += 1) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return h % 8;
}

function Avatar({ userId, name }: { userId: string; name: string }) {
  return (
    <span
      className="oc-avatar"
      data-tone={avatarToneOf(userId)}
      title={name}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  );
}

export function ChatParticipants({
  chatId,
  viewerRole,
  compact = false,
  ghost = false,
}: {
  // The header holds the id as the route's own branded type; both erase to the
  // same string, and the queries below take it verbatim.
  chatId: Id<"chats">;
  /** From getSessionMeta — absent while the meta is still loading. */
  viewerRole?: "owner" | "participant";
  compact?: boolean;
  ghost?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const members = useQuery(api.chatParticipants.listMembers, { chatId });
  // The candidate list is the owner's tool: for a participant the server returns
  // an empty array, so this subscription costs them nothing.
  const invitable = useQuery(
    api.chatParticipants.listInvitable,
    open && viewerRole === "owner" ? { chatId } : "skip",
  );
  const addMember = useMutation(api.chatParticipants.addMember);
  const removeMember = useMutation(api.chatParticipants.removeMember);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roster = members ?? [];
  const others = roster.filter((r) => r.role === "participant");
  const isOwner = viewerRole === "owner";

  // Shared by the real trigger and the ghost stand-in, so the header's width
  // measurement can never drift from what is actually rendered.
  const inner = (
    <>
      <Users size={13} aria-hidden />
      {!compact ? (
        <span className="oc-chip__label">
          {/* The count is only shown when somebody else is here, so it is never
              1 and the plural always reads correctly. */}
          {others.length === 0
            ? m.participants_solo()
            : m.participants_count({ count: others.length + 1 })}
        </span>
      ) : null}
      {others.length > 0 ? (
        <span className="oc-avatars">
          {roster.slice(0, 3).map((r) => (
            <Avatar key={String(r.userId)} userId={String(r.userId)} name={r.name} />
          ))}
          {roster.length > 3 ? (
            <span className="oc-avatar oc-avatar--more" aria-hidden>
              +{roster.length - 3}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );

  if (ghost) return <span className="oc-chip oc-chip--btn">{inner}</span>;

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      // The server is the authority on every one of these rules. It answers with a
      // CODE for the refusals a person can act on, which is what gets localized
      // here; anything else is an internal failure and is shown as one rather than
      // leaking an English exception into a French panel.
      const raw = err instanceof Error ? err.message : String(err);
      const limit = /participants_limit:(\d+)/.exec(raw);
      setError(
        limit !== null
          ? m.participants_limit({ count: Number(limit[1]) })
          : m.participants_failed(),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="oc-chip oc-chip--btn"
          title={m.participants_title()}
        >
          {inner}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="oc-participants">
        <div className="oc-participants__head">{m.participants_title()}</div>
        <ul className="oc-participants__list">
          {roster.map((r) => (
            <li key={String(r.userId)} className="oc-participants__row">
              <Avatar userId={String(r.userId)} name={r.name} />
              <span className="oc-participants__who">
                <span className="oc-participants__name">{r.name}</span>
                <span className="oc-participants__role">
                  {r.role === "owner"
                    ? m.participants_role_owner()
                    : m.participants_role_member()}
                </span>
              </span>
              {isOwner && r.role === "participant" ? (
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  title={m.participants_remove()}
                  onClick={() =>
                    void act(() => removeMember({ chatId, memberId: r.userId }))
                  }
                >
                  <X size={14} aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>

        {isOwner ? (
          <div className="oc-participants__add">
            <div className="oc-participants__head">{m.participants_add()}</div>
            {invitable === undefined ? (
              <p className="oc-participants__hint">{m.participants_loading()}</p>
            ) : invitable.length === 0 ? (
              <p className="oc-participants__hint">{m.participants_nobody()}</p>
            ) : (
              <ul className="oc-participants__list">
                {invitable.map((c) => (
                  <li key={String(c.userId)} className="oc-participants__row">
                    <Avatar userId={String(c.userId)} name={c.name} />
                    <span className="oc-participants__who">
                      <span className="oc-participants__name">{c.name}</span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      title={m.participants_add()}
                      onClick={() =>
                        void act(() => addMember({ chatId, memberId: c.userId }))
                      }
                    >
                      <UserPlus size={14} aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : viewerRole === "participant" ? (
          <div className="oc-participants__add">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  // MY row, not the first participant row — leaving must never
                  // remove somebody else who happens to be listed above me.
                  const me = roster.find((r) => r.isSelf);
                  if (me === undefined) return;
                  await removeMember({ chatId, memberId: me.userId });
                })
              }
            >
              <LogOut size={14} aria-hidden />
              {m.participants_leave()}
            </Button>
          </div>
        ) : null}

        {error !== null ? (
          <p className="oc-participants__error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="oc-participants__note">{m.participants_note()}</p>
      </PopoverContent>
    </Popover>
  );
}
