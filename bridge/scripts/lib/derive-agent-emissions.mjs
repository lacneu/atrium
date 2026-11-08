import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import ts from "typescript";

// Derive the EMISSION SURFACE of the gateway's `agent` event channel from upstream SOURCE.
//
// `AgentEventSchema.data` is `Type.Record(Type.String(), Type.Unknown())`: the vendored
// protocol says nothing about what an `agent` frame carries — which `stream` values exist,
// which `data.phase` each one moves through, which `data` keys it holds. The bridge's
// `KNOWN_AGENT_STREAMS` was therefore written by hand, and a new stream, phase or key in
// a new version reached the wire with nothing to say so. This module reads the answer out
// of the code that EMITS the frames, so two versions can be compared without anyone
// remembering what to look for.
//
// METHOD. One upstream function is named — the dispatcher that hands an event to the
// public listener registry (the gateway subscribes there). Everything else is DISCOVERED
// by following references with the TypeScript checker, transitively: a function that
// passes (part of) its own parameters into a known emitter is a WRAPPER, and its call
// sites are examined in turn; a function VALUE that reaches an emitter (an alias, a
// callback property, a constructor parameter, a closure returned by a factory) is
// followed to where it is called. No list of emitters is written here.
//
// Values are resolved by an abstract evaluator over the parsed tree: literals, constants
// (local or imported), ternaries and logical defaults, object literals and their spreads,
// `let` bindings (every assignment in scope), property writes on a binding, local helper
// calls (inlined), and — only when the syntax gives out — the DECLARED TYPE of the
// expression (a closed union of literals, or an object type's properties), recorded as
// such. What cannot be resolved becomes an `opaque` entry carrying the precise reason and
// the file:line it came from. Nothing is dropped in silence: a site this module cannot
// read is a row of the inventory, not a missing one.
//
// COMPLETENESS is accounted, not assumed. Every identifier whose name matches a member of
// the discovered family is resolved: it is either a reference to a member (and then an
// emission site, a forwarding site inside a wrapper, a followed value flow, an import, a
// type-only use, or an explicitly classified escape) or it binds to some other
// declaration (a homonym, listed with its declaration). An identifier that binds to a
// member and received no class is `unaccounted` — the count that must be zero.
//
// OPEN rows. A member whose callers are not all in reach — exported by the public surface
// (upstream's own `openclaw/plugin-sdk/*` paths), a member of a type that surface exposes,
// referenced by no name (a dynamic table, `handlers[key]`), or stored where its calls
// cannot be followed (a listener registry) — still emits what its template fixes; its
// parameters are closed by their declared types and the rest is an opaque contribution.
//
// AFTER the emitter, the bus enriches lifecycle data and the gateway rewrites, strips and
// fabricates frames (src/gateway): `transformations` records those by shape, anchored on
// an agent event's `data` type, with the stream/phase guards that select them.
//
// LIMITS, stated. The evaluator is flow-insensitive except for two constructs: a ternary
// over a discriminant (`x.kind === "a" ? … : …`, narrowed) and a test on a parameter
// (decided at the call site). A data object handed to a helper that mutates it is seen
// only for writes in its own scope (`x.k = v`, `Object.assign(x, …)`). Values taken from
// declared types are over-approximations and are marked `src: "type"`. Every bound of the
// evaluator, when reached, is an opaque row naming it.
//
// Same discipline as the sibling derivers (derive-event-catalogue, derive-broadcast-
// catalogue, derive-snapshot): TypeScript's own parser and checker, never a text scan; a
// structure this module cannot account for is a HARD ERROR or an OPAQUE row, never a
// shorter inventory.
//
// CLI (needs upstream's root tsconfig.json for its `paths`; re-executes with a 12 GB heap):
//   node scripts/lib/derive-agent-emissions.mjs --root <checkout> --tsconfig <tsconfig.json>
//     [--version <v>] [--commit <sha>] [--out <file>]       (DERIVE_AGENT_EMISSIONS_TRACE=1)

/** The module that owns the agent event bus. */
export const ROOT_SOURCE = "src/infra/agent-events.ts";
/** The one function named by hand: it hands an event to the PUBLIC listener registry. */
export const ROOT_DISPATCHER = "dispatchAgentEvent";
/** The generator over the public listeners (`onAgentEvent`, `onAgentRuntimeEvent`,
 *  `onAgentEventForRun`). The dispatcher must be the ONLY function feeding it: a second
 *  door to the public listeners would be a second root, and choosing one would inventory
 *  half of what reaches the gateway. */
export const ROOT_LISTENER_ITERATOR = "iterateAgentEventListeners";
/** Upstream's declared stream union — reported for reference, never used as the answer. */
export const STREAM_TYPE = "AgentEventStream";
/** Top-level directories of an upstream checkout that are analysed. */
export const SCAN_DIRS = ["src", "packages", "extensions", "ui"];
/** The gateway's own code, for the relay/fabrication section. */
export const GATEWAY_DIR = "src/gateway/";
/** The chat display projection modules (section 2). */
export const CHAT_PROJECTION_PREFIX = "src/gateway/chat-display-projection";
export const INVENTORY_SCHEMA = "atrium.agent-emissions/1";

const SOURCE_FILE_RE = /\.(?:[cm]?ts|tsx)$/;
const NON_TS_SOURCE_RE = /\.(?:[cm]?js|jsx)$/;

/**
 * What counts as TEST code, in the order the rules are tried.
 *
 * The first three mirror upstream's own production boundary — `tsconfig.core.json`
 * (`**\/*.test.ts`, `**\/*.test.tsx`, `test/**`) and `tsconfig.extensions.json`
 * (`*test-helpers.ts`, `*test-harness.ts`, `*test-support.ts`, `extensions/**\/test/**`,
 * `extensions/**\/src/test-support/**`) — generalised to every directory, plus the
 * `.test-<kind>.ts` family upstream also uses (`.test-utils.ts`, `.mocks.test-utils.ts`).
 * The fourth is a fact rather than a naming convention: production code never imports
 * vitest. A pattern that over-excludes is caught by the IMPORT GUARD (`collectFiles`): a
 * file production code imports at runtime is put back, and the inventory says so.
 */
export const TEST_FILE_RULES = [
  {
    id: "test-suffix",
    description: "basename ends in .test.ts / .test.tsx / .test.mts / .test.cts",
    match: (rel) => /\.test\.(?:[cm]?ts|tsx)$/.test(rel),
  },
  {
    id: "test-support-suffix",
    description:
      "basename ends in .test-<kind>.ts (test-helpers, test-harness, test-support, test-utils, …) " +
      "or in test-helpers.ts / test-harness.ts / test-support.ts",
    match: (rel) =>
      /\.test-[A-Za-z0-9-]+\.(?:[cm]?ts|tsx)$/.test(rel) ||
      /test-(?:helpers|harness|support)\.(?:[cm]?ts|tsx)$/.test(rel),
  },
  {
    id: "test-dir",
    description:
      "a directory segment named test, tests, __tests__, test-support, test-helpers or test-utils",
    match: (rel) => /(?:^|\/)(?:test|tests|__tests__|test-support|test-helpers|test-utils)\//.test(rel),
  },
  {
    id: "imports-vitest",
    description: "imports from vitest (production code never does)",
    match: (_rel, text) =>
      text !== undefined && /\bfrom\s+["'](?:vitest|@vitest\/[^"']+)["']/.test(text),
  },
];

/** The first test rule matching this file, or null. */
export function testRuleOf(rel, text) {
  for (const rule of TEST_FILE_RULES) if (rule.match(rel, text)) return rule.id;
  return null;
}

// Bounds of the evaluator. Each one, when reached, produces an OPAQUE value naming it —
// never a silent cut.
const MAX_INLINE_DEPTH = 8;
const MAX_STEPS_PER_SITE = 100000;
const MAX_UNION = 64;
const MAX_VARIANTS = 96;
const MAX_TYPE_DEPTH = 8;
const MAX_REQUEUE = 6;

const ARRAY_ITERATION_METHODS = new Set([
  "forEach",
  "map",
  "flatMap",
  "filter",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
  "some",
  "every",
]);

// ---------------------------------------------------------------------------------------
// Abstract values
//
// lit      a JavaScript primitive known from source
// absent   no value (undefined, a missing property)
// union    alternatives (a ternary, a `??`, a `let` assigned twice, a closed literal type)
// obj      ordered entries: props (with an `opt` flag) and spreads (in source order —
//          which one wins a key depends on it)
// arr      array literal elements
// tobj     an object known only by its DECLARED TYPE (lazy: properties read on demand)
// hole     "parameter #idx of function fn, at property path" — the thing a wrapper's
//          callers fill in
// call     a call whose callee is still a hole (a thunk parameter: `data()`)
// fn       a function value (closure) — callbacks and thunks
// derived  a string obtained from another value through a transformation this module
//          does not model (`x.trim()` of a parameter) — kept so the parameter can still
//          be resolved at the call site
// tpl      a template literal with unresolved parts
// opaque   unknown, with the reason and where it came from
// ---------------------------------------------------------------------------------------

const ABSENT = Object.freeze({ k: "absent" });
const lit = (v) => ({ k: "lit", v });
const opaque = (reason, at) => ({ k: "opaque", reason, at });

// Structural identity of a value, so that a union of two equal objects is one object:
// without it, every branch that rebuilds the same literal doubled the alternatives and a
// handful of wrappers hit the union bound for nothing.
const identities = new WeakMap();
let nextIdentity = 1;
function identity(obj) {
  let id = identities.get(obj);
  if (id === undefined) {
    id = nextIdentity;
    nextIdentity += 1;
    identities.set(obj, id);
  }
  return id;
}
const avKeys = new WeakMap();
function avKey(av) {
  if (!av || typeof av !== "object") return String(av);
  const hit = avKeys.get(av);
  if (hit !== undefined) return hit;
  let k;
  switch (av.k) {
    case "lit":
      k = `L${typeof av.v}:${JSON.stringify(av.v)}`;
      break;
    case "absent":
      k = "A";
      break;
    case "opaque":
      k = `O${av.reason}@${av.at ?? ""}`;
      break;
    case "hole":
      k = `H${identity(av.fn)}:${av.idx}:${av.path.join(".")}`;
      break;
    case "fn":
      k = `F${identity(av.node)}`;
      break;
    case "tobj":
      k = `T${identity(av.type)}`;
      break;
    case "union":
      k = `U(${av.opts.map(avKey).sort().join("|")})`;
      break;
    case "obj":
      k = `B{${av.entries.map((e) => (e.t === "prop" ? `p${e.key}${e.opt ? "?" : ""}=${e.lazy ? `Z${identity(e)}` : avKey(e.v)}` : e.t === "spread" ? `s${avKey(e.v)}` : `k${e.text}`)).join(",")}}`;
      break;
    case "arr":
      k = `R${av.typed ? identity(av.typed) : ""}[${av.elems.map(avKey).join(",")}]`;
      break;
    case "call":
      k = `C(${avKey(av.callee)};${av.args.map(avKey).join(",")};${(av.path ?? []).join(".")})`;
      break;
    case "derived":
      k = `D(${avKey(av.from)}.${av.via})`;
      break;
    case "tpl":
      k = `P(${av.parts.map((p) => (typeof p === "string" ? JSON.stringify(p) : avKey(p))).join(",")})`;
      break;
    case "guard":
      k = `G(${avKey(av.base)};${av.prop};${JSON.stringify(av.lit)};${av.eq};${avKey(av.t)};${avKey(av.f)})`;
      break;
    default:
      k = `?${av.k}`;
  }
  avKeys.set(av, k);
  return k;
}
function avEquals(a, b) {
  return a === b || avKey(a) === avKey(b);
}

function union(list) {
  const flat = [];
  const seenKeys = new Set();
  const push = (v) => {
    if (v.k === "union") {
      for (const o of v.opts) push(o);
      return;
    }
    const key = avKey(v);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    flat.push(v);
  };
  for (const v of list) push(v);
  if (flat.length === 0) return ABSENT;
  if (flat.length === 1) return flat[0];
  if (flat.length > MAX_UNION) {
    return opaque(`more than ${MAX_UNION} alternatives (evaluator bound)`, undefined);
  }
  return { k: "union", opts: flat };
}

function objFromEntries(entries, at) {
  return { k: "obj", entries, at };
}

// A PROPERTY's value is computed only when something asks for it. Only `stream`,
// `data`, `phase` and spreads decide what this inventory records; evaluating every text,
// id and metadata value on the way (an inlined formatter, a display helper) exhausted
// the evaluation budget at the busiest emission site and lost its keys.
function propVal(e) {
  if (e.lazy) {
    const f = e.lazy;
    e.lazy = undefined;
    e.v = f();
  }
  return e.v;
}
function lazyProp(key, thunk, extra = {}) {
  return { t: "prop", key, v: undefined, lazy: thunk, opt: false, ...extra };
}
/** Same entry, value transformed lazily. */
function mapProp(e, f) {
  if (e.lazy || e.v === undefined) {
    const src = e;
    return { ...e, v: undefined, lazy: () => f(propVal(src)) };
  }
  return { ...e, v: f(e.v), lazy: undefined };
}

/** Does `av` certainly carry `key`? (a non-optional prop, or a spread that certainly
 *  does; `typed(av, key)` answers for a value known by its declared type) */
function definitelyHas(av, key, typed = () => false) {
  switch (av.k) {
    case "obj":
      return av.entries.some(
        (e) => (e.t === "prop" && e.key === key && !e.opt) || (e.t === "spread" && definitelyHas(e.v, key, typed)),
      );
    case "union":
      return av.opts.every((o) => definitelyHas(o, key, typed));
    case "guard":
      return definitelyHas(av.t, key, typed) && definitelyHas(av.f, key, typed);
    case "tobj":
      return typed(av, key);
    default:
      return false;
  }
}

/** Collect hole function nodes referenced by `av` (deep). */
function holeFns(av, out = new Set(), seen = new Set()) {
  if (!av || seen.has(av)) return out;
  seen.add(av);
  switch (av.k) {
    case "hole":
      out.add(av.fn);
      break;
    case "union":
      for (const o of av.opts) holeFns(o, out, seen);
      break;
    case "obj":
      for (const e of av.entries) {
        if (e.t === "spread" || (e.t === "prop" && !e.lazy)) holeFns(e.v, out, seen);
      }
      break;
    case "arr":
      for (const e of av.elems) holeFns(e, out, seen);
      break;
    case "call":
      holeFns(av.callee, out, seen);
      for (const a of av.args) holeFns(a, out, seen);
      break;
    case "derived":
      holeFns(av.from, out, seen);
      break;
    case "tpl":
      for (const p of av.parts) if (typeof p !== "string") holeFns(p, out, seen);
      break;
    case "guard":
      holeFns(av.base, out, seen);
      holeFns(av.t, out, seen);
      holeFns(av.f, out, seen);
      break;
    default:
      break;
  }
  return out;
}

/** A GUARDED value — `base.prop === lit ? t : f` whose test depends on a parameter: decided
 *  where the parameter is filled (`tool.phase === "result" ? "end" : tool.phase` must not
 *  report "result" once the caller passes it). Undecided, it is the union of both. */
function asUnion(av) {
  return av && av.k === "guard" ? union([asUnion(av.t), asUnion(av.f)]) : av;
}

// ---------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** A filesystem view: the real one (rooted at an upstream checkout) or a virtual one
 *  (the synthetic sources of the tests). Same interface either way, so the tests run the
 *  exact code path the real derivation runs. */
function realFs(root) {
  const abs = (rel) => path.join(root, rel);
  return {
    root,
    list() {
      const out = [];
      const walk = (relDir) => {
        let entries;
        try {
          entries = fs.readdirSync(abs(relDir), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const rel = relDir ? `${relDir}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (e.name === "node_modules" || e.name === "dist") continue;
            walk(rel);
          } else if (e.isFile()) {
            out.push(rel);
          }
        }
      };
      for (const d of SCAN_DIRS) walk(d);
      return out.sort();
    },
    read(rel) {
      return fs.readFileSync(abs(rel), "utf8");
    },
  };
}

function virtualFs(root, files) {
  const map = new Map(Object.entries(files).map(([k, v]) => [toPosix(k), v]));
  return {
    root,
    virtual: map,
    list() {
      return [...map.keys()].filter((rel) => SCAN_DIRS.some((d) => rel.startsWith(`${d}/`))).sort();
    },
    read(rel) {
      const v = map.get(rel);
      if (v === undefined) throw new Error(`virtual file ${rel} does not exist`);
      return v;
    },
  };
}

function createHost(view, options) {
  const root = view.root;
  const base = ts.createCompilerHost(options, true);
  if (!view.virtual) return base;
  const relOf = (fileName) => {
    const n = toPosix(path.resolve(root, fileName));
    const r = toPosix(root);
    return n.startsWith(`${r}/`) ? n.slice(r.length + 1) : undefined;
  };
  const dirs = new Set();
  for (const rel of view.virtual.keys()) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  const readVirtual = (fileName) => {
    const rel = relOf(fileName);
    if (rel !== undefined) return view.virtual.get(rel);
    return base.readFile(fileName);
  };
  return {
    ...base,
    getCurrentDirectory: () => root,
    fileExists: (f) => {
      const rel = relOf(f);
      return rel !== undefined ? view.virtual.has(rel) : base.fileExists(f);
    },
    readFile: readVirtual,
    directoryExists: (d) => {
      const rel = relOf(d);
      if (rel === undefined) return base.directoryExists?.(d) ?? false;
      return rel === "" || dirs.has(rel);
    },
    getDirectories: (d) => {
      const rel = relOf(d);
      if (rel === undefined) return base.getDirectories?.(d) ?? [];
      const prefix = rel === "" ? "" : `${rel}/`;
      const out = new Set();
      for (const x of dirs) {
        if (x.startsWith(prefix)) {
          const rest = x.slice(prefix.length);
          if (rest && !rest.includes("/")) out.add(rest);
        }
      }
      return [...out];
    },
    realpath: (p) => p,
    getSourceFile: (fileName, languageVersion, onError) => {
      const text = readVirtual(fileName);
      if (text === undefined) {
        onError?.(`cannot read ${fileName}`);
        return undefined;
      }
      return ts.createSourceFile(fileName, text, languageVersion, true);
    },
  };
}

/** Is this import declaration (or re-export) a RUNTIME edge? `import type` and
 *  all-type-only specifier lists execute nothing. */
function isRuntimeImport(stmt) {
  if (ts.isImportDeclaration(stmt)) {
    const clause = stmt.importClause;
    if (!clause) return true; // side-effect import
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const b = clause.namedBindings;
    if (!b) return false;
    if (ts.isNamespaceImport(b)) return true;
    return b.elements.length === 0 || b.elements.some((e) => !e.isTypeOnly);
  }
  if (ts.isExportDeclaration(stmt)) {
    if (stmt.isTypeOnly) return false;
    const c = stmt.exportClause;
    if (!c || ts.isNamespaceExport(c)) return true;
    return c.elements.length === 0 || c.elements.some((e) => !e.isTypeOnly);
  }
  return false;
}

/** Module specifiers of a file, with whether each is a runtime edge. Dynamic `import()`
 *  counts as runtime. */
function moduleSpecifiers(sf) {
  const out = [];
  for (const stmt of sf.statements) {
    if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier) {
      if (ts.isStringLiteral(stmt.moduleSpecifier)) {
        out.push({ spec: stmt.moduleSpecifier.text, runtime: isRuntimeImport(stmt), node: stmt.moduleSpecifier });
      }
    }
  }
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments.length > 0 &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      out.push({ spec: n.arguments[0].text, runtime: true, node: n.arguments[0] });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** In-repo specifiers are the ones whose failure to resolve would hide code. */
function isInRepoSpecifier(spec) {
  return spec.startsWith(".") || spec.startsWith("openclaw/") || spec.startsWith("@openclaw/");
}

// ---------------------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------------------

/**
 * Derive the agent-emission inventory.
 *
 * @param {object} input
 * @param {string} input.root              upstream checkout (src/ packages/ extensions/ ui/)
 * @param {Record<string,string>} [input.files]   VIRTUAL sources (relative path → text) —
 *        the tests' synthetic upstream; when given, nothing is read from disk except the
 *        TypeScript lib
 * @param {object} [input.tsconfig]        the upstream root tsconfig.json, parsed (its
 *        `paths` resolve `openclaw/plugin-sdk/*` and `@openclaw/*`)
 * @param {object} [input.compilerOptions] overrides (the tests pass `noLib`)
 * @param {object} [input.meta]            recorded verbatim (`version`, `commit`)
 */
export function deriveAgentEmissions(input) {
  const root = path.resolve(input.root);
  const view = input.files ? virtualFs(root, input.files) : realFs(root);
  const tsconfig = input.tsconfig ?? { compilerOptions: {} };
  const parsed = ts.parseJsonConfigFileContent(
    tsconfig,
    {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [],
      fileExists: () => false,
      readFile: () => undefined,
    },
    root,
    undefined,
    path.join(root, "tsconfig.json"),
  );
  const options = {
    ...parsed.options,
    noEmit: true,
    types: [],
    skipLibCheck: true,
    noResolve: true,
    allowJs: false,
    ...(input.compilerOptions ?? {}),
  };

  // The PUBLIC surface external code links against, read from upstream's own `paths`
  // (`openclaw/plugin-sdk/*` → `src/plugin-sdk/*.ts`): a member exported there can be
  // called by a plugin this module never sees, so it is reported as an OPEN entry.
  const publicPrefixes = [];
  for (const [key, targets] of Object.entries(options.paths ?? {})) {
    if (!key.startsWith("openclaw/")) continue;
    for (const t of targets) {
      const rel = toPosix(path.relative(root, path.resolve(options.pathsBasePath ?? root, t)));
      if (!rel.startsWith("..")) publicPrefixes.push(rel.includes("*") ? rel.slice(0, rel.indexOf("*")) : rel);
    }
  }
  const publicSurface = (rel) => publicPrefixes.some((pre) => rel === pre || (pre.endsWith("/") && rel.startsWith(pre)));

  // ---- 1. files, test exclusion, import guard -----------------------------------------
  const t0 = Date.now();
  const trace = process.env.DERIVE_AGENT_EMISSIONS_TRACE
    ? (msg) => process.stderr.write(`[derive-agent-emissions +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`)
    : () => {};
  const all = view.list();
  const sourceRels = all.filter((rel) => SOURCE_FILE_RE.test(rel));
  const nonTsRels = all.filter((rel) => NON_TS_SOURCE_RE.test(rel));
  const texts = new Map();
  const textOf = (rel) => {
    if (!texts.has(rel)) texts.set(rel, view.read(rel));
    return texts.get(rel);
  };
  const excluded = new Map(); // rel → rule id
  for (const rel of sourceRels) {
    const rule = testRuleOf(rel, textOf(rel));
    if (rule) excluded.set(rel, rule);
  }
  trace(`${sourceRels.length} source files, ${excluded.size} excluded by the test rules`);
  const host = createHost(view, options);
  const relOfFile = (sf) => toPosix(path.relative(root, sf.fileName));
  // Re-include, to a fixpoint, any excluded file that production code imports at runtime:
  // a naming rule that over-excludes must not hide code the product runs.
  const reincluded = [];
  const cache = ts.createModuleResolutionCache(root, (f) => f, options);
  const resolveSpec = (spec, fromRel) => {
    const f = ts.resolveModuleName(spec, path.join(root, fromRel), options, host, cache).resolvedModule?.resolvedFileName;
    if (!f) return undefined;
    const rel = toPosix(path.relative(root, f));
    return rel.startsWith("..") ? undefined : rel;
  };
  let program = ts.createProgram({
    rootNames: sourceRels.filter((rel) => !excluded.has(rel)).map((rel) => path.join(root, rel)),
    options,
    host,
  });
  {
    // The closure: production files' runtime imports, then the re-included files' own.
    const pending = program.getSourceFiles().filter((sf) => !relOfFile(sf).startsWith(".."));
    while (pending.length > 0) {
      const sf = pending.pop();
      const rel = relOfFile(sf);
      for (const s of moduleSpecifiers(sf)) {
        if (!s.runtime || !isInRepoSpecifier(s.spec)) continue;
        const target = resolveSpec(s.spec, rel);
        if (target && excluded.has(target)) {
          reincluded.push({ file: target, rule: excluded.get(target), importedBy: rel, specifier: s.spec });
          excluded.delete(target);
          pending.push(ts.createSourceFile(path.join(root, target), textOf(target), ts.ScriptTarget.Latest, true));
        }
      }
    }
  }
  trace(`import guard re-included ${reincluded.length} file(s)`);
  const included = sourceRels.filter((rel) => !excluded.has(rel));
  if (reincluded.length > 0) {
    program = ts.createProgram({ rootNames: included.map((rel) => path.join(root, rel)), options, host, oldProgram: program });
  }
  const checker = program.getTypeChecker();
  trace(`program of ${program.getSourceFiles().length} files; checker ready`);
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => {
      const rel = relOfFile(sf);
      return !rel.startsWith("..") && !path.isAbsolute(rel) && SCAN_DIRS.some((d) => rel.startsWith(`${d}/`));
    })
    .sort((a, b) => (relOfFile(a) < relOfFile(b) ? -1 : relOfFile(a) > relOfFile(b) ? 1 : 0));
  const sfByRel = new Map(sourceFiles.map((sf) => [relOfFile(sf), sf]));
  const parseErrors = [];
  for (const sf of sourceFiles) {
    const d = sf.parseDiagnostics ?? [];
    if (d.length > 0) {
      parseErrors.push({
        file: relOfFile(sf),
        line: sf.getLineAndCharacterOfPosition(d[0].start ?? 0).line + 1,
        message: ts.flattenDiagnosticMessageText(d[0].messageText, " "),
      });
    }
  }
  if (parseErrors.length > 0) {
    // A tree the parser itself doubts yields short answers under a green light
    // (derive-snapshot's lesson). Refuse.
    throw new Error(
      `${parseErrors.length} upstream file(s) do not parse with TypeScript ${ts.version} — first: ` +
        `${parseErrors[0].file}:${parseErrors[0].line} (${parseErrors[0].message}); refusing to derive ` +
        "an inventory from a tree the parser doubts",
    );
  }
  // Unresolved in-repo imports hide the code behind them; they are reported, and the ones
  // in files the inventory reads are named on each affected row (via `unresolvedImports`).
  const unresolvedImports = [];
  for (const sf of sourceFiles) {
    const rel = relOfFile(sf);
    for (const s of moduleSpecifiers(sf)) {
      if (!isInRepoSpecifier(s.spec)) continue;
      const target = resolveSpec(s.spec, rel);
      if (target === undefined || !sfByRel.has(target)) {
        unresolvedImports.push({
          file: rel,
          line: sf.getLineAndCharacterOfPosition(s.node.getStart()).line + 1,
          specifier: s.spec,
          target: target ?? null,
          reason: target === undefined ? "does not resolve" : "resolves outside the analysed program",
        });
      }
    }
  }

  // ---- helpers over the program ---------------------------------------------------------
  const inAnalysis = (node) => {
    const sf = node.getSourceFile();
    return sfByRel.get(relOfFile(sf)) === sf;
  };
  const locOf = (node) => {
    const sf = node.getSourceFile();
    return `${relOfFile(sf)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  };
  const fileOf = (node) => relOfFile(node.getSourceFile());
  const lineOf = (node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

  const isFunctionLike = (n) =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n);
  const enclosingFunction = (node) => {
    let n = node.parent;
    while (n && !ts.isSourceFile(n)) {
      if (isFunctionLike(n)) return n;
      n = n.parent;
    }
    return undefined;
  };
  const isWrapperParen = (n) =>
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n);
  const skipOuter = (n) => {
    let cur = n;
    while (cur.parent && isWrapperParen(cur.parent)) cur = cur.parent;
    return cur;
  };
  const unwrapExpr = (n) => {
    let cur = n;
    while (cur && isWrapperParen(cur)) cur = cur.expression;
    return cur;
  };

  /** A stable, line-free label for a function: the chain of named containers. */
  const labelCache = new Map();
  const ownName = (fn) => {
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) && fn.name) {
      const n = fn.name.getText();
      const cls = fn.parent && (ts.isClassDeclaration(fn.parent) || ts.isClassExpression(fn.parent)) ? fn.parent.name?.text ?? "<class>" : undefined;
      return cls ? `${cls}.${n}` : n;
    }
    if (ts.isConstructorDeclaration(fn)) {
      return `${fn.parent?.name?.text ?? "<class>"}.constructor`;
    }
    const p = skipOuter(fn).parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p)) return p.name.getText();
    if (p && ts.isPropertyDeclaration(p)) {
      const cls = p.parent && (ts.isClassDeclaration(p.parent) || ts.isClassExpression(p.parent)) ? p.parent.name?.text ?? "<class>" : "<class>";
      return `${cls}.${p.name.getText()}`;
    }
    if (p && ts.isBinaryExpression(p) && p.right === skipOuter(fn)) return `${p.left.getText().slice(0, 60)}=`;
    if (p && (ts.isCallExpression(p) || ts.isNewExpression(p))) {
      const idx = (p.arguments ?? []).indexOf(skipOuter(fn));
      const callee = p.expression.getText().replace(/\s+/g, "");
      return `${callee.length > 60 ? `${callee.slice(0, 57)}...` : callee}(#${idx})`;
    }
    if (p && ts.isReturnStatement(p)) return "<returned>";
    return "<anonymous>";
  };
  const labelOf = (fn) => {
    if (!fn) return "<module>";
    if (labelCache.has(fn)) return labelCache.get(fn);
    const parts = [];
    let cur = fn;
    while (cur) {
      parts.unshift(ownName(cur));
      cur = enclosingFunction(cur);
    }
    const label = parts.join(" > ");
    labelCache.set(fn, label);
    return label;
  };

  const resolveSym = (node) => {
    let sym;
    try {
      sym = checker.getSymbolAtLocation(node);
    } catch {
      return undefined;
    }
    let guard = 0;
    while (sym && sym.flags & ts.SymbolFlags.Alias && guard < 16) {
      let next;
      try {
        next = checker.getAliasedSymbol(sym);
      } catch {
        break;
      }
      if (!next || next === sym || next.flags & ts.SymbolFlags.Alias && next.escapedName === "unknown") break;
      sym = next;
      guard += 1;
    }
    return sym;
  };
  /** The VALUE symbol an identifier denotes (shorthand properties denote two things). */
  const valueSymOf = (id) => {
    const p = id.parent;
    if (p && ts.isShorthandPropertyAssignment(p) && p.name === id) {
      let s = checker.getShorthandAssignmentValueSymbol(p);
      let guard = 0;
      while (s && s.flags & ts.SymbolFlags.Alias && guard < 16) {
        const next = checker.getAliasedSymbol(s);
        if (!next || next === s) break;
        s = next;
        guard += 1;
      }
      return s;
    }
    return resolveSym(id);
  };
  const declsOf = (sym) => (sym?.declarations ?? []).filter(Boolean);

  // ---- identifier index -----------------------------------------------------------------
  const idCache = new Map(); // sf → Map<name, Identifier[]>
  const identifiersOf = (sf) => {
    let m = idCache.get(sf);
    if (m) return m;
    m = new Map();
    const visit = (n) => {
      if (ts.isIdentifier(n)) {
        const list = m.get(n.text);
        if (list) list.push(n);
        else m.set(n.text, [n]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    idCache.set(sf, m);
    return m;
  };
  const filesMentioning = (name) => {
    const out = [];
    for (const sf of sourceFiles) {
      const ids = sf.identifiers;
      if (ids instanceof Map ? ids.has(name) : sf.text.includes(name)) out.push(sf);
    }
    return out;
  };

  // ---- type → abstract value --------------------------------------------------------------
  const typeStr = (t) => {
    try {
      return checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation).slice(0, 200);
    } catch {
      return "<type>";
    }
  };
  const isOpenStringish = (t) =>
    (t.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) !== 0 ||
    ((t.flags & ts.TypeFlags.Intersection) !== 0 && t.types.some((x) => (x.flags & ts.TypeFlags.String) !== 0));
  const typeToAV = (t, at, depth = 0) => {
    if (!t) return opaque("no type", at);
    if (depth > MAX_TYPE_DEPTH) return opaque(`type nesting beyond ${MAX_TYPE_DEPTH} (evaluator bound)`, at);
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return opaque(`declared type is ${typeStr(t)}`, at);
    if (f & ts.TypeFlags.StringLiteral) return { ...lit(t.value), src: "type" };
    if (f & ts.TypeFlags.NumberLiteral) return { ...lit(t.value), src: "type" };
    if (f & ts.TypeFlags.BooleanLiteral) return { ...lit(t.intrinsicName === "true"), src: "type" };
    if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) return ABSENT;
    if (f & ts.TypeFlags.EnumLiteral && t.isUnion?.() === false && "value" in t) return { ...lit(t.value), src: "type" };
    if (t.isUnion()) {
      const members = t.types;
      const open = members.filter(isOpenStringish);
      if (open.length > 0) {
        const lits = members.filter((m) => m.flags & ts.TypeFlags.StringLiteral).map((m) => m.value).sort();
        return {
          ...opaque(`declared type ${typeStr(t)} is open (a \`string\` member)`, at),
          literals: lits,
        };
      }
      return union(members.map((m) => typeToAV(m, at, depth)));
    }
    if (isOpenStringish(t)) return opaque(`declared type is ${typeStr(t)}`, at);
    if (f & (ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.BigInt | ts.TypeFlags.ESSymbol)) {
      return opaque(`declared type is ${typeStr(t)}`, at);
    }
    if (f & ts.TypeFlags.TypeParameter) {
      const c = checker.getBaseConstraintOfType(t);
      if (c && c !== t) return typeToAV(c, at, depth + 1);
      return opaque(`declared type is the type parameter ${typeStr(t)}`, at);
    }
    if (f & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
      if (checker.isArrayType(t) || checker.isTupleType(t)) return { k: "arr", elems: [], typed: t, at };
      if (t.getCallSignatures().length > 0 && checker.getPropertiesOfType(t).length === 0) {
        return opaque(`declared type is a function (${typeStr(t)})`, at);
      }
      return { k: "tobj", type: t, at, depth };
    }
    return opaque(`declared type is ${typeStr(t)}`, at);
  };
  const typeFallback = (node, why) => {
    let t;
    try {
      t = checker.getTypeAtLocation(node);
    } catch {
      return opaque(`${why}; its type could not be computed`, locOf(node));
    }
    const av = typeToAV(t, locOf(node));
    if (av.k === "opaque" && why) return { ...av, reason: `${why}; ${av.reason}` };
    return markTyped(av, why);
  };
  const markTyped = (av, why) => {
    if (av.k === "union") return { ...av, opts: av.opts.map((o) => markTyped(o, why)), src: "type", why };
    if (av.k === "lit" || av.k === "tobj") return { ...av, src: "type", why };
    return av;
  };
  /** A required (non-optional) property of a declared type. */
  const typedHas = (av, key) => {
    try {
      const p = checker.getPropertyOfType(av.type, key);
      return !!p && (p.flags & ts.SymbolFlags.Optional) === 0;
    } catch {
      return false;
    }
  };
  const tobjProp = (av, key) => {
    let prop;
    try {
      prop = checker.getPropertyOfType(av.type, key);
    } catch {
      return opaque(`property ${key} of ${typeStr(av.type)} could not be read`, av.at);
    }
    if (!prop) {
      const idx = checker.getIndexInfosOfType(av.type);
      if (idx.some((i) => i.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral))) {
        return opaque(`${av.why ? `${av.why}: ` : ""}declared type ${typeStr(av.type)} has an index signature`, av.at);
      }
      return ABSENT;
    }
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    let pt;
    try {
      pt = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getTypeOfSymbol(prop);
    } catch {
      return opaque(`type of property ${key} of ${typeStr(av.type)} could not be computed`, av.at);
    }
    const v = typeToAV(pt, av.at, (av.depth ?? 0) + 1);
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    const tagged = markTyped(v, `declared type ${typeStr(av.type)}`);
    return optional ? union([tagged, ABSENT]) : tagged;
  };
  const tobjKeys = (av) => {
    const keys = [];
    let props = [];
    try {
      props = checker.getPropertiesOfType(av.type);
    } catch {
      return { keys, opaque: [opaque(`properties of ${typeStr(av.type)} could not be listed`, av.at)] };
    }
    for (const p of props) keys.push({ key: p.name, opt: (p.flags & ts.SymbolFlags.Optional) !== 0 });
    const op = [];
    const idx = checker.getIndexInfosOfType(av.type);
    if (idx.some((i) => i.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral))) {
      op.push(opaque(`${av.why ? `${av.why}: ` : ""}declared type ${typeStr(av.type)} has an index signature`, av.at));
    }
    return { keys, opaque: op };
  };

  // ---- the evaluator --------------------------------------------------------------------
  //
  // ev(node, ctx): ctx.binds maps a parameter declaration to the value bound at an inlined
  // call; an unbound parameter of ANY enclosing function becomes a hole of that function.
  const ROOT_CTX = Object.freeze({ binds: new Map(), depth: 0, stack: new Set() });
  const constMemo = new Map();
  const inlineMemo = new Map();
  const budget = { steps: 0, exhausted: false };
  const enclosingParamsCache = new Map();
  /** Does the context bind a parameter of a function enclosing `node`? */
  const bindsTouch = (node, ctx) => {
    if (ctx.binds.size === 0) return false;
    let params = enclosingParamsCache.get(node);
    if (!params) {
      params = [];
      for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) params.push(...fn.parameters);
      enclosingParamsCache.set(node, params);
    }
    return params.some((p) => ctx.binds.has(p));
  };

  const paramIndex = (param) => param.parent.parameters.indexOf(param);
  const holeOfParam = (param, pathKeys, expr, ctx) => {
    if (ctx.binds.has(param)) return getPath(ctx.binds.get(param), pathKeys);
    const fn = param.parent;
    if (!isFunctionLike(fn)) return opaque(`parameter of a ${ts.SyntaxKind[fn.kind]}`, locOf(param));
    return { k: "hole", fn, idx: paramIndex(param), path: pathKeys, expr, rest: !!param.dotDotDotToken, param };
  };
  /** Path from a binding element up to its root declaration (parameter or variable). */
  const bindingPath = (el) => {
    const keys = [];
    let cur = el;
    while (ts.isBindingElement(cur)) {
      const pattern = cur.parent;
      if (ts.isObjectBindingPattern(pattern)) {
        const nameNode = cur.propertyName ?? cur.name;
        if (cur.dotDotDotToken) keys.unshift("...");
        else if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) keys.unshift(nameNode.text);
        else keys.unshift("<computed>");
      } else {
        keys.unshift(String(pattern.elements.indexOf(cur)));
      }
      cur = pattern.parent;
    }
    return { root: cur, keys };
  };
  function getPath(av, keys) {
    let cur = av;
    for (const k of keys) {
      if (k === "...") continue; // object rest: approximated by the whole object
      cur = getProp(cur, k);
    }
    return cur;
  }

  function getProp(av, key) {
    switch (av.k) {
      case "obj": {
        const found = [];
        let certain = false;
        for (let i = av.entries.length - 1; i >= 0 && !certain; i -= 1) {
          const e = av.entries[i];
          if (e.t === "prop") {
            if (e.key !== key) continue;
            found.push(propVal(e));
            if (!e.opt) certain = true;
          } else if (e.t === "keyopaque") {
            found.push(opaque(`computed key ${e.text} may be ${JSON.stringify(key)}`, e.at));
          } else if (e.t === "spread") {
            // A spread that may lack the key FALLS THROUGH to the entries before it: its
            // "absent" is not the key's — dropping it here kept a spurious no-phase variant
            // on every event whose data ends with an optional spread.
            const sub = getProp(e.v, key);
            if (sub.k === "absent") continue;
            const present = sub.k === "union" ? union(sub.opts.filter((o) => o.k !== "absent")) : sub;
            if (present.k === "absent") continue;
            found.push(present);
            if (definitelyHas(e.v, key, typedHas) && !(sub.k === "union" && sub.opts.some((o) => o.k === "absent"))) certain = true;
          }
        }
        if (found.length === 0) return ABSENT;
        return certain ? union(found) : union([...found, ABSENT]);
      }
      case "union":
        return union(av.opts.map((o) => getProp(o, key)));
      case "guard":
        return { ...av, t: getProp(av.t, key), f: getProp(av.f, key) };
      case "hole":
        return { ...av, path: [...av.path, key], expr: undefined, typedFrom: av.expr ?? av.typedFrom, typedPath: [...(av.typedPath ?? []), key] };
      case "tobj":
        return tobjProp(av, key);
      case "opaque":
        return opaque(av.reason, av.at);
      case "call":
        return { ...av, path: [...(av.path ?? []), key] };
      case "arr":
        if (/^\d+$/.test(key)) return av.elems[Number(key)] ?? (av.elems.length ? union(av.elems) : ABSENT);
        return ABSENT;
      default:
        return ABSENT;
    }
  }

  function elementOf(av0, at) {
    const av = asUnion(av0);
    switch (av.k) {
      case "arr":
        if (av.elems.length > 0) return union(av.elems);
        if (av.typed) {
          const args = checker.getTypeArguments(av.typed);
          if (args && args.length > 0) return union(args.map((a) => typeToAV(a, at)));
        }
        return opaque("elements of an array not known from source", at);
      case "union":
        return union(av.opts.map((o) => elementOf(o, at)));
      case "hole":
        return { ...av, path: [...av.path, "[]"], expr: undefined };
      case "opaque":
        return av;
      default:
        return opaque(`iteration over a ${av.k}`, at);
    }
  }

  const MUTATING_ASSIGN = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ]);
  /** Every occurrence of a binding's symbol inside `scope` (the declaring block). */
  const occurrencesIn = (scope, sym, name) => {
    const out = [];
    const visit = (n) => {
      if (ts.isIdentifier(n) && n.text === name) {
        const s = valueSymOf(n);
        if (s === sym) out.push(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return out;
  };
  const declaringScope = (decl) => {
    let n = decl.parent;
    while (n && !ts.isBlock(n) && !ts.isSourceFile(n) && !isFunctionLike(n) && !ts.isModuleBlock(n)) n = n.parent;
    return n ?? decl.getSourceFile();
  };
  /** Property writes on a binding (`x.k = v`, `x["k"] = v`, `Object.assign(x, {...})`) and
   *  its reassignments (`x = v`), found by symbol in its declaring scope. The NODES are
   *  context-free and cached; their values are evaluated by the caller in its context. */
  const writesCache = new Map();
  const bindingWrites = (decl) => {
    const hit = writesCache.get(decl);
    if (hit) return hit;
    const sym = checker.getSymbolAtLocation(decl.name);
    const props = [];
    const reassigned = [];
    const result = { props, reassigned };
    writesCache.set(decl, result);
    if (!sym) return result;
    for (const id of occurrencesIn(declaringScope(decl), sym, decl.name.text)) {
      if (id === decl.name) continue;
      const outer = skipOuter(id);
      const p = outer.parent;
      if (!p) continue;
      if (ts.isBinaryExpression(p) && p.left === outer && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        reassigned.push({ node: p.right, op: p.operatorToken.kind });
        continue;
      }
      if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === outer) {
        const top = skipOuter(p);
        const gp = top.parent;
        const isWrite = gp && ts.isBinaryExpression(gp) && gp.left === top && MUTATING_ASSIGN.has(gp.operatorToken.kind);
        if (!isWrite) continue;
        if (ts.isPropertyAccessExpression(p)) props.push({ key: p.name.text, value: gp.right, at: locOf(p) });
        else props.push({ keyNode: p.argumentExpression, value: gp.right, at: locOf(p), text: p.argumentExpression.getText().slice(0, 60) });
        continue;
      }
      if (ts.isCallExpression(p) && p.arguments[0] === outer) {
        const callee = p.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "assign" && ts.isIdentifier(callee.expression) && callee.expression.text === "Object") {
          for (const src of p.arguments.slice(1)) props.push({ spread: src, at: locOf(src) });
        }
      }
    }
    return result;
  };

  /** Add property writes to an object value. */
  const withWrites = (base, writes, ctx) => {
    if (writes.length === 0) return base;
    // Each alternative gets the writes: wrapping a union of states into one object hid the
    // discriminant (`state.kind`) behind a spread, and no test could narrow it any more.
    if (base.k === "union" && base.opts.every((o) => o.k === "obj" || o.k === "absent")) {
      return union(base.opts.map((o) => (o.k === "absent" ? o : withWrites(o, writes, ctx))));
    }
    const entries = base.k === "obj" ? [...base.entries] : [{ t: "spread", v: base }];
    for (const w of writes) {
      if (w.spread) {
        entries.push({ t: "spread", v: maybe(ev(w.spread, ctx)) });
        continue;
      }
      let key = w.key;
      if (key === undefined && w.keyNode) {
        const kv = ev(w.keyNode, ctx);
        if (kv.k === "lit" && typeof kv.v === "string") key = kv.v;
        else if (kv.k === "union" && kv.opts.every((o) => o.k === "lit" && typeof o.v === "string")) {
          for (const o of kv.opts) entries.push(lazyProp(o.v, () => ev(w.value, ctx), { opt: true, writtenAt: w.at, init: w.value }));
          continue;
        }
      }
      if (key === undefined) entries.push({ t: "keyopaque", text: w.text, at: w.at });
      else entries.push(lazyProp(key, () => ev(w.value, ctx), { opt: true, writtenAt: w.at, init: w.value }));
    }
    return objFromEntries(entries, base.at);
  };
  const maybe = (av) => union([av, ABSENT]);

  function evVariable(decl, ctx, refNode) {
    const list = decl.parent;
    const stmt = list?.parent;
    if (stmt && (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt))) {
      if (ts.isForInStatement(stmt)) return opaque("for-in key", locOf(decl));
      return elementOf(ev(stmt.expression, ctx), locOf(stmt.expression));
    }
    if (stmt && ts.isCatchClause(list)) return opaque("catch binding", locOf(decl));
    const isConst = list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
    // A binding's value depends on the context only through the parameters of the
    // functions enclosing it; when none of those is bound here, the value is the same in
    // every context and is computed once.
    const memoKey = !bindsTouch(decl, ctx) && !(ctx.self && ctx.self.size > 0) && !(ctx.narrow && ctx.narrow.size > 0) ? decl : undefined;
    if (memoKey && constMemo.has(memoKey)) return constMemo.get(memoKey);
    if (ctx.stack.has(decl)) return opaque(`recursive definition of ${decl.name.getText()}`, locOf(decl));
    const inner = { ...ctx, stack: new Set([...ctx.stack, decl]) };
    let value;
    if (!ts.isIdentifier(decl.name)) {
      value = opaque("destructured variable", locOf(decl));
    } else {
      const { props, reassigned } = bindingWrites(decl);
      const parts = [];
      const initial = decl.initializer ? ev(decl.initializer, inner) : isConst ? undefined : ABSENT;
      if (initial) parts.push(initial);
      // `data = { ...data, k }`: inside its own reassignment the binding denotes its value
      // BEFORE the write — one step of accumulation, which is what a key set needs.
      const selfCtx = { ...inner, self: new Map([...(inner.self ?? []), [decl, initial ?? ABSENT]]) };
      for (const r of reassigned) {
        if (r.op === ts.SyntaxKind.EqualsToken || r.op === ts.SyntaxKind.QuestionQuestionEqualsToken || r.op === ts.SyntaxKind.BarBarEqualsToken) {
          parts.push(ev(r.node, selfCtx));
        } else {
          parts.push(opaque(`compound assignment ${ts.tokenToString(r.op)} to ${decl.name.text}`, locOf(r.node)));
        }
      }
      if (parts.length === 0) {
        value = typeFallback(refNode ?? decl.name, `${decl.name.text} has no initializer`);
      } else {
        value = union(parts);
        if (props.length > 0) value = withWrites(value, props, inner);
      }
    }
    if (memoKey) constMemo.set(memoKey, value);
    return value;
  }

  function evIdentifier(id, ctx) {
    if (id.text === "undefined") return ABSENT;
    const sym = valueSymOf(id);
    if (!sym) return typeFallback(id, `identifier ${id.text} does not resolve`);
    if (sym.flags & ts.SymbolFlags.Alias) {
      return opaque(`${id.text} is imported from a module outside the analysed program`, locOf(id));
    }
    const decl = sym.valueDeclaration ?? declsOf(sym)[0];
    if (!decl) return typeFallback(id, `${id.text} has no declaration`);
    if (!inAnalysis(decl)) return typeFallback(id, `${id.text} is declared outside the analysed sources`);
    if (ctx.narrow?.has(decl)) return ctx.narrow.get(decl);
    if (ts.isParameter(decl)) return holeOfParam(decl, [], id, ctx);
    if (ts.isBindingElement(decl)) {
      const { root: r, keys } = bindingPath(decl);
      if (ts.isParameter(r)) return holeOfParam(r, keys, id, ctx);
      if (ts.isVariableDeclaration(r) && r.initializer) {
        const stmt = r.parent?.parent;
        let base;
        if (stmt && ts.isForOfStatement(stmt)) base = elementOf(ev(stmt.expression, ctx), locOf(stmt.expression));
        else base = ev(r.initializer, ctx);
        const v = getPath(base, keys);
        if (decl.initializer && (v.k === "absent" || v.k === "union" && v.opts.some((o) => o.k === "absent"))) {
          return union([v, ev(decl.initializer, ctx)].filter((x) => x.k !== "absent"));
        }
        return v;
      }
      return typeFallback(id, `${id.text} is destructured from something this module cannot read`);
    }
    if (ts.isVariableDeclaration(decl)) {
      if (ctx.self?.has(decl)) return ctx.self.get(decl);
      return evVariable(decl, ctx, id);
    }
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) {
      // Overloads: the value is the IMPLEMENTATION, the one declaration with a body.
      const impl = decl.body ? decl : declsOf(sym).find((d) => isFunctionLike(d) && d.body);
      return { k: "fn", node: impl ?? decl, ctx };
    }
    if (ts.isEnumMember(decl)) {
      const v = checker.getConstantValue(decl);
      return v === undefined ? opaque(`enum member ${id.text} without constant value`, locOf(decl)) : lit(v);
    }
    if (ts.isClassDeclaration(decl)) return opaque(`class ${id.text}`, locOf(decl));
    return typeFallback(id, `${id.text} is a ${ts.SyntaxKind[decl.kind]}`);
  }

  /** Inline a call to a function-like with a body: bind its parameters, union its returns. */
  function inlineCall(fnNode, argAVs, ctx, at) {
    if (ctx.depth >= MAX_INLINE_DEPTH) return opaque(`call nesting beyond ${MAX_INLINE_DEPTH} (evaluator bound)`, at);
    if (ctx.stack.has(fnNode)) return opaque(`recursive call of ${labelOf(fnNode)}`, at);
    if (!fnNode.body) return opaque(`${labelOf(fnNode)} has no body`, at);
    // Same function, same argument values, no bound enclosing parameter: same result.
    const memoable = !bindsTouch(fnNode.body, ctx);
    if (memoable) {
      const list = inlineMemo.get(fnNode);
      const hit = list?.find((m) => m.args.length === argAVs.length && m.args.every((a, i) => a === argAVs[i]));
      if (hit) return hit.value;
    }
    const value = inlineCallUncached(fnNode, argAVs, ctx, at);
    if (memoable && !budget.exhausted) {
      const list = inlineMemo.get(fnNode) ?? [];
      list.push({ args: argAVs, value });
      if (list.length > 32) list.shift();
      inlineMemo.set(fnNode, list);
    }
    return value;
  }
  function inlineCallUncached(fnNode, argAVs, ctx, at) {
    const binds = new Map(ctx.binds);
    fnNode.parameters.forEach((p, i) => {
      let v;
      if (p.dotDotDotToken) v = { k: "arr", elems: argAVs.slice(i), at };
      else v = argAVs[i] ?? ABSENT;
      if (p.initializer && (v.k === "absent" || v.k === "union" && v.opts.some((o) => o.k === "absent"))) {
        v = union([v, ev(p.initializer, ctx)].filter((x) => x.k !== "absent"));
      }
      binds.set(p, v);
    });
    const inner = { binds, depth: ctx.depth + 1, stack: new Set([...ctx.stack, fnNode]) };
    if (!ts.isBlock(fnNode.body)) return ev(fnNode.body, inner);
    const rets = [];
    const walk = (n) => {
      if (n !== fnNode && isFunctionLike(n)) return;
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
      if (ts.isReturnStatement(n)) rets.push(n);
      ts.forEachChild(n, walk);
    };
    walk(fnNode.body);
    if (rets.length === 0) return ABSENT;
    return union(rets.map((r) => (r.expression ? ev(r.expression, inner) : ABSENT)));
  }

  /** The declaration a call reaches, when it is a function-like with a body. */
  const calleeDeclaration = (call) => {
    let sig;
    try {
      sig = checker.getResolvedSignature(call);
    } catch {
      return undefined;
    }
    let d = sig?.declaration;
    if (!d || !isFunctionLike(d) || !inAnalysis(d)) return undefined;
    if (!d.body && d.name) {
      // An overload signature: the body is the implementation's.
      const impl = declsOf(checker.getSymbolAtLocation(d.name)).find((x) => isFunctionLike(x) && x.body);
      if (impl) d = impl;
    }
    return d;
  };

  function evCall(call, ctx) {
    const at = locOf(call);
    const calleeExpr = unwrapExpr(call.expression);
    const argAVs = evalArgs(call.arguments, ctx);
    // A string method on a value this module tracks: keep the value (literal methods are
    // computed; a parameter stays a hole wrapped in `derived`).
    if (ts.isPropertyAccessExpression(calleeExpr)) {
      const m = calleeExpr.name.text;
      if (["trim", "toLowerCase", "toUpperCase", "trimStart", "trimEnd", "toString", "valueOf"].includes(m) && call.arguments.length === 0) {
        const recv = ev(calleeExpr.expression, ctx);
        return derive(recv, m, at);
      }
    }
    const calleeAV = ev(calleeExpr, ctx);
    // A declaration without a body (`declare function`, an ambient module) is known by its
    // declared return type, not by an inlining that has nothing to read.
    if (calleeAV.k === "fn" && !calleeAV.node.body) return typeFallback(call, `result of ${calleeExpr.getText().slice(0, 80)}(…), declared without a body`);
    if (calleeAV.k === "fn") return inlineCall(calleeAV.node, argAVs, calleeAV.ctx && calleeAV.ctx !== ROOT_CTX ? { ...ctx, binds: new Map([...calleeAV.ctx.binds, ...ctx.binds]) } : ctx, at);
    if (calleeAV.k === "hole" || calleeAV.k === "call") return { k: "call", callee: calleeAV, args: argAVs, at, node: call };
    if (calleeAV.k === "union" && calleeAV.opts.every((o) => o.k === "fn")) {
      return union(calleeAV.opts.map((o) => inlineCall(o.node, argAVs, ctx, at)));
    }
    const decl = calleeDeclaration(call);
    if (decl && decl.body) return inlineCall(decl, argAVs, ctx, at);
    return typeFallback(call, `result of ${calleeExpr.getText().slice(0, 80)}(…)`);
  }

  const DERIVABLE = {
    trim: (s) => s.trim(),
    trimStart: (s) => s.trimStart(),
    trimEnd: (s) => s.trimEnd(),
    toLowerCase: (s) => s.toLowerCase(),
    toUpperCase: (s) => s.toUpperCase(),
    toString: (s) => s,
    valueOf: (s) => s,
  };
  function derive(recv, method, at) {
    if (recv.k === "guard") return { ...recv, t: derive(recv.t, method, at), f: derive(recv.f, method, at) };
    if (recv.k === "lit" && typeof recv.v === "string") return lit(DERIVABLE[method](recv.v));
    if (recv.k === "union") return union(recv.opts.map((o) => derive(o, method, at)));
    if (recv.k === "absent") return ABSENT;
    if (recv.k === "hole" || recv.k === "call" || recv.k === "derived") return { k: "derived", from: recv, via: method, at };
    return opaque(`.${method}() of ${recv.k === "opaque" ? recv.reason : `a ${recv.k}`}`, recv.at ?? at);
  }

  function evalArgs(args, ctx) {
    const out = [];
    for (const a of args ?? []) {
      if (ts.isSpreadElement(a)) {
        const v = ev(a.expression, ctx);
        if (v.k === "arr" && v.elems.length > 0) out.push(...v.elems);
        else if (v.k === "hole" && v.rest) {
          // `(...args) => f(...args)`: positional pass-through of a rest parameter.
          for (let i = 0; i < 8; i += 1) out.push({ ...v, path: [...v.path, String(i)], rest: false, restIndex: i });
        } else out.push(opaque("spread argument", locOf(a)));
      } else out.push(ev(a, ctx));
    }
    return out;
  }

  function evObject(node, ctx) {
    const entries = [];
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) {
        // The node rides along: whether a spread can set a key is asked of its declared
        // type (the gateway's sender classification), not only of its evaluated value.
        entries.push({ t: "spread", v: ev(p.expression, ctx), node: p.expression });
      } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
        let key;
        const nm = p.name;
        if (ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNoSubstitutionTemplateLiteral(nm) || ts.isNumericLiteral(nm)) key = nm.text;
        else if (ts.isComputedPropertyName(nm)) {
          const kv = ev(nm.expression, ctx);
          if (kv.k === "lit") key = String(kv.v);
          else if (kv.k === "union" && kv.opts.every((o) => o.k === "lit")) {
            for (const o of kv.opts) {
              entries.push(ts.isPropertyAssignment(p) ? lazyProp(String(o.v), () => ev(p.initializer, ctx), { opt: true, init: p.initializer }) : { t: "prop", key: String(o.v), v: { k: "fn", node: p }, opt: true });
            }
            continue;
          } else {
            entries.push({ t: "keyopaque", text: nm.getText().slice(0, 60), at: locOf(nm) });
            continue;
          }
        } else {
          entries.push({ t: "keyopaque", text: nm.getText().slice(0, 60), at: locOf(nm) });
          continue;
        }
        if (ts.isPropertyAssignment(p)) {
          const init = unwrapExpr(p.initializer);
          // Literals cost nothing; everything else is computed on demand.
          if (init && (ts.isStringLiteralLike(init) || ts.isNumericLiteral(init) || init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword || init.kind === ts.SyntaxKind.NullKeyword)) {
            entries.push({ t: "prop", key, v: ev(init, ctx), opt: false, node: p });
          } else {
            entries.push(lazyProp(key, () => ev(p.initializer, ctx), { node: p, init: p.initializer }));
          }
        } else if (ts.isShorthandPropertyAssignment(p)) {
          entries.push(lazyProp(key, () => evIdentifier(p.name, ctx), { node: p, init: p.name }));
        } else entries.push({ t: "prop", key, v: { k: "fn", node: p, ctx }, opt: false, node: p });
      }
    }
    return objFromEntries(entries, locOf(node));
  }

  function ev(node, ctx = ROOT_CTX) {
    if (!node) return ABSENT;
    const n = unwrapExpr(node);
    if (!n) return ABSENT;
    budget.steps += 1;
    if (budget.steps > MAX_STEPS_PER_SITE) {
      budget.exhausted = true;
      return opaque(`evaluation budget of ${MAX_STEPS_PER_SITE} steps exhausted at this site (evaluator bound)`, locOf(n));
    }
    switch (n.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return lit(n.text);
      case ts.SyntaxKind.NumericLiteral:
        return lit(Number(n.text));
      case ts.SyntaxKind.TrueKeyword:
        return lit(true);
      case ts.SyntaxKind.FalseKeyword:
        return lit(false);
      case ts.SyntaxKind.NullKeyword:
        return lit(null);
      case ts.SyntaxKind.VoidExpression:
        return ABSENT;
      case ts.SyntaxKind.Identifier:
        return evIdentifier(n, ctx);
      case ts.SyntaxKind.ThisKeyword:
        return opaque("`this`", locOf(n));
      case ts.SyntaxKind.ObjectLiteralExpression:
        return evObject(n, ctx);
      case ts.SyntaxKind.ArrayLiteralExpression: {
        const elems = [];
        for (const e of n.elements) {
          if (ts.isSpreadElement(e)) {
            const v = ev(e.expression, ctx);
            if (v.k === "arr") elems.push(...v.elems);
            else elems.push(elementOf(v, locOf(e)));
          } else elems.push(ev(e, ctx));
        }
        return { k: "arr", elems, at: locOf(n) };
      }
      case ts.SyntaxKind.ConditionalExpression: {
        // `x.kind === "captured" ? x.event : …` — each branch sees only the alternatives
        // of `x` its test admits. Without it, the states the test excludes leaked an
        // impossible "no phase" variant into every lifecycle terminal.
        const nar = narrowingOf(n.condition, ctx);
        if (nar && nar.guard) {
          return { k: "guard", base: nar.value, prop: nar.prop, lit: nar.lit, eq: nar.eq, t: ev(n.whenTrue, ctx), f: ev(n.whenFalse, ctx), at: locOf(n) };
        }
        if (nar) {
          // A branch no alternative can take contributes nothing (not "absent").
          const branches = [];
          if (nar.trueOpts > 0) branches.push(ev(n.whenTrue, { ...ctx, narrow: new Map([...(ctx.narrow ?? []), [nar.decl, nar.whenTrue]]) }));
          if (nar.falseOpts > 0) branches.push(ev(n.whenFalse, { ...ctx, narrow: new Map([...(ctx.narrow ?? []), [nar.decl, nar.whenFalse]]) }));
          return union(branches);
        }
        return union([ev(n.whenTrue, ctx), ev(n.whenFalse, ctx)]);
      }
      case ts.SyntaxKind.BinaryExpression: {
        const op = n.operatorToken.kind;
        if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
          const left = ev(n.left, ctx);
          const l = left.k === "union" ? union(left.opts.filter((o) => o.k !== "absent" && !(o.k === "lit" && (o.v === null || o.v === false || o.v === "")))) : left;
          return union([l, ev(n.right, ctx)]);
        }
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) return union([ev(n.right, ctx), ABSENT]);
        if (op === ts.SyntaxKind.CommaToken) return ev(n.right, ctx);
        if (op === ts.SyntaxKind.PlusToken) {
          const l = ev(n.left, ctx);
          const r = ev(n.right, ctx);
          if (l.k === "lit" && r.k === "lit") return lit(`${l.v}${r.v}`);
          if ((l.k === "lit" && typeof l.v === "string") || (r.k === "lit" && typeof r.v === "string")) return { k: "tpl", parts: [l.k === "lit" ? String(l.v) : l, r.k === "lit" ? String(r.v) : r], at: locOf(n) };
          return typeFallback(n, "arithmetic or concatenation");
        }
        if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) return ev(n.right, ctx);
        return typeFallback(n, `binary ${ts.tokenToString(op)}`);
      }
      case ts.SyntaxKind.TemplateExpression: {
        const parts = [n.head.text];
        for (const span of n.templateSpans) {
          const v = ev(span.expression, ctx);
          parts.push(v.k === "lit" ? String(v.v) : v);
          parts.push(span.literal.text);
        }
        if (parts.every((p) => typeof p === "string")) return lit(parts.join(""));
        return { k: "tpl", parts, at: locOf(n) };
      }
      case ts.SyntaxKind.PropertyAccessExpression: {
        const cv = checker.getConstantValue(n);
        if (cv !== undefined) return lit(cv);
        const base = ev(n.expression, ctx);
        const v = getProp(base, n.name.text);
        if (v.k === "opaque" && base.k === "opaque") return typeFallback(n, `${n.getText().slice(0, 60).replace(/\s+/g, "")} (${base.reason})`);
        return v;
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        const cv = checker.getConstantValue(n);
        if (cv !== undefined) return lit(cv);
        const kv = ev(n.argumentExpression, ctx);
        const base = ev(n.expression, ctx);
        if (kv.k === "lit") {
          const v = getProp(base, String(kv.v));
          if (v.k === "opaque" && base.k === "opaque") return typeFallback(n, n.getText().slice(0, 80));
          return v;
        }
        return typeFallback(n, `dynamic index ${n.argumentExpression.getText().slice(0, 40)}`);
      }
      case ts.SyntaxKind.CallExpression:
        return evCall(n, ctx);
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
        return { k: "fn", node: n, ctx };
      case ts.SyntaxKind.AwaitExpression:
        return ev(n.expression, ctx);
      case ts.SyntaxKind.PrefixUnaryExpression:
        if (n.operator === ts.SyntaxKind.ExclamationToken) return union([lit(true), lit(false)]);
        if (n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return lit(-Number(n.operand.text));
        return typeFallback(n, "unary expression");
      case ts.SyntaxKind.TypeOfExpression:
        return typeFallback(n, "typeof");
      default:
        return typeFallback(n, `${ts.SyntaxKind[n.kind]}`);
    }
  }

  /** A discriminant test `id.prop === "lit"` (or `!==`) over a binding whose value is a
   *  union: the alternatives each branch admits. */
  function narrowingOf(cond, ctx) {
    const c = unwrapExpr(cond);
    if (!ts.isBinaryExpression(c)) return undefined;
    const op = c.operatorToken.kind;
    const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const ne = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!eq && !ne) return undefined;
    let access = unwrapExpr(c.left);
    let litNode = unwrapExpr(c.right);
    if (!ts.isPropertyAccessExpression(access)) [access, litNode] = [litNode, access];
    if (!ts.isPropertyAccessExpression(access) || !ts.isStringLiteral(litNode)) return undefined;
    const base = unwrapExpr(access.expression);
    if (!ts.isIdentifier(base)) return undefined;
    const decl = declsOf(valueSymOf(base))[0];
    if (!decl || !(ts.isVariableDeclaration(decl) || ts.isParameter(decl))) return undefined;
    const value = ev(base, ctx);
    const opts = value.k === "union" ? value.opts : [value];
    const yes = [];
    const no = [];
    let pending = false;
    for (const o of opts) {
      const d = asUnion(getProp(o, access.name.text));
      const lits = d.k === "lit" ? [d] : d.k === "union" && d.opts.every((x) => x.k === "lit" || x.k === "absent") ? d.opts : null;
      if (lits) {
        if (lits.some((x) => x.k === "lit" && x.v === litNode.text)) yes.push(o);
        if (lits.some((x) => x.k !== "lit" || x.v !== litNode.text)) no.push(o);
      } else if (d.k === "absent") no.push(o);
      else {
        if (holeFns(d).size > 0) pending = true;
        yes.push(o);
        no.push(o);
      }
    }
    const t = eq ? yes : no;
    const f = eq ? no : yes;
    if (pending) return { guard: true, value, prop: access.name.text, lit: litNode.text, eq };
    if (yes.length === opts.length && no.length === opts.length) return undefined;
    return { decl, whenTrue: union(t), whenFalse: union(f), trueOpts: t.length, falseOpts: f.length };
  }

  /** Replace the holes of `fn` by the call's argument values. */
  function subst(av, fn, args, ctx = ROOT_CTX, seen = new Map()) {
    if (!av) return av;
    if (seen.has(av)) return seen.get(av);
    let out;
    switch (av.k) {
      case "hole": {
        if (av.fn !== fn) {
          out = av;
          break;
        }
        let base;
        if (av.rest) base = { k: "arr", elems: args.slice(av.idx) };
        else base = args[av.idx] ?? ABSENT;
        if (base.k === "absent" && av.param?.initializer) base = ev(av.param.initializer, ctx);
        out = getPath(base, av.path);
        if (out.k === "opaque" && (av.expr || av.typedFrom)) {
          const t = av.expr ? typeFallback(av.expr, `argument #${av.idx} of ${labelOf(av.fn)}`) : typedPathFallback(av);
          if (t.k !== "opaque") out = t;
          else out = { ...out, reason: `${out.reason} (argument #${av.idx} of ${labelOf(av.fn)})` };
        }
        break;
      }
      case "union":
        out = union(av.opts.map((o) => subst(o, fn, args, ctx, seen)));
        break;
      case "obj":
        out = objFromEntries(
          av.entries.map((e) => (e.t === "prop" ? mapProp(e, (v) => subst(v, fn, args, ctx, seen)) : e.t === "spread" ? { ...e, v: subst(e.v, fn, args, ctx, seen) } : e)),
          av.at,
        );
        break;
      case "arr":
        out = { ...av, elems: av.elems.map((e) => subst(e, fn, args, ctx, seen)) };
        break;
      case "derived": {
        const f = subst(av.from, fn, args, ctx, seen);
        out = derive(f, av.via, av.at);
        break;
      }
      case "tpl": {
        const parts = av.parts.map((p) => (typeof p === "string" ? p : subst(p, fn, args, ctx, seen)));
        const flat = parts.map((p) => (typeof p !== "string" && p.k === "lit" ? String(p.v) : p));
        out = flat.every((p) => typeof p === "string") ? lit(flat.join("")) : { ...av, parts: flat };
        break;
      }
      case "call": {
        const callee = subst(av.callee, fn, args, ctx, seen);
        const cargs = av.args.map((a) => subst(a, fn, args, ctx, seen));
        let r;
        if (callee.k === "fn" && !callee.node.body) r = av.node ? typeFallback(av.node, "result of a callback declared without a body") : opaque("call of a callback declared without a body", av.at);
        else if (callee.k === "fn") r = inlineCall(callee.node, cargs, callee.ctx ?? ctx, av.at);
        else if (callee.k === "union" && callee.opts.every((o) => o.k === "fn")) r = union(callee.opts.map((o) => inlineCall(o.node, cargs, o.ctx ?? ctx, av.at)));
        else if (callee.k === "hole" || callee.k === "call") r = { ...av, callee, args: cargs, path: [] };
        else r = av.node ? typeFallback(av.node, "result of a callback this module could not resolve") : opaque("call of an unresolved callback", av.at);
        out = getPath(r, av.path ?? []);
        break;
      }
      case "guard":
        out = decideGuard({ ...av, base: subst(av.base, fn, args, ctx, seen), t: subst(av.t, fn, args, ctx, seen), f: subst(av.f, fn, args, ctx, seen) });
        break;
      case "fn":
        out = av;
        break;
      default:
        out = av;
    }
    seen.set(av, out);
    return out;
  }
  /** Take the guard's branch when its test is now decidable; stay a guard while the test
   *  still depends on a parameter; otherwise both branches. */
  function decideGuard(g) {
    const d = asUnion(getProp(g.base, g.prop));
    const outcome = (v) => (v.k === "lit" ? (v.v === g.lit) === g.eq : v.k === "absent" ? !g.eq : undefined);
    const alts = d.k === "union" ? d.opts : [d];
    const results = alts.map(outcome);
    if (results.every((r) => r === true)) return g.t;
    if (results.every((r) => r === false)) return g.f;
    if (results.some((r) => r === undefined) && holeFns(d).size > 0) return g;
    return union([g.t, g.f]);
  }
  const typedPathFallback = (h) => {
    if (!h.typedFrom) return opaque("unresolved parameter", undefined);
    let v = typeFallback(h.typedFrom, `argument #${h.idx} of ${labelOf(h.fn)}`);
    for (const k of h.typedPath ?? []) v = getProp(v, k);
    return v;
  };

  // ---- variants, keys, phases -------------------------------------------------------------
  const contributesEventCore = (av) => {
    const s = getProp(av, "stream");
    const d = getProp(av, "data");
    return s.k !== "absent" || d.k !== "absent";
  };
  /** Expand an EVENT value into variants, keeping stream and data correlated: unions are
   *  distributed, and so are spreads whose alternatives carry `stream`/`data`. */
  function eventVariants(av0, budget = { n: 0 }) {
    const av = asUnion(av0);
    if (budget.n > MAX_VARIANTS) return [opaque(`more than ${MAX_VARIANTS} event variants (evaluator bound)`, av.at)];
    if (av.k === "union") return av.opts.flatMap((o) => eventVariants(o, budget));
    if (av.k !== "obj") return [av];
    let acc = [[]];
    for (const e of av.entries) {
      if (e.t === "spread" && e.v.k === "union" && e.v.opts.some((o) => o.k !== "absent" && contributesEventCore(o))) {
        const vs = e.v.opts.flatMap((o) => (o.k === "absent" ? [ABSENT] : eventVariants(o, budget)));
        acc = acc.flatMap((prefix) => vs.map((v) => (v.k === "absent" ? prefix : [...prefix, { t: "spread", v }])));
      } else acc = acc.map((prefix) => [...prefix, e]);
      budget.n = Math.max(budget.n, acc.length);
      if (acc.length > MAX_VARIANTS) return [opaque(`more than ${MAX_VARIANTS} event variants (evaluator bound)`, av.at)];
    }
    return acc.map((entries) => objFromEntries(entries, av.at));
  }

  /** Literal values of a scalar value (stream, phase): each with its provenance. */
  function scalarValues(av) {
    const out = [];
    const visit = (v, optional) => {
      switch (v.k) {
        case "guard":
          visit(asUnion(v), optional);
          break;
        case "union":
          for (const o of v.opts) visit(o, optional);
          break;
        case "lit":
          out.push({ value: v.v, src: v.src === "type" ? "type" : "syntax", why: v.why });
          break;
        case "absent":
          out.push({ value: null, absent: true });
          break;
        case "tpl":
          out.push({
            pattern: v.parts.map((p) => (typeof p === "string" ? p : "*")).join(""),
            reason: `template with unresolved parts (${v.parts.filter((p) => typeof p !== "string").map(describe).join("; ")})`,
            at: v.at,
          });
          break;
        default:
          out.push({ opaque: true, reason: describe(v), at: v.at, literals: v.literals });
      }
    };
    visit(av, false);
    return out;
  }
  function describe(v) {
    switch (v.k) {
      case "guard":
        return `${describe(v.t)} or ${describe(v.f)} (chosen by .${v.prop} === ${JSON.stringify(v.lit)})`;
      case "opaque":
        return v.reason;
      case "hole":
        return `parameter #${v.idx}${v.path.length ? `.${v.path.join(".")}` : ""} of ${labelOf(v.fn)} (no caller resolves it)`;
      case "derived":
        return `${describe(v.from)} through .${v.via}()`;
      case "call":
        return `result of calling ${describe(v.callee)}`;
      case "fn":
        return "a function value";
      case "obj":
        return "an object";
      case "arr":
        return "an array";
      case "tobj":
        return `a value of declared type ${typeStr(v.type)}`;
      case "lit":
        return JSON.stringify(v.v);
      case "tpl":
        return "a template";
      default:
        return v.k;
    }
  }

  /** Data variants: a top-level union is one variant per alternative. */
  const dataVariants = (av0) => {
    const av = asUnion(av0);
    if (av.k === "union") {
      const out = [];
      for (const o of av.opts) out.push(...dataVariants(o));
      return out;
    }
    return [av];
  };
  /** Keys of one data variant: name → { opt, src }; opaque contributions; notes. */
  function keysOf(av) {
    const keys = new Map();
    const opaques = [];
    const add = (key, opt, src) => {
      const prev = keys.get(key);
      if (!prev) keys.set(key, { opt, src });
      else keys.set(key, { opt: prev.opt && opt, src: prev.src === "syntax" || src === "syntax" ? "syntax" : "type" });
    };
    const visit = (v, opt) => {
      switch (v.k) {
        case "guard":
          visit(asUnion(v), opt);
          break;
        case "obj":
          for (const e of v.entries) {
            if (e.t === "prop") add(e.key, opt || e.opt || propMayBeAbsent(e), "syntax");
            else if (e.t === "keyopaque") opaques.push({ reason: `computed key ${e.text}`, at: e.at });
            else if (e.t === "spread") visit(e.v, opt || !definitelyObject(e.v));
          }
          break;
        case "union":
          for (const o of v.opts) {
            if (o.k === "absent") continue;
            visit(o, true);
          }
          // A key present in EVERY alternative is not optional.
          for (const [k, info] of keys) {
            if (v.opts.every((o) => o.k !== "absent" && definitelyHas(o, k, typedHas))) keys.set(k, { ...info, opt: opt });
          }
          break;
        case "tobj": {
          const { keys: tk, opaque: to } = tobjKeys(v);
          for (const { key, opt: o } of tk) add(key, opt || o, "type");
          for (const x of to) opaques.push({ reason: x.reason, at: x.at });
          break;
        }
        case "absent":
          break;
        case "lit":
          if (v.v !== null && v.v !== false) opaques.push({ reason: `data spread of a ${typeof v.v} literal`, at: v.at });
          break;
        default:
          opaques.push({ reason: describe(v), at: v.at });
      }
    };
    visit(av, false);
    return { keys, opaques };
  }
  const mayBeAbsent = (v0) => {
    const v = asUnion(v0);
    return v.k === "absent" || (v.k === "union" && v.opts.some((o) => o.k === "absent"));
  };
  /** May this property be absent on the wire? An unevaluated value is judged by its
   *  DECLARED type (`string | undefined` → may be absent), so that asking does not force
   *  the evaluation the laziness exists to avoid. */
  const propMayBeAbsent = (e) => {
    if (e.lazy && e.init) {
      let t;
      try {
        t = checker.getTypeAtLocation(e.init);
      } catch {
        return true;
      }
      const f = (x) => (x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      return f(t) || (t.isUnion() && t.types.some(f));
    }
    return mayBeAbsent(propVal(e));
  };
  const definitelyObject = (v0) => {
    const v = asUnion(v0);
    return v.k === "obj" || v.k === "tobj" || (v.k === "union" && v.opts.every((o) => o.k === "obj" || o.k === "tobj"));
  };

  // ---- 2. the root ----------------------------------------------------------------------
  const rootSf = sfByRel.get(ROOT_SOURCE);
  if (!rootSf) throw new Error(`${ROOT_SOURCE} is not in the analysed sources — upstream moved the agent event bus`);
  const topFns = rootSf.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name);
  const dispatchers = topFns.filter((s) => s.name.text === ROOT_DISPATCHER && s.body);
  if (dispatchers.length !== 1) {
    throw new Error(`${ROOT_SOURCE}: expected exactly one ${ROOT_DISPATCHER} with a body, found ${dispatchers.length} — upstream renamed or split the dispatcher`);
  }
  const dispatcher = dispatchers[0];
  const callsTo = (fnNode, name) => {
    let found = false;
    const visit = (n) => {
      if (found) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(unwrapExpr(n.expression)) && unwrapExpr(n.expression).text === name) found = true;
      ts.forEachChild(n, visit);
    };
    visit(fnNode.body);
    return found;
  };
  const feeders = topFns.filter((s) => s.body && callsTo(s, ROOT_LISTENER_ITERATOR));
  if (feeders.length !== 1 || feeders[0] !== dispatcher) {
    throw new Error(
      `${ROOT_SOURCE}: ${ROOT_LISTENER_ITERATOR} must be fed by ${ROOT_DISPATCHER} alone; fed by ` +
        `[${feeders.map((f) => f.name.text).join(", ")}] — a second door to the public listeners is a second root`,
    );
  }
  if (dispatcher.parameters.length === 0) throw new Error(`${ROOT_DISPATCHER} takes no event parameter`);
  // Other notifiers of the module: listed so the reader sees what is OUT of the channel.
  const otherChannels = topFns
    .filter((s) => s !== dispatcher && s.body && callsTo(s, "notifyListeners"))
    .map((s) => ({ function: s.name.text, line: lineOf(s), exported: (s.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword) }));
  // The declared stream union, for reference only.
  let declaredStreams = null;
  for (const st of rootSf.statements) {
    if (ts.isTypeAliasDeclaration(st) && st.name.text === STREAM_TYPE) {
      const t = checker.getTypeAtLocation(st.name);
      const members = t.isUnion() ? t.types : [t];
      declaredStreams = {
        literals: members.filter((m) => m.flags & ts.TypeFlags.StringLiteral).map((m) => m.value).sort(),
        open: members.some(isOpenStringish),
        line: lineOf(st),
      };
    }
  }

  // ---- 3. discovery ---------------------------------------------------------------------
  //
  // An ITEM is something whose calls emit: { decls, names, template, holeFn, chain, label }.
  // `template` is the event value in terms of holeFn's parameters.
  const items = new Map(); // key → item
  const queue = []; // tasks: { item, names } — names still to be searched for this item
  const siteResults = new Map(); // call node → { item, records }
  const opaqueEscapes = [];
  // Wrappers the discovery could not follow to a caller (unnameable, or produced by a
  // factory into somewhere it cannot read): their emissions become OPEN rows.
  const unnamedOpen = [];

  const declKey = (decls) => [...decls].map((d) => `${fileOf(d)}@${d.getStart()}`).sort().join("|");
  const addItem = (spec) => {
    const key = spec.key ?? declKey(spec.decls);
    const existing = items.get(key);
    if (existing) {
      const merged = union([existing.template, spec.template]);
      if (avEquals(merged, existing.template) || existing.requeue >= MAX_REQUEUE) {
        existing.via.push(...(spec.via ?? []));
        return existing;
      }
      existing.template = merged;
      existing.requeue += 1;
      existing.via.push(...(spec.via ?? []));
      queue.push({ item: existing, names: [...existing.names] });
      return existing;
    }
    const item = { ...spec, key, requeue: 0, via: [...(spec.via ?? [])], openVia: [] };
    items.set(key, item);
    queue.push({ item, names: [...item.names] });
    return item;
  };
  /** A member reached under another NAME (an import alias, a re-export as): the name is
   *  searched too. Missing this lost the codex projector's whole family — its module
   *  imports `emitAgentEvent as emitGlobalAgentEvent`. */
  const addName = (item, name) => {
    if (item.names.has(name)) return;
    item.names.add(name);
    queue.push({ item, names: [name] });
  };

  addItem({
    kind: "root",
    decls: new Set([dispatcher]),
    names: new Set([ROOT_DISPATCHER]),
    template: { k: "hole", fn: dispatcher, idx: 0, path: [], expr: dispatcher.parameters[0].name, param: dispatcher.parameters[0] },
    holeFn: dispatcher,
    chain: [ROOT_DISPATCHER],
    label: ROOT_DISPATCHER,
    def: dispatcher,
  });

  /** Where a FUNCTION VALUE expression flows. */
  function flowTargets(expr) {
    const outer = skipOuter(expr);
    const p = outer.parent;
    if (!p) return [{ kind: "opaque", reason: "no parent" }];
    if (ts.isConditionalExpression(p) && (p.whenTrue === outer || p.whenFalse === outer)) return flowTargets(p);
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(p.operatorToken.kind)) {
      if (p.right === outer || p.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return flowTargets(p);
    }
    if (ts.isVariableDeclaration(p) && p.initializer === outer) {
      if (ts.isIdentifier(p.name)) return [{ kind: "var", decl: p }];
      return [{ kind: "opaque", reason: "destructured into a pattern" }];
    }
    if (ts.isBinaryExpression(p) && p.right === outer && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrapExpr(p.left);
      const sym = resolveSym(ts.isPropertyAccessExpression(left) ? left.name : left);
      const decls = declsOf(sym);
      if (decls.length === 0) return [{ kind: "opaque", reason: `assigned to ${left.getText().slice(0, 60)}, which does not resolve` }];
      return [{ kind: "decls", decls, name: ts.isPropertyAccessExpression(left) ? left.name.text : left.getText(), how: "assignment" }];
    }
    if ((ts.isPropertyAssignment(p) && p.initializer === outer) || (ts.isShorthandPropertyAssignment(p) && p.name === outer)) {
      return [{ kind: "prop", prop: p }];
    }
    if (ts.isPropertyDeclaration(p) && p.initializer === outer) {
      return [{ kind: "decls", decls: [p], name: p.name.getText(), how: "class field" }];
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && (p.arguments ?? []).includes(outer)) {
      return [{ kind: "arg", call: p, index: p.arguments.indexOf(outer) }];
    }
    if (ts.isCallExpression(p) && p.expression === outer) return [{ kind: "invoke", call: p }];
    if (ts.isReturnStatement(p)) {
      const fn = enclosingFunction(p);
      return fn ? [{ kind: "return", fn }] : [{ kind: "opaque", reason: "returned at module level" }];
    }
    if (isFunctionLike(p) && p.body === outer) return [{ kind: "return", fn: p }];
    if (ts.isExportAssignment(p)) return [{ kind: "export", how: "export default" }];
    if (ts.isArrayLiteralExpression(p)) return [{ kind: "opaque", reason: "stored in an array literal" }];
    if (ts.isPropertyAccessExpression(p) && p.expression === outer) {
      const m = p.name.text;
      if (m === "bind" || m === "call" || m === "apply") return [{ kind: "opaque", reason: `.${m}() on an emitter` }];
      return [{ kind: "member", reason: `member .${m} read on an emitter` }];
    }
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) {
      return [{ kind: "compare" }];
    }
    if (ts.isTypeOfExpression(p)) return [{ kind: "compare" }];
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return [{ kind: "compare" }];
    if (ts.isIfStatement(p) && p.expression === outer) return [{ kind: "compare" }];
    if (ts.isExpressionStatement(p) || ts.isVoidExpression(p)) return [{ kind: "discarded" }];
    return [{ kind: "opaque", reason: `flows into a ${ts.SyntaxKind[p.kind]}` }];
  }

  /** The declarations of the property `name` an object literal is contextually typed by —
   *  looking through the wrappers that keep a literal's keys at the outer level (a spread,
   *  a ternary, parentheses): `handlers: { ...(ok ? { emitAgentEvent: … } : {}) }` is
   *  typed by `handlers`' declared type, not by anything of its own. */
  function contextualPropertyDecls(objLit, name) {
    const out = [];
    const tryOn = (lit0) => {
      let t;
      try {
        t = checker.getContextualType(lit0);
      } catch {
        t = undefined;
      }
      if (!t) return;
      const candidates = [t];
      if (t.isUnionOrIntersection?.()) candidates.push(...t.types);
      for (const c of candidates) {
        let p;
        try {
          p = checker.getPropertyOfType(c, name) ?? checker.getPropertyOfType(checker.getApparentType(c), name);
        } catch {
          p = undefined;
        }
        if (!p) continue;
        const ds = declsOf(p);
        if (ds.length > 0) out.push(...ds);
        else if (p.links?.syntheticOrigin) out.push(...declsOf(p.links.syntheticOrigin));
      }
    };
    let cur = objLit;
    tryOn(cur);
    for (let guard = 0; guard < 8; guard += 1) {
      let up = cur.parent;
      while (up && (isWrapperParen(up) || (ts.isConditionalExpression(up) && up.condition !== cur))) {
        cur = up;
        up = up.parent;
      }
      if (up && ts.isSpreadAssignment(up) && ts.isObjectLiteralExpression(up.parent)) {
        cur = up.parent;
        tryOn(cur);
        continue;
      }
      break;
    }
    return out;
  }

  /** The value item of a function expression that forwards: give it a name to be found by. */
  function itemForValue(expr, template, holeFn, chain, via, label) {
    const results = [];
    for (const t of flowTargets(expr)) {
      if (t.kind === "var") {
        results.push(addItem({ kind: "variable", decls: new Set([t.decl]), names: new Set([t.decl.name.text]), template, holeFn, chain, label, via, def: t.decl }));
      } else if (t.kind === "decls") {
        results.push(addItem({ kind: t.how, decls: new Set(t.decls), names: new Set([t.name]), template, holeFn, chain, label, via, def: t.decls[0] }));
      } else if (t.kind === "prop") {
        const decls = new Set([t.prop]);
        const name = t.prop.name.getText();
        for (const d of contextualPropertyDecls(t.prop.parent, name)) decls.add(d);
        // The literal itself may be reached through a variable typed by inference.
        const own = checker.getSymbolAtLocation(t.prop.name);
        for (const d of declsOf(own)) decls.add(d);
        results.push(addItem({ kind: "property", decls, names: new Set([name]), template, holeFn, chain, label, via, def: t.prop }));
      } else if (t.kind === "arg") {
        const call = t.call;
        const callee = unwrapExpr(call.expression);
        // Array iteration: the callback is CALLED with the receiver's elements, here.
        if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(callee) && ARRAY_ITERATION_METHODS.has(callee.name.text)) {
          const recvType = checker.getTypeAtLocation(callee.expression);
          if (checker.isArrayType(recvType) || checker.isTupleType(recvType) || /^(?:Readonly)?(?:Set|Map)</.test(typeStr(recvType))) {
            results.push({ invokeAt: call, args: (ctx) => [elementOf(ev(callee.expression, ctx), locOf(callee.expression)), opaque("index", locOf(call)), ev(callee.expression, ctx)] });
            continue;
          }
        }
        const decl = calleeDeclaration(call);
        if (!decl) {
          results.push({ escape: `passed to ${callee.getText().slice(0, 60)}(…) whose declaration is not in the analysed sources` });
          continue;
        }
        let param = decl.parameters[t.index];
        if (!param) {
          const last = decl.parameters[decl.parameters.length - 1];
          if (last?.dotDotDotToken) param = last;
        }
        if (!param) {
          results.push({ escape: `argument #${t.index} of ${labelOf(decl)} has no parameter` });
          continue;
        }
        if (!ts.isIdentifier(param.name)) {
          results.push({ escape: `argument #${t.index} of ${labelOf(decl)} is destructured` });
          continue;
        }
        const decls = new Set([param]);
        if (ts.isConstructorDeclaration(decl) && ts.getModifiers?.(param)?.length) {
          for (const s of checker.getSymbolsOfParameterPropertyDeclaration(param, param.name.text)) for (const d of declsOf(s)) decls.add(d);
        }
        results.push(addItem({ kind: "parameter", decls, names: new Set([param.name.text]), template, holeFn, chain, label, via, def: param, scope: decl }));
      } else if (t.kind === "invoke") {
        results.push({ invokeAt: t.call, args: (ctx) => evalArgs(t.call.arguments, ctx) });
      } else if (t.kind === "return") {
        results.push(addFactory(t.fn, template, holeFn, chain, via, label));
      } else if (t.kind === "opaque") {
        results.push({ escape: t.reason });
      } else {
        results.push({ benign: t.kind, reason: t.reason });
      }
    }
    return results;
  }

  /** A function that RETURNS a forwarding closure: its calls produce emitters. */
  function addFactory(fn, template, holeFn, chain, via, label) {
    const named = factoryHandle(fn);
    if (!named) return { escape: `factory ${labelOf(fn)} cannot be named` };
    return addItem({ ...named, kind: "factory", template, holeFn, chain, label: `${labelOf(fn)}()→${label}`, via, factoryFn: fn });
  }
  function factoryHandle(fn) {
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
      return { decls: new Set([fn]), names: new Set([fn.name.getText()]), def: fn };
    }
    const p = skipOuter(fn).parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return { decls: new Set([p]), names: new Set([p.name.text]), def: p };
    if (p && ts.isPropertyAssignment(p)) return { decls: new Set([p]), names: new Set([p.name.getText()]), def: p };
    return undefined;
  }

  /** Holes that can change what this inventory RECORDS: the stream, the data key set and
   *  `data.phase`. A hole in any other data value (a stop reason, a text) changes nothing
   *  recorded here — and following it made every function that passes a string through
   *  to an emitter a "wrapper", up the whole call graph (measured: 896 members, most of
   *  them forwarding a reason or an id). */
  function dataShapeHoles(d, out) {
    switch (d.k) {
      case "guard":
        holeFns(d.base, out);
        dataShapeHoles(d.t, out);
        dataShapeHoles(d.f, out);
        break;
      case "hole":
      case "call":
      case "derived":
      case "tpl":
        holeFns(d, out);
        break;
      case "union":
        for (const o of d.opts) dataShapeHoles(o, out);
        break;
      case "obj":
        for (const e of d.entries) {
          if (e.t === "spread") dataShapeHoles(e.v, out);
          else if (e.t === "prop" && e.key === "phase") holeFns(propVal(e), out);
        }
        break;
      default:
        break;
    }
    return out;
  }
  /** Classify an event value computed at a call site: emission, or a forwarding wrapper. */
  function classifySite(siteNode, eventAV, item) {
    const variants = eventVariants(eventAV);
    const relevantHoles = new Set();
    if (eventAV.k === "guard") holeFns(eventAV.base, relevantHoles);
    for (const v of variants) {
      holeFns(getProp(v, "stream"), relevantHoles);
      dataShapeHoles(getProp(v, "data"), relevantHoles);
    }
    // The innermost enclosing function among the hole owners is the wrapper.
    if (relevantHoles.size > 0) {
      let fn = enclosingFunction(siteNode);
      while (fn && !relevantHoles.has(fn)) fn = enclosingFunction(fn);
      if (!fn) fn = [...relevantHoles][0];
      return { kind: "forward", wrapperFn: fn, template: eventAV };
    }
    return { kind: "emission", variants };
  }

  const wrapperLabel = (fn) => labelOf(fn);
  /** Holes of functions that do NOT enclose the site cannot be filled from here: they are
   *  closure parameters of some other function, carried in by a template. They are closed
   *  over by their declared type, or become opaque, naming whose parameter they were. */
  function closeForeignHoles(av, siteNode) {
    const enclosing = new Set();
    for (let fn = enclosingFunction(siteNode); fn; fn = enclosingFunction(fn)) enclosing.add(fn);
    return closeHolesOf(av, (fn) => !enclosing.has(fn));
  }
  function closeHolesOf(av, shouldClose, seen = new Map()) {
    if (!av || typeof av !== "object") return av;
    if (seen.has(av)) return seen.get(av);
    let out = av;
    switch (av.k) {
      case "hole":
        if (shouldClose(av.fn)) {
          const t = av.expr ? typeFallback(av.expr, `closure parameter #${av.idx} of ${labelOf(av.fn)}`) : typedPathFallback(av);
          out = t.k === "opaque" ? { ...t, reason: `${t.reason} (closure parameter #${av.idx}${av.path.length ? `.${av.path.join(".")}` : ""} of ${labelOf(av.fn)}, not filled at this site)` } : t;
        }
        break;
      case "union":
        out = union(av.opts.map((o) => closeHolesOf(o, shouldClose, seen)));
        break;
      case "obj":
        out = objFromEntries(av.entries.map((e) => (e.t === "prop" ? mapProp(e, (v) => closeHolesOf(v, shouldClose, seen)) : e.t === "spread" ? { ...e, v: closeHolesOf(e.v, shouldClose, seen) } : e)), av.at);
        break;
      case "arr":
        out = { ...av, elems: av.elems.map((e) => closeHolesOf(e, shouldClose, seen)) };
        break;
      case "derived":
        out = derive(closeHolesOf(av.from, shouldClose, seen), av.via, av.at);
        break;
      case "tpl": {
        const parts = av.parts.map((p) => (typeof p === "string" ? p : closeHolesOf(p, shouldClose, seen)));
        out = { ...av, parts };
        break;
      }
      case "guard":
        out = decideGuard({ ...av, base: closeHolesOf(av.base, shouldClose, seen), t: closeHolesOf(av.t, shouldClose, seen), f: closeHolesOf(av.f, shouldClose, seen) });
        if (out.k === "guard" && holeFns(out.base).size === 0) out = union([out.t, out.f]);
        break;
      case "call":
        out = { ...av, callee: closeHolesOf(av.callee, shouldClose, seen), args: av.args.map((a) => closeHolesOf(a, shouldClose, seen)) };
        if (out.callee.k !== "hole" && out.callee.k !== "call" && out.callee.k !== "fn") out = av.node ? typeFallback(av.node, "result of a callback this module could not resolve") : opaque("call of an unresolved callback", av.at);
        break;
      default:
        break;
    }
    seen.set(av, out);
    return out;
  }

  function processCallSite(siteNode, item, argAVs, how) {
    const started = Date.now();
    const eventAV = closeForeignHoles(subst(item.template, item.holeFn, argAVs), siteNode);
    const ms = Date.now() - started;
    if (ms > 1000) trace(`site ${locOf(siteNode)} via ${item.label} took ${ms} ms (${budget.steps} steps)`);
    const c = classifySite(siteNode, eventAV, item);
    if (c.kind === "forward") {
      const wfn = c.wrapperFn;
      const chain = [wrapperLabel(wfn), ...item.chain];
      const via = [{ at: locOf(siteNode), through: item.label }];
      let handled;
      if ((ts.isFunctionDeclaration(wfn) || ts.isMethodDeclaration(wfn) || ts.isGetAccessorDeclaration(wfn)) && wfn.name) {
        const decls = new Set([wfn]);
        const own = checker.getSymbolAtLocation(wfn.name);
        for (const d of declsOf(own)) decls.add(d);
        // An object-literal method is also reached through the contextual type's property.
        if (ts.isMethodDeclaration(wfn) && ts.isObjectLiteralExpression(wfn.parent)) {
          for (const d of contextualPropertyDecls(wfn.parent, wfn.name.getText())) decls.add(d);
        }
        handled = [addItem({ kind: "function", decls, names: new Set([wfn.name.getText()]), template: c.template, holeFn: wfn, chain, label: wrapperLabel(wfn), via, def: wfn })];
      } else if (ts.isConstructorDeclaration(wfn)) {
        handled = [{ escape: `forwarding inside a constructor (${labelOf(wfn)})` }];
      } else {
        handled = itemForValue(wfn, c.template, wfn, chain, via, wrapperLabel(wfn));
      }
      const followed = [];
      for (const h of handled) {
        if (h && h.invokeAt) {
          // Invoked right here (IIFE, array callback): the call site is the invocation.
          const args = h.args(ROOT_CTX);
          const tmpItem = { template: c.template, holeFn: wfn, chain, label: wrapperLabel(wfn) };
          processCallSite(h.invokeAt, tmpItem, args, "invoked");
          followed.push({ invoked: locOf(h.invokeAt) });
        } else if (h && h.escape) {
          opaqueEscapes.push({ at: locOf(wfn), function: labelOf(wfn), reason: `wrapper ${labelOf(wfn)} ${h.escape}`, through: item.label });
          unnamedOpen.push({ label: wrapperLabel(wfn), kind: "unnamed", def: wfn, template: c.template, holeFn: wfn, chain, openVia: [{ at: locOf(wfn), how: `escapes: ${h.escape}` }] });
          followed.push({ escape: h.escape });
        } else if (h && h.benign) {
          followed.push({ benign: h.benign });
        } else if (h) followed.push({ item: h.key });
      }
      siteResults.set(siteNode, { item, kind: "forward", wrapper: labelOf(wfn), how, followed });
      return "forward";
    }
    siteResults.set(siteNode, { item, kind: "emission", variants: c.variants, how });
    return "emission";
  }

  /** The call a reference is the callee of, if any (`f(…)`, `o.f(…)`, `o?.f?.(…)`). */
  const callOfCallee = (id) => {
    let n = id;
    if (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
    const outer = skipOuter(n);
    const p = outer.parent;
    if (p && ts.isCallExpression(p) && p.expression === outer) return p;
    return undefined;
  };
  const isTypePosition = (id) => {
    let n = id.parent;
    while (n) {
      if (ts.isTypeNode(n) || ts.isTypeQueryNode?.(n) || ts.isExpressionWithTypeArguments(n) && n.parent && ts.isHeritageClause(n.parent) && n.parent.token === ts.SyntaxKind.ImplementsKeyword) return true;
      if (ts.isExpression(n) || ts.isStatement(n) || ts.isSourceFile(n)) return false;
      n = n.parent;
    }
    return false;
  };
  const isDeclarationName = (id) => {
    const p = id.parent;
    return !!p && (p.name === id) && (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isBindingElement(p) && !p.propertyName || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p));
  };
  const isImportExportName = (id) => {
    const p = id.parent;
    return !!p && (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isNamespaceExport(p) || ts.isExportAssignment(p) && p.expression === id);
  };

  /** The property an object-pattern element destructures, resolved on the initializer's
   *  type: `const { emitAgentEvent: emit } = await import(…)` reaches the export. */
  const bindingTargetDecls = (el) => {
    const pattern = el.parent;
    const key = el.propertyName ?? el.name;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return [];
    let t;
    try {
      t = checker.getTypeAtLocation(pattern);
    } catch {
      return [];
    }
    let prop = t ? checker.getPropertyOfType(t, key.text) : undefined;
    let guard = 0;
    while (prop && prop.flags & ts.SymbolFlags.Alias && guard < 16) {
      prop = checker.getAliasedSymbol(prop);
      guard += 1;
    }
    return declsOf(prop);
  };
  // The PUBLIC closure: every declaration the public surface exports, and every
  // interface / type alias reachable from those through type references. A member of a
  // type in this closure is a contract external code (a plugin) can call through.
  const publicDecls = new Set();
  const publicTypes = new Set();
  {
    const pending = [];
    const isTypeDecl = (d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isClassDeclaration(d);
    for (const sf of sourceFiles) {
      if (!publicSurface(relOfFile(sf))) continue;
      const msym = sf.symbol ? checker.getMergedSymbol(sf.symbol) : undefined;
      if (!msym) continue;
      for (const ex of checker.getExportsOfModule(msym)) {
        let sym = ex;
        let guard = 0;
        while (sym && sym.flags & ts.SymbolFlags.Alias && guard < 16) {
          const next = checker.getAliasedSymbol(sym);
          if (!next || next === sym) break;
          sym = next;
          guard += 1;
        }
        for (const d of declsOf(sym)) {
          publicDecls.add(d);
          if (isTypeDecl(d)) pending.push(d);
        }
      }
    }
    while (pending.length > 0 && publicTypes.size < 50000) {
      const d = pending.pop();
      if (publicTypes.has(d)) continue;
      publicTypes.add(d);
      const visit = (n) => {
        if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n)) {
          const nameNode = ts.isTypeReferenceNode(n) ? n.typeName : n.expression;
          const target = resolveSym(ts.isQualifiedName(nameNode) ? nameNode.right : nameNode);
          for (const td of declsOf(target)) if (isTypeDecl(td) && !publicTypes.has(td) && inAnalysis(td)) pending.push(td);
        }
        ts.forEachChild(n, visit);
      };
      visit(d);
    }
  }
  /** The public contract a member signature belongs to, if any. */
  const publicContractOf = (decl) => {
    if (!ts.isPropertySignature(decl) && !ts.isMethodSignature(decl) && !ts.isPropertyDeclaration(decl) && !ts.isMethodDeclaration(decl)) return undefined;
    let n = decl.parent;
    while (n && !ts.isInterfaceDeclaration(n) && !ts.isTypeAliasDeclaration(n) && !ts.isClassDeclaration(n) && !ts.isSourceFile(n)) n = n.parent;
    if (!n || ts.isSourceFile(n) || !publicTypes.has(n)) return undefined;
    return n.name?.text ?? "<anonymous>";
  };

  const matched = new Map(); // identifier → item key (completeness)
  function processItem(item, names) {
    for (const name of names) {
      for (const sf of filesMentioning(name)) {
        const ids = identifiersOf(sf).get(name) ?? [];
        for (const id of ids) {
          if (isDeclarationName(id) && item.decls.has(id.parent)) {
            matched.set(id, { item: item.key, cls: "declaration" });
            continue;
          }
          budget.steps = 0;
          budget.exhausted = false;
          const p = id.parent;
          // An object-pattern element: `{ emitAgentEvent }` / `{ emitAgentEvent: local }`.
          if (p && ts.isBindingElement(p) && ts.isObjectBindingPattern(p.parent) && (p.propertyName === id || (!p.propertyName && p.name === id))) {
            if (!bindingTargetDecls(p).some((d) => item.decls.has(d))) continue;
            if (ts.isIdentifier(p.name)) {
              addItem({ kind: "destructured", decls: new Set([p]), names: new Set([p.name.text]), template: item.template, holeFn: item.holeFn, chain: [`${p.name.text}=${item.label}`, ...item.chain.slice(1)], label: `${p.name.text}=${item.label}`, via: [{ at: locOf(p), through: item.label }], def: p });
              matched.set(id, { item: item.key, cls: "destructured" });
            } else {
              opaqueEscapes.push({ at: locOf(p), function: labelOf(enclosingFunction(p)), reason: `${item.label} destructured into a nested pattern`, through: item.label });
              item.openVia.push({ at: locOf(p), how: "escapes: destructured into a nested pattern" });
              matched.set(id, { item: item.key, cls: "escape" });
            }
            continue;
          }
          let sym;
          if (isImportExportName(id)) {
            sym = resolveSym(id);
          } else sym = valueSymOf(id);
          const decls = declsOf(sym);
          if (!decls.some((d) => item.decls.has(d))) continue;
          let cls;
          if (isImportExportName(id)) {
            cls = "import-export";
            if (p && (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.name.text !== name) addName(item, p.name.text);
            if (p && ts.isExportSpecifier(p) && publicSurface(fileOf(p))) {
              item.openVia.push({ at: locOf(p), how: `exported as ${p.name.text} by the public module ${fileOf(p)}` });
            }
            if (p && ts.isExportAssignment(p)) {
              opaqueEscapes.push({ at: locOf(p), function: "<module>", reason: `${item.label} is a default export; importers bind it under names this module does not search`, through: item.label });
              cls = "escape";
            }
          } else if (isTypePosition(id)) cls = "type-only";
          else if (isDeclarationName(id)) cls = "declaration";
          else {
            const call = callOfCallee(id);
            if (call) {
              if (item.kind === "factory") {
                // The call PRODUCES an emitter: follow where its result goes.
                const fnTemplate = subst(item.template, item.factoryFn, evalArgs(call.arguments, ROOT_CTX));
                const res = itemForValue(call, fnTemplate, item.holeFn, item.chain, [{ at: locOf(call), through: item.label }], `${item.label}@${fileOf(call)}`);
                const esc = res.filter((r) => r && r.escape);
                for (const e of esc) {
                  opaqueEscapes.push({ at: locOf(call), function: labelOf(enclosingFunction(call)), reason: `emitter produced by ${item.label} ${e.escape}`, through: item.label });
                  unnamedOpen.push({ label: `${item.label}@${locOf(call)}`, kind: "factory-result", def: call, template: fnTemplate, holeFn: item.holeFn, chain: item.chain, openVia: [{ at: locOf(call), how: `escapes: ${e.escape}` }] });
                }
                for (const r of res.filter((x) => x && x.invokeAt)) processCallSite(r.invokeAt, { template: fnTemplate, holeFn: item.holeFn, chain: item.chain, label: item.label }, r.args(ROOT_CTX), "invoked");
                cls = esc.length ? "factory-call-escape" : "factory-call";
              } else {
                const args = evalArgs(call.arguments, ROOT_CTX);
                cls = processCallSite(call, item, args, "call") === "emission" ? "emission" : "forward";
              }
            } else {
              const expr = id.parent && ts.isPropertyAccessExpression(id.parent) && id.parent.name === id ? id.parent : id;
              const res = itemForValue(expr, item.template, item.holeFn, item.chain, [{ at: locOf(id), through: item.label }], item.label);
              const kinds = new Set();
              for (const r of res) {
                if (r && r.escape) {
                  opaqueEscapes.push({ at: locOf(id), function: labelOf(enclosingFunction(id)), reason: `${item.label} ${r.escape}`, through: item.label });
                  item.openVia.push({ at: locOf(id), how: `escapes: ${r.escape}` });
                  kinds.add("escape");
                } else if (r && r.invokeAt) {
                  processCallSite(r.invokeAt, item, r.args(ROOT_CTX), "invoked");
                  kinds.add("invoked");
                } else if (r && r.benign) kinds.add(r.benign);
                else if (r) kinds.add("value-flow");
              }
              cls = [...kinds].sort().join("+") || "value-flow";
            }
          }
          matched.set(id, { item: item.key, cls });
        }
      }
    }
  }

  trace(`unresolved in-repo imports: ${unresolvedImports.length}; discovery starts`);
  let processed = 0;
  while (queue.length > 0) {
    const { item, names } = queue.shift();
    const before = Date.now();
    processItem(item, names);
    processed += 1;
    const ms = Date.now() - before;
    if (ms > 2000) trace(`item ${item.label} [${names.join(",")}] took ${ms} ms`);
  }
  // A member nothing references by name is not a member with no callers: it is reached
  // through a computed key, a dynamic table (`handlers[key]`), or code outside the
  // analysed sources. Reported as OPEN — never dropped.
  const referencedItems = new Set();
  for (const m of matched.values()) if (m.cls !== "declaration") referencedItems.add(m.item);
  for (const it of items.values()) {
    if (it.kind === "root" || referencedItems.has(it.key)) continue;
    it.openVia.push({ at: it.def ? locOf(it.def) : "?", how: "no reference by name in the analysed sources (computed access, dynamic table, or an external caller)" });
  }
  // Members a CONTRACT exposes: an exported interface / type member whose implementation
  // forwards — callers outside the analysed sources (plugins) reach it through the type.
  for (const it of items.values()) {
    for (const d of it.decls) {
      const contract = publicContractOf(d);
      if (contract) it.openVia.push({ at: locOf(d), how: `member of ${contract}, a type the public surface exposes` });
      if (publicDecls.has(d) && !it.openVia.some((o) => o.how.startsWith("exported as"))) {
        it.openVia.push({ at: locOf(d), how: "exported by the public surface" });
      }
    }
  }
  trace(`discovery done: ${items.size} family members, ${processed} item passes, ${siteResults.size} sites`);

  // ---- 4. emissions ---------------------------------------------------------------------
  const emissions = [];
  const opaqueRows = [];
  for (const [site, res] of siteResults) {
    if (res.kind !== "emission") continue;
    buildRows({ site, variants: res.variants, fnLabel: labelOf(enclosingFunction(site)), emitter: res.item.label, chain: res.item.chain, how: res.how });
  }
  // OPEN rows: a member whose callers are not all in reach (public surface, contract, no
  // reference by name, an escape) still emits what its own template fixes — a literal
  // stream, the keys it adds. Its parameters are closed by their declared types; what the
  // caller supplies beyond that is an opaque contribution, never a silent gap.
  const openSources = [...[...items.values()].filter((it) => it.kind !== "root" && it.openVia.length > 0), ...unnamedOpen];
  for (const it of openSources) {
    if (!it.def) continue;
    const closed = closeHolesOf(it.template, () => true);
    buildRows({ site: it.def, variants: eventVariants(closed), fnLabel: it.label, emitter: it.label, chain: it.chain, how: "open", open: dedupe(it.openVia.map((o) => o.how)).sort() });
  }
  function buildRows({ site, variants, fnLabel, emitter, chain, how, open }) {
    const file = fileOf(site);
    const res = { how };
    for (const ev0 of variants) {
      const streamAV = getProp(ev0, "stream");
      const dataAV = getProp(ev0, "data");
      const topKeys = keysOf(ev0).keys;
      const streams = scalarValues(streamAV);
      for (const s of streams) {
        if (s.absent) continue; // a variant without a stream is not an event of this channel
        const streamDesc = s.opaque || s.pattern !== undefined ? { opaque: true, pattern: s.pattern ?? null, reason: s.reason, at: s.at ?? null, literals: s.literals ?? null } : { value: s.value, src: s.src };
        if (streamDesc.opaque) {
          opaqueRows.push({ file, line: lineOf(site), function: fnLabel, what: "stream", reason: s.reason, origin: s.at ?? null, emitter });
        }
        const dvs = dataVariants(dataAV);
        // An absent-data alternative BESIDE present ones is the flow-insensitivity of the
        // evaluator (`x ? { stream, data: x } : …` guarded elsewhere), not a frame without
        // data: it becomes a flag on the rows, never a row of its own. Alone, it stays.
        const someData = dvs.some((d) => d.k !== "absent");
        const dataMaybeAbsent = someData && dvs.some((d) => d.k === "absent");
        for (const dv of dvs) {
          if (dv.k === "absent") {
            if (someData) continue;
            pushEmission({ file, site, fnLabel, emitter, chain, stream: streamDesc, phase: { value: null, absent: true }, keys: new Map(), opaques: [], dataAbsent: true, topKeys, how: res.how, open });
            continue;
          }
          const { keys, opaques } = keysOf(dv);
          for (const o of opaques) opaqueRows.push({ file, line: lineOf(site), function: fnLabel, what: "data", reason: o.reason, origin: o.at ?? null, emitter, stream: streamDesc.value ?? streamDesc.pattern ?? null });
          const phases = keys.has("phase") || dv.k === "tobj" || dv.k === "opaque" ? scalarValues(getProp(dv, "phase")) : [{ value: null, absent: true }];
          const seenPhase = new Set();
          for (const ph of phases) {
            const pk = ph.opaque ? `opaque:${ph.reason}` : ph.pattern !== undefined ? `pattern:${ph.pattern}` : String(ph.value);
            if (seenPhase.has(pk)) continue;
            seenPhase.add(pk);
            if (ph.opaque || ph.pattern !== undefined) {
              opaqueRows.push({ file, line: lineOf(site), function: fnLabel, what: "phase", reason: ph.reason, origin: ph.at ?? null, emitter, stream: streamDesc.value ?? streamDesc.pattern ?? null });
            }
            pushEmission({ file, site, fnLabel, emitter, chain, stream: streamDesc, phase: ph, keys, opaques, topKeys, how: res.how, dataMaybeAbsent, open });
          }
        }
      }
    }
  }
  function pushEmission(e) {
    const keyList = [...e.keys.entries()].map(([k, info]) => ({ key: k, optional: info.opt, src: info.src })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const stream = e.stream.opaque ? null : e.stream.value;
    const phase = e.phase.opaque || e.phase.pattern !== undefined ? null : e.phase.value;
    const phaseText = e.phase.absent ? "-" : e.phase.opaque ? "<opaque>" : e.phase.pattern !== undefined ? `<${e.phase.pattern}>` : String(e.phase.value);
    const streamText = e.stream.opaque ? `<${e.stream.pattern ?? "opaque"}>` : String(e.stream.value);
    const keysText = keyList.map((k) => k.key).join(",");
    const key = `${streamText}|${phaseText}|${keysText}|${e.file}|${e.fnLabel}`;
    emissions.push({
      key,
      stream,
      streamOpaque: e.stream.opaque ? { pattern: e.stream.pattern, reason: e.stream.reason, origin: e.stream.at, literals: e.stream.literals } : null,
      streamSource: e.stream.opaque ? "opaque" : e.stream.src,
      phase,
      phaseAbsent: !!e.phase.absent,
      phaseOpaque: e.phase.opaque || e.phase.pattern !== undefined ? { pattern: e.phase.pattern ?? null, reason: e.phase.reason, origin: e.phase.at ?? null, literals: e.phase.literals ?? null } : null,
      phaseSource: e.phase.absent ? null : e.phase.opaque ? "opaque" : e.phase.src ?? "syntax",
      keys: keyList,
      dataAbsent: !!e.dataAbsent,
      dataMaybeAbsent: !!e.dataMaybeAbsent,
      open: e.open ?? null,
      dataOpaque: e.opaques.map((o) => ({ reason: o.reason, origin: o.at ?? null })),
      file: e.file,
      line: lineOf(e.site),
      function: e.fnLabel,
      emitter: e.emitter,
      chain: e.chain,
      how: e.how,
      area: areaOf(e.file),
    });
  }

  trace(`emissions: ${emissions.length} raw rows`);
  const busExportNames = topFns
    .filter((f) => (f.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && [...items.values()].some((it) => it.decls.has(f)))
    .map((f) => f.name.text)
    .sort();
  // ---- 5. completeness ------------------------------------------------------------------
  // Every identifier spelled like a family member, across the analysed sources: matched
  // to a member (and classified), or bound to some other declaration (a homonym).
  const familyNames = new Set();
  for (const it of items.values()) for (const n of it.names) familyNames.add(n);
  const byName = {};
  const homonyms = [];
  const unaccountedRefs = [];
  let totalIds = 0;
  let matchedCount = 0;
  const classCounts = {};
  // Every declaration of every member: an UNMATCHED identifier that binds to one of these
  // is a reference the discovery saw no class for — the count that must be zero. (An
  // unmatched identifier binding elsewhere is a homonym: same spelling, other thing.)
  const familyDecls = new Set();
  for (const it of items.values()) for (const d of it.decls) familyDecls.add(d);
  for (const name of [...familyNames].sort()) {
    const entry = { identifiers: 0, matched: 0, homonym: 0, classes: {} };
    for (const sf of filesMentioning(name)) {
      for (const id of identifiersOf(sf).get(name) ?? []) {
        entry.identifiers += 1;
        totalIds += 1;
        const m = matched.get(id);
        if (m) {
          entry.matched += 1;
          matchedCount += 1;
          entry.classes[m.cls] = (entry.classes[m.cls] ?? 0) + 1;
          classCounts[m.cls] = (classCounts[m.cls] ?? 0) + 1;
        } else {
          const sym = isImportExportName(id) ? resolveSym(id) : valueSymOf(id);
          const ds = declsOf(sym);
          if (ds.some((d) => familyDecls.has(d)) && !(isDeclarationName(id) && familyDecls.has(id.parent))) {
            entry.unaccounted = (entry.unaccounted ?? 0) + 1;
            unaccountedRefs.push({ name, at: locOf(id) });
            continue;
          }
          entry.homonym += 1;
          const d = ds[0];
          homonyms.push({ name, at: locOf(id), boundTo: d ? (inAnalysis(d) || !d.getSourceFile().isDeclarationFile ? locOf(d) : `<lib:${path.basename(d.getSourceFile().fileName)}>`) : "<unresolved>" });
        }
      }
    }
    byName[name] = entry;
  }
  const unresolvedHomonyms = homonyms.filter((h) => h.boundTo === "<unresolved>");

  // References inside EXCLUDED test files — informational, by name, parse-only.
  const excludedRefs = {};
  for (const [rel, rule] of [...excluded.entries()].sort()) {
    const text = textOf(rel);
    let hit = false;
    for (const name of familyNames) if (text.includes(name)) hit = true;
    if (!hit) continue;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    let count = 0;
    const visit = (n) => {
      if (ts.isIdentifier(n) && familyNames.has(n.text)) count += 1;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (count > 0) excludedRefs[rel] = { rule, identifiers: count };
  }

  trace(`completeness: ${totalIds} identifiers`);
  // ---- 6. transformations between the emitter and the socket ---------------------------
  //
  // Two places rewrite an event after it is emitted: the bus itself (the dispatcher's
  // enrichment, ROOT_SOURCE — it adds `completionSource` and `startedAt` to lifecycle
  // data) and the gateway (src/gateway — it adds the accumulated `text` to assistant
  // deltas, strips tool results for node subscribers, and FABRICATES frames of its own).
  // Found by shape, anchored on types: an object rebuilt from an agent event's `data`.
  function deriveTransformations() {
    const fabricated = [];
    const relays = [];
    const unresolved = [];
    const rewrites = [];
    const removals = [];
    const senderRows = { fabricated, unresolved };
    for (const sf of sourceFiles) {
      const rel = relOfFile(sf);
      const scope = rel === ROOT_SOURCE ? "bus" : rel.startsWith(GATEWAY_DIR) ? "gateway" : null;
      if (!scope) continue;
      const row = (n, extra) => ({ scope, file: rel, line: lineOf(n), function: labelOf(enclosingFunction(n)), guard: guardOf(n), ...extra });
      const visit = (n) => {
        if (scope === "gateway" && (ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments) {
          n.arguments.forEach((a, i) => {
            const u = unwrapExpr(a);
            if (!u || !ts.isStringLiteral(u) || u.text !== "agent") return;
            // The event-name position of a sender: the callee's parameter at this index
            // is named `event` (GatewayBroadcastFn, GatewayBroadcastToConnIdsFn, the
            // node sender and the live-payload helper all spell it so).
            let params;
            try {
              params = checker.getResolvedSignature(n)?.parameters;
            } catch {
              params = undefined;
            }
            if (params?.[i]?.name !== "event") return;
            // The payload is the parameter the sender NAMES `payload` — not the next
            // argument: `sendLivePayload(event, sessionKey, payload)` puts a session key
            // there, which made its payload invisible.
            const named = params.findIndex((p) => p.name === "payload");
            const payloadIndex = named >= 0 ? named : i + 1;
            const payload = n.arguments[payloadIndex];
            const site = { file: rel, line: lineOf(n), function: labelOf(enclosingFunction(n)), sender: unwrapExpr(n.expression).getText().replace(/\s+/g, "") };
            const text = payload ? payload.getText().replace(/\s+/g, " ").slice(0, 80) : null;
            if (!payload) {
              unresolved.push({ ...site, payload: null, via: [], reason: `no argument at the sender's payload position (#${payloadIndex})` });
              return;
            }
            const origins = [];
            // One evaluation budget per sender site, as per emission site.
            budget.steps = 0;
            budget.exhausted = false;
            classifySenderPayload(ev(payload, ROOT_CTX), { site, at: site, text, via: [], depth: 0, visited: new Set(), origins, rows: senderRows });
            if (origins.length > 0) relays.push({ ...site, payload: text, origins: dedupeRows(origins).sort((x, y) => cmp(JSON.stringify(x), JSON.stringify(y))) });
          });
        }
        // `data: { ...e.data, k }` — keys added to a copy of an event's data.
        if (ts.isPropertyAssignment(n) && n.name.getText() === "data" && ts.isObjectLiteralExpression(unwrapExpr(n.initializer))) {
          const added = addedKeys(unwrapExpr(n.initializer), (x) => isAgentEventDataExpr(x) || isDataCopy(x));
          if (added) rewrites.push(row(n, { added, how: "data property" }));
        }
        // `data = { ...data, k }` where `data` holds an event's data.
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrapExpr(n.left)) && ts.isObjectLiteralExpression(unwrapExpr(n.right))) {
          const target = unwrapExpr(n.left);
          if (isDataCopy(target)) {
            const added = addedKeys(unwrapExpr(n.right), (x) => isDataCopy(x) || isAgentEventDataExpr(x));
            if (added) rewrites.push(row(n, { added, how: "reassignment" }));
          }
        }
        // `d.k = v` where `d` is a copy of an event's data.
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(unwrapExpr(n.left))) {
          const target = unwrapExpr(n.left);
          if (ts.isIdentifier(target.expression) && isDataCopy(target.expression, { copiesOnly: true })) {
            rewrites.push(row(n, { added: [target.name.text], how: "property write" }));
          }
        }
        // `delete d.k` where `d` is a copy of an event's data.
        if (ts.isDeleteExpression(n)) {
          const target = unwrapExpr(n.expression);
          if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && isDataCopy(target.expression, { copiesOnly: true })) {
            removals.push(row(n, { removed: target.name.text, how: "delete" }));
          }
        }
        // `const { k: _k, ...data } = payload.data` — a destructuring that drops keys.
        if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isAgentEventDataExpr(n.initializer)) {
          if (n.name.elements.some((e) => e.dotDotDotToken)) {
            for (const e of n.name.elements) {
              if (e.dotDotDotToken) continue;
              removals.push(row(n, { removed: (e.propertyName ?? e.name).getText(), how: "rest destructuring" }));
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    const sortRows = (rows) => dedupeRows(rows).sort((a, b) => cmp(`${a.file}:${String(a.line).padStart(6, "0")}:${JSON.stringify(a)}`, `${b.file}:${String(b.line).padStart(6, "0")}:${JSON.stringify(b)}`));
    return { fabricated: sortRows(fabricated), relays: sortRows(relays), unresolved: sortRows(unresolved), dataRewrites: sortRows(rewrites), dataRemovals: sortRows(removals) };
  }

  // ---- what a gateway sender puts on the `agent` channel --------------------------------
  //
  // Classified on the EVALUATED payload, whatever its syntax: a literal passed through a
  // binding, a helper's parameter or a conditional is the same frame as one written inline
  // (the review's `const extra = {…}; broadcast("agent", extra)` was a relay before). The
  // stream decides, read the way an object spread reads it — the LAST entry that can set
  // it wins, and whether a spread can set it is asked of its declared type first:
  //   - a literal                → a frame the gateway FABRICATES (`fabricated`, with its keys);
  //   - the `stream` of a value whose declared type is an agent event, passed on unchanged:
  //       · a parameter          → the helper's CALLERS are classified the same way (a literal
  //                                one passes in is fabricated); where the helper escapes
  //                                (passed as a value, exported, unnamed) the parameter is an
  //                                ENTRY of the relay, listed as its origin;
  //       · any other value      → a TYPED origin of the relay (read from state, returned by
  //                                a call nobody can inline): listed, since nothing proves it
  //                                came from the bus;
  //   - anything else (a computed or absent stream, an untyped payload, a bound reached)
  //                              → `unresolved`, which the vendoring refuses.
  const MAX_SENDER_CALLER_DEPTH = 4;
  const viaOf = (at) => `${at.file}:${at.line} \`${at.function}\``;
  function classifySenderPayload(av, c) {
    const variants = eventVariants(av).filter((v) => v.k !== "absent");
    if (variants.length === 0) {
      c.rows.unresolved.push({ ...c.site, ...locFields(c.at), payload: c.text, via: c.via.map(viaOf), reason: "the payload evaluates to nothing on every path" });
      return;
    }
    for (const v of variants) {
      const leaves = streamLeaves(v, 0, false);
      if (leaves.length === 0) leaves.push({ kind: "unresolved", reason: "a frame that sets no stream" });
      for (const leaf of leaves) {
        if (leaf.kind === "literal") pushFabricated(v, leaf.value, c);
        else if (leaf.kind === "parameter") followParameter(leaf.hole, leaf.type, c);
        else if (leaf.kind === "typed") c.origins.push({ kind: "typed", type: leaf.type, at: leaf.at ?? null, via: c.via.map(viaOf) });
        else c.rows.unresolved.push({ ...c.site, ...locFields(c.at), payload: c.text, via: c.via.map(viaOf), reason: leaf.reason });
      }
    }
  }
  const locFields = (at) => ({ file: at.file, line: at.line, function: at.function });
  function pushFabricated(v, stream, c) {
    for (const d of dataVariants(getProp(v, "data"))) {
      const { keys, opaques } = keysOf(d);
      const phases = keys.has("phase") ? scalarValues(getProp(d, "phase")) : [{ value: null, absent: true }];
      for (const ph of phases) {
        c.rows.fabricated.push({
          stream,
          phase: ph.absent ? null : ph.value ?? null,
          phaseAbsent: !!ph.absent,
          keys: [...keys.keys()].sort(),
          dataOpaque: opaques.map((o) => ({ reason: o.reason, origin: o.at ?? null })),
          ...locFields(c.at),
          sender: c.site.sender,
          ...(c.via.length > 0 ? { via: c.via.map(viaOf) } : {}),
        });
      }
    }
  }
  /** Is `t` (every alternative of it) an agent event — a type with `stream` and `data`? */
  const isAgentEventType = (t0) => {
    if (!t0) return false;
    let t;
    try {
      t = checker.getNonNullableType(t0);
    } catch {
      return false;
    }
    const members = t.isUnion() ? t.types : [t];
    return members.length > 0 && members.every((m) => !!checker.getPropertyOfType(m, "stream") && !!checker.getPropertyOfType(m, "data"));
  };
  /** The declared type at a property path (`.k`, `[]` for an element) below `t0`. */
  const typeAtPath = (t0, keys) => {
    let t = t0;
    for (const k of keys) {
      if (!t) return undefined;
      if (k === "...") continue;
      try {
        t = checker.getNonNullableType(t);
        if (k === "[]") {
          t = checker.getIndexTypeOfType(t, ts.IndexKind.Number) ?? undefined;
          continue;
        }
        const p = checker.getPropertyOfType(t, k);
        if (!p) return undefined;
        const d = p.valueDeclaration ?? p.declarations?.[0];
        t = d ? checker.getTypeOfSymbolAtLocation(p, d) : checker.getTypeOfSymbol(p);
      } catch {
        return undefined;
      }
    }
    return t;
  };
  /** Can a spread entry set `key`? "no" / "maybe" / "always" — from the declared type of
   *  the spread expression when there is one, else from its evaluated value. */
  function spreadSets(e, key) {
    if (e.node) {
      let t;
      try {
        t = checker.getTypeAtLocation(e.node);
      } catch {
        t = undefined;
      }
      if (t && !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
        const members = t.isUnion() ? t.types : [t];
        let some = false;
        let all = true;
        for (const m of members) {
          let has = false;
          let required = false;
          try {
            const p = checker.getPropertyOfType(m, key);
            if (p) {
              has = true;
              required = (p.flags & ts.SymbolFlags.Optional) === 0;
            } else if (checker.getIndexInfosOfType(m).some((x) => x.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral))) {
              has = true;
            }
          } catch {
            has = true;
          }
          if (has) some = true;
          if (!(has && required)) all = false;
        }
        return !some ? "no" : all ? "always" : "maybe";
      }
    }
    const sub = getProp(e.v, key);
    if (sub.k === "absent") return "no";
    return sub.k === "union" && sub.opts.some((o) => o.k === "absent") ? "maybe" : "always";
  }
  /** Where the `stream` of one event variant comes from: literal, parameter, typed, or
   *  unresolved leaves (an object can mix them across its alternatives). Empty when
   *  nothing sets it — for a SPREAD (`nested`) that means "falls through to the entries
   *  before it", and only the whole frame is refused for it (classifySenderPayload). */
  function streamLeaves(av, depth, nested) {
    if (depth > 16) return [{ kind: "unresolved", reason: "stream provenance nested beyond 16 levels (evaluator bound)" }];
    switch (av.k) {
      case "absent":
        return [];
      case "union":
        return av.opts.flatMap((o) => streamLeaves(o, depth + 1, nested));
      case "guard":
        return [...streamLeaves(av.t, depth + 1, nested), ...streamLeaves(av.f, depth + 1, nested)];
      case "obj": {
        const out = [];
        for (let i = av.entries.length - 1; i >= 0; i -= 1) {
          const e = av.entries[i];
          if (e.t === "prop") {
            if (e.key !== "stream") continue;
            out.push(...streamValueLeaves(propVal(e), depth + 1));
            if (!e.opt) return out;
          } else if (e.t === "keyopaque") {
            out.push({ kind: "unresolved", reason: `a computed key (${e.text}) may set the stream` });
            return out;
          } else if (e.t === "spread") {
            const sets = spreadSets(e, "stream");
            if (sets === "no") continue;
            const sub = streamLeaves(e.v, depth + 1, true);
            out.push(...sub);
            if (sets === "always" && sub.length > 0) return out;
          }
        }
        return out;
      }
      case "hole": {
        if (av.rest || av.restIndex !== undefined) return [{ kind: "unresolved", reason: `${describe(av)}: a rest parameter` }];
        let t;
        try {
          t = typeAtPath(checker.getTypeAtLocation(av.param), av.path);
        } catch {
          t = undefined;
        }
        if (isAgentEventType(t)) return [{ kind: "parameter", hole: av, type: typeStr(t) }];
        return [{ kind: "unresolved", reason: `${describe(av)}, whose declared type ${t ? typeStr(t) : "is unknown"} is not an agent event` }];
      }
      case "tobj": {
        const st = scalarValues(tobjProp(av, "stream")).filter((s) => !s.absent);
        if (st.length > 0 && st.every((s) => typeof s.value === "string")) return st.map((s) => ({ kind: "literal", value: s.value }));
        if (isAgentEventType(av.type)) return [{ kind: "typed", type: typeStr(av.type), at: av.at }];
        return [{ kind: "unresolved", reason: nested ? `a spread of declared type ${typeStr(av.type)} may set the stream` : `a value of declared type ${typeStr(av.type)}, not an agent event` }];
      }
      case "call": {
        let t;
        try {
          t = av.node ? checker.getTypeAtLocation(av.node) : undefined;
        } catch {
          t = undefined;
        }
        if (isAgentEventType(t)) return [{ kind: "typed", type: typeStr(t), at: av.at }];
        return [{ kind: "unresolved", reason: describe(av) }];
      }
      default:
        return [{ kind: "unresolved", reason: describe(av) }];
    }
  }
  /** An explicit `stream:` value: a literal, or an agent event's own stream re-stated. */
  function streamValueLeaves(v, depth) {
    const out = [];
    const visit = (x) => {
      switch (x.k) {
        case "union":
          for (const o of x.opts) visit(o);
          return;
        case "guard":
          visit(x.t);
          visit(x.f);
          return;
        case "lit":
          if (typeof x.v === "string") out.push({ kind: "literal", value: x.v });
          else out.push({ kind: "unresolved", reason: `a non-string stream ${JSON.stringify(x.v)}` });
          return;
        case "absent":
          return;
        case "hole":
          if (x.path[x.path.length - 1] === "stream") {
            out.push(...streamLeaves({ ...x, path: x.path.slice(0, -1) }, depth + 1, false));
            return;
          }
          out.push({ kind: "unresolved", reason: `a computed stream: ${describe(x)}` });
          return;
        default:
          out.push({ kind: "unresolved", reason: `a computed stream: ${describe(x)}` });
      }
    };
    visit(v);
    return out;
  }
  /** A parameter the stream is inherited from: classify what its callers pass, and name
   *  the helper as an ENTRY where callers can reach it unseen. */
  function followParameter(h, type, c) {
    const key = `${locOf(h.fn)}#${h.idx}#${h.path.join(".")}`;
    if (c.visited.has(key)) return;
    const visited = new Set([...c.visited, key]);
    const refs = functionReferences(h.fn);
    const param = `${h.param.name.getText().slice(0, 40)}${h.path.length ? `.${h.path.join(".")}` : ""}`;
    if (refs.escapes.length > 0 || refs.calls.length === 0) {
      c.origins.push({
        kind: "parameter",
        function: labelOf(h.fn),
        parameter: param,
        type,
        entries: refs.escapes.length > 0 ? refs.escapes : [{ at: locOf(h.fn), how: "no reference in the analysed sources" }],
        via: c.via.map(viaOf),
      });
    }
    if (refs.calls.length === 0) return;
    if (c.depth >= MAX_SENDER_CALLER_DEPTH) {
      c.rows.unresolved.push({ ...c.site, ...locFields(c.at), payload: c.text, via: c.via.map(viaOf), reason: `the callers of ${labelOf(h.fn)} lie beyond ${MAX_SENDER_CALLER_DEPTH} levels (classifier bound)` });
      return;
    }
    for (const call of refs.calls) {
      const at = { file: fileOf(call), line: lineOf(call), function: labelOf(enclosingFunction(call)) };
      const arg = call.arguments[h.idx];
      const argAV = arg ? ev(arg, ROOT_CTX) : h.param.initializer ? ev(h.param.initializer, ROOT_CTX) : ABSENT;
      classifySenderPayload(getPath(argAV, h.path), {
        ...c,
        at,
        text: arg ? arg.getText().replace(/\s+/g, " ").slice(0, 80) : null,
        via: [...c.via, c.at],
        depth: c.depth + 1,
        visited,
      });
    }
  }
  /** The direct calls of a function, and the references through which it ESCAPES. */
  const referencesCache = new Map();
  function functionReferences(fn) {
    if (referencesCache.has(fn)) return referencesCache.get(fn);
    let nameNode;
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) nameNode = fn.name;
    else {
      const p = skipOuter(fn).parent;
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer && unwrapExpr(p.initializer) === fn) nameNode = p.name;
    }
    let out;
    if (!nameNode || ts.isMethodDeclaration(fn)) {
      out = { calls: [], escapes: [{ at: locOf(fn), how: nameNode ? "a method: its callers go through its object" : "not bound to a name: its callers are whoever receives it" }] };
    } else {
      const sym = resolveSym(nameNode);
      const calls = [];
      const escapes = [];
      for (const sf of filesMentioning(nameNode.text)) {
        if (!sfByRel.has(relOfFile(sf))) continue;
        for (const id of identifiersOf(sf).get(nameNode.text) ?? []) {
          if (id === nameNode || valueSymOf(id) !== sym) continue;
          const p = id.parent;
          if (p && (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p))) continue;
          const outer = skipOuter(id);
          if (outer.parent && ts.isCallExpression(outer.parent) && outer.parent.expression === outer) {
            calls.push(outer.parent);
            continue;
          }
          escapes.push({ at: locOf(id), how: `referenced as a value (${ts.SyntaxKind[outer.parent?.kind] ?? "?"})` });
        }
      }
      const decl = ts.isFunctionDeclaration(fn) ? fn : nameNode.parent;
      const exported = !!decl && (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) !== 0;
      if (exported) escapes.push({ at: locOf(nameNode), how: "exported: callers outside the analysed sources are unseen" });
      calls.sort((a, b) => cmp(locOf(a), locOf(b)));
      out = { calls, escapes: dedupeRows(escapes).sort((a, b) => cmp(`${a.at}|${a.how}`, `${b.at}|${b.how}`)) };
    }
    referencesCache.set(fn, out);
    return out;
  }
  /** The keys an object literal adds on top of a spread `isBase` accepts; null when it
   *  spreads no such base or adds nothing. */
  function addedKeys(obj, isBase) {
    if (!obj.properties.some((p) => ts.isSpreadAssignment(p) && isBase(p.expression))) return null;
    const added = obj.properties
      .filter((p) => !ts.isSpreadAssignment(p))
      .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : p.name?.getText()))
      .filter(Boolean)
      .sort();
    return added.length > 0 ? added : null;
  }
  /** `x.data` where x's declared type has both `stream` and `data` (an agent event). */
  function isAgentEventDataExpr(expr) {
    const e = unwrapExpr(expr);
    if (!ts.isPropertyAccessExpression(e) || e.name.text !== "data") return false;
    let t;
    try {
      t = checker.getTypeAtLocation(e.expression);
    } catch {
      return false;
    }
    return !!checker.getPropertyOfType(t, "stream") && !!checker.getPropertyOfType(t, "data");
  }
  /** An identifier bound to an event's data or to a copy of it (`let data = event.data`,
   *  `const data = { ...event.data }`). `copiesOnly`: only a copy — writing to the event's
   *  own data object is a different (and unseen) mutation. */
  function isDataCopy(expr, { copiesOnly = false } = {}) {
    const e = unwrapExpr(expr);
    if (!ts.isIdentifier(e)) return false;
    const d = declsOf(valueSymOf(e))[0];
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return false;
    const init = unwrapExpr(d.initializer);
    if (ts.isObjectLiteralExpression(init)) return init.properties.some((p) => ts.isSpreadAssignment(p) && isAgentEventDataExpr(p.expression));
    return !copiesOnly && isAgentEventDataExpr(init);
  }
  /** The conditions guarding a node, up to its function: each `{ stream?, phase?, negated }`
   *  collects the literals an enclosing `if`/ternary compares `.stream`/`.phase` (or a
   *  binding named so) against; `negated` when the node sits in the ELSE branch. */
  function guardOf(node) {
    const conds = [];
    let child = node;
    let n = node.parent;
    while (n && !ts.isSourceFile(n)) {
      let cond;
      let negated = false;
      if (ts.isIfStatement(n) && child !== n.expression) {
        cond = n.expression;
        negated = child === n.elseStatement;
      } else if (ts.isConditionalExpression(n) && child !== n.condition) {
        cond = n.condition;
        negated = child === n.whenFalse;
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === n.right) {
        cond = n.left;
      }
      if (cond) {
        const g = { stream: [], phase: [] };
        const ng = { stream: [], phase: [] };
        const visit = (c) => {
          if (ts.isBinaryExpression(c) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(c.operatorToken.kind)) {
            const not = c.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || c.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
            const into = not ? ng : g;
            for (const [l0, r0] of [[c.left, c.right], [c.right, c.left]]) {
              const l = unwrapExpr(l0);
              const r = unwrapExpr(r0);
              if (!ts.isStringLiteral(r)) continue;
              const name = ts.isPropertyAccessExpression(l) ? l.name.text : ts.isIdentifier(l) ? l.text : undefined;
              if (name === "stream") into.stream.push(r.text);
              if (name === "phase" || name === "lifecyclePhase") into.phase.push(r.text);
            }
          }
          if (!isFunctionLike(c)) ts.forEachChild(c, visit);
        };
        visit(cond);
        const pack = (x, neg) => ({ ...(x.stream.length ? { stream: [...new Set(x.stream)].sort() } : {}), ...(x.phase.length ? { phase: [...new Set(x.phase)].sort() } : {}), negated: neg });
        // `a !== "x"` in a then-branch is a NEGATED condition; in an else-branch, a positive one.
        if (g.stream.length || g.phase.length) conds.push(pack(g, negated));
        if (ng.stream.length || ng.phase.length) conds.push(pack(ng, !negated));
      }
      if (isFunctionLike(n)) break;
      child = n;
      n = n.parent;
    }
    return conds;
  }

  // Called here, below every binding the sender classification reads (they are `const`).
  const transformations = deriveTransformations();

  // ---- 7. chat content parts (section 2) -------------------------------------------------
  //
  // The `type` values of `message.content[]` parts the display projection hands to clients.
  // Three answers, kept apart because they are not equally strong:
  //   fabricated — `{ type: "lit", … }` literals the projection BUILDS into a content array
  //                (a `content:` property, a `…content.push(…)`, a `…Content` binding);
  //   recognized — literals a content block's `type` is compared with (directly, by regex,
  //                by `switch`, or inside a helper predicate it is handed to), where "block"
  //                is tracked by data flow from a `content` array — never by spelling alone,
  //                so `senderIdentity.type === "profile"` is not a content type;
  //   pass-through — what the projection keeps without looking: stated, not enumerable.
  const chatContentParts = deriveChatContentParts();
  function deriveChatContentParts() {
    const modules = sourceFiles.filter((sf) => relOfFile(sf).startsWith(CHAT_PROJECTION_PREFIX));
    const inModules = (node) => modules.includes(node.getSourceFile());
    const fabricated = new Map();
    const recognized = new Map();
    const note = (map, type, at, how, fold = []) => {
      const list = map.get(type) ?? [];
      const f = fold.join("+");
      if (!list.some((x) => x.at === at && x.how === how && (x.fold ?? "") === f)) list.push({ at, how, ...(f ? { fold: f } : {}) });
      map.set(type, list);
    };
    // -- block variables: by data flow from a `content` array --------------------------------
    const isContentSource = (e) => {
      const u = unwrapExpr(e);
      if (!u) return false;
      if (ts.isPropertyAccessExpression(u)) return /content$/i.test(u.name.text);
      if (ts.isIdentifier(u)) return /content$/i.test(u.text);
      if (ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression) && ["filter", "slice", "concat", "flat"].includes(u.expression.name.text)) return isContentSource(u.expression.expression);
      return false;
    };
    const blockDecls = new Set();
    const isBlockExpr = (e) => {
      const u = unwrapExpr(e);
      if (!u) return false;
      if (ts.isIdentifier(u)) return declsOf(valueSymOf(u)).some((d) => blockDecls.has(d));
      // `readRecord(block)`, `{ ...(block as …) }`, `block as X`
      if (ts.isCallExpression(u) && u.arguments.length === 1) return isBlockExpr(u.arguments[0]);
      if (ts.isObjectLiteralExpression(u)) return u.properties.some((p) => ts.isSpreadAssignment(p) && isBlockExpr(p.expression));
      return false;
    };
    for (let round = 0; round < 6; round += 1) {
      const before = blockDecls.size;
      for (const sf of modules) {
        const visit = (n) => {
          // for (const block of message.content)
          if (ts.isForOfStatement(n) && isContentSource(n.expression) && ts.isVariableDeclarationList(n.initializer)) {
            for (const d of n.initializer.declarations) blockDecls.add(d);
          }
          // content.map((block) => …) / .filter / .some / …
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ARRAY_ITERATION_METHODS.has(n.expression.name.text) && isContentSource(n.expression.expression)) {
            const cb = unwrapExpr(n.arguments[0]);
            if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) blockDecls.add(cb.parameters[0]);
          }
          // const entry = block as … / { ...block } / readRecord(block)
          if (ts.isVariableDeclaration(n) && n.initializer && isBlockExpr(n.initializer)) blockDecls.add(n);
          // helper(block): the helper's parameter is a block too (within these modules)
          if (ts.isCallExpression(n)) {
            n.arguments.forEach((a, i) => {
              if (!isBlockExpr(a)) return;
              const d = calleeDeclaration(n);
              if (d && inModules(d) && d.parameters[i]) blockDecls.add(d.parameters[i]);
            });
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
      if (blockDecls.size === before) break;
    }
    const isBlockTypeRead = (e) => {
      const u = unwrapExpr(e);
      return !!u && ts.isPropertyAccessExpression(u) && u.name.text === "type" && isBlockExpr(u.expression);
    };
    /** Literals a helper compares its input with, following nested helpers — each with the
     *  NORMALIZATION the input went through before the comparison (`fold`): upstream
     *  compares tool block types as `type.trim().toLowerCase()`, so `toolResult` is the
     *  literal `toolresult` and a reader that only knew the literal spelling called it
     *  drift. `inFold` is what the callers applied before handing the value in; `input`
     *  is the index of the parameter that receives it. */
    const helperLiterals = (fn, depth, seen = new Set(), inFold = [], input = 0) => {
      const out = [];
      const seenKey = `${fn ? locOf(fn) : ""}|${inFold.join("+")}|${input}`;
      if (!fn?.body || depth > 3 || seen.has(seenKey)) return out;
      seen.add(seenKey);
      const fold = (e) => foldOf(e, fn, input);
      const visit = (n) => {
        // `typeof type === "string"` is a guard on the JavaScript type, not a content type.
        if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(n.operatorToken.kind) && !ts.isTypeOfExpression(unwrapExpr(n.left)) && !ts.isTypeOfExpression(unwrapExpr(n.right))) {
          for (const [side, other] of [[n.left, n.right], [n.right, n.left]]) {
            const u = unwrapExpr(side);
            if (!u || !ts.isStringLiteral(u)) continue;
            const f = fold(other);
            out.push({ value: u.text, at: locOf(u), fold: f === null ? [] : [...inFold, ...f] });
          }
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "test" && ts.isRegularExpressionLiteral(unwrapExpr(n.expression.expression))) {
          const f = n.arguments[0] ? fold(n.arguments[0]) : null;
          for (const alt of regexAlternatives(unwrapExpr(n.expression.expression).text) ?? []) out.push({ value: alt, at: locOf(n), fold: f === null ? [] : [...inFold, ...f] });
        }
        if (ts.isCallExpression(n)) {
          const d = calleeDeclaration(n);
          if (d && d !== fn) {
            // The nested helper's input: the first argument derived from ours.
            const k = n.arguments.findIndex((a) => fold(a) !== null);
            const f = k >= 0 ? fold(n.arguments[k]) : null;
            out.push(...helperLiterals(d, depth + 1, seen, f === null ? inFold : [...inFold, ...f], k >= 0 ? k : 0));
          }
        }
        if (!isFunctionLike(n) || n === fn) ts.forEachChild(n, visit);
      };
      visit(fn.body);
      return out;
    };
    const notes = [];
    for (const sf of modules) {
      const rel = relOfFile(sf);
      const visit = (n) => {
        if (ts.isObjectLiteralExpression(n)) {
          const tp = n.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "type");
          if (tp && ts.isPropertyAssignment(tp) && flowsIntoContent(n)) {
            for (const sv of scalarValues(ev(tp.initializer, ROOT_CTX))) {
              if (typeof sv.value === "string") note(fabricated, sv.value, `${rel}:${lineOf(n)}`, "built into a content array");
              else if (!sv.absent) notes.push({ at: `${rel}:${lineOf(n)}`, reason: `a content part's type is not a literal: ${sv.reason ?? "unresolved"}` });
            }
          }
        }
        if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
          for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
            const bu = unwrapExpr(b);
            if (isBlockTypeRead(a) && bu && ts.isStringLiteral(bu)) note(recognized, bu.text, `${rel}:${lineOf(n)}`, "compared");
          }
        }
        if (ts.isSwitchStatement(n) && isBlockTypeRead(n.expression)) {
          for (const c of n.caseBlock.clauses) {
            if (ts.isCaseClause(c) && ts.isStringLiteral(unwrapExpr(c.expression))) note(recognized, unwrapExpr(c.expression).text, `${rel}:${lineOf(c)}`, "switch");
          }
        }
        if (ts.isCallExpression(n) && n.arguments.some((a) => isBlockTypeRead(a))) {
          const callee = unwrapExpr(n.expression);
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === "test" && ts.isRegularExpressionLiteral(unwrapExpr(callee.expression))) {
            const alts = regexAlternatives(unwrapExpr(callee.expression).text);
            if (alts) for (const alt of alts) note(recognized, alt, `${rel}:${lineOf(n)}`, "regex");
            else notes.push({ at: `${rel}:${lineOf(n)}`, reason: `a block type is tested by a regex this module does not decompose: ${unwrapExpr(callee.expression).text}` });
          } else {
            const d = calleeDeclaration(n);
            if (d) {
              const lits = helperLiterals(d, 0, new Set(), [], n.arguments.findIndex((a) => isBlockTypeRead(a)));
              for (const l of lits) note(recognized, l.value, `${rel}:${lineOf(n)}`, `helper ${labelOf(d)} (${l.at})`, l.fold);
              if (lits.length === 0) notes.push({ at: `${rel}:${lineOf(n)}`, reason: `a block type is handed to ${labelOf(d)}, which compares it with no literal` });
            } else notes.push({ at: `${rel}:${lineOf(n)}`, reason: `a block type is handed to ${callee.getText().slice(0, 60)}, which does not resolve` });
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    const toList = (map) => [...map.entries()].sort((a, b) => cmp(a[0], b[0])).map(([type, sites]) => ({ type, sites: sites.sort((x, y) => cmp(`${x.at}|${x.how}|${x.fold ?? ""}`, `${y.at}|${y.how}|${y.fold ?? ""}`)) }));
    return {
      modules: modules.map((sf) => relOfFile(sf)),
      fabricated: toList(fabricated),
      recognized: toList(recognized),
      passThrough: "content parts of any other type pass through unchanged when the projection does not rewrite them; that set is the transcript's, not enumerable here",
      notes: dedupeRows(notes).sort((a, b) => cmp(a.at, b.at)),
    };
  }
  /** The normalizations (`trim`, `lowercase`) a value went through from parameter #`input`
   *  of `fn`, in order; null when it is not provably derived from that parameter. Followed
   *  through `const` bindings, string methods, a ternary whose other branch is a literal,
   *  and a call whose returns all normalize the argument the same way. */
  function foldOf(expr, fn, input, depth = 0) {
    if (!expr || depth > 8) return null;
    const u = unwrapExpr(expr);
    if (!u) return null;
    if (ts.isIdentifier(u)) {
      const d = declsOf(valueSymOf(u))[0];
      if (!d) return null;
      if (ts.isParameter(d)) return d === fn.parameters[input] && ts.isIdentifier(d.name) ? [] : null;
      if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer && enclosingFunction(d) === fn && (d.parent.flags & ts.NodeFlags.Const) !== 0) {
        return foldOf(d.initializer, fn, input, depth + 1);
      }
      return null;
    }
    if (ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression) && u.arguments.length === 0) {
      const m = u.expression.name.text;
      const step = m === "trim" ? "trim" : m === "toLowerCase" || m === "toLocaleLowerCase" ? "lowercase" : undefined;
      if (step) {
        const r = foldOf(u.expression.expression, fn, input, depth + 1);
        return r === null ? null : [...r, step];
      }
    }
    if (ts.isCallExpression(u)) {
      const g = calleeDeclaration(u);
      if (!g || g === fn) return null;
      const k = u.arguments.findIndex((a) => foldOf(a, fn, input, depth + 1) !== null);
      if (k < 0) return null;
      const r = foldOf(u.arguments[k], fn, input, depth + 1);
      const rf = returnFold(g, k, depth + 1);
      return rf === null ? null : [...r, ...rf];
    }
    if (ts.isConditionalExpression(u)) {
      const branches = [u.whenTrue, u.whenFalse].filter((b) => !ts.isStringLiteralLike(unwrapExpr(b)));
      if (branches.length === 0) return null;
      const folds = branches.map((b) => foldOf(b, fn, input, depth + 1));
      if (folds.some((f) => f === null)) return null;
      return folds.every((f) => f.join("+") === folds[0].join("+")) ? folds[0] : null;
    }
    return null;
  }
  /** The normalization every return of `g` applies to its parameter #`k`; null otherwise. */
  function returnFold(g, k, depth) {
    if (!g.body) return null;
    const rets = [];
    if (!ts.isBlock(g.body)) rets.push(g.body);
    else {
      let bare = false;
      const walk = (n) => {
        if (n !== g && isFunctionLike(n)) return;
        if (ts.isReturnStatement(n)) {
          if (n.expression) rets.push(n.expression);
          else bare = true;
        }
        ts.forEachChild(n, walk);
      };
      walk(g.body);
      if (bare) return null;
    }
    const folds = rets.filter((e) => !ts.isStringLiteralLike(unwrapExpr(e))).map((e) => foldOf(e, g, k, depth));
    if (folds.length === 0 || folds.some((f) => f === null)) return null;
    return folds.every((f) => f.join("+") === folds[0].join("+")) ? folds[0] : null;
  }
  /** Does an object literal end up in a content array? */
  function flowsIntoContent(lit0) {
    let n = lit0;
    for (let guard = 0; guard < 12 && n.parent; guard += 1) {
      const p = n.parent;
      if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || isWrapperParen(p) || (ts.isConditionalExpression(p) && p.condition !== n)) {
        n = p;
        continue;
      }
      if (ts.isPropertyAssignment(p) && p.initializer === n) return /^content$/i.test(p.name.getText());
      if (ts.isVariableDeclaration(p) && p.initializer === n) return ts.isIdentifier(p.name) && /content$/i.test(p.name.text);
      if (ts.isCallExpression(p) && p.arguments.includes(n) && ts.isPropertyAccessExpression(p.expression) && ["push", "unshift"].includes(p.expression.name.text)) {
        const recv = unwrapExpr(p.expression.expression);
        const name = ts.isPropertyAccessExpression(recv) ? recv.name.text : ts.isIdentifier(recv) ? recv.text : "";
        return /content$/i.test(name);
      }
      return false;
    }
    return false;
  }
  /** `^(?:a|b|c)$` / `^a$` → the alternatives; anything else → null. */
  function regexAlternatives(re) {
    const m = /^\/\^(?:\(\?:)?([A-Za-z0-9_|-]+)\)?\$\/[a-z]*$/.exec(re);
    return m ? m[1].split("|") : null;
  }

  // ---- 8. open entries -------------------------------------------------------------------
  // A member external code can call (exported by the public surface, or a member of an
  // exported contract): its callers are NOT in the analysed sources, so what it can carry
  // is only what its own template fixes; the rest is the caller's.
  const openEntries = [];
  for (const it of items.values()) {
    if (it.openVia.length === 0) continue;
    const callerHole = (v) => holeFns(v).has(it.holeFn);
    const shapes = [];
    const seenShape = new Set();
    for (const v of eventVariants(it.template)) {
      const sv = getProp(v, "stream");
      const dv = getProp(v, "data");
      const streams = callerHole(sv)
        ? [{ caller: true, values: scalarValues(sv).filter((x) => x.value !== undefined && !x.absent).map((x) => x.value) }]
        : scalarValues(sv).filter((x) => !x.absent).map((x) => (x.opaque ? { opaque: true, reason: x.reason } : { value: x.value }));
      const keys = new Map();
      let dataFromCaller = false;
      for (const d of dataVariants(dv)) {
        if (d.k === "obj") {
          for (const e of d.entries) {
            if (e.t === "prop") keys.set(e.key, (keys.get(e.key) ?? true) && !e.opt && !propMayBeAbsent(e));
            else if (e.t === "spread" && callerHole(e.v)) dataFromCaller = true;
            else if (e.t === "spread") for (const k2 of keysOf(e.v).keys.keys()) keys.set(k2, false);
          }
        } else if (callerHole(d) || d.k === "hole") dataFromCaller = true;
      }
      const shape = {
        streams,
        keys: [...keys.entries()].map(([key, always]) => ({ key, optional: !always })).sort((a, b) => cmp(a.key, b.key)),
        dataFromCaller,
      };
      const sk = JSON.stringify(shape);
      if (seenShape.has(sk)) continue;
      seenShape.add(sk);
      shapes.push(shape);
    }
    openEntries.push({
      label: it.label,
      kind: it.kind,
      at: it.def ? locOf(it.def) : null,
      openVia: dedupe(it.openVia.map((o) => `${o.how} (${o.at})`)).sort(),
      chain: it.chain,
      shapes: shapes.sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b))),
    });
  }
  openEntries.sort((a, b) => cmp(`${a.at}|${a.label}`, `${b.at}|${b.label}`));

  // ---- 9. assemble ----------------------------------------------------------------------
  const family = [...items.values()]
    .map((it) => ({
      key: it.key,
      kind: it.kind,
      label: it.label,
      names: [...it.names].sort(),
      at: it.def ? locOf(it.def) : null,
      chain: it.chain,
      template: summarizeTemplate(it.template, it.holeFn),
      via: dedupe(it.via.map((v) => `${v.at} (${v.through})`)).sort(),
    }))
    .sort((a, b) => cmp(`${a.at}|${a.label}`, `${b.at}|${b.label}`));
  function summarizeTemplate(t, fn) {
    const seen = new Set();
    const out = [];
    for (const v of eventVariants(t)) {
      const row = { stream: describeShort(getProp(v, "stream"), fn), data: describeShort(getProp(v, "data"), fn) };
      const k = `${row.stream}\u0000${row.data}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
    return out.sort((a, b) => cmp(`${a.stream}|${a.data}`, `${b.stream}|${b.data}`));
  }
  function describeShort(v, fn) {
    switch (v.k) {
      case "lit":
        return JSON.stringify(v.v);
      case "absent":
        return "∅";
      case "hole":
        return `${v.fn === fn ? "arg" : `arg(${labelOf(v.fn)})`}${v.idx}${v.path.length ? `.${v.path.join(".")}` : ""}`;
      case "union":
        return v.opts.map((o) => describeShort(o, fn)).join(" | ");
      case "obj":
        return `{${v.entries.map((e) => (e.t === "prop" ? `${e.key}${e.opt ? "?" : ""}` : e.t === "spread" ? `...${describeShort(e.v, fn)}` : `[${e.text}]`)).join(", ")}}`;
      case "derived":
        return `${describeShort(v.from, fn)}.${v.via}()`;
      case "call":
        return `${describeShort(v.callee, fn)}(…)${(v.path ?? []).length ? `.${v.path.join(".")}` : ""}`;
      case "tobj":
        return `<${typeStr(v.type)}>`;
      case "tpl":
        return `\`${v.parts.map((p) => (typeof p === "string" ? p : `\${${describeShort(p, fn)}}`)).join("")}\``;
      case "opaque":
        return `<opaque: ${v.reason}>`;
      case "guard":
        return `(.${v.prop}===${JSON.stringify(v.lit)} ? ${describeShort(v.t, fn)} : ${describeShort(v.f, fn)})`;
      default:
        return `<${v.k}>`;
    }
  }

  emissions.sort((a, b) => cmp(`${a.key}|${String(a.line).padStart(6, "0")}`, `${b.key}|${String(b.line).padStart(6, "0")}`));
  // Same key at several lines (one function emitting the same shape twice): one row, lines kept.
  const merged = [];
  for (const e of emissions) {
    const last = merged[merged.length - 1];
    if (last && last.key === e.key) {
      if (!last.lines.includes(e.line)) last.lines.push(e.line);
      last.dataMaybeAbsent ||= e.dataMaybeAbsent;
      for (const o of e.dataOpaque) if (!last.dataOpaque.some((x) => x.reason === o.reason && x.origin === o.origin)) last.dataOpaque.push(o);
      continue;
    }
    const { line, ...rest } = e;
    merged.push({ ...rest, lines: [line] });
  }
  const opaqueOut = dedupeRows(opaqueRows).sort((a, b) => cmp(`${a.file}:${String(a.line).padStart(6, "0")}:${a.what}:${a.reason}`, `${b.file}:${String(b.line).padStart(6, "0")}:${b.what}:${b.reason}`));
  const escapesOut = dedupeRows(opaqueEscapes).sort((a, b) => cmp(`${a.at}:${a.reason}`, `${b.at}:${b.reason}`));

  const excludedByRule = {};
  for (const rule of excluded.values()) excludedByRule[rule] = (excludedByRule[rule] ?? 0) + 1;
  const forwards = [...siteResults.entries()]
    .filter(([, r]) => r.kind === "forward")
    .map(([site, r]) => ({ at: locOf(site), function: labelOf(enclosingFunction(site)), through: r.item.label, wrapper: r.wrapper, followed: r.followed }))
    .sort((a, b) => cmp(`${a.at}|${a.through}`, `${b.at}|${b.through}`));

  const inventory = {
    schema: INVENTORY_SCHEMA,
    upstream: {
      version: input.meta?.version ?? null,
      commit: input.meta?.commit ?? null,
      tsconfigSha256: input.tsconfig ? sha256(JSON.stringify(input.tsconfig)) : null,
      typescript: ts.version,
    },
    scope: {
      dirs: SCAN_DIRS,
      sourceFiles: sourceRels.length,
      analysedFiles: included.length,
      nonTypeScriptFiles: nonTsRels.length,
      // JavaScript is outside the TypeScript program. It can only reach the bus through the
      // bus module's own exports, so those NAMES are searched in every .js/.mjs/.cjs file.
      busExportNames: busExportNames,
      nonTypeScriptFilesMentioningBusExports: nonTsRels.filter((rel) => busExportNames.some((n) => new RegExp(`\\b${n}\\b`).test(textOf(rel)))).sort(),
      testExclusion: {
        rules: TEST_FILE_RULES.map((r) => ({ id: r.id, description: r.description })),
        excludedFiles: excluded.size,
        byRule: sortObject(excludedByRule),
        reincludedByImportGuard: reincluded.sort((a, b) => cmp(a.file, b.file)),
        excludedFilesMentioningFamily: excludedRefs,
      },
      // Imports this program could not follow, by kind. A DATA target (`.json`) carries no
      // code; a package absent from the checkout cannot declare an emitter of this bus
      // (the bus is in-repo); a CODE target that does not resolve is what could hide one,
      // and is listed in full.
      unresolvedInRepoImports: unresolvedImports.length,
      unresolvedByKind: sortObject(unresolvedImports.reduce((acc, u) => {
        const kind = importKind(u);
        acc[kind] = (acc[kind] ?? 0) + 1;
        return acc;
      }, {})),
      unresolvedCodeImports: unresolvedImports.filter((u) => importKind(u) === "code").sort((a, b) => cmp(`${a.file}:${a.line}`, `${b.file}:${b.line}`)),
      unresolvedPackages: [...new Set(unresolvedImports.filter((u) => importKind(u) === "package").map((u) => u.specifier.split("/").slice(0, 2).join("/")))].sort(),
    },
    root: {
      source: ROOT_SOURCE,
      dispatcher: ROOT_DISPATCHER,
      dispatcherLine: lineOf(dispatcher),
      listenerIterator: ROOT_LISTENER_ITERATOR,
      otherChannels,
      declaredStreams,
    },
    family,
    forwards,
    emissions: merged,
    opaque: opaqueOut,
    escapes: escapesOut,
    openEntries,
    transformations,
    chatContentParts,
    completeness: {
      familyNames: familyNames.size,
      identifiers: totalIds,
      matched: matchedCount,
      homonyms: homonyms.length,
      unaccounted: unaccountedRefs.length,
      unaccountedReferences: unaccountedRefs.sort((a, b) => cmp(`${a.name}|${a.at}`, `${b.name}|${b.at}`)),
      byClass: sortObject(classCounts),
      byName: sortObject(byName),
      // Homonyms grouped by the declaration they bind to (an identifier spelled like a
      // member but bound elsewhere); unresolved ones by file — those are the identifiers
      // whose binding the checker could not establish (a receiver typed any, a module
      // outside the program), the only ones that COULD hide a reference.
      homonymDeclarations: groupRows(homonyms.filter((h) => h.boundTo !== "<unresolved>"), (h) => `${h.name}|${h.boundTo}`, (h) => ({ name: h.name, boundTo: h.boundTo })),
      unresolvedIdentifiers: groupRows(unresolvedHomonyms, (h) => `${h.name}|${h.at.replace(/:\d+$/, "")}`, (h) => ({ name: h.name, file: h.at.replace(/:\d+$/, "") })),
      unresolvedHomonyms: unresolvedHomonyms.length,
    },
  };
  inventory.summary = summarize(inventory);
  return inventory;
}

function importKind(u) {
  if (u.target && !/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(u.target)) return "data";
  if (!u.specifier.startsWith(".") && u.target === null) return "package";
  return "code";
}

function areaOf(file) {
  const parts = file.split("/");
  if (parts[0] === "extensions" || parts[0] === "packages") return `${parts[0]}/${parts[1]}`;
  return parts.slice(0, 2).join("/");
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function dedupe(list) {
  return [...new Set(list)];
}
function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = JSON.stringify(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
function groupRows(rows, keyOf, shapeOf) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const g = m.get(k) ?? { ...shapeOf(r), count: 0 };
    g.count += 1;
    m.set(k, g);
  }
  return [...m.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, g]) => g);
}
function sortObject(o) {
  return Object.fromEntries(Object.entries(o).sort((a, b) => cmp(a[0], b[0])));
}
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** stream → phase → keys, with site counts — the readable core of the inventory. */
export function summarize(inv) {
  const streams = {};
  for (const e of inv.emissions) {
    const s = e.stream ?? `<opaque${e.streamOpaque?.pattern ? `:${e.streamOpaque.pattern}` : ""}>`;
    const p = e.phaseAbsent ? "-" : e.phase === null ? "<opaque>" : String(e.phase);
    const st = (streams[s] ??= { sites: 0, phases: {} });
    st.sites += e.lines.length;
    const ph = (st.phases[p] ??= { sites: 0, keys: {}, opaqueData: 0 });
    ph.sites += e.lines.length;
    for (const k of e.keys) {
      const prev = ph.keys[k.key];
      ph.keys[k.key] = prev === undefined ? (k.optional ? "optional" : "always") : prev === "always" && !k.optional ? "always" : "optional";
    }
    if (e.dataOpaque.length > 0) ph.opaqueData += 1;
  }
  const out = {};
  for (const s of Object.keys(streams).sort()) {
    const st = streams[s];
    const phases = {};
    for (const p of Object.keys(st.phases).sort()) {
      const ph = st.phases[p];
      phases[p] = { sites: ph.sites, keys: Object.fromEntries(Object.entries(ph.keys).sort((a, b) => cmp(a[0], b[0]))), opaqueData: ph.opaqueData };
    }
    out[s] = { sites: st.sites, phases };
  }
  return out;
}

/** Serialize deterministically (key order as built; arrays already sorted). */
export function serializeInventory(inv) {
  return `${JSON.stringify(inv, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------
// CLI: node scripts/lib/derive-agent-emissions.mjs --root <dir> --tsconfig <file>
//        [--version <v>] [--commit <sha>] [--out <file>]
// The real derivation holds the whole upstream program (~20k files) in memory; the CLI
// re-executes itself with a larger heap when the default is too small.
// ---------------------------------------------------------------------------------------
const HEAP_MB = 12288;
function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  if (!args.root || !args.tsconfig) {
    process.stderr.write("usage: derive-agent-emissions.mjs --root <upstream dir> --tsconfig <upstream tsconfig.json> [--version v] [--commit sha] [--out file]\n");
    process.exit(2);
  }
  const limitMb = v8.getHeapStatistics().heap_size_limit / 1048576;
  if (limitMb < HEAP_MB * 0.9 && !process.env.DERIVE_AGENT_EMISSIONS_CHILD) {
    const r = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, fileURLToPath(import.meta.url), ...argv], {
      stdio: "inherit",
      env: { ...process.env, DERIVE_AGENT_EMISSIONS_CHILD: "1" },
    });
    process.exit(r.status ?? 1);
  }
  const raw = ts.parseConfigFileTextToJson(args.tsconfig, fs.readFileSync(args.tsconfig, "utf8"));
  if (raw.error) throw new Error(`cannot parse ${args.tsconfig}: ${ts.flattenDiagnosticMessageText(raw.error.messageText, " ")}`);
  const inv = deriveAgentEmissions({
    root: args.root,
    tsconfig: raw.config,
    meta: { version: args.version ?? null, commit: args.commit ?? null },
  });
  const text = serializeInventory(inv);
  if (args.out) fs.writeFileSync(args.out, text);
  else process.stdout.write(text);
  const c = inv.completeness;
  process.stderr.write(
    `emissions: ${inv.emissions.length} rows, ${Object.keys(inv.summary).length} streams; family: ${inv.family.length}; ` +
      `opaque: ${inv.opaque.length}; escapes: ${inv.escapes.length}; identifiers ${c.identifiers} = matched ${c.matched} + homonyms ${c.homonyms} (unaccounted ${c.unaccounted}); ` +
      `gateway senders: fabricated ${inv.transformations.fabricated.length}, relays ${inv.transformations.relays.length}, unresolved ${inv.transformations.unresolved.length}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
