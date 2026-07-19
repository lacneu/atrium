import { useEffect, useRef, useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { m } from "@/paraglide/messages.js";
import {
  turnBaselineMs,
  turnElapsedMs,
  turnClockLabel,
} from "./turnClockView";

// Live "Working for 5 min 21 s" clock above an IN-FLIGHT assistant message
// (ChatGPT/Codex-style). Renders null on settled turns — the final duration
// stays in the ⋯ menu (no duplication). The 1 s interval only exists while the
// message streams (pattern: SessionPanel's job clock).

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
  // First-observation anchor, keyed by messageId so a composer runtime reused
  // across chats/turns never carries a stale baseline (the repo's reuse trap).
  const anchor = useRef<{
    id: string;
    baselineMs: number;
    firstLocalMs: number;
  } | null>(null);
  const streaming = status === "streaming";
  if (
    streaming &&
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
    if (!streaming) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [streaming]);

  if (!streaming || anchor.current === null) return null;
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
