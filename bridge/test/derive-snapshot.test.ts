/**
 * The DERIVED session-snapshot shape (W9 / G-68).
 *
 * `KNOWN_AGENT_FIELDS` was a list of production observations — a field appeared in an
 * operator's unknown-field badge, someone patched the list, repeat — and fourteen fields
 * upstream demonstrably emits were still missing, `lastTo` among them after twenty-four
 * production sightings. It is now derived from the return shape of the gateway's own
 * `buildSessionEventSnapshot`, extracted at vendoring time.
 *
 * What matters is the FAILURE modes: a derivation that silently returns a short list is
 * the hand-maintained list again, one file over. So each of them is exercised here with a
 * synthetic source, which is also the only way to test them at all — the vendoring script
 * refuses to run against a modified checkout, by design.
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { deriveSnapshotFields, SNAPSHOT_FN } from "../scripts/lib/derive-snapshot.mjs";

const derive = deriveSnapshotFields as (source: string) => string[];

/** A synthetic `buildSessionEventSnapshot` with the given return body. */
const source = (body: string, extra = ""): string => `
  ${extra}
  const ${SNAPSHOT_FN} = (
    sessionKey: string,
  ) => {
    const row = load(sessionKey);
    return {
${body}
    };
  };
`;

describe("deriveSnapshotFields", () => {
  it("reads plain keys and ignores comments", () => {
    expect(
      derive(
        source(`      kind: row?.kind,
      // Carry the channel-aware mode so the snapshot matches the projections.
      channel: row?.channel,
      /* block comment */
      model: row?.model,`),
      ),
    ).toEqual(["channel", "kind", "model"]);
  });

  it("resolves an INLINE conditional spread, taking every branch's keys", () => {
    // `...(session ? { session } : {})` and `...(x ? {} : { goal: … })` both appear
    // upstream, and a key that lives only in one branch is still a key on the wire.
    expect(
      derive(
        source(`      kind: row?.kind,
      ...(session ? { session } : {}),
      ...(omit ? {} : { goal: row?.goal ?? null }),`),
      ),
    ).toEqual(["goal", "kind", "session"]);
  });

  it("resolves an IDENTIFIER spread from its declaration in the same function", () => {
    // `...activeRunFields` is the real case: its keys (`hasActiveRun`, `activeRunIds`)
    // exist only in a `const` above the return, so a parser that only reads the return
    // object loses two wire fields.
    const withDecl = `
  const ${SNAPSHOT_FN} = () => {
    const activeRunFields = state
      ? { hasActiveRun: state.active, activeRunIds: state.runIds }
      : {};
    return {
      kind: row?.kind,
      ...activeRunFields,
    };
  };
`;
    expect(derive(withDecl)).toEqual(["activeRunIds", "hasActiveRun", "kind"]);
  });

  it("REFUSES a spread it cannot resolve", () => {
    // The load-bearing failure mode. Silently dropping the spread would lose real fields
    // and leave every assertion downstream green against a short list.
    expect(() =>
      derive(
        source(`      kind: row?.kind,
      ...mysteryFields,`),
      ),
    ).toThrow(
      /cannot be read from source|no readable declaration|no top-level function declaration/i,
    );
  });

  it("REFUSES a HOMONYMOUS second declaration instead of picking the first", () => {
    // Taking the first match let a helper declared earlier decide the whole artifact.
    // "The right one is the first one" is a guess about file order; "there is exactly one"
    // is a fact that can be checked.
    const src = `
  const outer = () => {
    const ${SNAPSHOT_FN} = () => ({ wrong: 1 });
  };
  const ${SNAPSHOT_FN} = () => ({ real: 1 });
`;
    expect(() => derive(src)).toThrow(/2 declarations named/i);
  });

  it("REFUSES a const that is MUTATED, not just one that is rebound", () => {
    // `const` forbids rebinding, not mutation: `const fields = {}; fields.emitted = 1`
    // derived an EMPTY list, and the integrity gate would then re-derive the same wrong
    // list at green.
    // EVERY write form, asked of the parser rather than listed by hand: checking `=`
    // alone left `||=`, `??=`, `+=` and `++` looking stable — the same
    // enumerate-by-memory mistake that cost this module fourteen findings before the
    // rewrite.
    // The rule is INVERTED rather than enumerated: a binding resolves only when every
    // occurrence of its name is accounted for (its declaration, and the spread that reads
    // it). Listing write forms failed three times — `=` only, then property access, then
    // the compound operators — and pass 12 found `Object.assign`, which is a write with no
    // assignment operator at all. There is no end to that list; there is an end to "any
    // other mention disqualifies it".
    for (const mutation of [
      "fields.emitted = 1;",
      'fields["emitted"] = 1;',
      "fields.emitted ||= 1;",
      "fields.emitted ??= 1;",
      "fields.emitted += 1;",
      "fields.emitted++;",
      "++fields.emitted;",
      "Object.assign(fields, { emitted: 1 });",
      "helper(fields);",
      "const alias = fields;",
    ]) {
      expect(
        () =>
          derive(
            `const ${SNAPSHOT_FN} = () => { const fields = {}; ${mutation} return { ...fields }; };`,
          ),
        mutation,
      ).toThrow(/not a stable const|only uses are its declaration/i);
    }
  });

  it("REFUSES a binding that is BOTH read through Object.* AND used elsewhere (codex P2)", () => {
    // `Object.entries(x)` is an accepted read, `mutate(x)` is not: the second
    // must win. Before, the accepted read short-circuited to "unresolved" and the
    // initialiser was still followed — a PARTIAL list, no error, invisible to the
    // ratchet if the snapshot ever mutates `x` after reading it.
    expect(() =>
      derive(
        `const ${SNAPSHOT_FN} = () => { const fields = { a: 1 }; Object.entries(fields); mutate(fields); return { ...fields }; };`,
      ),
    ).toThrow(/not a stable const|only uses are its declaration/i);
  });

  it("does not take a nested ACCESSOR's return as its own", () => {
    // Both walks listed the function-scope node kinds by hand and both omitted accessors,
    // so a `class H { get v() { return {…} } }` inside the function contributed its return
    // to the snapshot. Two copies of a list are two chances to forget the same kind; there
    // is one predicate now.
    // An OBJECT-LITERAL getter, not a class: a class is caught by its own node kind, so
    // testing that form proved nothing about the accessor branch.
    expect(
      derive(
        `const ${SNAPSHOT_FN} = () => { const o = { get v() { return { fabricated: 1 }; } }; return { real: 1 }; };`,
      ),
    ).toEqual(["real"]);
    // …and the class form too, which travels the sibling branch.
    expect(
      derive(
        `const ${SNAPSHOT_FN} = () => { class H { get v() { return { fabricated: 1 }; } } return { real: 1 }; };`,
      ),
    ).toEqual(["real"]);
  });

  it("REFUSES a source the PARSER itself cannot read", () => {
    // `createSourceFile` is forgiving: it returns a tree for broken input, so a truncated
    // file derived a short list under a green light. The point of using a parser is that it
    // can TELL us.
    expect(() =>
      derive(`const ${SNAPSHOT_FN} = () => { return { good: 1,`),
    ).toThrow(/does not parse/i);
  });

  it("REFUSES a spread whose binding is not a stable const", () => {
    // Reading the INITIALISER of a `let` derives a stale shape:
    // `let fields = {stale:1}; fields = {emitted:1}` derived `stale`.
    expect(() =>
      derive(
        `const ${SNAPSHOT_FN} = () => { let fields = { stale: 1 }; fields = { emitted: 1 }; return { ...fields }; };`,
      ),
    ).toThrow(/not a stable const|only uses are its declaration/i);
    // …and a `const` that is assigned to later is refused too.
    expect(() =>
      derive(
        `const ${SNAPSHOT_FN} = () => { const fields = { a: 1 }; if (x) { fields = { b: 2 }; } return { ...fields }; };`,
      ),
    ).toThrow(/not a stable const|only uses are its declaration/i);
  });

  it("REFUSES when the function is renamed or moved", () => {
    // Upstream renaming it must be a red gate, not an empty list: the drift detector's
    // whole known-set is derived from this.
    expect(() => derive("const buildSomethingElse = () => ({ kind: 1 });")).toThrow(
      /not found/i,
    );
  });

  it("REFUSES an unreadable key INSIDE a spread", () => {
    // The top level already refused these; inside a spread they were skipped in silence,
    // so the derivation returned a short list under a green light — the exact failure this
    // module exists to prevent, one nesting level down.
    expect(() =>
      derive(source(`      kind: row?.kind,
      ...(x ? { safe: 1, ["dyn" + "amic"]: 2 } : {}),`)),
    ).toThrow(/cannot be read from source/i);
  });

  it("does not read a REGEX literal's brace as syntax", () => {
    // `{ first: /}/, omitted: 1 }` closed the object on the regex's brace and derived a
    // short list. When the regex heuristic guesses wrong the object fails to BALANCE and
    // throws — loud, never a quietly truncated list.
    expect(
      derive(`const ${SNAPSHOT_FN} = () => { return { first: /}/, omitted: 1 }; };`),
    ).toEqual(["first", "omitted"]);
  });

  it("reads the REAL return, not an inner helper's", () => {
    // The function body used to be sliced at the first `\n  };` — a guess about
    // indentation. An inner helper closed at the same depth ended the analysis early and
    // the derivation read the HELPER's object: a wrong list, silently.
    const src = `
  const ${SNAPSHOT_FN} = () => {
    const helper = () => {
      return { wrong: 1 };
    };
    return { real: 1 };
  };
`;
    expect(derive(src)).toEqual(["real"]);
  });

  it("is not fooled by a `return {` inside a COMMENT", () => {
    // `lastIndexOf("return {")` on raw text matched inside comments and template literals,
    // so a line after the real return would win.
    const src = `
  const ${SNAPSHOT_FN} = () => {
    return { real: 1 };
    // return { fake: 1 };
  };
`;
    expect(derive(src)).toEqual(["real"]);
  });

  it("finds a spread's declaration in CODE, not in a comment", () => {
    // A raw regex over the whole body matched inside a comment, so a commented-out
    // `const fields = { fabricated: 1 }` beat the real declaration and its keys were
    // derived — the same class as the `return {` in a comment, one indirection away.
    const src = `
  const ${SNAPSHOT_FN} = () => {
    const fields = { realA: 1, realB: 2 };
    // const fields = { fabricated: 1 };
    return { k: 1, ...fields };
  };
`;
    expect(derive(src)).toEqual(["k", "realA", "realB"]);
  });

  it("unions EVERY return at the function's own level", () => {
    // Keeping only the last `return {}` dropped a field emitted by an early conditional
    // return, which reaches the wire exactly like the others.
    expect(
      derive(
        `const ${SNAPSHOT_FN} = () => { if (flag) return { onlyEarly: 1 }; return { onlyFinal: 1 }; };`,
      ),
    ).toEqual(["onlyEarly", "onlyFinal"]);
  });

  it("REFUSES a return whose value is not an object literal", () => {
    // A returned variable or call carries fields the source does not show.
    expect(() =>
      derive(`const ${SNAPSHOT_FN} = () => { const o = build(); return o; };`),
    ).toThrow(/cannot be read from source|no `return \{/i);
  });

  it("sees a CLOSURE that captures the binding", () => {
    // Skipping nested functions entirely was the fix for a false refusal on a shadowed
    // name, and it opened a real hole: a closure that CAPTURES the binding was invisible,
    // so the artifact derived [] and every downstream check re-ran the same extractor and
    // agreed. Shadowing is the only reason to stop, and it stops per NAME.
    const src = `
  const ${SNAPSHOT_FN} = () => {
    const fields = {};
    const add = () => { fields.emitted = 1; };
    add();
    return { ...fields };
  };
`;
    expect(() => derive(src)).toThrow(/only uses are its declaration|not a stable const/i);
  });

  it("a BLOCK-level shadow inside a closure does not blind the capture", () => {
    // Collecting a nested function's declarations from ALL its blocks and applying them to
    // the whole function let a `const fields` inside an `if` hide a capture of the OUTER
    // `fields` sitting before that block — reopening the silent omission the closure fix
    // had just closed. The shadow is now the scope's own level only, so this refuses
    // instead of deriving a short list.
    const src = `
  const ${SNAPSHOT_FN} = () => {
    const fields = {};
    const add = () => {
      mutate(fields);
      if (flag) {
        const fields = { local: 1 };
        use(fields);
      }
    };
    add();
    return { ...fields };
  };
`;
    expect(() => derive(src)).toThrow(/only uses are its declaration|not a stable const/i);
  });

  it("a PARAMETER of the same name shadows, and does not disqualify", () => {
    const src = `
  const ${SNAPSHOT_FN} = () => {
    const fields = { real: 1 };
    const helper = (fields) => fields.x;
    return { ...fields };
  };
`;
    expect(derive(src)).toEqual(["real"]);
  });

  it("ignores a NESTED function's declaration when resolving a spread", () => {
    // A helper's shadowing `const fields` lives in another scope; taking the last textual
    // occurrence let it win.
    const src = `
  const ${SNAPSHOT_FN} = () => {
    const fields = { real: 1 };
    const helper = () => { const fields = { fabricated: 1 }; return fields; };
    return { ...fields };
  };
`;
    expect(derive(src)).toEqual(["real"]);
  });

  it("REFUSES a MEMBER spread instead of matching the wrong declaration", () => {
    // The spread name went into a regex unescaped: `...foo.bar` had its `.` match any
    // character, so `const fooXbar = {wrong: 1}` satisfied it and its keys were derived.
    const src = `
  const ${SNAPSHOT_FN} = () => {
    const fooXbar = { wrong: 1 };
    return { k: 1, ...foo.bar };
  };
`;
    expect(() => derive(src)).toThrow(/spread of PropertyAccessExpression/i);
  });

  it("reads a member whose VALUE contains braces, strings and regexes", () => {
    // The cases that defeated the hand-rolled scanner, kept as a record of what the parser
    // removed: a function value with a regex inside (which used to close the object early
    // and lose `omitted`), a string holding a brace, and a regex literal.
    expect(
      derive(
        `const ${SNAPSHOT_FN} = () => { return { first: function () { return /}/; }, omitted: 1 }; };`,
      ),
    ).toEqual(["first", "omitted"]);
    expect(
      derive(`const ${SNAPSHOT_FN} = () => { return { a: "}", b: /}/, c: \`}\` }; };`),
    ).toEqual(["a", "b", "c"]);
  });

  // ---- Following ONE local call (2026.8.1). Upstream split the shape into
  // buildGatewaySessionSnapshot -> buildGatewaySessionEventFields, so a spread of a
  // LOCAL function's result is derived from that function's own `return {…}`. These
  // pin the boundary: what it may follow, and everything it still refuses.
  it("follows a spread of a LOCAL function and derives ITS return keys", () => {
    const src = `
  function makeFields(params) {
    return { fromCallee: params.x, alsoFromCallee: 1 };
  }
  const ${SNAPSHOT_FN} = () => {
    const eventFields = makeFields({ argumentOnly: true });
    const session = Object.fromEntries(Object.entries(eventFields));
    return {
      kind: row?.kind,
      ...eventFields,
      ...(session ? { session } : {}),
    };
  };
`;
    const fields = derive(src);
    expect(fields).toContain("fromCallee");
    expect(fields).toContain("alsoFromCallee");
    expect(fields).toContain("session");
    // THE trap this whole family exists for: an ARGUMENT key is not a result key.
    expect(fields).not.toContain("argumentOnly");
  });

  it("still REFUSES when the callee's own return is not a literal", () => {
    const src = `
  function makeFields(params) {
    return somethingElse(params);
  }
  const ${SNAPSHOT_FN} = () => {
    const eventFields = makeFields({ a: 1 });
    return { kind: row?.kind, ...eventFields };
  };
`;
    expect(() => derive(src)).toThrow(/has no `return \{…\}` of its own/i);
  });

  it("an arbitrary call on the binding is NOT a read — it still disqualifies it", () => {
    // `helper(eventFields)` can FILL the object; only a closed list of native
    // Object readers counts as a read. Without this the follow-the-call path
    // would have re-opened the mutation hole the inverted rule closed.
    const src = `
  function makeFields(params) {
    return { fromCallee: 1 };
  }
  const ${SNAPSHOT_FN} = () => {
    const eventFields = makeFields({ a: 1 });
    helper(eventFields);
    return { kind: row?.kind, ...eventFields };
  };
`;
    expect(() => derive(src)).toThrow(/not a stable const|only uses are its declaration/i);
  });

  it("REFUSES a call ANYWHERE in a spread, not just at its start", () => {
    // `...(x ? makeFields({a: 1}) : {})` took the inline-brace branch and derived `a` — an
    // ARGUMENT presented as a result key. A refusal that only covers the spelling I thought
    // of is not a refusal.
    expect(() =>
      derive(source(`      kind: row?.kind,
      ...(enabled ? makeFields({ argumentOnly: true }) : {}),`)),
    ).toThrow(/no top-level function declaration in the same file/i);
  });

  it("REFUSES a spread that is a CALL", () => {
    // `...makeFields({flag: true})` used to derive `flag` — an ARGUMENT key mistaken for a
    // result key, which is worse than a short list: it is a wrong one.
    expect(() =>
      derive(source(`      kind: row?.kind,
      ...makeFields({ flag: true }),`)),
    ).toThrow(/no top-level function declaration in the same file/i);
  });

  it("REFUSES an identifier spread declared from a call", () => {
    const bare = `
  const ${SNAPSHOT_FN} = () => {
    const fields = getFields();
    return {
      kind: row?.kind,
      ...fields,
    };
  };
`;
    expect(() => derive(bare)).toThrow(
      /cannot be read from source|no readable declaration|no top-level function declaration/i,
    );
    // …including a call that HAS a brace in its argument: "contains a brace" is not "is an
    // object literal", and this used to derive `argumentOnly` — an argument key mistaken
    // for a result key, one indirection around the call refusal.
    const withArg = `
  const ${SNAPSHOT_FN} = () => {
    const fields = getFields({ argumentOnly: true });
    return {
      kind: row?.kind,
      ...fields,
    };
  };
`;
    expect(() => derive(withArg)).toThrow(/no top-level function declaration in the same file/i);
  });

  it("does not read braces INSIDE a string as syntax", () => {
    // `{ first: "}", omitted: 1 }` closed the object at the string's brace and derived a
    // silently short list — which every ratchet downstream would then confirm.
    expect(
      derive(`const ${SNAPSHOT_FN} = () => { return { first: "}", omitted: 1 }; };`),
    ).toEqual(["first", "omitted"]);
    // …and the real upstream shape still derives in full.
    expect(
      derive(source(`      kind: row?.kind,
      label: "a { brace } in text",
      model: row?.model,`)),
    ).toEqual(["kind", "label", "model"]);
  });

  it("REFUSES an unreadable key", () => {
    expect(() =>
      derive(source(`      ["computed" + "Key"]: row?.x,`)),
    ).toThrow(/cannot be read from source/i);
  });
});
