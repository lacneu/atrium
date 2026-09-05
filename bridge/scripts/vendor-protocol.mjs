#!/usr/bin/env node
// VENDOR the gateway's wire-contract schemas for one version (W10 / G0).
//
// WHY a script and not a manual copy: `maxValidated` is the bridge's public promise
// that a version's contract has been EXAMINED, and the examination artifact is these
// files plus the coverage manifest that stays red until a human classifies every new
// field. Copying by hand made that artifact optional — five contract additions of
// 2026.7.1 entered support with nobody looking, and `maxValidated` pointed at a
// version with no vendored directory at all.
//
// It writes `PROVENANCE.json` next to the modules: the upstream commit SHA of the
// tag, plus a sha256 per file. `vendor-integrity.test.ts` recomputes those hashes, so
// a hand-edited "verbatim" file fails a gate instead of quietly becoming fiction.
//
// Usage:
//   node scripts/vendor-protocol.mjs 2026.7.1 [--src <path to an openclaw checkout>]
//
// With no `--src`, a shallow clone of `v<version>` goes to a temp dir. A cached
// checkout is faster and is what the bench already keeps around.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveVendorEntries, since } from "./lib/vendor-files.mjs";
import process from "node:process";

import {
  SNAPSHOT_FN,
  SNAPSHOT_SITES,
  SNAPSHOT_SOURCE,
  deriveSnapshotFields,
} from "./lib/derive-snapshot.mjs";
import {
  CATALOGUE_CONST_SOURCE,
  CATALOGUE_SOURCE,
  CATALOGUE_SYMBOL,
  deriveEventCatalogue,
} from "./lib/derive-event-catalogue.mjs";

/** Files to vendor, with their path RELATIVE to `packages/gateway-protocol/src/`.
 *  Stated per file because upstream keeps the schema modules in `schema/` and the
 *  shared contracts they import one level up — an assumed single directory made the
 *  script fail on the second kind.
 *
 *  DERIVED, not chosen: `rpc-scope.test.ts` enumerates the RPC methods the bridge
 *  actually calls and fails when one is covered by no vendored module. Add a module
 *  here when that test names it — never "just in case", because every vendored
 *  schema is classification work for a human, and an unread schema in the manifest
 *  is worse than an absent one (it looks reviewed). */
const FILES = [
  // The chat lane: `chat.send` / `chat.abort` params and every event the
  // normalizer reads off the wire.
  "schema/logs-chat.ts",
  // `agent` events: tool / lifecycle / assistant / item streams.
  "schema/agent.ts",
  // Shared field types the two above import.
  "schema/primitives.ts",
  // The `sessions.*` lane: get / describe / patch / reset / compact / compaction.list
  // are 6 of the bridge's 26 RPC calls and the busiest family after chat.
  "schema/sessions.ts",
  // `cron.*` (6 calls) is USER-VISIBLE — the Scheduled tab lists, edits and runs jobs,
  // and `cronManage` is a capability gated on a specific gateway version, so a
  // contract drift here shows up as a broken control rather than a silent one.
  "schema/cron.ts",
  // `tasks.*` (2 calls): the background-task reconciliation the activity indicator
  // uses before expiring an engagement.
  "schema/tasks.ts",
  // `config.get` / `config.patch` (4 call sites): the ONLY place the bridge writes
  // gateway configuration. `config.patch` carries a `baseHash` OCC guard, so a
  // contract move here silently turns a guarded write into an unguarded one.
  "schema/config.ts",
  // `talk.client.create` / `talk.client.toolCall`: the realtime voice lane. Two calls
  // only, but they mint a browser-held session carrying a short-lived credential and
  // relay every voice consult, so a contract move here surfaces with NO talk-specific
  // diagnosis: `classifyGatewayError` has no code for this lane. The generic classifier
  // still does its job — a rejected parameter is INVALID_REQUEST, a timeout is
  // GATEWAY_TIMEOUT, and auth/permission/disconnect each keep their own code — but none
  // of that says "the voice contract moved", so the user sees a generic voice failure and
  // learns nothing about what changed.
  "schema/channels.ts",
  // `agents.list`, `models.list` and the `agents.files.*` trio share one module.
  // The Files agent's whole CRUD surface lives behind `agents.files.set`.
  "schema/agents-models-skills.ts",
  // Contracts the modules above import transitively; they must ride along for the
  // flat layout to typecheck. Explicit rather than an automatic import walk, which
  // would silently widen the reviewed surface.
  "client-info.ts",
  "secret-ref-contract.ts",
  // Imported by sessions.ts for `PluginJsonValueSchema` alone. Vendored because the
  // flat layout must typecheck, and CLASSIFIED like any other module — an unread
  // schema in the manifest is worse than an absent one.
  "schema/plugins.ts",
  // New transitive imports as of 2026.7.2-beta.5: upstream split `sessions.ts` into
  // sub-modules (frames / sessions-create / sessions-row / sessions-sharing-values /
  // snapshot), added a `closedObject` helper every schema module now imports, and
  // `sessions.ts` reads `SESSION_AGENT_ATTENTION_ICON_IDS` from `session-icon.ts`.
  // They ride along for the same reason as the three above, and the ones that export
  // schemas are classified like any other module.
  "schema/closed-object.ts",
  "schema/frames.ts",
  "schema/sessions-create.ts",
  "schema/sessions-row.ts",
  "schema/sessions-sharing-values.ts",
  "schema/snapshot.ts",
  // RENAMED at v2026.8.1: `session-icon.ts` became `session-agent-status.ts`,
  // still exporting `SESSION_AGENT_ATTENTION_ICON_IDS`. An entry may therefore
  // be a list of candidate paths, newest first — the first that EXISTS wins, and
  // a version where none exists still refuses. Vendoring by a single hardcoded
  // path turned an upstream rename into "module renamed?" with no way forward
  // but editing this list on every tag.
  ["session-agent-status.ts", "session-icon.ts"],
  // New transitive imports as of 2026.8.1: upstream split the session and worker
  // schemas much further (participants, classification, patch/list/goal/delete/
  // recover, worker admission/computer, failover reasons, history constants…).
  // This list is the TRANSITIVE CLOSURE of the roots above, computed against the
  // checkout rather than discovered one "module renamed?" at a time: a vendored
  // tree that does not typecheck is not a contract anyone can read, and each of
  // these is classified in the coverage manifest like every other module.
  ...since("2026.8.1", [
  "failover-reasons.ts",
  "protocol-value-normalization.ts",
  "server-capabilities.ts",
  "schema/chat-history-constants.ts",
  "schema/environments.ts",
  "schema/failover-reason.ts",
  "schema/plugin-declared-surface-groups.ts",
  "schema/secrets.ts",
  "schema/session-classification.ts",
  "schema/session-github-publication.ts",
  "schema/session-participant.ts",
  "schema/sessions-delete.ts",
  "schema/sessions-goal.ts",
  "schema/sessions-list.ts",
  "schema/sessions-patch.ts",
  "schema/sessions-recover.ts",
  "schema/since.ts",
  "schema/worker-admission.ts",
  "schema/worker-computer.ts",
  "schema/worker-protocol-primitives.ts",
  ]),
  // From ANOTHER package of the monorepo (see the rewrite below): re-exported by
  // protocol-value-normalization.ts, so the flat tree needs it to typecheck.
  ...since("2026.8.1", ["../../normalization-core/src/record-coerce.ts"]),

  // New transitive imports as of 2026.9.1 (1230 commits after 2026.8.2): the
  // cron schema split its shared pieces out, sessions gained a title schema,
  // the snapshot a gateway-suspend one, GitHub publication a users schema (which
  // pulls appearance preferences), and logs-chat a UTF-16 slicer from
  // normalization-core. Same closure rule as the 2026.8.1 block.
  ...since("2026.9.1", [
    "schema/cron-shared.ts",
    "schema/sessions-title.ts",
    "schema/gateway-suspend.ts",
    "schema/users.ts",
    "schema/ui-appearance-preferences.ts",
    "../../normalization-core/src/utf16-slice.ts",
  ]),
];

/** The one repository these bytes may be attributed to. */
const UPSTREAM_REPO = "openclaw/openclaw";

const version = process.argv[2];
if (!version || version.startsWith("-")) {
  console.error(
    "usage: vendor-protocol.mjs <version> [--src <openclaw checkout>]",
  );
  process.exit(2);
}
const srcFlag = process.argv.indexOf("--src");
const providedSrc = srcFlag > -1 ? process.argv[srcFlag + 1] : null;

const REPO = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(REPO, "protocol", "openclaw", version);

/** A checkout of the tag: the caller's, or a fresh shallow clone. */
function resolveSource() {
  if (providedSrc) {
    const dir = path.resolve(providedSrc);
    if (!fs.existsSync(path.join(dir, ".git"))) {
      throw new Error(`--src ${dir} is not a git checkout`);
    }
    // The tag MUST match: vendoring "verbatim from v2026.7.1" out of a checkout
    // sitting on something else is exactly the fiction PROVENANCE.json exists to
    // prevent.
    const described = execFileSync(
      "git",
      ["-C", dir, "describe", "--tags", "--exact-match"],
      { encoding: "utf-8" },
    ).trim();
    if (described !== `v${version}`) {
      throw new Error(
        `--src ${dir} is at ${described}, not v${version} — refusing to vendor`,
      );
    }
    // A DIRTY tree bearing the right tag would vendor edited bytes while
    // PROVENANCE.json attributes them to openclaw/openclaw (raised in review). The
    // attribution is the whole value of the record, so it must not be assumable.
    const dirty = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf-8",
    }).trim();
    if (dirty !== "") {
      throw new Error(
        `--src ${dir} has uncommitted changes — refusing to attribute edited bytes ` +
          `to ${UPSTREAM_REPO}`,
      );
    }
    // And it must be a checkout OF that repository. A local fork carrying the same
    // tag name is the other half of the same lie.
    // EXACT host+path, not a substring: `https://github.com/openclaw/openclaw.git.evil`
    // contains the repository name and is a different repository (raised in review).
    const remoteUrls = execFileSync("git", ["-C", dir, "remote", "-v"], {
      encoding: "utf-8",
    })
      .split("\n")
      .map((l) => l.split(/\s+/)[1] ?? "")
      .filter((u) => u.length > 0);
    const isUpstream = (url) => {
      // Accept the shapes git actually produces for one repository, and nothing else:
      //   https://github.com/<repo>[.git]   git@github.com:<repo>[.git]
      const normalized = url.replace(/\.git$/, "");
      return (
        normalized === `https://github.com/${UPSTREAM_REPO}` ||
        normalized === `http://github.com/${UPSTREAM_REPO}` ||
        normalized === `git@github.com:${UPSTREAM_REPO}` ||
        normalized === `ssh://git@github.com/${UPSTREAM_REPO}`
      );
    };
    const upstreamUrl = remoteUrls.find(isUpstream);
    if (upstreamUrl !== undefined) {
      // The checkout has the right remote and the right tag NAME — but a local tag can
      // be created on modified sources (raised in review). Ask the remote what
      // `v<version>` actually points at and require our HEAD to be that commit.
      // `ls-remote` needs no fetch and no objects. `--offline` skips it EXPLICITLY,
      // which is a stated downgrade rather than a silent one.
      if (process.argv.includes("--offline")) {
        console.error(
          `[vendor] --offline: NOT verifying that v${version} in ${UPSTREAM_REPO} is ` +
            `the commit being vendored. The provenance record will attribute these ` +
            `bytes to that tag on trust.`,
        );
      } else {
        const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
          encoding: "utf-8",
        }).trim();
        // `refs/tags/X` is the TAG OBJECT for an annotated tag; the COMMIT is
        // `refs/tags/X^{}` (upstream's release tags are annotated — the first version
        // of this check compared a tag-object sha against a commit sha and reported a
        // mismatch on a perfectly good checkout).
        const listing = execFileSync(
          "git",
          [
            "ls-remote",
            upstreamUrl,
            `refs/tags/v${version}`,
            `refs/tags/v${version}^{}`,
          ],
          { encoding: "utf-8" },
        ).trim();
        const rows = listing
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => l.split(/\s+/));
        const peeled = rows.find(([, ref]) => ref?.endsWith("^{}"));
        const plain = rows.find(([, ref]) => ref === `refs/tags/v${version}`);
        const remoteSha = (peeled ?? plain ?? [])[0] ?? "";
        if (remoteSha === "") {
          throw new Error(
            `${UPSTREAM_REPO} has no tag v${version} — refusing to vendor`,
          );
        }
        if (remoteSha !== head) {
          throw new Error(
            `v${version} in ${UPSTREAM_REPO} is ${remoteSha.slice(0, 12)} but --src ` +
              `is at ${head.slice(0, 12)} — the local tag does not match upstream's`,
          );
        }
      }
    }
    if (!remoteUrls.some(isUpstream)) {
      throw new Error(
        `--src ${dir} has no remote that IS ${UPSTREAM_REPO} (found: ` +
          `${remoteUrls.join(", ") || "none"}) — refusing to vendor bytes we would ` +
          `then attribute to it`,
      );
    }
    return dir;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vendor-"));
  console.error(`[vendor] shallow clone v${version} -> ${tmp}`);
  execFileSync(
    "git",
    [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      `v${version}`,
      `https://github.com/${UPSTREAM_REPO}.git`,
      tmp,
    ],
    { stdio: "inherit" },
  );
  return tmp;
}

const src = resolveSource();
const upstreamSha = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], {
  encoding: "utf-8",
}).trim();
const srcRoot = path.join(src, "packages", "gateway-protocol", "src");
if (!fs.existsSync(srcRoot)) {
  throw new Error(`no gateway-protocol source at ${srcRoot} — upstream layout changed`);
}

// The header names EXACTLY the substitutions applied to THAT file — nothing more
// (a rewrite the file never needed is not "a change vs upstream"), nothing less
// (raised in review: the `@openclaw/<pkg>/<module>` collapse introduced at
// v2026.8.1 was applied while the header still announced the `../` rebase as the
// only change — a provenance statement false precisely where it mattered).
const REWRITE_KINDS = {
  rebased: "../ imports rebased to ./ for the flat layout",
  packageCollapsed:
    "@openclaw/<pkg>/<module> workspace specifiers collapsed to ./<module>.js",
};
const header = (rel, applied) =>
  `// VENDORED VERBATIM from openclaw/openclaw @ v${version} — ` +
  `packages/gateway-protocol/src/${rel}.\n` +
  `// Source of truth for the wire protocol; used ONLY by the protocol-coverage\n` +
  `// ratchet test (never imported by runtime bridge code). Do not edit by hand:\n` +
  `// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.\n` +
  (applied.length === 0
    ? `// (No change vs upstream.)\n`
    : `// (Only change${applied.length > 1 ? "s" : ""} vs upstream: ` +
      `${applied.map((k) => REWRITE_KINDS[k]).join("; ")}.)\n`);

// DERIVED BEFORE ANYTHING IS WRITTEN.
//
// The derivation can REFUSE (an unreadable spread, a renamed function, a source the
// parser doubts), and it used to run after every schema file had already been copied —
// so a refusal left a half-vendored directory whose files no longer matched the
// PROVENANCE.json beside them (raised in review). It depends only on the checkout, so
// there is no reason for it to happen late: fail before the first byte is written.
// WHICH site builds the snapshot depends on the tag, so it is RESOLVED against
// the checkout instead of assumed: v2026.8.1 moved the shape out of
// server-chat.ts into session-event-payload.ts. The candidates are ordered
// (newest first) and the first whose file exists AND whose function derives
// wins; if none does, the LAST failure is raised rather than a vague "not
// found", so the message still names what upstream changed.
let snapshotFields;
let snapshotSource;
let snapshotRaw;
const snapshotErrors = [];
for (const site of SNAPSHOT_SITES) {
  const candidate = path.join(src, site.source);
  if (!fs.existsSync(candidate)) continue;
  const candidateRaw = fs.readFileSync(candidate, "utf-8");
  try {
    snapshotFields = deriveSnapshotFields(candidateRaw, {
      fnName: site.fn,
      sourceLabel: site.source,
      fileName: path.basename(site.source),
    });
    snapshotSource = site.source;
    snapshotRaw = candidateRaw;
    break;
  } catch (error) {
    snapshotErrors.push(`${site.source} :: ${site.fn} — ${error.message}`);
  }
}
if (snapshotFields === undefined) {
  // EVERY candidate's refusal, not just the last one: reporting only the last
  // named the OLD layout while the failure that mattered was the new one.
  throw new Error(
    snapshotErrors.length > 0
      ? `no snapshot site derives at v${version}:\n  - ${snapshotErrors.join("\n  - ")}`
      : `upstream has none of ${SNAPSHOT_SITES.map((x) => x.source).join(", ")} at v${version}`,
  );
}

// Same rule for the announced event catalogue (G-70): derive it BEFORE anything is
// written, and let an unresolvable entry abort the whole vendoring. A catalogue that
// is one entry short is worse than none — the ratchet would bless the shortfall.
const cataloguePath = path.join(src, CATALOGUE_SOURCE);
const catalogueConstPath = path.join(src, CATALOGUE_CONST_SOURCE);
for (const [label, p] of [
  [CATALOGUE_SOURCE, cataloguePath],
  [CATALOGUE_CONST_SOURCE, catalogueConstPath],
]) {
  if (!fs.existsSync(p)) {
    throw new Error(`upstream has no ${label} at v${version}`);
  }
}
const catalogueRaw = fs.readFileSync(cataloguePath, "utf-8");
const catalogueConstRaw = fs.readFileSync(catalogueConstPath, "utf-8");
const catalogueEvents = deriveEventCatalogue(catalogueRaw, catalogueConstRaw);

fs.mkdirSync(OUT_DIR, { recursive: true });
const files = {};
const { entries: vendorEntries, skipped: vendorSkipped } = resolveVendorEntries(FILES, version);
for (const { candidates, since: from } of vendorSkipped) {
  console.error(`[vendor] ${candidates.join(" | ")}: not before v${from}, skipped for v${version}`);
}
for (const { candidates } of vendorEntries) {
  // A candidate starting with "../" leaves gateway-protocol for another package
  // of the monorepo — v2026.8.1 made `protocol-value-normalization.ts` re-export
  // from `@openclaw/normalization-core`, so the vendored tree cannot typecheck
  // without that module. Resolution stays anchored on srcRoot either way.
  const rel = candidates.find((c) => fs.existsSync(path.join(srcRoot, c)));
  if (rel === undefined) {
    throw new Error(
      `upstream has none of ${candidates.join(", ")} at v${version} — module renamed?`,
    );
  }
  const from = path.join(srcRoot, rel);
  const name = path.basename(rel);
  const raw = fs.readFileSync(from, "utf-8");
  // The ONLY transformation, stated in the header: the flat vendored layout has no
  // parent directories, so `../x/y.js` and `./x/y.js` imports collapse to `./y.js`.
  //
  // Applied LINE BY LINE and only to import/export declarations (raised in review):
  // a comment or a string literal containing `from "../foo.js"` was being rewritten
  // too, which made the file non-verbatim outside the one change the header announces.
  const applied = new Set();
  const flattened = raw
    .split("\n")
    .map((line) => {
      const t = line.trim();
      const isDeclaration =
        (t.startsWith("import ") ||
          t.startsWith("export ") ||
          t.startsWith("}")) &&
        / from "/.test(t);
      // The FIRST `from "…"` only — the specifier. A trailing comment mentioning
      // another path (`import … from "../a.js"; // moved from "../b.js"`) was being
      // rewritten too, which is precisely the "verbatim except the specifier" promise
      // broken (raised in review). Note the non-global regex.
      if (!isDeclaration) return line;
      // Workspace package specifiers resolve to nothing in the flat vendored
      // layout. v2026.8.1 introduced exactly one
      // (`@openclaw/normalization-core/record-coerce`), and leaving it made every
      // consumer of the vendored tree fail to load — the coverage ratchet
      // included, which is how it surfaced. The module it names is vendored
      // alongside, so the specifier collapses the same way a relative one does.
      // Recorded in PROVENANCE.json like every other rewrite.
      const packageRewritten = line.replace(
        /from "@openclaw\/[a-z0-9-]+\/([a-z0-9-]+)"/,
        'from "./$1.js"',
      );
      if (packageRewritten !== line) applied.add("packageCollapsed");
      const rebased = packageRewritten.replace(
        /from "\.\.?\/(?:[^"]*\/)?([^/"]+\.js)"/,
        'from "./$1"',
      );
      if (rebased !== packageRewritten) applied.add("rebased");
      return rebased;
    })
    .join("\n");
  const body = header(rel, [...applied].sort()) + flattened;
  fs.writeFileSync(path.join(OUT_DIR, name), body);
  // TWO hashes, and the second is the one that matters.
  //
  // `vendored` covers what we WROTE (header included): it catches a local edit, but
  // it is SELF-ATTESTED — someone editing a schema can update this number too and
  // every gate stays green (raised in review, 2026-07-26).
  // `upstream` is the sha256 of the RAW upstream bytes, before our header and before
  // the import rewrite. That number is a claim about the CONTENT OF A PUBLIC TAG:
  // anyone with the tag can recompute it, so faking it requires lying about
  // something checkable outside this repo. `vendor-integrity.test.ts` also verifies
  // that stripping our header and undoing nothing else reproduces it, which pins the
  // body of every vendored file to upstream's own bytes for the unmodified files.
  // The rewrite is line-local and REVERSIBLE: record the original import lines so the
  // test can reconstruct the upstream bytes exactly and compare against `upstream`.
  // Without this, a rewritten file could only be checked against a self-attested
  // hash — and `primitives.ts` is rewritten, so that exemption would have covered a
  // walked schema module.
  const rewrites = [];
  if (flattened !== raw) {
    const before = raw.split("\n");
    const after = flattened.split("\n");
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i]) rewrites.push({ line: i, upstream: before[i] });
    }
  }
  files[name] = {
    // WHERE these bytes came from, inside the tag. Recorded rather than inferred:
    // the vendored layout is flat, so `logs-chat.ts` could be `schema/logs-chat.ts`
    // or `logs-chat.ts` and the integrity test was GUESSING between the two. A guess
    // that falls through to the wrong candidate verifies the wrong file, and the
    // upstream diff cannot derive its watchlist from a guess at all.
    upstreamPath: `packages/gateway-protocol/src/${rel}`,
    vendored: createHash("sha256").update(body).digest("hex"),
    upstream: createHash("sha256").update(raw).digest("hex"),
    // Empty when the file needed no rewrite.
    rewrites,
  };
}

// --- DERIVED artifact: the session snapshot the gateway flattens onto agent events ----
//
// `KNOWN_AGENT_FIELDS` (protocol-drift.ts) used to be a list of PROD OBSERVATIONS: a
// field appeared in the "N unknown fields" badge, someone patched the list, repeat. Twelve
// fields of this snapshot were still missing when W9 was written, which is twelve future
// badges for fields upstream demonstrably emits.
//
// The snapshot is built by `buildSessionEventSnapshot` in `src/gateway/server-chat.ts` —
// NOT a protocol module, and not something to vendor: it is 1400+ lines of gateway
// implementation and would have to be "classified" by a ratchet meant for schemas. What
// IS vendored is its RETURN SHAPE, derived mechanically, so the drift detector's known-set
// can be asserted against upstream instead of against memory.

fs.writeFileSync(
  path.join(OUT_DIR, "session-event-snapshot.json"),
  `${JSON.stringify(
    {
      _about:
        `Field names of ${SNAPSHOT_FN}'s return shape, DERIVED from ` +
        `${snapshotSource} at v${version}. The gateway flattens these onto agent ` +
        `events, so the drift detector's known-field set is asserted against this ` +
        `instead of against production observations. Do not edit by hand: re-run ` +
        `scripts/vendor-protocol.mjs.`,
      derivedFrom: snapshotSource,
      derivedFromSha256: createHash("sha256").update(snapshotRaw).digest("hex"),
      fields: snapshotFields,
    },
    null,
    2,
  )}\n`,
);

// --- DERIVED artifact: the event catalogue the gateway announces about ITSELF ---------
//
// `hello-ok.features.events` is populated from this array, so it is upstream's own
// statement of what it emits — not an inference of ours. Vendoring it lets a CI ratchet
// assert that every announced family is CLASSIFIED (read, or deliberately not read with
// a reason), instead of Atrium discovering an unhandled family when a user trips on it.
//
// Recorded as a resolved JSON list rather than a verbatim copy because one entry is an
// imported identifier; see lib/derive-event-catalogue.mjs.

fs.writeFileSync(
  path.join(OUT_DIR, "event-catalogue.json"),
  `${JSON.stringify(
    {
      _about:
        `Event names announced by the gateway in \`hello-ok.features.events\`, DERIVED ` +
        `from ${CATALOGUE_SYMBOL} in ${CATALOGUE_SOURCE} at v${version} (imported ` +
        `constants resolved from ${CATALOGUE_CONST_SOURCE}). Do not edit by hand: ` +
        `re-run scripts/vendor-protocol.mjs.`,
      derivedFrom: CATALOGUE_SOURCE,
      derivedFromSha256: createHash("sha256").update(catalogueRaw).digest("hex"),
      constantsFrom: CATALOGUE_CONST_SOURCE,
      constantsSha256: createHash("sha256").update(catalogueConstRaw).digest("hex"),
      events: catalogueEvents,
    },
    null,
    2,
  )}\n`,
);

fs.writeFileSync(
  path.join(OUT_DIR, "PROVENANCE.json"),
  `${JSON.stringify(
    {
      version,
      upstreamRepo: UPSTREAM_REPO,
      upstreamTag: `v${version}`,
      upstreamSha,
      // No timestamp on purpose: re-running must produce a BYTE-IDENTICAL directory,
      // so a diff means the contract moved, never that the clock did.
      files,
      // The DERIVED artifact, attributed like the copied ones: the sha256 of the upstream
      // file it was read from, so "this list came from that source" is checkable.
      derived: {
        "session-event-snapshot.json": {
          upstreamPath: snapshotSource,
          upstream: createHash("sha256").update(snapshotRaw).digest("hex"),
          fields: snapshotFields.length,
        },
        "event-catalogue.json": {
          upstreamPath: CATALOGUE_SOURCE,
          upstream: createHash("sha256").update(catalogueRaw).digest("hex"),
          // The constants module is attributed too: resolving an entry reads it, so a
          // change there can move the catalogue without touching the array itself.
          constantsPath: CATALOGUE_CONST_SOURCE,
          constants: createHash("sha256").update(catalogueConstRaw).digest("hex"),
          events: catalogueEvents.length,
        },
      },
    },
    null,
    2,
  )}\n`,
);

console.error(
  `[vendor] ${Object.keys(files).length} file(s) -> protocol/openclaw/${version}/ (upstream ${upstreamSha.slice(0, 12)})`,
);
