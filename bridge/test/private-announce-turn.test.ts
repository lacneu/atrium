// A PRIVATE ANNOUNCE TURN (OpenClaw 2026.10.33). A sub-agent spawned with
// `completionTarget:"parent"` returns its result in a private requester turn: the run
// `announce:v1:<childKey>:<childRunId>` gets NO `agent` and NO `chat` frame
// (src/agents/command/session-preparation.ts:160-174 `privateConversationWork` →
// `isControlUiVisible:false`; through 2026.9.36 the same turn was broadcast, :128). What
// is left on the wire is the session-events channel — `sessions.changed` custody notices,
// `phase:"start"` / `phase:"end"`, one `session.message` per row — and the transcript.
//
// Deterministic: the sequence captured on the bench (fixtures/
// private-announce-2026.10.33.jsonl) replayed in its real order through the real
// SessionEventsHub and TranscriptShadow, with the captured `chat.history` replies. It
// pins what the bridge hands Convex for such a turn — the facts the conversation is held
// busy by, the rows the answer is born from, the read that releases it — and the net
// when `phase:"end"` never arrives. The Convex hop replays this suite's output
// (fixtures/private-announce-projected-2026.10.33.json, convex/privateAnnounceTurn.test.ts).
//
// NOT pinned here, because no capture holds it: a private turn that fails or is aborted,
// and a request for approval raised inside one.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";
import { SessionEventsHub, type SessionEventsConnection } from "../src/providers/openclaw/session-events.js";
import { classifySessionsChanged, sessionsChangedRunLink } from "../src/providers/openclaw/transcript-rows.js";
import { TranscriptShadow, type TranscriptApply } from "../src/providers/openclaw/transcript-shadow.js";

type Entry = { n: number; conn: "chat" | "events"; receivedAt: number; frame: Record<string, unknown> & { payload: Record<string, unknown> } };

const CAPTURE: Entry[] = readFileSync(new URL("./fixtures/private-announce-2026.10.33.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "" && !l.startsWith("#"))
  .map((l) => JSON.parse(l) as Entry);
const PROJECTED = JSON.parse(
  readFileSync(new URL("./fixtures/private-announce-projected-2026.10.33.json", import.meta.url), "utf8"),
) as { sessionKey: string; announceRunId: string; applies: unknown[] };

const KEY = "agent:alice:atrium:chat:u-bench:c1";
const ANNOUNCE =
  "announce:v1:agent:files:subagent:aaaaaaaa-0000-4000-8000-000000000002:aaaaaaaa-0000-4000-8000-000000000003";
const EVENTS = CAPTURE.filter((e) => e.conn === "events");
const REPLIES = CAPTURE.filter((e) => e.conn === "chat").map((e) => e.frame.payload);
const frameOf = (n: number) => CAPTURE.find((e) => e.n === n)!.frame;

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The real hub and reconciler over a scripted gateway: every read gets the next captured
 *  `chat.history` reply; once they are spent, the last one again (an idle, empty delta —
 *  what the gateway keeps answering after the turn). The read the projection's switch-on
 *  asks for, before the capture begins, gets an empty idle delta. */
async function rig(replies: Array<Record<string, unknown>> = REPLIES) {
  const queue = [...replies];
  let last: Record<string, unknown> = {
    kind: "delta",
    messages: [],
    deltaCursor: "cursor-0",
    sessionInfo: { sessionId: "aaaaaaaa-0000-4000-8000-000000000001", hasActiveRun: false, activeRunIds: [] },
  };
  const applies: TranscriptApply[] = [];
  const timers: Array<() => void> = [];
  let reads = 0;
  let started = false;
  const conn: SessionEventsConnection = {
    request: async () => ({}),
    // The hub's reader stays parked: the suite hands it the captured frames itself.
    frames: async function* () {
      await new Promise<void>(() => {});
    },
    close: () => {},
    isClosed: false,
    gatewayVersion: "2026.10.33",
    onFrameGap: null,
  };
  const hub = new SessionEventsHub({
    instanceName: "bench",
    connect: async () => conn,
    setTimer: (fn) => {
      timers.push(fn);
      return { cancel: () => {} };
    },
    log: () => {},
  });
  const shadow = new TranscriptShadow({
    chatId: "c1",
    sessionKey: KEY,
    instanceName: "bench",
    events: hub,
    // No turn of this conversation is in the foreground: the parent's own turn ended
    // (`gateway_final`) before its sub-agent did.
    foregroundRunId: () => null,
    readHistory: async () => {
      reads++;
      await Promise.resolve();
      // Before the capture begins: the switch-on read, an idle session.
      const next = started ? queue.shift() : undefined;
      if (next !== undefined) last = next;
      return last;
    },
    apply: async (p) => {
      applies.push(JSON.parse(JSON.stringify(p)) as TranscriptApply);
    },
    sleep: async () => {},
    now: () => 1000,
    log: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 20; i++) {
      await shadow.idle();
      await tick();
    }
  };
  shadow.configure({ cursor: { deltaCursor: "cursor-0", sessionId: "aaaaaaaa-0000-4000-8000-000000000001" } as never });
  await flush();
  const before = { applies: applies.length, reads };
  started = true;
  return {
    hub,
    conn,
    applies,
    flush,
    fireTimers: () => {
      for (const fn of timers.splice(0)) fn();
    },
    /** What the turn itself produced (the switch-on read left out). */
    turn: () => applies.slice(before.applies),
    turnReads: () => reads - before.reads,
    async feed(entries: Entry[]) {
      for (const e of entries) {
        hub.dispatch(e.frame as unknown as GatewayFrame);
        await flush();
      }
    },
  };
}

describe("the wire of a private announce turn, as captured on 2026.10.33", () => {
  it("carries no agent and no chat frame — only session events and transcript reads", () => {
    const families = new Set(EVENTS.map((e) => e.frame.event));
    expect([...families].sort()).toEqual(["session.message", "sessions.changed"]);
    expect(CAPTURE.some((e) => e.frame.event === "agent" || e.frame.event === "chat")).toBe(false);
  });

  it("states the run active from the first notice, and names it", () => {
    expect(frameOf(403).payload).toMatchObject({ reason: "send", status: "running", hasActiveRun: true, activeRunIds: [ANNOUNCE] });
    expect(frameOf(409).payload).toMatchObject({ phase: "start", runId: ANNOUNCE, status: "running", hasActiveRun: true, activeRunIds: [ANNOUNCE] });
    // No client run beside it: nothing broadcasts this run under another name.
    expect(sessionsChangedRunLink(frameOf(409).payload)).toBeNull();
  });

  it("ends on `phase:end` with the run's outcome on the session snapshot", () => {
    expect(frameOf(513).payload).toMatchObject({
      phase: "end",
      runId: ANNOUNCE,
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
      lastRunId: ANNOUNCE,
      lastRunError: null,
      abortedLastRun: false,
    });
  });

  it("every transcript row of the turn names the announce run", () => {
    const rows = EVENTS.filter((e) => e.frame.event === "session.message").map((e) => e.frame.payload);
    expect(rows.length).toBe(7);
    for (const p of rows) {
      const meta = (p.message as { __openclaw: { runId?: string } }).__openclaw;
      expect(meta.runId).toBe(ANNOUNCE);
    }
  });
});

describe("what each session event of the turn asks of the reconciler", () => {
  it("custody notices and the run's end ask for a read; its start and its hidden input do not", () => {
    expect(classifySessionsChanged(frameOf(403).payload)).toMatchObject({ read: true, why: "custody" });
    expect(classifySessionsChanged(frameOf(406).payload)).toMatchObject({ read: true, why: "custody" });
    expect(classifySessionsChanged(frameOf(409).payload)).toEqual({ reset: false, read: false, why: null });
    // The injected input row is hidden (`display:false`): announced with its identity and
    // no `message` (src/gateway/server-session-events.ts:545-566) — not a batch write.
    expect(frameOf(415).payload).toMatchObject({ phase: "message", messageSeq: 92 });
    expect(frameOf(415).payload.message).toBeUndefined();
    expect(classifySessionsChanged(frameOf(415).payload)).toEqual({ reset: false, read: false, why: null });
    expect(classifySessionsChanged(frameOf(513).payload)).toMatchObject({ read: true, why: "run_end" });
    expect(classifySessionsChanged(frameOf(514).payload)).toMatchObject({ read: true, why: "custody" });
  });
});

describe("the capture replayed through the session-events hub and the reconciler", () => {
  it("tells Convex the session works from the first read, before any row", async () => {
    const r = await rig();
    await r.feed(EVENTS.slice(0, 1));
    const first = r.turn()[0]!;
    expect(first).toMatchObject({ kind: "delta", rows: [], hasActiveRun: true, activeRunIds: [ANNOUNCE] });
  });

  it("holds it working through the whole turn and releases it on the read `phase:end` asks for", async () => {
    const r = await rig();
    await r.feed(EVENTS);
    const turn = r.turn();
    const idleAt = turn.findIndex((a) => a.hasActiveRun === false);
    expect(idleAt).toBeGreaterThan(0);
    // (`live`: a row received and handed over at once — it carries no session fact.)
    const reads = turn.filter((a) => a.kind !== "live");
    const firstIdle = reads.findIndex((a) => a.hasActiveRun === false);
    for (const a of reads.slice(0, firstIdle)) {
      expect(a.hasActiveRun).toBe(true);
      expect(a.activeRunIds).toEqual([ANNOUNCE]);
    }
    for (const a of reads.slice(firstIdle)) {
      expect(a.hasActiveRun).toBe(false);
      expect(a.activeRunIds).toEqual([]);
    }
    // Released only once every row of the turn has been handed over.
    const before = turn.slice(0, idleAt).flatMap((a) => a.rows.map((row) => row.seq));
    expect([...new Set(before)].sort((a, b) => a - b)).toEqual([93, 94, 95, 96, 97, 98, 99, 100, 101, 102]);
  });

  it("hands over every row under the announce run, with its plan call and its spawn", async () => {
    const r = await rig();
    await r.feed(EVENTS);
    // A row is handed over twice — received live with its content, then read back by
    // identity: every copy counts.
    const all = r.turn().flatMap((a) => a.rows);
    expect(new Set(all.map((row) => row.entryId)).size).toBe(10);
    for (const row of all) expect(row.runId).toBe(ANNOUNCE);
    const planCall = all
      .flatMap((row) => row.blocks ?? [])
      .find((b) => b.type === "tool" && b.name === "progress_card" && b.status === "call") as { input?: unknown } | undefined;
    expect(planCall?.input).toEqual({
      plan: [
        { step: "Étape A : première tâche files", status: "completed" },
        { step: "Étape B : seconde tâche files", status: "in_progress" },
        { step: "Étape C : réponse finale", status: "pending" },
      ],
    });
    for (const fact of all.flatMap((row) => row.spawns ?? [])) {
      expect(fact).toEqual({ childSessionKey: "agent:files:subagent:aaaaaaaa-0000-4000-8000-000000000011", childRunId: "aaaaaaaa-0000-4000-8000-000000000012" });
    }
    expect(all.some((row) => row.seq === 97 && (row.spawns ?? []).length === 1)).toBe(true);
    // The answer: the `message` tool's delivery mirror row.
    expect(all.filter((row) => row.seq === 100).length).toBeGreaterThan(0);
    for (const row of all.filter((x) => x.seq === 100)) expect(row).toMatchObject({ role: "assistant", visible: true, hidden: false });
  });

  it("observes no terminal for the run: its end is the idle read's to state", async () => {
    const r = await rig();
    await r.feed(EVENTS);
    expect(r.turn().flatMap((a) => a.terminals)).toEqual([]);
  });

  it("produces exactly the applies the Convex hop is tested with", async () => {
    const r = await rig();
    await r.feed(EVENTS);
    expect(PROJECTED.sessionKey).toBe(KEY);
    expect(PROJECTED.announceRunId).toBe(ANNOUNCE);
    expect(r.turn()).toEqual(PROJECTED.applies);
  });
});

describe("`phase:end` never arrives", () => {
  // `sessions.changed` is broadcast `dropIfSlow`: a dropped one leaves a hole in the
  // event sequence, and nothing else (session-events.ts `noteFrameGap`).
  const withoutEnd = EVENTS.filter((e) => e.n < 513);
  // The reads the lost notices would have asked for never happen: the gateway's answer
  // to the NEXT read is the idle one.
  const replies = REPLIES;

  it("the last row's read still says the run works: nothing releases the session by itself", async () => {
    const r = await rig(replies.slice(0, -1));
    await r.feed(withoutEnd);
    expect(r.turn().at(-1)).toMatchObject({ hasActiveRun: true, activeRunIds: [ANNOUNCE] });
  });

  it("the hole in the event sequence asks every attached session to read again, and that read releases it", async () => {
    const r = await rig(replies);
    await r.feed(withoutEnd);
    const readsBefore = r.turnReads();
    r.conn.onFrameGap?.({ expected: 1, received: 3 } as never);
    r.fireTimers();
    await r.flush();
    expect(r.hub.stats.gapRereads).toBe(1);
    expect(r.turnReads()).toBe(readsBefore + 1);
    expect(r.turn().at(-1)).toMatchObject({ hasActiveRun: false, activeRunIds: [] });
  });

  it("a subscription established again reads too", async () => {
    const r = await rig(replies);
    await r.feed(withoutEnd);
    // What the hub does for every attached session once `sessions.subscribe` answers.
    const listener = r.hub as unknown as { listeners: Map<string, Set<{ onSubscribed(): void }>> };
    for (const l of listener.listeners.get(KEY)!) l.onSubscribed();
    await r.flush();
    expect(r.turn().at(-1)).toMatchObject({ hasActiveRun: false, activeRunIds: [] });
  });
});
