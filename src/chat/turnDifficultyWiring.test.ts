// WIRING of the live-turn difficulty and of the folded sub-agent failure line.
//
// The decisions are pure and tested on their own (turnDifficulty, turnDifficultyView,
// runStatusView, assistantEmptyState). What those tests cannot see is whether the
// components still CALL them with the live value — a row that stopped reading the
// context, a chip that dropped the argument, a list that stopped rendering the line
// would all pass them. These components need a Convex client and an assistant-ui
// message to render, so the wiring is read from the SYNTAX TREE (TypeScript's own
// parser: comments and strings cannot fake a call), per component.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

function parse(file: string): ts.SourceFile {
  const text = readFileSync(join(process.cwd(), file), "utf-8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** The body of a component: a `function Name(` or `const Name = memo(function Name(`. */
function component(sf: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) &&
      n.name?.text === name
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error(`${name} not found in ${sf.fileName}`);
  return found;
}

/** Every call to `callee` under `root`, as the source text of its arguments. */
function calls(root: ts.Node, callee: string): string[][] {
  const out: string[][] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === callee
    ) {
      out.push(n.arguments.map((a) => a.getText()));
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** Every JSX expression `{name ? … }` / `{name && …}` guard that renders under root. */
function rendersWhen(root: ts.Node, identifier: string): boolean {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (
      ts.isJsxExpression(n) &&
      n.expression !== undefined &&
      ts.isConditionalExpression(n.expression) &&
      n.expression.condition.getText() === identifier
    ) {
      hit = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return hit;
}

describe("the sidebar's activity bar has a struggling state", () => {
  const sf = parse("src/chat/ChatSidebar.tsx");

  test("the sidebar asks about the busy chats and provides the verdicts", () => {
    const body = component(sf, "ChatSidebar");
    expect(calls(body, "useLiveTurnDifficulties")).toEqual([["busyList ?? null"]]);
  });

  test("a row draws its ONE bar from the difficulty, and titles the row with it", () => {
    const row = component(sf, "ChatItem");
    expect(calls(row, "useContext")).toContainEqual(["TurnDifficultyContext"]);
    const bars = calls(row, "busyBarView");
    expect(bars.length).toBeGreaterThan(0);
    for (const args of bars) expect(args[0]).toBe("difficulty");
    expect(calls(row, "turnDifficultyLabel")).toContainEqual(["difficulty"]);
  });

  test("a folded section's aggregate bar takes the same state", () => {
    const section = component(sf, "Section");
    expect(calls(section, "useContext")).toContainEqual(["TurnDifficultyContext"]);
    for (const args of calls(section, "busyBarView")) expect(args[0]).toBe("struggling");
  });
});

describe("the folder page's bars say the same thing", () => {
  const sf = parse("src/chat/ProjectPage.tsx");

  test("the page asks about its busy chats; every chat row draws its bar from the difficulty", () => {
    expect(calls(component(sf, "ProjectPageBody"), "useLiveTurnDifficulties")).toEqual([
      ["busyList ?? null"],
    ]);
    for (const name of ["ChatRow", "TreeChatRow", "ColumnChatEntry"]) {
      const row = component(sf, name);
      expect(calls(row, "useContext"), name).toContainEqual(["TurnDifficultyContext"]);
      const bars = calls(row, "busyBarView");
      expect(bars.length, name).toBeGreaterThan(0);
      for (const args of bars) expect(args[0], name).toBe("difficulty");
    }
  });
});

describe("the streaming bubble's status line", () => {
  test("RunStatus passes the live difficulty of its own message to runStatusView", () => {
    const sf = parse("src/chat/RunStatus.tsx");
    const body = component(sf, "RunStatus");
    expect(calls(body, "useLiveTurnDifficulties")).toHaveLength(1);
    const [args] = calls(body, "runStatusView");
    expect(args?.[6]).toBe("difficulty");
  });
});

describe("the folded list of several sub-agents names an unrecovered failure", () => {
  test("MessageSubAgents computes the line with the recovery facts and renders it", () => {
    const sf = parse("src/chat/SubAgentActivity.tsx");
    const body = component(sf, "MessageSubAgents");
    const [args] = calls(body, "collapsedSubAgentFailure");
    expect(args?.slice(1)).toEqual(["rows ?? []", "messageId", "answeredChildRunIds"]);
    expect(rendersWhen(body, "hiddenFailure")).toBe(true);
  });
});
