/// <reference types="vitest" />
//
// The coverage manifest must tell the TRUTH, not just have a shape (2026-07-31).
//
// THE DEFECT THIS GUARDS. `protocol-coverage.test.ts` validates that every entry has a
// status and a justification — and never touches the production code. So a declaration
// could silently go false in BOTH directions, and both happened in one week:
// `TaskSummary.progressSummary` stayed declared "gap — NOT read" after the bridge
// started projecting it to the activity indicator, and seven cron delivery fields
// stayed "ignored — configured on the gateway" after the delivery-verdict lots started
// consuming every one of them. An inventory that is false is worse than none.
//
// THE MECHANISM IS NOT NEW. `hermes-features-coverage.test.ts` already anchors every
// `handled` capability to `{file, token}` verified in the COMMENT-STRIPPED source; this
// generalizes it to the OpenClaw field manifest, and adds the opposite direction: a
// field declared NOT consumed must not be consumed — or must declare, explicitly, every
// reader the sweep finds (`knownReaders`: the honest spelling of "a ready reader exists
// and nothing feeds it", which is the real state of the SessionOperationEvent family).
//
// Scope is the TRUTH RATCHET (truth-ratchet.json), not the whole 596-entry manifest:
// truth is earned field by field as each frame is instructed, and the ratchet can only
// grow — its floor is frozen here so shrinking it is a review event, never a quiet edit.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { COMPAT_MANIFEST } from "../src/compat.js";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { stripComments } from "../scripts/lib/derive-event-catalogue.mjs";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { touchedNames } from "../scripts/lib/touched-names.mjs";
import { promisedVersion, vendoredVersions } from "./helpers/vendored.js";

interface FieldEntry {
  status: "handled" | "ignored" | "gap";
  by?: string;
  why?: string;
  note?: string;
  anchor?: { file: string; token: string };
  knownReaders?: { file: string; token: string; note: string }[];
  proof?: { kind: string; ref: string; note?: string };
  verifiedVersions?: string[];
  contrib?: string[];
}
interface Manifest {
  version: string;
  schemas: Record<string, { status?: string; fields?: Record<string, FieldEntry> }>;
}

const PROOF_KINDS = ["golden-corpus", "live-bench", "deterministic-test"] as const;

/** The ratchet's frozen floor. A copy, deliberately: the ratchet file alone could be
 *  shrunk in the same edit that removes a field's enforcement — the same reasoning as
 *  FROZEN_GRANDFATHER in bench-attestation.test.ts. Growing is free; removing a name
 *  means editing THIS list, which a reviewer sees. */
const FROZEN_TRUTH_FLOOR = [
  "ChatAbortParams.discardPendingInput",
  "SessionRow.visibility",
  "SessionRow.sharingRole",
  "SessionRow.permissionMode",
  "SessionRow.permissionModePending",
  "SessionRow.sessionRoot",
  "AgentSummary.defaultPermissionMode",
  "ChatSendParams.expectedPermissionMode",
  "SessionsPatchParams.permissionMode",
  "ChatAbortedEvent.errorMessage",
  "ChatStatusEvent.retry",
  "ChatSendParams.expectedSessionRoutingContract",
  "ChatAbortParams.preserveSideRuns",
  "SessionOperationEvent.operationId",
  "SessionOperationEvent.operation",
  "SessionOperationEvent.phase",
  "SessionOperationEvent.sessionKey",
  "SessionOperationEvent.agentId",
  "SessionOperationEvent.ts",
  "SessionOperationEvent.completed",
  "SessionOperationEvent.reason",
  "SessionsResetParams.reason",
  "CronJobState.consecutiveErrors",
  "CronRunLogEntry.usage",
  "TaskSummary.progressSummary",
  "TalkClientToolCallResult.idempotencyKey",
  "TalkClientCreateParams.sessionKey",
  "TalkClientCreateResult.expiresAt",
  "TalkClientCreateResult.offerHeaders",
  "CronJobState.lastDelivered",
  "CronJobState.lastDeliveryStatus",
  "CronJobState.lastDeliveryError",
  "CronJobState.lastRunAtMs",
  "CronRunLogEntry.delivered",
  "CronRunLogEntry.deliveryStatus",
  "CronRunLogEntry.deliveryError",
  "TaskSummary.startedAt",
  // The knowledge plugin's session actions and the agent-default config write (2026-09-27).
  "PluginsSessionActionParams.payload",
  "ConfigPatchParams.replacePaths",
  // The agent-database admission refusal's code, read from a refused request's details (2026-09-28).
  "AgentDatabaseAdmissionRefusal.code",
  // Inline widgets: the connect capability and the one widget-document RPC (2026-09-30).
  "ConnectParams.caps",
  "CanvasDocumentViewParams.docId",
  "CanvasDocumentViewResult.html",
  // The structured provider observation on a failed chat, read before the prose (2026-10-02).
  "ChatErrorEvent.errorDetail",
  // The transcript projection's reads and its input guard (redesign phase 2, 2026-10-04).
  "ChatHistoryParams.inputRunIds",
  "ChatHistoryParams.cursor",
  "ChatHistoryDeltaResult.deltaCursor",
  "ChatHistoryDeltaResult.pendingInputs",
  "ChatHistoryDeltaResult.inputReceipts",
  "ChatPendingInputsPage.queuedCount",
  // A delivery item's phase, `update` (a running tool's progress) included (2026-10-17).
  "AgentActivityItem.phase",
];

const ratchet = JSON.parse(
  readFileSync(new URL("../protocol/openclaw/truth-ratchet.json", import.meta.url), "utf-8"),
) as { fields: { path: string; scan: boolean }[] };

function manifestOf(version: string): Manifest {
  return JSON.parse(
    readFileSync(
      new URL(`../protocol/openclaw/coverage/${version}.json`, import.meta.url),
      "utf-8",
    ),
  ) as Manifest;
}

function entryOf(m: Manifest, path: string): FieldEntry | undefined {
  const [schema, field] = path.split(".");
  if (schema === undefined || field === undefined) return undefined;
  return m.schemas[schema]?.fields?.[field];
}

/** Comment-stripped source of a BRIDGE file (bridge-relative `src/…`). */
function strippedBridge(file: string): string | null {
  const at = new URL(`../${file}`, import.meta.url);
  if (!existsSync(at)) return null;
  return stripComments(readFileSync(at, "utf-8")) as string;
}

/** Comment-stripped source of a REPO-relative file (bridge/src/…, convex/…, src/…).
 *  `.tsx` is searched raw: the stripper parses TS, and a reader declaration must not
 *  fail on syntax it was never meant to read. */
function strippedRepo(file: string): string | null {
  const at = new URL(`../../${file}`, import.meta.url);
  if (!existsSync(at)) return null;
  const body = readFileSync(at, "utf-8");
  return file.endsWith(".tsx") ? body : (stripComments(body) as string);
}

/** Every bridge/src TS file, recursively — protocol-drift.ts excluded: its lists NAME
 *  fields as classification strings, which is not consumption. */
function bridgeSrcFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const dir = new URL(`../${rel}`, import.meta.url);
    for (const name of readdirSync(dir)) {
      const relChild = `${rel}/${name}`;
      const child = new URL(`../${relChild}`, import.meta.url);
      if (statSync(child).isDirectory()) walk(relChild);
      else if (name.endsWith(".ts") && name !== "protocol-drift.ts") out.push(relChild);
    }
  };
  walk("src");
  return out;
}

/** Does this source CONSUME the field? Dot access, object-literal key, bracket
 *  access, and shorthand destructuring — the shapes review found the first version
 *  missing two of. STATED LIMIT: textual, not AST; an access through a computed
 *  variable name escapes it, and that residue is what the anchor + per-hop tests
 *  cover on the handled side. */
function consumes(stripped: string, field: string): boolean {
  return (
    stripped.includes(`.${field}`) ||
    stripped.includes(`["${field}"]`) ||
    stripped.includes(`['${field}']`) ||
    new RegExp(`[{,(\\s]${field}\\s*:`).test(stripped) ||
    new RegExp(`[{,]\\s*${field}\\s*[,}]`).test(stripped)
  );
}

/** App-side sources that can touch provider-shaped payloads: convex/ and src/,
 *  tests and generated trees excluded. Review's point: `knownReaders` explicitly
 *  admits those locations, so a sweep that never looks there can be walked around
 *  by consuming one hop later. Raw content for .tsx (the stripper parses TS). */
function repoSideFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const dir = new URL(`../../${rel}`, import.meta.url);
    for (const name of readdirSync(dir)) {
      const relChild = `${rel}/${name}`;
      if (
        name === "_generated" ||
        name === "paraglide" ||
        name === "node_modules" ||
        name.includes(".test.") ||
        name.endsWith(".d.ts") ||
        // Names-as-data, not consumption: this fixture freezes a real get_compat
        // payload, gapList included, so every declared gap appears in it as a
        // STRING — the same nature as protocol-drift.ts's classification lists,
        // excluded for the same reason.
        name === "bridgeCapabilitiesFixture.ts"
      ) {
        continue;
      }
      const child = new URL(`../../${relChild}`, import.meta.url);
      if (statSync(child).isDirectory()) walk(relChild);
      else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(relChild);
    }
  };
  walk("convex");
  walk("src");
  return out;
}

describe("coverage-truth — the manifest may not lie about the code", () => {
  const versions = vendoredVersions();

  it("the meta-schema and this test agree on the enums (lockstep)", () => {
    // coverage.schema.json is the documented shape; this test is the enforcement.
    // Asserting the enums equal keeps the documentation from drifting into fiction.
    const meta = JSON.parse(
      readFileSync(new URL("../protocol/coverage.schema.json", import.meta.url), "utf-8"),
    ) as { $defs: { status: { enum: string[] }; proofKind: { enum: string[] } } };
    expect(meta.$defs.status.enum).toEqual(["handled", "ignored", "gap"]);
    expect(meta.$defs.proofKind.enum).toEqual([...PROOF_KINDS]);
  });

  it("the ratchet holds its frozen floor — it only grows", () => {
    const have = new Set(ratchet.fields.map((f) => f.path));
    const missing = FROZEN_TRUTH_FLOOR.filter((p) => !have.has(p));
    expect(missing, "removing a field from truth enforcement is a decision, not an edit").toEqual([]);
  });

  it("every ratcheted path exists in the LATEST vendored manifest (no typo enforces nothing)", () => {
    const latestName = versions[versions.length - 1];
    expect(latestName, "no vendored version at all").toBeDefined();
    const latest = manifestOf(latestName as string);
    // A path whose WHOLE schema left the latest contract is a retirement, not a typo:
    // 2026.9.7 removed the `tasks.*` RPCs and `TaskSummary` with them. It still has to
    // be a real path of an older vendored version, where V1/V2 keep enforcing it — a
    // typo exists in none. A field gone from a schema that still exists stays a failure.
    const retired = (p: string): boolean => {
      const [schema] = p.split(".");
      return (
        schema !== undefined &&
        latest.schemas[schema] === undefined &&
        versions.some((v) => entryOf(manifestOf(v), p) !== undefined)
      );
    };
    const missing = ratchet.fields
      .map((f) => f.path)
      .filter((p) => entryOf(latest, p) === undefined && !retired(p));
    expect(missing).toEqual([]);
  });

  it("V1 — a `handled` under the ratchet anchors real consumption and carries a proof", () => {
    const bad: string[] = [];
    for (const version of versions) {
      const m = manifestOf(version);
      for (const { path } of ratchet.fields) {
        const e = entryOf(m, path);
        if (e === undefined || e.status !== "handled") continue;
        const where = `${version} ${path}`;
        const a = e.anchor;
        if (a === undefined) {
          bad.push(`${where}: handled requires anchor {file, token}`);
        } else if (!/^src\/[A-Za-z0-9_./-]+\.ts$/.test(a.file) || a.file.includes("%")) {
          bad.push(`${where}: anchor must point into bridge src/, not ${a.file}`);
        } else {
          const at = new URL(`../${a.file}`, import.meta.url);
          if (!at.pathname.includes("/bridge/src/") || at.pathname.includes("/..")) {
            bad.push(`${where}: anchor resolves outside bridge src/ (${a.file})`);
          } else {
            const stripped = strippedBridge(a.file);
            if (stripped === null) bad.push(`${where}: anchor file missing (${a.file})`);
            else if (!stripped.includes(a.token)) {
              bad.push(`${where}: anchor token "${a.token}" not in comment-stripped ${a.file}`);
            }
          }
        }
        const p = e.proof;
        if (p === undefined) {
          bad.push(`${where}: handled requires proof {kind, ref}`);
        } else {
          if (!(PROOF_KINDS as readonly string[]).includes(p.kind)) {
            bad.push(`${where}: unknown proof kind "${p.kind}"`);
          }
          if (p.kind === "deterministic-test") {
            // A deterministic proof is ADMITTED, with its reason on record: some fields
            // cannot be elicited live yet. The justification is what keeps this from
            // quietly becoming the default.
            if (!p.note) bad.push(`${where}: deterministic-test proof requires a justification note`);
            if (!existsSync(new URL(`../../${p.ref}`, import.meta.url))) {
              bad.push(`${where}: proof ref does not exist (${p.ref})`);
            }
          }
        }
        const vv = e.verifiedVersions ?? [];
        const validated = (COMPAT_MANIFEST.providers.openclaw?.validatedVersions ??
          []) as string[];
        for (const v of vv) {
          if (!validated.includes(v)) {
            bad.push(`${where}: verifiedVersions carries ${v}, not in validatedVersions`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("V2 — a `gap`/`ignored` under the ratchet is not consumed, or declares every reader", () => {
    // BOTH sides of the boundary. The bridge is where an inbound field is first
    // read — but `knownReaders` explicitly admits convex/ and src/, so a
    // consumption added one hop later must trip the sweep too, not walk around it.
    const bridgeStripped = new Map(
      bridgeSrcFiles().map((f) => [`bridge/${f}`, strippedBridge(f) ?? ""]),
    );
    const repoStripped = new Map(
      repoSideFiles().map((f) => [f, strippedRepo(f) ?? ""]),
    );
    const bad: string[] = [];
    for (const version of versions) {
      const m = manifestOf(version);
      for (const { path, scan } of ratchet.fields) {
        const e = entryOf(m, path);
        if (e === undefined || e.status === "handled") continue;
        const where = `${version} ${path}`;
        if (e.anchor !== undefined) {
          // Mirror of the Hermes rule: only `handled` carries an anchor.
          bad.push(`${where}: only handled carries an anchor`);
        }
        if (!scan) continue;
        const field = path.split(".")[1] as string;
        // A declared reader excuses ITS file only when that file really touches
        // the field — an unrelated declaration must not blank a whole file out
        // of the sweep (review: the token-only check did exactly that).
        const declared = new Set(
          (e.knownReaders ?? [])
            .filter((r) => {
              const body =
                bridgeStripped.get(r.file) ?? repoStripped.get(r.file) ?? "";
              return body.includes(field);
            })
            .map((r) => r.file),
        );
        for (const [file, stripped] of [...bridgeStripped, ...repoStripped]) {
          if (declared.has(file)) continue;
          if (consumes(stripped, field)) {
            bad.push(
              `${where}: declared ${e.status} but ${file} consumes it — ` +
                `either the status is false (the progressSummary drift) or the reader must be declared in knownReaders`,
            );
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("V2b — every declared knownReader really exists (a declaration is not a wish)", () => {
    const bad: string[] = [];
    for (const version of versions) {
      const m = manifestOf(version);
      for (const { path } of ratchet.fields) {
        const e = entryOf(m, path);
        for (const r of e?.knownReaders ?? []) {
          const where = `${version} ${path}`;
          if (!/^(bridge\/src|convex|src)\/[A-Za-z0-9_./-]+\.tsx?$/.test(r.file) || r.file.includes("%")) {
            bad.push(`${where}: knownReader path out of policy (${r.file})`);
            continue;
          }
          const stripped = strippedRepo(r.file);
          const field = path.split(".")[1] as string;
          if (stripped === null) bad.push(`${where}: knownReader file missing (${r.file})`);
          else {
            if (!stripped.includes(r.token)) {
              bad.push(`${where}: knownReader token "${r.token}" not found in ${r.file}`);
            }
            // The declaration must name a file that TOUCHES the field: a reader
            // whose file never mentions it declares nothing (review pass).
            if (!stripped.includes(field)) {
              bad.push(`${where}: knownReader ${r.file} never mentions "${field}"`);
            }
          }
          if (!r.note || r.note.length < 10) {
            bad.push(`${where}: a knownReader must SAY why the flow does not happen`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// V3 — a field declared UNREAD may not be read at the schema's own read sites (2026-11-08).
//
// THE DEFECT THIS GUARDS. V1/V2 enforce truth on the ratchet's fields only; outside it a
// `gap` or `ignored` was never confronted with the code, and 2026.9.36's manifest carried
// the result: `HelloOk.server/policy/auth/features` and `ShutdownEvent.reason/
// restartExpectedMs` declared "not yet instructed" while the bridge read them, the
// `AgentActivityItem` fields the delivery cards are built from declared gaps, the
// `inFlightRun` reread called unread. A whole-bridge textual sweep cannot judge a generic
// name (`status` is read everywhere, for other objects) — so the question is asked where
// the answer is unambiguous: inside the functions that read THAT schema's payload
// (protocol/openclaw/read-sites.json), through the parser (scripts/lib/touched-names.mjs).
// Scope: the PROMISED version's manifest — the contract the bridge is judged against.
// ---------------------------------------------------------------------------------------

interface ReadSite {
  file: string;
  fn: string | null;
}
interface ReadSiteGroup {
  name: string;
  schemas: string[];
  sites: ReadSite[];
  homonyms: Record<string, string>;
}
interface ReadSites {
  groups: ReadSiteGroup[];
  unscoped: Record<string, string>;
  emissionStreams: Record<string, string>;
}
type Touched = { reads: Set<string>; writes: Set<string> };

/** Schemas the bridge reads without a declared read site yet. A COPY, like the truth
 *  floor: the JSON list may shrink freely, but growing it — reading a schema nobody
 *  scoped — means editing this list, which a reviewer sees. */
const FROZEN_UNSCOPED: string[] = [
  // Built or read INLINE in multi-purpose functions (2026-11-08): the backlog that
  // extracting each builder into a function of its own pays down.
  "ChatSendParams",
  "SessionsPatchParams",
  "CronGetParams",
  "CronListParams",
  "CronRemoveParams",
  "CronRunParams",
  "CronRunsParams",
  "CronUpdateParams",
  "ModelsListParams",
  "TalkClientCreateResult",
  "TalkClientToolCallResult",
  "AgentsFilesSetParams",
];

const READ_SITES = JSON.parse(
  readFileSync(new URL("../protocol/openclaw/read-sites.json", import.meta.url), "utf-8"),
) as ReadSites;

const TOUCHED = new Map<string, { functions: Map<string, Touched>; file: Touched }>();
function touchedAt(site: ReadSite): Touched | null {
  if (!/^src\/[A-Za-z0-9_./-]+\.ts$/.test(site.file) || site.file.includes("%") || site.file.includes("..")) {
    return null;
  }
  const at = new URL(`../${site.file}`, import.meta.url);
  if (!existsSync(at)) return null;
  let t = TOUCHED.get(site.file);
  if (t === undefined) {
    t = touchedNames(readFileSync(at, "utf-8"), site.file) as { functions: Map<string, Touched>; file: Touched };
    TOUCHED.set(site.file, t);
  }
  return site.fn === null ? t.file : (t.functions.get(site.fn) ?? null);
}

/** The names a group's sites touch for one schema, with where: reads, plus the
 *  object-literal keys when the schema is one the bridge SENDS (`*Params`). */
function touchedFor(group: ReadSiteGroup, schema: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const site of group.sites) {
    const t = touchedAt(site);
    if (t === null) continue;
    const names = schema.endsWith("Params") ? [...t.reads, ...t.writes] : [...t.reads];
    for (const n of names) out.set(n, [...(out.get(n) ?? []), `${site.file}${site.fn ? `#${site.fn}` : ""}`]);
  }
  return out;
}

describe("coverage-truth V3 — a field declared unread is not read at its schema's read sites", () => {
  const PROMISED = promisedVersion();
  const manifest = manifestOf(PROMISED);
  const scoped = new Map<string, ReadSiteGroup>();
  for (const g of READ_SITES.groups) for (const s of g.schemas) scoped.set(s, g);

  it("every read site exists — a site that names nothing scopes nothing", () => {
    const bad: string[] = [];
    for (const g of READ_SITES.groups) {
      if (g.sites.length === 0) bad.push(`${g.name}: no site`);
      for (const site of g.sites) {
        if (touchedAt(site) === null) bad.push(`${g.name}: ${site.file}${site.fn ? `#${site.fn}` : ""} not found`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every scoped schema exists in the promised manifest, in one group only", () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const g of READ_SITES.groups) {
      for (const s of g.schemas) {
        if (manifest.schemas[s] === undefined) bad.push(`${g.name}: ${s} is not a schema of ${PROMISED}`);
        if (seen.has(s)) bad.push(`${s} is scoped twice`);
        seen.add(s);
        if (READ_SITES.unscoped[s] !== undefined) bad.push(`${s} is both scoped and unscoped`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("COMPLETE: every schema the bridge reads is scoped, or unscoped with a reason — and that list only shrinks", () => {
    // A schema with a handled field is one the bridge reads; if it also declares fields
    // unread, those declarations are only checkable at its read sites.
    const missing: string[] = [];
    for (const [name, entry] of Object.entries(manifest.schemas)) {
      const fields = Object.values(entry.fields ?? {});
      const reads = fields.some((f) => f.status === "handled");
      const unread = fields.some((f) => f.status !== "handled" && (f.knownReaders ?? []).length === 0);
      // A schema of agent `data` is checked against the emission registry instead (below).
      const checked = scoped.has(name) || READ_SITES.emissionStreams[name] !== undefined;
      if (reads && unread && !checked && READ_SITES.unscoped[name] === undefined) missing.push(name);
    }
    expect(missing, "read by the bridge, but no read site declared — add a group (read-sites.json)").toEqual([]);
    const bad = Object.entries(READ_SITES.unscoped)
      .filter(([, why]) => (why ?? "").trim().length < 10)
      .map(([s]) => s);
    expect(bad, "an unscoped schema says why").toEqual([]);
    const grown = Object.keys(READ_SITES.unscoped).filter((s) => !FROZEN_UNSCOPED.includes(s));
    expect(grown, "the unscoped list grew — scope the schema instead (or edit FROZEN_UNSCOPED, a review event)").toEqual([]);
  });

  it("TRUTH: no gap/ignored field is touched at its schema's read sites", () => {
    const bad: string[] = [];
    for (const g of READ_SITES.groups) {
      for (const schema of g.schemas) {
        const touched = touchedFor(g, schema);
        for (const [field, e] of Object.entries(manifest.schemas[schema]?.fields ?? {})) {
          if (e.status === "handled") continue;
          const at = touched.get(field);
          if (at === undefined) continue;
          if (g.homonyms[`${schema}.${field}`] !== undefined) continue;
          const declared = new Set((e.knownReaders ?? []).map((r) => r.file));
          const undeclared = at.filter((where) => !declared.has(`bridge/${where.split("#")[0]}`));
          if (undeclared.length === 0) continue;
          bad.push(
            `${PROMISED} ${schema}.${field}: declared ${e.status} but ${[...new Set(undeclared)].join(", ")} reads it — ` +
              `correct the status, declare the reader (knownReaders), or declare the name a homonym at that site`,
          );
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("every homonym declaration is real: the name is touched there, declared unread, and explained", () => {
    const bad: string[] = [];
    for (const g of READ_SITES.groups) {
      for (const [path, why] of Object.entries(g.homonyms)) {
        const [schema, field] = path.split(".") as [string, string];
        if (!g.schemas.includes(schema)) {
          bad.push(`${g.name}: homonym ${path} names a schema outside the group`);
          continue;
        }
        const e = manifest.schemas[schema]?.fields?.[field];
        if (e === undefined || e.status === "handled") bad.push(`${g.name}: homonym ${path} is not a gap/ignored field`);
        if (!touchedFor(g, schema).has(field)) bad.push(`${g.name}: homonym ${path} is not touched by the group's sites (stale)`);
        if ((why ?? "").trim().length < 10) bad.push(`${g.name}: homonym ${path} says why`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("a schema describing agent `data` does not contradict the emission registry", () => {
    // The emission registry classifies each `data` key of a stream with an anchor and a
    // VERIFIED proof; the coverage schema of that stream's data must not call a key it
    // classifies as read unread, or read what it classifies as unread.
    const registry = JSON.parse(
      readFileSync(new URL(`../protocol/openclaw/emissions/${PROMISED}.json`, import.meta.url), "utf-8"),
    ) as { streams: Record<string, { keys: Record<string, { status: string }> }> };
    const bad: string[] = [];
    for (const [schema, stream] of Object.entries(READ_SITES.emissionStreams)) {
      const keys = registry.streams[stream]?.keys ?? {};
      for (const [field, e] of Object.entries(manifest.schemas[schema]?.fields ?? {})) {
        const r = keys[field];
        if (r === undefined) continue;
        if ((r.status === "handled") !== (e.status === "handled")) {
          bad.push(`${schema}.${field} is ${e.status} but the emission registry has ${stream}.${field} ${r.status}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
