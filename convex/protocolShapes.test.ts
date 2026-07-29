/// <reference types="vite/client" />
//
// The drift ledger: a shape the gateway emits is REMEMBERED (lot 38 — W9 slice 2b).
//
// The bridge has detected unknown field shapes since lot 23, but only in MEMORY: its
// counters die with the process, and the compat poller stored the whole report as a single
// `protocol` snapshot, overwritten every five minutes. So nothing recorded that a shape had
// ever been seen, when it first appeared, or whether a human had triaged it — and the
// programme's own exit indicator ("shapes still `new` after a week ⇒ 0") could not be
// measured at all.
//
// These tests drive the REAL poller with a mocked `/capabilities`, because the seam that
// matters is the one the cron actually walks. A test that called the mutation directly
// would prove the ledger writes and leave the question that matters — does anything ever
// call it — untouched.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const CAPABILITIES = (drift: Array<{ shape: string; count: number }>) => ({
  instanceName: "main",
  bridgeVersion: "0.68.11",
  protocolVersion: 2,
  protocol: {
    vendoredVersion: "2026.7.1",
    coverage: { handled: 41, ignored: 50, gaps: 0, gapList: [] },
    drift,
  },
  targets: [
    {
      key: "alice",
      instanceName: "main",
      agentId: "alice",
      gatewayVersion: "2026.7.1",
      capabilities: {},
    },
  ],
});

function stubBridge(body: unknown) {
  const prev = process.env.BRIDGE_URL;
  process.env.BRIDGE_URL = "https://bridge.example.org";
  vi.stubGlobal(
    "fetch",
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
  return {
    restore: () => {
      vi.unstubAllGlobals();
      if (prev === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prev;
    },
  };
}

/** An ADMIN caller. The triage surface is operator diagnostics, so every assertion about
 *  it has to go through a real identity — that is half of what these tests prove. */
async function asAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "admin" as const });
    return uid;
  });
  return t.withIdentity({ subject: `${userId}|session` });
}

const ledger = async (t: ReturnType<typeof convexTest>) =>
  await t.run(async (ctx) => await ctx.db.query("protocolShapes").collect());

/** Poll with an arbitrary (or absent) `protocol` section — the shapes the fold itself
 *  has to survive. */
async function pollRaw(
  t: ReturnType<typeof convexTest>,
  protocol: unknown,
) {
  const body = { ...CAPABILITIES([]) } as Record<string, unknown>;
  if (protocol === undefined) delete body.protocol;
  else body.protocol = protocol;
  const stub = stubBridge(body);
  try {
    await t.action(internal.compat.pollBridgeCompat, {});
  } finally {
    stub.restore();
  }
}

async function poll(
  t: ReturnType<typeof convexTest>,
  drift: Array<{ shape: string; count: number }>,
) {
  const stub = stubBridge(CAPABILITIES(drift));
  try {
    await t.action(internal.compat.pollBridgeCompat, {});
  } finally {
    stub.restore();
  }
}

describe("the poller writes the drift ledger", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("a drifting shape is recorded, `new` and timestamped", async () => {
    const t = convexTest(schema, modules);
    await poll(t, [{ shape: "agent.lastTo", count: 24 }]);
    const rows = await ledger(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.shape).toBe("agent.lastTo");
    expect(rows[0]?.lastCount).toBe(24);
    // `new` is the whole point: it is what the exit indicator counts.
    expect(rows[0]?.status).toBe("new");
    expect(rows[0]?.firstSeenAt).toBeGreaterThan(0);
  });

  test("a second poll UPDATES the same row — first-seen never moves", async () => {
    const t = convexTest(schema, modules);
    await poll(t, [{ shape: "agent.lastTo", count: 24 }]);
    const first = (await ledger(t))[0];
    await poll(t, [{ shape: "agent.lastTo", count: 31 }]);
    const rows = await ledger(t);
    expect(rows, "a poll must not duplicate a known shape").toHaveLength(1);
    expect(rows[0]?.lastCount).toBe(31);
    expect(rows[0]?.firstSeenAt).toBe(first?.firstSeenAt);
  });

  test("TRIAGE SURVIVES the poll — through the REAL admin mutation", async () => {
    // Two failures in one test. The obvious: a poll that reset `status` would erase, every
    // five minutes, the only thing this table exists to remember. The subtler, and the one
    // the first cut of this lot hid from itself: this used to triage with a direct
    // `ctx.db.patch`, which passes whether or not any human CAN triage. Going through the
    // admin mutation is what proves the ledger has an end a person can hold.
    const t = convexTest(schema, modules);
    await poll(t, [{ shape: "agent.lastTo", count: 24 }]);
    const id = (await ledger(t))[0]?._id;
    const admin = await asAdmin(t);
    await admin.mutation(api.compat.triageProtocolShape, {
      id: id as Id<"protocolShapes">,
      status: "handled",
      note: "read since 0.68.12",
    });
    await poll(t, [{ shape: "agent.lastTo", count: 40 }]);
    const rows = await ledger(t);
    expect(rows[0]?.status).toBe("handled");
    expect(rows[0]?.note).toBe("read since 0.68.12");
    expect(rows[0]?.lastCount, "…while the live count still moves").toBe(40);
  });

  test("the indicator is READABLE, and says when it cannot be trusted", async () => {
    const t = convexTest(schema, modules);
    await poll(t, [{ shape: "agent.lastTo", count: 3 }]);
    const admin = await asAdmin(t);
    const view = await admin.query(api.compat.listProtocolShapes, {});
    expect(view.shapes).toHaveLength(1);
    expect(view.staleNew, "fresh, so not yet stale").toBe(0);
    expect(view.indicatorReliable).toBe(true);
  });

  test("an UNNAMEABLE shape is counted, never stored — and the indicator says so", async () => {
    // `/capabilities` is a network input and this table keeps what it is given forever, so
    // an arbitrary string would turn a diagnostic into durable storage for whatever a
    // broken or hostile bridge sends. A charset filter would not do — the bridge settled
    // that at lot 28 ("`AliceMartin` passes it") — so only the grammars its producers
    // actually emit are stored, and the rest is COUNTED so the ledger cannot lie by
    // omission.
    const t = convexTest(schema, modules);
    await poll(t, [
      { shape: "agent.lastTo", count: 3 },
      { shape: "Jean Dupont, 12 rue des Lilas", count: 1 },
    ]);
    const rows = await ledger(t);
    expect(rows.map((r) => r.shape)).toEqual(["agent.lastTo"]);
    const admin = await asAdmin(t);
    const view = await admin.query(api.compat.listProtocolShapes, {});
    expect(view.unnamedLast).toBe(1);
    expect(view.indicatorReliable, "blind polls make the count a floor").toBe(false);
  });

  test("an exception SUFFIX carrying free text is refused", async () => {
    // The grammar started with `«exception».<Class>@<site>..+`, and that `.+` let arbitrary
    // content through inside a well-formed envelope (raised in review). The suffix is a
    // CLOSED set — what `exceptionFrameShape` can return — so this must not be stored.
    const t = convexTest(schema, modules);
    await poll(t, [
      { shape: "«exception».TypeError@feed.chat.assistant", count: 1 },
      { shape: "«exception».TypeError@feed.Jean Dupont, 12 rue des Lilas", count: 1 },
    ]);
    const rows = await ledger(t);
    expect(rows.map((r) => r.shape)).toEqual([
      "«exception».TypeError@feed.chat.assistant",
    ]);
    const admin = await asAdmin(t);
    expect((await admin.query(api.compat.listProtocolShapes, {})).unnamedLast).toBe(1);
  });

  test("driftOverflow — what the BRIDGE could not name — counts as blindness", async () => {
    // The fold keeps it separately and the first cut ignored it entirely, so a poll whose
    // named shapes were all clean reported a reliable indicator while the bridge was
    // telling us it had lost observations.
    const t = convexTest(schema, modules);
    await pollRaw(t, {
      vendoredVersion: "2026.7.1",
      coverage: { handled: 41, ignored: 50, gaps: 0, gapList: [] },
      drift: [{ shape: "agent.lastTo", count: 2 }],
      driftOverflow: 7,
    });
    const admin = await asAdmin(t);
    const view = await admin.query(api.compat.listProtocolShapes, {});
    expect(view.unnamedLast).toBe(7);
    expect(view.indicatorReliable).toBe(false);
  });

  test("a bridge with NO protocol section is unobserved, not clean", async () => {
    // The sharpest way to read this table wrong: an operator sees zero stale shapes and
    // concludes the gateway emits nothing unknown, when in truth nothing was ever looked
    // at.
    const t = convexTest(schema, modules);
    await pollRaw(t, undefined);
    const admin = await asAdmin(t);
    const view = await admin.query(api.compat.listProtocolShapes, {});
    expect(view.shapes).toEqual([]);
    expect(view.reporting).toBe(false);
    expect(view.indicatorReliable).toBe(false);
  });

  test("past its CAPACITY the ledger counts instead of naming", async () => {
    // A grammar keeps content out; it does not keep VOLUME out. A bridge emitting fresh
    // valid names every poll would grow this table without end (raised in review), so past
    // the cap an identity is still counted — the ledger stops growing without pretending
    // it saw nothing. Driven through the mutation because that is where capacity lives;
    // the poller → mutation seam is proved by every other test in this file.
    const t = convexTest(schema, modules);
    const many = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        shape: `agent.f${from + i}`,
        count: 1,
      }));
    await t.mutation(internal.compat.recordProtocolShapes, {
      shapes: many(0, 500),
      unnamed: 0,
      reporting: true,
    });
    expect(await ledger(t)).toHaveLength(500);
    await t.mutation(internal.compat.recordProtocolShapes, {
      shapes: many(500, 5),
      unnamed: 0,
      reporting: true,
    });
    expect(await ledger(t), "the table stops growing").toHaveLength(500);
    const admin = await asAdmin(t);
    const view = await admin.query(api.compat.listProtocolShapes, {});
    expect(view.unnamedLast, "…and says how many it refused to name").toBe(5);
    expect(view.indicatorReliable).toBe(false);
  });

  test("a legacy bridge beside a modern one still makes coverage PARTIAL", async () => {
    // The fold merges every reachable bridge and drops the nulls, so one modern bridge used
    // to vouch for a legacy one standing next to it (raised in review). Coverage is whole
    // only when every bridge reported.
    const t = convexTest(schema, modules);
    const modern = CAPABILITIES([{ shape: "agent.lastTo", count: 2 }]);
    const legacy = { ...CAPABILITIES([]) } as Record<string, unknown>;
    delete legacy.protocol;
    (legacy as { instanceName: string }).instanceName = "second";
    // TWO bridges, the way production has them: per-instance `bridgeUrl` rows, not a
    // comma-separated env var.
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "main",
        gatewayUrl: "https://gw-a.example.org",
        bridgeUrl: "https://a.example.org",
      });
      await ctx.db.insert("instances", {
        name: "second",
        gatewayUrl: "https://gw-b.example.org",
        bridgeUrl: "https://b.example.org",
      });
    });
    const prev = process.env.BRIDGE_URL;
    delete process.env.BRIDGE_URL;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify(String(input).includes("a.example.org") ? modern : legacy),
        { status: 200 },
      ),
    );
    try {
      await t.action(internal.compat.pollBridgeCompat, {});
    } finally {
      vi.unstubAllGlobals();
      if (prev !== undefined) process.env.BRIDGE_URL = prev;
    }
    const admin = await asAdmin(t);
    const view = await admin.query(api.compat.listProtocolShapes, {});
    expect(view.reporting, "one silent bridge makes the whole reading partial").toBe(
      false,
    );
    expect(view.indicatorReliable).toBe(false);
  });

  test("every stored shape is REACHABLE for triage", async () => {
    // A page smaller than the capacity left rows 201-500 visible only as a truncation
    // flag: `triageProtocolShape` needs an `_id`, so an admin could see that something was
    // hidden and have no way to act on it (raised in review).
    const t = convexTest(schema, modules);
    await t.mutation(internal.compat.recordProtocolShapes, {
      shapes: Array.from({ length: 500 }, (_, i) => ({
        shape: `agent.f${i}`,
        count: 1,
      })),
      unnamed: 0,
      reporting: true,
    });
    const admin = await asAdmin(t);
    const view = await admin.query(api.compat.listProtocolShapes, {});
    expect(view.shapes).toHaveLength(500);
    expect(view.truncated, "the read bound IS the write cap").toBe(false);
    // …and the LAST one can actually be triaged.
    await admin.mutation(api.compat.triageProtocolShape, {
      id: view.shapes[499]?._id as Id<"protocolShapes">,
      status: "ignored",
      note: "bruit connu",
    });
    const after = await admin.query(api.compat.listProtocolShapes, {});
    expect(after.shapes[499]?.status).toBe("ignored");
  });

  test("an identifier-shaped FIELD NAME is stored — that is the feature", async () => {
    // Raised in review as a leak: `agent.AliceMartin` satisfies the grammar. It is kept
    // DELIBERATELY, and the reasoning is the bridge's own (lot 23): a drift detector that
    // refused to name an unknown FIELD could never report a new field at all, which is the
    // one thing it exists to do. The bridge draws the line between structure and content
    // where it can be drawn — it names unknown payload KEYS and DIGESTS unknown VALUES —
    // and this ledger inherits that line rather than inventing a second one.
    const t = convexTest(schema, modules);
    await poll(t, [{ shape: "agent.AliceMartin", count: 1 }]);
    expect((await ledger(t)).map((r) => r.shape)).toEqual(["agent.AliceMartin"]);
  });

  test("a bridge that FAILS makes coverage partial, without losing history", async () => {
    // An unreachable bridge is an unobserved one. Skipping it silently left one healthy
    // bridge vouching for a fleet that was partly dark (raised in review).
    const t = convexTest(schema, modules);
    await poll(t, [{ shape: "agent.lastTo", count: 2 }]);
    let admin = await asAdmin(t);
    expect((await admin.query(api.compat.listProtocolShapes, {})).indicatorReliable).toBe(
      true,
    );
    // Now every bridge goes dark.
    const prev = process.env.BRIDGE_URL;
    process.env.BRIDGE_URL = "https://bridge.example.org";
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      await t.action(internal.compat.pollBridgeCompat, {});
    } finally {
      vi.unstubAllGlobals();
      if (prev === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prev;
    }
    admin = await asAdmin(t);
    const view = await admin.query(api.compat.listProtocolShapes, {});
    expect(view.reporting, "a dark fleet is not a clean one").toBe(false);
    expect(view.indicatorReliable).toBe(false);
    // …and the rows survive: history is not what a failed poll invalidates.
    expect(view.shapes).toHaveLength(1);
  });

  test("triage requires an admin", async () => {
    const t = convexTest(schema, modules);
    await poll(t, [{ shape: "agent.lastTo", count: 1 }]);
    const id = (await ledger(t))[0]?._id;
    await expect(
      t.mutation(api.compat.triageProtocolShape, {
        id: id as Id<"protocolShapes">,
        status: "ignored",
      }),
    ).rejects.toThrow();
  });

  test("a shape that STOPS drifting keeps its row", async () => {
    // A bridge restart empties the in-memory counters. If the ledger mirrored that, the
    // history would vanish exactly when someone came to read it.
    const t = convexTest(schema, modules);
    await poll(t, [{ shape: "agent.lastTo", count: 24 }]);
    await poll(t, []);
    expect(await ledger(t)).toHaveLength(1);
  });

  test("a clean bridge writes nothing", async () => {
    const t = convexTest(schema, modules);
    await poll(t, []);
    expect(await ledger(t)).toEqual([]);
  });

  test("a malformed entry is dropped, not stored", async () => {
    // The bridge is trusted, but this row is written from a body fetched over the network
    // and the table's identity column is the shape itself. Each rejected form below is
    // rejected by its OWN clause — an empty name, a non-string name (JSON carries numbers
    // happily), and a count that did not survive serialization (`NaN` becomes `null`).
    const t = convexTest(schema, modules);
    await poll(t, [
      { shape: "", count: 3 },
      { shape: 42 as unknown as string, count: 1 },
      { shape: "agent.ok", count: 2 },
      { shape: "agent.nan", count: Number.NaN },
    ]);
    const rows = await ledger(t);
    expect(rows.map((r) => r.shape)).toEqual(["agent.ok"]);
  });
});
