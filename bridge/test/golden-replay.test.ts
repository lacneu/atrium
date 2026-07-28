/**
 * GOLDEN REPLAY (W11/G4) — real captures, replayed with no gateway and no model.
 *
 * Until now the only thing that proved Atrium still INTERPRETS a real gateway
 * conversation correctly was the live bench: minutes per run, an LLM in the loop, a
 * verdict that moves with host load. This suite replays captures promoted from a GO run
 * by `scripts/promote-capture.mjs` (anonymised on the way in) through the whole reading
 * stack — normalizer, run manager, turn sink — in milliseconds, in CI.
 *
 * It replays through the RUN MANAGER, not the normalizer alone, and pins the WRITER
 * CALLS. That is deliberate: announce fusion, the background-task engagement and the plan
 * card are all decided above the normalizer, so a normalizer-only replay would be green
 * while the three things this corpus exists to protect were broken.
 *
 * What is pinned is the interpretation, not the frames. A change that makes an OLD
 * capture mean something new turns this red, and the right reaction is a question — "did
 * I mean to change that reading?" — then updating the snapshot IN THE SAME commit.
 *
 * The clock is the CAPTURED one: `receivedAt` replays as real elapsed time, so the
 * timing-dependent paths stay reachable instead of being frozen out by a synthetic tick.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";
import type {
  ConvexWriter,
  FinalizeStatus,
  ToolPart,
} from "../src/convex-writer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = resolve(__dirname, "./fixtures/golden");

interface FixtureHeader {
  corpus: string;
  promoter: number;
  scenario: string;
  gatewayVersion: string;
  bodySha256: string;
  frames: number;
  sessionKey: string;
  ackRunIds: string[];
}

interface Fixture {
  version: string;
  file: string;
  header: FixtureHeader;
  entries: { receivedAt: number | null; frame: unknown }[];
}

function loadCorpus(): Fixture[] {
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

const CORPUS = loadCorpus();

/** Records what Atrium WOULD have written. Every call is captured — including the ones
 *  the announce, task-engagement and plan paths make, which is the point of replaying
 *  above the normalizer. */
class RecordingWriter implements ConvexWriter {
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
function family(runId: string | null): string {
  if (runId === null) return "none";
  if (runId.startsWith("announce:")) return "announce";
  if (runId.startsWith("inject-")) return "inject";
  if (/:.+:ok$/.test(runId)) return "task-delivery";
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

/** Replay one fixture through the whole stack, on the CAPTURED clock. */
async function replay(fx: Fixture): Promise<RecordingWriter> {
  const writer = new RecordingWriter();
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
  // review). The ack is the `res` frame carrying the turn's run id.
  const ackIndex = fx.entries.findIndex(
    (e) =>
      (e.frame as { type?: string; payload?: { runId?: string } })?.type === "res" &&
      (e.frame as { payload?: { runId?: string } })?.payload?.runId ===
        fx.header.ackRunIds[0],
  );
  manager.armReplayBuffer();
  let opened = ackIndex < 0;
  if (opened) await manager.beginTurn(t0, fx.header.ackRunIds[0] ?? null);
  let now = t0;
  for (let i = 0; i < fx.entries.length; i++) {
    const arrival = at(fx.entries[i]!, i);
    if (!opened && i === ackIndex) {
      await manager.beginTurn(arrival, fx.header.ackRunIds[0] ?? null);
      opened = true;
    }
    // Deadlines that expire DURING the silence before this frame fire first. Production's
    // receive loop waits with a timeout and resolves them before the late frame arrives;
    // feeding straight through let the replay accept a frame that would really have hit a
    // recovery or a finalization, which is the opposite of the timing coverage these
    // fixtures exist for (raised in review).
    now = await drainDeadlines(manager, now, 64, arrival);
    now = arrival;
    await manager.feed(fx.entries[i]!.frame, now);
  }
  // THE DEADLINES, after the last frame. A capture whose turn ends on a grace rather than
  // on a terminal frame (`lifecycle:end`, an empty final, plain recv silence) never
  // finalizes if the replay only ever feeds: the arrival times would be recorded and the
  // paths they exist for still unreachable (raised in review).
  //
  // Driven by the manager's OWN `nextTimeout`, not by a fixed jump. Adding
  // `BASE_RECV_TIMEOUT + 1` was the first version and it assumed the base receive timeout
  // is the longest wait there is — it is not (`APPROVAL_WAIT` is 600 s, the compaction
  // receive timeout 900 s), so a capture ending inside either would have stayed active
  // and failed the finalize assertion for a reason that is not a defect.
  now = await drainDeadlines(manager, now);
  if (manager.turnActive && manager.takeRecvSilence()) {
    await manager.endTurn(now, "final", null, "recv_timeout");
  }
  return writer;
}

/** A stable, diff-readable summary: WHICH writes, in what order, at what size. */
function summarise(writer: RecordingWriter): Record<string, unknown> {
  const byCall: Record<string, number> = {};
  const order: string[] = [];
  for (const c of writer.calls) {
    byCall[c.call] = (byCall[c.call] ?? 0) + 1;
    if (order[order.length - 1] !== c.call) order.push(c.call);
  }
  return {
    calls: writer.calls.length,
    byCall,
    order,
    bubbles: writer.calls
      .filter((c) => c.call === "startAssistant")
      .map((c) => c.detail?.runFamily),
    finals: writer.calls.filter((c) => c.call === "finalize").map((c) => c.detail?.status),
    tools: [
      ...new Set(
        writer.calls
          .filter((c) => c.call === "addToolPart")
          .map((c) => `${c.detail?.kind ?? "?"}:${c.detail?.name ?? "?"}`),
      ),
    ].sort(),
    engagements: writer.calls
      .filter((c) => c.call === "upsertSubAgent")
      .map((c) => `${c.detail?.kind}:${c.detail?.status}`),
  };
}

describe("golden corpus", () => {
  it("EXISTS and is non-empty", () => {
    // An absent or empty corpus satisfies every `for (const fx of CORPUS)` below while
    // proving nothing — the same vacuous-green shape as an empty vendored directory.
    expect(
      CORPUS.length,
      "no golden fixtures — run scripts/promote-capture.mjs",
    ).toBeGreaterThan(0);
    for (const fx of CORPUS) {
      expect(fx.entries.length, `${fx.file} has no frames`).toBeGreaterThan(0);
    }
  });

  it("declares a version that MATCHES the directory it sits in", () => {
    // Otherwise a 2026.6.11 capture filed under 2026.7.1 satisfies the whole suite and
    // the corpus silently claims coverage of a version it never saw.
    for (const fx of CORPUS) {
      expect(fx.header.gatewayVersion, `${fx.version}/${fx.file}`).toBe(fx.version);
      expect(fx.header.corpus).toBe("openclaw-golden");
      expect(fx.header.frames, `${fx.file} frame count`).toBe(fx.entries.length);
    }
  });

  it("carries a replay session key its own frames actually use", () => {
    for (const fx of CORPUS) {
      expect(fx.header.sessionKey, `${fx.file}`).toMatch(/:atrium:chat:/);
      const used = fx.entries.some((e) =>
        JSON.stringify(e.frame).includes(fx.header.sessionKey),
      );
      expect(used, `${fx.file}: the replay key appears in no frame`).toBe(true);
    }
  });
});

describe("golden replay — the interpretation is pinned", () => {
  for (const fx of CORPUS) {
    it(`${fx.version}/${fx.header.scenario}`, async () => {
      const writer = await replay(fx);
      // NON-VACUITY, asserted before the snapshot. The first promoter recorded the
      // session key through a second pseudonym mint, so it matched no frame, the
      // isolation gate dropped everything, and nine snapshots were written showing zero
      // events — a corpus that replays nothing passes every comparison it makes.
      expect(writer.calls.length, `${fx.file} replayed to nothing`).toBeGreaterThan(0);
      expect(
        writer.calls.some((c) => c.call === "finalize"),
        `${fx.file} never finalized a message`,
      ).toBe(true);
      expect(summarise(writer)).toMatchSnapshot();
    });
  }
});

describe("golden replay — the corpus covers what it claims", () => {
  const byScenario = new Map(CORPUS.map((fx) => [fx.header.scenario, fx]));

  it("the ANNOUNCE lane opens its own bubble", async () => {
    // What this layer decides: a late child report arrives on the PARENT session with an
    // `announce:` run and must open a turn of its own. The sub-agent ROW is written a
    // layer up (session.ts), so the bubble — and its run family — is the evidence here.
    const fx = byScenario.get("spawn-announce-merge");
    expect(fx, "the announce scenario is missing from the corpus").toBeDefined();
    const writer = await replay(fx!);
    const families = writer.calls
      .filter((c) => c.call === "startAssistant")
      .map((c) => c.detail?.runFamily);
    expect(families, "the announce run opened no bubble").toContain("announce");
    expect(
      writer.calls.filter((c) => c.call === "finalize").length,
      "the announce turn never finalized",
    ).toBeGreaterThan(1);
  });

  it("the BACKGROUND TASK engagement is recorded", async () => {
    const fx = byScenario.get("async-task");
    expect(fx, "the async-task scenario is missing from the corpus").toBeDefined();
    const writer = await replay(fx!);
    const tasks = writer.calls.filter(
      (c) => c.call === "upsertSubAgent" && c.detail?.kind === "task",
    );
    expect(tasks.length, "no kind:task engagement — the async ack was not read").
      toBeGreaterThan(0);
    // …and the DELIVERY, not just the ack. Pseudonymising the task UUID token-by-token
    // broke the `<tool>:<taskId>:ok` grammar, so the delivery run went unrecognised and
    // this scenario proved only that the engagement OPENED (raised in review).
    expect(
      tasks.map((c) => c.detail?.status),
      "the engagement never settled — the delivery run was not correlated",
    ).toContain("done");
    expect(
      writer.calls
        .filter((c) => c.call === "startAssistant")
        .map((c) => c.detail?.runFamily),
      "the delivery opened no bubble",
    ).toContain("task-delivery");
  });

  it("MEDIA is delivered", async () => {
    // `mediaUrls` was not classified, so promotion renamed it to a masked key and the
    // outbound path became unrecognisable: the media scenario replayed as a plain turn
    // and any regression in the extraction path stayed green (raised in review).
    const fx = byScenario.get("media-outbound");
    expect(fx, "the media scenario is missing from the corpus").toBeDefined();
    const writer = await replay(fx!);
    expect(
      writer.calls.filter((c) => c.call === "addMedia").length,
      "no media delivered — the outbound reading is gone",
    ).toBeGreaterThan(0);
  });

  it("the PLAN card is produced", async () => {
    const fx = byScenario.get("update-plan");
    expect(fx, "the update-plan scenario is missing from the corpus").toBeDefined();
    const writer = await replay(fx!);
    const plans = writer.calls.filter((c) => c.call === "addPlanPart");
    expect(plans.length, "no plan part — the plan reading is gone").toBeGreaterThan(0);
  });
});

describe("golden replay — the corpus is at the vendored version", () => {
  it("produces NO protocol drift", () => {
    // The corpus was captured from the version the bridge vendors, so a single unknown
    // field means either the capture is from another version or the anonymiser mangled a
    // name — and this catches both. It is also the cheapest check of the anonymiser:
    // mangle a discriminant and the report fills with unknown states.
    protocolDrift.resetForTests();
    for (const fx of CORPUS) {
      for (const e of fx.entries) protocolDrift.observe(e.frame);
    }
    expect(protocolDrift.report()).toEqual([]);
    expect(protocolDrift.overflowCount()).toBe(0);
  });
});

describe("drainDeadlines", () => {
  it("advances by the REMAINING seconds, not to them", () => {
    // `nextTimeout` returns a duration. Treating it as an absolute time moved the clock a
    // millisecond per step, so a capture that ends inside a 600 s approval wait would
    // never have finalized — and the replay would have looked like it tried.
    const ticks: number[] = [];
    const remaining = [240, 600, null] as (number | null)[];
    let i = 0;
    const stub = {
      nextTimeout: (): number | null => remaining[i++] ?? null,
      tick: async (now: number): Promise<void> => {
        ticks.push(Math.round(now));
      },
    };
    return drainDeadlines(stub, 1000).then((end) => {
      expect(ticks).toEqual([1240, 1840]);
      expect(Math.round(end)).toBe(1840);
    });
  });

  it("stops at the step cap instead of spinning forever", async () => {
    const stub = {
      nextTimeout: (): number => 1,
      tick: async (): Promise<void> => {},
    };
    expect(await drainDeadlines(stub, 0, 5)).toBeCloseTo(5.005, 2);
  });
});

describe("drainDeadlines — the `until` bound", () => {
  it("fires a deadline that expires BEFORE the next frame", async () => {
    const ticks: number[] = [];
    let armed: number | null = 30;
    const stub = {
      nextTimeout: (): number | null => armed,
      tick: async (now: number): Promise<void> => {
        ticks.push(Math.round(now));
        armed = null;
      },
    };
    // Next frame lands 120 s later; a 30 s deadline expired during that silence.
    await drainDeadlines(stub, 1000, 64, 1120);
    expect(ticks).toEqual([1030]);
  });

  it("does NOT fire one that expires after it", async () => {
    const ticks: number[] = [];
    const stub = {
      nextTimeout: (): number | null => 300,
      tick: async (now: number): Promise<void> => {
        ticks.push(now);
      },
    };
    // The frame arrives 10 s later: in production the deadline has not expired yet, and
    // firing it early would replay a finalization that never happened.
    const end = await drainDeadlines(stub, 1000, 64, 1010);
    expect(ticks).toEqual([]);
    expect(end).toBe(1000);
  });
});
