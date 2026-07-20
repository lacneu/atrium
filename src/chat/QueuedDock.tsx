import { useContext, useLayoutEffect, useRef } from "react";
import { useThreadRuntime } from "@assistant-ui/react";
import { CornerDownRight, Pencil, Trash2 } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { QueueDockContext } from "./ConvexChat";

// Codex-style QUEUE DOCK: each message sent mid-turn is a CARD stacked right
// against the composer (the card's lower edge tucks BEHIND it — one visual
// group) until the drain promotes it into the conversation. While parked:
//   - 🗑 cancels it (atomically server-side; a promoted turn refuses + toast);
//   - ✏️ pulls the text BACK INTO THE COMPOSER (and removes the card): the
//     user edits there and re-sends — the send lands back in the queue while
//     the turn still runs (the normal queue-send path).
// Live steering ("send as instruction") is intentionally absent: the gateway's
// injection surface crashes the active embedded run (D0 spike).

export function QueuedDock() {
  const dock = useContext(QueueDockContext);
  const threadRuntime = useThreadRuntime();
  const ref = useRef<HTMLDivElement | null>(null);
  const count = dock?.queuedTurns.length ?? 0;
  // Publish the dock's measured height to the thread viewport (CSS var): the
  // cards FLOAT over the end of the thread (frosted), so without this pad the
  // auto-scrolled bottom of the in-flight reply would sit hidden behind them
  // (user report). Cleared when the dock empties/unmounts.
  useLayoutEffect(() => {
    const el = ref.current;
    const viewport = document.querySelector<HTMLElement>(
      ".oc-thread__viewport",
    );
    if (!viewport) return;
    if (!el || count === 0) {
      viewport.style.removeProperty("--oc-dock-pad");
      return;
    }
    const apply = () =>
      viewport.style.setProperty("--oc-dock-pad", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      viewport.style.removeProperty("--oc-dock-pad");
    };
  }, [count]);
  if (dock === null || count === 0) return null;
  const { queuedTurns, cancelQueued } = dock;
  return (
    <div
      ref={ref}
      className="oc-queue-dock"
      role="status"
      aria-label={m.chat_queue_dock_aria()}
    >
      {queuedTurns.map((t) => (
        <div className="oc-queue-card" key={t.messageId}>
          <CornerDownRight
            size={16}
            aria-hidden
            className="oc-queue-card__icon"
          />
          <span className="oc-queue-card__text" title={t.text}>
            {t.text}
          </span>
          <button
            type="button"
            className="oc-queue-card__btn"
            title={m.chat_queue_edit()}
            aria-label={m.chat_queue_edit()}
            disabled={t.pending}
            onClick={() => {
              // Cancel FIRST (atomic — refuses if already dispatched), and only
              // then hand the text to the composer: a promoted turn must never
              // be duplicated into a new draft.
              void cancelQueued(t.messageId).then((ok) => {
                if (ok) threadRuntime.composer.setText(t.text);
              });
            }}
          >
            <Pencil size={15} />
          </button>
          <button
            type="button"
            className="oc-queue-card__btn oc-queue-card__btn--danger"
            title={m.chat_queue_delete()}
            aria-label={m.chat_queue_delete()}
            disabled={t.pending}
            onClick={() => void cancelQueued(t.messageId)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
