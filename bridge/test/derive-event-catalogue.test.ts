/**
 * The DERIVED announced-event catalogue (W9 slice 2b, point 7 — G-70).
 *
 * `hello-ok.features.events` is upstream's own statement of what it emits, and Atrium
 * threw it away. Vendoring it lets a CI ratchet demand that every announced family be
 * classified. But the vendored list is only worth the derivation that produced it, and
 * ONE entry of `GATEWAY_EVENTS` is not a string literal — `GATEWAY_EVENT_UPDATE_AVAILABLE`
 * is an imported identifier. A literal scrape yields 29 of 30 and looks complete.
 *
 * That is exactly how lot 47 failed: a derivation matched by call shape and dropped three
 * helpers without a word. So what is tested here is not the happy path — it is every way
 * this deriver could return a SHORT list. A short catalogue is worse than no catalogue,
 * because the ratchet would bless the shortfall and report full coverage.
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { CATALOGUE_SYMBOL, deriveEventCatalogue } from "../scripts/lib/derive-event-catalogue.mjs";

const derive = deriveEventCatalogue as (raw: string, constRaw: string) => string[];

/** A synthetic catalogue module with the given array body.
 *
 *  The import line is not decoration: since review pass 11 an identifier entry only
 *  resolves when it is a NAMED IMPORT from the constants module, so a fixture that uses
 *  one has to import it — exactly as upstream does. */
const source = (body: string): string => `
  import { GATEWAY_EVENT_UPDATE_AVAILABLE, SOME_EVENT } from "./events.js";
  export const ${CATALOGUE_SYMBOL} = [
${body}
  ];
`;
const CONSTANTS = `export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;\n`;

describe("the catalogue is derived whole, or not at all", () => {
  it("string literals come through in upstream order", () => {
    expect(derive(source(`    "agent",\n    "chat",\n    "tick",`), CONSTANTS)).toEqual([
      "agent",
      "chat",
      "tick",
    ]);
  });

  it("an IMPORTED constant is resolved, not dropped", () => {
    // The entry that makes this file necessary. A literal scrape returns 2 here.
    const got = derive(
      source(`    "agent",\n    "chat",\n    GATEWAY_EVENT_UPDATE_AVAILABLE,`),
      CONSTANTS,
    );
    expect(got).toEqual(["agent", "chat", "update.available"]);
  });

  it("a `]` inside a COMMENT does not end the array early", () => {
    // Raised in adversarial review, and it is the invariant this file exists for: the
    // array extent used to be `indexOf("]")`, so a comment mentioning a bracket cut the
    // catalogue short AND returned a non-empty list — which the ratchet would bless as
    // complete coverage. Silent truncation is the one outcome this deriver may never have.
    expect(
      derive(source(`    "agent", // see events[] upstream\n    "chat",`), CONSTANTS),
    ).toEqual(["agent", "chat"]);
  });

  it("a `]` inside a STRING entry does not end the array early", () => {
    expect(derive(source(`    "we[i]rd",\n    "chat",`), CONSTANTS)).toEqual([
      "we[i]rd",
      "chat",
    ]);
  });

  it("a `]` inside a BLOCK comment does not end the array early", () => {
    expect(
      derive(source(`    "agent", /* array] here */\n    "chat",`), CONSTANTS),
    ).toEqual(["agent", "chat"]);
  });

  it("an ESCAPED literal is DECODED, not recorded verbatim", () => {
    // Raised in adversarial review. `"new.event"` is `new.event` to the gateway, but
    // the regex captured the raw source text — so the catalogue would carry a name that
    // exists nowhere on the wire, the classification would be green against that phantom,
    // and the live handshake would report the REAL name as unanticipated. A derivation
    // that invents names is worse than one that drops them: it looks complete.
    expect(derive(source(`    "\\u006eew.event",`), CONSTANTS)).toEqual(["new.event"]);
    expect(derive(source(`    "tab\\tname",`), CONSTANTS)).toEqual(["tab\tname"]);
  });

  it("an escaped CONSTANT value is decoded too", () => {
    expect(
      derive(
        source(`    SOME_EVENT,`),
        `export const SOME_EVENT = "\\u006eew.event" as const;\n`,
      ),
    ).toEqual(["new.event"]);
  });

  it("a CONCATENATED constant is refused, not truncated to its first piece", () => {
    // Raised in review pass 3, and it is the "invents a name" defect again: the regex
    // captured only the literal PREFIX, so `"update." + suffix` was recorded as
    // `update.` — a name the gateway never announces, which the classification would
    // then be green against.
    expect(() =>
      derive(
        source(`    SOME_EVENT,`),
        `export const SOME_EVENT = "update." + suffix;\n`,
      ),
    ).toThrow(/not resolvable/);
  });

  it("a constant declared inside a COMMENT does not resolve anything", () => {
    expect(() =>
      derive(
        source(`    SOME_EVENT,`),
        `// export const SOME_EVENT = "phantom.event";\n`,
      ),
    ).toThrow(/not resolvable/);
  });

  it("quote STYLE is not the rule — a constant value is", () => {
    // This used to refuse single quotes and templates, and that looked like rigour. It was
    // an artifact of decoding with `JSON.parse`: to the compiler that parses the upstream
    // file, `'agent'` and `\`agent\`` are the same constant as `"agent"`. Refusing them
    // would have aborted a vendoring over a valid catalogue.
    expect(derive(source(`    'agent',`), CONSTANTS)).toEqual(["agent"]);
    expect(derive(source("    `agent`,"), CONSTANTS)).toEqual(["agent"]);
  });

  it("a COMPUTED value is still refused — it is not knowable from the source", () => {
    expect(() => derive(source("    `agent-${suffix}`,"), CONSTANTS)).toThrow(
      /neither a string/,
    );
    expect(() => derive(source(`    "a" + "b",`), CONSTANTS)).toThrow(/neither a string/);
  });

  it("a trailing comment never masquerades as an unresolvable entry", () => {
    expect(
      derive(source(`    "agent", // the run stream\n    "chat",`), CONSTANTS),
    ).toEqual(["agent", "chat"]);
  });
});

describe("every way to return a SHORT list is a hard error", () => {
  it("an UNRESOLVABLE constant throws rather than shortening the list", () => {
    expect(() =>
      derive(source(`    "agent",\n    GATEWAY_EVENT_UPDATE_AVAILABLE,`), "// nothing here"),
    ).toThrow(/not resolvable/);
  });

  it("an entry that is neither literal nor constant throws", () => {
    // A spread, a call, a computed name: anything this deriver cannot account for must
    // stop the vendoring instead of silently producing a catalogue one entry short.
    expect(() => derive(source(`    "agent",\n    ...OTHER_EVENTS,`), CONSTANTS)).toThrow(
      /neither a string literal/,
    );
  });

  it("a declaration inside a COMMENT is not mistaken for the real one", () => {
    // Review pass 5, reproduced by the reviewer: the declaration was located with a raw
    // `indexOf` BEFORE any lexical analysis, so documentation showing a sample
    // `export const GATEWAY_EVENTS = [...]` above the real one derived the SAMPLE. The
    // ratchet then blessed a catalogue of phantoms. Third variant of the same lesson:
    // anything that reads source text must ignore comments and strings first.
    const withDoc = `
      // Example usage:
      //   export const ${CATALOGUE_SYMBOL} = ["phantom"];
      export const ${CATALOGUE_SYMBOL} = [
        "agent",
        "chat",
      ];
    `;
    expect(derive(withDoc, CONSTANTS)).toEqual(["agent", "chat"]);
  });

  it("a declaration inside a BLOCK comment is not mistaken for the real one", () => {
    const withDoc = `
      /* export const ${CATALOGUE_SYMBOL} = ["phantom"]; */
      export const ${CATALOGUE_SYMBOL} = [
        "agent",
      ];
    `;
    expect(derive(withDoc, CONSTANTS)).toEqual(["agent"]);
  });

  it("a declaration inside a STRING is not mistaken for the real one", () => {
    // Fourth variant of the same lesson (pass 9). Comments were neutralised in passes 1,
    // 2 and 5; STRING literals were not, and `indexOf` cannot tell code from a quoted
    // example. A documentation string mentioning the declaration won, and the ratchet
    // would then certify a catalogue of phantoms against the wrong contract.
    const withDoc = `
      const usage = "export const ${CATALOGUE_SYMBOL} = [\\"phantom\\"];";
      export const ${CATALOGUE_SYMBOL} = [
        "agent",
        "chat",
      ];
    `;
    expect(derive(withDoc, CONSTANTS)).toEqual(["agent", "chat"]);
  });

  it("a declaration inside a TEMPLATE LITERAL is not mistaken for the real one", () => {
    const withDoc = [
      "const doc = `export const " + CATALOGUE_SYMBOL + ' = ["phantom"];`;',
      "export const " + CATALOGUE_SYMBOL + " = [",
      '  "agent",',
      "];",
    ].join("\n");
    expect(derive(withDoc, CONSTANTS)).toEqual(["agent"]);
  });

  it("a MUTATION after the declaration is refused, not ignored", () => {
    // Reproduced in review (pass 11): only the initializer was read, so
    // `GATEWAY_EVENTS.push("late")` upstream would announce an event at runtime that the
    // vendored catalogue never mentions — and the bijection would certify the short list
    // as full coverage. Refusing is the only safe answer: this deriver cannot evaluate.
    const mutated = [
      `export const ${CATALOGUE_SYMBOL} = ["agent"];`,
      `${CATALOGUE_SYMBOL}.push("late.arrival");`,
    ].join("\n");
    expect(() => derive(mutated, CONSTANTS)).toThrow(/referenced|mutat/i);
  });

  it("an identifier that is NOT imported from the constants module is refused", () => {
    // Also reproduced (pass 11): the entry was resolved by NAME against every export of
    // the constants file, so a local `const X = "real"` shadowing an unrelated
    // `export const X = "phantom"` derived the phantom. The binding must be checked, not
    // the spelling.
    const local = [
      `const X = "real";`,
      `export const ${CATALOGUE_SYMBOL} = [X];`,
    ].join("\n");
    expect(() => derive(local, `export const X = "phantom";`)).toThrow(/import/i);
  });

  it("an identifier imported from ANOTHER module is refused", () => {
    const elsewhere = [
      `import { X } from "./somewhere-else.js";`,
      `export const ${CATALOGUE_SYMBOL} = [X];`,
    ].join("\n");
    expect(() => derive(elsewhere, `export const X = "phantom";`)).toThrow(/import/i);
  });

  it("an ALIASED import from the constants module still resolves", () => {
    const aliased = [
      `import { GATEWAY_EVENT_UPDATE_AVAILABLE as UPD } from "./events.js";`,
      `export const ${CATALOGUE_SYMBOL} = ["agent", UPD];`,
    ].join("\n");
    expect(derive(aliased, CONSTANTS)).toEqual(["agent", "update.available"]);
  });

  it("an import from a DIFFERENT module that merely ends in events.js is refused", () => {
    // Pass 12: the specifier was matched on its basename, so `../other/events.js` was
    // accepted and then resolved against the real constants file — a same-named export
    // elsewhere would have been vendored with the wrong value, silently.
    const wrongModule = [
      `import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "../other/events.js";`,
      `export const ${CATALOGUE_SYMBOL} = [GATEWAY_EVENT_UPDATE_AVAILABLE];`,
    ].join("\n");
    expect(() => derive(wrongModule, CONSTANTS)).toThrow(/import/i);
  });

  it("a REASSIGNABLE constant is refused — its initializer is not its value", () => {
    // `export let X = "before"; X = "after";` would vendor "before" while the gateway
    // announces "after". Only an immutable binding can be read from its initializer.
    expect(() =>
      derive(
        source(`    SOME_EVENT,`),
        `export let SOME_EVENT = "before";\nSOME_EVENT = "after";\n`,
      ),
    ).toThrow(/not resolvable/);
  });

  it("a MOVED catalogue throws instead of deriving nothing", () => {
    expect(() => derive(`export const SOMETHING_ELSE = ["agent"];`, CONSTANTS)).toThrow(
      /no exported GATEWAY_EVENTS/,
    );
  });

  it("an EMPTY array throws — vendoring nothing would read as full coverage", () => {
    expect(() => derive(source(""), CONSTANTS)).toThrow(/empty/);
  });

  it("DUPLICATE entries throw — a bijection cannot be asserted against a bag", () => {
    expect(() => derive(source(`    "agent",\n    "agent",`), CONSTANTS)).toThrow(
      /duplicate/,
    );
  });
});
