import { useContext, useEffect, useRef, useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { m } from "@/paraglide/messages.js";
import {
  turnBaselineMs,
  turnClockActive,
  turnElapsedMs,
  turnClockLabel,
} from "./turnClockView";
import { TurnActivityAnchorContext } from "./turnActivityAnchor";

// Live "Working for 5 min 21 s" clock above an assistant message whose TURN is
// still being treated (ChatGPT/Codex-style). Covers BOTH in-flight shapes:
//   - the message itself is STREAMING, and
//   - a DELEGATED turn whose parent message settled — with or WITHOUT text —
//     while its sub-agent runs or its merged reply is being composed (the
//     waiting/composing pill) — the user reads that block as "still working",
//     so the clock must not vanish there (user report 2026-07-20).
// The second shape is not decided here: it is the thread's anchor, read through
// TurnActivityAnchorContext, so the clock and the pill under it show one verdict
// over one window instead of two verdicts over two.
// Renders null once the turn truly settles — the final duration stays in the
// ⋯ menu (no duplication). The 1 s interval only exists while active.

interface ClockMeta {
  status?: string;
  messageId?: string;
  sentAt?: number;
}

export function TurnClock() {
  const status = useMessage(
    (msg) => (msg.metadata?.custom as ClockMeta | undefined)?.status,
  );
  const messageId = useMessage(
    (msg) => (msg.metadata?.custom as ClockMeta | undefined)?.messageId,
  );
  const sentAt = useMessage(
    (msg) => (msg.metadata?.custom as ClockMeta | undefined)?.sentAt,
  );
  const streaming = status === "streaming";
  // THE SAME VERDICT the thread already reached, not a second opinion of it.
  // The thread computes where the "still working" signal belongs — covering a
  // running sub-agent AND the window in which its reply is being composed, each
  // with its own local expiry — and publishes it here. Reading that decision is
  // what makes the clock and the pill under it incapable of disagreeing.
  //
  // It replaces, in turn: a probe that only fired on a settled turn with NO text
  // and NO media (an agent that says a sentence before delegating fell outside
  // it), then a straight `running` read of the same query — which switched the
  // clock off at "the agent is finalising its reply" while the pill below stayed
  // on, because running and delivering are not the same window (live check
  // 2026-08-03; prod reports 2026-07-22 and 2026-08-03).
  const anchored = useContext(TurnActivityAnchorContext);
  const active = turnClockActive(
    streaming,
    anchored?.messageId ?? null,
    messageId,
  );
  // First-observation anchor, keyed by messageId so a composer runtime reused
  // across chats/turns never carries a stale baseline (the repo's reuse trap).
  const anchor = useRef<{
    id: string;
    baselineMs: number;
    firstLocalMs: number;
  } | null>(null);
  if (
    active &&
    messageId !== undefined &&
    sentAt !== undefined &&
    anchor.current?.id !== messageId
  ) {
    const now = Date.now();
    anchor.current = {
      id: messageId,
      baselineMs: turnBaselineMs(sentAt, now),
      firstLocalMs: now,
    };
  }
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [active]);

  if (!active || anchor.current === null || anchor.current.id !== messageId) {
    return null;
  }
  const label = turnClockLabel(
    turnElapsedMs(
      anchor.current.baselineMs,
      anchor.current.firstLocalMs,
      Date.now(),
    ),
  );
  if (label === null) return null;
  return (
    <div className="oc-turn-clock" role="timer">
      <span className="oc-turn-clock__label">
        {m.chat_turn_elapsed({ duration: label })}
      </span>
    </div>
  );
}
