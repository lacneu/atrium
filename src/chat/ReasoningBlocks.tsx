import { useId, useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { useQuery } from "convex/react";
import { Brain } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { ActivityRow } from "./ActivityRow";
import { AgentMarkdown } from "./MarkdownText";
import { thinkingTitle } from "./reasoningView";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// THE TWO KINDS OF PROSE THAT ARE NOT THE ANSWER (0.103.0), each with its own look so a
// reader tells them from the reply and from each other:
//   - ThinkingBlock: the MODEL'S reasoning — a "Reflexion" disclosure (Thinking) in the bubble, open
//     while it is the latest thing written and no answer follows it, folded as soon as the
//     answer begins (convertMessage.ts `settleThinkingBlocks`); muted, with a rule on its
//     left. The Control UI shows the same text above the row it belongs to
//     (ui/src/pages/chat/components/chat-message-bubble.ts:579-588 at v2026.9.33);
//   - CommentaryNote: the AGENT'S work notes between its actions — normal prose, quieter
//     than the answer, never folded (the Control UI keeps them on view by default,
//     "Keep commentary").
// Both wrappers carry `oc-msg__meta`: bookmarks and quote-reply count the reply's own blocks
// only (bookmarkView.ts `collectAnchorBlocks`), so a reasoning that appears never moves a
// bookmark of the answer.

type ThinkingData = {
  key: string;
  open: boolean;
  /** The reasoning itself (Hermes'), `capped` when only its first part was kept… */
  text?: string;
  capped?: boolean;
  /** …or the row that carries it: read when the block is open, never with the window
   *  (convex/messages.ts `getRowReasoning`). */
  row?: { messageId: string; entryId: string };
};

/** The model's reasoning: a disclosure (shared ActivityRow chrome) over the muted text. */
export function ThinkingBlock({ data }: { data?: ThinkingData }) {
  const row = data?.row;
  const capped = data?.capped === true;
  const text = (data?.text ?? "").trim();
  const autoOpen = data?.open === true;
  // The reader's own choice wins over the automatic one, for this block, until it remounts.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? autoOpen;
  const bodyId = useId();
  const facts = useMessage((msg) => {
    const custom = msg.metadata?.custom as
      | { generationMs?: number | null; allToolParts?: unknown[]; status?: string }
      | undefined;
    return `${custom?.status ?? ""}|${custom?.generationMs ?? ""}|${(custom?.allToolParts ?? []).length}`;
  });
  if (row === undefined && text === "" && !capped) return null;
  const [status, generationMs, toolCount] = facts.split("|");
  const title = thinkingTitle({
    writing: autoOpen && status === "streaming",
    generationMs: generationMs === "" ? null : Number(generationMs),
    hasToolActivity: Number(toolCount) > 0,
  });
  return (
    <div className="oc-msg__meta oc-thinking" data-open={open ? "true" : "false"}>
      <ActivityRow
        icon={<Brain size={14} />}
        label={title}
        open={open}
        ariaExpanded={open}
        ariaControls={open ? bodyId : undefined}
        title={open ? m.reasoning_collapse() : m.reasoning_expand()}
        onClick={() => setChosen(!open)}
      />
      {open ? (
        <div id={bodyId} className="oc-thinking__body" role="region" aria-label={m.reasoning_region_aria()}>
          {row !== undefined ? <RowReasoning messageId={row.messageId} entryId={row.entryId} /> : text !== "" ? <AgentMarkdown text={text} /> : null}
          {capped ? <p className="oc-thinking__status">{m.reasoning_capped()}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A row's reasoning, read from the row while its block is open — so a corrected reasoning
 *  is the one shown, and a window of them is never read at once. */
function RowReasoning({ messageId, entryId }: { messageId: string; entryId: string }) {
  const id = messageId as Id<"messages">;
  const result = useQuery(api.messages.getRowReasoning, { messageId: id, entryId });
  if (result === undefined) return <p className="oc-thinking__status">{m.reasoning_loading()}</p>;
  if (result === null) return <p className="oc-thinking__status">{m.reasoning_unavailable()}</p>;
  return (
    <>
      <AgentMarkdown text={result.text} />
      {/* The gateway served only its first part, and the full row could not be read. */}
      {result.truncated === true ? <p className="oc-thinking__status">{m.reasoning_capped()}</p> : null}
    </>
  );
}

/** The agent's work note: quieter prose, in its place between the agent's actions. */
export function CommentaryNote({ data }: { data?: { key: string; text: string; capped?: boolean } }) {
  const text = (data?.text ?? "").trim();
  if (text === "") return null;
  return (
    <div className="oc-msg__meta oc-msg__note" role="note" aria-label={m.commentary_note_aria()}>
      <AgentMarkdown text={text} />
      {data?.capped === true ? <p className="oc-thinking__status">{m.chat_text_capped()}</p> : null}
    </div>
  );
}
