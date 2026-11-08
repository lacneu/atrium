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
import { aliasClosure, schemaLiteral, touchedNames, unreachableWhen } from "../scripts/lib/touched-names.mjs";
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
/** ONE concrete access the guard is told is not the payload field's read: the field, the
 *  site, the receivers it is read through, and — for a branch — the discriminant whose
 *  own value (the schema's, vendored) makes every access unreachable. */
interface ReadException {
  field: string;
  site: ReadSite;
  receivers: string[];
  branch?: { receiver: string; field: string };
  why: string;
}
interface ReadSiteGroup {
  name: string;
  schemas: string[];
  sites: ReadSite[];
  exceptions: ReadException[];
}
interface ReadSites {
  groups: ReadSiteGroup[];
  unscoped: Record<string, string>;
  emissionStreams: Record<string, string>;
}
/** What touched-names collects per site. A receiver is identified by its BINDING
 *  (`receiverKeys`: declaration + property path, resolved by the checker); its text
 *  (`receivers`) is for messages and for the declarations of read-sites.json, which
 *  `textKeys` resolves to bindings at the site. */
type Touched = {
  reads: Set<string>;
  writes: Set<string>;
  receivers: Map<string, Set<string>>;
  receiverKeys: Map<string, Set<string>>;
  aliases: Map<string, string>;
  textKeys: Map<string, Set<string>>;
};

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

/** The receiver a WRITE (an object-literal key of a `*Params` builder) is counted under. */
const WRITE = "<object literal>";
const siteId = (s: ReadSite): string => `${s.file}${s.fn ? `#${s.fn}` : ""}`;
const sameSite = (a: ReadSite, b: ReadSite): boolean => a.file === b.file && a.fn === b.fn;

const SOURCES = new Map<string, string>();
const TOUCHED = new Map<string, { functions: Map<string, Touched>; file: Touched }>();
function sourceOf(file: string): string | null {
  if (!/^src\/[A-Za-z0-9_./-]+\.ts$/.test(file) || file.includes("%") || file.includes("..")) return null;
  const at = new URL(`../${file}`, import.meta.url);
  if (!existsSync(at)) return null;
  if (!SOURCES.has(file)) SOURCES.set(file, readFileSync(at, "utf-8"));
  return SOURCES.get(file)!;
}
function touchedAt(site: ReadSite): Touched | null {
  const text = sourceOf(site.file);
  if (text === null) return null;
  let t = TOUCHED.get(site.file);
  if (t === undefined) {
    t = touchedNames(text, site.file) as { functions: Map<string, Touched>; file: Touched };
    TOUCHED.set(site.file, t);
  }
  return site.fn === null ? t.file : (t.functions.get(site.fn) ?? null);
}

/** The text a receiver binding is spelled with at a site (for messages). */
function textOfKey(t: Touched, key: string): string {
  if (key === WRITE) return WRITE;
  for (const [text, keys] of t.textKeys) if (keys.has(key)) return text;
  return key;
}

/** Through what each name is touched at a site, for one schema: the BINDINGS it is read
 *  through, plus WRITE when the schema is one the bridge SENDS (`*Params`) and the site
 *  builds the key. */
function receiverKeysAt(t: Touched, schema: string, name: string): string[] {
  const out = [...(t.receiverKeys.get(name) ?? [])];
  if (schema.endsWith("Params") && t.writes.has(name)) out.push(WRITE);
  return out;
}

/** The binding a receiver TEXT denotes at a site — one, or the declaration is refused:
 *  two bindings spelled alike there (one shadowing the other) make the text ambiguous. */
function bindingOf(t: Touched, text: string): { key?: string; fault?: string } {
  if (text === WRITE) return { key: WRITE };
  const keys = t.textKeys.get(text);
  if (keys === undefined || keys.size === 0) return { fault: `\`${text}\` is not a receiver there` };
  if (keys.size > 1) return { fault: `\`${text}\` names ${keys.size} different bindings there (shadowing) — the access is ambiguous` };
  return { key: [...keys][0] };
}

/** The receivers that ARE the schema's payload: at a site, every BINDING one of its
 *  HANDLED fields is read through, closed over renamings (`const e = evt`, by binding);
 *  and, group-wide, every TEXT such a binding is spelled with — a homonym spelled like the
 *  payload anywhere in the group is refused too (the conservative half). */
function payloadReceivers(group: ReadSiteGroup, schema: string, manifest: Manifest, site: ReadSite): { keys: Set<string>; texts: Set<string> } {
  const handled = Object.entries(manifest.schemas[schema]?.fields ?? {})
    .filter(([, e]) => e.status === "handled")
    .map(([f]) => f);
  const keysAt = (t: Touched): Set<string> => {
    const seeds = new Set<string>();
    for (const f of handled) for (const r of t.receiverKeys.get(f) ?? []) seeds.add(r);
    return aliasClosure(seeds, t.aliases) as Set<string>;
  };
  const texts = new Set<string>();
  for (const s of group.sites) {
    const t = touchedAt(s);
    if (t === null) continue;
    for (const k of keysAt(t)) texts.add(textOfKey(t, k));
  }
  const here = touchedAt(site);
  return { keys: here === null ? new Set() : keysAt(here), texts };
}

/** The vendored literal a schema declares for a property (its discriminant), read from
 *  the promised version's schema sources — or null. */
const VENDORED_DIR = (v: string): URL => new URL(`../protocol/openclaw/${v}/`, import.meta.url);
function vendoredLiteral(version: string, schema: string, property: string): string | null {
  const dir = VENDORED_DIR(version);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) {
    const text = readFileSync(new URL(f, dir), "utf-8");
    if (!text.includes(`${schema}Schema`)) continue;
    const lit = schemaLiteral(text, f, schema, property) as string | null;
    if (lit !== null) return lit;
  }
  return null;
}

/** Why an exception does not hold, or null when it does. */
function exceptionFault(group: ReadSiteGroup, x: ReadException, manifest: Manifest, version: string): string | null {
  const [schema, field] = x.field.split(".") as [string, string | undefined];
  const at = `${group.name}: exception ${x.field} at ${x.site ? siteId(x.site) : "?"}`;
  if (field === undefined || !group.schemas.includes(schema)) return `${at} names a schema outside the group`;
  const e = manifest.schemas[schema]?.fields?.[field];
  if (e === undefined || e.status === "handled") return `${at} is not a gap/ignored field`;
  if (!x.site || !group.sites.some((s) => sameSite(s, x.site))) return `${at}: the site is not one of the group's`;
  if ((x.why ?? "").trim().length < 10) return `${at} says why`;
  const t = touchedAt(x.site);
  if (t === null) return `${at}: the site does not exist`;
  if (!Array.isArray(x.receivers) || x.receivers.length === 0) return `${at} names no receiver — an exception is one concrete access`;
  const actual = new Set(receiverKeysAt(t, schema, field));
  const keys: string[] = [];
  for (const r of x.receivers) {
    const b = bindingOf(t, r);
    if (b.fault !== undefined) return `${at}: ${b.fault}`;
    if (!actual.has(b.key!)) return `${at}: \`${r}.${field}\` is not touched there (stale)`;
    keys.push(b.key!);
  }
  if (x.branch === undefined) {
    const payload = payloadReceivers(group, schema, manifest, x.site);
    for (const [i, r] of x.receivers.entries()) {
      if (payload.keys.has(keys[i]!) || payload.texts.has(r)) {
        return `${at}: \`${r}\` carries handled ${schema} fields in this group — it IS the payload, not a homonym`;
      }
    }
    return null;
  }
  const b = x.branch;
  if (manifest.schemas[schema]?.fields?.[b.field]?.status !== "handled") {
    return `${at}: the discriminant ${schema}.${b.field} is not a handled field of the schema`;
  }
  // The schema's OWN value, read from its vendored source — never declared here, so an
  // exception cannot name a branch the schema takes.
  const own = vendoredLiteral(version, schema, b.field);
  if (own === null) return `${at}: ${schema} declares no literal ${b.field} in the vendored schema`;
  if (x.site.fn === null) return `${at}: a branch is proved inside a function, not a whole file`;
  const discriminant = bindingOf(t, b.receiver);
  if (discriminant.fault !== undefined) return `${at}: the discriminant ${discriminant.fault}`;
  const g = unreachableWhen(sourceOf(x.site.file), x.site.file, x.site.fn, field, keys, { receiverKey: discriminant.key, field: b.field }, own) as {
    accesses: number;
    unguarded: number[];
  };
  if (g.accesses === 0) return `${at}: no access of ${field} through the declared receivers`;
  if (g.unguarded.length > 0) {
    return `${at}: line(s) ${g.unguarded.join(", ")} can read it when \`${b.receiver}.${b.field}\` is ${JSON.stringify(own)} — ${schema}'s own value`;
  }
  return null;
}

describe("coverage-truth V3 — a field declared unread is not read at its schema's read sites", () => {
  const PROMISED = promisedVersion();
  const manifest = manifestOf(PROMISED);
  const scoped = new Map<string, ReadSiteGroup>();
  for (const g of READ_SITES.groups) for (const s of g.schemas) scoped.set(s, g);
  const valid = (g: ReadSiteGroup): ReadException[] =>
    (g.exceptions ?? []).filter((x) => exceptionFault(g, x, manifest, PROMISED) === null);

  it("every read site exists — a site that names nothing scopes nothing", () => {
    const bad: string[] = [];
    for (const g of READ_SITES.groups) {
      if (g.sites.length === 0) bad.push(`${g.name}: no site`);
      for (const site of g.sites) {
        if (touchedAt(site) === null) bad.push(`${g.name}: ${siteId(site)} not found`);
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

  it("TRUTH: no gap/ignored field is touched at its schema's read sites, access by access", () => {
    // Each access is (site, receiver). It is excused by an exception that names exactly
    // that access and HOLDS (below), or — for a gap — admitted by a knownReader whose
    // token is that very access in that file. A name-level exception excused every read
    // of the name at the site, the payload's own included: declaring the real
    // `AgentEvent.isHeartbeat` read a "homonym" made the guard pass (review, 2026-11-08).
    const bad: string[] = [];
    for (const g of READ_SITES.groups) {
      const exceptions = valid(g);
      for (const schema of g.schemas) {
        for (const [field, e] of Object.entries(manifest.schemas[schema]?.fields ?? {})) {
          if (e.status === "handled") continue;
          for (const site of g.sites) {
            const t = touchedAt(site);
            if (t === null) continue;
            for (const key of receiverKeysAt(t, schema, field)) {
              const r = textOfKey(t, key);
              const excepted = exceptions.some(
                (x) => x.field === `${schema}.${field}` && sameSite(x.site, site) && x.receivers.some((text) => bindingOf(t, text).key === key),
              );
              if (excepted) continue;
              const admitted =
                e.status === "gap" &&
                (e.knownReaders ?? []).some((k) => {
                  if (k.file !== `bridge/${site.file}` || !k.token.endsWith(`.${field}`)) return false;
                  return bindingOf(t, k.token.slice(0, -`.${field}`.length)).key === key;
                });
              if (admitted) continue;
              bad.push(
                `${PROMISED} ${schema}.${field}: declared ${e.status} but ${siteId(site)} reads it through \`${r}\` — ` +
                  `correct the status, admit the read (a gap's knownReader with token "${r}.${field}"), or declare that access an exception`,
              );
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("every exception holds: one concrete access, real, and not the payload's own read", () => {
    const bad: string[] = [];
    for (const g of READ_SITES.groups) {
      // The name-level form (`homonyms: {"Schema.field": why}`) excused every read of the
      // name at every site, the payload's own included; it is refused, not ignored.
      const extra = Object.keys(g).filter((k) => !["name", "schemas", "sites", "exceptions"].includes(k));
      if (extra.length > 0) bad.push(`${g.name}: unknown key(s) ${extra.join(", ")} — exceptions are concrete accesses`);
      if (!Array.isArray(g.exceptions)) bad.push(`${g.name}: no exceptions list`);
      for (const x of g.exceptions ?? []) {
        const fault = exceptionFault(g, x, manifest, PROMISED);
        if (fault !== null) bad.push(fault);
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
