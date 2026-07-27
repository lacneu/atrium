// The vendored surface must be DERIVED from what the bridge actually calls (W10 / G0).
//
// The vendored schema set used to be chosen by hand, and the choice was never checked
// against reality: the bridge calls 26 gateway RPC methods and three vendored modules
// cover the chat lane only. Everything else — every `sessions.*`, `cron.*`, `tasks.*`,
// `config.*` call — has NO schema in the repo, so no ratchet can notice when its
// contract moves. The program's own count was "15 of the 20 called RPCs have no
// guardrail"; this test is what makes that number a fact instead of an estimate, and
// what makes it impossible to add a 27th call without noticing.
//
// Deliberately NOT red-by-default for the whole set: the uncovered methods are a
// DECLARED, enumerated gap (a snapshot below), because vendoring a module is human
// classification work and a wall of red says nothing about which piece to do next.
// What IS red-by-default is a change: a new call, or a method leaving the list.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { promisedVersion } from "./helpers/vendored.js";
import { requestCallSites, sourceFiles } from "./helpers/rpc-sites.js";

const SRC = new URL("../src/", import.meta.url);

/** Call sites whose method name is a TEMPLATE over an allowlisted set, with the set
 *  enumerated. The bridge has exactly one: `/tts` builds `tts.${method}` from a body
 *  field it first restricts to `status|providers|convert` (server.ts). Declared here
 *  rather than refactored, because this lot must not touch the turn path — but
 *  declared EXPLICITLY, so the three methods count toward the derived surface instead
 *  of vanishing. A NEW indirect site fails the test until it is decided. */
const INDIRECT_EXPANSIONS: Record<string, string[]> = {
  "`tts.${method}`": ["tts.status", "tts.providers", "tts.convert"],
};

/** Every gateway RPC method the bridge invokes, read out of the source.
 *
 *  Reads the SOURCE rather than a hand-kept list — a list would be exactly the thing
 *  that drifts. Multi-line calls count: the method literal may sit on the line after
 *  `.request(`, and the first version of this regex missed a third of the surface. */
function calledMethods(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const site of requestCallSites()) {
    const methods =
      site.method !== null
        ? [site.method]
        : (INDIRECT_EXPANSIONS[site.expression ?? ""] ?? []);
    for (const m of methods) {
      const where = found.get(m) ?? [];
      where.push(site.file);
      found.set(m, where);
    }
  }
  return found;
}

/** Which upstream schema module holds a namespace's PARAM schemas — verified by
 *  reading `packages/gateway-protocol/src/index.ts`'s validators at v2026.7.1, not
 *  guessed from the name (the first version of this map sent `talk.*` to `agent.ts`,
 *  which is vendored, and so reported two uncovered RPCs as covered).
 *
 *  `null` means the method takes NO params on the wire — nothing to vendor and
 *  nothing to classify, which is a different fact from "not done yet". */
const NAMESPACE_MODULE: Record<string, string | null> = {
  chat: "logs-chat.ts",
  sessions: "sessions.ts",
  cron: "cron.ts",
  tasks: "tasks.ts",
  config: "config.ts",
  // `models.list`, `agents.list` and the `agents.files.*` trio share one module.
  models: "agents-models-skills.ts",
  agents: "agents-models-skills.ts",
  // TalkClientCreate/ToolCall params live with the channel schemas.
  talk: "channels.ts",
  // `usage.status` is `async ({ respond }) => …` upstream: no params at all.
  usage: null,
  // Upstream validates only `tts.speak` (schema/channels.ts). The three methods the
  // bridge reaches (status/providers/convert) have NO param schema upstream, so
  // "vendor channels.ts" would not cover them. Mapped to the module anyway so the
  // gap is attributable rather than unmapped.
  tts: "channels.ts",
};

/** Modules vendored for the version the bridge PROMISES (`maxValidated`).
 *
 *  Not the newest directory on disk (raised in review): vendoring 2026.8.x to prepare
 *  a bump would otherwise make a module added only there count as covering an RPC for
 *  the 2026.7.1 contract we actually claim. */
function vendoredModules(): Set<string> {
  return new Set(
    readdirSync(
      new URL(`../protocol/openclaw/${promisedVersion()}/`, import.meta.url),
    ).filter((f) => f.endsWith(".ts")),
  );
}

/** The methods knowingly WITHOUT a vendored contract, as of 2026-07-26.
 *
 *  This is a declared gap, not an accident: each one needs its upstream schema module
 *  vendored AND every field classified. Shrinking this list is the work; growing it
 *  without a decision is what the test forbids. */
const UNCOVERED_SNAPSHOT = [
  // `cron.*` and `tasks.*` left this list on 2026-07-27 with schema/cron.ts and
  // schema/tasks.ts (31 more schemas classified).
  // `sessions.*` left this list on 2026-07-27: schema/sessions.ts is vendored and its
  // 48 schemas are classified — EXCEPT `sessions.get`, which upstream does not
  // validate at all: its handler parses `{key, sessionKey, limit}` by hand
  // (server-methods/sessions.ts) and no `SessionsGetParamsSchema` exists. Uncovered by
  // CONSTRUCTION, not by omission — the same category as `usage.status` and `tts.*`.
  "sessions.get",
  "agents.files.get",
  "agents.files.list",
  "agents.files.set",
  "agents.list",
  "config.get",
  "config.patch",
  "models.list",
  "talk.client.create",
  "talk.client.toolCall",
  // The three `tts.*` methods the /tts passthrough can reach. Upstream schematizes
  // only `tts.speak` (channels.ts), so `status`/`providers`/`convert` have no param
  // schema at all — they are uncovered by CONSTRUCTION, not by omission.
  "tts.convert",
  "tts.providers",
  "tts.status",
];

/** Every `*ParamsSchema` exported by the modules vendored for the PROMISED version. */
function vendoredParamSchemas(): Set<string> {
  const dir = new URL(`../protocol/openclaw/${promisedVersion()}/`, import.meta.url);
  const out = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const text = readFileSync(new URL(f, dir), "utf-8");
    for (const m of text.matchAll(/export const ([A-Za-z0-9_]+Schema)\b/g)) {
      out.add(m[1]!);
    }
  }
  return out;
}

/** Upstream's mechanical naming: `sessions.compaction.list` ->
 *  `SessionsCompactionListParamsSchema`. */
function paramsSchemaName(method: string): string {
  return `${method
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}ParamsSchema`;
}

/**
 * Methods whose CONTRACT is not enumerated in this repo.
 *
 * ONE definition, deliberately: "the module is vendored" is not coverage — a module
 * can be present and still hold no schema for the method (`sessions.get` is parsed by
 * hand upstream and has none). Two tests computing "covered" two different ways
 * disagreed the moment sessions.ts landed, so the schema-level check is now the only
 * one and the module check feeds it.
 */
function uncovered(): string[] {
  const modules = vendoredModules();
  const schemas = vendoredParamSchemas();
  return [...calledMethods().keys()]
    .filter((m) => {
      const ns = m.split(".")[0]!;
      if (!(ns in NAMESPACE_MODULE)) return true; // unmapped: reported by name below
      const module = NAMESPACE_MODULE[ns] ?? null;
      if (module === null) return false; // no params on the wire: nothing to cover
      if (!modules.has(module)) return true; // module not vendored at all
      return !schemas.has(paramsSchemaName(m)); // vendored, but no schema for THIS method
    })
    .sort();
}

/** `.request` occurrences that are NOT gateway calls. Declared one by one, because the
 *  sweep below is FAIL-CLOSED: any `.request` token that no call pattern recognizes
 *  must appear here. That is what makes the derivation independent of how clever the
 *  call regex is — review found three shapes it missed in a row (optional call,
 *  generic call, generic-with-parentheses), and this closes the class rather than the
 *  instances. */
const NON_CALL_REFERENCES: { file: string; text: string }[] = [
  // A doc comment describing the connection's own method.
  { file: "conf.ts", text: "OpenClawConnection.request" },
  // A Hermes event NAME that happens to end in `.request`.
  { file: "ws-turn.ts", text: '"approval.request"' },
];

describe("RPC scope derivation (W10)", () => {
  it("EVERY `.request` token is a recognized call or a declared non-call", () => {
    // The fail-closed backstop. A call shape the patterns do not match cannot slip
    // through silently any more: it lands here, unrecognized and undeclared, and the
    // test names its file and line.
    const CALL = new RegExp(
      String.raw`\.request(?:\?\.)?\s*(?:<[^()\n]*>\s*)?\(`,
      "g",
    );
    const stray: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf-8");
      const name = file.pathname.split("/").pop()!;
      const callStarts = new Set([...source.matchAll(CALL)].map((m) => m.index));
      // Bracket access counts too: `client["request"](…)` contains no `.request` at
      // all, so a sweep anchored only on the dotted form would let it through while
      // claiming completeness (raised in review). All three quote styles, backtick
      // included — the same review found `client[`request`]` slipping past a
      // two-quote class.
      for (const m of source.matchAll(/\[\s*["'`]request["'`]\s*\]/g)) {
        const line = source.slice(0, m.index).split("\n").length;
        stray.push(`${name}:${line} (bracket access)`);
      }
      // And DESTRUCTURING: `const { request: rpc } = conn; rpc("x", …)` reaches the
      // gateway with no `.request` token anywhere (raised in review). Following the
      // alias would need real static analysis; refusing the alias costs nothing,
      // because no bridge code does this and none needs to.
      for (const m of source.matchAll(
        // The optional `: Type` between `}` and `=` is not decoration: an ANNOTATED
        // destructuring (`const { request: rpc }: Gateway = conn`) slipped past the
        // first pattern (raised in review). No `(` in the annotation, so it cannot run
        // away past the statement.
        /(?:const|let|var)\s*\{[^}\n]*\brequest\b[^}\n]*\}\s*(?::[^=(\n]*)?=/g,
      )) {
        const line = source.slice(0, m.index).split("\n").length;
        stray.push(`${name}:${line} (destructured request)`);
      }
      // A destructured PARAMETER is the same alias by another route:
      // (single-LINE braces only: `[^}]*` crossed newlines and matched an object
      // literal passed as an argument several lines below — a real false positive.)
      // `function relay({ request: rpc }: Gateway) { rpc("x", …) }` (raised in
      // review). No bridge code destructures a connection in a parameter list, so
      // refusing the shape costs nothing and closes the last way in.
      for (const m of source.matchAll(/\(\s*\{[^}\n]*\brequest\b[^}\n]*\}/g)) {
        const line = source.slice(0, m.index).split("\n").length;
        stray.push(`${name}:${line} (destructured request parameter)`);
      }
      for (const m of source.matchAll(/\.request\b/g)) {
        if (callStarts.has(m.index)) continue;
        const around = source.slice(Math.max(0, m.index! - 60), m.index! + 60);
        const declared = NON_CALL_REFERENCES.some(
          (r) => r.file === name && around.includes(r.text),
        );
        if (declared) continue;
        const line = source.slice(0, m.index).split("\n").length;
        stray.push(`${name}:${line}`);
      }
    }
    expect(
      stray,
      "a `.request` occurrence that is neither a recognized call shape nor a " +
        "declared non-call reference: if it IS a gateway call, the derivation is " +
        "blind to it — widen the pattern; if not, declare it.",
    ).toEqual([]);
  });

  it("finds the real call surface, multi-line calls included", () => {
    const methods = calledMethods();
    // Sanity on the extractor: if the regex ever stops matching, every assertion
    // below passes vacuously — the classic way a derivation gate stops deriving.
    expect(methods.size).toBeGreaterThan(20);
    expect([...methods.keys()]).toContain("chat.send");
    // `sessions.describe` sits on the line after `.request(` — the case the first
    // extractor missed, and the reason this expectation is named.
    expect([...methods.keys()]).toContain("sessions.describe");
  });

  it("no `.request(` call hides its method behind a variable", () => {
    // An indirect method name is not a style question: the derivation reads literals,
    // so a constant or a template would add an RPC the ratchet cannot see. If one is
    // ever needed, the decision belongs here — with the method enumerated — not in a
    // silent gap.
    const undeclared = requestCallSites()
      .filter((s) => s.method === null)
      .filter((s) => !((s.expression ?? "") in INDIRECT_EXPANSIONS))
      .map((s) => `${s.file}: ${s.expression}`);
    expect(
      undeclared,
      "a .request() call whose method is not a plain string literal and whose " +
        "expression is not enumerated in INDIRECT_EXPANSIONS: the RPC-scope " +
        "derivation cannot see it. Inline the method name, or declare its expansion.",
    ).toEqual([]);
  });

  it("every called namespace maps to a known upstream module", () => {
    const unmapped = [...calledMethods().keys()]
      .map((m) => m.split(".")[0]!)
      .filter((ns) => !(ns in NAMESPACE_MODULE));
    expect(
      [...new Set(unmapped)],
      "a new RPC namespace: say which upstream schema module covers it (NAMESPACE_MODULE)",
    ).toEqual([]);
  });

  it("the UNCOVERED set matches its declared snapshot exactly", () => {
    // Both directions matter. A method APPEARING here is a new call with no
    // contract — decide before shipping it. A method DISAPPEARING means its module
    // was vendored: delete the line, and the diff records the progress.
    expect(
      uncovered(),
      "the set of RPCs with no vendored contract changed — vendor the module or " +
        "update UNCOVERED_SNAPSHOT deliberately",
    ).toEqual([...UNCOVERED_SNAPSHOT].sort());
  });

  it("the methods we claim to cover are nameable in the vendored schemas", () => {
    // DIRECT, not derived (raised in review): the previous version filtered
    // `!uncovered().includes(m)` and then re-applied the very check `uncovered()` had
    // just applied, so it could never find anything — a test that could not fail.
    // This one names the methods and looks their schema up in the vendored files, so
    // losing a schema, losing the vendoring, or dropping the schema check out of
    // `uncovered()` all turn it red.
    const MUST_BE_ENUMERATED = [
      "chat.send",
      "chat.abort",
      "sessions.describe",
      "sessions.patch",
      "sessions.reset",
      "sessions.compact",
      "sessions.compaction.list",
      // The cron/tasks families, added 2026-07-27. This list is the DIRECT,
      // non-derived claim, so every newly covered method must join it — omitting them
      // (as the first edit silently did) leaves their schemas free to vanish while the
      // snapshot stays green.
      "cron.list",
      "cron.get",
      "cron.update",
      "cron.remove",
      "cron.run",
      "cron.runs",
      "tasks.get",
      "tasks.list",
    ];
    // The list must be EXHAUSTIVE, not a sample (raised in review): adding a call to
    // a method whose schema happens to be vendored — `cron.status`, say — would leave
    // `uncovered()` and its snapshot untouched and every test green, while that
    // schema's classification still said the bridge never calls it. Equality forces
    // the new method into view.
    const covered = [...calledMethods().keys()]
      .filter((m) => !uncovered().includes(m))
      .filter((m) => NAMESPACE_MODULE[m.split(".")[0]!] !== null)
      .sort();
    expect(
      covered,
      "a method became covered without joining MUST_BE_ENUMERATED — add it, and check " +
        "its schema classification still tells the truth about what the bridge does",
    ).toEqual([...MUST_BE_ENUMERATED].sort());

    const schemas = vendoredParamSchemas();
    for (const m of MUST_BE_ENUMERATED) {
      expect(
        schemas.has(paramsSchemaName(m)),
        `${m} -> ${paramsSchemaName(m)} is missing from the vendored schemas`,
      ).toBe(true);
      // …and the derivation must AGREE that it is covered. The two together are what
      // make the claim mean something.
      expect(uncovered(), m).not.toContain(m);
    }
    // The seventh sessions call stays declared-uncovered: upstream parses it by hand
    // and exports no schema for it.
    expect(uncovered()).toContain("sessions.get");
  });

  it("the chat lane IS covered (the ratchet is not vacuous)", () => {
    // The one namespace whose contract is vendored and classified. If this ever
    // joins the uncovered set, the ratchet is protecting nothing at all.
    expect(uncovered()).not.toContain("chat.send");
    expect(uncovered()).not.toContain("chat.abort");
  });
});
