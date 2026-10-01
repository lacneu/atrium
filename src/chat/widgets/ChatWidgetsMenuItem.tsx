// The conversation's inline-widget switch in the sidebar item menu. Mounted only while
// the menu is open, so a closed sidebar does not hold one subscription per conversation.
import { LayoutTemplate } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { m } from "@/paraglide/messages.js";
import type { ConvexId } from "../convexTypes";
import { useConversationWidgets } from "./useConversationWidgets";

export function ChatWidgetsMenuItem({ chatId }: { chatId: ConvexId<"chats"> }) {
  const widgets = useConversationWidgets(chatId);
  if (!widgets.offered) return null;
  return (
    <DropdownMenuItem
      disabled={widgets.pending}
      data-widgets-toggle
      onSelect={() => widgets.set(!widgets.enabled)}
    >
      <LayoutTemplate />
      {widgets.enabled ? m.sidebar_widgets_turn_off() : m.sidebar_widgets_turn_on()}
    </DropdownMenuItem>
  );
}
