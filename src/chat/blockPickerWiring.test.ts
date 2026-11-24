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
    expect(compose.arguments[0].getText()).toBe("bubbles");
    expect(read!.getText()).toMatch(/const bubbles = sources\.map\(\(messageId\) => \(\{ messageId, faces: facesOf\(messageId\) \?\? \[\] \}\)\);/);
    const faces = find(SF, ts.isFunctionDeclaration).find((f) => f.name?.text === "facesOf")!;
    expect(faces.getText()).toMatch(/collectAnchorBlocks\(body\)\.map\(blockFace\)/);
  });

  test("each row names its bubble and its block, and a pick hands over the whole choice", () => {
    const [row] = jsx(SF, "Button").filter((b) => attr(b, "className")?.getText().includes("oc-blockpick__item"));
    expect(attr(row, "data-message-id")?.initializer?.getText()).toBe("{choice.messageId}");
    expect(attr(row, "data-block-index")?.initializer?.getText()).toBe("{choice.blockIndex}");
    // The whole choice — its bubble, its excerpt —, at the index its block has now (lot 22).
    const [pick] = callsTo(SF, "onPick");
    expect(pick.arguments.map((a) => a.getText())).toEqual(["{ ...choice, blockIndex: at }"]);
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
    const locate = fnNamed(GUTTER, "locateBlock")!;
    const offers = callsTo(locate, "blockOffer");
    expect(offers).toHaveLength(1);
    expect(locate.getText()).toMatch(/const faces = blocks\.map\(blockFace\);/);
    expect(offers[0].arguments[0].getText()).toBe("faces[i]!");
    expect(locate.getText()).toMatch(/if \(offer === null\) continue;/);
    const gutter = fnNamed(GUTTER, "BookmarkGutterInner")!;
    expect(callsTo(gutter, "locateBlock").length, "the hover does not go through locateBlock").toBeGreaterThan(0);
    // The innermost condition around the reply button (pre-order: the outer first).
    const reply = find(gutter, ts.isConditionalExpression)
      .filter((c) => /oc-bmk-gutter--reply/.test(c.whenTrue.getText()))
      .pop();
    expect(reply?.condition.getText()).toBe("onReplyToBlock && hover.quotable");
  });
});

// LOT 22: the list is read when it opens, the gutter's row when the pointer comes; the
// bubble can change before the choice — a delegated result inserted before the
// conclusion, a block gone, the reply regenerated. The decision is pure and tested in
// quoteBlocks.test.ts (`resolveChosen`, `pickTarget`); here, that the picker and the
// gutter go through it, and act on nothing when it says so.
describe("a block action lands on the block chosen, or on nothing (lot 22)", () => {
  test("the list keeps what each bubble showed when it was read", () => {
    const read = find(SF, ts.isFunctionDeclaration).find((f) => f.name?.text === "readChoices")!;
    expect(read.getText()).toMatch(/seen: new Map\(bubbles\.map\(\(b\) => \[b\.messageId, b\.faces\.map\(\(face\) => face\.print\)\]\)\)/);
    const reader = find(SF, ts.isVariableDeclaration).find((d) => d.name.getText() === "read")!;
    expect(reader.getText()).toMatch(/seen\.current = list\.seen;/);
  });

  test("a row's pick goes through pickTarget against the bubble as it is now; null does nothing but read the list again and say so", () => {
    const [row] = jsx(SF, "Button").filter((b) => attr(b, "className")?.getText().includes("oc-blockpick__item"));
    expect(attr(row, "onClick")?.initializer?.getText()).toBe("{() => pick(choice)}");
    const pick = find(SF, ts.isVariableDeclaration).find((d) => d.name.getText() === "pick")!;
    const [target] = callsTo(pick, "pickTarget");
    expect(target.arguments.map((a) => a.getText())).toEqual([
      "choice",
      "kind",
      "seen.current.get(choice.messageId) ?? null",
      "facesOf(choice.messageId)?.map((face) => face.print) ?? null",
      "marked",
    ]);
    // Null: the list read again, the notice, and NOTHING more — the return comes
    // before any action.
    const body = pick.getText();
    const refusal = /if \(at === null\) \{\s*read\(\);\s*announcer\.say\(m\.block_pick_changed\(\)\);\s*return;\s*\}/.exec(body);
    expect(refusal, "a refused pick does more than read the list again").not.toBeNull();
    expect(body.indexOf("onPick(")).toBeGreaterThan(refusal!.index + refusal![0].length);
    expect(callsTo(pick, "onPick")[0].arguments[0].getText()).toBe("{ ...choice, blockIndex: at }");
    // The notice: said through the status region (lot 23, below) — and the action's
    // own refusal too (lot 24, below).
    expect(callsTo(pick, "say").map((c) => c.arguments.map((a) => a.getText()).join())).toEqual([
      "m.block_pick_changed()",
      "refused",
    ]);
  });

  test("the gutter acts on the block its row still stands by, or on nothing — the row then moves", () => {
    const still = fnNamed(GUTTER, "stillHovered")!;
    const [resolve] = callsTo(still, "resolveChosen");
    expect(resolve.arguments.map((a) => a.getText())).toEqual(["hover", "hover.seen", "blocks.map(blockPrint)"]);
    expect(still.getText()).toMatch(/if \(at !== hover\.blockIndex\) return null;/);
    expect(still.getText()).toMatch(/Math\.abs\(top - hover\.top\) < 1 \? at : null/);
    const gutter = fnNamed(GUTTER, "BookmarkGutterInner")!;
    const clicks = jsx(gutter, "button")
      .map((b) => attr(b, "onClick")?.initializer?.getText() ?? "")
      .filter((t) => /stillHovered/.test(t));
    expect(clicks, "both gutter buttons check the block first").toHaveLength(2);
    for (const click of clicks) {
      // Nothing done, the row moved — and, since lot 24, the person told so: a
      // refused click is no longer silent (refuseMoved, below).
      expect(click).toMatch(/const at = stillHovered\(body, hover\);\s*if \(at === null\) \{\s*refuseMoved\(e\.clientY, hover\.top\);\s*return;\s*\}/);
      expect(click).not.toMatch(/hover\.blockIndex/);
    }
    const moved = find(gutter, ts.isVariableDeclaration).find((d) => d.name.getText() === "refuseMoved")!;
    expect(moved.getText()).toMatch(/const next = locateBlock\(body, clientY\);\s*setHover\(next\);\s*refuse\(m\.block_gutter_changed\(\), next\?\.top \?\? top\);/);
    expect(clicks.join("\n")).toMatch(/bmApi\.toggle\(messageId, at\)/);
    expect(clicks.join("\n")).toMatch(/onReplyToBlock\(at, excerpt\)/);
  });
});

// LOT 23: a block is known by its EXACT print (bookmarkView.test.ts: what it covers and
// leaves out) and the rule of identity (quoteBlocks.test.ts: `resolveChosen`); what a
// screen reader hears of a refusal is in src/lib/liveStatus.test.ts. Here, that the
// picker and the gutter read prints from the one place, and that the status region is
// on the page, empty, from the list's opening, every refusal said through it.
describe("a block's identity, and every refusal heard (lot 23)", () => {
  const VIEW = source("bookmarkView.ts");

  test("one print for the lists and the gutter: blockPrint, which the face carries", () => {
    const face = fnNamed(VIEW, "blockFace")!;
    expect(face.getText()).toMatch(/print: blockPrint\(block\),/);
    const locate = fnNamed(GUTTER, "locateBlock")!;
    expect(locate.getText()).toMatch(/const seen = faces\.map\(\(face\) => face\.print\);/);
    // No print of its own anywhere else: the lists' module only reads the face's.
    const LISTS = source("quoteBlocks.ts");
    expect(fnNamed(LISTS, "blockPrint"), "a second print in quoteBlocks.ts").toBeUndefined();
    expect(LISTS.getText()).toMatch(/print: face\.print/);
  });

  test("the status region is always on the list, its content the announcer's", () => {
    const regions = jsx(SF, "p").filter((p) => attr(p, "role")?.initializer?.getText() === '"status"');
    expect(regions).toHaveLength(1);
    // Not behind a condition: rendered with the list, empty until a refusal.
    let up: ts.Node = regions[0]!;
    while (!ts.isJsxElement(up)) up = up.parent;
    for (let n: ts.Node = up.parent; !ts.isSourceFile(n); n = n.parent) {
      expect(ts.isConditionalExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken), "the region behind a condition").toBe(false);
      if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === "DialogContent") break;
    }
    expect((up as ts.JsxElement).children.map((c) => c.getText().trim()).filter((t) => t !== "")).toEqual(["{status}"]);
    const announcer = find(SF, ts.isVariableDeclaration).find((d) => d.name.getText() === "announcer")!;
    expect(announcer.initializer?.getText()).toBe("useMemo(() => liveStatus(setStatus, windowSchedule), [])");
  });

  test("empty, the region is out of the flow — present for a screen reader, no gap in the dialog", () => {
    const css = readFileSync(join(process.cwd(), "src/chat/convexChat.css"), "utf-8");
    const rule = /\.oc-blockpick__changed:empty \{([^}]*)\}/.exec(css);
    expect(rule, "no rule for the empty region").not.toBeNull();
    expect(rule![1]).toMatch(/position: absolute;/);
    expect(rule![1]).toMatch(/clip: rect\(0, 0, 0, 0\);/);
    // Out of the flow, never removed from it: display none would take it out of the
    // accessibility tree, and a region must be there before its message.
    expect(rule![1]).not.toMatch(/display: none|visibility: hidden/);
  });

  test("every opening empties it first, and a refusal is the only thing that fills it", () => {
    const effect = callsTo(SF, "useEffect").find((c) => /read\(\);/.test(c.getText()) && /picked\.current = false/.test(c.getText()))!;
    expect(effect.arguments[0].getText()).toMatch(/^\(\) => \{\s*announcer\.clear\(\);\s*if \(open\) \{/);
    expect(effect.arguments[1]?.getText()).toBe("[open, read, announcer]");
    // Two says, both refusals: a block changed (lot 23), the action refused (lot 24).
    const says = callsTo(SF, "say");
    expect(says).toHaveLength(2);
    for (const say of says) {
      let up: ts.Node = say;
      while (!ts.isIfStatement(up)) up = up.parent;
      expect(up.expression.getText()).toMatch(/^(at === null|refused !== null)$/);
    }
    expect(callsTo(SF, "setStatus")).toHaveLength(0);
  });
});

// LOT 24: every refused block action is said, on every surface — the lists in their
// dialog, the gutter beside its row —, through a status region on the page before it
// speaks, each refusal announced anew (src/lib/liveStatus.test.ts). What each refusal
// says and the bookmark toggle's outcome are pure (blockRefusals.test.ts). Here: the
// regions, and that no refusal branch of a block action returns without saying it — a
// structural guard over every early return of the handlers, so a new silent branch
// fails the suite.
describe("every refused block action is said, on every surface (lot 24)", () => {
  const gutter = fnNamed(GUTTER, "BookmarkGutterInner")!;
  const message = fnNamed(CHAT, "AssistantMessage")!;
  const pickers = jsx(message, "BlockPicker");
  const clicks = () =>
    jsx(gutter, "button")
      .map((b) => attr(b, "onClick")?.initializer)
      .filter((init): init is ts.JsxExpression => init !== undefined && /stillHovered/.test(init.getText()))
      .map((init) => init.expression as ts.ArrowFunction);
  /** The returns of a handler that are its own (not those of a callback inside it). */
  const ownReturns = (fn: ts.FunctionLikeDeclaration) =>
    find(fn, ts.isReturnStatement).filter((r) => {
      let up: ts.Node = r.parent;
      while (!ts.isFunctionLike(up)) up = up.parent;
      return up === fn;
    });
  /** The statement before a return, in its block. */
  const before = (r: ts.ReturnStatement) => {
    const block = r.parent as ts.Block;
    return block.statements[block.statements.indexOf(r) - 1]?.getText() ?? "";
  };

  test("the gutter's status region is in the bubble from the start, its content the announcer's", () => {
    const regions = jsx(gutter, "p").filter((p) => attr(p, "role")?.initializer?.getText() === '"status"');
    expect(regions).toHaveLength(1);
    expect(attr(regions[0]!, "className")?.initializer?.getText()).toBe('"oc-bmk-status"');
    expect(attr(regions[0]!, "style")?.initializer?.getText()).toBe("{{ top: statusTop }}");
    // Rendered with the portal, not behind the row's condition nor any other.
    let up: ts.Node = regions[0]!;
    while (!ts.isJsxElement(up)) up = up.parent;
    expect((up as ts.JsxElement).children.map((c) => c.getText().trim()).filter((t) => t !== "")).toEqual(["{status}"]);
    for (let n: ts.Node = up.parent; !ts.isCallExpression(n); n = n.parent) {
      expect(ts.isConditionalExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken), "the region behind a condition").toBe(false);
    }
    const portal = callsTo(gutter, "createPortal")[0]!;
    expect(portal.getText()).toContain('className="oc-bmk-status"');
    const announcer = find(gutter, ts.isVariableDeclaration).find((d) => d.name.getText() === "announcer")!;
    expect(announcer.initializer?.getText()).toBe("useMemo(() => liveStatus(setStatus, windowSchedule), [])");
    expect(gutter.getText()).toMatch(/useEffect\(\(\) => \(\) => announcer\.clear\(\), \[announcer\]\);/);
    const refuse = find(gutter, ts.isVariableDeclaration).find((d) => d.name.getText() === "refuse")!;
    expect(refuse.getText()).toMatch(/setStatusTop\(top\);\s*announcer\.say\(text, GUTTER_STATUS_HOLD_MS\);/);
    // Visible where the person looks: under the row's line, above it when the
    // thread's visible bottom is too close (the composer would hide it).
    expect(refuse.getText()).toMatch(/const room = viewport === null \? Infinity : viewport\.getBoundingClientRect\(\)\.bottom - rowAt;\s*setStatusAbove\(room < GUTTER_STATUS_ROOM_PX\);/);
    expect(attr(regions[0]!, "data-above")?.initializer?.getText()).toBe("{statusAbove || undefined}");
    const css = readFileSync(join(process.cwd(), "src/chat/convexChat.css"), "utf-8");
    expect(css).toMatch(/\.oc-bmk-status \{[^}]*transform: translateY\(1\.6rem\);/);
    expect(css).toMatch(/\.oc-bmk-status\[data-above\] \{\s*transform: translateY\(calc\(-100% - 0\.25rem\)\);\s*\}/);
  });

  test("no gutter refusal is silent: every early return of its two handlers comes right after the refusal is said", () => {
    const handlers = clicks();
    expect(handlers, "the reply and the bookmark buttons").toHaveLength(2);
    for (const handler of handlers) {
      const returns = ownReturns(handler);
      expect(returns.length, handler.getText().slice(0, 80)).toBeGreaterThan(0);
      for (const r of returns) expect(before(r), "a silent return").toMatch(/^refuse(Moved)?\(/);
    }
  });

  test("the gutter says the action's own refusal: a quote past the bounds, a bookmark refused", () => {
    const [reply, bookmark] = clicks();
    expect(reply!.getText()).toMatch(/const refused = onReplyToBlock\(at, excerpt\);\s*if \(refused !== null\) refuse\(refused, hover\.top\);\s*else announcer\.clear\(\);/);
    expect(bookmark!.getText()).toMatch(/void bmApi\.toggle\(messageId, at\)\.then\(\(outcome\) => \{\s*const refused = bookmarkRefusalText\(outcome\);\s*if \(refused !== null\) refuse\(refused, top\);\s*else announcer\.clear\(\);\s*\}\);/);
  });

  test("no list refusal is silent: every early return of a pick says why, but the one waiting for a pick in flight", () => {
    const pick = find(SF, ts.isVariableDeclaration).find((d) => d.name.getText() === "pick")!;
    const fn = pick.initializer as ts.ArrowFunction;
    for (const r of ownReturns(fn)) {
      const guard = ts.isIfStatement(r.parent) ? r.parent : r.parent.parent;
      // The one exception: a second pick while the first is acted on. The list says it
      // is busy (aria-busy), and the first pick's own outcome is said or done.
      if (ts.isIfStatement(guard) && guard.expression.getText() === "acting.current") continue;
      expect(before(r), "a silent return").toMatch(/^announcer\.say\(/);
    }
    expect(fn.getText()).toMatch(/refused = await onPick\(\{ \.\.\.choice, blockIndex: at \}\);/);
    expect(fn.getText()).toMatch(/if \(refused !== null\) \{\s*read\(\);\s*announcer\.say\(refused\);\s*return;\s*\}\s*picked\.current = true;\s*onOpenChange\(false\);/);
    const [list] = jsx(SF, "div").filter((d) => attr(d, "className")?.initializer?.getText() === '"oc-blockpick__list"');
    expect(attr(list!, "aria-busy")?.initializer?.getText()).toBe("{busy || undefined}");
  });

  test("the lists and the gutter are handed every refusal: quotes past the bounds, bookmarks refused", () => {
    const stage = find(message, ts.isVariableDeclaration).find((d) => d.name.getText() === "stageQuote")!;
    expect(stage.getText()).toMatch(/quoteRefusalText\(addPendingQuote\(chatId, quote\)\)/);
    expect(stage.getText()).not.toMatch(/Toast/);
    const onPick = (kind: string) => {
      const picker = pickers.find((p) => attr(p, "kind")?.initializer?.getText() === `"${kind}"`)!;
      return (attr(picker, "onPick")!.initializer as ts.JsxExpression).expression as ts.ArrowFunction;
    };
    // An expression body: what the action returns is what the list says.
    expect(ts.isCallExpression(onPick("quote").body) && onPick("quote").body.getText().startsWith("stageQuote(")).toBe(true);
    expect(onPick("bookmark").body.getText()).toBe("bmApi.toggle(choice.messageId, choice.blockIndex).then(bookmarkRefusalText)");
    const [gutterJsx] = jsx(message, "BookmarkGutter");
    expect(attr(gutterJsx!, "onReplyToBlock")!.initializer!.getText()).toMatch(/\(blockIndex, excerpt\) =>\s*stageQuote\(quoteChatId, \{/);
    // The header's whole-message quote is not a block action: its refusal stays a toast.
    expect(message.getText()).toMatch(/const refused = stageQuote\(quoteChatId, \{\s*messageId,\s*blockIndex: null,\s*excerpt,\s*\}\);\s*if \(refused !== null\) quoteAddToast\.error\(refused\);/);
  });

  test("the bookmark toggle returns how it ended — the server's refusal and an admin's view of another account included", () => {
    const provider = fnNamed(GUTTER, "BookmarksProvider")!;
    expect(provider.getText()).toMatch(/useQuery\(api\.me\.getImpersonation\)/);
    expect(provider.getText()).toMatch(/const impersonating = impersonation\?\.impersonating === true;/);
    const [outcome] = callsTo(provider, "bookmarkToggleOutcome");
    expect(outcome!.arguments[0]!.getText()).toBe("impersonating");
    expect(outcome!.arguments[1]!.getText()).toMatch(/^\(\) =>\s*toggleMut\(/);
  });

  test("empty, the gutter's region is out of sight and out of the flow — never removed from the page", () => {
    const css = readFileSync(join(process.cwd(), "src/chat/convexChat.css"), "utf-8");
    const base = /\.oc-bmk-status \{([^}]*)\}/.exec(css);
    const empty = /\.oc-bmk-status:empty \{([^}]*)\}/.exec(css);
    expect(base?.[1]).toMatch(/position: absolute;/);
    expect(empty?.[1]).toMatch(/clip: rect\(0, 0, 0, 0\);/);
    for (const rule of [base![1], empty![1]]) expect(rule).not.toMatch(/display: none|visibility: hidden/);
  });
});
