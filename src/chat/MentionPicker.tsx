// Naming somebody in a group conversation, from the composer.
//
// A BUTTON AND A LIST, not an "@"-triggered autocomplete. The composer is a rich
// text surface whose caret this component does not own, and an autocomplete that
// mis-reads the caret inserts the name in the wrong place — a mention whose
// offsets do not match what was sent is refused by the gateway for the whole
// message, not just the mention. A button appends "@Name " at the end, which is
// where a writer is anyway, and the writer can then move it wherever they like:
// the span is located at SEND time, not now (see pendingMention).
//
// The button is absent on a solo conversation. There is nobody to name, and an
// affordance that opens an empty list is a promise the room cannot keep.

import { useComposerRuntime } from "@assistant-ui/react";
import { useQuery } from "convex/react";
import { AtSign } from "lucide-react";
import { useState } from "react";

import { api } from "./convexApi";
import type { Id } from "../../convex/_generated/dataModel";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { m } from "../paraglide/messages";
import { stagePendingMention } from "./pendingMention";

import "./chatParticipants.css";

/**
 * The token inserted for a person, and the key their mention is staged under.
 *
 * Display names are not unique and may contain spaces, so the token is the name
 * with its inner whitespace collapsed to a dot — stable, readable, and a single
 * word the writer can delete in one gesture. Uniqueness across the room is not
 * required: two identical tokens resolve to two different occurrences at send
 * time, and the staged list is keyed by user id regardless.
 */
export function mentionTokenFor(name: string): string {
  const slug = name.trim().replace(/\s+/g, ".");
  return `@${slug.length > 0 ? slug : "?"}`;
}

export function MentionPicker({ chatId }: { chatId: Id<"chats"> }) {
  const [open, setOpen] = useState(false);
  const composer = useComposerRuntime();
  const members = useQuery(api.chatParticipants.listMembers, { chatId });
  const roster = members ?? [];
  // Everyone in the room except the person writing: naming yourself notifies
  // nobody (the send path skips it), so offering it would be a dead choice.
  const others = roster.filter((r) => !r.isSelf);

  if (others.length === 0) return null;

  const insert = (name: string, userId: Id<"users">) => {
    const token = mentionTokenFor(name);
    const current = composer.getState().text;
    const separator = current.length === 0 || current.endsWith(" ") ? "" : " ";
    composer.setText(`${current}${separator}${token} `);
    stagePendingMention(String(chatId), { userId: String(userId), token });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="oc-chip oc-chip--btn"
          title={m.mention_pick()}
          aria-label={m.mention_pick()}
        >
          <AtSign size={13} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="oc-participants">
        <div className="oc-participants__head">{m.mention_pick()}</div>
        <ul className="oc-participants__list">
          {others.map((r) => (
            <li key={String(r.userId)}>
              <button
                type="button"
                className="oc-participants__row oc-participants__pick"
                onClick={() => insert(r.name, r.userId)}
              >
                <span className="oc-participants__who">
                  <span className="oc-participants__name">{r.name}</span>
                  <span className="oc-participants__role">
                    {mentionTokenFor(r.name)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
