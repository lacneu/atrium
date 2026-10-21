/// <reference types="vite/client" />
//
// A sub-agent's status is its gateway SESSION ROW (0.101.4), end to end: the frames
// captured on the 2026.9.33 bench go through the bridge's real session-events hub and
// row follower, the row is posted to the real `/bridge/ingest` route, and the card is
// built from `listSubAgents` by the front's own view model — what the reader sees.

import { readFileSync } from "node:fs";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import type { Id } from "../../convex/_generated/dataModel";
import { ChildRowStatus, type RowRequester } from "../../bridge/src/providers/openclaw/child-row-status";
import {
  SessionEventsHub,
  type SessionEventsConnection,
} from "../../bridge/src/providers/openclaw/session-events";
import type { GatewayFrame } from "../../bridge/src/providers/openclaw/openclaw-client";
import type {
  SubAgentRowStatusRecord,
  SubAgentRowStatusResult,
} from "../../bridge/src/convex-writer";
import { isChatBusy } from "../../convex/lib/outboxQueue";
import {
  buildSubAgentActivityView,
  hasRunningSubAgent,
  shortenSubAgentError,
  type SubAgentRow,
} from "./subAgentActivityView";

const modules = import.meta.glob("../../convex/**/*.ts");
type T = TestConvex<typeof schema>;

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../bridge/test/fixtures/subagent-status-timeout-2026.9.33.json", import.meta.url),
    "utf8",
  ),
) as { frames: Array<{ frame: GatewayFrame & { payload: Record<string, unknown> } }> };
const [SETTLED, REGISTRY] = FIXTURE.frames.map((f) => f.frame) as [
  GatewayFrame & { payload: Record<string, unknown> },
  GatewayFrame & { payload: Record<string, unknown> },
];
const CHILD = SETTLED.payload.sessionKey as string;
const PARENT = SETTLED.payload.spawnedBy as string;
const DELEGATION_RUN = REGISTRY.payload.lastRunId as string;

let SECRET = "";

async function seed(t: T) {
  const seeded = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" as const });
    const instanceId = await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://prod" });
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod" });
    return { admin, instanceId, userId, chatId };
  });
  const minted = await t
    .withIdentity({ subject: `${seeded.admin}|session` })
    .action(api.bridgeAuth.mintBridgeSecret, { instanceId: seeded.instanceId });
  SECRET = minted.plaintext;
  return seeded;
}

async function post(t: T, body: unknown): Promise<unknown> {
  const res = await t.fetch("/bridge/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return await res.json();
}

/** The bridge's writer, over the real route (the body HttpConvexWriter posts —
 *  bridge/test/convex-writer.test.ts pins it). */
const rowWriter =
  (t: T) =>
  async (record: SubAgentRowStatusRecord): Promise<SubAgentRowStatusResult> =>
    (await post(t, { op: "applySubAgentRowStatus", ...record })) as SubAgentRowStatusResult;

const registerChild = (t: T, chatId: Id<"chats">, extra: Record<string, unknown> = {}) =>
  post(t, {
    op: "upsertSubAgent",
    chatId,
    childSessionKey: CHILD,
    taskName: "wait",
    status: "running",
    childRunId: DELEGATION_RUN,
    runTimeoutSeconds: 20,
    ...extra,
  });

const writeRow = (t: T, chatId: Id<"chats">, row: Record<string, unknown>) =>
  post(t, { op: "applySubAgentRowStatus", chatId, childSessionKey: CHILD, ...row });

/** The bridge's `missing` dependency, over the real route. */
const missingVia =
  (t: T, chatId: Id<"chats">) =>
  async (parentKey: string, presentKeys: string[]): Promise<string[]> =>
    ((await post(t, { op: "missingSubAgentRows", chatId, parentKey, presentKeys })) as { keys: string[] }).keys;

/** What the reader sees: the card the front builds from `listSubAgents`. */
async function card(t: T, userId: Id<"users">, chatId: Id<"chats">) {
  const rows = (await t
    .withIdentity({ subject: userId })
    .query(api.subAgents.listSubAgents, { chatId })) as unknown as SubAgentRow[];
  const view = buildSubAgentActivityView(rows);
  return { card: view.cards[0]!, rows };
}

/** The instance's session-events socket: frames pushed by the test. */
function eventsConnection() {
  const queue: GatewayFrame[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const conn: SessionEventsConnection & { push(f: GatewayFrame): void } = {
    gatewayVersion: "2026.9.33",
    onFrameGap: null,
    get isClosed() {
      return closed;
    },
    async request() {
      return {};
    },
    async *frames() {
      while (!closed) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((r) => (wake = r));
      }
    },
    close() {
      closed = true;
      wake?.();
    },
    push(f) {
      queue.push(f);
      const w = wake;
      wake = null;
      w?.();
    },
  };
  return conn;
}

/** A conversation socket answering the row the gateway holds now. */
function gatewayHolding(row: () => Record<string, unknown> | null): RowRequester {
  return {
    async request(method) {
      if (method === "sessions.describe") return { payload: { session: row() } };
      if (method === "sessions.list") {
        const r = row();
        return { payload: { sessions: r === null ? [] : [r] } };
      }
      return { payload: {} };
    },
  };
}

describe("the captured 2026.9.33 timeout, end to end", () => {
  test("a child cut off by its limit reads « délai dépassé », whatever order the frame-derived `done` lands in", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);

    let row: Record<string, unknown> = { key: CHILD, status: "running", hasActiveRun: true, snapshotAt: 1 };
    const conn = eventsConnection();
    const hub = new SessionEventsHub({ instanceName: "prod", connect: async () => conn, log: () => {} });
    const follower = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: gatewayHolding(() => row),
      write: rowWriter(t),
      events: hub,
      log: () => {},
    });
    follower.track(CHILD);
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).rows[0]?.gatewayRow?.display).toBe("live"));

    // The bench order: the run settles (`done`), then the registry publishes `timeout`.
    row = SETTLED.payload.session as Record<string, unknown>;
    conn.push(SETTLED);
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).card.statusLabel).toBe("terminé"));
    row = REGISTRY.payload.session as Record<string, unknown>;
    conn.push(REGISTRY);
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).card.statusLabel).toBe("délai dépassé"));

    // The child's plain `chat` final reaches the conversation socket AFTER (the hub can
    // run ahead of it): its content lands, the status does not move.
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "done", resultText: "partial" });
    // A frame-derived failure (the observer's TTL sweep) brings its own class and word:
    // the row's stand.
    await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: CHILD,
      status: "error",
      providerStatus: "failed",
      errorCode: "subagent_no_activity",
      errorMessage: "no activity seen",
    });

    const { card: c, rows } = await card(t, userId, chatId);
    expect(rows[0]).toMatchObject({
      status: "error",
      providerStatus: "timeout",
      errorCode: "timeout",
      resultText: "partial",
      gatewayRow: { status: "timeout", display: "timeout", runId: DELEGATION_RUN, snapshotAt: 1792448269766 },
    });
    expect(c.statusLabel).toBe("délai dépassé");
    expect(c.tone).toBe("failed");
    expect(shortenSubAgentError(c.errorMessage, c.errorCode, c.runTimeoutSeconds)).toBe(
      "Le sous-agent a dépassé son délai de 20 s sans répondre.",
    );
    expect(hasRunningSubAgent(rows)).toBe(false);
    follower.close();
    hub.stop();
  });

  test("before 0.101.4 (no row read) the same frames left a check mark: the defect, pinned", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "done", resultText: "partial" });
    const { card: c } = await card(t, userId, chatId);
    expect([c.statusLabel, c.tone]).toEqual(["terminé", "done"]);
  });
});

describe("a child the reader stopped", () => {
  test("reads « arrêté », even when the gateway then records the aborted run as done", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10 });
    // The reader's Stop, as convex/messages.ts abortTurn records it on a running child.
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .first();
      await ctx.db.patch(r!._id, { status: "aborted", stopRequestedAt: 50, updatedAt: 50 });
    });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("arrêté");
    // The kill is still travelling: the row says live. The Stop is not undone.
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 60 });
    let seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel, seen.card.tone]).toEqual(["aborted", "arrêté", "aborted"]);
    // The aborted run lands as `done` upstream (resolveSubagentSessionStatus: an aborted
    // outcome is neither error nor timeout): never a check mark for a run the reader stopped.
    await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: DELEGATION_RUN, snapshotAt: 70 });
    seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel, seen.card.tone]).toEqual(["done", "arrêté", "aborted"]);
    expect(hasRunningSubAgent(seen.rows)).toBe(false);
  });
});

describe("Stop, the stopped run ends, then « Interagir »", () => {
  async function stoppedChild(t: T, chatId: Id<"chats">) {
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10 });
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .first();
      await ctx.db.patch(r!._id, { status: "aborted", stopRequestedAt: 50, updatedAt: 50 });
    });
  }

  test("the new run is shown live, then its own end; the stopped run's report stays out", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await stoppedChild(t, chatId);
    // The stopped run ends (recorded `done` upstream): « arrêté ».
    await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: DELEGATION_RUN, snapshotAt: 70 });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("arrêté");
    // « Interagir » relaunches the child: the row is live — and so is the card.
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 80 });
    let seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel, seen.card.tone, hasRunningSubAgent(seen.rows)]).toEqual([
      "running",
      "en cours",
      "running",
      true,
    ]);
    // Its end speaks for its own run.
    await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: "interaction-1", snapshotAt: 90 });
    seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel, seen.rows[0]!.stoppedRunId]).toEqual([
      "done",
      "terminé",
      DELEGATION_RUN,
    ]);
    // The stopped run's report never lands, whatever runs after.
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "done", resultText: "REFUSED" });
    expect((await card(t, userId, chatId)).rows[0]!.resultText).toBeUndefined();
  });

  test("an interaction asked after the Stop lifts it even when the stopped run's end was never read", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await stoppedChild(t, chatId);
    await t.run((ctx) =>
      ctx.db.insert("subAgentInteractions", {
        chatId,
        childSessionKey: CHILD,
        userText: "encore",
        status: "pending" as const,
        createdAt: 60,
        updatedAt: 60,
      }),
    );
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 80 });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("en cours");
  });
});

describe("two full cycles Stop → « Interagir », through the real Stop mutation", () => {
  test("each Stop protects ITS run: the second stopped run still reads « arrêté », each new run its own state", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seed(t);
      const reader = t.withIdentity({ subject: `${userId}|session` });
      const label = async () => {
        const seen = await card(t, userId, chatId);
        return [seen.rows[0]!.status, seen.card.statusLabel];
      };
      await registerChild(t, chatId);
      await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10 });

      // Cycle 1: Stop the delegation; its run ends (recorded `done` upstream).
      vi.setSystemTime(2_000);
      await reader.mutation(api.messages.abortTurn, { chatId });
      expect(await label()).toEqual(["aborted", "arrêté"]);
      await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: DELEGATION_RUN, snapshotAt: 20 });
      expect(await label()).toEqual(["done", "arrêté"]);
      // « Interagir »: a new run, live.
      await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 30 });
      expect(await label()).toEqual(["running", "en cours"]);

      // Cycle 2: Stop THAT run. A read while the kill travels keeps it stopped; its end
      // (another run id than cycle 1's) still reads « arrêté ».
      vi.setSystemTime(3_000);
      await reader.mutation(api.messages.abortTurn, { chatId });
      expect(await label()).toEqual(["aborted", "arrêté"]);
      await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 35 });
      expect(await label()).toEqual(["aborted", "arrêté"]);
      await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: "interaction-1", snapshotAt: 40 });
      expect(await label()).toEqual(["done", "arrêté"]);
      // « Interagir » again: live, then its own end.
      await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 50 });
      expect(await label()).toEqual(["running", "en cours"]);
      await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: "interaction-2", snapshotAt: 60 });
      expect(await label()).toEqual(["done", "terminé"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a reconnection while the hub is already subscribed for another conversation", () => {
  test("a correction published before the attachment still reaches the card: « délai dépassé »", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    const conn = eventsConnection();
    const hub = new SessionEventsHub({ instanceName: "prod", connect: async () => conn, log: () => {} });
    const detachOther = hub.attach("agent:alice:atrium:chat:other", {
      onSessionMessage: () => {},
      onSessionsChanged: () => {},
      onSubscribed: () => {},
    });
    await vi.waitFor(() => expect(hub.ready).toBe(true));
    // The list samples `done`; the registry's `timeout` was published before the child
    // was attached, and the live subscription does not replay it.
    const settled = { ...(SETTLED.payload.session as Record<string, unknown>), updatedAt: Date.now() };
    const corrected = REGISTRY.payload.session as Record<string, unknown>;
    const follower = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: {
        async request(method) {
          return method === "sessions.list"
            ? { payload: { sessions: [settled] } }
            : { payload: { session: corrected } };
        },
      },
      write: rowWriter(t),
      events: hub,
      log: () => {},
    });
    await follower.relistChildren();
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).card.statusLabel).toBe("délai dépassé"));
    follower.close();
    detachOther();
    hub.stop();
  });
});

describe("a child deleted by `cleanup: \"delete\"` (the gateway has no row any more)", () => {
  const busy = (t: T, chatId: Id<"chats">) =>
    t.run(async (ctx) => [
      await isChatBusy(ctx, chatId, "off"),
      await isChatBusy(ctx, chatId, "shadow"),
      await isChatBusy(ctx, chatId, "on"),
    ]);

  test("first POST delayed, then `describe` → null: the end the frames reported applies, the send queue is released", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    let row: Record<string, unknown> | null = { key: CHILD, spawnedBy: PARENT, status: "running", hasActiveRun: true, snapshotAt: 10 };
    // The first row write is held in flight.
    let release: (() => void) | null = null;
    let writes = 0;
    const follower = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: gatewayHolding(() => row),
      write: async (record) => {
        writes++;
        if (writes === 1) await new Promise<void>((r) => (release = r));
        return await rowWriter(t)(record);
      },
      missing: missingVia(t, chatId),
      log: () => {},
    });
    follower.runEnded(CHILD); // the read of the live row, its write in flight
    await vi.waitFor(() => expect(release).not.toBeNull());
    // Meanwhile the child ends (its frames: a `done` final with its answer) and the gateway
    // deletes its session (`cleanup: "delete"`).
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "done", resultText: "the answer" });
    row = null;
    // The delayed live row lands last: the card would be stuck running on its own.
    release!();
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).rows[0]!.gatewayRow?.display).toBe("live"));
    expect(await busy(t, chatId)).toEqual([true, true, false]);
    // The end of the run is reread: `{ session: null }` — the row is gone.
    follower.runEnded(CHILD);
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).rows[0]!.status).toBe("done"));
    const seen = await card(t, userId, chatId);
    expect([seen.card.statusLabel, seen.rows[0]!.gatewayRow, seen.rows[0]!.resultText]).toEqual([
      "terminé",
      undefined,
      "the answer",
    ]);
    expect(await busy(t, chatId)).toEqual([false, false, false]);
    // A reconnection whose list no longer has the child changes nothing more.
    await follower.relistChildren();
    expect((await card(t, userId, chatId)).rows[0]!.status).toBe("done");
    follower.close();
  });

  test("a frame-reported failure landed BEFORE a stale live row: the gone row takes that failure, not `done`", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "error", errorCode: "timeout", providerStatus: "timeout" });
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10, parentKey: PARENT });
    expect(await busy(t, chatId)).toEqual([true, true, false]);
    await writeRow(t, chatId, { absent: true });
    const seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.rows[0]!.providerStatus, seen.card.statusLabel]).toEqual([
      "error",
      "timeout",
      "délai dépassé",
    ]);
    expect(await busy(t, chatId)).toEqual([false, false, false]);
  });

  test("never reread before the reconnection: the new socket's complete (empty) list lets go of the live row", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10, parentKey: PARENT });
    // The frames reported a timeout while the row held the status.
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "error", errorCode: "timeout", providerStatus: "timeout" });
    expect(await busy(t, chatId)).toEqual([true, true, false]);
    const follower = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: gatewayHolding(() => null),
      write: rowWriter(t),
      missing: missingVia(t, chatId),
      log: () => {},
    });
    await follower.relistChildren();
    // The candidate is READ: `{ session: null }` — gone.
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).rows[0]!.status).toBe("error"));
    const seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.rows[0]!.providerStatus, seen.card.statusLabel]).toEqual([
      "error",
      "timeout",
      "délai dépassé",
    ]);
    expect(await busy(t, chatId)).toEqual([false, false, false]);
    follower.close();
  });

  test("an old connection's `running` POST landing AFTER the empty reconcile is refused: the child stays ended", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10, parentKey: PARENT });
    // The OLD connection reads the live row; its POST stays in flight.
    let release: (() => void) | null = null;
    const old = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: gatewayHolding(() => ({ key: CHILD, spawnedBy: PARENT, status: "running", hasActiveRun: true, snapshotAt: 20 })),
      write: async (record) => {
        await new Promise<void>((r) => (release = r));
        return await rowWriter(t)(record);
      },
      log: () => {},
    });
    old.runEnded(CHILD);
    await vi.waitFor(() => expect(release).not.toBeNull());
    // The child ends (`cleanup: "delete"`) — its frames' `done` is the end applied at the
    // absence; the NEW connection's complete list is empty.
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "done", resultText: "the answer" });
    const fresh = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: gatewayHolding(() => null),
      write: rowWriter(t),
      missing: missingVia(t, chatId),
      log: () => {},
    });
    await fresh.relistChildren();
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).rows[0]!.status).toBe("done"));
    // The old POST lands now: refused — a deleted session never comes back under its key.
    release!();
    await vi.waitFor(async () => expect(((await card(t, userId, chatId)).rows[0] as SubAgentRow & { rowAbsentAt?: number }).rowAbsentAt).toBeDefined());
    await new Promise((r) => setTimeout(r, 20));
    expect(await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 99, parentKey: PARENT })).toEqual({
      applied: false,
      reason: "absent",
    });
    const seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel, seen.rows[0]!.resultText]).toEqual(["done", "terminé", "the answer"]);
    expect(await busy(t, chatId)).toEqual([false, false, false]);
    old.close();
    fresh.close();
  });

  test("a list sampled BEFORE a spawn never declares the new child gone; its later timeout applies", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    // The list is sampled empty…
    let sampled: Record<string, unknown>[] = [];
    let row: Record<string, unknown> | null = null;
    const follower = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: {
        async request(method) {
          if (method === "sessions.list") {
            const page = sampled;
            // …then the child is spawned and its running row written, before the
            // missing-children question reaches Convex.
            await registerChild(t, chatId);
            row = { key: CHILD, spawnedBy: PARENT, status: "running", hasActiveRun: true, snapshotAt: 10 };
            await writeRow(t, chatId, { ...row });
            return { payload: { sessions: page } };
          }
          return { payload: { session: row } };
        },
      },
      write: rowWriter(t),
      missing: missingVia(t, chatId),
      log: () => {},
    });
    await follower.relistChildren();
    await vi.waitFor(async () => expect(((await card(t, userId, chatId)).rows[0]?.gatewayRow as { snapshotAt?: number } | undefined)?.snapshotAt).toBe(10));
    const r = (await card(t, userId, chatId)).rows[0] as SubAgentRow & { rowAbsentAt?: number };
    expect([r.status, r.rowAbsentAt]).toEqual(["running", undefined]);
    // The child times out: its row is applied, never refused.
    expect(await writeRow(t, chatId, { status: "timeout", hasActiveRun: false, snapshotAt: 20, parentKey: PARENT })).toMatchObject({ applied: true });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("délai dépassé");
    sampled = [];
    follower.close();
  });

  test("a deleted child with no reported end stands as a PROVISIONAL done: its real end replaces it, the reaper's does not", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10, parentKey: PARENT });
    await writeRow(t, chatId, { absent: true });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("terminé");
    // The observer's synthesized "no activity" error is no end the child reported.
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "error", errorCode: "subagent_no_activity", errorMessage: "no activity" });
    expect((await card(t, userId, chatId)).rows[0]!.status).toBe("done");
    // The child's real end, arriving late: it replaces the stand-in.
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "error", errorCode: "timeout", providerStatus: "timeout" });
    const seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel]).toEqual(["error", "délai dépassé"]);
    expect((seen.rows[0] as SubAgentRow & { terminalSource?: string }).terminalSource).toBeUndefined();
    expect(await busy(t, chatId)).toEqual([false, false, false]);
  });

  test("a row whose last word was an end keeps it; a list of ANOTHER parent leaves the row alone", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10, parentKey: PARENT });
    // A list of ANOTHER parent, or one that still has the child: no candidate to read.
    expect(await missingVia(t, chatId)("agent:alice:atrium:chat:other", [])).toEqual([]);
    expect(await missingVia(t, chatId)(PARENT, [CHILD])).toEqual([]);
    expect(await missingVia(t, chatId)(PARENT, [])).toEqual([CHILD]);
    expect((await card(t, userId, chatId)).rows[0]!.gatewayRow?.display).toBe("live");
    await writeRow(t, chatId, { status: "timeout", hasActiveRun: false, snapshotAt: 20, parentKey: PARENT });
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "done" });
    await writeRow(t, chatId, { absent: true });
    const seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel, seen.rows[0]!.gatewayRow?.display]).toEqual([
      "error",
      "délai dépassé",
      "timeout",
    ]);
  });
});

describe("a reconnection 7 h after the gateway corrected the child", () => {
  test("the relist applies the `timeout` though the row is too old to be followed", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { ...(SETTLED.payload.session as Record<string, unknown>), runId: DELEGATION_RUN });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("terminé");
    const row = {
      ...(REGISTRY.payload.session as Record<string, unknown>),
      updatedAt: Date.now() - 7 * 3600_000,
    };
    const follower = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: gatewayHolding(() => row),
      write: rowWriter(t),
      log: () => {},
    });
    await follower.relistChildren();
    expect(follower.trackedKeys).toEqual([]);
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("délai dépassé");
    follower.close();
  });
});

describe("a reconnection while the child ends", () => {
  test("the new socket's relist writes the row the gateway now holds", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    let row: Record<string, unknown> | null = { key: CHILD, spawnedBy: PARENT, status: "running", hasActiveRun: true, snapshotAt: 1 };
    const first = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: gatewayHolding(() => row),
      write: rowWriter(t),
      log: () => {},
    });
    // The run ends on the first socket: its row says `done` (the registry has not spoken).
    row = { ...(SETTLED.payload.session as Record<string, unknown>) };
    first.runEnded(CHILD);
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).card.statusLabel).toBe("terminé"));
    // The socket drops; the registry records the timeout while nobody listens.
    first.close();
    row = { ...(REGISTRY.payload.session as Record<string, unknown>), updatedAt: Date.now() };
    // A new socket, no memory: it relists the parent's children.
    const second = new ChildRowStatus({
      chatId,
      parentSessionKey: PARENT,
      gateway: gatewayHolding(() => row),
      write: rowWriter(t),
      log: () => {},
    });
    await second.relistChildren();
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).card.statusLabel).toBe("délai dépassé"));
    second.close();
  });
});

describe("« Interagir » on a finished child", () => {
  test("the card shows what the Control UI shows: live during the turn, then the row's done", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "timeout", hasActiveRun: false, runId: DELEGATION_RUN, snapshotAt: 100 });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("délai dépassé");
    // The interaction's `chat.send` runs on the child session: the row is live.
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 200 });
    let seen = await card(t, userId, chatId);
    expect([seen.card.statusLabel, seen.card.tone, seen.rows[0]!.status]).toEqual(["en cours", "running", "running"]);
    // A frame-derived write in between (the observer's placeholder) moves nothing.
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "done" });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("en cours");
    // The turn ends: the session's own status is `done` and the display projection prefers
    // it to the registry's word (src/gateway/session-utils-display.ts:158-162) — the Control
    // UI shows Done; so does the card.
    await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: "interaction-1", snapshotAt: 300 });
    // A read of the timed-out row answered late (sampled before) is ignored.
    expect(await writeRow(t, chatId, { status: "timeout", hasActiveRun: false, runId: DELEGATION_RUN, snapshotAt: 150 })).toEqual({
      applied: false,
      reason: "older",
    });
    seen = await card(t, userId, chatId);
    expect([seen.card.statusLabel, seen.card.tone, seen.rows[0]!.gatewayRow?.runId]).toEqual([
      "terminé",
      "done",
      "interaction-1",
    ]);
  });
});

describe("a late announce of run A while « Interagir » runs B (projection on)", () => {
  async function bRunning(t: T, chatId: Id<"chats">) {
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10, parentKey: PARENT });
    // Run A ends (the row says so).
    await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: DELEGATION_RUN, snapshotAt: 20, parentKey: PARENT });
    // « Interagir » starts run B: the row is live.
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 30, parentKey: PARENT });
  }

  test("A's NO_REPLY announce (settleAnnouncedChild) leaves B « en cours »; B's end then gives its real status", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await bRunning(t, chatId);
    await post(t, { op: "settleAnnouncedChild", chatId, childSessionKey: CHILD });
    let seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel]).toEqual(["running", "en cours"]);
    expect((seen.rows[0] as SubAgentRow & { frameTerminal?: { status: string } }).frameTerminal).toEqual({ status: "done" });
    await writeRow(t, chatId, { status: "timeout", hasActiveRun: false, runId: "interaction-1", snapshotAt: 40, parentKey: PARENT });
    seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel]).toEqual(["error", "délai dépassé"]);
  });

  test("A's announce opening its bubble (stream.startAssistant) leaves B « en cours » too", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await bRunning(t, chatId);
    const started = (await post(t, {
      op: "startAssistant",
      chatId,
      runId: `announce:v1:${CHILD}:${DELEGATION_RUN}`,
    })) as { messageId?: string };
    expect(started.messageId).toBeDefined();
    const seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel]).toEqual(["running", "en cours"]);
  });

  test("without a row read, the announce still settles the child (behaviour unchanged)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await post(t, { op: "settleAnnouncedChild", chatId, childSessionKey: CHILD });
    expect((await card(t, userId, chatId)).rows[0]!.status).toBe("done");
  });
});

describe("a relaunched delegation: two runs on one child", () => {
  test("the card follows the run the gateway's row speaks for, by its sampling clock", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    // Run A times out.
    await writeRow(t, chatId, { status: "timeout", hasActiveRun: false, runId: "run-A", snapshotAt: 100 });
    // Run B starts (the gateway now displays B: `getDisplaySubagentRun`, the latest run).
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 200 });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("en cours");
    // B finishes.
    await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: "run-B", snapshotAt: 300 });
    // A read of A's row that was in flight arrives last: older, ignored.
    expect(
      await writeRow(t, chatId, { status: "timeout", hasActiveRun: false, runId: "run-A", snapshotAt: 150 }),
    ).toEqual({ applied: false, reason: "older" });
    const seen = await card(t, userId, chatId);
    expect([seen.card.statusLabel, seen.rows[0]!.gatewayRow?.runId, seen.rows[0]!.errorCode]).toEqual([
      "terminé",
      "run-B",
      undefined,
    ]);
  });

  test("B times out after A finished: A's late done does not hide it", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: "run-A", snapshotAt: 100 });
    await writeRow(t, chatId, { status: "timeout", hasActiveRun: false, runId: "run-B", snapshotAt: 300 });
    await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: "run-A", snapshotAt: 120 });
    const seen = await card(t, userId, chatId);
    expect([seen.card.statusLabel, seen.rows[0]!.gatewayRow?.runId]).toEqual(["délai dépassé", "run-B"]);
  });
});

describe("applySubAgentRowStatus bounds", () => {
  test("without a sampling clock (a gateway predating `snapshotAt`), the last read written stands", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "timeout", hasActiveRun: false });
    await writeRow(t, chatId, { status: "done", hasActiveRun: false });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("terminé");
  });

  test("never creates a row, never writes another chat's child or a task row, drops an unknown word", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    expect(await writeRow(t, chatId, { status: "timeout" })).toEqual({ applied: false, reason: "no_row" });
    expect(await t.run((ctx) => ctx.db.query("subAgents").collect())).toEqual([]);
    const other = await t.run((ctx) => ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod" }));
    await registerChild(t, chatId);
    expect(await writeRow(t, other, { status: "timeout" })).toEqual({ applied: false, reason: "not_this_chat" });
    // An unknown word reads as no word: the badge says « inconnu », the state is untouched.
    await writeRow(t, chatId, { status: "exploded", snapshotAt: 5 });
    const seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel, seen.rows[0]!.gatewayRow?.status]).toEqual([
      "running",
      "inconnu",
      undefined,
    ]);
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: "task:t1", kind: "task", status: "running" });
    expect(
      await post(t, { op: "applySubAgentRowStatus", chatId, childSessionKey: "task:t1", status: "timeout" }),
    ).toEqual({ applied: false, reason: "not_this_chat" });
  });

  test("another instance's bridge cannot write the row (403, nothing changed)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    const foreign = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "other" });
      await ctx.db.insert("subAgents", {
        chatId,
        userId,
        childSessionKey: CHILD,
        status: "running" as const,
        createdAt: 1,
        updatedAt: 1,
      });
      return chatId;
    });
    const res = await t.fetch("/bridge/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ op: "applySubAgentRowStatus", chatId: foreign, childSessionKey: CHILD, status: "timeout" }),
    });
    expect(res.status).toBe(403);
    const row = await t.run((ctx) => ctx.db.query("subAgents").first());
    expect([row?.status, row?.gatewayRow]).toEqual(["running", undefined]);
  });

  test("a killed row: « arrêt forcé » in the danger tone, and the child no longer holds the composer", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 1 });
    expect(hasRunningSubAgent((await card(t, userId, chatId)).rows)).toBe(true);
    await writeRow(t, chatId, { status: "killed", hasActiveRun: false, snapshotAt: 2 });
    const seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.rows[0]!.providerStatus, seen.card.statusLabel, seen.card.tone]).toEqual([
      "aborted",
      "killed",
      "arrêt forcé",
      "failed",
    ]);
    expect(hasRunningSubAgent(seen.rows)).toBe(false);
  });
});
