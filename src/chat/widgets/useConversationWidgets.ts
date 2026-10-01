// The conversation's inline-widget switch, shared by the composer's "+" menu and the
// sidebar item menu. Offered to the conversation OWNER, on an OpenClaw instance whose
// admin allows widgets, when the gateway version supports them (`inlineWidgets`
// capability). The change applies from the next turn: the bridge re-opens the
// conversation's socket with or without the `inline-widgets` capability.

import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";

import { useToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { useInstanceCapabilities } from "../useInstanceCapabilities";
import type { ConvexId } from "../convexTypes";

export function useConversationWidgets(chatId: ConvexId<"chats"> | null): {
  /** The switch is offered to this reader. */
  offered: boolean;
  enabled: boolean;
  pending: boolean;
  set: (enabled: boolean) => void;
} {
  const config = useQuery(api.widgets.widgetConfigForChat, chatId === null ? "skip" : { chatId });
  const { can } = useInstanceCapabilities(chatId);
  const setChatWidgets = useMutation(api.widgets.setChatWidgets);
  const toast = useToast();
  const [pending, setPending] = useState<boolean | null>(null);
  const offered = config?.canToggle === true && can("inlineWidgets");
  const enabled = pending ?? config?.chatDisabled !== true;
  const set = useCallback(
    (next: boolean) => {
      if (chatId === null) return;
      setPending(next);
      void setChatWidgets({ chatId: chatId as Id<"chats">, enabled: next })
        .catch((err: unknown) => toast.error(m.widget_toggle_failed(), err))
        .finally(() => setPending(null));
    },
    [chatId, setChatWidgets, toast],
  );
  return { offered, enabled, pending: pending !== null, set };
}
