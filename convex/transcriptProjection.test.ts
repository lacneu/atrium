/// <reference types="vite/client" />
//
// THE TRANSCRIPT PROJECTION, Convex side (redesign phase 1, SHADOW).
//
//  - the send identity Convex computes is the key the gateway recorded LIVE;
//  - `applyTranscript` is idempotent (replay, reorder, restart rewrite nothing), keeps
//    run statuses sticky, moves its cursor forward, sets the floor from the first send
//    it can prove — and never touches a message;
//  - the measurement (I1–I3) finds exactly the gaps that exist, over seeded worlds;
//  - the dispatch stamps the identity on the outbox row and its user bubble.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { sendIdentityFor, ATRIUM_SEND_ID_RE } from "./lib/sendIdentity";
import {
  INCOMPLETENESS_REASONS,
  incompletenessReasons,
  projectionVerdict,
  type CompletenessFacts,
  type IncompletenessReason,
  assessProjection,
  floorForFirstRead,
  gapTotal,
  mergeRunStatus,
  sanitizeRow,
  type ProjectionBubble,
  type ProjectionRow,
  type RunStatus,
  type SendResolution,
} from "./lib/transcriptProjection";
import { parseInstanceConfig } from "./lib/instanceConfig";
import { projectionForDiagnose, utf8ByteLength } from "./lib/transcriptProjection";
import { hashKey } from "./lib/apikeys";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SK = "agent:alice:atrium:chat:owner:c1";

async function seed(t: T, config: Record<string, unknown> = { transcriptProjection: "shadow" }) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: owner,
      role: "user",
      canonical: "owner",
      name: "owner",
      email: "owner@example.com",
    });
    const instanceId = await ctx.db.insert("instances", {
      name: "alpha",
      gatewayUrl: "ws://gw",
      config: config as never,
    });
    await ctx.db.insert("agents", {
      instanceName: "alpha",
      agentId: "alice",
      displayName: "Alice",
      enabled: true,
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
    const chatId = await ctx.db.insert("chats", {
      userId: owner,
      updatedAt: 1,
      instanceName: "alpha",
      agentId: "alice",
    });
    return { owner, instanceId, chatId };
  });
}

type Row = {
  entryId: string;
  seq: number;
  role: string;
  runId?: string;
  sendId?: string;
  steerTargetRunId?: string;
  hidden: boolean;
  visible: boolean;
};
const user = (seq: number, sendId: string, extra: Partial<Row> = {}): Row => ({
  entryId: `u${seq}`,
  seq,
  role: "user",
  runId: sendId,
  sendId,
  hidden: false,
  visible: true,
  ...extra,
});
const reply = (seq: number, runId: string, extra: Partial<Row> = {}): Row => ({
  entryId: `a${seq}`,
  seq,
  role: "assistant",
  runId,
  hidden: false,
  visible: true,
  ...extra,
});

const apply = (
  t: T,
  chatId: Id<"chats">,
  rows: Row[],
  extra: Partial<{
    kind: "page" | "delta" | "reset";
    deltaCursor: string;
    sessionId: string;
    terminals: Array<{ runId: string; status: "completed" | "error" | "aborted" | "timeout" | "yielded"; at: number; emptyFinal?: boolean }>;
    activeRunIds: string[];
    boundInstanceName: string;
    unidentified: number;
    readAt: number;
  }> = {},
) =>
  t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: extra.boundInstanceName ?? "alpha",
    sessionKey: SK,
    sessionId: extra.sessionId ?? "s-1",
    kind: extra.kind ?? "page",
    ...(extra.deltaCursor === undefined ? {} : { deltaCursor: extra.deltaCursor }),
    rows,
    terminals: extra.terminals ?? [],
    ...(extra.activeRunIds === undefined ? {} : { activeRunIds: extra.activeRunIds }),
    unidentified: extra.unidentified ?? 0,
    ...(extra.readAt === undefined ? {} : { readAt: extra.readAt }),
  });

/** Everything the projection stored, without volatile timestamps / ids. */
const stored = (t: T) =>
  t.run(async (ctx) => {
    const strip = <X extends Record<string, unknown>>(x: X) => {
      const { _id, _creationTime, updatedAt, terminalAt, floorAt, coveredAt, lastReadAt, ...rest } =
        x as Record<string, unknown>;
      void coveredAt;
      void lastReadAt;
      void _id;
      void _creationTime;
      void updatedAt;
      void terminalAt;
      void floorAt;
      return rest;
    };
    const rows = (await ctx.db.query("transcriptRows").collect())
      .map(strip)
      .sort((a, b) => String(a.entryId).localeCompare(String(b.entryId)));
    const runs = (await ctx.db.query("transcriptRuns").collect())
      .map(strip)
      .sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
    const cursors = (await ctx.db.query("transcriptCursors").collect()).map((c) => {
      const { reads: _r, ...rest } = strip(c);
      void _r;
      return rest;
    });
    return { rows, runs, cursors };
  });

describe("the send identity Convex computes", () => {
  test("is the key the gateway RECORDED live (OpenClaw 2026.9.6, bench 2026-10-01)", async () => {
    // From bridge/test/fixtures/transcript-history-2026.9.6.json: the outbox row
    // `7a9491b1-…` of chat m97380… was recorded by the gateway under this exact key.
    const key = await sendIdentityFor(
      "agent:alice:atrium:chat:u-repro:m97380jswyt0bqd0j7v65e2cx18ffe0q",
      "7a9491b1-659b-4887-a58b-5a03cb77c5ca",
    );
    expect(key).toBe("webchat-91b972c14151fef250ce0b86470ae46edd9d0401124aad03567f7337e1d608f2");
    expect(ATRIUM_SEND_ID_RE.test(key)).toBe(true);
  });

  test("another session, another key — the gateway's dedupe is not per session", async () => {
    const a = await sendIdentityFor("agent:alice:atrium:chat:o:c1", "cm-1");
    const b = await sendIdentityFor("agent:bob:atrium:chat:o:c1", "cm-1");
    expect(a).not.toBe(b);
  });
});

describe("applyTranscript — idempotent, sticky, never a bubble", () => {
  test("a read is stored as identities; replaying it N times changes nothing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const rows = [user(1, "webchat-a"), reply(2, "webchat-a")];
    const first = await apply(t, s.chatId, rows, { deltaCursor: "c:2" });
    expect(first).toMatchObject({ ok: true, inserted: 2, updated: 0 });
    const once = await stored(t);
    for (let i = 0; i < 3; i++) {
      const again = await apply(t, s.chatId, rows, { deltaCursor: "c:2" });
      expect(again).toMatchObject({ inserted: 0, updated: 0 });
    }
    expect(await stored(t)).toEqual(once);
    expect(once.rows.map((r) => [r.entryId, r.seq, r.role, r.runId, r.sendId ?? null])).toEqual([
      ["a2", 2, "assistant", "webchat-a", null],
      ["u1", 1, "user", "webchat-a", "webchat-a"],
    ]);
    expect(once.cursors).toEqual([
      expect.objectContaining({ sessionKey: SK, sessionId: "s-1", deltaCursor: "c:2", lastSeq: 2, lastKind: "page" }),
    ]);
  });

  test("it NEVER writes a message", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "visible",
        runId: "webchat-a",
        updatedAt: 5,
      }),
    );
    const before = await t.run((ctx) => ctx.db.query("messages").collect());
    await apply(t, s.chatId, [user(1, "webchat-a"), reply(2, "webchat-a"), reply(3, "run-foreign")], {
      terminals: [{ runId: "webchat-a", status: "completed", at: 9 }],
    });
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual(before);
  });

  test("another instance's bridge cannot write this chat's transcript", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(apply(t, s.chatId, [user(1, "k")], { boundInstanceName: "beta" })).rejects.toThrow(
      /forbidden: cross-instance/,
    );
    expect((await stored(t)).rows).toEqual([]);
  });

  test("unidentified or out-of-bound rows are counted, never stored", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [
      user(1, "k"),
      { ...reply(0, "r"), entryId: "bad-seq" },
      { ...reply(2, "r"), entryId: "" },
      { ...reply(3, "r"), runId: "x".repeat(300) },
    ], { unidentified: 2 });
    const st = await stored(t);
    // The over-long run id is dropped from the row, the row itself is kept.
    expect(st.rows.map((r) => r.entryId).sort()).toEqual(["a3", "u1"]);
    expect(st.rows.find((r) => r.entryId === "a3")!.runId).toBeUndefined();
    expect(st.cursors[0]!.unidentified).toBe(4);
  });

  test("a terminal status is STICKY: the first terminal wins, rows never downgrade it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(2, "run-1")], { terminals: [{ runId: "run-1", status: "aborted", at: 1 }] });
    await apply(t, s.chatId, [reply(3, "run-1")], {
      kind: "delta",
      terminals: [{ runId: "run-1", status: "completed", at: 2 }],
    });
    await apply(t, s.chatId, [reply(4, "run-1")], { kind: "delta", activeRunIds: ["run-1"] });
    const run = (await stored(t)).runs.find((r) => r.runId === "run-1")!;
    expect(run.status).toBe("aborted");
    expect([run.firstSeq, run.lastSeq]).toEqual([2, 4]);
  });

  test("a run known only from its rows is `persisted` (or `streaming` while active), then takes its terminal", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(2, "run-a"), reply(3, "run-b")], { activeRunIds: ["run-b"] });
    let runs = (await stored(t)).runs;
    expect(runs.map((r) => [r.runId, r.status])).toEqual([
      ["run-a", "persisted"],
      ["run-b", "streaming"],
    ]);
    await apply(t, s.chatId, [], { kind: "delta", terminals: [{ runId: "run-b", status: "yielded", at: 3 }] });
    runs = (await stored(t)).runs;
    expect(runs.find((r) => r.runId === "run-b")!.status).toBe("yielded");
  });

  test("a cursor that never learnt its session ADOPTS the first one named — not a reset", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // The first read ran before the session existed (the switch-on read races the send).
    await apply(t, s.chatId, [], { sessionId: "" });
    await apply(t, s.chatId, [user(1, "k"), reply(2, "k")], { sessionId: "s-9", deltaCursor: "c:2" });
    const c = (await stored(t)).cursors[0]!;
    expect(c).toMatchObject({ sessionId: "s-9", resets: 0, floorSeq: 0, deltaCursor: "c:2" });
  });

  test("a per-turn routed chat (no chat instance) takes the switch of the bridge that read", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.chatId, { instanceName: undefined, perTurnRouting: true }));
    // The write barrier needs proof a turn went there: an outbox row sent to `alpha`.
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-r",
        text: "x",
        attachmentIds: [],
        status: "sent",
        sentToInstance: "alpha",
      }),
    );
    await apply(t, s.chatId, [reply(2, "r")]);
    const r = await t.query(internal.transcriptProjection.projectionReportInternal, { chatId: s.chatId });
    expect(r!.mode).toBe("shadow");
  });

  test("a `reset` drops the cursor; a new gateway session restarts seq with a floor of 0", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(5, "r1")], { deltaCursor: "c:5" });
    await apply(t, s.chatId, [], { kind: "reset" });
    let c = (await stored(t)).cursors[0]!;
    expect(c.deltaCursor).toBeUndefined();
    expect(c.resets).toBe(1);
    await apply(t, s.chatId, [reply(1, "r2")], { sessionId: "s-2", deltaCursor: "c:1" });
    c = (await stored(t)).cursors[0]!;
    expect(c).toMatchObject({ sessionId: "s-2", floorSeq: 0, deltaCursor: "c:1", lastSeq: 1, resets: 2 });
    // Both transcripts' rows are kept, each under its own session id.
    expect(
      (await stored(t)).rows.map((r) => [r.sessionId, r.seq]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["s-1", 5],
      ["s-2", 1],
    ]);
  });
});

describe("the floor (design §10.2, refined for phase 1)", () => {
  test("just below the first user row whose send Atrium can PROVE", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-7",
        text: "x",
        attachmentIds: [],
        status: "sent",
        sendId: "webchat-known",
      }),
    );
    // A legacy turn (seq 1-2, a key nobody stamped), then the projected one (seq 3-4).
    await apply(t, s.chatId, [user(1, "webchat-legacy"), reply(2, "webchat-legacy"), user(3, "webchat-known"), reply(4, "webchat-known")]);
    expect((await stored(t)).cursors[0]!.floorSeq).toBe(2);
  });

  test("with no provable send in the first read, at the largest seq read", async () => {
    expect(floorForFirstRead([{ seq: 4, role: "user", sendId: "x" }, { seq: 9, role: "assistant" }], () => false)).toBe(9);
    expect(floorForFirstRead([], () => false)).toBe(0);
    expect(
      floorForFirstRead([{ seq: 6, role: "user", sendId: "b" }, { seq: 3, role: "user", sendId: "a" }], () => true),
    ).toBe(2);
  });
});

describe("mergeRunStatus — upstream session-projection.ts updateRun", () => {
  const all: RunStatus[] = ["streaming", "completed", "error", "aborted", "timeout", "yielded", "persisted"];
  test.each(all.flatMap((a) => all.map((b) => [a, b] as const)))("%s then %s", (a, b) => {
    const terminal = (x: RunStatus) => !["streaming", "persisted"].includes(x);
    const out = mergeRunStatus(a, b);
    if (terminal(a)) expect(out).toBe(a);
    else if (b === "persisted") expect(out).toBe(a);
    else expect(out).toBe(b);
  });
});

// ── The measurement ─────────────────────────────────────────────────────────────────

const prow = (r: Row): ProjectionRow => ({ sessionKey: SK, sessionId: "s-1", ...r });

describe("assessProjection — the invariants, case by case", () => {
  const atrium = (bubbleCount = 1, headBubble = true, internal = false): SendResolution => ({
    kind: "atrium",
    bubbleCount,
    headBubble,
    internal,
  });

  test("a consistent turn: no gap", () => {
    const g = assessProjection({
      rows: [prow(user(1, "webchat-a")), prow(reply(2, "webchat-a"))],
      bubblesForRun: (id) => new Set(id === "webchat-a" ? ["m1"] : []),
      bubbles: [{ messageId: "m1", runIds: ["webchat-a"], status: "complete", hasText: true, settled: true }],
      resolveSend: () => atrium(),
    });
    expect(gapTotal(g)).toBe(0);
    expect(g.i1.visibleRuns).toBe(1);
    expect(g.i3.userRows).toBe(1);
  });

  test("I1: a reply only in the transcript, and a reply in two bubbles", () => {
    const g = assessProjection({
      rows: [prow(reply(2, "run-follow")), prow(reply(3, "run-dup"))],
      bubblesForRun: (id) => new Set(id === "run-dup" ? ["m1", "m2"] : []),
      bubbles: [],
      resolveSend: () => atrium(),
    });
    expect([g.i1.transcriptOnly, g.i1.duplicated]).toEqual([1, 1]);
    expect(g.i1.samples.map((x) => [x.runId, x.bubbles])).toEqual([
      ["run-follow", 0],
      ["run-dup", 2],
    ]);
  });

  test("I1 ignores hidden rows and tool-call-only rows; a tool RESULT needs a bubble", () => {
    const g = assessProjection({
      rows: [
        prow(reply(2, "r-silent", { hidden: true })),
        prow(reply(3, "r-tools", { visible: false })),
        prow({ entryId: "t4", seq: 4, role: "toolresult", runId: "r-tr", hidden: false, visible: true }),
        // The upstream spelling, should a reader ever store it un-lowered.
        prow({ entryId: "t5", seq: 5, role: "toolResult", runId: "r-tr2", hidden: false, visible: false }),
      ],
      bubblesForRun: () => new Set(),
      bubbles: [],
      resolveSend: () => atrium(),
    });
    expect(g.i1.visibleRuns).toBe(2);
    expect(g.i1.transcriptOnly).toBe(2);
  });

  test("I2: a settled bubble with no durable visible row of its runs (the steered client run)", () => {
    const bubbles: ProjectionBubble[] = [
      { messageId: "m-steer", runIds: ["webchat-b"], status: "complete", hasText: false, settled: true },
      { messageId: "m-err", runIds: ["webchat-c"], status: "error", hasText: false, settled: true },
      { messageId: "m-live", runIds: ["webchat-d"], status: "complete", hasText: true, settled: false },
      { messageId: "m-merge", runIds: ["webchat-e", "announce:v1:x"], status: "complete", hasText: true, settled: true },
    ];
    const g = assessProjection({
      rows: [prow(reply(9, "announce:v1:x"))],
      bubblesForRun: () => new Set(["m-merge"]),
      bubbles,
      resolveSend: () => atrium(),
    });
    expect(g.i2).toMatchObject({ judged: 3, unsettled: 1, bubbleWithoutRow: 1, errorCardWithoutRow: 1 });
    expect(g.i2.samples.map((x) => x.messageId)).toEqual(["m-steer", "m-err"]);
  });

  test("I3: missing, duplicated, unmatched; internal sends and other clients' inputs are not gaps", () => {
    const g = assessProjection({
      rows: [
        prow(user(1, "webchat-" + "a".repeat(64))),
        prow(user(2, "webchat-dup")),
        prow(user(3, "webchat-gone")),
        prow(user(4, "webchat-internal")),
        prow(user(5, "control-ui-run-7")),
        prow(user(6, "webchat-steer", { steerTargetRunId: "run-1" })),
      ],
      bubblesForRun: () => new Set(),
      bubbles: [],
      resolveSend: (id): SendResolution =>
        id === "webchat-dup"
          ? atrium(2)
          : id === "webchat-gone"
            ? atrium(0, false)
            : id === "webchat-internal"
              ? atrium(0, false, true)
              : id === "webchat-steer"
                ? atrium()
                : { kind: "unknown" },
    });
    expect(g.i3).toMatchObject({
      userRows: 6,
      missingBubble: 1,
      duplicated: 1,
      unmatchedAtriumSend: 1,
      internalSends: 1,
      foreignInputs: 1,
      steeredInputs: 1,
    });
  });
});

/** mulberry32 — deterministic, so every failing world replays from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A CONSISTENT world: every send has one bubble, every visible run one bubble. */
function world(seed: number) {
  const rand = prng(seed);
  const rows: ProjectionRow[] = [];
  const runBubbles = new Map<string, Set<string>>();
  const sends = new Map<string, SendResolution>();
  const bubbles: ProjectionBubble[] = [];
  let seq = 0;
  const turns = 2 + Math.floor(rand() * 6);
  for (let i = 0; i < turns; i++) {
    const sendId = `webchat-${seed}-${i}`;
    rows.push(prow(user(++seq, sendId)));
    sends.set(sendId, { kind: "atrium", bubbleCount: 1, headBubble: true, internal: false });
    const n = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const visible = rand() < 0.6 || k === n - 1;
      rows.push(prow(reply(++seq, sendId, { visible, entryId: `a${seq}` })));
    }
    runBubbles.set(sendId, new Set([`m-${i}`]));
    bubbles.push({ messageId: `m-${i}`, runIds: [sendId], status: "complete", hasText: true, settled: true });
    if (rand() < 0.3) {
      // A delivery run merged into the turn's bubble.
      const ann = `announce:v1:${seed}:${i}`;
      rows.push(prow(reply(++seq, ann)));
      runBubbles.set(ann, new Set([`m-${i}`]));
      bubbles[bubbles.length - 1]!.runIds.push(ann);
    }
  }
  // Display order is not seq order: shuffle.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
  }
  return { rows, runBubbles, sends, bubbles, rand };
}

describe("properties over seeded worlds", () => {
  for (let seed = 1; seed <= 60; seed++) {
    test(`seed ${seed}: consistent ⇒ 0 gaps; each injected defect is counted exactly once`, () => {
      const w = world(seed);
      const run = (over: Partial<Parameters<typeof assessProjection>[0]> = {}) =>
        assessProjection({
          rows: w.rows,
          bubblesForRun: (id) => w.runBubbles.get(id) ?? new Set(),
          bubbles: w.bubbles,
          resolveSend: (id) => w.sends.get(id) ?? { kind: "unknown" },
          ...over,
        });
      expect(gapTotal(run())).toBe(0);
      // Replay / duplicate rows: idempotent measurement.
      expect(run({ rows: [...w.rows, ...w.rows] })).toEqual(run());

      const victim = [...w.runBubbles.keys()][Math.floor(w.rand() * w.runBubbles.size)]!;
      // I1 — the victim's bubble is gone.
      const lost = run({ bubblesForRun: (id) => (id === victim ? new Set() : (w.runBubbles.get(id) ?? new Set())) });
      expect([lost.i1.transcriptOnly, lost.i1.duplicated]).toEqual([1, 0]);
      // I1 — doubled.
      const doubled = run({
        bubblesForRun: (id) =>
          id === victim ? new Set(["x1", "x2"]) : (w.runBubbles.get(id) ?? new Set()),
      });
      expect([doubled.i1.transcriptOnly, doubled.i1.duplicated]).toEqual([0, 1]);
      // I2 — a settled bubble whose runs wrote no visible row.
      const orphan = run({
        bubbles: [...w.bubbles, { messageId: "orphan", runIds: ["webchat-never"], status: "complete", hasText: false, settled: true }],
      });
      expect(orphan.i2.bubbleWithoutRow).toBe(1);
      expect(gapTotal(orphan)).toBe(1);
      // I3 — one send without its bubble.
      const sendVictim = [...w.sends.keys()][0]!;
      const noBubble = run({
        resolveSend: (id) =>
          id === sendVictim
            ? { kind: "atrium", bubbleCount: 0, headBubble: false, internal: false }
            : (w.sends.get(id) ?? { kind: "unknown" }),
      });
      expect(noBubble.i3.missingBubble).toBe(1);
      expect(gapTotal(noBubble)).toBe(1);
    });
  }
});

describe("sanitizeRow", () => {
  test("keeps identities within the upstream bounds, drops the unplaceable", () => {
    expect(sanitizeRow({ ...reply(1, "r"), toolCallIds: Array.from({ length: 40 }, (_, i) => `c${i}`) })!.toolCallIds).toHaveLength(32);
    expect(sanitizeRow({ ...reply(1.5, "r") })).toBeNull();
    expect(sanitizeRow({ ...reply(1, "r"), role: "" })).toBeNull();
  });
});

describe("the dispatch stamps the send identity", () => {
  test("lastGateBeforeSend writes it on the row and on its user bubble — never on a chained row's", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { outboxId, messageId } = await t
      .withIdentity({ subject: s.owner })
      .mutation(api.send.sendMessage, { chatId: s.chatId, text: "bonjour", clientMessageId: "cm-1" });
    const out = await t.mutation(internal.bridge.lastGateBeforeSend, {
      outboxId,
      target: { instanceName: "alpha", agentId: "alice" },
      sendId: "webchat-xyz",
    });
    expect(out.kind).toBe("send");
    const [row, msg] = await t.run(async (ctx) => [await ctx.db.get(outboxId), await ctx.db.get(messageId as Id<"messages">)] as const);
    expect(row!.sendId).toBe("webchat-xyz");
    expect(msg!.sendId).toBe("webchat-xyz");

    // A chained row shares the head's bubble: the bubble keeps the head's identity.
    await t.run((ctx) => ctx.db.patch(outboxId, { status: "pending", chainStep: 1 }));
    await t.mutation(internal.bridge.lastGateBeforeSend, {
      outboxId,
      target: { instanceName: "alpha", agentId: "alice" },
      sendId: "webchat-chain",
    });
    const msg2 = await t.run((ctx) => ctx.db.get(messageId as Id<"messages">));
    expect(msg2!.sendId).toBe("webchat-xyz");
  });

  test("the bridge's answer CORRECTS a disagreeing identity on the ack", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { outboxId, messageId } = await t
      .withIdentity({ subject: s.owner })
      .mutation(api.send.sendMessage, { chatId: s.chatId, text: "bonjour", clientMessageId: "cm-2" });
    await t.run((ctx) => ctx.db.patch(outboxId, { status: "pending", sendId: "webchat-convex" }));
    await t.run((ctx) => ctx.db.patch(messageId as Id<"messages">, { sendId: "webchat-convex" }));
    await t.mutation(internal.bridge.markOutbox, {
      outboxId,
      status: "sent",
      expectedClientMessageId: "cm-2",
      sendId: "webchat-bridge",
    });
    const [row, msg] = await t.run(async (ctx) => [await ctx.db.get(outboxId), await ctx.db.get(messageId as Id<"messages">)] as const);
    expect(row!.sendId).toBe("webchat-bridge");
    expect(msg!.sendId).toBe("webchat-bridge");
  });
});

describe("the instance switch", () => {
  test("parses off|shadow|on and refuses anything else", () => {
    for (const mode of ["off", "shadow", "on"]) {
      expect(parseInstanceConfig({ transcriptProjection: mode })).toEqual({ transcriptProjection: mode });
    }
    expect(parseInstanceConfig({ transcriptProjection: "yes" })).toBe("invalid");
  });

  test("the routing carries the cursor only when the switch is not off", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const sessionKey = "agent:alice:atrium:chat:owner:" + s.chatId;
    await apply(t, s.chatId, [], { deltaCursor: "c:4" });
    // The test applied under SK; mirror it under the real key the routing derives.
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("transcriptCursors").collect())[0]!;
      await ctx.db.patch(c._id, { sessionKey });
    });
    const routing = await t.query(internal.bridge.getChatRouting, { chatId: s.chatId, userId: s.owner });
    expect(routing?.transcript).toEqual({ mode: "shadow", sessionKey, cursor: { sessionId: "s-1", deltaCursor: "c:4" } });
    await t.run((ctx) => ctx.db.patch(s.instanceId, { config: { transcriptProjection: "off" } }));
    const off = await t.query(internal.bridge.getChatRouting, { chatId: s.chatId, userId: s.owner });
    expect(off?.transcript).toBeNull();
    expect(off?.configOverrides).toMatchObject({ transcriptProjection: "off" });
  });
});

describe("the report diagnose_chat carries", () => {
  test("not projected → stated; projected and consistent → 0 gaps; a lost bubble → I1", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const report = () => t.query(internal.transcriptProjection.projectionReportInternal, { chatId: s.chatId });
    expect(await report()).toMatchObject({ mode: "shadow", verdict: "not_projected", gaps: null });

    const sendId = "webchat-" + "b".repeat(64);
    const ids = await t.run(async (ctx) => {
      const um = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm",
        text: "q",
        attachmentIds: [],
        status: "sent",
        messageId: um,
        sendId,
      });
      const am = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "a",
        runId: sendId,
        turnSessionKey: SK,
        updatedAt: 1,
      });
      return { um, am };
    });
    await apply(t, s.chatId, [user(1, sendId), reply(2, sendId)], {
      terminals: [{ runId: sendId, status: "completed", at: 3 }],
    });
    const ok = await report();
    expect(ok).toMatchObject({ verdict: "consistent", gapTotal: 0 });
    expect(ok!.gaps!.i1.visibleRuns).toBe(1);
    expect(ok!.gaps!.i2.judged).toBe(1);
    expect(ok!.gaps!.i3.userRows).toBe(1);
    // The session key never leaves as is (it names a person's canonical).
    expect(JSON.stringify(ok)).not.toContain(SK);

    // A delivery merged into the bubble ROTATES its runId (stream.ts
    // reopenParentForAnnounce): the turn's run still has its bubble — through the
    // dispatch that opened it — and the bubble still has its durable rows. Measured
    // live on the first shadow bench (2026-10-02): five false I1 gaps without this join.
    await t.run(async (ctx) => {
      const ob = (await ctx.db.query("outbox").collect())[0]!;
      await ctx.db.patch(ids.am, { runId: "announce:v1:x:y", dispatchOutboxId: String(ob._id) });
    });
    expect(await report()).toMatchObject({ verdict: "consistent", gapTotal: 0 });

    await t.run((ctx) => ctx.db.delete(ids.am));
    const lost = await report();
    expect(lost).toMatchObject({ verdict: "gaps", gapTotal: 1 });
    expect(lost!.gaps!.i1.transcriptOnly).toBe(1);
  });
});

describe("the dev bench helpers", () => {
  test("testSetTranscriptProjection reports the previous value for the restore", async () => {
    const prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
    const prevInst = process.env.DEV_LIVE_INSTANCES;
    process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
    process.env.DEV_LIVE_INSTANCES = "alpha";
    try {
      const t = convexTest(schema, modules);
      await seed(t, {});
      const first = await t.mutation(api.dev.testSetTranscriptProjection, { instanceName: "alpha", mode: "shadow" });
      expect(first).toEqual({ ok: true, previous: null });
      const second = await t.mutation(api.dev.testSetTranscriptProjection, { instanceName: "alpha", mode: "off" });
      expect(second).toEqual({ ok: true, previous: "shadow" });
    } finally {
      if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
      else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
      if (prevInst === undefined) delete process.env.DEV_LIVE_INSTANCES;
      else process.env.DEV_LIVE_INSTANCES = prevInst;
    }
  });
});

describe("the measured window — newest first, aligned, never an unqualified verdict when cut", () => {
  /** A projected session with `n` filler rows (one run, one bubble) above floor 0, then
   *  whatever `tail` adds at the NEWEST end. Written directly: `applyTranscript` caps a
   *  call at 200 rows, and the window is what is under test here. */
  async function longSession(t: T, s: Awaited<ReturnType<typeof seed>>, n: number) {
    await t.run(async (ctx) => {
      await ctx.db.insert("transcriptCursors", {
        chatId: s.chatId,
        instanceName: "alpha",
        sessionKey: SK,
        sessionId: "s-1",
        floorSeq: 0,
        floorAt: 0,
        lastKind: "delta",
        reads: 1,
        resets: 0,
        unidentified: 0,
        updatedAt: Date.now() + 60_000,
      });
      await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "old",
        runId: "filler-run",
        turnSessionKey: SK,
        updatedAt: 1,
      });
      for (let seq = 1; seq <= n; seq++) {
        await ctx.db.insert("transcriptRows", {
          chatId: s.chatId,
          instanceName: "alpha",
          sessionKey: SK,
          sessionId: "s-1",
          entryId: `f${seq}`,
          seq,
          role: "assistant",
          runId: "filler-run",
          hidden: false,
          visible: true,
          updatedAt: 1,
        });
      }
    });
  }
  const row = (t: T, chatId: Id<"chats">, r: Row) =>
    t.run((ctx) =>
      ctx.db.insert("transcriptRows", {
        chatId,
        instanceName: "alpha",
        sessionKey: SK,
        sessionId: "s-1",
        ...r,
        updatedAt: 1,
      }),
    );
  const report = (t: T, chatId: Id<"chats">) =>
    t.query(internal.transcriptProjection.projectionReportInternal, { chatId });

  test("I1: past the row bound, the NEWEST reply without a bubble is still found", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await longSession(t, s, 650);
    await row(t, s.chatId, reply(651, "lost-run"));
    const r = (await report(t, s.chatId))!;
    expect(r.gaps!.i1.transcriptOnly).toBe(1);
    expect(r.gaps!.i1.samples[0]).toMatchObject({ runId: "lost-run", firstSeq: 651 });
    expect(r.verdict).toBe("gaps");
    expect(r.window).toMatchObject({ truncated: true, rowsTruncated: true });
    expect(r.sessions[0]).toMatchObject({ rowsInWindow: 600, rowsTruncated: true, windowStartSeq: 52 });
  });

  /** A run `long-run` of `n` rows at seq 1..n, the ones `visibleAt` names visible, pushed
   *  out of the window by 650 filler rows, and its bubble written AFTER the window's oldest
   *  send (so it is judged). Rows are inserted in seq order: the run's index returns them
   *  in that order, newest last. */
  async function runOutsideWindow(t: T, n: number, visibleAt: number[]) {
    const s = await seed(t);
    await longSession(t, s, 0);
    await t.run(async (ctx) => {
      for (let seq = 1; seq <= n; seq++) {
        await ctx.db.insert("transcriptRows", {
          chatId: s.chatId,
          instanceName: "alpha",
          sessionKey: SK,
          sessionId: "s-1",
          entryId: `l${seq}`,
          seq,
          role: "assistant",
          runId: "long-run",
          hidden: false,
          visible: visibleAt.includes(seq),
          updatedAt: 1,
        });
      }
      for (let seq = n + 1; seq <= n + 650; seq++) {
        await ctx.db.insert("transcriptRows", {
          chatId: s.chatId,
          instanceName: "alpha",
          sessionKey: SK,
          sessionId: "s-1",
          entryId: `f${seq}`,
          seq,
          role: "assistant",
          runId: "filler-run",
          hidden: false,
          visible: true,
          updatedAt: 1,
        });
      }
    });
    const sendId = "webchat-" + "9".repeat(64);
    await t.run(async (ctx) => {
      const um = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-long",
        text: "q",
        attachmentIds: [],
        status: "sent",
        messageId: um,
        sendId,
      });
    });
    await row(t, s.chatId, user(n + 651, sendId));
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "the long run's reply",
        runId: "long-run",
        turnSessionKey: SK,
        updatedAt: 1,
      }),
    );
    return (await report(t, s.chatId))!;
  }

  test("I2 outside the window: a long run's visible reply (its LAST row) is found past the lookup bound", async () => {
    const t = convexTest(schema, modules);
    // 59 non-visible rows, then the reply: reading oldest first, 50 rows never reach it.
    const r = await runOutsideWindow(t, 60, [60]);
    expect(r.gaps!.i2).toMatchObject({ bubbleWithoutRow: 0, unmeasuredBubbles: 0 });
    expect(r.gaps!.i2.judged).toBeGreaterThan(0);
  });

  test("I2 outside the window: a lookup cut by its bound is UNMEASURED, never a row-less bubble", async () => {
    const t = convexTest(schema, modules);
    // The only visible row sits 60 rows from either end of a 120-row run.
    const r = await runOutsideWindow(t, 120, [60]);
    expect(r.gaps!.i2.bubbleWithoutRow).toBe(0);
    expect(r.gaps!.i2.unmeasuredBubbles).toBe(1);
    expect(r.window.incompleteReasons).toContain("unmeasured_bubbles");
    expect(r.verdict).toBe("consistent_in_window");
  });

  test("I2 outside the window: a run read WHOLE within the bound with no visible row IS row-less", async () => {
    const t = convexTest(schema, modules);
    // Exactly the bound, none visible: absence is proven, the gap is real.
    const r = await runOutsideWindow(t, 50, []);
    expect(r.gaps!.i2).toMatchObject({ bubbleWithoutRow: 1, unmeasuredBubbles: 0 });
    expect(r.verdict).toBe("gaps");
  });

  test("I3: past the row bound, the NEWEST send carried by two user bubbles is flagged", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await longSession(t, s, 650);
    const sendId = "webchat-" + "d".repeat(64);
    await t.run(async (ctx) => {
      const um = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId,
        updatedAt: 1,
      });
      await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-dup",
        text: "q",
        attachmentIds: [],
        status: "sent",
        messageId: um,
        sendId,
      });
    });
    await row(t, s.chatId, user(651, sendId));
    const r = (await report(t, s.chatId))!;
    expect(r.gaps!.i3.duplicated).toBe(1);
    expect(r.verdict).toBe("gaps");
  });

  test("I2: a bubble OLDER than the window is not judged — no false row-less verdict", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // An old bubble whose run left no visible row in the window (its rows, if any, are
    // older than the 600 newest).
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "a long time ago",
        runId: "ancient-run",
        turnSessionKey: SK,
        updatedAt: 1,
      }),
    );
    await longSession(t, s, 650);
    // The window's oldest send, dispatched AFTER that bubble, opens the window.
    const sendId = "webchat-" + "e".repeat(64);
    await t.run(async (ctx) => {
      const um = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-w",
        text: "q",
        attachmentIds: [],
        status: "sent",
        messageId: um,
        sendId,
      });
    });
    await row(t, s.chatId, user(651, sendId));
    await row(t, s.chatId, reply(652, "filler-run"));
    const r = (await report(t, s.chatId))!;
    expect(r.gaps!.i2.bubbleWithoutRow).toBe(0);
    expect(r.gaps!.i2.samples).toEqual([]);
    expect(r.gapTotal).toBe(0);
    // Nothing found — but the window was cut, so the verdict says so.
    expect(r.verdict).toBe("consistent_in_window");
  });

  test("bubbles cut by their own bound inside the window: never an unqualified `consistent`", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("transcriptCursors", {
        chatId: s.chatId,
        instanceName: "alpha",
        sessionKey: SK,
        sessionId: "s-1",
        floorSeq: 0,
        floorAt: 0,
        lastKind: "delta",
        reads: 1,
        resets: 0,
        unidentified: 0,
        updatedAt: Date.now() + 60_000,
      });
      for (let i = 0; i < 205; i++) {
        await ctx.db.insert("messages", {
          chatId: s.chatId,
          userId: s.owner,
          role: "user",
          status: "complete" as const,
          text: `m${i}`,
          updatedAt: 1,
        });
      }
    });
    const r = (await report(t, s.chatId))!;
    expect(r.window).toMatchObject({ truncated: true, rowsTruncated: false, bubblesTruncated: true, qualified: true });
    expect(r.verdict).toBe("consistent_in_window");
  });

  test("a window that covers everything above the floor keeps the unqualified verdict", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await longSession(t, s, 20);
    const r = (await report(t, s.chatId))!;
    expect(r.window.truncated).toBe(false);
    expect(r.verdict).toBe("consistent");
    expect(r.sessions[0]).toMatchObject({ rowsInWindow: 20, rowsTruncated: false, windowStartSeq: 1 });
  });
});

describe("the bubble boundary after a rotation, and the holes a reset leaves", () => {
  const report = (t: T, chatId: Id<"chats">) =>
    t.query(internal.transcriptProjection.projectionReportInternal, { chatId });
  const bubble = (t: T, s: Awaited<ReturnType<typeof seed>>, runId: string) =>
    t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "x",
        runId,
        turnSessionKey: SK,
        updatedAt: Date.now(),
      }),
    );
  const outbox = (t: T, s: Awaited<ReturnType<typeof seed>>, sendId: string) =>
    t.run(async (ctx) => {
      const um = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: `cm-${sendId}`,
        text: "q",
        attachmentIds: [],
        status: "sent",
        messageId: um,
        sendId,
      });
    });
  const tick = () => new Promise((r) => setTimeout(r, 5));

  test("a ROTATION found after the turn: the new session's first bubble is judged from its proven dispatch", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const first = "webchat-" + "1".repeat(64);
    await outbox(t, s, first);
    await apply(t, s.chatId, [user(1, first), reply(2, first)]);
    await bubble(t, s, first);
    await tick();
    // The turn that rotated the session: dispatched, bubble opened under the CLIENT run,
    // reply written by another run — and the rotation is only discovered on the next read.
    const second = "webchat-" + "2".repeat(64);
    await outbox(t, s, second);
    await bubble(t, s, second);
    await bubble(t, s, "run-reply");
    await tick();
    await apply(t, s.chatId, [user(1, second), reply(2, "run-reply")], { sessionId: "s-2" });
    const r = (await report(t, s.chatId))!;
    expect(r.sessions[0]).toMatchObject({ sessionId: "s-2", floorSeq: 0, boundaryProven: true });
    expect(r.gaps!.i2.bubbleWithoutRow).toBe(1);
    expect(r.gaps!.i2.samples[0]!.runId).toBe(second);
    expect(r.verdict).toBe("gaps");
  });

  test("a rotation with NO provable dispatch: the boundary is unproven and the verdict says so — until a send proves it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const first = "webchat-" + "3".repeat(64);
    await outbox(t, s, first);
    await apply(t, s.chatId, [user(1, first), reply(2, first)]);
    await bubble(t, s, first);
    await apply(t, s.chatId, [user(1, "control-ui-input"), reply(2, "run-foreign")], { sessionId: "s-2" });
    let r = (await report(t, s.chatId))!;
    expect(r.window).toMatchObject({ boundaryUnproven: true, qualified: true });
    expect(r.verdict).not.toBe("consistent");
    // A later send of ours, read in the same session, proves the boundary.
    const later = "webchat-" + "4".repeat(64);
    await outbox(t, s, later);
    await apply(t, s.chatId, [user(3, later)], { sessionId: "s-2", kind: "delta" });
    r = (await report(t, s.chatId))!;
    expect(r.window.boundaryUnproven).toBe(false);
    expect(r.sessions[0]!.boundaryProven).toBe(true);
  });

  test("a RESET answered by a tail page that starts above what was read records the hole; the verdict is qualified", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const sendId = "webchat-" + "5".repeat(64);
    await outbox(t, s, sendId);
    await apply(t, s.chatId, [user(1, sendId), reply(2, sendId)], { deltaCursor: "c:2" });
    await bubble(t, s, sendId);
    // Distinct milliseconds: the hole opens at the last covered read, strictly after.
    await tick();
    await apply(t, s.chatId, [reply(3, sendId)], { kind: "delta", deltaCursor: "c:3" });
    await tick();
    // While the hole is open, a bubble whose rows the reads never returned.
    await bubble(t, s, "run-in-the-hole");
    await tick();
    await apply(t, s.chatId, [], { kind: "reset" });
    await apply(t, s.chatId, [reply(250, "run-tail"), reply(251, "run-tail")], { deltaCursor: "c:251" });
    await bubble(t, s, "run-tail");
    const r = (await report(t, s.chatId))!;
    expect(r.sessions[0]!.coverageGaps).toEqual([{ fromSeq: 4, toSeq: 249 }]);
    expect(r.window).toMatchObject({ coverageGaps: 1, qualified: true, truncated: false });
    // No false row-less verdict for the bubble written while the hole was open.
    expect(r.gaps!.i2.bubbleWithoutRow).toBe(0);
    expect(r.gaps!.i2.inCoverageGap).toBe(1);
    expect(r.verdict).toBe("consistent_in_window");
  });

  test("a tail page that OVERLAPS what was read leaves no hole", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(5, "r"), reply(6, "r")], { deltaCursor: "c:6" });
    await apply(t, s.chatId, [], { kind: "reset" });
    await apply(t, s.chatId, [reply(6, "r"), reply(7, "r2")], { deltaCursor: "c:7" });
    const c = (await t.run((ctx) => ctx.db.query("transcriptCursors").collect()))[0]!;
    expect(c.gaps ?? []).toEqual([]);
  });
});

describe("which sessions are measured, and when a bubble counts as settled", () => {
  const report = (t: T, chatId: Id<"chats">) =>
    t.query(internal.transcriptProjection.projectionReportInternal, { chatId });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const cursor = (t: T, chatId: Id<"chats">, sessionKey: string, updatedAt: number) =>
    t.run((ctx) =>
      ctx.db.insert("transcriptCursors", {
        chatId,
        instanceName: "alpha",
        sessionKey,
        sessionId: "s",
        floorSeq: 0,
        floorAt: 0,
        lastKind: "delta",
        reads: 1,
        resets: 0,
        unidentified: 0,
        updatedAt,
        coveredAt: updatedAt,
      }),
    );

  test("more than 10 projected sessions: the MOST RECENT are measured and the cut qualifies the verdict", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const now = Date.now() + 60_000;
    // Ten old sessions created FIRST, then the newest one — the one with the defect.
    for (let i = 0; i < 10; i++) await cursor(t, s.chatId, `${SK}:old-${i}`, 1_000 + i);
    await cursor(t, s.chatId, `${SK}:newest`, now);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "said something",
        runId: "run-without-rows",
        turnSessionKey: `${SK}:newest`,
        updatedAt: 2,
      }),
    );
    const r = (await report(t, s.chatId))!;
    expect(r.sessions).toHaveLength(10);
    expect(r.window).toMatchObject({ sessionsTruncated: true, truncated: true, qualified: true });
    expect(r.gaps!.i2.bubbleWithoutRow).toBe(1);
    expect(r.verdict).toBe("gaps");
  });

  test("ten sessions or fewer: nothing cut", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (let i = 0; i < 10; i++) await cursor(t, s.chatId, `${SK}:s-${i}`, 1_000 + i);
    const r = (await report(t, s.chatId))!;
    expect(r.window.sessionsTruncated).toBe(false);
    expect(r.verdict).toBe("consistent");
  });

  test("a RESET (then a failed recovery) neither settles a bubble nor forgets the active runs", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const sendId = "webchat-" + "6".repeat(64);
    await t.run(async (ctx) => {
      const um = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-6",
        text: "q",
        attachmentIds: [],
        status: "sent",
        messageId: um,
        sendId,
      });
    });
    await apply(t, s.chatId, [user(1, sendId)], { deltaCursor: "c:1", activeRunIds: ["run-live"] });
    await tick();
    // A bubble that changed AFTER the last read that returned rows.
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "still being read back",
        runId: "run-after-the-read",
        turnSessionKey: SK,
        updatedAt: Date.now(),
      }),
    );
    await tick();
    // The reset is recorded; the recovery read that should follow never lands.
    await apply(t, s.chatId, [], { kind: "reset" });
    const c = (await t.run((ctx) => ctx.db.query("transcriptCursors").collect()))[0]!;
    expect(c.activeRunIds).toEqual(["run-live"]);
    const r = (await report(t, s.chatId))!;
    expect(r.gaps!.i2.bubbleWithoutRow).toBe(0);
    expect(r.gaps!.i2.unsettled).toBe(1);
  });
});

describe("ONE completeness predicate: nothing unmeasured can read `consistent`", () => {
  const cleanGaps = () =>
    assessProjection({ rows: [], bubblesForRun: () => new Set(), bubbles: [], resolveSend: () => ({ kind: "unknown" }) });
  const clean = (): CompletenessFacts => ({
    sessionsTruncated: false,
    rowsTruncated: false,
    bubblesTruncated: false,
    coverageGaps: 0,
    coverageGapsEvicted: 0,
    boundaryUnproven: false,
    unidentifiedRows: 0,
    readBudgetExhausted: false,
    gaps: cleanGaps(),
  });
  /** One way to make each reason true — and ONLY that one. A reason added to the registry
   *  without an entry here fails the equality below. */
  const TRIGGER: Record<IncompletenessReason, (f: CompletenessFacts) => void> = {
    sessions_truncated: (f) => void (f.sessionsTruncated = true),
    rows_truncated: (f) => void (f.rowsTruncated = true),
    bubbles_truncated: (f) => void (f.bubblesTruncated = true),
    coverage_gaps: (f) => void (f.coverageGaps = 1),
    coverage_gaps_evicted: (f) => void (f.coverageGapsEvicted = 3),
    boundary_unproven: (f) => void (f.boundaryUnproven = true),
    unidentified_rows: (f) => void (f.unidentifiedRows = 2),
    unattributed_rows: (f) => void (f.gaps.i1.unattributedRows = 1),
    unattributed_user_rows: (f) => void (f.gaps.i3.unattributedUserRows = 1),
    unattributed_bubbles: (f) => void (f.gaps.i2.unattributedBubbles = 1),
    unsettled_bubbles: (f) => void (f.gaps.i2.unsettled = 1),
    bubbles_in_coverage_gap: (f) => void (f.gaps.i2.inCoverageGap = 1),
    read_budget_exhausted: (f) => void (f.readBudgetExhausted = true),
    unmeasured_runs: (f) => void (f.gaps.i1.unmeasuredRuns = 1),
    unmeasured_bubbles: (f) => void (f.gaps.i2.unmeasuredBubbles = 1),
    unmeasured_sends: (f) => void (f.gaps.i3.unmeasuredSends = 1),
  };

  test("a bubble naming no run, and a streaming one, are COUNTED (not silently skipped)", () => {
    const g = assessProjection({
      rows: [],
      bubblesForRun: () => new Set(),
      bubbles: [
        { messageId: "m0", runIds: [], status: "complete", hasText: true, settled: true },
        { messageId: "m1", runIds: ["r"], status: "streaming", hasText: false, settled: true },
      ],
      resolveSend: () => ({ kind: "unknown" }),
    });
    expect([g.i2.unattributedBubbles, g.i2.unsettled]).toEqual([1, 1]);
  });

  test("a bubble whose only run is UNMEASURED outside the window is not judged row-less", () => {
    const bubble: ProjectionBubble = { messageId: "m", runIds: ["r"], status: "complete", hasText: true, settled: true };
    const base = {
      rows: [],
      bubblesForRun: () => new Set<string>(),
      bubbles: [bubble],
      resolveSend: (): SendResolution => ({ kind: "unknown" }),
    };
    expect(assessProjection(base).i2).toMatchObject({ judged: 1, bubbleWithoutRow: 1, unmeasuredBubbles: 0 });
    expect(assessProjection({ ...base, runRowsUnmeasured: () => true }).i2).toMatchObject({
      judged: 0,
      bubbleWithoutRow: 0,
      unmeasuredBubbles: 1,
    });
    // A durable row found by another of its runs still wins.
    expect(
      assessProjection({
        ...base,
        bubbles: [{ ...bubble, runIds: ["r", "r2"] }],
        runRowsUnmeasured: (id) => id === "r",
        runHasRowsOutsideWindow: (id) => id === "r2",
      }).i2,
    ).toMatchObject({ judged: 1, bubbleWithoutRow: 0, unmeasuredBubbles: 0 });
  });

  test("the table enumerates EVERY reason the registry names", () => {
    expect(Object.keys(TRIGGER).sort()).toEqual([...INCOMPLETENESS_REASONS].sort());
  });

  test("nothing unmeasured: `consistent`", () => {
    expect(incompletenessReasons(clean())).toEqual([]);
    expect(projectionVerdict(0, incompletenessReasons(clean()))).toBe("consistent");
  });

  for (const reason of INCOMPLETENESS_REASONS) {
    test(`${reason} alone: incomplete, never \`consistent\``, () => {
      const f = clean();
      TRIGGER[reason](f);
      expect(incompletenessReasons(f)).toEqual([reason]);
      expect(projectionVerdict(0, incompletenessReasons(f))).toBe("consistent_in_window");
      // A real gap still wins.
      expect(projectionVerdict(1, incompletenessReasons(f))).toBe("gaps");
    });
  }

  test("every 'could not measure' counter of the gaps object is bound to a reason", () => {
    // The counters that are NOT gaps and NOT verified facts: each must make the
    // measurement incomplete. Listed by walking the object, so a new counter shows up.
    const g = cleanGaps();
    const counters = [
      ...Object.keys(g.i1).map((k) => `i1.${k}`),
      ...Object.keys(g.i2).map((k) => `i2.${k}`),
      ...Object.keys(g.i3).map((k) => `i3.${k}`),
    ].sort();
    const GAPS = ["i1.transcriptOnly", "i1.duplicated", "i2.bubbleWithoutRow", "i3.missingBubble", "i3.duplicated", "i3.unmatchedAtriumSend"];
    const VERIFIED = [
      "i1.visibleRuns",
      "i1.samples",
      "i2.judged",
      "i2.errorCardWithoutRow",
      "i2.samples",
      "i3.userRows",
      "i3.internalSends",
      "i3.foreignInputs",
      "i3.steeredInputs",
      "i3.samples",
    ];
    const UNMEASURED = [
      "i1.unattributedRows",
      "i1.unmeasuredRuns",
      "i2.unsettled",
      "i2.unattributedBubbles",
      "i2.inCoverageGap",
      "i2.unmeasuredBubbles",
      "i3.unattributedUserRows",
      "i3.unmeasuredSends",
    ];
    expect(counters).toEqual([...GAPS, ...VERIFIED, ...UNMEASURED].sort());
    for (const path of UNMEASURED) {
      const f = clean();
      const [section, key] = path.split(".") as ["i1" | "i2" | "i3", string];
      (f.gaps[section] as unknown as Record<string, number>)[key] = 1;
      expect(incompletenessReasons(f), path).toHaveLength(1);
    }
  });

  describe("the report itself", () => {
    const report = (t: T, chatId: Id<"chats">) =>
      t.query(internal.transcriptProjection.projectionReportInternal, { chatId });
    const X = "webchat-" + "7".repeat(64);
    /** A proven, verified first turn (so the only thing left to report is the case). */
    const provenTurn = async (t: T, s: Awaited<ReturnType<typeof seed>>, extra: Row[] = []) => {
      await t.run(async (ctx) => {
        const um = await ctx.db.insert("messages", {
          chatId: s.chatId,
          userId: s.owner,
          role: "user",
          status: "complete" as const,
          text: "q",
          sendId: X,
          updatedAt: 1,
        });
        await ctx.db.insert("outbox", {
          chatId: s.chatId,
          userId: s.owner,
          clientMessageId: "cm-x",
          text: "q",
          attachmentIds: [],
          status: "sent",
          messageId: um,
          sendId: X,
        });
        await ctx.db.insert("messages", {
          chatId: s.chatId,
          userId: s.owner,
          role: "assistant",
          status: "complete" as const,
          text: "a",
          runId: X,
          turnSessionKey: SK,
          updatedAt: 1,
        });
      });
      await apply(t, s.chatId, [user(1, X), reply(2, X), ...extra]);
    };

    test("the proven turn alone is complete (control)", async () => {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      await provenTurn(t, s);
      const r = (await report(t, s.chatId))!;
      expect(r.window.incompleteReasons).toEqual([]);
      expect(r.verdict).toBe("consistent");
    });

    test("a visible reply with NO run cannot be verified: `unattributed_rows`, not `consistent`", async () => {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      await provenTurn(t, s, [{ entryId: "a3", seq: 3, role: "assistant", hidden: false, visible: true }]);
      const r = (await report(t, s.chatId))!;
      expect(r.gaps!.i1.unattributedRows).toBe(1);
      expect(r.window.incompleteReasons).toContain("unattributed_rows");
      expect(r.verdict).toBe("consistent_in_window");
    });

    test("rows the reads could not identify: `unidentified_rows`", async () => {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      await provenTurn(t, s);
      await apply(t, s.chatId, [], { kind: "delta", unidentified: 3 });
      const r = (await report(t, s.chatId))!;
      expect(r.window.incompleteReasons).toContain("unidentified_rows");
      expect(r.verdict).toBe("consistent_in_window");
    });

    test("holes evicted from the bounded gap list still count: `coverage_gaps_evicted`", async () => {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      await provenTurn(t, s);
      await t.run(async (ctx) => {
        const c = (await ctx.db.query("transcriptCursors").collect())[0]!;
        await ctx.db.patch(c._id, { gapsDropped: 2 });
      });
      const r = (await report(t, s.chatId))!;
      expect(r.window.incompleteReasons).toEqual(["coverage_gaps_evicted"]);
      expect(r.verdict).toBe("consistent_in_window");
    });

    test("a user row with no send key: `unattributed_user_rows`", async () => {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      await provenTurn(t, s, [{ entryId: "u3", seq: 3, role: "user", hidden: false, visible: true }]);
      const r = (await report(t, s.chatId))!;
      expect(r.window.incompleteReasons).toContain("unattributed_user_rows");
      expect(r.verdict).toBe("consistent_in_window");
    });

    test("a bubble still streaming: `unsettled_bubbles`", async () => {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      await provenTurn(t, s);
      await t.run((ctx) =>
        ctx.db.insert("messages", {
          chatId: s.chatId,
          userId: s.owner,
          role: "assistant",
          status: "streaming" as const,
          text: "",
          runId: "run-live",
          turnSessionKey: SK,
          updatedAt: 1,
        }),
      );
      const r = (await report(t, s.chatId))!;
      expect(r.window.incompleteReasons).toEqual(["unsettled_bubbles"]);
      expect(r.verdict).toBe("consistent_in_window");
    });
  });
});

describe("an OLDER read landing late, and the real dispatch time", () => {
  const cursorOf = (t: T) => t.run(async (ctx) => (await ctx.db.query("transcriptCursors").collect())[0]!);

  test("a stale apply merges its rows but never rewinds the cursor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(1, "r")], { deltaCursor: "c:1", readAt: 100 });
    await apply(t, s.chatId, [reply(5, "r")], { kind: "delta", deltaCursor: "c:5", readAt: 300, activeRunIds: ["live"] });
    // The read issued at 200 timed out on the bridge and commits only now.
    const res = await apply(t, s.chatId, [reply(3, "r")], { kind: "delta", deltaCursor: "c:3", readAt: 200, activeRunIds: [] });
    expect(res).toMatchObject({ stale: true });
    const c = await cursorOf(t);
    expect(c).toMatchObject({ deltaCursor: "c:5", lastSeq: 5, lastReadAt: 300, activeRunIds: ["live"], staleReads: 1 });
    // Its row is not lost.
    const seqs = (await t.run((ctx) => ctx.db.query("transcriptRows").collect())).map((r) => r.seq).sort();
    expect(seqs).toEqual([1, 3, 5]);
  });

  test("after a rotation, a stale read of the OLD session neither restores it nor resets the floor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(4, "old")], { sessionId: "s-1", deltaCursor: "c:4", readAt: 100 });
    await apply(t, s.chatId, [reply(1, "new")], { sessionId: "s-2", deltaCursor: "n:1", readAt: 300 });
    await apply(t, s.chatId, [reply(5, "old")], { sessionId: "s-1", kind: "delta", deltaCursor: "c:5", readAt: 200 });
    const c = await cursorOf(t);
    expect(c).toMatchObject({ sessionId: "s-2", deltaCursor: "n:1", floorSeq: 0, resets: 1 });
    // The late row is kept under ITS session.
    const late = (await t.run((ctx) => ctx.db.query("transcriptRows").collect())).find((r) => r.seq === 5)!;
    expect(late.sessionId).toBe("s-1");
  });

  test("a bridge that sends no read time is judged by arrival (older bridges keep working)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(1, "r")], { deltaCursor: "c:1" });
    await apply(t, s.chatId, [reply(2, "r")], { kind: "delta", deltaCursor: "c:2" });
    expect((await cursorOf(t)).deltaCursor).toBe("c:2");
  });

  test("the bubble boundary is the DISPATCH, not the creation of a queued send", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const first = "webchat-" + "8".repeat(64);
    const queued = "webchat-" + "9".repeat(64);
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const outbox = (sendId: string, dispatchedAt?: number) =>
      t.run((ctx) =>
        ctx.db.insert("outbox", {
          chatId: s.chatId,
          userId: s.owner,
          clientMessageId: `cm-${sendId}`,
          text: "q",
          attachmentIds: [],
          status: "sent",
          sendId,
          ...(dispatchedAt === undefined ? {} : { dispatchedAt }),
        }),
      );
    const bubble = (runId: string) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          chatId: s.chatId,
          userId: s.owner,
          role: "assistant",
          status: "complete" as const,
          text: "x",
          runId,
          turnSessionKey: SK,
          updatedAt: 1,
        }),
      );
    await outbox(first, Date.now());
    await apply(t, s.chatId, [user(1, first), reply(2, first)], { sessionId: "s-1" });
    // A send QUEUED now, while the old session still answers…
    const queuedId = await outbox(queued);
    await tick();
    // …a bubble of the OLD session written after the queueing, with no row of its own…
    await bubble("old-session-run");
    await tick();
    // …then the queued send leaves and opens the new session.
    await t.run((ctx) => ctx.db.patch(queuedId, { dispatchedAt: Date.now() }));
    await tick();
    await bubble("new-reply");
    await apply(t, s.chatId, [user(1, queued), reply(2, "new-reply")], { sessionId: "s-2" });
    const r = (await t.query(internal.transcriptProjection.projectionReportInternal, { chatId: s.chatId }))!;
    // The old session's bubble is outside the new session's window: no false I2.
    expect(r.gaps!.i2.bubbleWithoutRow).toBe(0);
    expect(r.verdict).toBe("consistent");
  });

  test("the last gate stamps the dispatch time with the send identity", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { outboxId } = await t
      .withIdentity({ subject: s.owner })
      .mutation(api.send.sendMessage, { chatId: s.chatId, text: "x", clientMessageId: "cm-d" });
    vi.setSystemTime(new Date(5_000_000_000_000));
    await t.mutation(internal.bridge.lastGateBeforeSend, {
      outboxId,
      target: { instanceName: "alpha", agentId: "alice" },
      sendId: "webchat-d",
    });
    const row = await t.run((ctx) => ctx.db.get(outboxId));
    expect(row!.dispatchedAt).toBe(5_000_000_000_000);
  });
});

describe("coverage is the read's OWN time, not its arrival", () => {
  test("a delayed POST does not cover a bubble written after the read was issued", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const X = "webchat-" + "a".repeat(64);
    await t.run(async (ctx) => {
      const um = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId: X,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-a",
        text: "q",
        attachmentIds: [],
        status: "sent",
        messageId: um,
        sendId: X,
        dispatchedAt: 1,
      });
    });
    const issuedAt = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    // A new turn writes and finalizes its bubble AFTER the read was issued…
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "fresh reply",
        runId: "run-after-the-read",
        turnSessionKey: SK,
        updatedAt: Date.now(),
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    // …and only then does the read's POST land.
    await apply(t, s.chatId, [user(1, X)], { readAt: issuedAt });
    const c = (await t.run((ctx) => ctx.db.query("transcriptCursors").collect()))[0]!;
    expect(c.coveredAt).toBe(issuedAt);
    const r = (await t.query(internal.transcriptProjection.projectionReportInternal, { chatId: s.chatId }))!;
    expect(r.gaps!.i2.bubbleWithoutRow).toBe(0);
    expect(r.gaps!.i2.unsettled).toBe(1);
  });

  test("a hole is dated by the read that FOUND it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(1, "r")], { deltaCursor: "c:1", readAt: 1_000 });
    await apply(t, s.chatId, [], { kind: "reset", readAt: 2_000 });
    await apply(t, s.chatId, [reply(50, "r")], { deltaCursor: "c:50", readAt: 3_000 });
    const c = (await t.run((ctx) => ctx.db.query("transcriptCursors").collect()))[0]!;
    expect(c.gaps).toEqual([{ fromSeq: 2, toSeq: 49, sinceAt: 1_000, detectedAt: 3_000 }]);
  });
});

describe("run bubbles that no longer exist, and active runs without rows", () => {
  const report = (t: T, chatId: Id<"chats">) =>
    t.query(internal.transcriptProjection.projectionReportInternal, { chatId });
  const runsOf = (t: T) =>
    t.run(async (ctx) =>
      Object.fromEntries((await ctx.db.query("transcriptRuns").collect()).map((r) => [r.runId, r.status])),
    );

  test("a `runBubbles` record pointing at a DELETED message does not count as a bubble (I1)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const gone = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "x",
        updatedAt: 1,
      });
      await ctx.db.insert("runBubbles", { chatId: s.chatId, runId: "announce:v1:a", messageId: gone, createdAt: 1 });
      await ctx.db.delete(gone);
    });
    // An empty first read sets the floor at 0, so the row below is measured.
    await apply(t, s.chatId, [], { readAt: 1 });
    await apply(t, s.chatId, [reply(5, "announce:v1:a")], { kind: "delta", readAt: 2 });
    const r = (await report(t, s.chatId))!;
    expect(r.gaps!.i1.visibleRuns).toBe(1);
    expect(r.gaps!.i1.transcriptOnly).toBe(1);
  });

  test("…while one pointing at an existing bubble does (control)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const here = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "x",
        updatedAt: 1,
      });
      await ctx.db.insert("runBubbles", { chatId: s.chatId, runId: "announce:v1:b", messageId: here, createdAt: 1 });
    });
    // An empty first read sets the floor at 0, so the row below is measured.
    await apply(t, s.chatId, [], { readAt: 1 });
    await apply(t, s.chatId, [reply(5, "announce:v1:b")], { kind: "delta", readAt: 2 });
    const r = (await report(t, s.chatId))!;
    expect(r.gaps!.i1.visibleRuns).toBe(1);
    expect(r.gaps!.i1.transcriptOnly).toBe(0);
    expect(r.gaps!.i1.duplicated).toBe(0);
  });

  test("an ACTIVE run without a row is recorded streaming; a persisted one becomes streaming; a terminal one stays", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(1, "run-p"), reply(2, "run-done")], {
      terminals: [{ runId: "run-done", status: "completed", at: 1 }],
      readAt: 100,
    });
    await apply(t, s.chatId, [], {
      kind: "delta",
      activeRunIds: ["run-new", "run-p", "run-done"],
      readAt: 200,
    });
    expect(await runsOf(t)).toEqual({ "run-p": "streaming", "run-done": "completed", "run-new": "streaming" });
    const r = (await report(t, s.chatId))!;
    expect(r.runs.byStatus).toEqual({ streaming: 2, completed: 1 });
  });

  test("a STALE read's active runs are ignored, and so are a reset's", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await apply(t, s.chatId, [reply(1, "run-p")], { readAt: 300 });
    await apply(t, s.chatId, [], { kind: "delta", activeRunIds: ["run-p", "run-ghost"], readAt: 200 });
    await apply(t, s.chatId, [], { kind: "reset", activeRunIds: ["run-p", "run-ghost"], readAt: 400 });
    expect(await runsOf(t)).toEqual({ "run-p": "persisted" });
  });
});

describe("I3 counts DISTINCT bubbles; the report is bounded by volume; diagnose never fails on it", () => {
  const report = (t: T, chatId: Id<"chats">, readBudgetBytes?: number) =>
    t.query(internal.transcriptProjection.projectionReportInternal, {
      chatId,
      ...(readBudgetBytes === undefined ? {} : { readBudgetBytes }),
    });
  const HEAD = "webchat-" + "b".repeat(63) + "1";
  const STEP = "webchat-" + "b".repeat(63) + "2";

  test("a chained step's key on a SECOND bubble is a duplicate, though the head bubble keeps the head's key", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const u = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId: HEAD,
        updatedAt: 1,
      });
      await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q again",
        sendId: STEP,
        updatedAt: 1,
      });
      for (const [sendId, chainStep] of [[HEAD, undefined], [STEP, 1]] as const) {
        await ctx.db.insert("outbox", {
          chatId: s.chatId,
          userId: s.owner,
          clientMessageId: `cm-${sendId}`,
          text: "q",
          attachmentIds: [],
          status: "sent",
          messageId: u,
          sendId,
          dispatchedAt: 1,
          ...(chainStep === undefined ? {} : { chainStep }),
        });
      }
    });
    await apply(t, s.chatId, [user(1, HEAD), user(2, STEP)]);
    const r = (await report(t, s.chatId))!;
    expect(r.gaps!.i3.duplicated).toBe(1);
    expect(r.gaps!.i3.samples).toEqual([{ seq: 2, kind: "duplicated", bubbles: 2 }]);
  });

  test("LARGE messages: the byte budget stops the reads; the verdict says what was not measured, nothing throws", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const X = "webchat-" + "c".repeat(64);
    const big = "x".repeat(100_000);
    await t.run(async (ctx) => {
      const um = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId: X,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-big",
        text: "q",
        attachmentIds: [],
        status: "sent",
        messageId: um,
        sendId: X,
        dispatchedAt: 1,
      });
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("messages", {
          chatId: s.chatId,
          userId: s.owner,
          role: "assistant",
          status: "complete" as const,
          text: big,
          runId: `run-${i}`,
          turnSessionKey: SK,
          updatedAt: 1,
        });
      }
    });
    await apply(
      t,
      s.chatId,
      [user(1, X), ...Array.from({ length: 30 }, (_, i) => reply(i + 2, `run-${i}`))],
    );
    // Unbounded, every one of the 30 replies is found in its bubble.
    const full = (await report(t, s.chatId))!;
    expect(full.window.readBudgetExhausted).toBe(false);
    expect(full.gaps!.i1).toMatchObject({ visibleRuns: 30, transcriptOnly: 0 });
    // A 500 KB budget: about five of the 100 KB bubbles, then nothing more is read.
    const cut = (await report(t, s.chatId, 500_000))!;
    expect(cut.window).toMatchObject({ readBudgetExhausted: true, bubblesTruncated: true, qualified: true });
    expect(cut.window.incompleteReasons).toEqual(
      expect.arrayContaining(["read_budget_exhausted", "bubbles_truncated", "unmeasured_runs"]),
    );
    // Lookups that did not run are UNMEASURED — never "no bubble".
    expect(cut.gaps!.i1.transcriptOnly).toBe(0);
    expect(cut.gaps!.i1.unmeasuredRuns).toBeGreaterThan(0);
    expect(cut.verdict).toBe("consistent_in_window");
  });

  /** A world whose bubbles are all OLDER than the window's send (the bubble scan reads
   *  none of them), so the budget is spent only by the lookups under test: `runBubbles`
   *  100 KB replies of run `dup-run` (one visible row) and `sendBubbles` 100 KB user
   *  bubbles carrying send X, the first one its head. */
  async function cutWorld(t: T, opts: { runBubbles: number; sendBubbles: number }) {
    const s = await seed(t);
    const X = "webchat-" + "7".repeat(64);
    const big = "x".repeat(100_000);
    const head = await t.run(async (ctx) => {
      let first: Id<"messages"> | null = null;
      for (let i = 0; i < opts.sendBubbles; i++) {
        const id = await ctx.db.insert("messages", {
          chatId: s.chatId,
          userId: s.owner,
          role: "user",
          status: "complete" as const,
          text: big,
          sendId: X,
          updatedAt: 1,
        });
        first ??= id;
      }
      for (let i = 0; i < opts.runBubbles; i++) {
        await ctx.db.insert("messages", {
          chatId: s.chatId,
          userId: s.owner,
          role: "assistant",
          status: "complete" as const,
          text: big,
          runId: "dup-run",
          turnSessionKey: SK,
          updatedAt: 1,
        });
      }
      return first;
    });
    await new Promise((r) => setTimeout(r, 5));
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-cut",
        text: "q",
        attachmentIds: [],
        status: "sent",
        ...(head === null ? {} : { messageId: head }),
        sendId: X,
        dispatchedAt: Date.now(),
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await apply(t, s.chatId, [user(1, X), ...(opts.runBubbles > 0 ? [reply(2, "dup-run")] : [])]);
    return s;
  }

  test("I1: a lookup CUT after ONE bubble is unmeasured — one found proves existence, not uniqueness", async () => {
    const t = convexTest(schema, modules);
    const s = await cutWorld(t, { runBubbles: 2, sendBubbles: 1 });
    // Unbounded: the duplicate is there.
    expect((await report(t, s.chatId))!.gaps!.i1).toMatchObject({ duplicated: 1, unmeasuredRuns: 0 });
    // The first 100 KB reply spends a 50 KB budget: the second is never read.
    const cut = (await report(t, s.chatId, 50_000))!;
    expect(cut.gaps!.i1).toMatchObject({ visibleRuns: 1, duplicated: 0, transcriptOnly: 0, unmeasuredRuns: 1 });
    expect(cut.window.incompleteReasons).toContain("unmeasured_runs");
    expect(cut.verdict).toBe("consistent_in_window");
  });

  test("I1: a lookup cut after TWO bubbles still reports the duplicate", async () => {
    const t = convexTest(schema, modules);
    const s = await cutWorld(t, { runBubbles: 3, sendBubbles: 1 });
    // Two replies read, the third cut off: two already prove the duplicate.
    const cut = (await report(t, s.chatId, 150_000))!;
    expect(cut.window.readBudgetExhausted).toBe(true);
    expect(cut.gaps!.i1).toMatchObject({ duplicated: 1, unmeasuredRuns: 0 });
    expect(cut.gaps!.i1.samples).toEqual([{ runId: "dup-run", firstSeq: 2, bubbles: 2 }]);
    expect(cut.verdict).toBe("gaps");
  });

  test("I1 and I3: a COMPLETE lookup that finds one bubble is satisfied", async () => {
    const t = convexTest(schema, modules);
    const s = await cutWorld(t, { runBubbles: 1, sendBubbles: 1 });
    const r = (await report(t, s.chatId))!;
    expect(r.window.readBudgetExhausted).toBe(false);
    expect(r.gaps!.i1).toMatchObject({ visibleRuns: 1, duplicated: 0, transcriptOnly: 0, unmeasuredRuns: 0 });
    expect(r.gaps!.i3).toMatchObject({ userRows: 1, duplicated: 0, missingBubble: 0, unmeasuredSends: 0 });
  });

  test("I3: a send lookup CUT after ONE user bubble is unmeasured", async () => {
    const t = convexTest(schema, modules);
    const s = await cutWorld(t, { runBubbles: 0, sendBubbles: 2 });
    expect((await report(t, s.chatId))!.gaps!.i3).toMatchObject({ duplicated: 1, unmeasuredSends: 0 });
    // The head (100 KB) spends a 50 KB budget before the stamped bubbles are read.
    const cut = (await report(t, s.chatId, 50_000))!;
    expect(cut.gaps!.i3).toMatchObject({ userRows: 1, duplicated: 0, missingBubble: 0, unmeasuredSends: 1 });
    expect(cut.window.incompleteReasons).toContain("unmeasured_sends");
    expect(cut.verdict).toBe("consistent_in_window");
  });

  test("I3: a send lookup cut after TWO user bubbles still reports the duplicate", async () => {
    const t = convexTest(schema, modules);
    const s = await cutWorld(t, { runBubbles: 0, sendBubbles: 3 });
    // Head read (100 KB), then itself again and the second bubble (300 KB): the third
    // is cut off, two distinct bubbles already prove the duplicate.
    const cut = (await report(t, s.chatId, 250_000))!;
    expect(cut.window.readBudgetExhausted).toBe(true);
    expect(cut.gaps!.i3).toMatchObject({ duplicated: 1, unmeasuredSends: 0 });
    expect(cut.gaps!.i3.samples).toEqual([{ seq: 1, kind: "duplicated", bubbles: 2 }]);
    expect(cut.verdict).toBe("gaps");
  });

  test("the budget counts UTF-8 BYTES: CJK replies under the budget in UTF-16 units still exhaust it", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // 20 replies of 50 000 CJK characters: 1 000 000 UTF-16 units, 3 000 000 UTF-8 bytes.
    const cjk = "漢".repeat(50_000);
    const X = "webchat-" + "d".repeat(64);
    await t.run(async (ctx) => {
      const um = await ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "user",
        status: "complete" as const,
        text: "q",
        sendId: X,
        updatedAt: 1,
      });
      await ctx.db.insert("outbox", {
        chatId: s.chatId,
        userId: s.owner,
        clientMessageId: "cm-cjk",
        text: "q",
        attachmentIds: [],
        status: "sent",
        messageId: um,
        sendId: X,
        dispatchedAt: 1,
      });
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("messages", {
          chatId: s.chatId,
          userId: s.owner,
          role: "assistant",
          status: "complete" as const,
          text: cjk,
          runId: `run-${i}`,
          turnSessionKey: SK,
          updatedAt: 1,
        });
      }
    });
    await apply(t, s.chatId, [user(1, X), ...Array.from({ length: 20 }, (_, i) => reply(i + 2, `run-${i}`))]);
    // Unbounded, the 20 replies are all read and found.
    const full = (await report(t, s.chatId))!;
    expect(full.window.readBudgetExhausted).toBe(false);
    expect(full.gaps!.i1).toMatchObject({ visibleRuns: 20, transcriptOnly: 0 });
    // Each reply is read twice (the bubble scan, then its run's lookup): ≈2.0 M UTF-16
    // units in all, ≈6.0 M UTF-8 bytes. A 3.5 MB budget holds the first, not the second.
    const cut = (await report(t, s.chatId, 3_500_000))!;
    expect(cut.window.readBudgetExhausted).toBe(true);
    expect(cut.window.incompleteReasons).toContain("read_budget_exhausted");
    expect(cut.gaps!.i1.transcriptOnly).toBe(0);
  });

  test("utf8ByteLength agrees with TextEncoder, surrogate pairs and lone surrogates included", () => {
    const enc = new TextEncoder();
    for (const str of ["", "abc", "é", "漢字", "😀", "a😀漢é", "\ud800", "x\udc00y", "\ud800\ud800", '{"t":"漢"}']) {
      expect(utf8ByteLength(str), JSON.stringify(str)).toBe(enc.encode(str).byteLength);
    }
  });

  test("a chat that was never projected reads no message at all (early return)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: s.chatId,
        userId: s.owner,
        role: "assistant",
        status: "complete" as const,
        text: "x".repeat(200_000),
        updatedAt: 1,
      }),
    );
    // A budget no single message fits in: the early return reads none.
    const r = (await report(t, s.chatId, 1))!;
    expect(r.verdict).toBe("not_projected");
    expect(r.window.readBudgetExhausted).toBe(false);
  });

  test("a FAILING projection query is reported `unavailable`, never thrown", async () => {
    const calls: unknown[] = [];
    const failing = {
      runQuery: (async (fn: unknown, args: unknown) => {
        calls.push([fn, args]);
        throw new Error("Too many bytes read in a single function execution");
      }) as never,
    };
    const out = await projectionForDiagnose(failing, "chat-1");
    expect(out).toEqual({ verdict: "unavailable", reason: "projection_query_failed" });
    // It IS the projection query, in its own invocation, for this chat.
    expect(calls).toEqual([[internal.transcriptProjection.projectionReportInternal, { chatId: "chat-1" }]]);
    const passing = { runQuery: (async () => null) as never };
    expect(await projectionForDiagnose(passing, "chat-1")).toBeNull();
  });

  test("GET /api/v1/diagnose carries its usual sections AND the projection", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const KEY = "oc_test_diag_key";
    const hashedKey = await hashKey(KEY);
    await t.run(async (ctx) => {
      await ctx.db.insert("roles", { key: "diag", name: "Diag", builtin: false, permissions: ["traces.read"] });
      const serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: "svc-diag",
        roleKey: "diag",
        disabled: false,
        createdByUserId: s.owner,
      });
      await ctx.db.insert("apiKeys", {
        serviceAccountId,
        hashedKey,
        prefix: "oc_test_diag",
        lastFour: "key1",
        disabled: false,
        createdAt: Date.now(),
      });
    });
    await apply(t, s.chatId, [reply(1, "r")]);
    const res = await t.fetch(`/api/v1/diagnose?chatId=${s.chatId}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["assessment", "availability", "chatState", "ok", "projection"].sort(),
    );
    expect((body.projection as { verdict: string }).verdict).not.toBe("unavailable");
  });
});
