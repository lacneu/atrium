// THE COMPOSER'S ROOM POPOVER (the split pill: Agents / People) is the quick view.
//
// It shows no technical detail — the model and the instance of an agent live in the
// conversation panel — except the instance of two agents bearing the same name, which
// would otherwise read as one. And it lets whoever manages the room take an agent or
// a person OUT in one click (call an agent in, let it go once the work is done),
// never the primary, never someone the server would refuse to remove.
//
// React wiring with no pure function to call: pinned on the source, comment-stripped
// (commenting a guard out is exactly how it would disappear). The decisions
// themselves are pure helpers, tested in perTurnAgent.test.ts / conversationRoles.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const read = (f: string) => stripComments(readFileSync(join(process.cwd(), f), "utf-8"));
const CHAT = read("src/chat/ConvexChat.tsx");
const PANEL = read("src/chat/ConversationPanel.tsx");

function composerSelect(): string {
  const start = CHAT.indexOf("function ComposerAgentSelect(");
  expect(start, "ComposerAgentSelect moved").toBeGreaterThan(-1);
  const end = CHAT.indexOf("\nfunction ", start + 1);
  return CHAT.slice(start, end === -1 ? undefined : end);
}

describe("the quick view carries no technical detail", () => {
  test("no model anywhere in the agent rows", () => {
    const body = composerSelect();
    expect(body).not.toMatch(/\ba\.model\b/);
    expect(body).not.toMatch(/agentRowMeta/);
  });

  test("an instance is shown only for a homonym", () => {
    const body = composerSelect();
    const shown = [...body.matchAll(/oc-agentrow__inst/g)];
    expect(shown.length).toBeGreaterThan(0);
    for (const hit of shown) {
      const before = body.slice(Math.max(0, hit.index! - 220), hit.index!);
      expect(before, "an instance rendered without the homonym guard").toMatch(
        /homonym(s\.has\((key|`\$\{a\.instanceName\}\\u0000\$\{a\.agentId\}`)\))? \? \(/,
      );
    }
    expect(body).toMatch(/homonymAgentKeys\(\[\.\.\.listed, \.\.\.\(addable \?\? \[\]\)\]\)/);
  });

  test("the conversation panel keeps both, for every agent of the room", () => {
    expect(PANEL).toMatch(
      /<Server size=\{10\} aria-hidden \/> \{a\.instanceName\}\s*\{a\.model \? ` · \$\{a\.model\}` : ""\}/,
    );
  });
});

describe("taking an agent out, from the quick view", () => {
  test("offered by the room's own rule — added agents, for those who manage it", () => {
    const body = composerSelect();
    expect(body).toMatch(
      /const canRemove = mayRemoveRoomAgent\(room\?\.viewerRoomRole, a, roomPrimary, roomAgents\);/,
    );
    expect(body).toMatch(
      /\{canRemove \? \(\s*<button\s+type="button"\s+className="oc-agentrow__remove"\s+title=\{m\.room_remove_title\(\{ name \}\)\}\s+aria-label=\{m\.room_remove_title\(\{ name \}\)\}\s+onClick=\{\(\) => removeFromRoom\(a\)\}/,
    );
  });

  test("no confirmation; a toast names who left, errors as elsewhere", () => {
    const body = composerSelect();
    const start = body.indexOf("const removeFromRoom = ");
    const fn = body.slice(start, body.indexOf("const addToRoom = ", start));
    expect(fn).toMatch(/useMutation\(api\.chatAgents\.removeChatAgent\)|removeChatAgent\(\{/);
    expect(body).toMatch(/const removeChatAgent = useMutation\(api\.chatAgents\.removeChatAgent\);/);
    expect(fn).toMatch(/if \(r\.removed\) toast\.success\(m\.room_removed\(\{ name \}\)\);/);
    expect(fn).toMatch(/\.catch\(\(\) => toast\.error\(m\.conversation_failed\(\)\)\)/);
    expect(fn).not.toMatch(/confirm\(/);
  });
});

describe("taking a person out, from the quick view", () => {
  test("offered only where the server would accept it", () => {
    const body = composerSelect();
    expect(body).toMatch(/if \(!mayRemoveMember\(room\?\.viewerRoomRole, p\)\) return row;/);
    expect(body).toMatch(
      /className="oc-agentrow__remove"\s+title=\{m\.room_remove_title\(\{ name: p\.name \}\)\}\s+aria-label=\{m\.room_remove_title\(\{ name: p\.name \}\)\}\s+onClick=\{\(\) => removePerson\(p\)\}/,
    );
    // …and the panel applies the very same rule.
    expect(PANEL).toMatch(/const removable = mayRemoveMember\(viewer, p\);/);
  });

  test("no confirmation; a toast names who left, errors as elsewhere", () => {
    const body = composerSelect();
    expect(body).toMatch(/const removeMember = useMutation\(api\.chatParticipants\.removeMember\);/);
    const start = body.indexOf("const removePerson = ");
    const fn = body.slice(start, body.indexOf("};", start));
    expect(fn).toMatch(/\.then\(\(\) => toast\.success\(m\.room_removed\(\{ name: p\.name \}\)\)\)/);
    expect(fn).toMatch(/\.catch\(\(\) => toast\.error\(m\.participants_failed\(\)\)\)/);
    expect(fn).not.toMatch(/confirm\(/);
  });
});

describe("row actions are always visible, not revealed by the pointer", () => {
  test("remove, mention and add are never hidden until hover", () => {
    const css = readFileSync(join(process.cwd(), "src/chat/chatParticipants.css"), "utf-8");
    const rule = (sel: string) => {
      const at = css.indexOf(`${sel} {`);
      return at === -1 ? "" : css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".oc-agentrow__remove")).not.toMatch(/opacity:\s*0|visibility:\s*hidden|display:\s*none/);
    expect(rule(".oc-agentrow__hover")).not.toMatch(/opacity:\s*0|visibility:\s*hidden|display:\s*none/);
    expect(css).not.toMatch(/\.oc-agentrow-wrap:hover \.oc-agentrow__remove/);
  });
});

describe("an agent outside the conversation is added, never addressed", () => {
  test("the attribution fallback is resolved against the room's agents only", () => {
    const rt = readFileSync(join(process.cwd(), "src/chat/useConvexChatRuntime.ts"), "utf-8");
    // One resolution left: the in-flight placeholder's. Addressing is by mention of
    // a room row — there is no selection to resolve any more.
    expect(rt.match(/pool: targetPool,/g)?.length).toBe(1);
    expect(rt).toMatch(/roomTargets\(pool, roomInfo \? \[roomInfo\.primary, \.\.\.roomInfo\.agents\] : null\)/);
  });
  test("outside rows only add (no pick)", () => {
    const src = readFileSync(join(process.cwd(), "src/chat/ConvexChat.tsx"), "utf-8");
    const at = src.indexOf("{otherRows.map((a) => {");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("})}", at));
    expect(block).toMatch(/onClick=\{\(\) => addToRoom\(a\)\}/);
    expect(block).not.toMatch(/pick\(a\)/);
  });
});

describe("adding someone is its own feedback", () => {
  // The row appears in the list the reader is looking at: a success toast on top of
  // it said the same thing twice. Failures still toast; a REMOVAL still names who
  // left (the row disappears, which a toast confirms).
  test("adding an agent: an error toast, never a success one", () => {
    const body = composerSelect();
    const start = body.indexOf("const addToRoom = ");
    const fn = body.slice(start, body.indexOf("};", start));
    expect(fn).toMatch(/addChatAgent\(\{/);
    expect(fn).toMatch(/toast\.error\(/);
    expect(fn).not.toMatch(/toast\.success/);
  });

  test("inviting a person: an error toast, never a success one", () => {
    const body = composerSelect();
    const start = body.indexOf("const invite = ");
    const fn = body.slice(start, body.indexOf("};", start));
    expect(fn).toMatch(/addMember\(\{/);
    expect(fn).toMatch(/toast\.error\(/);
    expect(fn).not.toMatch(/toast\.success/);
  });

  test("…and no other success toast in the room control but the removals'", () => {
    const body = composerSelect();
    const successes = [...body.matchAll(/toast\.success\(m\.(\w+)\(/g)].map((h) => h[1]);
    expect(successes).toEqual(["room_removed", "room_removed"]);
  });
});
