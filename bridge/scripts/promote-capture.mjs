#!/usr/bin/env node
// Promote a LIVE bench capture into the golden corpus (W11/G4).
//
//   node bridge/scripts/promote-capture.mjs --run <bench-run-dir> [--out <dir>]
//
// The live bench is the only thing that proves the gateway still speaks the dialect the
// normalizer was built against — and it is slow, needs a gateway and a model, and its
// verdict moves with host load and LLM variance. This script turns one green run into
// fixtures a unit test can replay forever, with no gateway and no model: a change that
// alters how an OLD capture is interpreted becomes RED in CI, immediately.
//
// What it refuses, and why:
//   * a run whose verdict is not GO — promoting a red run would enshrine the very
//     interpretation the run says is wrong;
//   * a run with no per-scenario slices — only the runner knows where a scenario begins
//     in the shared capture, and guessing the boundaries afterwards is how a fixture ends
//     up containing another scenario's frames;
//   * a scenario slice with no frames — an empty fixture satisfies every replay test
//     while proving nothing (the empty-vendored-directory trap, in a new costume).
//
// Anonymisation lives in lib/anonymize-capture.mjs and is an ALLOWLIST. See its header.
//
// ── THE INPUT CONTRACT ──────────────────────────────────────────────────────────────
// A "bench run directory" is anything that contains:
//
//   report.json            {
//                            "gatewayVersion": "2026.7.1",   // the version under test
//                            "verdict": "GO",                // only GO may be promoted
//                            "results": [                     // one entry per scenario
//                              { "id": "basic-turn", "provider": "openclaw", … }
//                            ]
//                          }
//   scenario-<id>.jsonl    the frames captured DURING that scenario, one JSON line each,
//                          either `{"receivedAt": <epoch ms>, "frame": {…}}` (what the
//                          bridge writes under OPENCLAW_CAPTURE_FRAMES since 2026-07-28)
//                          or a bare frame per line (older captures).
//
// Any harness that produces that shape can feed this script; the frames come from the
// bridge itself (OPENCLAW_CAPTURE_FRAMES), and the per-scenario split is the only part a
// harness must add — it is the one thing the capture cannot know. The contract is spelled
// out here because the harness this repo's maintainer uses lives OUTSIDE the repo, and a
// tool whose input format is undocumented cannot be used by anyone else (raised in
// review).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

import { fidelityDiff, loadRunManager } from "./lib/replay-fidelity.mjs";
import {
  anonymizeFrame,
  baseKnownKeys,
  createPseudonymiser,
  knownKeysFromCoverage,
} from "./lib/anonymize-capture.mjs";

/** Bumped whenever promotion CHANGES the bytes it produces from the same capture. It is
 *  recorded per fixture, so a corpus half-promoted by two different rules is visible
 *  instead of silently mixed. */
export const PROMOTER_VERSION = 1;

const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const DEFAULT_OUT = path.join(REPO_ROOT, "bridge/test/fixtures/golden");

function parseArgs(argv) {
  const args = { run: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run") args.run = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.run) throw new Error("--run <bench-run-dir> is required");
  return args;
}

/** Every tool NAME the slice mentions, harvested from `data.name`.
 *
 *  A tool name is gateway registry vocabulary, and it reappears INSIDE identifiers: the
 *  background-task delivery family is `<tool>:<taskId>:ok`, which the run-family reader
 *  parses. Pseudonymising the tool token there turned a delivery run into an unrecognised
 *  id and quietly removed the whole async path from the corpus. */
/** Gateway BUILT-IN tools, safe to publish verbatim: they are registry entries of the
 *  gateway itself, identical on every deployment, and reading `tool:exec` in a snapshot is
 *  most of what makes a red one diagnosable.
 *
 *  A custom or plugin tool is a different thing entirely — its name can carry a client, a
 *  project or a patient (raised in review), and a shape regexp validates the FORM, never
 *  the safety. Unknown names are pseudonymised into the same grammar instead, so the
 *  `<tool>:<taskId>:ok` delivery family still parses. Allowlist, so the failure is safe. */
const BUILT_IN_TOOL_NAMES = new Set([
  // `cron` is REQUIRED verbatim by `cronPartFromTool`, and leaving it out renamed the
  // cron scenario's tool: the cron card stopped being produced and the golden snapshot
  // went red — the corpus catching a regression in its own promoter, which is the best
  // evidence that a missing entry here fails loudly rather than silently.
  "cron",
  "exec",
  "read",
  "write",
  "edit",
  "apply_patch",
  "message",
  "update_plan",
  "sessions_spawn",
  "sessions_yield",
  "image_generate",
  "video_generate",
  "web_search",
  "web_fetch",
  "browser",
  "cron_list",
  "cron_create",
  "cron_delete",
  "memory_search",
  "todo_write",
]);

/** The harvest, split into what may be published and what must be renamed.
 *
 *  Renames are SEQUENTIAL per capture (`tool_1`, `tool_2`), not a hash of the name. A
 *  32-bit digest was the first version and it protects nothing: a reader of the corpus
 *  hashes candidates and confirms the one that produced `tool_<hash>` — the same
 *  dictionary attack that made the unknown-state digest need a salt. A counter is not
 *  derivable at all, and the grammar the run-family parser needs (`[a-z][a-z0-9_]*`) is
 *  preserved either way. */
export function classifyToolNames(names) {
  const verbatim = new Set();
  const renamed = new Map();
  let n = 0;
  for (const name of [...names].sort()) {
    if (BUILT_IN_TOOL_NAMES.has(name)) verbatim.add(name);
    else renamed.set(name, `tool_${++n}`);
  }
  return { verbatim, renamed };
}

export function harvestToolNames(rawSlice) {
  const names = new Set();
  for (const line of rawSlice.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; /* counted as unparsable by promoteSlice */
    }
    // TWO positions, and only two: the tool name of a `stream:"tool"` or `stream:"item"`
    // agent event — the item is the tool's tracked item and readers key on its name. The
    // first version walked the whole frame for any `name` key, which let the CAPTURE
    // write its own allowlist — it harvested `Alice`, `Bob` and `Fichiers` from the
    // session snapshot's agent list, and `alice` then survived verbatim inside every
    // session key of three fixtures. Vocabulary must come from the protocol, never from
    // the payload being anonymised.
    const payload = parsed?.frame?.payload ?? parsed?.payload;
    if (payload?.stream !== "tool" && payload?.stream !== "item") continue;
    const name = payload?.data?.name;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Parse a slice into `{receivedAt, frame}` entries, both on-disk shapes accepted. */
export function parseEntries(rawSlice) {
  const out = [];
  for (const line of rawSlice.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const enveloped =
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.receivedAt === "number" &&
      Object.prototype.hasOwnProperty.call(parsed, "frame");
    out.push(
      enveloped
        ? { receivedAt: parsed.receivedAt, frame: parsed.frame }
        : { receivedAt: null, frame: parsed },
    );
  }
  return out;
}

/** The capture's own time origin.
 *
 *  The first arrival time when the capture is enveloped — and, for a PRE-ENVELOPE capture,
 *  the earliest epoch-shaped number in the frames themselves. Returning null for those
 *  meant no rebasing happened at all, so `ts`, `startedAt` and `updatedAt` were published
 *  absolute in exactly the captures the promoter says it still accepts. Null now means one
 *  thing only: nothing in this slice looks like a date. */
export function captureEpochBase(rawSlice) {
  let earliest = null;
  const consider = (n) => {
    if (
      typeof n === "number" &&
      Number.isFinite(n) &&
      Math.abs(n) >= 1_000_000_000_000 &&
      Math.abs(n) <= 4_000_000_000_000 &&
      (earliest === null || n < earliest)
    ) {
      earliest = n;
    }
  };
  // PROTOCOL positions only. A free-form blob can hold any date at all — a document's,
  // a record's — and letting one become the origin would publish the real `ts` values as
  // a large offset from it, from which the capture time can be inferred.
  const FREE_FORM = new Set([
    "args",
    "result",
    "output",
    "input",
    "meta",
    "details",
    "structuredContent",
  ]);
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (FREE_FORM.has(k)) continue;
        visit(v);
      }
      return;
    }
    consider(node);
  };
  for (const line of rawSlice.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.receivedAt === "number") return parsed.receivedAt;
      visit(parsed);
    } catch {
      /* ignored here; counted by promoteSlice */
    }
  }
  return earliest;
}

/** The replay CONTEXT a fixture cannot be replayed without.
 *
 *  A capture is not self-describing: the normalizer is constructed around ONE session key
 *  (its isolation gate compares against it) and the bridge seeds the run id it was acked,
 *  neither of which is derivable from the frames unless you know which session was "ours".
 *  Recording it at promotion is what makes the fixture replayable at all — and it is
 *  derived, not guessed: the parent session is the only key with the `:atrium:chat:`
 *  grammar (children carry `:subagent:`), and a slice that does not have EXACTLY one is
 *  refused rather than promoted with an arbitrary pick. */
export function replayContext(rawSlice) {
  const frames = [];
  const acks = [];
  for (const line of rawSlice.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const frame = parsed?.frame ?? parsed;
    if (frame === null || typeof frame !== "object") continue;
    frames.push(frame);
    const payload = frame.payload;
    if (frame.type === "res" && typeof payload?.runId === "string") {
      acks.push(payload.runId);
    }
  }
  // The scenario's OWN turn is the FIRST acked run: the slice begins at the send, so the
  // first response carrying a run id is that send's. Not the session-key grammar, which
  // was the first attempt and picked two keys on `cron-tool` — the bridge mints its own
  // `summarize-…` session on the same chat, with the same grammar, and it is not the turn.
  if (acks.length === 0) {
    throw new Error("slice carries no acked run — nothing identifies the scenario's turn");
  }
  const turnRunId = acks[0];
  const sessions = new Set();
  for (const frame of frames) {
    const payload = frame.payload;
    if (payload?.runId === turnRunId && typeof payload?.sessionKey === "string") {
      sessions.add(payload.sessionKey);
    }
  }
  if (sessions.size !== 1) {
    throw new Error(
      `the acked run ${turnRunId} appears on ${sessions.size} session(s); exactly one is required`,
    );
  }
  const sessionKey = [...sessions][0];
  // Only the acks that belong to THIS session are seeded: a summarize run seeded into the
  // turn's normalizer would be a run it never owned.
  const ackRunIds = acks.filter((runId) =>
    frames.some(
      (f) => f.payload?.runId === runId && f.payload?.sessionKey === sessionKey,
    ),
  );
  return { sessionKey, ackRunIds };
}

/** One scenario slice -> one anonymised fixture body, its stats and its replay context.
 *
 *  The context is minted by the SAME pseudonymiser as the frames. A second mint was the
 *  first version and it produced a corpus that replayed to ZERO events on every scenario:
 *  the recorded session key numbered its tokens independently, so the isolation gate
 *  matched nothing and nine snapshots were vacuously green. */
export function promoteSlice(rawSlice, knownKeys = undefined) {
  const { verbatim: toolNames, renamed: renamedTools } = classifyToolNames(
    harvestToolNames(rawSlice),
  );
  // A renamed tool must read the same EVERYWHERE — on the card, and inside the delivery
  // run id — or the two stop joining, exactly as the UUID grammar did.
  const pseudo = createPseudonymiser(toolNames, renamedTools);
  // Every time in the fixture is an OFFSET from the first frame. An absolute date says
  // when a real conversation happened, and the replay only needs the intervals.
  const epochBase = captureEpochBase(rawSlice);
  const stats = { frames: 0, verbatim: 0, pseudonymised: 0, masked: 0, maskedKeys: 0, unparsable: 0 };
  const lines = [];
  for (const line of rawSlice.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      stats.unparsable += 1;
      continue;
    }
    // Both capture shapes: the `{receivedAt, frame}` envelope, and the bare frame of a
    // pre-2026-07-28 capture. A fixture ALWAYS carries `receivedAt`, null when the source
    // had none — a replay must be able to tell "no arrival time" from "time zero".
    const enveloped =
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.receivedAt === "number" &&
      Object.prototype.hasOwnProperty.call(parsed, "frame");
    const receivedAt =
      enveloped ? parsed.receivedAt - (epochBase ?? parsed.receivedAt) : null;
    const frame = enveloped ? parsed.frame : parsed;
    stats.frames += 1;
    lines.push(
      JSON.stringify({
        receivedAt,
        frame: anonymizeFrame(
          frame,
          pseudo,
          stats,
          knownKeys ?? baseKnownKeys(),
          toolNames,
          epochBase,
          renamedTools,
        ),
      }),
    );
  }
  const raw = replayContext(rawSlice);
  const context = {
    sessionKey: pseudo.identifier(raw.sessionKey),
    ackRunIds: raw.ackRunIds.map((r) => pseudo.identifier(r)),
  };
  return { lines, stats, pseudonyms: pseudo.size(), context };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args.run);
  const reportPath = path.join(runDir, "report.json");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`no report.json in ${runDir} — is that a bench run directory?`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.verdict !== "GO") {
    throw new Error(
      `run verdict is ${JSON.stringify(report.verdict)} — only a GO run may be promoted`,
    );
  }
  const version = report.gatewayVersion;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("report.json carries no gatewayVersion");
  }
  // FAIL CLOSED on the vocabulary: without the manifest for this version the promoter
  // cannot tell a protocol field from an unclassified one, and would mask half the corpus
  // while reporting success.
  const coveragePath = path.join(
    REPO_ROOT,
    "bridge/protocol/openclaw/coverage",
    `${version}.json`,
  );
  if (!fs.existsSync(coveragePath)) {
    throw new Error(
      `no coverage manifest for gateway ${version} (${coveragePath}) — vendor the version first`,
    );
  }
  // …and the DERIVED snapshot artifact beside the schemas: the gateway flattens those
  // field names onto agent events and no schema declares them.
  const snapshotPath = path.join(
    REPO_ROOT,
    "bridge/protocol/openclaw",
    version,
    "session-event-snapshot.json",
  );
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(
      `no session-event-snapshot.json for gateway ${version} — re-vendor the version`,
    );
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const snapshotFields = Array.isArray(snapshot) ? snapshot : (snapshot.fields ?? []);
  if (snapshotFields.length === 0) {
    throw new Error(`${snapshotPath} declares no field`);
  }
  const knownKeys = knownKeysFromCoverage(
    JSON.parse(fs.readFileSync(coveragePath, "utf8")),
    snapshotFields,
  );

  const outDir = path.join(args.out, version);

  const slices = fs
    .readdirSync(runDir)
    .filter((f) => f.startsWith("scenario-") && f.endsWith(".jsonl"));
  if (slices.length === 0) {
    throw new Error(
      `${runDir} has no scenario-*.jsonl slices — re-run the bench with a harness that keeps them`,
    );
  }
  // The capture belongs to the OPENCLAW connection alone. A Hermes scenario's byte range
  // therefore holds whatever OpenClaw emitted during its wall-clock window — real frames,
  // but not that scenario's, and promoting them would file another provider's timeline
  // under a Hermes name. Fail CLOSED when the run predates the provider marker: guessing
  // from the id is how the wrong frames end up in the corpus wearing the right label.
  const providerById = new Map(
    (Array.isArray(report.results) ? report.results : []).map((r) => [r.id, r.provider]),
  );
  if ([...providerById.values()].every((p) => p === undefined)) {
    throw new Error(
      "report.json records no per-scenario provider — re-run the bench with a harness that does",
    );
  }

  // The fidelity gate needs the BUILT bridge. Loaded once, up front, so a missing build
  // stops the promotion before it writes anything rather than half-way through.
  const RunManager = await loadRunManager(path.join(REPO_ROOT, "bridge"));

  const promoted = [];
  const skipped = [];
  const pending = [];
  for (const file of slices.sort()) {
    const id = file.slice("scenario-".length, -".jsonl".length);
    if (!providerById.has(id)) {
      throw new Error(`slice ${file} has no matching result in report.json`);
    }
    const provider = providerById.get(id);
    if (provider !== "openclaw") {
      skipped.push({ id, provider });
      continue;
    }
    const raw = fs.readFileSync(path.join(runDir, file), "utf8");
    const { lines, stats, pseudonyms, context } = promoteSlice(raw, knownKeys);
    if (lines.length === 0) {
      throw new Error(`scenario ${id} promoted to ZERO frames — refusing to write it`);
    }
    // The recorded session key MUST be one the fixture's own frames carry, or the replay
    // silently observes nothing.
    if (!lines.some((l) => l.includes(JSON.stringify(context.sessionKey).slice(1, -1)))) {
      throw new Error(
        `scenario ${id}: the replay session key appears in none of its frames`,
      );
    }
    const header = {
      corpus: "openclaw-golden",
      promoter: PROMOTER_VERSION,
      scenario: id,
      gatewayVersion: version,
      // PROVENANCE without a date. The bench run directory is named by its ISO instant,
      // so recording it published the exact moment of a real capture in every fixture and
      // undid the timestamp rebasing one line above (raised in review). The source hash is
      // the better anchor anyway: it is not reversible, and correlating a candidate run is
      // a re-hash away.
      // The hash of the PUBLISHED body, not of the raw capture. A digest of the source
      // was a presence oracle: anyone holding a candidate capture re-hashes it and
      // confirms it is this fixture's origin, and the source explicitly contains
      // conversation content (raised in review). Hashing what is already public keeps the
      // useful half — detecting a fixture edited by hand or regenerated by other rules —
      // and gives away nothing.
      bodySha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
      sessionKey: context.sessionKey,
      ackRunIds: context.ackRunIds,
      frames: stats.frames,
      strings: {
        verbatim: stats.verbatim,
        pseudonymised: stats.pseudonymised,
        masked: stats.masked,
        maskedKeys: stats.maskedKeys,
      },
      pseudonyms,
    };
    // FIDELITY: the promoted capture must make the reading stack do exactly what the raw
    // one does. Every promotion defect in this lot hid here — a masked field, a broken
    // grammar, a dropped control value — and each was invisible in the fixture itself.
    const rawEntries = parseEntries(raw);
    const promotedEntries = lines.map((l) => JSON.parse(l));
    const diffs = await fidelityDiff(RunManager, rawEntries, promotedEntries);
    if (diffs.length > 0) {
      throw new Error(
        `scenario ${id}: promotion CHANGED how the capture reads —\n  ${diffs.join("\n  ")}`,
      );
    }
    const body = `#${JSON.stringify(header)}\n${lines.join("\n")}\n`;
    // HELD, not written. A later slice can still fail the fidelity gate, and writing as we
    // go left the corpus half-updated behind a refusal — a mix of old and new fixtures
    // that every test would happily replay. The vendoring script learned this the same
    // way; a refusal must change nothing at all.
    pending.push({ file: `${id}.jsonl`, body });
    promoted.push({ id, ...stats, unparsable: stats.unparsable });
  }
  if (promoted.length === 0) {
    throw new Error("no OpenClaw scenario was promoted — the corpus would be empty");
  }
  // Everything validated: write now, all of it — and REPLACE, not merge. A run that drops
  // or renames a scenario used to leave the previous fixture in place, so the replay kept
  // testing a mix of captures from different runs while the output claimed to be one
  // promotion (raised in review). Stale files are named as they are removed.
  fs.mkdirSync(outDir, { recursive: true });
  const keep = new Set(pending.map((p) => p.file));
  const stale = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith(".jsonl") && !keep.has(f));
  for (const file of stale) fs.rmSync(path.join(outDir, file));
  for (const { file, body } of pending) fs.writeFileSync(path.join(outDir, file), body);
  // No silent caps: every scenario, every count, and every skip, printed.
  console.log(`promoted ${promoted.length} scenario(s) -> ${outDir}`);
  for (const s of skipped) {
    console.log(`  (skipped ${s.id}: provider ${s.provider}, not this capture's)`);
  }
  for (const file of stale) {
    console.log(`  (removed ${file}: absent from this run, so never validated by it)`);
  }
  for (const p of promoted) {
    console.log(
      `  ${p.id}: ${p.frames} frames (${p.verbatim} verbatim, ` +
        `${p.pseudonymised} pseudonymised, ${p.masked} masked` +
        `${p.unparsable > 0 ? `, ${p.unparsable} UNPARSABLE line(s) dropped` : ""})`,
    );
  }
}

// Importable for tests; runs only when invoked directly.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
