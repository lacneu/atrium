// The reply's blocks as a list to act on one — the touch-screen (and keyboard) way
// to "Reply to this block" and to "Bookmark this block", whose gutter buttons only
// ever show under a mouse. Opened from the reply's "More actions" menu; owned by
// the message, not by the menu's action bar, which may unmount the moment the
// pointer leaves the message.
//
// A delegation's answer reads as ONE answer across consecutive bubbles, and only
// its last bubble has a ⋯ (lot 21): the list then holds the blocks of every bubble
// of the answer, in reading order — the order a screen reader reads them too —,
// each row naming its own bubble, so a pick quotes or marks THAT bubble's block.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { liveStatus, windowSchedule } from "@/lib/liveStatus";
import { blockFace, collectAnchorBlocks, type BlockFace } from "./bookmarkView";
import {
  blockChoices,
  blockKey,
  pickerFocusOrder,
  pickTarget,
  type BlockChoice,
  type BlockListKind,
  type PickerFocusCandidate,
} from "./quoteBlocks";

/** A bubble's blocks as it is RENDERED now — what the gutter acts on, through the same
 *  `blockOffer` —, or null when the bubble is gone. */
function facesOf(messageId: string): BlockFace[] | null {
  const body = document.querySelector(
    `.oc-msg[data-message-id="${CSS.escape(messageId)}"] .oc-msg__body`,
  );
  return body === null ? null : collectAnchorBlocks(body).map(blockFace);
}

/** The list of the bubbles listed, and what each bubble showed when it was read: what
 *  a pick is checked against (lot 22). */
function readChoices(sources: readonly string[], kind: BlockListKind): {
  choices: BlockChoice[];
  seen: Map<string, string[]>;
} {
  const bubbles = sources.map((messageId) => ({ messageId, faces: facesOf(messageId) ?? [] }));
  return {
    choices: blockChoices(bubbles, kind),
    seen: new Map(bubbles.map((b) => [b.messageId, b.faces.map((face) => face.print)])),
  };
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
export type BlockPickerKind = BlockListKind;

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
  sources,
  kind,
  marked,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The reply whose ⋯ opens the list: where the focus goes back. */
  messageId: string;
  /** The bubbles whose blocks the list holds, in reading order (`listSources`). */
  sources: readonly string[];
  kind: BlockPickerKind;
  /** The blocks already bookmarked (kind "bookmark"), by `blockKey`: shown set. */
  marked?: ReadonlySet<string>;
  onPick: (choice: BlockChoice) => void;
}) {
  const [choices, setChoices] = useState<BlockChoice[]>([]);
  // What each bubble showed when the list was read; and the status a refused pick
  // says — the list was then read again (lot 22). The status region is on the page,
  // empty, from the list's opening, and every refusal is announced anew (lot 23).
  const seen = useRef(new Map<string, string[]>());
  const [status, setStatus] = useState("");
  const announcer = useMemo(() => liveStatus(setStatus, windowSchedule), []);
  useEffect(() => () => announcer.clear(), [announcer]);
  const picked = useRef(false);
  const sourceKey = sources.join(" ");
  const read = useCallback(() => {
    const list = readChoices(sourceKey === "" ? [] : sourceKey.split(" "), kind);
    seen.current = list.seen;
    setChoices(list.choices);
  }, [sourceKey, kind]);
  useEffect(() => {
    announcer.clear();
    if (open) {
      picked.current = false;
      read();
    }
  }, [open, read, announcer]);
  // A PICK ACTS ON THE BLOCK THE PERSON CHOSE, OR ON NOTHING (lot 22): the bubble can
  // change while the list is open — a delegated result inserted before its conclusion,
  // a block gone, the reply regenerated —, so the chosen block is found again by what
  // it showed, exactly — and elsewhere only if nothing else showed the same (lot 23,
  // `resolveChosen`). Found: the action takes its index now. Gone, ambiguous, or a
  // bookmark whose state is no longer the one the row showed: nothing is done, the list
  // is read again and says why.
  const pick = (choice: BlockChoice) => {
    const at = pickTarget(
      choice,
      kind,
      seen.current.get(choice.messageId) ?? null,
      facesOf(choice.messageId)?.map((face) => face.print) ?? null,
      marked,
    );
    if (at === null) {
      read();
      announcer.say(m.block_pick_changed());
      return;
    }
    picked.current = true;
    onPick({ ...choice, blockIndex: at });
    onOpenChange(false);
  };
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
        <p className="oc-blockpick__changed" role="status">
          {status}
        </p>
        {choices.length === 0 ? (
          <p className="oc-blockpick__empty">{text.empty()}</p>
        ) : (
          <div className="oc-blockpick__list">
            {choices.map((choice) => {
              const set =
                kind === "bookmark" &&
                (marked?.has(blockKey(choice.messageId, choice.blockIndex)) ?? false);
              return (
                <Button
                  key={blockKey(choice.messageId, choice.blockIndex)}
                  type="button"
                  variant="ghost"
                  className="oc-blockpick__item h-auto w-full justify-start whitespace-normal text-left"
                  data-message-id={choice.messageId}
                  data-block-index={choice.blockIndex}
                  aria-pressed={kind === "bookmark" ? set : undefined}
                  onClick={() => pick(choice)}
                >
                  {kind === "bookmark" ? (
                    <Bookmark
                      className={"oc-blockpick__mark" + (set ? " is-set" : "")}
                      aria-hidden
                    />
                  ) : null}
                  {choice.label !== "" ? choice.label : m.block_pick_media_untitled()}
                </Button>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
