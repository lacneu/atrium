// A GUEST of a conversation is not offered the owner's controls.
//
// Deleting/regenerating a turn, branching and stopping a run are refused to a
// guest by the server (owner-only mutations). Offering them anyway gave a control
// whose every click failed — and a delete even applied its optimistic update before
// rolling back. These are React wiring decisions with no pure function to call, so
// what is pinned is the wiring itself, comment-stripped (commenting a gate out is
// exactly how it would disappear).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CHAT = stripComments(
  readFileSync(join(process.cwd(), "src/chat/ConvexChat.tsx"), "utf-8"),
);

describe("the owner's controls are not offered to a guest", () => {
  test("the reader's role is read, and turns Delete off in the UI prefs", () => {
    expect(CHAT).toMatch(/guestView\s*=\s*\n?\s*useQuery\(\s*\n?\s*api\.messages\.getSessionMeta/);
    expect(CHAT).toMatch(/guestView \? \{ \.\.\.ui, showDelete: false, showReport: false \} : ui/);
    expect(CHAT).toMatch(/<UiPrefsContext\.Provider value=\{uiForReader\}>/);
  });

  test("Stop is withdrawn (no abort handler) for a guest", () => {
    expect(CHAT).toMatch(/<AbortTurnContext\.Provider value=\{guestView \? null : abortTurn\}>/);
  });

  test("the session's knobs and full panel are mounted for the owner only", () => {
    expect(CHAT).toMatch(/\{sm && meta\?\.viewerRole === "owner" \? \(\s*<SessionKnobsMenu/);
    expect(CHAT).toMatch(
      /\{meta\?\.viewerRole === "owner" \? \(\s*<SessionPanel chatId=\{chatId\} open=\{panelOpen\}/,
    );
    // Nothing else mounts them ungated.
    expect(CHAT.match(/<SessionKnobsMenu\b/g)).toHaveLength(1);
    expect(CHAT.match(/<SessionPanel\b/g)).toHaveLength(1);
  });

  test("Branch is offered to the owner only", () => {
    expect(CHAT).toMatch(/<OwnerViewContext\.Provider value=\{!guestView\}>/);
    const item = CHAT.indexOf("void branch()");
    expect(item).toBeGreaterThan(-1);
    expect(CHAT.slice(Math.max(0, item - 400), item)).toMatch(/\{ownerView \? \(/);
  });
});

const read = (f: string) => stripComments(readFileSync(join(process.cwd(), f), "utf-8"));

describe("the other owner-only controls a guest meets", () => {
  test("a context overflow offers a guest neither compact nor branch", () => {
    const src = read("src/chat/ContextLengthActions.tsx");
    expect(src).toMatch(/guestView =\s*\n?\s*useQuery\(api\.messages\.getSessionMeta/);
    expect(src).toMatch(/if \(guestView\) return null;\s*\n\s*return \(/);
  });

  test("a sub-agent's panel: no report flag and no composer for a guest", () => {
    const src = read("src/chat/SubAgentPanel.tsx");
    expect(src).toMatch(/guestView = chatMeta\?\.viewerRole === "participant"/);
    expect(src).toMatch(/isReportableSubAgent\(card\.status\) && !guestView/);
    expect(src).toMatch(/\{guestView \? null : \(\s*\n\s*<footer className="oc-subpanel__foot">/);
  });
});

describe("a guest never sees their own agents offered", () => {
  test("the pool is empty until the room is known, and the role is read from either answer", () => {
    const src = read("src/chat/useConvexChatRuntime.ts");
    expect(src).toMatch(/if \(chatId !== null && roomInfo === undefined\) return \[\];\s*\n\s*if \(!isGuest \|\| !roomInfo\) return myAgents \?\? \[\];/);
    expect(src).toMatch(/isGuest = \(roomInfo\?\.viewerRole \?\? chatMeta\?\.viewerRole\) === "participant"/);
  });
});

describe("a hidden shared conversation keeps a way back", () => {
  test("kept out of the working set, folded under the shared section, restorable", () => {
    const src = read("src/chat/ChatSidebar.tsx");
    expect(src).toMatch(/const rows = allRows\.filter\(\(c\) => c\.sidebarHidden !== true\);/);
    expect(src).toMatch(/const hiddenShared = allRows\.filter\(\(c\) => c\.sidebarHidden === true\);/);
    expect(src).toMatch(/<HiddenShared chats=\{hiddenShared\} \/>/);
    expect(src).toMatch(/setChatSidebar\(\{ chatId: c\._id, hidden: false \}\)/);
  });
});

describe("adding lives in the button; removing, in the panel", () => {
  test("the Agents tab adds an agent to the room; the chevron no longer does", () => {
    const src = read("src/chat/ConvexChat.tsx");
    expect(src).toMatch(/api\.chatAgents\.listAddableAgents,\s*\n\s*manages && open && tab === "agents"/);
    expect(src).toMatch(/className="oc-agentrow__add"/);
    expect(src).not.toMatch(/onManage\("agents", "add-agent"\)/);
  });
});
