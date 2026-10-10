// THE SEND BUTTON WHILE THE AGENT WORKS (transcript projection `on`, phase 3).
//
// Like the Control UI: the primary action says what Enter does (steer / queue / send
// with the agent's own mode), and a menu offers the three explicit choices — steer now,
// queue, interrupt and send — plus the person's default. Shown only on a conversation
// whose instance runs the projection `on` and whose bridge declares `followUpModes`.

import { useMutation, useQuery } from "convex/react";
import { useComposer, useComposerRuntime } from "@assistant-ui/react";
import {
  ArrowUp,
  ChevronDown,
  Clock,
  CornerDownRight,
  ListEnd,
  OctagonX,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "../../convex/_generated/dataModel";
import type { ConvexId } from "./convexTypes";
import { useToast } from "@/components/ui/toast";
import {
  custodyBadge,
  primaryFollowUp,
  type FollowUpPreference,
  type FollowUpSendMode,
  type GatewayQueueMode,
} from "./followUpComposer";

export type FollowUpQueueSend = (
  text: string,
  mode?: FollowUpSendMode,
) => Promise<boolean>;

/** The composer's follow-up facts for one conversation (null while loading or when the
 *  projection is not `on`). */
export function useFollowUpState(chatId: ConvexId<"chats">): {
  preference: FollowUpPreference | null;
  serverMode: GatewayQueueMode | null;
} | null {
  const state = useQuery(api.followUp.followUpState, { chatId: chatId as Id<"chats"> });
  if (state === undefined || state.projection !== true) return null;
  return {
    preference: state.preference ?? null,
    serverMode: (state.serverMode as GatewayQueueMode | null) ?? null,
  };
}

export function FollowUpSendControl({
  chatId,
  queueSend,
}: {
  chatId: ConvexId<"chats">;
  queueSend: FollowUpQueueSend | null;
}) {
  const state = useFollowUpState(chatId);
  const setDefault = useMutation(api.followUp.setFollowUpMode);
  const composer = useComposerRuntime();
  const text = useComposer((c) => c.text);
  const hasText = text.trim().length > 0;
  const primary = primaryFollowUp(state?.preference ?? null, state?.serverMode ?? null);
  const send = (mode: FollowUpSendMode | undefined) => {
    if (queueSend === null) return;
    const t = composer.getState().text;
    if (t.trim() === "") return;
    void queueSend(t, mode).then((ok) => {
      if (ok) composer.setText("");
    });
  };
  const title =
    primary.kind === "queue"
      ? m.chat_queue_send_title()
      : primary.kind === "steer"
        ? m.chat_followup_steer_title()
        : m.chat_followup_send_title();
  return (
    <div className="oc-composer__followup">
      <button
        type="button"
        className="oc-composer__send"
        disabled={!hasText || queueSend === null}
        aria-label={
          primary.kind === "queue"
            ? m.chat_queue_send_aria()
            : primary.kind === "steer"
              ? m.chat_followup_steer_aria()
              : m.chat_send()
        }
        title={hasText ? title : m.chat_response_in_progress()}
        onClick={() => send(primary.mode)}
      >
        <ArrowUp size={18} aria-hidden />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="oc-iconbtn oc-composer__followup-menu"
            aria-label={m.chat_followup_menu_aria()}
            title={m.chat_followup_menu_aria()}
          >
            <ChevronDown size={14} aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-64">
          <DropdownMenuItem disabled={!hasText} onClick={() => send("steer")}>
            <CornerDownRight /> {m.chat_followup_action_steer()}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasText} onClick={() => send("queue")}>
            <ListEnd /> {m.chat_followup_action_queue()}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasText} onClick={() => send("interrupt")}>
            <OctagonX /> {m.chat_followup_action_interrupt()}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{m.chat_followup_default_label()}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state?.preference ?? "server"}
            onValueChange={(v) =>
              void setDefault({ mode: v === "server" ? null : (v as FollowUpPreference) })
            }
          >
            <DropdownMenuRadioItem value="server">
              {m.chat_followup_default_server()}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="steer">
              {m.chat_followup_default_steer()}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="queue">
              {m.chat_followup_default_queue()}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * THE GATEWAY'S CUSTODY OF A USER MESSAGE (design §3.2), shown discreetly under the
 * bubble: waiting in the agent's own queue (with a withdraw action from 2026.9.7 —
 * `chat.abort {discardPendingInput}`), added to the turn in progress (steer),
 * cancelled, or interrupted. Nothing for the ordinary life of a message.
 */
export function CustodyBadge({
  custody,
  messageId,
  canWithdraw,
}: {
  custody: string | null;
  messageId: string;
  canWithdraw: boolean;
}) {
  const badge = custodyBadge(custody);
  const withdraw = useMutation(api.followUp.cancelGatewayQueuedInput);
  const toast = useToast();
  if (badge === null) return null;
  const label =
    badge === "queued"
      ? m.chat_custody_queued()
      : badge === "steered"
        ? m.chat_custody_steered()
        : badge === "cancelled"
          ? m.chat_custody_cancelled()
          : m.chat_custody_interrupted();
  return (
    <span className={`oc-msg__custody oc-msg__custody--${badge}`} role="status">
      {badge === "queued" ? (
        <Clock size={12} aria-hidden />
      ) : badge === "steered" ? (
        <CornerDownRight size={12} aria-hidden />
      ) : (
        <OctagonX size={12} aria-hidden />
      )}
      {label}
      {badge === "queued" && canWithdraw ? (
        <button
          type="button"
          className="oc-msg__custody-action"
          aria-label={m.chat_custody_cancel_aria()}
          onClick={() =>
            void withdraw({ messageId: messageId as Id<"messages"> }).then(
              (r) => {
                if (!r.ok) toast.error(m.chat_custody_cancel_failed());
              },
              () => toast.error(m.chat_custody_cancel_failed()),
            )
          }
        >
          {m.chat_custody_cancel()}
        </button>
      ) : null}
    </span>
  );
}
