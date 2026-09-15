// FIDELITY CHECK for promoted captures (W11/G4).
//
// Anonymisation must change what a capture SAYS and nothing about what Atrium MAKES of
// it. Every promotion defect in this lot had the same shape — a field masked, a grammar
// broken, a control value dropped — and every one of them was invisible in the fixture:
// the corpus replayed green while covering less than it claimed.
//
//   the async ack   `details.async` masked        -> engagement never opened
//   the delivery    UUID grammar broken           -> engagement never settled
//   media           `mediaUrls` masked            -> no media delivered
//   the cron card   `action: "add"` masked        -> no cron part
//
// So the promoter replays BOTH the raw slice and its promoted form through the real
// reading stack and compares what each would have written. A divergence is a promotion
// defect, and promotion REFUSES rather than committing a fixture that proves less than
// its source.
//
// The raw slice never leaves the operator's machine: only the comparison happens here.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { maskText, readingsLedger } from "./anonymize-capture.mjs";

/** The newest mtime under a directory tree, or 0 when it does not exist. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/** Refuse a build older than the sources it was made from.
 *
 *  The promoter validates fixtures against the COMPILED bridge while the golden tests
 *  replay them against the SOURCES. A forgotten rebuild after a normalizer change means
 *  the two disagree and the fidelity guarantee is void — silently (raised in review). */
function assertFreshBuild(bridgeDir) {
  const src = newestMtime(path.join(bridgeDir, "src"));
  const dist = newestMtime(path.join(bridgeDir, "dist"));
  if (dist === 0) return; // absent: the import below reports it with the right message
  if (src > dist) {
    throw new Error(
      "the built bridge is OLDER than its sources — the fidelity check would validate " +
        "against a stale RunManager while the golden tests replay against the current " +
        "one. Run `npm run build` in bridge/ first.",
    );
  }
}

/** Load the built RunManager. The promoter runs from a checkout, so `dist` is the
 *  compiled bridge; a missing build is a REFUSAL, not a skipped check — a fidelity gate
 *  that quietly does nothing is the silence it exists to replace. */
export async function loadRunManager(bridgeDir) {
  assertFreshBuild(bridgeDir);
  const url = pathToFileURL(
    `${bridgeDir}/dist/providers/openclaw/run-manager.js`,
  ).href;
  try {
    const mod = await import(url);
    if (typeof mod.RunManager !== "function") {
      throw new Error("dist exports no RunManager");
    }
    return mod.RunManager;
  } catch (err) {
    throw new Error(
      `cannot load the built bridge for the fidelity check (${bridgeDir}/dist) — ` +
        `run \`npm run build\` in bridge/ first. Cause: ${err?.message ?? err}`,
    );
  }
}

/** Load the readers promotion consults to keep reader-consumed values (anonymize-capture.mjs
 *  `captureReaderRules`), from the same build as the RunManager. A missing export is a refusal. */
export async function loadReaders(bridgeDir) {
  assertFreshBuild(bridgeDir);
  const load = async (rel) => import(pathToFileURL(`${bridgeDir}/dist/${rel}`).href);
  try {
    const provenance = await load("core/provenance.js");
    const asyncTask = await load("core/async-task.js");
    const cron = await load("core/cron-part.js");
    const readers = {
      isProvenanceStream: provenance.isProvenanceStream,
      parseProvenanceFrame: provenance.parseProvenanceFrame,
      parseProvenanceReport: provenance.parseProvenanceReport,
      MAX_PROVENANCE_ITEMS: provenance.MAX_PROVENANCE_ITEMS,
      asyncTaskStartFromTool: asyncTask.asyncTaskStartFromTool,
      isCronTool: cron.isCronTool,
      taskChildKey: asyncTask.taskChildKey,
      cronPartFromTool: cron.cronPartFromTool,
      printableCronSchedule: cron.printableCronSchedule,
    };
    for (const [k, v] of Object.entries(readers)) {
      if (v === undefined) throw new Error(`dist exports no ${k}`);
    }
    return readers;
  } catch (err) {
    throw new Error(
      `cannot load the built readers (${bridgeDir}/dist) — run \`npm run build\` in bridge/ first. Cause: ${err?.message ?? err}`,
    );
  }
}

/** Records only WHICH writes happen, and their protocol-shaped detail. Text lengths are
 *  deliberately excluded: masking preserves them for streamed text but not inside a
 *  re-serialised JSON blob, and the question here is whether the same READINGS happen. */
function recorder(feeding = () => null) {
  const calls = [];
  // The writes themselves too — `consumedReadings` needs what was written, not its shape.
  const writes = [];
  const handler = {
    get: (_t, name) => {
      if (name === "then") return undefined;
      if (name === "emitRehydrateTrace") return () => {};
      return async (...args) => {
        // …tagged with the entry being FED when the write happened (null outside a feed):
        // a write with no reference to its frame is attributed by that tag.
        writes.push([String(name), args, feeding()]);
        const detail = describe(String(name), args);
        calls.push(detail === null ? String(name) : `${String(name)}:${detail}`);
        if (name === "startAssistant") return "m1";
        if (name === "setSnapshot" || name === "addMedia") return true;
        if (name === "getRehydrationContext") return { history: null, turnCount: 0 };
        return undefined;
      };
    },
  };
  return { calls, writes, writer: new Proxy({}, handler) };
}

/** The fields of an object that are SET — the shape of a card, never its content. */
function setKeys(o) {
  if (o === null || typeof o !== "object") return "-";
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k]) => k)
    .sort()
    .join("+");
}

/** Which schedule a cron card prints (`printableCronSchedule`, core/cron-part.ts), as SHAPE:
 *  the branch word, then the rest through the anonymiser's own `maskText` — so a masked value
 *  compares equal to its raw form while a lost time zone, a lost expression token or a masked
 *  bare kind does not. A parenthesised suffix is no evidence of a zone (an expression may carry
 *  one, codex). `every` is its branch alone: its interval is a number promotion masks. */
const CRON_BARE_KINDS = new Set(["at", "every", "cron", "on-exit", "stream"]);
function scheduleShape(schedule) {
  const branch = /^(cron|at|every) /.exec(schedule)?.[1];
  if (branch === "every") return branch;
  if (branch !== undefined) return `${branch}:${maskText(schedule.slice(branch.length + 1))}`;
  return CRON_BARE_KINDS.has(schedule) ? `kind:${schedule}` : `other:${maskText(schedule)}`;
}

/** The protocol-shaped part of a write: what the reading stack DECIDED, never content. */
function describe(name, args) {
  if (name === "startAssistant") {
    const runId = args[1];
    if (typeof runId !== "string") return "none";
    if (runId.startsWith("announce:")) return "announce";
    if (runId.startsWith("inject-")) return "inject";
    if (/:.+:(ok|error)$/.test(runId)) return "task-delivery";
    return "turn";
  }
  if (name === "addToolPart") return String(args[1]?.kind ?? "?");
  // The SHAPE of a card, not just its existence. Counting `addCronPart` could not see a
  // card that had lost every field it is made of (raised in review) — the promotion
  // degraded the reading and the gate called it identical.
  if (name === "addCronPart" || name === "addPlanPart") {
    const part = args[1];
    if (part === null || typeof part !== "object") return "empty";
    const fields = setKeys(part);
    // …and for a cron card, WHICH schedule it prints. The keys alone called
    // `"cron 0 5 1 1 * (UTC)"` and `"xxxx"` identical — both set a schedule (defect 13).
    if (name === "addCronPart" && typeof part.schedule === "string") {
      return `${fields}:schedule=${scheduleShape(part.schedule)}`;
    }
    return fields;
  }
  // A provenance part by its SHAPE: counting the write could not see a report that lost
  // its items' leaves, or its injected/retrieval detail, while still being written.
  if (name === "addProvenancePart") {
    const part = args[1];
    if (part === null || typeof part !== "object") return "empty";
    const items = Array.isArray(part.items) ? part.items.map(setKeys).join("|") : "-";
    const truncated = typeof part.injected?.truncated === "boolean" ? `:truncated=${part.injected.truncated}` : "";
    return `${part.group ?? "?"}:v${part.v ?? "?"}:${setKeys(part)}:items=${items}:injected=${setKeys(part.injected)}${truncated}:retrieval=${setKeys(part.retrieval)}`;
  }
  if (name === "upsertSubAgent") {
    // A task's declared bound is the row's only deadline tighter than the 24 h net — its
    // VALUE is the deadline, so the value is compared, not its presence (codex).
    const declared =
      args[0]?.declaredTimeoutMs !== undefined ? `/declared-timeout=${args[0].declaredTimeoutMs}` : "";
    return `${args[0]?.kind ?? "?"}/${args[0]?.status ?? "?"}${declared}`;
  }
  // The failure CLASS too: a turn that ended `error` as `context_length` and one that ended
  // `error` unclassified are different readings (writer.finalize's errorKind argument).
  if (name === "finalize") {
    return `${String(args[1] ?? "?")}${typeof args[4] === "string" ? `:${args[4]}` : ""}`;
  }
  return null;
}

/** Where a replay arms the pre-ack buffer and opens each acked turn of a capture.
 *
 *  Production arms the buffer right before `chat.send` and opens the turn at its ack
 *  (server.ts: armReplayBuffer, then beginTurn with the acked run id), once PER SEND. A capture
 *  can hold several sends on the replayed session — announce-reverse-hold holds the user's
 *  reply behind a delivery, then sends it — and opening only the first left every later turn
 *  unread: its frames fed an idle manager and wrote nothing (codex).
 *
 *  The first turn is armed at the start of the capture, which begins at its send. A later
 *  send's request is not in the capture, so its buffer is armed at the earliest frame proven to
 *  follow that request: the first frame of its own run on the replayed session, else its ack.
 *  A frame of another run arriving between the real request and that point is not placed in
 *  the buffer — stated, not solved: nothing in the capture dates the request. */
export function turnOpenings(frames, ackRunIds, sessionKey) {
  const openings = [];
  let after = -1;
  for (const [k, runId] of ackRunIds.entries()) {
    const ackIndex = frames.findIndex(
      (f, i) => i > after && f?.type === "res" && f?.payload?.runId === runId,
    );
    let armIndex = k === 0 ? 0 : ackIndex;
    if (k > 0 && ackIndex >= 0) {
      const raced = frames.findIndex(
        (f, i) =>
          i > after &&
          i < ackIndex &&
          f?.type === "event" &&
          f?.payload?.runId === runId &&
          f?.payload?.sessionKey === sessionKey,
      );
      if (raced >= 0) armIndex = raced;
    }
    if (k > 0 && ackIndex < 0) continue;
    openings.push({ runId, armIndex, ackIndex });
    if (ackIndex >= 0) after = ackIndex;
  }
  return openings;
}

/** Replay one capture (already parsed into `{receivedAt, frame}` entries). */
async function replay(RunManager, entries) {
  const frames = entries.map((e) => e.frame);
  const acks = frames
    .filter((f) => f?.type === "res" && typeof f?.payload?.runId === "string")
    .map((f) => f.payload.runId);
  const turnRun = acks[0] ?? null;
  const sessionKey =
    frames.find(
      (f) => f?.payload?.runId === turnRun && typeof f?.payload?.sessionKey === "string",
    )?.payload?.sessionKey ?? null;
  // Every send of the replayed session, as promotion records them (replayContext): the first
  // acked run, then each later ack whose run appears on that session. A run of another session
  // (the bridge's own summarize run) is another manager's turn, never this one's.
  const openings = turnOpenings(
    frames,
    turnRun === null
      ? []
      : [
          turnRun,
          ...acks
            .slice(1)
            .filter((runId) => frames.some((f) => f?.payload?.runId === runId && f?.payload?.sessionKey === sessionKey)),
        ],
    sessionKey,
  );
  // The entry each write is attributed to: the frame being fed — including a frame the manager
  // RE-feeds itself (an announce buffered during the turn is replayed with `this.feed` at the
  // terminal, run-manager.ts) — found by identity, innermost feed first (codex).
  const entryOf = new Map(entries.map((entry, index) => [entry.frame, index]));
  const feeding = [];
  // A write outside any feed can still belong to a run: the provenance the manager stashed before
  // the ack is written while the turn OPENS (run-manager.ts beginTurn, flushed for the acked run).
  let opening = null;
  const { calls, writes, writer } = recorder(() =>
    feeding.length > 0 ? { entry: feeding[feeding.length - 1], run: null } : { entry: null, run: opening },
  );
  const manager = new RunManager("fidelity", sessionKey, writer);
  const tagged = (fn) => async (frame, at) => {
    feeding.push(entryOf.get(frame) ?? null);
    try {
      return await fn(frame, at);
    } finally {
      feeding.pop();
    }
  };
  manager.feed = tagged(manager.feed.bind(manager));
  // The FRAME each provenance part was read from, by reference. The normalizer turns a report
  // frame into `{type: "provenance", part}` and the sink hands that very `part` to the writer
  // (turn-sink.ts addProvenancePart), so the part object names its frame — whichever path fed it:
  // the manager's feed, a stashed announce re-fed, or a frame that raced the ack and is replayed
  // straight into the normalizer as the turn opens (run-manager.ts beginTurn). `normalizer.feed`
  // is synchronous and returns the events, so the wrapper stays synchronous.
  const partEntry = new WeakMap();
  if (typeof manager.normalizer?.feed === "function") {
    const normalizerFeed = manager.normalizer.feed.bind(manager.normalizer);
    manager.normalizer.feed = (frame, at) => {
      const events = normalizerFeed(frame, at);
      const index = entryOf.get(frame);
      if (index !== undefined && Array.isArray(events)) {
        for (const event of events) {
          if (event?.type === "provenance" && event.part !== null && typeof event.part === "object") {
            partEntry.set(event.part, index);
          }
        }
      }
      return events;
    };
  }
  const base = entries.find((e) => typeof e.receivedAt === "number")?.receivedAt ?? 0;
  const at = (e, i) =>
    typeof e.receivedAt === "number" ? 1000 + (e.receivedAt - base) / 1000 : 1000 + i * 0.01;
  let now = at(entries[0] ?? {}, 0);
  // The pre-ack window, exactly as the golden replay does it: arm, then open the turn at
  // the ack. Both sides of the comparison use it, so the check stays about promotion —
  // but describing production faithfully is the point of the whole exercise.
  manager.armReplayBuffer();
  const first = openings[0];
  if (first === undefined || first.ackIndex < 0) {
    opening = first?.runId ?? turnRun;
    await manager.beginTurn(now, opening);
    opening = null;
  }
  for (let i = 0; i < entries.length; i++) {
    const arrival = at(entries[i], i);
    for (const [k, turn] of openings.entries()) {
      if (k > 0 && turn.armIndex === i) manager.armReplayBuffer();
      if (turn.ackIndex === i) {
        opening = turn.runId;
        await manager.beginTurn(arrival, turn.runId);
        opening = null;
      }
    }
    for (let step = 0; step < 64; step++) {
      const remaining = manager.nextTimeout(now);
      if (remaining === null) break;
      const fires = now + remaining + 0.001;
      if (fires > arrival) break;
      now = fires;
      await manager.tick(now);
    }
    now = arrival;
    await manager.feed(entries[i].frame, now);
  }
  for (let step = 0; step < 64; step++) {
    const remaining = manager.nextTimeout(now);
    if (remaining === null) break;
    now += remaining + 0.001;
    await manager.tick(now);
  }
  // The SAME settle the golden replay performs. Without it a capture ending on pure recv
  // silence finalizes in neither replay, so an anonymisation that removed or invented
  // that termination read as faithful — the gate agreeing with itself about nothing
  // (raised in review).
  if (manager.turnActive && manager.takeRecvSilence()) {
    await manager.endTurn(now, "final", null, "recv_timeout");
  }
  return { calls, writes, sessionKey, partEntry };
}

/** Compare the readings of a raw slice and its promoted form. Returns a list of
 *  differences — empty means promotion changed nothing the reading stack notices. */
export async function fidelityDiff(RunManager, rawEntries, promotedEntries) {
  const { calls: before } = await replay(RunManager, rawEntries);
  const { calls: after } = await replay(RunManager, promotedEntries);
  const count = (calls) => {
    const m = new Map();
    for (const c of calls) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  const diffs = [];
  for (const key of new Set([...a.keys(), ...b.keys()].sort())) {
    const got = b.get(key) ?? 0;
    const want = a.get(key) ?? 0;
    if (got !== want) diffs.push(`${key}: raw ${want}, promoted ${got}`);
  }
  // …and the SEQUENCE. Write order is semantic — a card updated after a finalize is a
  // different reading from the same card updated before it — and comparing frequencies
  // alone accepted any permutation (raised in review).
  if (diffs.length === 0) {
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (before[i] !== after[i]) {
        diffs.push(
          `write #${i + 1} differs: raw ${before[i] ?? "(none)"}, promoted ${after[i] ?? "(none)"}`,
        );
        break;
      }
    }
  }
  return diffs;
}

/** Every object of the raw entries -> its path (`[entryIndex, key, …]`). JSON.parse yields a tree,
 *  so a path is unique and resolves identically in any other parse of the same lines. */
function pathIndex(entries) {
  const paths = new WeakMap();
  const walk = (node, path) => {
    if (node === null || typeof node !== "object" || paths.has(node)) return;
    paths.set(node, path);
    for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
  };
  entries.forEach((entry, index) => walk(entry, [index]));
  return paths;
}

/** What the reading stack CONSUMES from a raw capture, from the replay the gate runs: each
 *  provenance part it writes with the run it belongs to, and each cron card and each declared-timeout task engagement with
 *  the raw objects it was read from. The sink writes a completed tool part with the event's
 *  `input`/`output` BY REFERENCE right before the card and the engagement it derives from them
 *  (turn-sink.ts), so those references attribute each reading to the frames the normalizer really
 *  admitted and coalesced. Without `readers`, only provenance parts are collected. */
export async function consumedReadings(RunManager, rawEntries, readers) {
  const { writes, sessionKey, partEntry } = await replay(RunManager, rawEntries);
  const paths = pathIndex(rawEntries);
  const provenanceReads = [];
  const cronReads = [];
  const taskReads = [];
  const errorReads = [];
  let completed = null;
  // The run of the bubble parts are currently written into.
  let bubbleRun = null;
  for (const [name, args, tag] of writes) {
    const fedEntry = tag?.entry ?? null;
    if (name === "startAssistant") {
      bubbleRun = typeof args[1] === "string" && args[1].length > 0 ? args[1] : null;
      continue;
    }
    if (name === "addToolPart") {
      completed = args[1]?.phase === "completed" ? args[1] : null;
      continue;
    }
    if (name === "addProvenancePart") {
      const part = JSON.stringify(args[1]);
      // EXACT when the normalizer produced this part from a frame of the capture (see partEntry).
      // Otherwise it came from the manager's pre-turn STASH (`parseProvenanceFrame`, rebuilt outside
      // the normalizer) and is written into the bubble of ITS run: the run of the last
      // `startAssistant` — not of the frame being fed, whose runId may be empty (codex).
      const entry = partEntry.get(args[1]);
      if (entry !== undefined) {
        provenanceReads.push({ entry, part });
      } else {
        provenanceReads.push({ run: bubbleRun ?? tag?.run ?? null, part });
      }
      continue;
    }
    if (name === "finalize") {
      // The class a turn closed with, attributed to the entry whose feed closed it.
      if (typeof args[4] === "string" && fedEntry !== null) {
        errorReads.push({ entry: fedEntry, errorKind: args[4] });
      }
      continue;
    }
    if (readers == null || completed === null) continue;
    if (name === "addCronPart") {
      cronReads.push({
        name: completed.name,
        input: paths.get(completed.input),
        output: paths.get(completed.output),
        card: JSON.stringify(args[1]),
      });
    } else if (name === "upsertSubAgent" && args[0]?.declaredTimeoutMs !== undefined) {
      taskReads.push({
        name: completed.name,
        output: paths.get(completed.output),
        declaredTimeoutMs: args[0].declaredTimeoutMs,
        childSessionKey: args[0].childSessionKey,
      });
    }
  }
  return readingsLedger({ sessionKey, provenanceReads, cronReads, taskReads, errorReads });
}
