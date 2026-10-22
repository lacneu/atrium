// I5 — NO TURN OF AN OPENCLAW SESSION ENDS ON A TIMER OR ON THE WORDS OF AN ANSWER
// (transcript redesign phase 4, design §4.4 / §11.3; the switch is gone since 0.102.0).
//
// A guard that reads source as TEXT is a false guard (lesson of the inbound-attachment
// lot: three text guards fell one after the other). These rules walk the TypeScript
// SYNTAX TREE and refuse what they cannot read (a computed wait name, a call they cannot
// place):
//   1. a deadline is written only by `arm` and `armRecv` (no side door);
//   2. every wait `arm` is asked for is named by a literal, and is one of the §8.2 nets
//      (the human waits) — a NEW wait must be classified to compile green;
//   3. the tick resolves only those nets and the silence budget (`recv`);
//   4. the session reads no transcript positionally: no `sessions.get`, nothing from the
//      `history-recovery` readers (the `/lossless` route's own concern, server.ts);
//   5. a socket that closes mid-turn, and a silence, never END the turn in the session
//      loop (no `endTurn` under `if (winner.done)` nor under the recv-silence branch);
//   6. the Convex planner that places rows reads no clock, no timer and no pattern;
//   7. NO FILE FROM THE LIVE SIDE (final design step 4): every `addMedia` call site of
//      bridge/src is known — the normalizer produces no media event at all, the sink's
//      and the lane's uploads consume only that event, the outbound scan runs only under
//      `!this.liveFilesOff`, `liveFilesOff` is set once (true) by the RunManager for its
//      sink, and the session attaches nothing. The operator's `/deliver-media` repair is
//      the one named exception: an explicit human act, not the live stream.

import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url);
const NORMALIZER = new URL("providers/openclaw/normalizer.ts", SRC).pathname;
const SESSION = new URL("session.ts", SRC).pathname;
const PLANNER = new URL("../../convex/lib/bubbleProjection.ts", SRC).pathname;
const TURN_SINK = new URL("core/turn-sink.ts", SRC).pathname;
const RUN_MANAGER = new URL("providers/openclaw/run-manager.ts", SRC).pathname;
const OUTBOUND_SCAN = new URL("core/outbound-scan.ts", SRC).pathname;
const SERVER = new URL("server.ts", SRC).pathname;

/** The §8.2 nets: the silence budget is `armRecv`'s (a READ, never an end), the human
 *  waits are the gateway's own deadlines. */
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

describe("I5 — the normalizer cannot end a turn on a timer", () => {
  const sf = parse(NORMALIZER);

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

  it("2. every armed wait is named by a literal, and is a §8.2 net", () => {
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
    expect(armed.size).toBeGreaterThan(0);
    expect([...armed].filter((w) => !NETS.has(w))).toEqual([]);
  });

  it("3. the tick resolves only the nets and the silence budget", () => {
    const tick = members(sf).get("tickAt");
    expect(tick, "tickAt() not found").toBeDefined();
    const resolved = new Set<string>();
    const unreadable: string[] = [];
    walk(tick!, (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "has" &&
        n.expression.expression.getText() === "expired"
      ) {
        const name = n.arguments[0];
        if (name !== undefined && ts.isStringLiteral(name)) resolved.add(name.text);
        else unreadable.push(n.getText().slice(0, 60));
      }
    });
    expect(unreadable).toEqual([]);
    expect(resolved.has("recv")).toBe(true);
    expect([...resolved].filter((w) => w !== "recv" && !NETS.has(w))).toEqual([]);
  });
});

describe("I5 — the session never reads the transcript by position, nor ends a turn on a close or a silence", () => {
  const sf = parse(SESSION);

  it("4. no `sessions.get`, nothing from the positional readers", () => {
    const found: string[] = [];
    walk(sf, (n) => {
      if (ts.isStringLiteral(n) && n.text === "sessions.get") found.push("sessions.get");
      if (
        ts.isImportDeclaration(n) &&
        ts.isStringLiteral(n.moduleSpecifier) &&
        n.moduleSpecifier.text.includes("history-recovery")
      ) {
        found.push(n.moduleSpecifier.text);
      }
    });
    expect(found).toEqual([]);
  });

  it("5. no `endTurn` under the close (`winner.done`) nor under the recv-silence branch", () => {
    const branches: ts.IfStatement[] = [];
    walk(sf, (n) => {
      if (!ts.isIfStatement(n)) return;
      const cond = n.expression.getText();
      if (cond === "winner.done" || cond.startsWith("this.runManager.takeRecvSilence()")) branches.push(n);
    });
    expect(branches).toHaveLength(2);
    const ends: string[] = [];
    for (const b of branches) {
      walk(b.thenStatement, (n) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "endTurn") {
          ends.push(b.expression.getText().slice(0, 40));
        }
      });
    }
    expect(ends).toEqual([]);
  });
});

describe("I5 — the Convex planner places rows by identity only", () => {
  it("6. no clock, no timer, no pattern in convex/lib/bubbleProjection.ts", () => {
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

describe("I5 — no file from the live side (final design step 4)", () => {
  /** Every `x.addMedia(…)` / `x.addMedia?.(…)` call of a file, with its enclosing chain. */
  function addMediaCalls(sf: ts.SourceFile): ts.CallExpression[] {
    const out: ts.CallExpression[] = [];
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "addMedia") {
        out.push(n);
      }
    });
    return out;
  }

  /** The conditions of the `if`s whose THEN branch holds `node` (innermost first). */
  function thenConditions(node: ts.Node): ts.Expression[] {
    const out: ts.Expression[] = [];
    let child: ts.Node = node;
    for (let p = node.parent; p !== undefined; child = p, p = p.parent) {
      if (ts.isIfStatement(p) && p.thenStatement === child) out.push(p.expression);
    }
    return out;
  }

  /** The `case` labels of the switch clauses holding `node`. */
  function caseLabels(node: ts.Node): string[] {
    const out: string[] = [];
    for (let p = node.parent; p !== undefined; p = p.parent) {
      if (ts.isCaseClause(p)) out.push(p.expression.getText());
    }
    return out;
  }

  const SOURCE_FILES = (() => {
    const dir = new URL("../src/", import.meta.url).pathname;
    const files: string[] = [];
    const visit = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = `${d}${e.name}`;
        if (e.isDirectory()) visit(`${full}/`);
        else if (e.name.endsWith(".ts")) files.push(full);
      }
    };
    visit(dir);
    return files;
  })();

  it("7a. the addMedia call sites of bridge/src are exactly the known ones", () => {
    const sites: string[] = [];
    for (const f of SOURCE_FILES) {
      const sf = parse(f);
      const n = addMediaCalls(sf).length;
      for (let i = 0; i < n; i++) sites.push(f.slice(f.indexOf("/src/") + 5));
    }
    expect(sites.sort()).toEqual(
      [
        "core/outbound-scan.ts",
        "core/turn-sink.ts",
        "server.ts",
      ].sort(),
    );
  });

  it("7b. the normalizer produces no media event at all", () => {
    const sf = parse(NORMALIZER);
    const producers: string[] = [];
    walk(sf, (n) => {
      if (
        ts.isPropertyAssignment(n) &&
        n.name.getText() === "type" &&
        (n.initializer.getText() === "EVENT_MEDIA" || n.initializer.getText() === '"media"')
      ) {
        producers.push(enclosingMethod(n) ?? "<outside a method>");
      }
    });
    expect(producers).toEqual([]);
  });

  it("7c. the sink uploads only a media event, and scans the outbound directory only under `!this.liveFilesOff`", () => {
    const sf = parse(TURN_SINK);
    const calls = addMediaCalls(sf);
    expect(calls).toHaveLength(1);
    expect(caseLabels(calls[0]!)).toContain('"media"');
    const scans: ts.Node[] = [];
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && isThisProp(n.expression, "outboundScan")) scans.push(n);
    });
    expect(scans).toHaveLength(1);
    const guarded = thenConditions(scans[0]!).some((c) => conjuncts(c).some((p) => isNotThisProp(p, "liveFilesOff")));
    expect(guarded).toBe(true);
    // scanAndHostOutbound is the only uploader of the scan, called by no other module.
    const scanCallers = SOURCE_FILES.filter((f) => f !== OUTBOUND_SCAN && readFileSync(f, "utf-8").includes("scanAndHostOutbound("));
    for (const f of scanCallers) {
      const sfc = parse(f);
      walk(sfc, (n) => {
        if (ts.isCallExpression(n) && n.expression.getText() === "scanAndHostOutbound") {
          // Wired as the sink's `outboundScan` dependency only (an arrow handed to it).
          let p: ts.Node | undefined = n.parent;
          while (p !== undefined && !ts.isArrowFunction(p) && !ts.isFunctionExpression(p)) p = p.parent;
          expect(p, `${f}: scanAndHostOutbound called outside the sink's dependency`).toBeDefined();
        }
      });
    }
  });

  it("7d. the run manager uploads nothing (a closed run's lane included), and the sink's gate is set once, on", () => {
    const sf = parse(RUN_MANAGER);
    expect(addMediaCalls(sf)).toEqual([]);
    // `liveFilesOff` is written once: `true`, on the RunManager's own sink, at construction.
    const writes: string[] = [];
    walk(sf, (n) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === "liveFilesOff"
      ) {
        let m: ts.Node | undefined = n.parent;
        while (m !== undefined && !ts.isMethodDeclaration(m) && !ts.isConstructorDeclaration(m)) m = m.parent;
        const where =
          m === undefined ? "<outside>" : ts.isConstructorDeclaration(m) ? "constructor" : m.name.getText();
        writes.push(`${where}:${n.left.expression.getText()}=${n.right.getText()}`);
      }
    });
    expect(writes).toEqual(["constructor:this.sink=true"]);
  });

  it("7e. the session attaches no file", () => {
    expect(addMediaCalls(parse(SESSION))).toEqual([]);
  });

  it("7f. the server's only addMedia is the operator's `/deliver-media` repair", () => {
    const sf = parse(SERVER);
    const calls = addMediaCalls(sf);
    expect(calls).toHaveLength(1);
    // It lies in the THEN branch of `if (req.url === "/deliver-media")`.
    const conds = thenConditions(calls[0]!).map((c) => c.getText());
    expect(conds).toContain('req.url === "/deliver-media"');
  });
});
