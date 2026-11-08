// WIRING of the block picker's focus on close (lots 11, 12 and 16).
//
// The order is pure and tested in quoteBlocks.test.ts (pickerFocusOrder), the walk
// that offers the focus in that order in src/lib/focusFallback.test.ts
// (focusFirst), the shared rule in src/lib/returnFocus.test.ts. What those tests
// cannot see is whether the picker still goes through them. Since lot 16 it has no
// close handler of its own — one ran before the guard and took back a focus the
// user had moved to the composer during the exit —: it names its fallbacks to the
// shared rule, and a picked quote sends the focus to the composer as the pick's
// outcome, which the rule's guard then keeps. The picker needs Radix and the DOM
// to render, so the wiring is read from the SYNTAX TREE (TypeScript's parser:
// comments and strings cannot fake a call).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const SF = ts.createSourceFile(
  "BlockPicker.tsx",
  readFileSync(join(process.cwd(), "src/chat/BlockPicker.tsx"), "utf-8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function find<T extends ts.Node>(root: ts.Node, pick: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node) => {
    if (pick(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

const callsTo = (root: ts.Node, name: string) =>
  find(root, ts.isCallExpression).filter((c) => {
    const e = c.expression;
    return (
      (ts.isIdentifier(e) && e.text === name) ||
      (ts.isPropertyAccessExpression(e) && e.name.text === name)
    );
  });

const candidatesFn = () =>
  find(SF, ts.isFunctionDeclaration).find((f) => f.name?.text === "pickerCandidates");

describe("the block picker gives the focus back by the shared rule", () => {
  test("no close handler of its own: its fallbacks go to the rule, for both kinds", () => {
    const own = find(SF, ts.isJsxAttribute).filter((a) => a.name.getText() === "onCloseAutoFocus");
    expect(own, "an own onCloseAutoFocus runs before the guard").toHaveLength(0);
    const fallbacks = find(SF, ts.isJsxAttribute).filter((a) => a.name.getText() === "returnFocus");
    expect(fallbacks).toHaveLength(1);
    const [call] = callsTo(fallbacks[0], "pickerCandidates");
    expect(call, "returnFocus no longer reads pickerCandidates").toBeDefined();
    expect(call.arguments.map((a) => a.getText())).toEqual([
      "messageId",
      'picked.current && kind === "quote"',
    ]);
  });

  test("a picked quote: the composer takes the focus as the outcome, once the picker is closed", () => {
    const effect = callsTo(SF, "useEffect").find((c) => /picked\.current/.test(c.getText()) && /focusFirst/.test(c.getText()));
    expect(effect, "no outcome effect").toBeDefined();
    const body = effect!.arguments[0].getText();
    // Only after the close (`open` false), only for a picked quote, only the composer.
    expect(body).toMatch(/if \(open \|\| !picked\.current \|\| kind !== "quote"\) return;/);
    const [walk] = callsTo(effect!, "focusFirst");
    expect(walk.arguments[0].getText()).toBe("[composer]");
    const [read] = callsTo(effect!, "pickerCandidates");
    expect(read.arguments.map((a) => a.getText())).toEqual(["messageId", "true"]);
    expect(effect!.arguments[1]?.getText()).toBe("[open, kind, messageId]");
  });

  test("the focus only moves through the shared walk: no direct .focus() call", () => {
    expect(callsTo(SF, "focus"), "a direct .focus() call bypasses the walk").toHaveLength(0);
    const fn = candidatesFn();
    expect(fn, "no pickerCandidates").toBeDefined();
    expect(callsTo(fn!, "pickerFocusOrder")).toHaveLength(1);
  });

  test("every candidate of the order is resolved: the ⋯, the reply, the composer", () => {
    const table = find(candidatesFn()!, ts.isObjectLiteralExpression)[0];
    const keys = table.properties.map((p) => p.name?.getText());
    expect(keys).toEqual(expect.arrayContaining(["composer", "trigger", "message"]));
  });
});

// LOT 21: a delegation's answer reads as ONE answer across consecutive bubbles, and
// only its last bubble has a ⋯. The lists of that ⋯ must hold the blocks of every
// bubble of the answer, and a pick must name the bubble its block belongs to. The
// lists' content is pure and composed end to end in quoteBlocks.test.ts (with
// displayGroupPlaces); here, that the components still go through it.
const source = (file: string) =>
  ts.createSourceFile(file, readFileSync(join(process.cwd(), "src/chat", file), "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const CHAT = source("ConvexChat.tsx");
const GUTTER = source("Bookmarks.tsx");
const fnNamed = (sf: ts.SourceFile, name: string) => find(sf, ts.isFunctionDeclaration).find((f) => f.name?.text === name);
const attr = (el: ts.JsxSelfClosingElement | ts.JsxOpeningElement, name: string) =>
  el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
const jsx = (root: ts.Node, tag: string) =>
  find(root, (n): n is ts.JsxSelfClosingElement | ts.JsxOpeningElement =>
    (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText() === tag,
  );

describe("the lists of a grouped answer's ⋯ hold every bubble's blocks (lot 21)", () => {
  test("the picker reads the blocks of every bubble it lists, through the gutter's own rule", () => {
    const read = find(SF, ts.isFunctionDeclaration).find((f) => f.name?.text === "readChoices");
    expect(read, "no readChoices").toBeDefined();
    expect(read!.parameters.map((p) => p.name.getText())).toEqual(["sources", "kind"]);
    const [compose] = callsTo(read!, "blockChoices");
    expect(compose, "the blocks are not composed by blockChoices").toBeDefined();
    expect(compose.arguments[0].getText()).toMatch(/^sources\.map\(/);
    expect(compose.arguments[0].getText()).toMatch(/collectAnchorBlocks\(body\)\.map\(blockFace\)/);
  });

  test("each row names its bubble and its block, and a pick hands over the whole choice", () => {
    const [row] = jsx(SF, "Button").filter((b) => attr(b, "className")?.getText().includes("oc-blockpick__item"));
    expect(attr(row, "data-message-id")?.initializer?.getText()).toBe("{choice.messageId}");
    expect(attr(row, "data-block-index")?.initializer?.getText()).toBe("{choice.blockIndex}");
    const [pick] = callsTo(SF, "onPick");
    expect(pick.arguments.map((a) => a.getText())).toEqual(["choice"]);
    // A row shows as marked when ITS bubble's block is, not the opener's.
    const [marked] = callsTo(SF, "has").filter((c) => /marked/.test(c.expression.getText()));
    expect(marked.arguments.map((a) => a.getText())).toEqual(["blockKey(choice.messageId, choice.blockIndex)"]);
    // An image without alt text is named by a label, never left blank.
    const parent = row.parent as ts.JsxElement;
    expect(parent.getText()).toMatch(/choice\.label !== "" \? choice\.label : m\.block_pick_media_untitled\(\)/);
  });

  const message = fnNamed(CHAT, "AssistantMessage")!;
  const pickers = jsx(message, "BlockPicker");

  test("both lists are the ⋯'s: absent on a bubble continued below, fed by listSources", () => {
    expect(pickers).toHaveLength(2);
    for (const picker of pickers) {
      let up: ts.Node = picker;
      while (!ts.isConditionalExpression(up)) up = up.parent;
      expect(up.condition.getText(), "a picker on a bubble without a ⋯").toMatch(/!groupContinues/);
      expect(attr(picker, "sources")?.initializer?.getText()).toBe("{sources}");
      expect(attr(picker, "messageId")?.initializer?.getText()).toBe("{messageId}");
    }
    const [sources] = callsTo(message, "listSources");
    expect(sources.arguments.map((a) => a.getText())).toEqual(["messageId", "listLive", "groupMembers"]);
    // The marks the bookmark list shows: every bubble it lists, each block by its key.
    const marks = find(message, ts.isVariableDeclaration).find((d) => d.name.getText() === "bookmarkedBlocks");
    expect(marks?.initializer?.getText()).toMatch(/sources\.flatMap\(\(id\) =>[\s\S]*blockKey\(id, b\.blockIndex\)/);
  });

  test("a pick targets the bubble its block belongs to — never the one whose ⋯ opened the list", () => {
    const pick = (kind: string) => {
      const picker = pickers.find((p) => attr(p, "kind")?.initializer?.getText() === `"${kind}"`)!;
      return attr(picker, "onPick")!.initializer!.getText();
    };
    expect(pick("quote")).toMatch(/messageId: choice\.messageId,\s*blockIndex: choice\.blockIndex,/);
    expect(pick("bookmark")).toMatch(/bmApi\.toggle\(choice\.messageId, choice\.blockIndex\)/);
    expect(pick("quote") + pick("bookmark")).not.toMatch(/\{ messageId,|toggle\(messageId/);
  });

  test("the ⋯ offers the lists while a bubble it lists is settled — not only while the last one is", () => {
    const [menu] = jsx(message, "AssistantMoreMenu");
    for (const name of ["onPickBlock", "onPickBookmarkBlock"]) {
      const offered = attr(menu, name)!.initializer!.getText();
      expect(offered, name).toMatch(/sources\.length > 0/);
      expect(offered, name).not.toMatch(/quoteRunning/);
    }
    const items = jsx(fnNamed(CHAT, "AssistantMoreMenu")!, "ActionBarMoreItem").filter((i) =>
      /onPick(Bookmark)?Block/.test(attr(i, "onSelect")?.getText() ?? ""),
    );
    expect(items).toHaveLength(2);
    for (const item of items) expect(attr(item, "disabled"), "the last bubble's stream disables the lists").toBeUndefined();
  });

  test("the gutter offers through the same rule: a block offering nothing gets no row, a block without text no quote", () => {
    const gutter = fnNamed(GUTTER, "BookmarkGutterInner")!;
    const offers = callsTo(gutter, "blockOffer");
    expect(offers).toHaveLength(1);
    expect(offers[0].arguments[0].getText()).toMatch(/^blockFace\(/);
    expect(gutter.getText()).toMatch(/if \(offer === null\) continue;/);
    // The innermost condition around the reply button (pre-order: the outer first).
    const reply = find(gutter, ts.isConditionalExpression)
      .filter((c) => /oc-bmk-gutter--reply/.test(c.whenTrue.getText()))
      .pop();
    expect(reply?.condition.getText()).toBe("onReplyToBlock && hover.quotable");
  });
});
