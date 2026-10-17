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
//   7. the Convex planner that places rows reads no clock, no timer and no pattern;
//   8. NO FILE FROM THE LIVE SIDE while `on` (final design step 4, refonte-finale-
//      conception.md): every `addMedia` call site of bridge/src is known and each one is
//      unreachable while the instance is `on` — the normalizer's only media producer
//      (`collectMedia`) opens with `if (this.liveFilesOff) return;`, the sink's and the
//      lane's uploads consume only that event, the outbound scan runs only under
//      `!this.liveFilesOff`, the sub-agent's delivered media only under
//      `!this.runManager.projectionOn`, and `liveFilesOff` follows the switch
//      (RunManager.setProjection). The operator's `/deliver-media` repair is the one
//      named exception: an explicit human act, not the live stream.

import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { TRANSCRIPT_DECIDED_WAITS } from "../src/providers/openclaw/normalizer.js";

const SRC = new URL("../src/", import.meta.url);
const NORMALIZER = new URL("providers/openclaw/normalizer.ts", SRC).pathname;
const SESSION = new URL("session.ts", SRC).pathname;
const PLANNER = new URL("../../convex/lib/bubbleProjection.ts", SRC).pathname;
const TURN_SINK = new URL("core/turn-sink.ts", SRC).pathname;
const RUN_MANAGER = new URL("providers/openclaw/run-manager.ts", SRC).pathname;
const OUTBOUND_SCAN = new URL("core/outbound-scan.ts", SRC).pathname;
const SERVER = new URL("server.ts", SRC).pathname;

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

describe("I5 — no file from the live side while `on` (final design step 4)", () => {
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

  it("8a. the addMedia call sites of bridge/src are exactly the known ones", () => {
    const sites: string[] = [];
    for (const f of SOURCE_FILES) {
      const sf = parse(f);
      for (const c of addMediaCalls(sf)) sites.push(f.slice(f.indexOf("/src/") + 5));
    }
    expect(sites.sort()).toEqual(
      [
        "core/outbound-scan.ts",
        "core/turn-sink.ts",
        "providers/openclaw/run-manager.ts",
        "server.ts",
        "session.ts",
      ].sort(),
    );
  });

  it("8b. the normalizer's only media producer opens with the live-files gate", () => {
    const sf = parse(NORMALIZER);
    const producers: string[] = [];
    walk(sf, (n) => {
      if (
        ts.isPropertyAssignment(n) &&
        n.name.getText() === "type" &&
        n.initializer.getText() === "EVENT_MEDIA"
      ) {
        producers.push(enclosingMethod(n) ?? "<outside a method>");
      }
    });
    expect(producers).toEqual(["collectMedia"]);
    const collect = members(sf).get("collectMedia") as ts.MethodDeclaration;
    const first = collect.body!.statements[0]!;
    expect(ts.isIfStatement(first)).toBe(true);
    expect(isThisProp((first as ts.IfStatement).expression, "liveFilesOff")).toBe(true);
    const then = (first as ts.IfStatement).thenStatement;
    expect(ts.isReturnStatement(then) && then.expression === undefined).toBe(true);
  });

  it("8c. the sink uploads only a media event, and scans the outbound directory only under `!this.liveFilesOff`", () => {
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

  it("8d. a closed run's lane uploads only a media event of ITS normalizer, which follows the switch", () => {
    const sf = parse(RUN_MANAGER);
    const calls = addMediaCalls(sf);
    expect(calls).toHaveLength(1);
    const conds = thenConditions(calls[0]!).flatMap((c) => conjuncts(c).map((p) => p.getText()));
    expect(conds).toContain('e.type === "media"');
    // `liveFilesOff` is written only by setProjection (every normalizer, the sink, every
    // lane) and by laneNormalizer (from the current switch).
    const writes: string[] = [];
    walk(sf, (n) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === "liveFilesOff"
      ) {
        let m: ts.Node | undefined = n.parent;
        while (m !== undefined && !ts.isMethodDeclaration(m)) m = m.parent;
        writes.push(`${(m as ts.MethodDeclaration | undefined)?.name.getText()}:${n.left.expression.getText()}=${n.right.getText()}`);
      }
    });
    expect(writes.sort()).toEqual(
      [
        "laneNormalizer:normalizer=this.projection",
        "setProjection:lane.normalizer=on",
        "setProjection:this.normalizer=on",
        "setProjection:this.sink=on",
      ].sort(),
    );
  });

  it("8e. the sub-agent's delivered media is attached only when the switch is not `on`", () => {
    const sf = parse(SESSION);
    const calls = addMediaCalls(sf);
    expect(calls).toHaveLength(1);
    const guarded = thenConditions(calls[0]!).some((c) =>
      conjuncts(c).some((p) => isNotThisPropPath(p, "this.runManager.projectionOn")),
    );
    expect(guarded).toBe(true);
  });

  it("8f. the server's only addMedia is the operator's `/deliver-media` repair", () => {
    const sf = parse(SERVER);
    const calls = addMediaCalls(sf);
    expect(calls).toHaveLength(1);
    // It lies in the THEN branch of `if (req.url === "/deliver-media")`.
    const conds = thenConditions(calls[0]!).map((c) => c.getText());
    expect(conds).toContain('req.url === "/deliver-media"');
  });
});

/** `!<path>` where the operand's text is exactly `path`. */
function isNotThisPropPath(n: ts.Node, path: string): boolean {
  return ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken && n.operand.getText() === path;
}
