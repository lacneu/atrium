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

/** Gives the focus back when the list closes: to the first candidate, in the
 *  order of `pickerFocusOrder`, that really takes it (`focusFirst`). False when
 *  none did — the focus is then Radix's to place. */
function restoreFocus(messageId: string, quotePicked: boolean): boolean {
  const message = document.querySelector<HTMLElement>(
    `.oc-msg[data-message-id="${CSS.escape(messageId)}"]`,
  );
  const candidates: Record<PickerFocusCandidate, HTMLElement | null> = {
    composer: document.querySelector<HTMLElement>(".oc-composer__input"),
    trigger:
      message?.querySelector<HTMLElement>('.oc-msg__actions [aria-haspopup="menu"]') ?? null,
    message,
  };
  return focusFirst(pickerFocusOrder(quotePicked).map((c) => candidates[c])) !== null;
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
  const text = TEXT[kind];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="oc-blockpick"
        // Opened from a menu, not from a trigger of its own: Radix would hand the
        // focus back to the page. Both kinds give it back by the same fallback —
        // the reply's ⋯, the reply itself, then the composer —, a picked quote
        // asking the composer first (`pickerFocusOrder`).
        onCloseAutoFocus={(e) => {
          if (restoreFocus(messageId, picked.current && kind === "quote")) e.preventDefault();
        }}
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
