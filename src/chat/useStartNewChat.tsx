import { useCallback, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { AgentPickerDialog, type PickableAgent } from "./AgentPicker";

// New-chat orchestration, extracted from ChatSidebar so it can live in the
// PERSISTENT chrome (always mounted) rather than the sidebar (which unmounts when
// collapsed or while in Settings). That placement is what lets the ⌘⇧O / Ctrl+
// Shift+O global shortcut work everywhere — exactly like the ⌘K search palette,
// which also lives in the always-mounted top bar.
//
// The hook owns the agent query, the create mutation and the agent picker dialog
// (returned as `picker`, which the caller renders once at chrome level). The
// sidebar button now simply calls the returned `startNewChat`.

/**
 * @param onCreated called with the new chat id once it is bound to an agent, so
 *   the caller can navigate to it.
 */
export function useStartNewChat(onCreated: (id: Id<"chats">) => void): {
  startNewChat: () => Promise<void>;
  picker: ReactNode;
} {
  const createChat = useMutation(api.chats.createChat);
  // The agents this (effective) user may open a chat on. Drives the binding:
  // exactly 1 usable → bind automatically; >1 (or 0) → open the picker.
  const myAgents = useQuery(api.agents.listMyAgents) as
    | PickableAgent[]
    | undefined;
  const [pickerOpen, setPickerOpen] = useState(false);

  const bindAndOpen = useCallback(
    async (instanceName: string, agentId: string) => {
      const id = (await createChat({
        title: "New chat",
        instanceName,
        agentId,
      })) as Id<"chats">;
      onCreated(id);
    },
    [createChat, onCreated],
  );

  const startNewChat = useCallback(async () => {
    const agents = myAgents;
    // Auto-bind ONLY when the sole agent is usable. A single agent that was
    // deleted on the gateway falls through to the picker (which disables it) so we
    // never auto-create a chat bound to a dead agent.
    if (agents && agents.length === 1 && agents[0].state !== "deleted") {
      await bindAndOpen(agents[0].instanceName, agents[0].agentId);
      return;
    }
    // 0, >1, sole-deleted, or still loading → let the picker decide.
    setPickerOpen(true);
  }, [myAgents, bindAndOpen]);

  const picker = (
    <AgentPickerDialog
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      agents={myAgents}
      onPick={(instanceName, agentId) => {
        setPickerOpen(false);
        void bindAndOpen(instanceName, agentId);
      }}
    />
  );

  return { startNewChat, picker };
}
