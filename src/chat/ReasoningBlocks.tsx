import { useRef, type RefObject } from "react";
import { useQuery } from "convex/react";
import { m } from "@/paraglide/messages.js";
import { AgentMarkdown } from "./MarkdownText";
import { lastRead, readWhileNear, useNearViewport } from "./nearViewport";
import { useWorkZone } from "./WorkZone";
import { noteShown, thoughtShown, type WorkZoneMark } from "./workZoneView";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// THE TWO KINDS OF PROSE THAT ARE NOT THE ANSWER (0.103.0). With the activity groups
// (InlineTurnActivity) they are the turn's WORK, threaded on one rail (`oc-work`,
// convexChat.css) and told apart by their writing alone:
//   - ThinkingBlock: the MODEL'S reasoning — bare muted text, with no icon, label or
//     chevron of its own: its ZONE is headed once and folds as a whole (WorkZone.tsx). On
//     view by default wherever reasoning is shown (it reaches the view only then,
//     convex/lib/reasoningDisplay.ts);
//   - CommentaryNote: the AGENT'S work notes between its actions — the same quiet prose
//     behind a dot on the rail (the Control UI keeps them on view by default, "Keep
//     commentary").
// Both wrappers carry `oc-msg__meta`: bookmarks and quote-reply count the reply's own blocks
// only (bookmarkView.ts `collectAnchorBlocks`), so a reasoning that appears never moves a
// bookmark of the answer.

type ThinkingData = {
  key: string;
  /** Being written: the bubble runs and no answer follows it yet (`settleThinkingBlocks`). */
  live: boolean;
  /** The reasoning itself (Hermes'), `capped` when only its first part was kept… */
  text?: string;
  capped?: boolean;
  /** …or the row that carries it: read by the block while it is on view, never carried
   *  by the window itself (convex/messages.ts `getRowReasoning`). */
  row?: { messageId: string; entryId: string };
  zone?: WorkZoneMark;
};

/** The model's reasoning: muted text on the rail, on view unless the reader folded its zone. */
export function ThinkingBlock({ data }: { data?: ThinkingData }) {
  const row = data?.row;
  const capped = data?.capped === true;
  const text = (data?.text ?? "").trim();
  const { header, folded } = useWorkZone(data?.zone);
  const block = useRef<HTMLDivElement>(null);
  if (!thoughtShown(data)) return null;
  return (
    <>
      {header}
      {folded ? null : (
        <div ref={block} className="oc-msg__meta oc-work oc-thinking" role="region" aria-label={m.reasoning_region_aria()}>
          {row !== undefined ? <RowReasoning block={block} messageId={row.messageId} entryId={row.entryId} /> : text !== "" ? <AgentMarkdown text={text} /> : null}
          {capped ? <p className="oc-thinking__status">{m.reasoning_capped()}</p> : null}
        </div>
      )}
    </>
  );
}

/** A row's reasoning, read from the row while its block is near what the reader sees
 *  (nearViewport.ts) — so a corrected reasoning is the one shown, and neither a folded zone
 *  nor a block far off screen costs a read. Once read, its text stays shown: leaving the
 *  neighbourhood releases the subscription, never the block's height. */
function RowReasoning({ block, messageId, entryId }: { block: RefObject<Element | null>; messageId: string; entryId: string }) {
  const near = useNearViewport(block);
  const read = useQuery(api.messages.getRowReasoning, readWhileNear(near, { messageId: messageId as Id<"messages">, entryId }));
  const kept = useRef<typeof read>(undefined);
  const result = lastRead(read, kept.current);
  kept.current = result;
  // One quiet line for a block never read — not near yet, or being read: the same line, so
  // nearing it moves nothing before its text is there.
  if (result === undefined) return <p className="oc-thinking__status" data-reasoning="unread">{m.reasoning_loading()}</p>;
  if (result === null) return <p className="oc-thinking__status">{m.reasoning_unavailable()}</p>;
  return (
    <>
      <AgentMarkdown text={result.text} />
      {/* The gateway served only its first part, and the full row could not be read. */}
      {result.truncated === true ? <p className="oc-thinking__status">{m.reasoning_capped()}</p> : null}
    </>
  );
}

/** The agent's work note: quieter prose on the rail, in its place between the agent's actions. */
export function CommentaryNote({ data }: { data?: { key: string; text: string; capped?: boolean; zone?: WorkZoneMark } }) {
  const text = (data?.text ?? "").trim();
  const { header, folded } = useWorkZone(data?.zone);
  if (!noteShown(data?.text)) return null;
  return (
    <>
      {header}
      {folded ? null : (
        <div className="oc-msg__meta oc-work oc-msg__note" role="note" aria-label={m.commentary_note_aria()}>
          <AgentMarkdown text={text} />
          {data?.capped === true ? <p className="oc-thinking__status">{m.chat_text_capped()}</p> : null}
        </div>
      )}
    </>
  );
}
