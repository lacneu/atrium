/**
 * The golden corpus and its replay driver, shared by the suites that replay real captures
 * (golden-replay.test.ts pins the interpretation; live-text-authority.test.ts replays the
 * same captures against a writer that enforces Convex's anti-regression guard).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { taskDeliveryRunFromRunId } from "../../src/core/async-task.js";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { turnOpenings } from "../../scripts/lib/replay-fidelity.mjs";
import { RunManager } from "../../src/providers/openclaw/run-manager.js";
import { LiveTextBaselines } from "../../src/providers/openclaw/live-text-baseline.js";
import type { GatewayFrame } from "../../src/providers/openclaw/openclaw-client.js";
import type { ConvexWriter, FinalizeStatus, ToolPart } from "../../src/convex-writer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = resolve(__dirname, "../fixtures/golden");

export interface FixtureHeader {
  corpus: string;
  promoter: number;
  scenario: string;
  gatewayVersion: string;
  bodySha256: string;
  frames: number;
  sessionKey: string;
  ackRunIds: string[];
}

export interface Fixture {
  version: string;
  file: string;
  header: FixtureHeader;
  entries: { receivedAt: number | null; frame: unknown }[];
}

export function loadCorpus(): Fixture[] {
  if (!existsSync(CORPUS_ROOT)) return [];
  const out: Fixture[] = [];
  for (const version of readdirSync(CORPUS_ROOT).sort()) {
    const dir = join(CORPUS_ROOT, version);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".jsonl")) continue;
      const lines = readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter((l) => l.trim());
      const header = JSON.parse(lines[0]!.slice(1)) as FixtureHeader;
      // INTEGRITY, checked rather than merely recorded. A hash nobody compares is a
      // promise, and a hand-edited fixture would sail past frame counts and snapshots
      // (raised in review).
      const body = lines.slice(1).join("\n");
      const digest = createHash("sha256").update(body).digest("hex");
      if (digest !== header.bodySha256) {
        throw new Error(
          `${version}/${file}: body hash ${digest} does not match the header ` +
            `(${header.bodySha256}) — the fixture was edited or partly regenerated`,
        );
      }
      const entries = lines.slice(1).map((l) => JSON.parse(l));
      out.push({ version, file, header, entries });
    }
  }
  return out;
}


/** Records what Atrium WOULD have written. Every call is captured — including the ones
 *  the announce, task-engagement and plan paths make, which is the point of replaying
 *  above the normalizer. */
export class RecordingWriter implements ConvexWriter {
  readonly calls: { call: string; detail?: Record<string, unknown> }[] = [];
  private nextId = 1;
  async startAssistant(_chatId: string, runId: string | null): Promise<string> {
    const id = `msg${this.nextId++}`;
    this.calls.push({ call: "startAssistant", detail: { runFamily: family(runId) } });
    return id;
  }
  async appendDelta(_m: string, text: string): Promise<void> {
    this.calls.push({ call: "appendDelta", detail: { length: text.length } });
  }
  async setSnapshot(_m: string, text: string): Promise<boolean> {
    this.calls.push({ call: "setSnapshot", detail: { length: text.length } });
    return true;
  }
  async addToolPart(_m: string, part: ToolPart): Promise<void> {
    this.calls.push({ call: "addToolPart", detail: { kind: part.kind, name: part.name } });
  }
  async addCompactionPart(): Promise<void> {
    this.calls.push({ call: "addCompactionPart" });
  }
  async recordGatewayPressure(): Promise<void> {}
  async addWidgetPart(): Promise<boolean> {
    this.calls.push({ call: "addWidgetPart" });
    return true;
  }
  async addProvenancePart(): Promise<void> {
    this.calls.push({ call: "addProvenancePart" });
  }
  async addMedia(): Promise<boolean> {
    this.calls.push({ call: "addMedia" });
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {
    this.calls.push({ call: "noteMediaUndelivered" });
  }
  async finalize(_m: string, status: FinalizeStatus, text: string): Promise<void> {
    this.calls.push({ call: "finalize", detail: { status, length: text.length } });
  }
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionRoster(): Promise<void> {}
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(row: unknown): Promise<void> {
    const r = row as { kind?: string; status?: string; taskName?: string };
    this.calls.push({
      call: "upsertSubAgent",
      detail: { kind: r.kind ?? null, status: r.status ?? null, task: r.taskName ?? null },
    });
  }
  async upsertSubAgentToolPart(): Promise<void> {
    this.calls.push({ call: "upsertSubAgentToolPart" });
  }
  // OPTIONAL on the interface, and therefore silently absent from a naive fake — which
  // is how the first version of this suite reported "no plan card" for a capture that
  // produced one: the sink called a method the recorder did not have.
  async addPlanPart(_m: string, part: unknown): Promise<void> {
    const p = part as { kind?: string; steps?: unknown[] };
    this.calls.push({
      call: "addPlanPart",
      detail: { steps: Array.isArray(p.steps) ? p.steps.length : null },
    });
  }
  async advancePlanPart(): Promise<void> {
    this.calls.push({ call: "advancePlanPart" });
  }
  async addCronPart(): Promise<void> {
    this.calls.push({ call: "addCronPart" });
  }
  async settleAnnouncedChild(): Promise<void> {
    this.calls.push({ call: "settleAnnouncedChild" });
  }
  async setPhase(): Promise<void> {}
  async updateRunId(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

/** Run ids carry identity; only their FAMILY is protocol. Pinning the family keeps the
 *  snapshot stable across re-promotions while still proving which lane opened a bubble. */
export function family(runId: string | null): string {
  if (runId === null) return "none";
  if (runId.startsWith("announce:")) return "announce";
  if (runId.startsWith("inject-")) return "inject";
  // The SHARED reader, never a private regex: this helper carried its own
  // `/:.+:ok$/`, which stopped matching when 2026.8.1 appended the delivery lane
  // (`…:ok:agent-loop`) — a fourth copy of the same grammar, drifting on its own.
  if (taskDeliveryRunFromRunId(runId) !== null) return "task-delivery";
  return "turn";
}

/** Advance a manager past every deadline it has armed, and return the resulting clock.
 *
 *  `nextTimeout(now)` returns the SECONDS REMAINING, not an absolute time. Treating it as
 *  a timestamp (`Math.max(now, next)`) moved the clock by one millisecond per iteration —
 *  the loop looked like it drained the deadlines and drained nothing (raised in review).
 *  Exported so that mistake has a test of its own rather than hiding in a replay that is
 *  green either way. */
export async function drainDeadlines(
  manager: { nextTimeout(now: number): number | null; tick(now: number): Promise<void> },
  from: number,
  maxSteps = 64,
  until = Number.POSITIVE_INFINITY,
): Promise<number> {
  let now = from;
  for (let step = 0; step < maxSteps; step++) {
    const remaining = manager.nextTimeout(now);
    if (remaining === null) return now;
    const at = now + remaining + 0.001;
    // `until` is the arrival of the NEXT captured frame. A deadline that falls after it
    // has not expired yet, and firing it early would replay a finalization production
    // never performed.
    if (at > until) return now;
    now = at;
    await manager.tick(now);
  }
  return now;
}

/** Replay one fixture through the whole stack, on the CAPTURED clock. `afterFrame` runs
 *  once each captured frame has been fed (the raw wire frame, before projection). */
export async function replay<W extends RecordingWriter = RecordingWriter>(
  fx: Fixture,
  writer: W = new RecordingWriter() as W,
  afterFrame?: (frame: GatewayFrame, index: number) => void,
  /** Index of ONE frame the socket never delivered. The connection sees the hole in the
   *  envelope seq and retires its live-text baselines (openclaw-client.ts), as here. */
  lost?: number,
): Promise<W> {
  const manager = new RunManager(`chat-${fx.header.scenario}`, fx.header.sessionKey, writer);
  const base = fx.entries.find((e) => e.receivedAt !== null)?.receivedAt ?? 0;
  // Seconds, like every clock the reading stack is given, anchored away from zero so no
  // code can confuse "start of capture" with "no time at all".
  const at = (e: { receivedAt: number | null }, i: number): number =>
    e.receivedAt === null ? 1000 + i * 0.01 : 1000 + (e.receivedAt - base) / 1000;
  const t0 = at(fx.entries[0]!, 0);
  // THE PRE-ACK WINDOW. Production arms a replay buffer at dispatch and only opens the
  // turn when `chat.send` is acked; a run frame that arrives in between is STASHED, not
  // treated as belonging to an already-open turn. Calling `beginTurn` up front skipped
  // that window entirely — the very race the run manager exists to handle (raised in
  // review). The ack is the `res` frame carrying the turn's run id — and EVERY acked run of
  // the fixture is a send of its own, armed and opened the same way (turnOpenings).
  const openings = turnOpenings(
    fx.entries.map((e) => e.frame),
    fx.header.ackRunIds,
    fx.header.sessionKey,
  ) as Array<{ runId: string; armIndex: number; ackIndex: number }>;
  manager.armReplayBuffer();
  const baselines = new LiveTextBaselines();
  const first = openings[0];
  if (first === undefined || first.ackIndex < 0) await manager.beginTurn(t0, first?.runId ?? null);
  let now = t0;
  for (let i = 0; i < fx.entries.length; i++) {
    const arrival = at(fx.entries[i]!, i);
    for (const [k, opening] of openings.entries()) {
      if (k > 0 && opening.armIndex === i) manager.armReplayBuffer();
      if (opening.ackIndex === i) await manager.beginTurn(arrival, opening.runId);
    }
    // Deadlines that expire DURING the silence before this frame fire first. Production's
    // receive loop waits with a timeout and resolves them before the late frame arrives;
    // feeding straight through let the replay accept a frame that would really have hit a
    // recovery or a finalization, which is the opposite of the timing coverage these
    // fixtures exist for (raised in review).
    now = await drainDeadlines(manager, now, 64, arrival);
    now = arrival;
    // The capture is the RAW wire; production restores append-only live text at the
    // connection before the run manager sees a frame (live-text-baseline.ts). Identity on
    // a capture whose deltas all carry their base (every version before 2026.9.7).
    if (i === lost) {
      baselines.invalidate();
      continue;
    }
    await manager.feed(baselines.project(fx.entries[i]!.frame as GatewayFrame).frame, now);
    afterFrame?.(fx.entries[i]!.frame as GatewayFrame, i);
  }
  // THE DEADLINES, after the last frame. A capture whose turn ends on a grace rather than
  // on a terminal frame (`lifecycle:end`, an empty final, plain recv silence) never
  // finalizes if the replay only ever feeds: the arrival times would be recorded and the
  // paths they exist for still unreachable (raised in review).
  //
  // Driven by the manager's OWN `nextTimeout`, not by a fixed jump. Adding
  // `BASE_RECV_TIMEOUT + 1` was the first version and it assumed the base receive timeout
  // is the longest wait there is — it is not (an approval wait follows the request's own
  // deadline, 30 min + 30 s by default; the compaction receive timeout is 900 s), so a
  // capture ending inside either would have stayed active and failed the finalize
  // assertion for a reason that is not a defect.
  now = await drainDeadlines(manager, now);
  if (manager.turnActive && manager.takeRecvSilence()) {
    await manager.endTurn(now, "final", null, "recv_timeout");
  }
  return writer;
}
