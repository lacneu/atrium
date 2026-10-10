// The trash left the sidebar. Deleted conversations are rarely visited, so their
// entry point moved to Settings › Deleted conversations (DeletedChatsTab.tsx);
// the sidebar keeps its space for the conversation list.
//
// Rendered rather than grepped: what matters is what the sidebar actually emits.
// Convex and the router are stubbed at the hook boundary — the sidebar renders
// its real tree, with an empty conversation list.

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("convex/react", () => ({
  useQuery: (_ref: unknown, args: unknown) => (args === "skip" ? undefined : []),
  useMutation: () => async () => null,
  useAction: () => async () => null,
  useConvex: () => ({}),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => async () => undefined,
}));

// A browser-only store (no server snapshot): no flash is running.
vi.mock("./sidebarFlash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidebarFlash")>()),
  useSidebarFlash: () => null,
}));

import { ChatSidebar } from "./ChatSidebar";
import { DialogsProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";

function renderSidebar(): string {
  return renderToStaticMarkup(
    h(
      ToastProvider,
      null,
      h(
        DialogsProvider,
        null,
        h(ChatSidebar, {
          activeChatId: null,
          onSelect: () => undefined,
          onNewChat: () => undefined,
          newChatShortcut: "⌘K",
        }),
      ),
    ),
  );
}

describe("the sidebar no longer carries the trash", () => {
  test("no trash entry is rendered under the conversation list", () => {
    const html = renderSidebar();
    // The render really produced the sidebar (its new-chat action is there).
    expect(html).toContain("oc-sidebar");
    expect(html).toContain(m.sidebar_new_chat());
    expect(html).not.toContain("oc-sidebar__trash");
    expect(html).not.toContain("Corbeille");
  });
});
