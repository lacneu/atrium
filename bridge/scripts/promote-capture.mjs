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
//                              { "id": "basic-turn",          // [a-z0-9][a-z0-9-]*, unique
//                                "provider": "openclaw",      // "openclaw" | "hermes"
//                                "violations": [], … }        // REQUIRED, empty on a clean run
//                            ]
//                          }
//   scenario-<id>.jsonl    the frames captured DURING that scenario, one JSON line each,
//                          each `{"receivedAt": <epoch ms>, "connection": <socket id>,
//                          "frame": {"type": …}}` — what the bridge writes under
//                          OPENCLAW_CAPTURE_FRAMES (receivedAt since 2026-07-28, connection
//                          since 2026-09-15). Bare frames are refused: they carry no arrival
//                          time, and any date read inside a frame is one its emitter chose.
//                          A line without a connection is refused too: the gateway sends
//                          every event to every socket the bridge holds and a turn reads one,
//                          so only the frames of the socket its run was acked on are promoted.
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

import { consumedReadings, fidelityDiff, loadReaders, loadRunManager } from "./lib/replay-fidelity.mjs";
import {
  anonymizeFrame,
  baseKnownKeys,
  createPseudonymiser,
  knownKeysFromCoverage,
  reservedPseudonymShapes,
  isEpochMs,
  captureReaderRules,
} from "./lib/anonymize-capture.mjs";

/** Bumped whenever promotion CHANGES the bytes it produces from the same capture. It is
 *  recorded per fixture, so a corpus half-promoted by two different rules is visible
 *  instead of silently mixed. */
export const PROMOTER_VERSION = 5; // 2: pseudonym-shaped raw strings reserved (defect 15); 3: time origin from arrivals only (defect 14); 4: provenance, cron schedule, task bound and lifecycle-error reader leaves kept (defect 13); 5: only the turn's own gateway connection is promoted (defect 19)

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
  // The SAME tool, renamed upstream at 2026.8.1 (`automations-tool-name.ts`; `cron`
  // stays an accepted alias inbound). `cronPartFromTool` reads both, so both must be
  // verbatim here — the corpus caught the omission the same way it caught `cron`:
  // the promoted cron scenario produced no cron card (2026-09-04).
  "automations",
  // Renamed with it: the plan tool `update_plan` became `progress_card` at 2026.8.1.
  // The plan reader accepts both names, and the normalizer keys the delivery-run plan
  // signal on the literal — a masked name silently drops the plan card.
  "progress_card",
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
export function classifyToolNames(names, reserved = new Set()) {
  const verbatim = new Set();
  const renamed = new Map();
  // A FIXED POINT publishes the very name it is meant to hide: a custom tool called
  // `tool_1` that sorts first was handed the alias `tool_1`, so the name came out verbatim
  // while the run counted it as pseudonymised (raised in review). The counter is monotone,
  // so advancing past a collision cannot re-issue an alias.
  // An alias must be disjoint from the WHOLE harvest, not just from the name it replaces.
  // Skipping only the self-collision still republished a real name: `["tool_1","tool_2"]`
  // produced `["tool_2","tool_3"]`, so the raw identifier `tool_2` was in the corpus as
  // someone else's alias, indistinguishable from a pseudonym (raised in review). Every
  // name is known here before the first alias is minted, so the disjunction is exact —
  // unlike the streaming id minter, which cannot see a token it has not read yet.
  const harvested = new Set(names);
  let n = 0;
  for (const name of [...names].sort()) {
    if (BUILT_IN_TOOL_NAMES.has(name)) verbatim.add(name);
    else {
      let alias = `tool_${++n}`;
      // `reserved`: every `tool_<n>` found ANYWHERE in the capture, not only among tool names —
      // a raw `instanceName: "tool_1"` was otherwise handed out as a custom tool's alias (codex).
      while (harvested.has(alias) || reserved.has(alias)) alias = `tool_${++n}`;
      renamed.set(name, alias);
    }
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

/** Parse a slice into its `{receivedAt, frame}` entries — the same envelope captureEpochBase
 *  enforces, which promoteSlice has already applied to this slice, read by ONE connection. */
export function parseEntries(rawSlice) {
  const out = [];
  const connections = new Set();
  let lineNo = 0;
  for (const line of rawSlice.split("\n")) {
    lineNo += 1;
    if (!line.trim() || line.startsWith("#")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    assertCaptureEnvelope(parsed, lineNo);
    connections.add(parsed.connection);
    out.push({ receivedAt: parsed.receivedAt, frame: parsed.frame });
  }
  assertOneConnection(connections);
  return out;
}

/** A turn reads ONE gateway socket (defect 19). A slice spanning several replays copies the
 *  turn never read, so it is refused; turnConnectionSlice keeps the turn's own first. */
function assertOneConnection(connections) {
  if (connections.size > 1) {
    throw new Error(
      `slice spans ${connections.size} gateway connections — a turn reads one; keep the turn's own first (turnConnectionSlice)`,
    );
  }
}

/** The part of a scenario slice the turn's OWN connection read (defect 19).
 *
 *  The bridge holds several gateway sockets at once: each conversation's, and short operator
 *  ones. The gateway broadcasts every event to every operator connection, each with its own
 *  seq (server-broadcast.ts), and sends a run's tool events only to the connection that
 *  started it (server-chat.ts, toolEventRecipients); a conversation reads its own socket
 *  alone (session.ts, `frames()`). Measured on the 2026.9.4 async-task captures of two GO
 *  runs: two connections carried the run, only one of them its tool start and result, and
 *  the other one's final arrived first. Replayed together, the turn ended before the async
 *  tool result it really read.
 *
 *  The turn's connection is the one its acked run arrived on: the first `res` carrying a run
 *  id, the very response replayContext names as the turn. Frames of every other connection
 *  are left out and counted; an unparsable line is kept, so promoteSlice still reports it. */
export function turnConnectionSlice(rawSlice) {
  const lines = [];
  let turnConnection = null;
  let lineNo = 0;
  for (const text of rawSlice.split("\n")) {
    lineNo += 1;
    if (!text.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      lines.push({ text, connection: undefined });
      continue;
    }
    assertCaptureEnvelope(parsed, lineNo);
    lines.push({ text, connection: parsed.connection });
    if (turnConnection === null && parsed.frame.type === "res" && typeof parsed.frame.payload?.runId === "string") {
      turnConnection = parsed.connection;
    }
  }
  if (turnConnection === null) {
    throw new Error("slice carries no acked run — nothing identifies the turn's connection");
  }
  const kept = lines.filter((l) => l.connection === undefined || l.connection === turnConnection);
  return { slice: kept.map((l) => l.text).join("\n"), otherConnectionFrames: lines.length - kept.length };
}

/** The capture's own time origin: its EARLIEST arrival time, and nothing else.
 *
 *  Every line must be a capture envelope (assertCaptureEnvelope). The origin is never read
 *  inside a frame: whatever date a frame carries is one its emitter chose, and an origin an
 *  emitter can choose gives every published offset back by subtraction (defect 14, codex).
 *  The pre-envelope fallback that did read frames is gone with the bare shape itself — none
 *  of the bench's 1547 slices (124 643 lines) and no golden fixture comes from one, measured
 *  2026-09-15.
 *
 *  The EARLIEST, not the first: `Date.now()` is a wall clock, and a clock stepped back during
 *  a scenario must neither refuse the capture nor publish a negative offset. In all 1547
 *  slices the first arrival is also the earliest, so the corpus bytes do not move.
 *
 *  What rebasing on any origin cannot hide, stated rather than implied: the intervals are
 *  kept exact, so whoever independently knows the absolute value of one published timestamp
 *  recovers the origin. The origin only guarantees the corpus itself never supplies it. */
export function captureEpochBase(rawSlice) {
  let base = null;
  const connections = new Set();
  let lineNo = 0;
  for (const line of rawSlice.split("\n")) {
    lineNo += 1;
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // counted by promoteSlice
    }
    assertCaptureEnvelope(parsed, lineNo);
    connections.add(parsed.connection);
    if (base === null || parsed.receivedAt < base) base = parsed.receivedAt;
  }
  assertOneConnection(connections);
  return base;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Refuse any line that is not `{receivedAt: <positive epoch ms>, frame: {type: <string>, …}}`.
 *
 *  The envelope is recognised by its own `frame`, never by the field under validation:
 *  keying it on a numeric `receivedAt` let `"bad"`, `null` or an absent value pass as a bare
 *  frame and skip the check (codex). The frame must be an object with a string `type` — what
 *  every gateway frame is (`res`/`event` on all 124 643 bench lines) — and never an envelope
 *  itself, which would publish a second, un-rebased arrival time one level down (codex). */
function assertCaptureEnvelope(parsed, lineNo) {
  if (!isPlainObject(parsed) || !Object.prototype.hasOwnProperty.call(parsed, "frame")) {
    throw new Error(
      `capture line ${lineNo}: not a {receivedAt, frame} envelope — a bare frame has no arrival time to rebase on`,
    );
  }
  if (!isEpochMs(parsed.receivedAt)) {
    throw new Error(
      `capture line ${lineNo}: receivedAt ${JSON.stringify(parsed.receivedAt)} is not a positive epoch in milliseconds — refusing to rebase timestamps on it`,
    );
  }
  if (typeof parsed.connection !== "string" || parsed.connection.length === 0) {
    throw new Error(
      `capture line ${lineNo}: connection ${JSON.stringify(parsed.connection)} names no socket — the gateway sends every event to every connection and a turn reads one, so a frame from an unknown socket cannot be placed in the turn`,
    );
  }
  const frame = parsed.frame;
  if (!isPlainObject(frame) || typeof frame.type !== "string") {
    throw new Error(`capture line ${lineNo}: frame is not a gateway frame (an object with a string type)`);
  }
  if (Object.prototype.hasOwnProperty.call(frame, "frame")) {
    throw new Error(`capture line ${lineNo}: frame is itself an envelope — refusing a nested capture`);
  }
}

/** The replay CONTEXT a fixture cannot be replayed without.
 *
 *  A capture is not self-describing: the normalizer is constructed around ONE session key
 *  (its isolation gate compares against it) and the bridge seeds the run id it was acked,
 *  neither of which is derivable from the frames unless you know which session was "ours".
 *  Recording it at promotion is what makes the fixture replayable at all — and it is
 *  derived, not guessed: the turn is the FIRST acked run, and the session is the one that
 *  run appears on; a slice where that run spans anything other than EXACTLY one session is
 *  refused rather than promoted with an arbitrary pick.
 *
 *  This doc used to describe the `:atrium:chat:` session-key grammar instead. That was the
 *  first attempt and the body already says why it was abandoned — it picked two keys on
 *  `cron-tool` — so the two sat twenty lines apart contradicting each other (raised in
 *  review). */
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
export function promoteSlice(rawSlice, knownKeys = undefined, readers = undefined, consumed = undefined) {
  // Every pseudonym-shaped string of the capture is reserved BEFORE the first mint, for the
  // tool aliases and for the ids alike, so no pseudonym can equal a raw identifier found
  // elsewhere in it (defect 15).
  const reserved = reservedPseudonymShapes(rawSlice);
  const { verbatim: toolNames, renamed: renamedTools } = classifyToolNames(
    harvestToolNames(rawSlice),
    reserved,
  );
  // A renamed tool must read the same EVERYWHERE — on the card, and inside the delivery
  // run id — or the two stop joining, exactly as the UUID grammar did.
  const pseudo = createPseudonymiser(toolNames, renamedTools, reserved);
  // Every time in the fixture is an OFFSET from the earliest arrival. An absolute date says
  // when a real conversation happened, and the replay only needs the intervals.
  const epochBase = captureEpochBase(rawSlice);
  const stats = { frames: 0, verbatim: 0, pseudonymised: 0, masked: 0, maskedKeys: 0, unparsable: 0 };
  // Parsed ONCE: the rules a whole capture decides (the cron card is built from a start and a
  // result frame) are keyed on these very objects.
  const entries = [];
  for (const line of rawSlice.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      stats.unparsable += 1;
    }
  }
  const sharedRules = captureReaderRules(entries, readers, consumed);
  const lines = [];
  for (const parsed of entries) {
    // captureEpochBase has already refused any line that is not a well-formed envelope, so
    // every line here is one, and its offset from the earliest arrival is never negative.
    const receivedAt = parsed.receivedAt - epochBase;
    const frame = parsed.frame;
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
          readers,
          sharedRules,
          consumed,
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

/**
 * Which slices a run may promote, decided from the run's OWN report before any slice is
 * read or any output is written — pure, so the refusals below are tested directly.
 *
 * TWO completeness gaps used to let a PARTIAL capture through (defect 16). The promoter
 * checked that every slice had a result, never that every OpenClaw result had a slice:
 * a GO report of ten results beside one slice promoted one fixture, then REMOVED the nine
 * others as stale — the corpus shrank behind an attested run. And the provider guard only
 * refused when EVERY result lacked a provider, so one marked result let the unmarked ones
 * be read as non-OpenClaw and skipped in silence.
 *
 * A result with no slice is legitimate only off the OpenClaw capture: a bridge-only HTTP
 * check (hermes-cron-list) records a result and no frames. Measured on the full-catalogue
 * run 2026-09-15T09-19-29-704Z: every OpenClaw result had its slice.
 */
export function planPromotion(results, sliceFiles) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) {
    throw new Error("report.json records no scenario result — nothing to check the slices against");
  }
  // The scenario id names the fixture file and the slice: an empty or odd one would
  // write `.jsonl` and leave every real fixture looking stale (codex). Every id recorded by
  // the bench so far matches this grammar (26 across all runs, checked 2026-09-15).
  const badIds = list.filter((r) => typeof r?.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(r.id));
  if (badIds.length > 0) {
    throw new Error(
      `report.json records scenario id(s) outside [a-z0-9][a-z0-9-]*: ${badIds.map((r) => JSON.stringify(r?.id)).join(", ")}`,
    );
  }
  // An id seen twice is refused before any Map is built: a Map keeps the LAST provider,
  // so `basic-turn` recorded as openclaw then as hermes read as hermes and its fixture was
  // removed as stale (codex).
  const seen = new Set();
  const duplicated = new Set();
  for (const r of list) {
    if (seen.has(r?.id)) duplicated.add(r?.id);
    seen.add(r?.id);
  }
  if (duplicated.size > 0) {
    throw new Error(`report.json records scenario id(s) more than once: ${[...duplicated].join(", ")}`);
  }
  // A FAILED scenario inside a GO report is refused too: GO is meant to imply every scenario
  // ran clean (bench-attestation.test.ts holds the same rule), and a result carrying
  // violations is not a capture worth publishing whatever the verdict line says.
  const failed = list
    .filter((r) => !Array.isArray(r?.violations) || r.violations.length > 0)
    .map((r) => r?.id);
  if (failed.length > 0) {
    throw new Error(
      `report.json records scenario(s) with violations, or no violations list: ${failed.join(", ")} — not a clean run`,
    );
  }
  // A CLOSED provider domain (bridge/src/server.ts CapabilityTarget.provider): anything
  // else — a typo, an empty string — was skipped like Hermes, and its OpenClaw fixture
  // then removed as stale (codex).
  const unmarked = list
    .filter((r) => r?.provider !== "openclaw" && r?.provider !== "hermes")
    .map((r) => r?.id);
  if (unmarked.length > 0) {
    throw new Error(
      `report.json records no known provider ("openclaw" | "hermes") for ${unmarked.join(", ")} — re-run the bench with a harness that does`,
    );
  }
  const providerById = new Map(list.map((r) => [r.id, r.provider]));
  const sliceIds = sliceFiles
    .map((f) => f.slice("scenario-".length, -".jsonl".length))
    .sort();
  for (const id of sliceIds) {
    if (!providerById.has(id)) {
      throw new Error(`slice scenario-${id}.jsonl has no matching result in report.json`);
    }
  }
  const sliced = new Set(sliceIds);
  const missing = list
    .filter((r) => r.provider === "openclaw" && !sliced.has(r.id))
    .map((r) => r.id);
  if (missing.length > 0) {
    throw new Error(
      `OpenClaw result(s) with no slice: ${missing.join(", ")} — promoting this PARTIAL capture would delete their fixtures as stale`,
    );
  }
  return {
    openclaw: sliceIds.filter((id) => providerById.get(id) === "openclaw"),
    skipped: sliceIds
      .filter((id) => providerById.get(id) !== "openclaw")
      .map((id) => ({ id, provider: providerById.get(id) })),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
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
  const plan = planPromotion(report.results, slices);

  // The fidelity gate needs the BUILT bridge. Loaded once, up front, so a missing build
  // stops the promotion before it writes anything rather than half-way through.
  const RunManager = await loadRunManager(path.join(REPO_ROOT, "bridge"));
  // …and the readers that decide which reader-consumed values promotion keeps, from the SAME
  // build: the positions kept and the gate that checks them cannot disagree about a reader.
  const readers = await loadReaders(path.join(REPO_ROOT, "bridge"));

  const promoted = [];
  const skipped = plan.skipped;
  const pending = [];
  for (const id of plan.openclaw) {
    const file = `scenario-${id}.jsonl`;
    const capture = fs.readFileSync(path.join(runDir, file), "utf8");
    // The turn's OWN connection, before anything reads the slice (defect 19): the anonymiser,
    // the replay context and both sides of the fidelity gate all see what the turn read, and
    // never another socket's copy of it.
    const { slice: raw, otherConnectionFrames } = turnConnectionSlice(capture);
    // What the reading stack CONSUMES from this capture, from the same replay the fidelity gate
    // runs: a reader-consumed value is kept only for a reading that replay wrote.
    const rawEntries = parseEntries(raw);
    const consumed = await consumedReadings(RunManager, rawEntries, readers);
    const { lines, stats, pseudonyms, context } = promoteSlice(raw, knownKeys, readers, consumed);
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
    promoted.push({ id, ...stats, otherConnectionFrames });
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
        `${p.unparsable > 0 ? `, ${p.unparsable} UNPARSABLE line(s) dropped` : ""}` +
        `${p.otherConnectionFrames > 0 ? `, ${p.otherConnectionFrames} frame(s) of other gateway connections left out` : ""})`,
    );
  }
}

// Importable for tests; runs only when invoked directly.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
