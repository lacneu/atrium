// Derive the SHAPE of the session snapshot the gateway flattens onto agent events.
//
// Its own module, and not inline in the vendoring script, for one reason: the script
// refuses to run against a modified checkout (it attributes bytes to a public tag), so the
// only way to test what this does with a spread it cannot resolve, or with the function
// renamed, is to hand it a SYNTHETIC source. A derivation whose failure modes cannot be
// exercised is a derivation nobody has checked.
//
// It reads `src/gateway/server-chat.ts` — gateway IMPLEMENTATION, not a protocol module,
// which is why the file itself is not vendored (1400+ lines, and a coverage ratchet meant
// for schemas would have to "classify" it). Only the field NAMES of the return shape are
// kept, so no upstream logic is copied and nothing here can carry a value.
//
// WHY THE TYPESCRIPT PARSER, and not a scanner of our own.
//
// The first version walked the text counting braces. Across seven review rounds it took
// FOURTEEN findings, every one the same shape: it produced a short or a wrong list and did
// NOT fail. Braces inside strings. Regex literals. A regex after `return`, which yielded a
// body that balanced BY ACCIDENT and was one field short. A `return {` inside a comment. A
// commented-out `const` beating the real declaration. A helper's shadowing declaration in
// an inner scope. Each fix was correct, and each left a sibling hole — because what was
// being written was a JavaScript parser, one construct at a time.
//
// `typescript` is already a dependency here. Handing it the source removes that entire
// class: comments, strings, templates, regexes, nesting and scope become the parser's
// problem, and what is left are the questions this module is actually about — which
// declaration, which return, which spread.
//
// It still REFUSES rather than guesses. A spread whose keys are not in the source (a call,
// a member expression, an identifier bound to something that is not an object literal)
// aborts the vendoring: a derivation that quietly loses fields is the hand-maintained list
// it replaced, one file over.

import ts from "typescript";

export const SNAPSHOT_SOURCE = "src/gateway/server-chat.ts";
export const SNAPSHOT_FN = "buildSessionEventSnapshot";

/**
 * Where the session-event snapshot shape is BUILT, newest layout first.
 *
 * v2026.8.1 moved it: `buildSessionEventSnapshot` in server-chat.ts stopped
 * building the object and now returns `buildGatewaySessionSnapshot({…})` from
 * session-event-payload.ts, so deriving from the old site refused with "no
 * `return {…}` at the function's own level" — correctly, since the fields were
 * no longer there. The list is ordered, not guessed: the first candidate whose
 * file exists AND whose function is present wins, and if none matches the
 * caller still refuses. Older tags keep vendoring from their own layout.
 */
export const SNAPSHOT_SITES = [
  { source: "src/gateway/session-event-payload.ts", fn: "buildGatewaySessionSnapshot" },
  { source: SNAPSHOT_SOURCE, fn: SNAPSHOT_FN },
];

/** Does this node open a new function scope?
 *
 *  ONE predicate, used by both walks. They each listed the node kinds by hand and the list
 *  omitted accessors, so a `class Helper { get value() { return { fabricated: 1 }; } }`
 *  inside the function contributed its return to the snapshot (raised in review). Two
 *  copies of a list is two chances to forget the same kind. */
function isFunctionScope(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/** The property name of an object-literal member, or null when it is not a plain name. */
function propertyName(node) {
  const name = node.name;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null; // computed, numeric, private — not something to guess at
}

/** Collect the keys of one object literal into `fields`, REFUSING what it cannot read. */
function collectObjectKeys(object, fields, resolveIdentifier, where, ctx) {
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      collectSpread(member.expression, fields, resolveIdentifier, where, ctx);
      continue;
    }
    if (
      ts.isPropertyAssignment(member) ||
      ts.isShorthandPropertyAssignment(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member)
    ) {
      const name = propertyName(member);
      if (name === null) {
        throw new Error(
          `${SNAPSHOT_FN}: ${where} has a member whose name cannot be read from source ` +
            `(computed or unusual) — resolve it here deliberately`,
        );
      }
      fields.add(name);
      continue;
    }
    throw new Error(
      `${SNAPSHOT_FN}: ${where} has an unsupported member kind ` +
        `${ts.SyntaxKind[member.kind]}`,
    );
  }
}

/** Collect the keys a spread contributes. */
function collectSpread(expression, fields, resolveIdentifier, where, ctx) {
  if (ts.isObjectLiteralExpression(expression)) {
    collectObjectKeys(expression, fields, resolveIdentifier, where, ctx);
    return;
  }
  // `...(cond ? {…} : {…})` — BOTH branches: a key present in only one branch is still a
  // key on the wire.
  if (ts.isConditionalExpression(expression)) {
    collectSpread(expression.whenTrue, fields, resolveIdentifier, where, ctx);
    collectSpread(expression.whenFalse, fields, resolveIdentifier, where, ctx);
    return;
  }
  if (ts.isParenthesizedExpression(expression)) {
    collectSpread(expression.expression, fields, resolveIdentifier, where, ctx);
    return;
  }
  // `...activeRunFields` — resolved from its binding in the function's OWN scope, and only
  // when that binding is something whose keys are readable.
  if (ts.isIdentifier(expression)) {
    const bound = resolveIdentifier(expression.text);
    if (bound === undefined) {
      // Not readable as a shape. LAST resort, and only this one: if the binding
      // is initialised by a call to a local function, derive from that
      // function's own returns instead of from the binding.
      const init = ctx?.initialiserOf?.(expression.text);
      if (init !== undefined && ts.isCallExpression(init)) {
        collectSpread(init, fields, resolveIdentifier, `spread ...${expression.text}`, ctx);
        return;
      }
      throw new Error(
        `${SNAPSHOT_FN}: spread \`...${expression.text}\` has no readable declaration in ` +
          `the function's own scope — resolve it here deliberately rather than losing ` +
          `its fields`,
      );
    }
    collectSpread(bound, fields, resolveIdentifier, `spread ...${expression.text}`, ctx);
    return;
  }
  // `...eventFields` where `eventFields` is the result of calling a function
  // declared in this same file (v2026.8.1 splits the shape across
  // buildGatewaySessionSnapshot -> buildGatewaySessionEventFields). Following
  // ONE such call is what keeps the derivation honest: refusing here would lose
  // every field of the callee, and inlining the list by hand is exactly the
  // hand-maintained list this module exists to replace. Only a call to a
  // top-level function of the same file is followed — nothing imported, nothing
  // computed — and the callee is subject to the same rules, so an unreadable
  // callee still refuses.
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const callee = ctx?.resolveLocalFunction?.(expression.expression.text);
    if (callee === undefined) {
      throw new Error(
        `${SNAPSHOT_FN}: spread of call \`${expression.expression.text}(…)\` in ${where} ` +
          `has no top-level function declaration in the same file — resolve it here ` +
          `deliberately rather than losing its fields`,
      );
    }
    ctx.collectFunctionReturnKeys(callee, fields, `${expression.expression.text}()`);
    return;
  }
  throw new Error(
    `${SNAPSHOT_FN}: spread of ${ts.SyntaxKind[expression.kind]} in ${where} cannot be ` +
      `read from source — resolve it here deliberately`,
  );
}

/**
 * Field names of `buildSessionEventSnapshot`'s returned object(s).
 *
 * EVERY return at the function's own level is unioned, not just the last one: a field
 * emitted by an early `if (…) return {…}` reaches the wire exactly like the others, and
 * keeping only the final return dropped it in silence.
 */
export function deriveSnapshotFields(source, options = {}) {
  const FN = options.fnName ?? SNAPSHOT_FN;
  const SRC = options.sourceLabel ?? SNAPSHOT_SOURCE;
  const sf = ts.createSourceFile(
    options.fileName ?? "server-chat.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  // A source the PARSER could not read is not a source this can derive from.
  //
  // `createSourceFile` is forgiving: it returns a tree for broken input, so
  // `return { good: 1,` — a truncated file, a syntax upstream uses that this TS version
  // does not know — yielded `["good"]` under a green light. The whole point of moving to a
  // parser is that it can TELL us; asking it costs one line.
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    throw new Error(
      `${SRC}: does not parse (${ts.flattenDiagnosticMessageText(
        first.messageText,
        " ",
      )}) — refusing to derive a field list from a tree the parser itself doubts`,
    );
  }

  // Found in the SYNTAX TREE — a commented-out copy cannot win, because a comment is not a
  // node — and required to be UNIQUE.
  //
  // Taking the FIRST match let a homonymous helper declared earlier decide the whole
  // artifact (raised in review). "The right one is the first one" is a guess about file
  // order; "there is exactly one" is a fact this can check. Upstream declares it inside a
  // closure, so requiring top level would be wrong; requiring uniqueness is not.
  const found = [];
  const findFn = (node) => {
    // `const fn = (…) => …` (the pre-2026.8.1 layout, declared inside a closure)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === FN &&
      node.initializer !== undefined
    ) {
      found.push(node.initializer);
    }
    // `export function fn(…) {…}` — the 2026.8.1 layout. Accepting only the
    // variable form made a real declaration invisible and reported "not found",
    // which reads as "upstream removed it" when upstream merely declared it the
    // other way.
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.name.text === FN
    ) {
      found.push(node);
    }
    ts.forEachChild(node, findFn);
  };
  ts.forEachChild(sf, findFn);
  if (found.length > 1) {
    throw new Error(
      `${SRC}: ${found.length} declarations named ${FN} — which one ` +
        `the gateway broadcasts is not decidable from the name; resolve it here deliberately`,
    );
  }
  const fn = found[0] ?? null;
  if (fn === null) {
    throw new Error(
      `${SRC}: ${FN} not found — upstream renamed or moved it, so ` +
        `the derived known-field set cannot be trusted`,
    );
  }
  if (
    !ts.isArrowFunction(fn) &&
    !ts.isFunctionExpression(fn) &&
    !ts.isFunctionDeclaration(fn)
  ) {
    throw new Error(`${FN}: not a function`);
  }
  const body = fn.body;
  if (body === undefined) {
    throw new Error(`${FN}: declaration has no body (overload signature?)`);
  }

  /** Top-level `function name(…) {…}` of THIS file, by name and unique. Used to
   *  follow ONE spread of a local call — see collectSpread. Uniqueness is
   *  required for the same reason as the entry function: "the first one" would
   *  be a guess about file order. */
  const resolveLocalFunction = (name) => {
    const hits = sf.statements.filter(
      (st) => ts.isFunctionDeclaration(st) && st.name?.text === name && st.body !== undefined,
    );
    if (hits.length !== 1) return undefined;
    return hits[0];
  };

  /** The keys of every `return {…}` at a callee's OWN level, under the same
   *  rules as the entry function: a return of anything else is opaque and
   *  refuses, because its fields would be lost in silence. */
  const collectFunctionReturnKeys = (callee, fields, where) => {
    const rets = [];
    const walkRet = (node) => {
      if (isFunctionScope(node) && node !== callee) return;
      if (ts.isReturnStatement(node)) rets.push(node);
      ts.forEachChild(node, walkRet);
    };
    ts.forEachChild(callee.body, walkRet);
    const literals = rets.filter(
      (r) => r.expression !== undefined && ts.isObjectLiteralExpression(r.expression),
    );
    if (literals.length === 0) {
      throw new Error(
        `${FN}: ${where} has no \`return {…}\` of its own — its fields cannot be read ` +
          `from source; resolve this here deliberately`,
      );
    }
    const opaqueRets = rets.filter(
      (r) => r.expression !== undefined && !ts.isObjectLiteralExpression(r.expression),
    );
    if (opaqueRets.length > 0) {
      throw new Error(
        `${FN}: ${where} also returns a non-literal — part of its shape is invisible ` +
          `here; resolve this deliberately rather than deriving a partial field list`,
      );
    }
    for (const r of literals) {
      collectObjectKeys(r.expression, fields, () => undefined, where, undefined);
    }
  };
  const ctx = {
    resolveLocalFunction,
    collectFunctionReturnKeys,
    initialiserOf: (name) => bindings.get(name),
  };

  /** Bindings declared directly in the function's OWN body. A helper's shadowing
   *  declaration lives in a nested scope and must not win. */
  const bindings = new Map();
  const reassigned = new Set();
  /** Names read in argument position — see countOccurrences. Such a name is NOT
   *  resolvable as a literal; it only becomes eligible for following its
   *  initialiser's call. Declared at the same level as `reassigned` because
   *  `resolveIdentifier` reads it from outside the block that fills it. */
  const argumentReads = new Set();
  if (ts.isBlock(body)) {
    for (const statement of body.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      // `const` ONLY. A `let` can be rebound after its declaration, and reading the
      // INITIALISER then derives a stale shape: `let fields = {stale:1}; fields =
      // {emitted:1}; return {...fields}` derived `stale` (raised in review). Rather than
      // model assignment, this refuses to resolve anything that can change.
      const isConst =
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const d of statement.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (!isConst) {
          reassigned.add(d.name.text);
          continue;
        }
        if (d.initializer !== undefined) bindings.set(d.name.text, d.initializer);
      }
    }
    // WHICH OCCURRENCES ARE ACCOUNTED FOR — the rule, inverted.
    //
    // Listing what counts as a write was an enumeration, and it failed three times: `=`
    // only, then `=` plus property access, then those plus `||=`/`??=`/`+=`/`++`. Pass 12
    // found `Object.assign(fields, {…})`, which is a write with no assignment operator at
    // all — and there is no end to that list (`Object.defineProperty`, a helper taking the
    // object, a `for` loop filling it).
    //
    // So the question is turned around. A binding is resolvable only when EVERY occurrence
    // of its name is one this module can account for: the declaration itself, and the
    // spread(s) that read it. Any other mention — passed to a call, mutated, captured,
    // returned — disqualifies it. That is fail-closed by construction rather than by
    // memory, and it needs no list of the ways JavaScript can change an object.
    const occurrences = new Map();
    /** Names a nested scope DECLARES for itself (parameters and its own bindings). */
    const shadowedBy = (fnNode) => {
      const names = new Set();
      for (const p of fnNode.parameters ?? []) {
        if (ts.isIdentifier(p.name)) names.add(p.name.text);
      }
      // The scope's OWN top level only — not declarations nested in its blocks.
      //
      // Collecting them all and applying them to the whole function let a `const fields`
      // inside an `if` blind a capture of the OUTER `fields` sitting before that block
      // (raised in review), which reopened the silent omission the closure fix had just
      // closed. Proper per-block scoping is more than this module needs; restricting the
      // shadow to the function's own level is exact where it matters, and a block-level
      // shadow now shows up as an unaccounted occurrence — a REFUSAL, naming the case,
      // rather than a short list.
      const body = fnNode.body;
      if (body !== undefined && ts.isBlock(body)) {
        for (const statement of body.statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const d of statement.declarationList.declarations) {
            if (ts.isIdentifier(d.name)) names.add(d.name.text);
          }
        }
      }
      return names;
    };
    // Descend INTO nested functions, minus the names they shadow.
    //
    // Skipping them entirely was the fix for a false refusal (a helper's own `const fields`
    // is a different variable) and it opened a real hole: a closure that CAPTURES the
    // binding — `const add = () => { fields.emitted = 1; }; add();` — was invisible, so the
    // artifact derived `[]` and every downstream check re-ran the same extractor and agreed
    // (raised in review). Shadowing is the only reason to stop, and it stops per NAME.
    const countOccurrences = (node, shadowed) => {
      if (isFunctionScope(node)) {
        const inner = new Set([...shadowed, ...shadowedBy(node)]);
        ts.forEachChild(node, (child) => countOccurrences(child, inner));
        return;
      }
      if (
        ts.isIdentifier(node) &&
        bindings.has(node.text) &&
        !shadowed.has(node.text)
      ) {
        const parent = node.parent;
        const isDeclarationName =
          parent !== undefined &&
          ts.isVariableDeclaration(parent) &&
          parent.name === node;
        const isSpreadRead =
          parent !== undefined && ts.isSpreadAssignment(parent);
        // A READ in argument position: `Object.entries(eventFields)`.
        //
        // v2026.8.1 builds the shape in two steps and reads the intermediate
        // binding once more to project it, which the two categories above
        // refuse. This third one is deliberately NARROW: the identifier must be
        // an ARGUMENT of a call — never the callee, never the object of a
        // member access (`x.push(…)`, `x.foo = 1` stay refusals) — and never the
        // first argument of the mutating Object built-ins. Everything else
        // still falls through to a refusal, so the rule stays fail-closed by
        // construction rather than by enumerating ways to mutate.
        //
        // LIMIT, stated rather than hidden: a helper that MUTATES the object it
        // receives (`fill(eventFields)`) is an argument read by this rule and
        // would not be caught. What such a read unlocks is only the right to
        // FOLLOW the initialiser's call (see collectSpread) — never to read the
        // initialiser as a literal — so the derived list comes from the callee's
        // own `return {…}`, and a mutation could make it short. That residual
        // case is the price of this option, agreed 2026-08-31.
        // Only a CLOSED list of native, non-mutating readers counts — never an
        // arbitrary call. `helper(fields)` stays an unaccounted occurrence,
        // because a function taking the object can fill it and this module
        // cannot know; that case is one of the mutations the test above pins.
        // The list is closed by construction (four `Object` statics whose
        // contract is to read), unlike "ways to mutate an object", which is
        // open-ended — the distinction that made the inverted rule necessary.
        const NON_MUTATING_OBJECT_READERS = ["entries", "keys", "values", "fromEntries"];
        let isArgumentRead = false;
        if (parent !== undefined && ts.isCallExpression(parent)) {
          const callee = parent.expression;
          isArgumentRead =
            parent.arguments.indexOf(node) === 0 &&
            parent.arguments.length === 1 &&
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Object" &&
            NON_MUTATING_OBJECT_READERS.includes(callee.name.text);
          if (isArgumentRead) argumentReads.add(node.text);
        }
        if (!isDeclarationName && !isSpreadRead && !isArgumentRead) {
          occurrences.set(node.text, (occurrences.get(node.text) ?? 0) + 1);
        }
      }
      ts.forEachChild(node, (child) => countOccurrences(child, shadowed));
    };
    ts.forEachChild(body, (child) => countOccurrences(child, new Set()));
    for (const [name, count] of occurrences) {
      if (count > 0) reassigned.add(name);
    }
  }
  const resolveIdentifier = (name) => {
    // Read somewhere else, in a position this module accepts but cannot prove
    // harmless: refuse to read the initialiser as a shape. `collectSpread` may
    // still follow it if — and only if — that initialiser is a call to a local
    // function whose own returns are literal.
    // Order matters: a binding that is BOTH read through an accepted reader
    // (`Object.entries(x)`) and used somewhere unproven (`mutate(x)`) must be
    // refused, not quietly downgraded to "unresolved" — the unresolved path can
    // still follow a local initialiser and derive a PARTIAL list without error.
    if (reassigned.has(name)) {
      throw new Error(
        `${SNAPSHOT_FN}: spread \`...${name}\` refers to a binding that is not a stable ` +
          `const whose ONLY uses are its declaration and this spread (it is ` +
          `\`let\`/\`var\`, or its name appears somewhere else — assigned to, mutated, ` +
          `passed to a call) — its shape at the return is not readable from its ` +
          `declaration; resolve it here deliberately`,
      );
    }
    if (argumentReads.has(name)) return undefined;
    return bindings.get(name);
  };

  const fields = new Set();

  // Concise body: `=> ({…})`.
  if (!ts.isBlock(body)) {
    const expr = ts.isParenthesizedExpression(body) ? body.expression : body;
    if (!ts.isObjectLiteralExpression(expr)) {
      throw new Error(`${SNAPSHOT_FN}: concise body is not an object literal`);
    }
    collectObjectKeys(expr, fields, resolveIdentifier, "the returned object", ctx);
    return [...fields].sort();
  }

  // EVERY return at this function's own level — a nested function's returns are not this
  // function's.
  const returns = [];
  const walk = (node) => {
    if (isFunctionScope(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);

  const objectReturns = returns.filter(
    (r) => r.expression !== undefined && ts.isObjectLiteralExpression(r.expression),
  );
  if (objectReturns.length === 0) {
    throw new Error(
      `${SNAPSHOT_FN}: no \`return {…}\` at the function's own level — upstream changed ` +
        `its shape; resolve this here deliberately`,
    );
  }
  // A return of something OTHER than an object literal carries fields this cannot see.
  const opaque = returns.filter(
    (r) => r.expression !== undefined && !ts.isObjectLiteralExpression(r.expression),
  );
  if (opaque.length > 0) {
    throw new Error(
      `${SNAPSHOT_FN}: returns a ${ts.SyntaxKind[opaque[0].expression.kind]} whose ` +
        `fields cannot be read from source — resolve it here deliberately`,
    );
  }
  for (const r of objectReturns) {
    collectObjectKeys(r.expression, fields, resolveIdentifier, "a returned object", ctx);
  }
  return [...fields].sort();
}
