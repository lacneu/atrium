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

import { COMPAT_MANIFEST } from "../src/compat.js";

const SRC = new URL("../src/", import.meta.url);

/** Source files of the bridge, recursively. */
function sourceFiles(dir: URL = SRC, out: URL[] = []): URL[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) sourceFiles(child, out);
    else if (entry.name.endsWith(".ts")) out.push(child);
  }
  return out;
}

/** Every `.request(` call site: the method name when it is a plain string literal,
 *  or the raw first-argument EXPRESSION when it is anything else. */
function requestCallSites(): {
  method: string | null;
  expression?: string;
  file: string;
}[] {
  // Two patterns over the same anchor. The literal one extracts the name; the ANY one
  // counts call sites. A site the first matches and the second does not cannot exist;
  // a site only the second matches is an INDIRECT method name, which defeats the
  // whole derivation — reported by name rather than silently skipped (the first
  // version of this test only looked for double-quoted literals, so a constant or a
  // template literal would have added an RPC with no contract and stayed green).
  // Three call shapes the first versions missed, each raised in review and each a way
  // for an RPC to vanish from the derived surface while every size assertion stayed
  // green: an OPTIONAL call (`client.request?.(…)`), a GENERIC call
  // (`client.request<Result>(…)`), and the two combined.
  // The type-argument class must ALLOW braces (`request<{ok:boolean}>(…)` is the shape
  // the bridge would actually write) while excluding parentheses and newlines so the
  // match cannot run away. Excluding braces made the generic case silently unmatched.
  const CALL = String.raw`\.request(?:\?\.)?\s*(?:<[^()\n]*>\s*)?\(`;
  const LITERAL = new RegExp(
    `${CALL}\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)?(?://[^\\n]*\\n\\s*)*"([a-zA-Z0-9._]+)"`,
    "g",
  );
  const ANY = new RegExp(CALL, "g");
  const sites: { method: string | null; expression?: string; file: string }[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf-8");
    const name = file.pathname.split("/").pop()!;
    const literals = [...source.matchAll(LITERAL)];
    const all = [...source.matchAll(ANY)];
    // Match them by position: a literal call site starts where an ANY match starts.
    const literalStarts = new Set(literals.map((m) => m.index));
    for (const m of literals) sites.push({ method: m[1]!, file: name });
    for (const m of all) {
      if (literalStarts.has(m.index)) continue;
      // The first argument's own text, up to the comma. Identifying an indirect site
      // by its EXPRESSION rather than by its file (raised in review): keyed by file,
      // a second indirect call in server.ts would have silently inherited the TTS
      // expansion and vanished from the derived surface.
      const after = source.slice(m.index! + m[0].length);
      const expression = (after.split(",")[0] ?? "").trim();
      sites.push({ method: null, expression, file: name });
    }
  }
  return sites;
}

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
  const promised = COMPAT_MANIFEST.providers.openclaw?.supportedRange?.maxValidated;
  if (!promised) throw new Error("the openclaw provider declares no supported range");
  return new Set(
    readdirSync(
      new URL(`../protocol/openclaw/${promised}/`, import.meta.url),
    ).filter((f) => f.endsWith(".ts")),
  );
}

/** The methods knowingly WITHOUT a vendored contract, as of 2026-07-26.
 *
 *  This is a declared gap, not an accident: each one needs its upstream schema module
 *  vendored AND every field classified. Shrinking this list is the work; growing it
 *  without a decision is what the test forbids. */
const UNCOVERED_SNAPSHOT = [
  "agents.files.get",
  "agents.files.list",
  "agents.files.set",
  "agents.list",
  "config.get",
  "config.patch",
  "cron.get",
  "cron.list",
  "cron.remove",
  "cron.run",
  "cron.runs",
  "cron.update",
  "models.list",
  "sessions.compact",
  "sessions.compaction.list",
  "sessions.describe",
  "sessions.get",
  "sessions.patch",
  "sessions.reset",
  "talk.client.create",
  "talk.client.toolCall",
  "tasks.get",
  "tasks.list",
  // The three `tts.*` methods the /tts passthrough can reach. Upstream schematizes
  // only `tts.speak` (channels.ts), so `status`/`providers`/`convert` have no param
  // schema at all — they are uncovered by CONSTRUCTION, not by omission.
  "tts.convert",
  "tts.providers",
  "tts.status",
];

function uncovered(): string[] {
  const modules = vendoredModules();
  return [...calledMethods().keys()]
    .filter((m) => {
      const ns = m.split(".")[0]!;
      if (!(ns in NAMESPACE_MODULE)) return true; // unmapped: reported by name below
      const module = NAMESPACE_MODULE[ns] ?? null;
      if (module === null) return false; // no params on the wire: nothing to cover
      return !modules.has(module);
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

  it("a covered method has its OWN params schema in the vendored module", async () => {
    // Namespace-level coverage is not coverage: `chat.newRpc` would count as covered
    // merely because `logs-chat.ts` exists, with no schema for it and nothing to
    // classify (raised in review). Upstream's naming is mechanical —
    // `sessions.describe` -> `SessionsDescribeParamsSchema` — so the link is
    // checkable. Methods with NO params schema upstream are listed by name: for those
    // the gateway itself validates nothing, which is a fact about the protocol.
    const promised =
      COMPAT_MANIFEST.providers.openclaw?.supportedRange?.maxValidated;
    if (!promised) throw new Error("no supported range");
    const exports = new Set<string>();
    for (const file of readdirSync(
      new URL(`../protocol/openclaw/${promised}/`, import.meta.url),
    ).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(
        new URL(`../protocol/openclaw/${promised}/${file}`, import.meta.url),
        "utf-8",
      );
      for (const m of text.matchAll(/export const ([A-Za-z0-9_]+Schema)\b/g)) {
        exports.add(m[1]!);
      }
    }
    const schemaName = (method: string): string =>
      `${method
        .split(".")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("")}ParamsSchema`;

    const missing = [...calledMethods().keys()]
      .filter((m) => !uncovered().includes(m))
      // Methods that take NO params have nothing to enumerate — `usage.status` is
      // `async ({ respond }) => …` upstream. Excluded by the same declared fact that
      // keeps them out of the uncovered set, not by a special case here.
      .filter((m) => NAMESPACE_MODULE[m.split(".")[0]!] !== null)
      .filter((m) => !exports.has(schemaName(m)))
      .sort();
    expect(
      missing,
      "these methods sit in a vendored module but have no *ParamsSchema there — " +
        "their contract is not actually enumerated: " + missing.join(", "),
    ).toEqual([]);
  });

  it("the chat lane IS covered (the ratchet is not vacuous)", () => {
    // The one namespace whose contract is vendored and classified. If this ever
    // joins the uncovered set, the ratchet is protecting nothing at all.
    expect(uncovered()).not.toContain("chat.send");
    expect(uncovered()).not.toContain("chat.abort");
  });
});
