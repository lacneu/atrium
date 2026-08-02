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
import { vendoredVersions } from "./helpers/vendored.js";

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
  "ChatAbortedEvent.errorMessage",
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
    const missing = ratchet.fields
      .map((f) => f.path)
      .filter((p) => entryOf(latest, p) === undefined);
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
