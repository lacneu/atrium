import ts from "typescript";

// Derive the event catalogue the gateway ANNOUNCES about itself.
//
// `hello-ok.features.events` is not a guess about what upstream emits — it is upstream's
// own answer, populated from `GATEWAY_EVENTS`. Atrium read the handshake for
// `server.version` and `policy.maxPayload` and dropped the catalogue on the floor, so
// every unhandled event family was discovered the same way: a user hit it first.
//
// The list is derived rather than copied because ONE of its entries is not a string
// literal. `GATEWAY_EVENT_UPDATE_AVAILABLE` is an imported identifier, and a naive
// literal scrape silently yields 29 of 30 — the exact failure mode of lot 47, where a
// derivation matched by call shape and dropped three helpers without a word. An entry
// this deriver cannot resolve is a hard error, never a shorter list.


/**
 * The source with COMMENT text blanked out, length preserved.
 *
 * Used by the coverage ratchets: an `anchor` proves a `handled` verdict only if its token
 * appears in real code, and a token satisfied by an explanatory comment would certify
 * exactly the vague prose the anchor rule exists to kill. Tokenised with TypeScript's own
 * scanner rather than a hand-rolled pass — five review passes proved that hand-rolled
 * source scanning is a losing game.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  const file = parse(src);
  const text = file.getFullText();
  const out = text.split("");
  const blank = (ranges) => {
    for (const r of ranges ?? []) {
      for (let i = r.pos; i < r.end; i += 1) if (out[i] !== "\n") out[i] = " ";
    }
  };
  // Walked through the PARSED tree, not a bare scanner. A scanner without a parser loses
  // its place on the first template literal — measured: it stopped after 400 tokens on a
  // 1400-line file and left every later comment intact, which would have let an anchor be
  // satisfied by prose. That is the fifth-variant lesson applying to my own fix.
  const visit = (node) => {
    blank(ts.getLeadingCommentRanges(text, node.getFullStart()));
    blank(ts.getTrailingCommentRanges(text, node.getEnd()));
    node.forEachChild(visit);
  };
  visit(file);
  blank(ts.getLeadingCommentRanges(text, file.endOfFileToken.getFullStart()));
  return out.join("");
}

/** Upstream module holding the announced catalogue. */
export const CATALOGUE_SOURCE = "src/gateway/server-methods-list.ts";
/** Upstream module holding the constants that catalogue imports. */
export const CATALOGUE_CONST_SOURCE = "src/gateway/events.ts";
/** The exported array this reads. */
export const CATALOGUE_SYMBOL = "GATEWAY_EVENTS";

/**
 * Parse `src` with TypeScript's own parser.
 *
 * FIVE review passes found the same defect wearing five coats, and every one of them came
 * from reading source text with something hand-rolled: a `]` inside a comment, a block
 * comment glued to an entry, a declaration commented out, a declaration inside a STRING,
 * and finally one inside a RegExp literal. Each patch closed the reported spelling and the
 * next pass found another — because a text scanner cannot tell code from prose, and
 * enumerating the ways prose can look like code is not a finite job.
 *
 * So the scanner is gone. TypeScript is already a dependency of this package (it type-checks
 * the bridge), its parser is the same one that compiles the upstream file, and it cannot be
 * fooled by a construct that is valid TypeScript. What used to be five guards is now a
 * precondition: if it is not a real exported declaration, it is not a declaration.
 *
 * @param {string} src
 * @returns {import("typescript").SourceFile}
 */
function parse(src) {
  return ts.createSourceFile("upstream.ts", src, ts.ScriptTarget.Latest, true);
}

/** The initializer of an exported `const NAME = …`, or undefined. */
function exportedInitializer(sourceFile, name) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const exported = (stmt.modifiers ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl.initializer;
    }
  }
  return undefined;
}

/** Unwrap `x as const` / `x satisfies T` down to the expression itself. */
function unwrap(node) {
  let n = node;
  while (n && (ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isParenthesizedExpression(n))) {
    n = n.expression;
  }
  return n;
}

/** `export const NAME = "value"` pairs, for resolving imported entries.
 *
 *  Only a WHOLE string literal counts. A concatenation (`"update." + suffix`) used to be
 *  recorded as its first piece — a name the gateway never announces (review pass 3). */
function readConstants(constSource) {
  const out = new Map();
  const file = parse(constSource);
  for (const stmt of file.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!(stmt.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    // `const` ONLY. `export let X = "before"; X = "after";` would vendor the initializer
    // while the gateway announces the reassigned value — the catalogue would be green and
    // wrong (review pass 12). An immutable binding is the only one whose initializer IS
    // its value.
    if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const init = unwrap(decl.initializer);
      if (
        init &&
        (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) &&
        init.text !== ""
      ) {
        out.set(decl.name.text, init.text);
      }
    }
  }
  return out;
}


/** Local name → EXPORTED name, for named imports of the constants module only.
 *
 *  The entry used to be resolved by SPELLING against every export of `events.ts`, so a
 *  local `const X = "real"` — or an import of `X` from somewhere else entirely — derived
 *  whatever `events.ts` happened to call `X` (review pass 11, reproduced). What binds a
 *  name is its DECLARATION, not its letters. Aliases are honoured because upstream may
 *  legitimately rename on import.
 */
function importedFromConstants(sourceFile) {
  // Resolved RELATIVE TO the catalogue module, then compared to the constants module in
  // full. Matching on the basename accepted `../other/events.js` and then read the value
  // out of the real `events.ts` — a same-named export elsewhere would have been vendored
  // with the wrong value and nothing would have said so (review pass 12).
  const dir = CATALOGUE_SOURCE.replace(/\/[^/]*$/, "");
  const wanted = CATALOGUE_CONST_SOURCE.replace(/\.ts$/, "");
  const out = new Map();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue; // a package, never our constants module
    const segments = `${dir}/${spec}`.split("/");
    const resolved = [];
    for (const seg of segments) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") resolved.pop();
      else resolved.push(seg);
    }
    if (resolved.join("/").replace(/\.[cm]?js$/, "") !== wanted) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      out.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }
  return out;
}

/** Every reference to `name` outside its own declaration. A catalogue that is MUTATED
 *  after it is declared cannot be derived from its initializer, and this deriver has no
 *  way to evaluate one — so it refuses rather than vendor a list upstream will extend at
 *  runtime (review pass 11). */
function referencedOutsideDeclaration(sourceFile, name) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      return; // the declaration itself, initializer included
    }
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

/**
 * Event names announced by the gateway, in upstream order.
 *
 * @param {string} raw        contents of CATALOGUE_SOURCE
 * @param {string} constRaw   contents of CATALOGUE_CONST_SOURCE
 * @returns {string[]}
 */
export function deriveEventCatalogue(raw, constRaw) {
  const file = parse(raw);
  if (referencedOutsideDeclaration(file, CATALOGUE_SYMBOL)) {
    throw new Error(
      `${CATALOGUE_SYMBOL} is referenced outside its declaration in ${CATALOGUE_SOURCE} ` +
        `(a mutation would not appear in the vendored catalogue) — refusing to derive it`,
    );
  }
  const imported = importedFromConstants(file);
  const init = unwrap(exportedInitializer(file, CATALOGUE_SYMBOL));
  if (init === undefined) {
    throw new Error(
      `${CATALOGUE_SOURCE} has no exported ${CATALOGUE_SYMBOL} — upstream moved the catalogue`,
    );
  }
  if (!ts.isArrayLiteralExpression(init)) {
    throw new Error(`${CATALOGUE_SYMBOL} is not an array literal`);
  }
  const constants = readConstants(constRaw);
  const names = [];
  for (const el of init.elements) {
    const node = unwrap(el);
    // A no-substitution template (`\`agent\``) is as constant as a quoted string, and the
    // parser hands back the same `.text`. Quote STYLE was never the rule — the rule is
    // that the value must be known without evaluating anything. The hand-rolled decoder
    // refused single quotes and templates alike, which looked like rigour and was an
    // artifact of using `JSON.parse` as a lexer.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // `.text` is the DECODED value: `"\u006eew.event"` is `new.event` on the wire, and
      // recording the source spelling would put a phantom in the catalogue (pass 2).
      if (node.text === "") {
        throw new Error(`${CATALOGUE_SYMBOL} has an empty entry — refusing to vendor it`);
      }
      names.push(node.text);
      continue;
    }
    if (ts.isIdentifier(node)) {
      const exportedName = imported.get(node.text);
      if (exportedName === undefined) {
        throw new Error(
          `${CATALOGUE_SYMBOL} entry ${node.text} is not a named import from ` +
            `${CATALOGUE_CONST_SOURCE} — refusing to resolve it by spelling`,
        );
      }
      const resolved = constants.get(exportedName);
      if (resolved === undefined) {
        // The whole reason this file exists. A dropped entry would make the catalogue look
        // complete while being one short, and the ratchet would bless it.
        throw new Error(
          `${CATALOGUE_SYMBOL} entry ${node.text} is not resolvable from ` +
            `${CATALOGUE_CONST_SOURCE} — refusing to emit a short catalogue`,
        );
      }
      names.push(resolved);
      continue;
    }
    throw new Error(
      `${CATALOGUE_SYMBOL} entry ${JSON.stringify(node.getText())} is neither a string ` +
        `literal nor a resolvable constant — refusing to emit a short catalogue`,
    );
  }
  if (names.length === 0) {
    throw new Error(`${CATALOGUE_SYMBOL} derived empty — refusing to vendor nothing`);
  }
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`${CATALOGUE_SYMBOL} has duplicate entries: ${dupes.join(", ")}`);
  }
  return names;
}
