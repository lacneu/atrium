// Which property NAMES a piece of bridge code touches — through the TypeScript parser and
// binder, never a text scan — and THROUGH WHAT each one is touched.
//
// The coverage manifest's truth guard (test/coverage-truth.test.ts, V3) asks one question
// of a READ SITE (a named function, or a whole file, that reads one protocol schema's
// payload): does it touch a field the manifest declares unread? A textual sweep of the
// whole bridge cannot answer it — `status`, `kind`, `reason` are read everywhere, for
// other objects — but inside the function that reads the payload the same name is that
// payload's field. So the names are collected per function, from the syntax:
//   - `x.name`, `x?.name`, `x["name"]`                       (a read, through `x`)
//   - `const { name } = x`, `const { name: y } = x`           (a read, through `x`)
//   - `"name" in x`                                          (a read, through `x`)
//   - `{ name: v }`, `{ name }` in an object literal         (a WRITE — counted only when
//     the caller asks, for the schemas the bridge SENDS)
// Comments and string contents are not syntax, so they never count.
//
// The RECEIVER of each read is kept, because an exception to the guard is only as good as
// its scope: "this name is not the payload's here" must say WHICH access it means, so it
// cannot also excuse the access that IS the payload's (adversarial review, 2026-11-08).
// A receiver is identified by its BINDING, not its spelling: the root identifier is
// resolved by the checker of a one-file program (every local name bound to its
// declaration and scope; imports stay unresolved, which nothing here needs), and the key
// is that declaration plus the property path (`payload@120.data`). Two variables both
// spelled `state` — one shadowing the other in a block or a closure — are two receivers
// (second review: an alias matched by NAME let a shadowing `const state = "error"` prove
// a read unreachable that runs). Bindings that merely rename another receiver
// (`const e = evt as X`) are kept as aliases, by binding too, so a renamed payload is
// still the payload.

import ts from "typescript";

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

/** The name a function-like node is known by: its own, or the binding it is assigned to. */
function nameOf(node) {
  if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isPrivateIdentifier(node.name))) {
    return node.name.text;
  }
  if (node.kind === ts.SyntaxKind.Constructor) return "constructor";
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
  if (p && ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

function propName(n) {
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  return null;
}

const isWrapper = (n) =>
  ts.isParenthesizedExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isSatisfiesExpression(n) ||
  ts.isNonNullExpression(n) ||
  ts.isTypeAssertionExpression(n);
const unwrap = (n) => {
  let cur = n;
  while (cur && isWrapper(cur)) cur = cur.expression;
  return cur;
};

/** A one-file program: its checker binds every local identifier to its declaration. */
const BOUND = new Map();
function bound(text, fileName) {
  const key = `${fileName}\u0000${text}`;
  const hit = BOUND.get(key);
  if (hit) return hit;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const host = {
    getSourceFile: (f) => (f === fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === fileName,
    readFile: (f) => (f === fileName ? text : undefined),
  };
  const program = ts.createProgram({ rootNames: [fileName], options: { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest }, host });
  const out = { sf: program.getSourceFile(fileName) ?? sf, checker: program.getTypeChecker() };
  BOUND.set(key, out);
  return out;
}

/** A receiver's normalized TEXT, for messages and declarations: `(evt as X)!.data?.x` →
 *  `evt.data.x`. Never the identity of the receiver — see `receiverKey`. */
export function receiverText(expr) {
  const e = unwrap(expr);
  if (!e) return "<none>";
  if (ts.isIdentifier(e) || ts.isPrivateIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(e)) return `${receiverText(e.expression)}.${e.name.text}`;
  if (ts.isElementAccessExpression(e)) {
    const arg = e.argumentExpression;
    return `${receiverText(e.expression)}[${arg && ts.isStringLiteralLike(arg) ? JSON.stringify(arg.text) : "*"}]`;
  }
  if (ts.isCallExpression(e)) return `${receiverText(e.expression)}()`;
  return e.getText().replace(/\s+/g, "").replace(/\?\./g, ".");
}

/** The declaration an identifier is bound to, by the checker (shorthand values included). */
function declarationOf(checker, id) {
  let sym;
  try {
    const p = id.parent;
    sym = p && ts.isShorthandPropertyAssignment(p) && p.name === id ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(id);
  } catch {
    sym = undefined;
  }
  return sym?.valueDeclaration ?? sym?.declarations?.[0];
}

/** The innermost non-arrow function enclosing a node (what `this` denotes there). */
function thisOwner(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (FUNCTION_LIKE.has(n.kind) && n.kind !== ts.SyntaxKind.ArrowFunction) return n;
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return n;
  }
  return undefined;
}

/** A receiver's IDENTITY: its root binding (declaration position) plus the property path.
 *  An identifier the checker cannot bind (a global) is keyed by name, marked as such. */
function receiverKey(checker, expr) {
  const e = unwrap(expr);
  if (!e) return "<none>";
  if (ts.isIdentifier(e)) {
    const d = declarationOf(checker, e);
    return d ? `${e.text}@${d.getStart()}` : `${e.text}@?`;
  }
  if (e.kind === ts.SyntaxKind.ThisKeyword) return `this@${thisOwner(e)?.getStart() ?? "?"}`;
  if (ts.isPropertyAccessExpression(e)) return `${receiverKey(checker, e.expression)}.${e.name.text}`;
  if (ts.isElementAccessExpression(e)) {
    const arg = e.argumentExpression;
    return `${receiverKey(checker, e.expression)}[${arg && ts.isStringLiteralLike(arg) ? JSON.stringify(arg.text) : "*"}]`;
  }
  if (ts.isCallExpression(e)) return `${receiverKey(checker, e.expression)}()`;
  return `~${e.getText().replace(/\s+/g, "")}@${e.getStart()}`;
}

/** What an object binding pattern destructures, as [text, key]: its initializer, a
 *  parameter, an element. */
function patternReceiver(checker, pattern) {
  const owner = pattern.parent;
  if (!owner) return ["<pattern>", `<pattern>@${pattern.getStart()}`];
  if (ts.isBindingElement(owner)) {
    const k = propName(owner.propertyName ?? owner.name) ?? "*";
    const [t, key] = patternReceiver(checker, owner.parent);
    return [`${t}.${k}`, `${key}.${k}`];
  }
  if (ts.isVariableDeclaration(owner)) {
    if (owner.initializer) return [receiverText(owner.initializer), receiverKey(checker, owner.initializer)];
    const stmt = owner.parent?.parent;
    if (stmt && (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt))) {
      return [`<element of ${receiverText(stmt.expression)}>`, `<element of ${receiverKey(checker, stmt.expression)}>`];
    }
    return ["<uninitialized>", `<uninitialized>@${owner.getStart()}`];
  }
  if (ts.isParameter(owner)) {
    const fn = owner.parent;
    const i = fn?.parameters ? fn.parameters.indexOf(owner) : "?";
    return [`<parameter #${i}>`, `<parameter #${i}>@${owner.getStart()}`];
  }
  return ["<pattern>", `<pattern>@${pattern.getStart()}`];
}

const emptyTouch = () => ({ reads: new Set(), writes: new Set(), receivers: new Map(), receiverKeys: new Map(), aliases: new Map(), textKeys: new Map() });

/**
 * Every named function of a source file, with the names its WHOLE body touches (nested
 * closures included: a site is the function and everything it encloses) and, per name,
 * the receivers it is read through — by text (`receivers`, for messages) and by binding
 * (`receiverKeys`, the identity). `textKeys` maps each receiver text met in the function
 * to the bindings it denotes there (more than one = shadowing); `aliases` maps a renaming
 * binding's key to the key of what it renames.
 *
 * @param {string} text
 * @param {string} fileName
 */
export function touchedNames(text, fileName) {
  const { sf, checker } = bound(text, fileName);
  const functions = new Map();
  const file = emptyTouch();
  const stack = [];
  const each = (f) => {
    f(file);
    for (const t of stack) f(t);
  };
  const add = (m, k, v) => {
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(v);
  };
  const read = (name, rText, rKey) => {
    if (name === null) return;
    each((t) => {
      t.reads.add(name);
      add(t.receivers, name, rText);
      add(t.receiverKeys, name, rKey);
      add(t.textKeys, rText, rKey);
    });
  };
  const write = (name) => {
    if (name === null) return;
    each((t) => t.writes.add(name));
  };
  const visit = (node) => {
    let pushed = false;
    if (FUNCTION_LIKE.has(node.kind)) {
      const name = nameOf(node);
      if (name !== null) {
        if (!functions.has(name)) functions.set(name, emptyTouch());
        stack.push(functions.get(name));
        pushed = true;
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      read(propName(node.name), receiverText(node.expression), receiverKey(checker, node.expression));
    } else if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
      read(node.argumentExpression.text, receiverText(node.expression), receiverKey(checker, node.expression));
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const [rText, rKey] = patternReceiver(checker, node.parent);
      read(propName(node.propertyName ?? node.name), rText, rKey);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword && ts.isStringLiteralLike(node.left)) {
      read(node.left.text, receiverText(node.right), receiverKey(checker, node.right));
    } else if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      write(propName(node.name));
    } else if (ts.isShorthandPropertyAssignment(node)) {
      write(node.name.text);
    }
    // `const e = evt as X` / `const e = evt` — a RENAMING of another receiver, by binding.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (init && (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init) || init.kind === ts.SyntaxKind.ThisKeyword)) {
        const alias = `${node.name.text}@${node.name.getStart()}`;
        const of = receiverKey(checker, init);
        each((t) => t.aliases.set(alias, of));
      }
    }
    ts.forEachChild(node, visit);
    if (pushed) stack.pop();
  };
  visit(sf);
  return { functions, file };
}

/**
 * Every read of `field` through one of the bindings `receiverKeys` inside the function(s)
 * named `fnName`, and which of them COULD run when the discriminant — `<branch key>.field`
 * read through the binding `branch.receiverKey`, or a `const` bound to exactly that read —
 * equals `own`, the value the excepted schema itself takes (read from its vendored source
 * by the caller, never declared by hand). Every name is resolved by the checker: a test or
 * an alias that merely SPELLS the discriminant (a shadowing `const state = …` in a block
 * or a closure) proves nothing.
 *
 * An access is proved unreachable for `G === own` when, walking up to the function:
 *   - it sits where a test held that excludes `own`: the then-branch (or `&&` right side,
 *     `?:` true side) of `G !== own` or of `G === other`, a conjunct of either sufficing;
 *   - it sits where a test FAILED that `G === own` would satisfy: the else-branch (or `||`
 *     right side, `?:` false side) of `G === own` or of `G !== other`, a disjunct of
 *     either sufficing (both sides of a conjunction);
 *   - it follows, in an enclosing block, `if (C) return|throw|continue` with such a C.
 * Anything else counts as reachable: the proof is syntactic and errs that way.
 *
 * @returns {{ accesses: number, unguarded: number[] }} unguarded = 1-based lines
 */
export function unreachableWhen(text, fileName, fnName, field, receiverKeys, branch, own) {
  const { sf, checker } = bound(text, fileName);
  const wanted = new Set(receiverKeys);
  const guardKey = `${branch.receiverKey}.${branch.field}`;
  const fns = [];
  const find = (n) => {
    if (FUNCTION_LIKE.has(n.kind) && nameOf(n) === fnName) fns.push(n);
    ts.forEachChild(n, find);
  };
  find(sf);
  let accesses = 0;
  const unguarded = [];
  for (const fn of fns) {
    // A `const` bound to the discriminant read, by its DECLARATION.
    const aliasDecls = new Set();
    const collect = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (n.parent.flags & ts.NodeFlags.Const) !== 0 && receiverKey(checker, n.initializer) === guardKey) {
        aliasDecls.add(n);
      }
      ts.forEachChild(n, collect);
    };
    collect(fn);
    const isG = (e) => {
      const u = unwrap(e);
      if (!u) return false;
      if (ts.isIdentifier(u)) {
        const d = declarationOf(checker, u);
        return !!d && aliasDecls.has(d);
      }
      return receiverKey(checker, u) === guardKey;
    };
    const EQ = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken];
    const NE = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];
    /** `G op "lit"` (either side) → { ne, lit }, else null. */
    const test = (c) => {
      const u = unwrap(c);
      if (!u || !ts.isBinaryExpression(u)) return null;
      const op = u.operatorToken.kind;
      if (!EQ.includes(op) && !NE.includes(op)) return null;
      const [l, r] = [unwrap(u.left), unwrap(u.right)];
      if (isG(l) && ts.isStringLiteralLike(r)) return { ne: NE.includes(op), lit: r.text };
      if (isG(r) && ts.isStringLiteralLike(l)) return { ne: NE.includes(op), lit: l.text };
      return null;
    };
    const isOp = (u, kind) => !!u && ts.isBinaryExpression(u) && u.operatorToken.kind === kind;
    /** True ⇒ G !== own. */
    const excludesWhenTrue = (c) => {
      const u = unwrap(c);
      const t = test(u);
      if (t) return t.ne ? t.lit === own : t.lit !== own;
      return isOp(u, ts.SyntaxKind.AmpersandAmpersandToken) && (excludesWhenTrue(u.left) || excludesWhenTrue(u.right));
    };
    /** G === own ⇒ true (so its failure excludes own). */
    const trueWhenOwn = (c) => {
      const u = unwrap(c);
      const t = test(u);
      if (t) return t.ne ? t.lit !== own : t.lit === own;
      if (isOp(u, ts.SyntaxKind.BarBarToken)) return trueWhenOwn(u.left) || trueWhenOwn(u.right);
      if (isOp(u, ts.SyntaxKind.AmpersandAmpersandToken)) return trueWhenOwn(u.left) && trueWhenOwn(u.right);
      return false;
    };
    const exits = (st) => {
      if (!st) return false;
      if (ts.isReturnStatement(st) || ts.isThrowStatement(st) || ts.isContinueStatement(st)) return true;
      if (ts.isBlock(st)) return st.statements.length > 0 && exits(st.statements[st.statements.length - 1]);
      return false;
    };
    const guarded = (node) => {
      let cur = node;
      while (cur && cur !== fn) {
        const p = cur.parent;
        if (!p) break;
        if (ts.isIfStatement(p)) {
          if (p.thenStatement === cur && excludesWhenTrue(p.expression)) return true;
          if (p.elseStatement === cur && trueWhenOwn(p.expression)) return true;
        }
        if (ts.isConditionalExpression(p)) {
          if (p.whenTrue === cur && excludesWhenTrue(p.condition)) return true;
          if (p.whenFalse === cur && trueWhenOwn(p.condition)) return true;
        }
        if (ts.isBinaryExpression(p) && p.right === cur) {
          if (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && excludesWhenTrue(p.left)) return true;
          if (p.operatorToken.kind === ts.SyntaxKind.BarBarToken && trueWhenOwn(p.left)) return true;
        }
        if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
          for (const st of p.statements) {
            if (st === cur) break;
            if (ts.isIfStatement(st) && !st.elseStatement && exits(st.thenStatement) && trueWhenOwn(st.expression)) return true;
          }
        }
        // A closure runs when it is CALLED, not where it is written: a guard outside it
        // proves nothing about it (it may be called on another path, or later).
        if (FUNCTION_LIKE.has(p.kind)) return false;
        cur = p;
      }
      return false;
    };
    const visit = (n) => {
      let hit = false;
      if (ts.isPropertyAccessExpression(n) && propName(n.name) === field && wanted.has(receiverKey(checker, n.expression))) hit = true;
      else if (ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === field && wanted.has(receiverKey(checker, n.expression))) hit = true;
      else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && propName(n.propertyName ?? n.name) === field && wanted.has(patternReceiver(checker, n.parent)[1])) hit = true;
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword && ts.isStringLiteralLike(n.left) && n.left.text === field && wanted.has(receiverKey(checker, n.right))) hit = true;
      if (hit) {
        accesses += 1;
        if (!guarded(n)) unguarded.push(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1);
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
  }
  return { accesses, unguarded };
}

/** The string literal a vendored schema declares for one of its properties
 *  (`export const <name>Schema = closedObject({ …, state: Type.Literal("final") })`), or
 *  null when the file does not declare it so. */
export function schemaLiteral(text, fileName, schemaName, property) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let out = null;
  const visit = (n) => {
    if (out !== null) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === `${schemaName}Schema` && n.initializer) {
      const call = unwrap(n.initializer);
      const obj = call && ts.isCallExpression(call) ? unwrap(call.arguments[0]) : undefined;
      if (obj && ts.isObjectLiteralExpression(obj)) {
        for (const p of obj.properties) {
          if (!ts.isPropertyAssignment(p) || propName(p.name) !== property) continue;
          const v = unwrap(p.initializer);
          if (v && ts.isCallExpression(v) && ts.isPropertyAccessExpression(v.expression) && v.expression.name.text === "Literal" && v.arguments[0] && ts.isStringLiteralLike(v.arguments[0])) {
            out = v.arguments[0].text;
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The receivers a set of seed receivers reaches through `aliases` (both ways: a renaming
 *  of a payload is the payload, and so is what the payload was renamed FROM). Works on
 *  keys and texts alike. */
export function aliasClosure(seeds, aliases) {
  const out = new Set(seeds);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [alias, of] of aliases) {
      if (out.has(of) && !out.has(alias)) {
        out.add(alias);
        changed = true;
      }
      if (out.has(alias) && !out.has(of)) {
        out.add(of);
        changed = true;
      }
    }
  }
  return out;
}
