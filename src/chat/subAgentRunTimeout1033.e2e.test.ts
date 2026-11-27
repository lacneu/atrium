/// <reference types="vite/client" />
//
// A child cut off by its time limit on OpenClaw 2026.10.33, end to end: the frames
// captured on the bench (bridge/test/fixtures/subagent-run-timeout-2026.10.33.json, run
// 2026-11-24T21-28-40-832Z, scenario settle-chain-no-synthesis) go, in the order received,
// through the bridge's real session-events hub, row follower and sub-agent observer; what
// they produce is posted to the real `/bridge/ingest` route; the card is built from
// `listSubAgents` by the front's own view model.
//
// What 2026.10.33 changed (the 2026.9.33/9.36 sequence is pinned by
// subAgentRowStatus.e2e.test.ts and still holds):
//   - the registry's `subagent-status` arrives BEFORE the run ends, so it reads `running`;
//   - the run ends in error, and the row settles as `interrupted` — the word a gateway
//     restart leaves — never `timeout`;
//   - the run's own terminal carries the gateway's class, `errorKind:"timeout"`.

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
import { SubAgentObserver } from "../../bridge/src/providers/openclaw/sub-agent-observer";
import type { GatewayFrame } from "../../bridge/src/providers/openclaw/openclaw-client";
import type {
  SubAgentRowStatusRecord,
  SubAgentRowStatusResult,
} from "../../bridge/src/convex-writer";
import {
  buildSubAgentActivityView,
  hasRunningSubAgent,
  shortenSubAgentError,
  type SubAgentRow,
} from "./subAgentActivityView";

const modules = import.meta.glob("../../convex/**/*.ts");
type T = TestConvex<typeof schema>;
type Frame = GatewayFrame & { payload: Record<string, any> };

const CAPTURED = (
  JSON.parse(
    readFileSync(
      new URL("../../bridge/test/fixtures/subagent-run-timeout-2026.10.33.json", import.meta.url),
      "utf8",
    ),
  ) as { frames: Array<{ line: number; frame: Frame }> }
).frames;
const at = (line: number): Frame => {
  const found = CAPTURED.find((f) => f.line === line);
  if (found === undefined) throw new Error(`no captured frame at line ${line}`);
  return structuredClone(found.frame);
};
const rowAt = (line: number) => at(line).payload.session as Record<string, unknown>;

const CHAT_ERROR = at(1645);
const CHILD = CHAT_ERROR.payload.sessionKey as string;
const PARENT = CHAT_ERROR.payload.spawnedBy as string;
const RUN = CHAT_ERROR.payload.runId as string;

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

const writeRow = (t: T, chatId: Id<"chats">, row: Record<string, unknown>) =>
  post(t, { op: "applySubAgentRowStatus", chatId, childSessionKey: CHILD, ...row });

/** The child as its spawn registered it: `runTimeoutSeconds: 20`, its run id. */
const registerChild = (t: T, chatId: Id<"chats">) =>
  post(t, {
    op: "upsertSubAgent",
    chatId,
    childSessionKey: CHILD,
    taskName: "Seconde tâche silencieuse",
    status: "running",
    childRunId: RUN,
    runTimeoutSeconds: 20,
  });

/** What the reader sees: the card the front builds from `listSubAgents`. */
async function card(t: T, userId: Id<"users">, chatId: Id<"chats">) {
  const rows = (await t
    .withIdentity({ subject: userId })
    .query(api.subAgents.listSubAgents, { chatId })) as unknown as SubAgentRow[];
  return { card: buildSubAgentActivityView(rows).cards[0]!, rows };
}

/** The instance's session-events socket: frames pushed by the test. */
function eventsConnection() {
  const queue: GatewayFrame[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const conn: SessionEventsConnection & { push(f: GatewayFrame): void } = {
    gatewayVersion: "2026.10.33",
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

/** The bridge on one conversation: the row follower over the real hub, the observer
 *  over the conversation socket's frames, both writing through the real route. */
function bridge(t: T, chatId: Id<"chats">, held: { row: Record<string, unknown> }) {
  const conn = eventsConnection();
  const hub = new SessionEventsHub({ instanceName: "prod", connect: async () => conn, log: () => {} });
  const applied: SubAgentRowStatusRecord[] = [];
  const gateway: RowRequester = {
    async request(method) {
      return method === "sessions.describe" ? { payload: { session: held.row } } : { payload: {} };
    },
  };
  const follower = new ChildRowStatus({
    chatId,
    parentSessionKey: PARENT,
    gateway,
    write: async (record) => {
      const result = (await post(t, { op: "applySubAgentRowStatus", ...record })) as SubAgentRowStatusResult;
      applied.push(record);
      return result;
    },
    events: hub,
    log: () => {},
  });
  const observer = new SubAgentObserver(PARENT, chatId);
  let clock = 1;
  return {
    follower,
    applied,
    /** A `sessions.changed` on the session-events socket, and the read it triggers. */
    async changed(frame: Frame, rowThen: Record<string, unknown>) {
      held.row = rowThen;
      const before = applied.length;
      conn.push(frame);
      await vi.waitFor(() => expect(applied.length).toBeGreaterThan(before));
    },
    /** A child frame on the conversation socket: the observer's writes, as posted. */
    async conversationFrame(frame: Frame) {
      for (const record of observer.observe(frame, clock++, null, null)) {
        await post(t, { op: "upsertSubAgent", ...JSON.parse(JSON.stringify(record)) });
      }
    },
    stop() {
      follower.close();
      hub.stop();
    },
  };
}

describe("the captured 2026.10.33 run timeout, end to end", () => {
  test("in the order received: « en cours » through the late `running`, then « délai dépassé »", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    const held = { row: rowAt(1626) };
    const b = bridge(t, chatId, held);
    b.follower.track(CHILD);
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).rows[0]?.gatewayRow?.display).toBe("live"));

    // L1625: the registry's `subagent-status`, ~300 ms before the run ends. The row read
    // after it (L1626) still says `running`: the card stays live, rightly.
    await b.changed(at(1625), rowAt(1626));
    // L1639 / L1640: the run is finishing, still `running`.
    await b.changed(at(1639), rowAt(1640));
    let seen = await card(t, userId, chatId);
    expect([seen.card.statusLabel, seen.card.tone, hasRunningSubAgent(seen.rows)]).toEqual(["en cours", "running", true]);

    // L1641 / L1645: the run ends in error on the conversation socket. The row still
    // holds the status; the run the gateway classed as a timeout is recorded.
    await b.conversationFrame(at(1641));
    await b.conversationFrame(at(1645));
    seen = await card(t, userId, chatId);
    expect(seen.rows[0]).toMatchObject({ status: "running", timedOutRunId: RUN });
    expect(seen.card.statusLabel).toBe("en cours");

    // L1649 / L1651: `agent.input.settled` — the read it triggers finds the row
    // `interrupted` for that same run. This is what ends the live state.
    await b.changed(at(1649), rowAt(1651));
    seen = await card(t, userId, chatId);
    expect(seen.rows[0]).toMatchObject({
      status: "error",
      providerStatus: "timeout",
      errorCode: "timeout",
      // The row, kept as read.
      gatewayRow: { status: "interrupted", display: "interrupted", hasActiveRun: false, runId: RUN },
    });
    expect([seen.card.statusLabel, seen.card.tone, seen.card.failure]).toEqual(["délai dépassé", "failed", true]);
    expect(shortenSubAgentError(seen.card.errorMessage, seen.card.errorCode, seen.card.runTimeoutSeconds)).toBe(
      "Le sous-agent a dépassé son délai de 20 s sans répondre.",
    );
    expect(hasRunningSubAgent(seen.rows)).toBe(false);

    // L1650 / L1654: the second copy, and any later read of the same row (a reconnection
    // relists the children): the end stands.
    await b.changed(at(1650), rowAt(1654));
    await writeRow(t, chatId, { status: "interrupted", hasActiveRun: false, runId: RUN, snapshotAt: 1795556400000 });
    seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel]).toEqual(["error", "délai dépassé"]);
    b.stop();
  });

  test("the settled row alone ends the live state: no frame after the late `running` is needed but that read", async () => {
    // Without `agent.input.settled` (a frame lost), the end of the run observed on the
    // conversation socket reads the row too (session.ts `runEnded`).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    const held = { row: rowAt(1626) };
    const b = bridge(t, chatId, held);
    b.follower.track(CHILD);
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).rows[0]?.gatewayRow?.display).toBe("live"));
    await b.changed(at(1625), rowAt(1626));
    await b.conversationFrame(at(1645));
    held.row = rowAt(1651);
    b.follower.runEnded(CHILD);
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).card.statusLabel).toBe("délai dépassé"));
    expect(hasRunningSubAgent((await card(t, userId, chatId)).rows)).toBe(false);
    b.stop();
  });

  test("the row read landing BEFORE the terminal's write: « interrompu », then « délai dépassé »", async () => {
    // The two writes travel separately (the row follower, the observer's queue).
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    const held = { row: rowAt(1626) };
    const b = bridge(t, chatId, held);
    b.follower.track(CHILD);
    await vi.waitFor(async () => expect((await card(t, userId, chatId)).rows[0]?.gatewayRow?.display).toBe("live"));
    await b.changed(at(1649), rowAt(1651));
    let seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel, seen.card.tone]).toEqual(["aborted", "interrompu", "aborted"]);
    await b.conversationFrame(at(1645));
    seen = await card(t, userId, chatId);
    expect(seen.rows[0]).toMatchObject({ status: "error", providerStatus: "timeout", errorCode: "timeout" });
    expect([seen.card.statusLabel, seen.card.tone]).toEqual(["délai dépassé", "failed"]);
    b.stop();
  });
});

describe("an `interrupted` row nothing proves a timeout for keeps the row's word", () => {
  async function child(t: T, chatId: Id<"chats">) {
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10 });
  }
  const interrupted = { status: "interrupted", hasActiveRun: false, snapshotAt: 20 };

  test("a gateway restart (no timeout terminal): « interrompu », as the Control UI shows it", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await child(t, chatId);
    await writeRow(t, chatId, { ...interrupted, runId: RUN });
    const seen = await card(t, userId, chatId);
    expect(seen.rows[0]).toMatchObject({ status: "aborted", providerStatus: "interrupted" });
    expect(seen.rows[0]!.errorCode).toBeUndefined();
    expect([seen.card.statusLabel, seen.card.tone, seen.card.failure]).toEqual(["interrompu", "aborted", false]);
  });

  test("the timeout was ANOTHER run's (the row now speaks for a later one)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await child(t, chatId);
    await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: CHILD,
      status: "error",
      errorCode: "timeout",
      timedOutRunId: RUN,
    });
    await writeRow(t, chatId, { ...interrupted, runId: "a-later-run" });
    const seen = await card(t, userId, chatId);
    expect([seen.rows[0]!.status, seen.card.statusLabel]).toEqual(["aborted", "interrompu"]);
    // …and a row that names no run proves nothing either.
    await writeRow(t, chatId, { ...interrupted, snapshotAt: 30 });
    expect((await card(t, userId, chatId)).card.statusLabel).toBe("interrompu");
  });

  test("the terminal carries the sentence but not the gateway's class: no run is named", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await child(t, chatId);
    const b = bridge(t, chatId, { row: {} });
    const withoutKind = at(1645);
    delete withoutKind.payload.errorKind;
    await b.conversationFrame(withoutKind);
    await writeRow(t, chatId, { ...interrupted, runId: RUN });
    const seen = await card(t, userId, chatId);
    expect(seen.rows[0]).not.toHaveProperty("timedOutRunId");
    expect([seen.rows[0]!.status, seen.card.statusLabel]).toEqual(["aborted", "interrompu"]);
    b.stop();
  });

  test("a run id that is not one is refused at the ingest boundary", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await child(t, chatId);
    await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: CHILD,
      status: "error",
      timedOutRunId: "announce:requester-settle:x",
    });
    expect((await card(t, userId, chatId)).rows[0]).not.toHaveProperty("timedOutRunId");
  });
});

describe("the other order 2026.10.33 can take (the registry after the run): the row says `timeout` itself", () => {
  test("« délai dépassé », from the row, as on 2026.9.36", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await registerChild(t, chatId);
    await writeRow(t, chatId, { status: "running", hasActiveRun: true, snapshotAt: 10 });
    await post(t, { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "error", errorCode: "timeout", timedOutRunId: RUN });
    await writeRow(t, chatId, { status: "interrupted", hasActiveRun: false, runId: RUN, snapshotAt: 20 });
    await writeRow(t, chatId, { status: "timeout", hasActiveRun: false, runId: RUN, snapshotAt: 30 });
    const seen = await card(t, userId, chatId);
    expect(seen.rows[0]).toMatchObject({
      status: "error",
      providerStatus: "timeout",
      errorCode: "timeout",
      gatewayRow: { display: "timeout" },
    });
    expect(seen.card.statusLabel).toBe("délai dépassé");
  });
});

describe("the run of an interaction cut off by its limit (« Interagir » on an ended child)", () => {
  /** The child's own run ended with its answer; the reader then asked it something. The
   *  interaction's run is the captured one: its `chat` error carries the gateway's class,
   *  and the row it leaves reads `interrupted` for it. */
  async function interacted(t: T, chatId: Id<"chats">, order: "identity-first" | "row-first") {
    await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: CHILD,
      taskName: "Seconde tâche silencieuse",
      status: "done",
      childRunId: "the-child-own-run",
      resultText: "The original answer.",
    });
    await writeRow(t, chatId, { status: "done", hasActiveRun: false, runId: "the-child-own-run", snapshotAt: 10 });
    const observer = new SubAgentObserver(PARENT, chatId);
    observer.armInteraction(CHILD, "ix", 1);
    const records = observer.observe(at(1645), 2, null, null);
    // As session.ts flushes them: an interaction reply goes to the interaction store
    // (not modelled here), every other record to the child's row.
    const toRow = records.filter((r) => r.interactionReply === undefined);
    const row = { status: "interrupted", hasActiveRun: false, runId: RUN, snapshotAt: 20 };
    if (order === "row-first") await writeRow(t, chatId, row);
    for (const record of toRow) {
      await post(t, { op: "upsertSubAgent", ...JSON.parse(JSON.stringify(record)) });
    }
    if (order === "identity-first") await writeRow(t, chatId, row);
  }

  for (const order of ["identity-first", "row-first"] as const) {
    test(`${order}: « délai dépassé », and the panel keeps the child's original answer`, async () => {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seed(t);
      await interacted(t, chatId, order);
      const seen = await card(t, userId, chatId);
      expect(seen.rows[0]).toMatchObject({
        status: "error",
        providerStatus: "timeout",
        errorCode: "timeout",
        timedOutRunId: RUN,
        resultText: "The original answer.",
      });
      expect([seen.card.statusLabel, seen.card.tone]).toEqual(["délai dépassé", "failed"]);
    });
  }
});
