// `config.changed` (frame-discovery) — the gateway broadcasts it on EVERY persisted
// config change, hand edits included (upstream server-reload-managed.ts,
// onConfigCandidateCommitted). The per-owner `models.list` roster cached on the
// connection is a projection of that config, so it is stale the moment the event
// arrives; before this frame was read, a roster was cached for the life of the
// connection and a model added to the gateway's config stayed invisible until a restart.
//
// The contract, each clause a test. TRANSPORT (a real socket): the frame is read and
// reported raw; a frame gap moves the roster epoch (a `dropIfSlow` broadcast that was
// lost consumed a `seq`). POLICY (models-roster.ts, attached by the session): every
// notice invalidates and, coalesced over a burst, ends in a refresh that pushes the
// roster to Convex — retried once, forcing the ask past the failure bound, when the
// roster published was not the post-change one. CACHE: ordered by EPOCH, never by the
// clock; a roster in hand is served and re-asked off the caller's path; the config
// refresh alone waits for a post-invalidation answer; asks are serialized per owner; a
// failed re-ask keeps the last good roster (`null` when there never was one); a late
// answer from an older epoch never clobbers a newer entry.
import { afterEach, describe, expect, it } from "vitest";

import { readConfigChanged } from "../src/providers/openclaw/config-changed.js";
import {
  attachRosterPolicy,
  ensureAvailableModels,
  parseSessionMeta,
  rosterEpochOf,
} from "../src/providers/openclaw/models-roster.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { BROADCAST_ONLY_EVENTS } from "../src/providers/openclaw/protocol-drift.js";
import { modelsConnSpy } from "./helpers/fake-gateway.js";
import { sleep } from "./helpers/sleep.js";
import { deviceIdentity, startWsFakeGateway, type WsFakeGateway } from "./helpers/ws-fake-gateway.js";

/** The gateway's own frame, verbatim shape as observed at v2026.9.1. */
const configChanged = (hash: string) => ({
  type: "event",
  event: "config.changed",
  payload: { path: "/x/openclaw.json", hash: `hmac-sha256:v1:${hash}`, ts: 42 },
});
const DEBOUNCE_MS = 20;
const RETRY_MS = 250; // longer than SETTLE_MS: a retry is observed on purpose, never by accident
const SETTLE_MS = DEBOUNCE_MS * 6; // the window is jittered up to 2× debounce
const ids = (r: { models: { id: string }[] } | { id: string }[] | null) =>
  r === null ? null : (Array.isArray(r) ? r : r.models).map((x) => x.id);

let gateway: WsFakeGateway | null = null;
afterEach(async () => {
  await gateway?.stop();
  gateway = null;
});

/** A gateway whose `models.list` answer can be changed between asks, and that describes
 *  any session as agent `alice`. */
function rosterGateway(initial: { id: string; label?: string }[]) {
  let roster = initial;
  let failList = false;
  let failDescribe = false;
  const gw = startWsFakeGateway({
    onMethod: (method) => {
      if (method === "models.list") return failList ? { error: { code: "UNAVAILABLE" } } : { models: roster };
      if (method === "sessions.describe") {
        return failDescribe ? { error: { code: "UNAVAILABLE" } } : { session: { key: "k", agentId: "alice", model: "openai/gpt-5.5" } };
      }
      return {};
    },
  });
  return {
    gw,
    setRoster(next: { id: string; label?: string }[]) {
      roster = next;
    },
    setFailList(v: boolean) {
      failList = v;
    },
    setFailDescribe(v: boolean) {
      failDescribe = v;
    },
    listCalls: () => gw.requests.filter((r) => r.method === "models.list").length,
  };
}

/** A connection with the policy attached and a writer spy: what the SESSION does. */
async function connectWithPolicy(gw: WsFakeGateway) {
  const conn = await OpenClawConnection.connect(gw.url, "tok", deviceIdentity());
  const published: ({ id: string }[] | null)[] = [];
  const writer = {
    reportSessionMeta: async (_chatId: string, meta: { availableModels?: { id: string }[] }) => {
      published.push(meta.availableModels ?? null);
    },
    reportSessionRoster: async () => {},
  };
  const policy = attachRosterPolicy(
    { connection: conn, sessionKey: "k", chatId: "c1", agentId: "alice" },
    writer,
    { debounceMs: DEBOUNCE_MS, retryMs: RETRY_MS },
  );
  return { conn, policy, published };
}

describe("readConfigChanged — the frame, and nothing else", () => {
  it("reads the observed wire shape", () => {
    expect(readConfigChanged(configChanged("rev-2"))).toEqual({ hash: "hmac-sha256:v1:rev-2" });
  });
  it("tolerates an absent or malformed payload (a notice, not a contract to refuse)", () => {
    expect(readConfigChanged({ type: "event", event: "config.changed" })).toEqual({ hash: null });
    expect(readConfigChanged({ type: "event", event: "config.changed", payload: { hash: 7, ts: "x" } })).toEqual({ hash: null });
  });
  it("is null for every other frame", () => {
    expect(readConfigChanged({ type: "event", event: "skills.changed" })).toBeNull();
    expect(readConfigChanged({ type: "res", event: "config.changed" })).toBeNull();
    expect(readConfigChanged(null)).toBeNull();
    expect(readConfigChanged("config.changed")).toBeNull();
  });
});

describe("the transport: the notice is reported raw, every invalidation moves the epoch here", () => {
  it("a config.changed frame moves the epoch, then every listener hears the notice", async () => {
    const { gw } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const conn = await OpenClawConnection.connect(gw.url, "tok", deviceIdentity());
    try {
      const seen: unknown[] = [];
      conn.onConfigChanged((notice) => {
        seen.push(notice);
      });
      gw.push(configChanged("rev-2"));
      await sleep(30);
      expect(seen).toEqual([{ hash: "hmac-sha256:v1:rev-2" }]);
      expect(conn.rosterEpoch, "invalidated in the transport, like a frame gap").toBe(1);
    } finally {
      conn.close();
    }
  });
  it("a frame GAP moves the epoch in the transport itself — free, no request, and every gap counts", async () => {
    const { gw, setRoster, listCalls } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const conn = await OpenClawConnection.connect(gw.url, "tok", deviceIdentity());
    try {
      await ensureAvailableModels(conn, "alice");
      setRoster([{ id: "a" }, { id: "b" }]);
      gw.push({ type: "event", event: "tick", payload: {}, seq: 1 });
      gw.push({ type: "event", event: "tick", payload: {}, seq: 7 }); // seqs consumed for frames we never got
      await sleep(30);
      expect(conn.rosterEpoch).toBe(1);
      gw.push({ type: "event", event: "tick", payload: {}, seq: 20 });
      await sleep(30);
      expect(conn.rosterEpoch).toBe(2);
      expect(listCalls(), "no request was started by the gaps").toBe(1);
      expect(ids(await ensureAvailableModels(conn, "alice", "fresh"))).toEqual(["a", "b"]);
    } finally {
      conn.close();
    }
  });
});

describe("the policy: config.changed → invalidate, coalesce, refresh, publish", () => {
  it("a model added to the gateway config reaches Convex WITHOUT a turn and without a restart", async () => {
    const { gw, setRoster, listCalls } = rosterGateway([{ id: "openai/gpt-5.5", label: "GPT-5.5" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    try {
      expect(ids(await ensureAvailableModels(conn, "alice"))).toEqual(["openai/gpt-5.5"]);
      setRoster([{ id: "openai/gpt-5.5", label: "GPT-5.5" }, { id: "openai/gpt-6-astra", label: "GPT-6-Astra" }]);
      gw.push(configChanged("rev-2")); // the operator edited openclaw.json; the gateway reloaded and broadcast
      await sleep(SETTLE_MS);
      expect(published.map(ids), "the fresh roster was pushed to Convex").toEqual([["openai/gpt-5.5", "openai/gpt-6-astra"]]);
      expect(listCalls(), "one re-ask for the refresh").toBe(2);
      expect(ids(await ensureAvailableModels(conn, "alice"))).toEqual(["openai/gpt-5.5", "openai/gpt-6-astra"]);
      expect(listCalls(), "…and the cache serves the next turn with no further round trip").toBe(2);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("without the event, a fresh success is served from cache", async () => {
    const { gw, setRoster, listCalls } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy } = await connectWithPolicy(gw);
    try {
      await ensureAvailableModels(conn, "alice");
      setRoster([{ id: "a" }, { id: "b" }]);
      await ensureAvailableModels(conn, "alice");
      expect(listCalls()).toBe(1);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("a burst of revisions is ONE refresh (coalesced); a re-sent revision is refreshed again (no acknowledgement by hash)", async () => {
    const { gw, listCalls } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    try {
      gw.push(configChanged("rev-2"));
      gw.push(configChanged("rev-3"));
      gw.push(configChanged("rev-4"));
      await sleep(SETTLE_MS);
      expect(published, "three commits in a burst, one publish").toHaveLength(1);
      expect(listCalls()).toBe(1);
      gw.push(configChanged("rev-4")); // re-sent: a `models.list` answered mid-reload may have been the OLD roster — refresh again
      await sleep(SETTLE_MS);
      expect(published).toHaveLength(2);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("a refresh whose roster was not the post-change one is retried once, FORCING the ask past the failure bound", async () => {
    const { gw, setRoster, setFailList } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    try {
      await ensureAvailableModels(conn, "alice");
      setRoster([{ id: "a" }, { id: "b" }]);
      setFailList(true); // the gateway is reloading providers right after the commit
      gw.push(configChanged("rev-2"));
      await sleep(SETTLE_MS);
      expect(published.map(ids), "the last good roster was published, never a blank").toEqual([["a"]]);
      expect(rosterEpochOf(conn, "alice"), "…but it is the pre-change one (epoch 0), not the post-change one").toBe(0);
      setFailList(false);
      await sleep(RETRY_MS + SETTLE_MS);
      expect(published.map(ids), "one retry later, the post-change roster is published").toEqual([["a"], ["a", "b"]]);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("a refresh whose ask fails with NO roster in hand publishes WITHOUT the field (Convex keeps the roster) and is retried", async () => {
    const { gw, setFailList } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    try {
      setFailList(true);
      gw.push(configChanged("rev-2"));
      await sleep(SETTLE_MS);
      expect(published, "published with no roster field — the wipe rule lives in Convex").toEqual([null]);
      setFailList(false);
      await sleep(RETRY_MS + SETTLE_MS);
      expect(published.map(ids)).toEqual([null, ["a"]]);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("a new revision during a pending retry is refreshed within the debounce window, with its own budget", async () => {
    const { gw, setRoster, setFailDescribe } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    try {
      setFailDescribe(true);
      gw.push(configChanged("rev-2")); // fails: retry armed (RETRY_MS)
      await sleep(SETTLE_MS);
      expect(published).toHaveLength(0);
      setFailDescribe(false);
      setRoster([{ id: "a" }, { id: "b" }]);
      gw.push(configChanged("rev-3")); // arrives while rev-2's retry is pending
      await sleep(SETTLE_MS); // well before RETRY_MS
      expect(published.map(ids), "rev-3 was refreshed on its own debounce, not rev-2's retry deadline").toEqual([["a", "b"]]);
      await sleep(RETRY_MS + SETTLE_MS);
      expect(published, "and rev-2's retry did not fire on top of it").toHaveLength(1);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("an OLDER refresh answering after a newer revision is pending does not spend the newer one's retry budget", async () => {
    // Sequence: rev-2's describe is slow and fails; rev-3 arrives while that answer is in
    // flight and is waiting for its own window; rev-2's failure lands first. Superseded,
    // it must neither take rev-3's place in the pending slot nor arm a retry: rev-3's own
    // refresh then fails once and is the one retried — with its budget of one.
    let describes = 0;
    let failRev2: () => void = () => {};
    const gw = startWsFakeGateway({
      onMethod: async (method) => {
        if (method === "models.list") return { models: [{ id: "a" }] };
        if (method !== "sessions.describe") return {};
        describes += 1;
        if (describes === 1) {
          await new Promise<void>((r) => { failRev2 = r; }); // held until the test lets it fail
          return { error: { code: "UNAVAILABLE" } };
        }
        if (describes === 2) return { error: { code: "UNAVAILABLE" } };
        return { session: { key: "k", agentId: "alice" } };
      },
    });
    gateway = gw;
    await gw.ready;
    const conn = await OpenClawConnection.connect(gw.url, "tok", deviceIdentity());
    const published: unknown[] = [];
    const policy = attachRosterPolicy(
      { connection: conn, sessionKey: "k", chatId: "c1", agentId: "alice" },
      { reportSessionMeta: async (_c: string, meta: unknown) => { published.push(meta); }, reportSessionRoster: async () => {} },
      { debounceMs: 100, retryMs: RETRY_MS },
    );
    try {
      gw.push(configChanged("rev-2"));
      await sleep(250); // rev-2's window (100–200 ms) is over: its describe is in flight, held
      expect(describes).toBe(1);
      gw.push(configChanged("rev-3")); // pending, its window is 100–200 ms away
      await sleep(30);
      failRev2(); // rev-2's failure lands while rev-3 is still waiting for its window
      await sleep(200 + RETRY_MS + 200); // rev-3 refreshed once (failed), then retried once (succeeds)
      expect(describes, "rev-2, rev-3, rev-3's retry").toBe(3);
      expect(published, "rev-3's retry published — its budget was its own").toHaveLength(1);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("a frame gap landing while the refresh's ask is IN FLIGHT does not make it retry (judged by the notice's epoch)", async () => {
    let roster = [{ id: "a" }];
    const gw = startWsFakeGateway({
      onMethod: async (method) => {
        if (method === "sessions.describe") return { session: { key: "k", agentId: "alice" } };
        if (method === "models.list") {
          await sleep(120); // a slow answer, computed on the post-change config
          return { models: roster };
        }
        return {};
      },
    });
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    try {
      roster = [{ id: "a" }, { id: "b" }];
      gw.push(configChanged("rev-2"));
      await sleep(DEBOUNCE_MS * 2 + 30); // the refresh's ask is in flight now
      gw.push({ type: "event", event: "tick", payload: {}, seq: 50 });
      gw.push({ type: "event", event: "tick", payload: {}, seq: 90 }); // a gap, mid-ask
      await sleep(200);
      expect(published).toHaveLength(1);
      await sleep(RETRY_MS + SETTLE_MS);
      expect(published, "no retry: the roster is from the notice's epoch or later").toHaveLength(1);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("disposes itself when the connection closes: a frame buffered past close() never re-arms", async () => {
    const { gw } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, published } = await connectWithPolicy(gw);
    conn.close();
    await sleep(SETTLE_MS);
    expect(published).toHaveLength(0);
  });
});

describe("ensureAvailableModels — the cache's own clauses", () => {
  it("a success past its bound is SERVED and refreshed off the caller's path", async () => {
    let roster: { id: string }[] = [{ id: "a" }];
    const { conn, countOf } = modelsConnSpy(() => ({ models: roster }));
    await ensureAvailableModels(conn, "alice");
    roster = [{ id: "a" }, { id: "b" }];
    conn.modelsByOwner.get("alice")!.at = Date.now() - 11 * 60_000;
    expect(ids(await ensureAvailableModels(conn, "alice"))).toEqual(["a"]);
    await sleep(5);
    expect(countOf("models.list"), "the refresh ran in the background").toBe(2);
    expect(ids(await ensureAvailableModels(conn, "alice"))).toEqual(["a", "b"]);
  });

  it("a fresh success is not asked again", async () => {
    const { conn, countOf } = modelsConnSpy(() => ({ models: [{ id: "a" }] }));
    await ensureAvailableModels(conn, "alice");
    await ensureAvailableModels(conn, "alice");
    expect(countOf("models.list")).toBe(1);
  });

  it("an invalidated roster is SERVED as is by default (a turn, a knob patch never wait), refreshed behind", async () => {
    let roster: { id: string }[] = [{ id: "a" }];
    const { conn, countOf } = modelsConnSpy(() => ({ models: roster }));
    await ensureAvailableModels(conn, "alice");
    roster = [{ id: "a" }, { id: "b" }];
    conn.rosterEpoch += 1;
    expect(ids(await ensureAvailableModels(conn, "alice"))).toEqual(["a"]);
    await sleep(5);
    expect(countOf("models.list")).toBe(2);
    expect(ids(await ensureAvailableModels(conn, "alice"))).toEqual(["a", "b"]);
  });

  it("`fresh` (the config refresh) waits, and a caller arriving during an OLDER ask waits for it then asks ONCE more — never in parallel", async () => {
    let release: (v: unknown) => void = () => {};
    let first = true;
    const { conn, countOf, calls } = modelsConnSpy(() => {
      if (first) {
        first = false;
        return new Promise((r) => { release = r; });
      }
      return { models: [{ id: "a" }, { id: "b" }] };
    });
    const ask1 = ensureAvailableModels(conn, "alice"); // epoch 0, slow
    await sleep(2);
    conn.rosterEpoch += 1; // config.changed arrives mid-flight
    const ask2 = ensureAvailableModels(conn, "alice", "fresh");
    await sleep(5);
    expect(calls.filter((c) => c.method === "models.list"), "no second ask while one is in flight").toHaveLength(1);
    release({ models: [{ id: "a" }] }); // the old answer lands
    expect(ids(await ask1)).toEqual(["a"]);
    expect(ids(await ask2), "then one ask in the current epoch").toEqual(["a", "b"]);
    expect(countOf("models.list")).toBe(2);
    expect(rosterEpochOf(conn, "alice")).toBe(1);
  });

  it("filing is forward-only: an answer from an OLDER epoch never replaces an entry filed for a newer one", async () => {
    let release: (v: unknown) => void = () => {};
    const { conn } = modelsConnSpy(() => new Promise((r) => { release = r; }));
    const slow = ensureAvailableModels(conn, "alice"); // epoch 0, in flight
    await sleep(2);
    conn.rosterEpoch += 1;
    // What a newer filing looks like once it has landed (the serialized ask path files it
    // the same way): the late epoch-0 answer must not win over it.
    conn.modelsByOwner.set("alice", { roster: { models: [{ id: "a", label: "a" }, { id: "b", label: "b" }], owner: "alice", observedAt: Date.now() }, rosterEpoch: 1, at: Date.now(), ok: true, epoch: 1 });
    release({ models: [{ id: "old" }] });
    expect(ids(await slow), "the old caller is served the entry on record, not its stale answer").toEqual(["a", "b"]);
    const entry = conn.modelsByOwner.get("alice")!;
    expect([entry.ok, entry.epoch, ids(entry.roster)], "the cache only moves forward").toEqual([true, 1, ["a", "b"]]);
  });

  it("an OLDER ask that ends in FAILURE after an invalidation neither demotes nor skips the ask that waited for it", async () => {
    let reject: (e: unknown) => void = () => {};
    let first = true;
    const { conn, countOf } = modelsConnSpy(() => {
      if (first) {
        first = false;
        return new Promise((_r, rj) => { reject = rj; });
      }
      return { models: [{ id: "a" }, { id: "b" }] };
    });
    const slow = ensureAvailableModels(conn, "alice"); // epoch 0
    await sleep(2);
    conn.rosterEpoch += 1;
    const waiting = ensureAvailableModels(conn, "alice", "fresh"); // waits for the epoch-0 ask
    await sleep(2);
    reject(new Error("timeout"));
    expect(await slow).toBeNull();
    expect(ids(await waiting), "the failure bound did not swallow the post-invalidation ask").toEqual(["a", "b"]);
    const entry = conn.modelsByOwner.get("alice")!;
    expect([entry.ok, entry.epoch, ids(entry.roster)]).toEqual([true, 1, ["a", "b"]]);
    expect(countOf("models.list")).toBe(2);
  });

  it("a failed re-ask keeps the LAST GOOD roster — a transient failure never empties the picker", async () => {
    let fail = false;
    const { conn } = modelsConnSpy(() => {
      if (fail) throw new Error("timeout");
      return { models: [{ id: "a" }] };
    });
    await ensureAvailableModels(conn, "alice");
    fail = true;
    conn.rosterEpoch += 1;
    expect(ids(await ensureAvailableModels(conn, "alice", "fresh"))).toEqual(["a"]);
    expect(ids(await ensureAvailableModels(conn, "alice"))).toEqual(["a"]);
  });

  it("nothing in hand is `null`, OMITTED from the meta; an EMPTY answer is a failure, not a roster", async () => {
    const { conn: failing } = modelsConnSpy(() => { throw new Error("timeout"); });
    expect(await ensureAvailableModels(failing, "alice")).toBeNull();
    expect(parseSessionMeta({}, null).availableModels, "Convex keeps the roster on record").toBeUndefined();
    // A gateway mid-reload answers an empty catalogue: the last good roster is kept and the
    // ask retried on the failure bound — a stale list a person can pick from beats none.
    let empty = false;
    const { conn, countOf } = modelsConnSpy(() => ({ models: empty ? [] : [{ id: "a" }] }));
    expect(ids(await ensureAvailableModels(conn, "alice"))).toEqual(["a"]);
    empty = true;
    conn.rosterEpoch += 1;
    expect(ids(await ensureAvailableModels(conn, "alice", "forced")), "the last good roster").toEqual(["a"]);
    expect(conn.modelsByOwner.get("alice")!.ok, "…marked failed, so the bound applies and a retry follows").toBe(false);
    expect(countOf("models.list")).toBe(2);
  });

  it("a failed ask after a good one in the SAME epoch does not un-file the roster: it still answers 'post-change'", async () => {
    let fail = false;
    const { conn } = modelsConnSpy(() => {
      if (fail) throw new Error("timeout");
      return { models: [{ id: "a" }] };
    });
    conn.rosterEpoch = 3;
    await ensureAvailableModels(conn, "alice");
    fail = true;
    conn.modelsByOwner.get("alice")!.at = Date.now() - 11 * 60_000; // past the success bound
    await ensureAvailableModels(conn, "alice", "fresh");
    expect(rosterEpochOf(conn, "alice"), "the roster in hand is from epoch 3, whatever the last ask did").toBe(3);
    expect(conn.modelsByOwner.get("alice")!.ok).toBe(false);
  });

  it("a cached FAILURE is honoured for its bound, even under `fresh` — a dead gateway costs no timeout per turn; `force` is the deliberate retry", async () => {
    const { conn, countOf } = modelsConnSpy(() => { throw new Error("timeout"); });
    await ensureAvailableModels(conn, "alice", "fresh");
    await ensureAvailableModels(conn, "alice", "fresh");
    expect(countOf("models.list")).toBe(1);
    await ensureAvailableModels(conn, "alice", "forced");
    expect(countOf("models.list")).toBe(2);
  });

  it("with NOTHING in hand, an expired failure is waited for — the picker gets a roster, not one more blank", async () => {
    let fail = true;
    const { conn, countOf } = modelsConnSpy(() => {
      if (fail) throw new Error("timeout");
      return { models: [{ id: "a" }] };
    });
    expect(await ensureAvailableModels(conn, "alice")).toBeNull();
    fail = false;
    conn.modelsByOwner.get("alice")!.at = Date.now() - 2 * 60_000; // the failure aged out
    expect(ids(await ensureAvailableModels(conn, "alice")), "served the answer, not the blank behind a background re-ask").toEqual(["a"]);
    expect(countOf("models.list")).toBe(2);
  });

  it("concurrent asks for one owner share ONE round trip", async () => {
    const { conn, countOf } = modelsConnSpy(() => ({ models: [{ id: "a" }] }));
    const [x, y] = await Promise.all([ensureAvailableModels(conn, "alice"), ensureAvailableModels(conn, "alice")]);
    expect(x).toEqual(y);
    expect(countOf("models.list")).toBe(1);
  });
});

describe("the sensor knows the family under its real vocabulary", () => {
  it("config.changed is a broadcast-only family — never announced, so never in the announced mirror", () => {
    expect(BROADCAST_ONLY_EVENTS.has("config.changed")).toBe(true);
  });
});
