// Protocol-coverage RATCHET (Inc 1 of docs/design/protocol-contract.md).
//
// The vendored files under protocol/openclaw/<version>/ are the OFFICIAL
// gateway wire contract (TypeBox schemas, verbatim from the openclaw repo at
// the bridge's maxValidated tag). TypeBox schemas ARE JSON Schema objects, so
// this test walks them directly and enforces a BIJECTION with the coverage
// manifest (protocol/openclaw/coverage.json):
//
//   1. every exported *Schema must be classified (whole-schema or per-field);
//   2. every top-level field of a per-field schema must be classified
//      (handled: `by` required / ignored: `why` required / gap: `note` required);
//   3. no orphan manifest entries (a field that left the schema must leave
//      the manifest — stale claims are as bad as missing ones);
//   4. the manifest's version must match the vendored directory.
//
// THE POINT: bumping the validated gateway version = vendoring its schema =
// this test enumerates every NEW schema/field and stays RED until a human
// classifies it. A protocol evolution can never land silently again — the
// diff between two vendored versions IS the migration checklist.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// EVERY vendored version, not one hardcoded (W10 / G1). The ratchet's whole value is
// that bumping the validated range = vendoring the new tag = this test enumerating
// what changed; pinned to a single directory, it went green on a version nobody had
// examined while `maxValidated` had already moved on. `import.meta.glob` keeps the
// paths statically analyzable (a computed dynamic import would not resolve).
// `import.meta.glob` is Vite's, so it is not on the Node `ImportMeta` type the
// bridge's tsconfig uses. Narrowed here rather than adding vite's client types to the
// whole package for one test.
const VENDORED_MODULES = (
  import.meta as unknown as {
    glob: (p: string) => Record<string, () => Promise<Record<string, unknown>>>;
  }
).glob("../protocol/openclaw/*/*.ts");

/** Vendored version directories, in ascending order. */
function vendoredVersions(): string[] {
  return readdirSync(new URL("../protocol/openclaw", import.meta.url), {
    withFileTypes: true,
  })
    .filter((e) => e.isDirectory() && e.name !== "coverage")
    .map((e) => e.name)
    .sort();
}

interface FieldEntry {
  status: "handled" | "ignored" | "gap";
  by?: string;
  why?: string;
  note?: string;
}
interface SchemaEntry extends Partial<FieldEntry> {
  fields?: Record<string, FieldEntry>;
}
interface Manifest {
  version: string;
  schemas: Record<string, SchemaEntry>;
}

function manifestFor(version: string): Manifest {
  return JSON.parse(
    readFileSync(
      new URL(`../protocol/openclaw/coverage/${version}.json`, import.meta.url),
      "utf-8",
    ),
  ) as Manifest;
}

/** EVERY `.ts` file of a vendored version — the list is derived, not fixed.
 *
 *  It used to be a hardcoded trio, which meant vendoring a new module (say
 *  `sessions.ts`) made `rpc-scope.test.ts` report its RPCs as COVERED while this
 *  ratchet never walked it: its schemas and fields would need no classification at
 *  all, and every test would pass. Modules that export no `*Schema` (the shared
 *  contracts) contribute nothing and cost nothing. */
function walkedFiles(version: string): string[] {
  return readdirSync(
    new URL(`../protocol/openclaw/${version}/`, import.meta.url),
  ).filter((f) => f.endsWith(".ts"));
}

/** Every exported TypeBox schema of one version's vendored modules, keyed by its
 *  export name minus the `Schema` suffix (the manifest's key convention). */
async function exportedSchemas(
  version: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const file of walkedFiles(version)) {
    const key = `../protocol/openclaw/${version}/${file}`;
    const loader = VENDORED_MODULES[key];
    if (loader === undefined) {
      throw new Error(`vendored ${version} is missing ${file}`);
    }
    const mod = await loader();
    for (const [name, value] of Object.entries(mod)) {
      if (!name.endsWith("Schema")) continue;
      if (typeof value !== "object" || value === null) continue;
      out.set(name.replace(/Schema$/, ""), value as Record<string, unknown>);
    }
  }
  return out;
}

/** Top-level field names of a TypeBox Object schema (empty for unions etc. —
 *  those are classified whole-schema). */
function topLevelFields(schema: Record<string, unknown>): string[] {
  const props = schema.properties;
  if (typeof props !== "object" || props === null) return [];
  return Object.keys(props as Record<string, unknown>);
}

const VALID_STATUSES = new Set(["handled", "ignored", "gap"]);

function validEntry(entry: FieldEntry, where: string): string | null {
  // Runtime-validate the JSON (the TS cast checks nothing): a missing status or
  // a typo ("hanlded") must FAIL, not silently count as classified.
  if (!VALID_STATUSES.has(entry.status as string)) {
    return `${where}: invalid status ${JSON.stringify(entry.status)} (expected handled|ignored|gap)`;
  }
  if (entry.status === "handled" && !entry.by) {
    return `${where}: status "handled" requires \`by\` (where the bridge consumes/emits it)`;
  }
  if (entry.status === "ignored" && !entry.why) {
    return `${where}: status "ignored" requires \`why\` (the deliberate reason)`;
  }
  if (entry.status === "gap" && !entry.note) {
    return `${where}: status "gap" requires \`note\` (what is unsupported + impact)`;
  }
  return null;
}

for (const VENDORED_VERSION of vendoredVersions()) {
describe(`protocol coverage ratchet (openclaw @ ${VENDORED_VERSION})`, () => {
  const MANIFEST = manifestFor(VENDORED_VERSION);

  it("the manifest targets the vendored version", () => {
    expect(MANIFEST.version).toBe(VENDORED_VERSION);
  });

  it("the version is not VACUOUSLY vendored", async () => {
    // An empty directory with an empty matching manifest satisfies every other test
    // here, the bijection in compat.test.ts and the provenance integrity check — and
    // reports a version as examined whose contract was never enumerated (raised in
    // review). It is the exact failure this lot exists to prevent, one level up.
    const schemas = await exportedSchemas(VENDORED_VERSION);
    expect(
      schemas.size,
      `protocol/openclaw/${VENDORED_VERSION}/ exports no schemas — an empty ` +
        `directory claims an examination that never happened`,
    ).toBeGreaterThan(10);
    expect(Object.keys(MANIFEST.schemas).length).toBeGreaterThan(10);
  });

  it("EVERY exported schema is classified — a new schema in a version bump must be triaged", async () => {
    const schemas = await exportedSchemas(VENDORED_VERSION);
    const missing = [...schemas.keys()].filter((k) => !(k in MANIFEST.schemas));
    expect(missing, `unclassified schemas: ${missing.join(", ")}`).toEqual([]);
  });

  it("EVERY top-level field of a per-field schema is classified — a new field must be triaged", async () => {
    const schemas = await exportedSchemas(VENDORED_VERSION);
    const problems: string[] = [];
    for (const [name, entry] of Object.entries(MANIFEST.schemas)) {
      const schema = schemas.get(name);
      if (schema === undefined) continue; // orphan check below owns this
      if (entry.fields === undefined) {
        // Whole-schema classification: must itself be a valid entry.
        const err = validEntry(entry as FieldEntry, name);
        if (err) problems.push(err);
        continue;
      }
      const fields = topLevelFields(schema);
      for (const f of fields) {
        const fe = entry.fields[f];
        if (fe === undefined) {
          problems.push(`${name}.${f}: NEW protocol field — classify it (handled/ignored/gap)`);
          continue;
        }
        const err = validEntry(fe, `${name}.${f}`);
        if (err) problems.push(err);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("no ORPHAN manifest entries — a schema/field that left the protocol must leave the manifest", async () => {
    const schemas = await exportedSchemas(VENDORED_VERSION);
    const problems: string[] = [];
    for (const [name, entry] of Object.entries(MANIFEST.schemas)) {
      const schema = schemas.get(name);
      if (schema === undefined) {
        problems.push(`${name}: manifest entry with no vendored schema export`);
        continue;
      }
      if (entry.fields === undefined) continue;
      const fields = new Set(topLevelFields(schema));
      for (const f of Object.keys(entry.fields)) {
        if (!fields.has(f)) {
          problems.push(`${name}.${f}: manifest field absent from the vendored schema`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("the classified surface is real: spot-pin the fields this repo just made handled", () => {
    // Guards the manifest against wishful edits: these two were the audit's #1
    // gap and are now consumed end-to-end (normalizer -> errorCode + trace).
    const chatError = MANIFEST.schemas.ChatErrorEvent?.fields;
    expect(chatError?.errorKind?.status).toBe("handled");
    expect(chatError?.errorMessage?.status).toBe("handled");
    // replace is WIRED now (bare-deltaText replacement takes the replace path).
    expect(MANIFEST.schemas.ChatDeltaEvent?.fields?.replace?.status).toBe(
      "handled",
    );
    // chat.abort is WIRED now (the stop button kills the gateway run).
    expect(MANIFEST.schemas.ChatAbortParams?.fields?.sessionKey?.status).toBe(
      "handled",
    );
  });
});
}
