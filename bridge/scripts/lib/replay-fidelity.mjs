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

/** Records only WHICH writes happen, and their protocol-shaped detail. Text lengths are
 *  deliberately excluded: masking preserves them for streamed text but not inside a
 *  re-serialised JSON blob, and the question here is whether the same READINGS happen. */
function recorder() {
  const calls = [];
  const handler = {
    get: (_t, name) => {
      if (name === "then") return undefined;
      if (name === "emitRehydrateTrace") return () => {};
      return async (...args) => {
        const detail = describe(String(name), args);
        calls.push(detail === null ? String(name) : `${String(name)}:${detail}`);
        if (name === "startAssistant") return "m1";
        if (name === "setSnapshot" || name === "addMedia") return true;
        if (name === "getRehydrationContext") return { history: null, turnCount: 0 };
        return undefined;
      };
    },
  };
  return { calls, writer: new Proxy({}, handler) };
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
    return Object.entries(part)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k]) => k)
      .sort()
      .join("+");
  }
  if (name === "upsertSubAgent") {
    return `${args[0]?.kind ?? "?"}/${args[0]?.status ?? "?"}`;
  }
  if (name === "finalize") return String(args[1] ?? "?");
  return null;
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
  const { calls, writer } = recorder();
  const manager = new RunManager("fidelity", sessionKey, writer);
  const base = entries.find((e) => typeof e.receivedAt === "number")?.receivedAt ?? 0;
  const at = (e, i) =>
    typeof e.receivedAt === "number" ? 1000 + (e.receivedAt - base) / 1000 : 1000 + i * 0.01;
  let now = at(entries[0] ?? {}, 0);
  // The pre-ack window, exactly as the golden replay does it: arm, then open the turn at
  // the ack. Both sides of the comparison use it, so the check stays about promotion —
  // but describing production faithfully is the point of the whole exercise.
  const ackIndex = entries.findIndex(
    (e) => e.frame?.type === "res" && e.frame?.payload?.runId === turnRun,
  );
  manager.armReplayBuffer();
  let opened = ackIndex < 0;
  if (opened) await manager.beginTurn(now, turnRun);
  for (let i = 0; i < entries.length; i++) {
    const arrival = at(entries[i], i);
    if (!opened && i === ackIndex) {
      await manager.beginTurn(arrival, turnRun);
      opened = true;
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
  return calls;
}

/** Compare the readings of a raw slice and its promoted form. Returns a list of
 *  differences — empty means promotion changed nothing the reading stack notices. */
export async function fidelityDiff(RunManager, rawEntries, promotedEntries) {
  const before = await replay(RunManager, rawEntries);
  const after = await replay(RunManager, promotedEntries);
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
