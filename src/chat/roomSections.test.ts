import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { addableOutsideList, joinSectionOpen } from "./roomSections";

describe("joinSectionOpen — who could join is folded by default", () => {
  test("folded when the room has someone to address and nothing is searched", () => {
    expect(joinSectionOpen({ unfolded: false, searching: false, hereCount: 2 })).toBe(false);
  });
  test("the toggle unfolds it", () => {
    expect(joinSectionOpen({ unfolded: true, searching: false, hereCount: 2 })).toBe(true);
  });
  test("a search unfolds it: a typed name finds its match wherever it lives", () => {
    expect(joinSectionOpen({ unfolded: false, searching: true, hereCount: 2 })).toBe(true);
  });
  test("an empty room unfolds it: adding is the next step", () => {
    expect(joinSectionOpen({ unfolded: false, searching: false, hereCount: 0 })).toBe(true);
  });
});

// React wiring, pinned on the comment-stripped source (see roomPopover.test.ts).
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const CHAT = stripComments(readFileSync(join(process.cwd(), "src/chat/ConvexChat.tsx"), "utf-8"));
function composerSelect(): string {
  const start = CHAT.indexOf("function ComposerAgentSelect(");
  const end = CHAT.indexOf("\nfunction ", start + 1);
  return CHAT.slice(start, end === -1 ? undefined : end);
}

describe("the room control applies the rule in both tabs", () => {
  test("both sections start folded, and fold again for the next opening and chat", () => {
    const body = composerSelect();
    expect(body).toMatch(/const \[othersUnfolded, setOthersUnfolded\] = useState\(false\);/);
    expect(body).toMatch(/const \[inviteUnfolded, setInviteUnfolded\] = useState\(false\);/);
    const reset = /setOthersUnfolded\(false\);\s*setInviteUnfolded\(false\);/g;
    // Once on a chat change, once when the popover closes.
    expect(body.match(reset)?.length).toBe(2);
  });

  test("agents: the outside rows and the add-only rows render only when open", () => {
    const body = composerSelect();
    expect(body).toMatch(
      /const othersOpen = joinSectionOpen\(\{\s*unfolded: othersUnfolded,\s*searching: addTerm !== "",\s*hereCount: roomRows\.length,\s*\}\);/,
    );
    expect(body).toMatch(/\{othersOpen \? \(\s*<>\s*\{otherRows\.map\(/);
    expect(body).toMatch(/\{othersOpen && addOnly\.length > 0 \? \(/);
  });

  test("people: the invite rows render only when open, the role picker with them", () => {
    const body = composerSelect();
    expect(body).toMatch(
      /const inviteOpen = joinSectionOpen\(\{\s*unfolded: inviteUnfolded,\s*searching: term !== "",\s*hereCount: presentRows\.filter\(\(p\) => !p\.isSelf\)\.length,\s*\}\);/,
    );
    expect(body).toMatch(/\{inviteOpen \? \(\s*<label className="oc-invite-as">/);
    expect(body).toMatch(/\{!inviteOpen \? null : invitable === undefined \? \(/);
  });

  test("each toggle says whether it is open", () => {
    const body = composerSelect();
    expect(body).toMatch(/aria-expanded=\{othersOpen\}\s+onClick=\{\(\) => setOthersUnfolded\(!othersOpen\)\}/);
    expect(body).toMatch(/aria-expanded=\{inviteOpen\}\s+onClick=\{\(\) => setInviteUnfolded\(!inviteOpen\)\}/);
  });
});

describe("the fold's count says what the search found", () => {
  test("counted after the search filter, before the display bound", () => {
    const body = composerSelect();
    expect(body).toMatch(/const addOnly = addMatches\.slice\(0, 8\);/);
    expect(body).toMatch(/const othersCount = otherRows\.length \+ addMatches\.length;/);
  });
  test("the Invite count is what the search found too", () => {
    const body = composerSelect();
    expect(body).toMatch(/<span className="oc-agentlist__togglecount">\{inviteMatches\.length\}<\/span>/);
    expect(body).not.toMatch(/\{invitable\.length\}/);
  });
  test("the section uses the shared helper on the WHOLE list", () => {
    expect(composerSelect()).toMatch(/const addMatches = addableOutsideList\(listed, addable \?\? \[\], q\);/);
  });
});

describe("addableOutsideList", () => {
  const ag = (agentId: string, displayName: string | null = null, instanceName = "i1") => ({
    instanceName,
    agentId,
    displayName,
  });
  test("an agent the list shows is never offered as one to add", () => {
    expect(addableOutsideList([ag("alice")], [ag("alice"), ag("bob")], "")).toEqual([ag("bob")]);
  });
  test("judged on the whole list: a listed agent hidden by the search is not re-offered", () => {
    // `listed` is the unsearched list; the term matches alice by instance name.
    expect(addableOutsideList([ag("alice", "Alice", "jerome")], [ag("alice", "Alice", "jerome")], "jer")).toEqual([]);
  });
  test("narrowed by the term on name, id or instance — all matches, no display bound", () => {
    const addable = Array.from({ length: 12 }, (_, k) => ag(`nova${k}`, `Nova ${k}`));
    expect(addableOutsideList([], [...addable, ag("zed")], "nova")).toHaveLength(12);
    expect(addableOutsideList([], [ag("x", "Zed", "gw-b")], "GW-B")).toHaveLength(1);
  });
});
