// The reply's blocks as a list to act on one — the touch-screen (and keyboard) way
// to "Reply to this block" and to "Bookmark this block", whose gutter buttons only
// ever show under a mouse. Opened from the reply's "More actions" menu; owned by
// the message, not by the menu's action bar, which may unmount the moment the
// pointer leaves the message.
import { useEffect, useRef, useState } from "react";
import { Bookmark } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { focusFirst } from "@/lib/focusFallback";
import { collectAnchorBlocks } from "./bookmarkView";
import {
  pickerFocusOrder,
  quoteBlockChoices,
  type PickerFocusCandidate,
  type QuoteBlockChoice,
} from "./quoteBlocks";

/** The reply's blocks, read from what is RENDERED (the gutter acts on the same). */
function readChoices(messageId: string): QuoteBlockChoice[] {
  const body = document.querySelector(
    `.oc-msg[data-message-id="${CSS.escape(messageId)}"] .oc-msg__body`,
  );
  if (body === null) return [];
  return quoteBlockChoices(
    collectAnchorBlocks(body).map((block) => block.textContent ?? ""),
  );
}

/** The candidates of `pickerFocusOrder` as they are on the page now: the reply's
 *  ⋯ (often a new one: the action bar unmounts when the pointer leaves the
 *  reply), the reply itself, the composer. */
function pickerCandidates(messageId: string, quotePicked: boolean): Array<HTMLElement | null> {
  const message = document.querySelector<HTMLElement>(
    `.oc-msg[data-message-id="${CSS.escape(messageId)}"]`,
  );
  const candidates: Record<PickerFocusCandidate, HTMLElement | null> = {
    composer: document.querySelector<HTMLElement>(".oc-composer__input"),
    trigger:
      message?.querySelector<HTMLElement>('.oc-msg__actions [aria-haspopup="menu"]') ?? null,
    message,
  };
  return pickerFocusOrder(quotePicked).map((c) => candidates[c]);
}

/** "quote": the pick goes on to the reply being written. "bookmark": the pick
 *  toggles the block's bookmark — a block already marked loses it. */
export type BlockPickerKind = "quote" | "bookmark";

const TEXT: Record<
  BlockPickerKind,
  { title: () => string; desc: () => string; empty: () => string }
> = {
  quote: {
    title: m.quote_reply_pick_title,
    desc: m.quote_reply_pick_desc,
    empty: m.quote_reply_pick_empty,
  },
  bookmark: {
    title: m.bookmark_pick_title,
    desc: m.bookmark_pick_desc,
    empty: m.bookmark_pick_empty,
  },
};

export function BlockPicker({
  open,
  onOpenChange,
  messageId,
  kind,
  marked,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string;
  kind: BlockPickerKind;
  /** The blocks already bookmarked (kind "bookmark"), by index: shown set. */
  marked?: ReadonlySet<number>;
  onPick: (blockIndex: number, excerpt: string) => void;
}) {
  const [choices, setChoices] = useState<QuoteBlockChoice[]>([]);
  const picked = useRef(false);
  useEffect(() => {
    if (open) {
      picked.current = false;
      setChoices(readChoices(messageId));
    }
  }, [open, messageId]);
  // A PICKED QUOTE GOES ON TO THE REPLY BEING WRITTEN: the composer takes the
  // focus as the pick's outcome, once the list has stopped trapping it (this
  // effect runs after Radix released its trap, in the same commit). As the list
  // then closes, the shared rule finds the focus placed and leaves it there; a
  // disabled composer takes nothing, and the rule's fallbacks follow.
  useEffect(() => {
    if (open || !picked.current || kind !== "quote") return;
    const [composer] = pickerCandidates(messageId, true);
    focusFirst([composer]);
  }, [open, kind, messageId]);
  const text = TEXT[kind];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="oc-blockpick"
        // Opened from the reply's ⋯ menu: the shared rule gives the focus back to
        // that ⋯ (the menu's trigger). It may be gone by then — the action bar
        // unmounts when the pointer leaves the reply —: the fallback of both
        // kinds follows, the reply's ⋯ as it is now, the reply, the composer.
        returnFocus={() => pickerCandidates(messageId, picked.current && kind === "quote")}
      >
        <DialogHeader>
          <DialogTitle>{text.title()}</DialogTitle>
          <DialogDescription>{text.desc()}</DialogDescription>
        </DialogHeader>
        {choices.length === 0 ? (
          <p className="oc-blockpick__empty">{text.empty()}</p>
        ) : (
          <div className="oc-blockpick__list">
            {choices.map((choice) => {
              const set = kind === "bookmark" && (marked?.has(choice.blockIndex) ?? false);
              return (
                <Button
                  key={choice.blockIndex}
                  type="button"
                  variant="ghost"
                  className="oc-blockpick__item h-auto w-full justify-start whitespace-normal text-left"
                  aria-pressed={kind === "bookmark" ? set : undefined}
                  onClick={() => {
                    picked.current = true;
                    onPick(choice.blockIndex, choice.excerpt);
                    onOpenChange(false);
                  }}
                >
                  {kind === "bookmark" ? (
                    <Bookmark
                      className={"oc-blockpick__mark" + (set ? " is-set" : "")}
                      aria-hidden
                    />
                  ) : null}
                  {choice.excerpt}
                </Button>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
