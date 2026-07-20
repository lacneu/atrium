import { useEffect, useRef, useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { m } from "@/paraglide/messages.js";
import {
  turnBaselineMs,
  turnElapsedMs,
  turnClockLabel,
} from "./turnClockView";
import {
  assistantEmptyState,
  toolPartsHaveSpawn,
} from "./assistantEmptyState";
import { messageHasText } from "./runStatusView";
import type { ToolActivityPart } from "./toolActivityView";
import type { SubAgentRow } from "./subAgentActivityView";

// Live "Working for 5 min 21 s" clock above an assistant message whose TURN is
// still being treated (ChatGPT/Codex-style). Covers BOTH in-flight shapes:
//   - the message itself is STREAMING, and
//   - a DELEGATED turn whose parent message settled empty while its sub-agent
//     runs or its merged reply is being composed (the waiting/composing pill)
//     — the user reads that block as "still working", so the clock must not
//     vanish there (user report 2026-07-20).
// Renders null once the turn truly settles — the final duration stays in the
// ⋯ menu (no duplication). The 1 s interval only exists while active.

interface ClockMeta {
  status?: string;
  messageId?: string;
  sentAt?: number;
  chatId?: string;
  allToolParts?: ToolActivityPart[];
  toolParts?: ToolActivityPart[];
}

const EMPTY_PARTS: ToolActivityPart[] = [];

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
  const chatId = useMessage(
    (msg) => (msg.metadata?.custom as ClockMeta | undefined)?.chatId,
  );
  const toolParts = useMessage(
    (msg) =>
      (msg.metadata?.custom as ClockMeta | undefined)?.allToolParts ??
      (msg.metadata?.custom as ClockMeta | undefined)?.toolParts ??
      EMPTY_PARTS,
  );
  const hasText = useMessage((msg) =>
    messageHasText(
      msg.content as ReadonlyArray<{ type?: string; text?: unknown }>,
    ),
  );
  const hasMedia = useMessage((msg) =>
    (msg.content as ReadonlyArray<{ type?: string }>).some(
      (p) => p?.type === "file",
    ),
  );
  const streaming = status === "streaming";
  // DELEGATION probe, only where it can matter (a settled-empty turn that
  // spawned): Convex dedupes this subscription with the sub-agent monitor's
  // and AssistantEmptyState's identical one — no extra network cost.
  const mayBeDelegated =
    status === "complete" &&
    !hasText &&
    !hasMedia &&
    toolPartsHaveSpawn(toolParts);
  const subAgents = useQuery(
    api.subAgents.listSubAgents,
    mayBeDelegated && chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  ) as SubAgentRow[] | undefined;
  const delegatedState = mayBeDelegated
    ? assistantEmptyState(
        { status, hasText, hasMedia },
        toolParts,
        subAgents ?? [],
        messageId,
      ).kind
    : "none";
  const active =
    streaming || delegatedState === "waiting" || delegatedState === "composing";
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
