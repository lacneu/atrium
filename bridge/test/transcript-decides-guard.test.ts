// I5 — ON A PROJECTED SESSION, NO TURN ENDS ON A TIMER OR ON THE WORDS OF AN ANSWER
// (transcript redesign phase 4, design §4.4 / §11.3).
//
// A guard that reads source as TEXT is a false guard (lesson of the inbound-attachment
// lot: three text guards fell one after the other). These rules walk the TypeScript
// SYNTAX TREE and refuse what they cannot read (a computed wait name, a call they cannot
// place):
//   1. a deadline is written only by `arm` and `armRecv` (no side door around the gate);
//   2. `arm` opens with THE gate: `if (this.transcriptDecides && TRANSCRIPT_DECIDED_WAITS
//      .has(name)) return;`;
//   3. every wait `arm` is asked for is named by a literal, and is either one the
//      transcript now decides or one of the §8.2 nets — and the decided set is exactly
//      the armed waits minus the nets, so a NEW wait must be classified to compile green;
//   4. the prose rule (`isPrivateAck`) is reachable only when the transcript does not
//      decide (`!this.transcriptDecides && …` or `this.transcriptDecides || …`);
//   5. the positional transcript recovery is refused first thing on a projected turn;
//   6. the orphan poll (`scheduleOrphanRecovery`) runs only in the `else` of
//      `if (this.runManager.projectionOn)`;
//   7. the Convex planner that places rows reads no clock, no timer and no pattern.

import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { TRANSCRIPT_DECIDED_WAITS } from "../src/providers/openclaw/normalizer.js";

const SRC = new URL("../src/", import.meta.url);
const NORMALIZER = new URL("providers/openclaw/normalizer.ts", SRC).pathname;
const SESSION = new URL("session.ts", SRC).pathname;
const PLANNER = new URL("../../convex/lib/bubbleProjection.ts", SRC).pathname;

/** The §8.2 nets that stay armed on a projected turn: the silence budget is `armRecv`'s
 *  (a READ, never an end), the human waits are the gateway's own deadlines. */
const NETS = new Set(["approval_wait", "question_wait", "human_beat"]);

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

function enclosingMethod(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p)) {
      return p.name.getText();
    }
  }
  return null;
}

/** `this.<name>` */
const isThisProp = (n: ts.Node, name: string): boolean =>
  ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword && n.name.text === name;

/** `!this.<name>` */
const isNotThisProp = (n: ts.Node, name: string): boolean =>
  ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken && isThisProp(n.operand, name);

/** The conjuncts of an `a && b && c` chain (parentheses stripped). */
function conjuncts(n: ts.Node): ts.Node[] {
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...conjuncts(n.left), ...conjuncts(n.right)];
  }
  return [n];
}

/** The method/getter declarations of the Normalizer class, by name. */
function members(sf: ts.SourceFile): Map<string, ts.MethodDeclaration | ts.GetAccessorDeclaration> {
  const out = new Map<string, ts.MethodDeclaration | ts.GetAccessorDeclaration>();
  walk(sf, (n) => {
    if (
      (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n)) &&
      ts.isClassDeclaration(n.parent) &&
      n.parent.name?.text === "Normalizer"
    ) {
      out.set(n.name.getText(), n);
    }
  });
  return out;
}

describe("I5 — the normalizer cannot end a projected turn on a timer or on prose", () => {
  const sf = parse(NORMALIZER);
  const methods = members(sf);

  it("1. a deadline is written only by `arm` and `armRecv`", () => {
    const writers: string[] = [];
    walk(sf, (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "set" &&
        isThisProp(n.expression.expression, "deadlines")
      ) {
        writers.push(enclosingMethod(n) ?? "<outside a method>");
      }
    });
    expect(writers.length).toBeGreaterThan(0);
    expect([...new Set(writers)].sort()).toEqual(["arm", "armRecv"]);
  });

  it("2. `arm` opens with the gate", () => {
    const arm = methods.get("arm");
    expect(arm, "arm() not found").toBeDefined();
    const param = (arm as ts.MethodDeclaration).parameters[0]!.name.getText();
    const first = (arm as ts.MethodDeclaration).body!.statements[0]!;
    expect(ts.isIfStatement(first)).toBe(true);
    const cond = (first as ts.IfStatement).expression;
    const parts = conjuncts(cond);
    expect(parts).toHaveLength(2);
    expect(isThisProp(parts[0]!, "transcriptDecides")).toBe(true);
    const has = parts[1]!;
    expect(
      ts.isCallExpression(has) &&
        ts.isPropertyAccessExpression(has.expression) &&
        has.expression.expression.getText() === "TRANSCRIPT_DECIDED_WAITS" &&
        has.expression.name.text === "has" &&
        has.arguments.length === 1 &&
        has.arguments[0]!.getText() === param,
    ).toBe(true);
    const then = (first as ts.IfStatement).thenStatement;
    expect(ts.isReturnStatement(then) && then.expression === undefined).toBe(true);
  });

  it("3. every armed wait is named, and classified: decided by the transcript, or a §8.2 net", () => {
    const armed = new Set<string>();
    const unreadable: string[] = [];
    walk(sf, (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        isThisProp(n.expression, "arm")
      ) {
        const name = n.arguments[0];
        if (name !== undefined && ts.isStringLiteral(name)) armed.add(name.text);
        else unreadable.push(n.getText().slice(0, 60));
      }
    });
    expect(unreadable, "a wait name the guard cannot read").toEqual([]);
    const decided = [...armed].filter((w) => !NETS.has(w)).sort();
    expect(decided).toEqual([...TRANSCRIPT_DECIDED_WAITS].sort());
  });

  it("4. the prose rule is reachable only when the transcript does not decide", () => {
    const unguarded: string[] = [];
    let calls = 0;
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || n.expression.getText() !== "isPrivateAck") return;
      calls++;
      let guarded = false;
      let child: ts.Node = n;
      for (let p = n.parent; p !== undefined && !ts.isStatement(p); child = p, p = p.parent) {
        if (!ts.isBinaryExpression(p) || p.right !== child) continue;
        const op = p.operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken &&
          conjuncts(p.left).some((c) => isNotThisProp(c, "transcriptDecides"))
        ) {
          guarded = true;
        }
        if (op === ts.SyntaxKind.BarBarToken && isThisProp(p.left, "transcriptDecides")) guarded = true;
      }
      if (!guarded) unguarded.push(`${enclosingMethod(n)}: ${n.parent.getText().slice(0, 80)}`);
    });
    expect(calls).toBeGreaterThan(0);
    expect(unguarded).toEqual([]);
  });

  it("5. the positional transcript recovery is refused first on a projected turn", () => {
    const getter = methods.get("wantsHistoryRecovery") as ts.GetAccessorDeclaration;
    const ret = getter.body!.statements[0]!;
    expect(ts.isReturnStatement(ret)).toBe(true);
    const parts = conjuncts((ret as ts.ReturnStatement).expression!);
    expect(isNotThisProp(parts[0]!, "transcriptDecides")).toBe(true);
  });
});

describe("I5 — the session never polls an orphan on a projected session", () => {
  it("6. `scheduleOrphanRecovery` runs only in the else of `if (this.runManager.projectionOn)`", () => {
    const sf = parse(SESSION);
    const calls: Array<{ guarded: boolean; at: string }> = [];
    walk(sf, (n) => {
      if (
        !ts.isCallExpression(n) ||
        !ts.isPropertyAccessExpression(n.expression) ||
        n.expression.name.text !== "scheduleOrphanRecovery"
      ) {
        return;
      }
      let guarded = false;
      let child: ts.Node = n;
      for (let p = n.parent; p !== undefined; child = p, p = p.parent) {
        if (
          ts.isIfStatement(p) &&
          p.elseStatement === child &&
          p.expression.getText() === "this.runManager.projectionOn"
        ) {
          guarded = true;
          break;
        }
        if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) break;
      }
      calls.push({ guarded, at: `line ${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}` });
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !c.guarded)).toEqual([]);
  });
});

describe("I5 — the Convex planner places rows by identity only", () => {
  it("7. no clock, no timer, no pattern in convex/lib/bubbleProjection.ts", () => {
    const sf = parse(PLANNER);
    const found: string[] = [];
    walk(sf, (n) => {
      if (ts.isRegularExpressionLiteral(n)) found.push(`regex ${n.getText()}`);
      if (ts.isIdentifier(n) && ["Date", "setTimeout", "setInterval", "RegExp", "performance"].includes(n.text)) {
        found.push(n.text);
      }
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ["match", "test", "search", "includes", "startsWith", "endsWith", "indexOf"].includes(
          n.expression.name.text,
        )
      ) {
        // `includes` on a list of ids would be identity, on text it would be prose: the
        // planner has no such call at all, which is the simplest rule to hold.
        found.push(`.${n.expression.name.text}(`);
      }
    });
    expect(found).toEqual([]);
  });
});
