import ts from "typescript";
import {
  exportedInitializer,
  importedFromConstants,
  parse,
  readConstants,
  referencesOf,
  resolveImportedConstant,
  unwrap,
} from "./derive-event-catalogue.mjs";

// Derive the event catalogue the gateway can BROADCAST — as opposed to the one it
// ANNOUNCES (lib/derive-event-catalogue.mjs).
//
// Upstream keeps two vocabularies. `GATEWAY_EVENTS` (server-methods-list.ts) is what
// `hello-ok.features.events` declares. `EVENT_SCOPE_GUARDS` (server-broadcast.ts) is the
// table every broadcast is scope-checked against — and it is the LARGER of the two: at
// v2026.9.1 six families (`config.changed`, `board.changed`, `board.command`,
// `chat.send_timing`, `chat.side_result`, `sessions.catalog.host`) reach a client's
// socket without ever being announced. A ratchet written on the announced list alone
// blesses a runtime that ignores them, which is how a model added to the gateway's
// config stayed invisible to Atrium until a restart: `config.changed` arrived, unread,
// and no gate knew it existed.
//
// Same discipline as the announced deriver: TypeScript's own parser, never a text scan;
// two keys are computed from imported constants and are resolved by their DECLARATION;
// anything this deriver cannot name is a hard error, never a shorter list.

/** Upstream module holding the scope-guard table up to v2026.9.5. */
export const BROADCAST_SOURCE = "src/gateway/server-broadcast.ts";
/** Every module the table has lived in, newest first: v2026.9.6 moved it into
 *  `server-broadcast-scopes.ts`. Exactly ONE of them may declare it at a given version
 *  (`locateBroadcastSource`) — two would be two tables, and choosing one would vendor
 *  half of what the gateway checks. */
export const BROADCAST_SOURCES = ["src/gateway/server-broadcast-scopes.ts", BROADCAST_SOURCE];

/** The module that declares the table at this version, read through `read(rel)` (which
 *  returns undefined for a file the version does not have). Refuses zero or several. */
export function locateBroadcastSource(read) {
  const found = [];
  for (const rel of BROADCAST_SOURCES) {
    const raw = read(rel);
    if (raw === undefined) continue;
    const init = exportedInitializer(parse(raw), BROADCAST_SYMBOL, {
      requireExport: false,
      requireConst: true,
    });
    if (init !== undefined) found.push({ source: rel, raw });
  }
  if (found.length !== 1) {
    throw new Error(
      `${BROADCAST_SYMBOL} is declared at top level in ${found.length} of ${BROADCAST_SOURCES.join(", ")} ` +
        "— expected exactly one: upstream moved the table",
    );
  }
  return found[0];
}
/** Upstream module holding the constants the table's computed keys import. */
export const BROADCAST_CONST_SOURCE = "src/gateway/events.ts";
/** The table this reads. NOT exported upstream — a top-level `const` all the same. */
export const BROADCAST_SYMBOL = "EVENT_SCOPE_GUARDS";

/** Any reference to the TABLE outside its declaration that is not a plain READ
 *  (`TABLE[expr]` / `TABLE.key`, not assigned to, not deleted, not incremented, not
 *  called on) refuses the derivation. The bare identifier handed to a call, wrapped in
 *  `as`/`satisfies`, aliased into a `const`, spread, exported or put in an object
 *  literal is an ESCAPE: from there the table can grow or shrink past what its
 *  initializer says (the sibling deriver refuses every outside reference; reads are
 *  allowed here because the gateway reads the table on every broadcast).
 *
 *  LIMIT, stated: an ENTRY read into a variable (`const required = TABLE[event]`, which
 *  is how the gateway reads it) or passed to a call is allowed, and a mutation through
 *  that alias (`required.push(x)`) is invisible to this deriver. The key list is not
 *  affected — adding a family needs an assignment, a spread or a bare-identifier
 *  hand-off, all refused — but a family's `scopes` may then lag upstream's runtime
 *  guards. Nothing in Atrium reads `scopes` at runtime; they are vendored for the
 *  record. */
function referencedBeyondReads(sourceFile, name) {
  const isAssignmentTarget = (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) return true;
    if (ts.isDeleteExpression(parent)) return true;
    // `++`/`--` mutate; `!TABLE[k]`, `-x`, `+x`, `typeof` are reads.
    if (
      (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
    ) return true;
    return false;
  };
  // A plain read: an access chain rooted at the identifier that is neither assigned to
  // nor CALLED (`TABLE[k].push(x)` mutates through a method, and a parser cannot tell
  // push from includes — the gateway reads the entry into a variable first).
  const isPlainRead = (node) => {
    let top = node;
    while (
      top.parent &&
      (ts.isElementAccessExpression(top.parent) || ts.isPropertyAccessExpression(top.parent)) &&
      top.parent.expression === top
    ) {
      top = top.parent;
    }
    const called = top.parent && ts.isCallExpression(top.parent) && top.parent.expression === top;
    return top !== node && !isAssignmentTarget(top) && !called;
  };
  return referencesOf(sourceFile, name, isPlainRead);
}

/**
 * Broadcastable event names in upstream order, with the scope-guard constants each
 * requires (identifier names as upstream spells them: `READ_SCOPE`; `[]` = unguarded).
 *
 * @param {string} raw        contents of BROADCAST_SOURCE
 * @param {string} constRaw   contents of BROADCAST_CONST_SOURCE
 * @returns {{ events: string[], scopes: Record<string, string[]> }}
 */
export function deriveBroadcastCatalogue(raw, constRaw, source = BROADCAST_SOURCE) {
  const file = parse(raw);
  const init = unwrap(
    exportedInitializer(file, BROADCAST_SYMBOL, { requireExport: false, requireConst: true }),
  );
  if (init === undefined) {
    throw new Error(`${source} has no top-level ${BROADCAST_SYMBOL} — upstream moved the table`);
  }
  if (referencedBeyondReads(file, BROADCAST_SYMBOL)) {
    throw new Error(`${BROADCAST_SYMBOL} is mutated or escapes its declaration in ${source} (a reference beyond a plain read) — refusing to derive it`);
  }
  if (!ts.isObjectLiteralExpression(init)) {
    throw new Error(`${BROADCAST_SYMBOL} is not an object literal`);
  }
  const imported = importedFromConstants(file, source, BROADCAST_CONST_SOURCE);
  const constants = readConstants(constRaw);
  const scopes = new Map();
  for (const prop of init.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      // A spread, a shorthand or a method: entries this deriver cannot enumerate.
      throw new Error(`${BROADCAST_SYMBOL} entry ${JSON.stringify(prop.getText())} is not a plain key: value — refusing to emit a short catalogue`);
    }
    const key = prop.name;
    let name;
    if (ts.isStringLiteral(key)) {
      name = key.text;
    } else if (ts.isIdentifier(key)) {
      name = key.text; // `agent: […]` — a bare key IS the string "agent"
    } else if (ts.isComputedPropertyName(key)) {
      const inner = unwrap(key.expression);
      if (!ts.isIdentifier(inner)) {
        throw new Error(`${BROADCAST_SYMBOL} computed key ${JSON.stringify(key.getText())} is not an identifier — refusing to emit a short catalogue`);
      }
      name = resolveImportedConstant(imported, constants, inner.text, {
        symbol: BROADCAST_SYMBOL,
        constSource: BROADCAST_CONST_SOURCE,
      });
    } else {
      throw new Error(`${BROADCAST_SYMBOL} key ${JSON.stringify(key.getText())} is of a kind this deriver cannot name`);
    }
    if (name === "") throw new Error(`${BROADCAST_SYMBOL} has an empty key — refusing to vendor it`);
    if (scopes.has(name)) throw new Error(`${BROADCAST_SYMBOL} has duplicate entries: ${name}`);
    const value = unwrap(prop.initializer);
    if (!ts.isArrayLiteralExpression(value)) {
      throw new Error(`${BROADCAST_SYMBOL}[${JSON.stringify(name)}] is not an array of scope guards`);
    }
    const guards = [];
    for (const el of value.elements) {
      const g = unwrap(el);
      // A named constant is recorded by its NAME (`READ_SCOPE`); a scope written as a
      // string literal (v2026.9.6: `"operator.sessions.read"`) by its VALUE. The two
      // cannot be confused — constant names are UPPER_SNAKE, scope values are dotted.
      if (ts.isIdentifier(g)) guards.push(g.text);
      else if (ts.isStringLiteral(g) && g.text !== "") guards.push(g.text);
      else {
        throw new Error(`${BROADCAST_SYMBOL}[${JSON.stringify(name)}] has a guard that is neither a named constant nor a scope string: ${JSON.stringify(el.getText())}`);
      }
    }
    scopes.set(name, guards);
  }
  if (scopes.size === 0) throw new Error(`${BROADCAST_SYMBOL} derived empty — refusing to vendor nothing`);
  return { events: [...scopes.keys()], scopes: Object.fromEntries(scopes) };
}
