/**
 * The DERIVED broadcast catalogue — the table every gateway broadcast is scope-checked
 * against (`EVENT_SCOPE_GUARDS`, server-broadcast.ts). It is larger than the announced
 * catalogue, and `config.changed` lives only here: a gate on the announced list alone
 * blessed a runtime that dropped it unread.
 *
 * As with the announced deriver, what is tested is every way this one could return a
 * SHORT list — because the ratchet built on it would bless the shortfall and report a
 * broadcast-only family as classified when it was merely missing.
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { BROADCAST_SYMBOL, deriveBroadcastCatalogue } from "../scripts/lib/derive-broadcast-catalogue.mjs";

const derive = deriveBroadcastCatalogue as (
  raw: string,
  constRaw: string,
) => { events: string[]; scopes: Record<string, string[]> };

const CONSTANTS = `
  export const GATEWAY_EVENT_DEVICE_PAIR_CHANGED = "device.pair.changed" as const;
  export const GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED = "node.runnerInventory.changed" as const;
  export let MUTABLE = "before";
  export const EMPTY = "";
`;

/** A synthetic broadcast module shaped like upstream's: the import, the (non-exported)
 *  table, and the READ the gateway performs on it — a read must never count as a
 *  mutation, or the real file would refuse. */
const source = (body: string, opts: { exported?: boolean; decl?: string; tail?: string } = {}): string => `
  import { GATEWAY_EVENT_DEVICE_PAIR_CHANGED, GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED as INV } from "./events.js";
  import { READ_SCOPE, PAIRING_SCOPE } from "./method-scopes.js";
  ${opts.exported ? "export " : ""}${opts.decl ?? "const"} ${BROADCAST_SYMBOL}: Record<string, string[]> = {
    ${body}
  };
  function guard(event: string) { const required = ${BROADCAST_SYMBOL}[event]; return required ?? []; }
  ${opts.tail ?? ""}
`;

const REAL_SHAPE = `
  agent: [READ_SCOPE],
  "chat.metadata.changed": [READ_SCOPE],
  heartbeat: [],
  // Hash-only change notice after a persisted config write; the comment has a } in it
  "config.changed": [READ_SCOPE],
  [GATEWAY_EVENT_DEVICE_PAIR_CHANGED]: [PAIRING_SCOPE],
  [INV]: [READ_SCOPE],
`;

describe("deriveBroadcastCatalogue — the happy path, shaped like upstream", () => {
  it("names every key kind: bare, quoted, and computed-from-import (aliased too)", () => {
    const out = derive(source(REAL_SHAPE), CONSTANTS);
    expect(out.events).toEqual([
      "agent",
      "chat.metadata.changed",
      "heartbeat",
      "config.changed",
      "device.pair.changed",
      "node.runnerInventory.changed",
    ]);
    expect(out.scopes["config.changed"]).toEqual(["READ_SCOPE"]);
    expect(out.scopes["heartbeat"], "an unguarded broadcast is `[]`, not absent").toEqual([]);
    expect(out.scopes["device.pair.changed"]).toEqual(["PAIRING_SCOPE"]);
  });

  it("accepts the table whether exported or not (upstream does not export it)", () => {
    expect(derive(source(REAL_SHAPE, { exported: true }), CONSTANTS).events).toHaveLength(6);
  });

  it("a READ of the table is not a mutation — the real file reads it on every broadcast", () => {
    expect(() => derive(source(REAL_SHAPE), CONSTANTS)).not.toThrow();
  });
});

describe("deriveBroadcastCatalogue — every way to come back SHORT is a refusal", () => {
  const refuses = (body: string, opts: { decl?: string; tail?: string } = {}) =>
    expect(() => derive(source(body, opts), CONSTANTS));

  it("a missing table is an upstream move, not an empty catalogue", () => {
    expect(() => derive(`const OTHER = { a: [] };`, CONSTANTS)).toThrow(/no top-level/);
  });
  it("a `let` table could be reassigned past its initializer", () => {
    refuses(REAL_SHAPE, { decl: "let" }).toThrow(/not a `const`/);
  });
  it("an empty table vendors nothing", () => {
    refuses(``).toThrow(/derived empty/);
  });
  it("a spread entry hides an unknown number of families", () => {
    refuses(`agent: [READ_SCOPE], ...EXTRA,`).toThrow(/not a plain key/);
  });
  it("a shorthand or method entry is not a key: value", () => {
    refuses(`agent: [READ_SCOPE], chat,`).toThrow(/not a plain key/);
    refuses(`agent: [READ_SCOPE], chat() { return []; },`).toThrow(/not a plain key/);
  });
  it("a computed key that is not an import from the constants module is not resolved by spelling", () => {
    refuses(`[LOCAL]: [READ_SCOPE],`).toThrow(/not a named import/);
  });
  it("a computed key whose constant is not a whole `const` string literal is unresolvable", () => {
    const src = `
      import { MUTABLE } from "./events.js";
      const ${BROADCAST_SYMBOL} = { [MUTABLE]: [] };`;
    expect(() => derive(src, CONSTANTS)).toThrow(/not resolvable/);
  });
  it("a computed key resolving to an empty name is refused", () => {
    const src = `
      import { EMPTY } from "./events.js";
      const ${BROADCAST_SYMBOL} = { [EMPTY]: [] };`;
    expect(() => derive(src, CONSTANTS)).toThrow(/not resolvable|empty key/);
  });
  it("a computed key that is an expression cannot be named", () => {
    refuses(`["a" + "b"]: [READ_SCOPE],`).toThrow(/not an identifier/);
  });
  it("a duplicate key is a table that lies about its size", () => {
    refuses(`agent: [READ_SCOPE], "agent": [READ_SCOPE],`).toThrow(/duplicate/);
  });
  it("a guard list that is not an array, or holds a non-constant, is not a scope contract", () => {
    refuses(`agent: READ_SCOPE,`).toThrow(/not an array/);
    refuses(`agent: ["read"],`).toThrow(/not a named constant/);
  });
  it("an assignment into the table after declaration grows it past the initializer", () => {
    refuses(REAL_SHAPE, { tail: `${BROADCAST_SYMBOL}["later.event"] = [READ_SCOPE];` }).toThrow(/mutated or escapes/);
    refuses(REAL_SHAPE, { tail: `${BROADCAST_SYMBOL}.later = [];` }).toThrow(/mutated or escapes/);
  });
  it("a `delete` shrinks it", () => {
    refuses(REAL_SHAPE, { tail: `delete ${BROADCAST_SYMBOL}["agent"];` }).toThrow(/mutated or escapes/);
  });
  it("handing the table to a call (Object.assign) could do either", () => {
    refuses(REAL_SHAPE, { tail: `Object.assign(${BROADCAST_SYMBOL}, { x: [] });` }).toThrow(/mutated or escapes/);
  });
  it("a WRAPPED hand-off escapes too: `as`, `satisfies`, an alias, an object literal, a spread", () => {
    refuses(REAL_SHAPE, { tail: `Object.assign(${BROADCAST_SYMBOL} as Record<string, string[]>, { x: [] });` }).toThrow(/mutated or escapes/);
    refuses(REAL_SHAPE, { tail: `const guards = ${BROADCAST_SYMBOL}; guards["later"] = [];` }).toThrow(/mutated or escapes/);
    refuses(REAL_SHAPE, { tail: `registerGuards({ table: ${BROADCAST_SYMBOL} });` }).toThrow(/mutated or escapes/);
    refuses(REAL_SHAPE, { tail: `const merged = { ...${BROADCAST_SYMBOL}, extra: [] };` }).toThrow(/mutated or escapes/);
    refuses(REAL_SHAPE, { tail: `export { ${BROADCAST_SYMBOL} };` }).toThrow(/mutated or escapes/);
    refuses(REAL_SHAPE, { tail: `${BROADCAST_SYMBOL}["agent"].length++;` }).toThrow(/mutated or escapes/);
  });
  it("a method CALL on an entry is refused — push and includes look the same to a parser", () => {
    refuses(REAL_SHAPE, { tail: `${BROADCAST_SYMBOL}["agent"].push(READ_SCOPE);` }).toThrow(/mutated or escapes/);
    refuses(REAL_SHAPE, { tail: `${BROADCAST_SYMBOL}["agent"].splice(0, 1);` }).toThrow(/mutated or escapes/);
    refuses(REAL_SHAPE, { tail: `${BROADCAST_SYMBOL}[e]?.includes("x");` }).toThrow(/mutated or escapes/);
  });
  it("`!TABLE[k]` and `typeof TABLE[k]` are reads, not mutations (only ++/-- mutate)", () => {
    expect(() => derive(source(REAL_SHAPE, { tail: `if (!${BROADCAST_SYMBOL}[e]) { } const t = typeof ${BROADCAST_SYMBOL}[e];` }), CONSTANTS)).not.toThrow();
    refuses(REAL_SHAPE, { tail: `${BROADCAST_SYMBOL}["agent"].length++;` }).toThrow(/mutated or escapes/);
  });
  it("…while READS stay allowed: `TABLE[event]`, `TABLE.agent.length`, and a call on a COPY", () => {
    expect(() => derive(source(REAL_SHAPE, { tail: `const n = ${BROADCAST_SYMBOL}["agent"].length; const required = ${BROADCAST_SYMBOL}[e]; const ok = required?.includes("x");` }), CONSTANTS)).not.toThrow();
  });
  it("the table hidden in a comment, a string or a regexp is not a declaration", () => {
    const src = `
      // const ${BROADCAST_SYMBOL} = { fake: [] };
      const s = "const ${BROADCAST_SYMBOL} = { fake: [] }";
      const r = /const ${BROADCAST_SYMBOL} = \\{/;`;
    expect(() => derive(src, CONSTANTS)).toThrow(/no top-level/);
  });
});
