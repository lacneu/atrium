// WIRED exits from a context-overflow error card (W2, P4).
//
// The label used to END with advice — "retry asking to delegate to sub-agents,
// compact the session, or start a new chat" — and it cited `/reset`, a command
// Atrium does not have. Telling a user what to do by hand, for a state the app
// can act on itself, is the pattern this program forbids: the fix is to make the
// exit a BUTTON, not a sentence.
//
// Both actions reuse mutations that already existed; nothing new server-side.

import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { flashSidebarChat } from "./sidebarFlash";

/** Does the gateway's refusal mean "cannot compact now" rather than a defect?
 *  A refusal is not a failure to report as one — it means the OTHER exit is the
 *  one that will work, and the notice says so.
 *
 *  `compact_refused[:<class>]` is the CANONICAL form: the bridge reads the
 *  gateway's `{compacted:false, reason}` answer and `compactSession` raises it.
 *  The bare reason strings stay recognised because they can also arrive inside a
 *  gateway error text on other paths. */
export function isCompactRefusal(err: unknown): boolean {
  const text =
    err instanceof Error
      ? err.message
      : typeof (err as { data?: unknown } | null)?.data === "string"
        ? String((err as { data: string }).data)
        : String(err ?? "");
  return /compact_refused|already_active|already_in_flight|deferred_compaction_not_scheduled|below_threshold|already_compacted_recently|unsupported_harness_compaction|no transcript|no sessionId/i.test(
    text,
  );
}

export function ContextLengthActions(props: {
  chatId: string;
  /** The failed assistant message — the branch point for a new session. */
  messageId: string | null;
}) {
  const compact = useAction(api.agentFiles.compactSession);
  const fork = useMutation(api.chatFork.forkChat);
  const [busy, setBusy] = useState<null | "compact" | "branch">(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A DONE action does not offer itself again: the branch created a chat, and a
  // second click would silently create another one the user never asked for.
  const [done, setDone] = useState<null | "compact" | "branch">(null);

  const runCompact = async (): Promise<void> => {
    setBusy("compact");
    setNotice(null);
    try {
      await compact({ chatId: props.chatId as Id<"chats"> });
      // Compaction SUCCEEDED: the session is smaller, so the same turn can now
      // be worth re-running. Deliberately NOT automatic — re-sending is the
      // user's call, and a silent re-send would bill a turn they did not ask for.
      // SAY so: an action that reports nothing is indistinguishable from one that
      // did nothing, which is what this card exists to stop doing.
      setDone("compact");
      setNotice(m.ctxerr_act_compacted());
    } catch (err) {
      setNotice(
        isCompactRefusal(err)
          ? m.ctxerr_act_compact_refused()
          : m.ctxerr_act_failed(),
      );
    } finally {
      setBusy(null);
    }
  };

  const runBranch = async (): Promise<void> => {
    if (props.messageId === null) return;
    setBusy("branch");
    setNotice(null);
    try {
      const { chatId } = await fork({
        branchMessageId: props.messageId as Id<"messages">,
      });
      // Same feedback as the message action bar's own branch: the sidebar row
      // pulses where the branch landed. Without it the user stayed on the failure
      // card with no sign a new session existed — and clicked again.
      flashSidebarChat(chatId, { expand: true });
      setDone("branch");
      setNotice(m.ctxerr_act_branched());
    } catch {
      setNotice(m.ctxerr_act_failed());
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="oc-error-card__actions">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy !== null || done !== null}
        onClick={() => void runCompact()}
      >
        {busy === "compact" ? m.ctxerr_act_busy() : m.ctxerr_act_compact()}
      </Button>
      {props.messageId !== null ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null || done === "branch"}
          onClick={() => void runBranch()}
        >
          {busy === "branch" ? m.ctxerr_act_busy() : m.ctxerr_act_branch()}
        </Button>
      ) : null}
      {notice !== null ? (
        <p className="oc-error-card__notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
