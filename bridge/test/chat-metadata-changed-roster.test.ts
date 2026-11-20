// `chat.metadata.changed` — the gateway's notice that what a chat header shows about
// models may have changed. The model roster cached per connection is one of those
// things, and until this frame was read it stayed stale for up to the success TTL
// (10 min) after a catalogue or model-selection change that touched no config file.
//
// Upstream facts these tests encode:
//  - v2026.9.7 → v2026.9.36: the payload carries booleans — `modelCatalogChanged` /
//    `authChanged` from the chat-metadata runtime, `{modelSelectionChanged: true}` on a
//    model-selection policy change, and `{…, modelCatalogChanged: false, authChanged:
//    false}` on every session-cost publication (src/gateway/
//    server-chat-metadata-lifecycle.ts). Sent `dropIfSlow`.
//  - v2026.8.1 → v2026.9.6: the payload is `{}` (same file, `broadcast(…, {})`).
//  - The Control UI refreshes its model catalogue unless the payload says the catalogue
//    did not change (ui/src/lib/model-catalog-cache.ts modelCatalogEventInvalidation:
//    `modelSelectionChanged === true` → clear; `modelCatalogChanged === false` →
//    nothing; otherwise refresh). `authChanged` alone refreshes its auth-status reads,
//    not the catalogue (ui/src/lib/model-auth-request-state.ts).
//
// The payloads below are the four shapes the bench captured (2026.9.6 and 2026.9.36),
// plus the two the source emits that no run has captured.
import { afterEach, describe, expect, it } from "vitest";

import { readChatMetadataChanged } from "../src/providers/openclaw/chat-metadata-changed.js";
import {
  attachRosterPolicy,
  ensureAvailableModels,
  publishSessionMeta,
} from "../src/providers/openclaw/models-roster.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { sleep } from "./helpers/sleep.js";
import { deviceIdentity, startWsFakeGateway, type WsFakeGateway } from "./helpers/ws-fake-gateway.js";

const metadataChanged = (payload: unknown, seq?: number) => ({
  type: "event",
  event: "chat.metadata.changed",
  payload,
  ...(seq === undefined ? {} : { seq }),
});
/** Captured on 2026.9.36. */
const CATALOG_CHANGED = { authChanged: false, modelCatalogChanged: true };
const CATALOG_AND_AUTH_CHANGED = { authChanged: true, modelCatalogChanged: true };
const NOTHING_CHANGED = { authChanged: false, modelCatalogChanged: false };
/** Captured on 2026.9.6 (the only shape v2026.8.1 → v2026.9.6 send). */
const EMPTY = {};

const DEBOUNCE_MS = 20;
const SETTLE_MS = DEBOUNCE_MS * 6;

let gateway: WsFakeGateway | null = null;
afterEach(async () => {
  await gateway?.stop();
  gateway = null;
});

function rosterGateway(initial: { id: string }[]) {
  let roster = initial;
  const gw = startWsFakeGateway({
    version: "2026.9.36",
    onMethod: (method) => {
      if (method === "models.list") return { models: roster };
      if (method === "sessions.describe") {
        return { session: { key: "k", agentId: "alice", model: "openai/gpt-5.5" } };
      }
      return {};
    },
  });
  return {
    gw,
    setRoster(next: { id: string }[]) {
      roster = next;
    },
    listCalls: () => gw.requests.filter((r) => r.method === "models.list").length,
  };
}

describe("readChatMetadataChanged — the Control UI's own rule", () => {
  it("says the catalogue is stale unless the gateway says it did not change", () => {
    expect(readChatMetadataChanged(metadataChanged(CATALOG_CHANGED))).toEqual({ modelCatalogStale: true });
    expect(readChatMetadataChanged(metadataChanged(CATALOG_AND_AUTH_CHANGED))).toEqual({ modelCatalogStale: true });
    // The pre-2026.9.7 notice says nothing: everything may have changed.
    expect(readChatMetadataChanged(metadataChanged(EMPTY))).toEqual({ modelCatalogStale: true });
    expect(readChatMetadataChanged({ type: "event", event: "chat.metadata.changed" })).toEqual({ modelCatalogStale: true });
  });
  it("is not stale on the notice a session-cost publication rides on", () => {
    expect(readChatMetadataChanged(metadataChanged(NOTHING_CHANGED))).toEqual({ modelCatalogStale: false });
    expect(
      readChatMetadataChanged(
        metadataChanged({ agentId: "alice", usageUpdatedAt: 1794162692629, modelCatalogChanged: false, authChanged: false }),
      ),
    ).toEqual({ modelCatalogStale: false });
  });
  it("is not stale when only the provider auth changed (upstream refreshes auth status, not the catalogue)", () => {
    expect(readChatMetadataChanged(metadataChanged({ authChanged: true, modelCatalogChanged: false }))).toEqual({
      modelCatalogStale: false,
    });
  });
  it("is stale on a model-selection change, whatever else the payload says", () => {
    expect(readChatMetadataChanged(metadataChanged({ modelSelectionChanged: true }))).toEqual({ modelCatalogStale: true });
    expect(
      readChatMetadataChanged(metadataChanged({ modelSelectionChanged: true, modelCatalogChanged: false })),
    ).toEqual({ modelCatalogStale: true });
  });
  it("is null for every other frame", () => {
    expect(readChatMetadataChanged({ type: "event", event: "config.changed", payload: {} })).toBeNull();
    expect(readChatMetadataChanged({ type: "res", event: "chat.metadata.changed" })).toBeNull();
    expect(readChatMetadataChanged(null)).toBeNull();
  });
});

describe("the transport: a stale catalogue moves the roster epoch and is reported", () => {
  it("moves the epoch and tells the roster policy, and still queues the frame", async () => {
    const { gw } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const conn = await OpenClawConnection.connect(gw.url, "tok", deviceIdentity());
    try {
      const seen: unknown[] = [];
      conn.onConfigChanged((notice) => seen.push(notice));
      const frames = conn.frames();
      gw.push(metadataChanged(CATALOG_CHANGED, 1));
      // Observe-only: the consumer (and the drift detector behind it) still gets it.
      expect(((await frames.next()).value as { event?: string }).event).toBe("chat.metadata.changed");
      expect(conn.rosterEpoch).toBe(1);
      expect(seen).toEqual([{ hash: null, origin: "chat.metadata.changed" }]);
    } finally {
      conn.close();
    }
  });
  it("leaves the roster alone when the gateway says the catalogue did not change", async () => {
    const { gw } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const conn = await OpenClawConnection.connect(gw.url, "tok", deviceIdentity());
    try {
      const seen: unknown[] = [];
      conn.onConfigChanged((notice) => seen.push(notice));
      const frames = conn.frames();
      gw.push(metadataChanged(NOTHING_CHANGED, 1));
      gw.push(metadataChanged({ authChanged: true, modelCatalogChanged: false }, 2));
      await frames.next();
      await frames.next();
      expect(conn.rosterEpoch).toBe(0);
      expect(seen).toEqual([]);
    } finally {
      conn.close();
    }
  });
});

describe("the policy: the roster a chat shows follows the notice, without a turn", () => {
  async function connectWithPolicy(gw: WsFakeGateway) {
    const conn = await OpenClawConnection.connect(gw.url, "tok", deviceIdentity());
    const published: (string[] | null)[] = [];
    const writer = {
      reportSessionMeta: async (_chatId: string, meta: { availableModels?: { id: string }[] }) => {
        published.push(meta.availableModels?.map((m) => m.id) ?? null);
      },
      reportSessionRoster: async () => {},
    };
    const policy = attachRosterPolicy(
      { connection: conn, sessionKey: "k", chatId: "c1", agentId: "alice" },
      writer,
      { debounceMs: DEBOUNCE_MS, retryMs: 10_000 },
    );
    return { conn, policy, published, writer };
  }

  it("publishes the new roster after a catalogue change — one refresh for a burst", async () => {
    const { gw, setRoster, listCalls } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    try {
      await ensureAvailableModels(conn, "alice");
      expect(listCalls()).toBe(1);
      setRoster([{ id: "a" }, { id: "b" }]);
      // The gateway sends these in bursts (median gap ~150 ms on the bench).
      for (let seq = 1; seq <= 8; seq++) gw.push(metadataChanged(seq % 2 ? CATALOG_CHANGED : EMPTY, seq));
      await sleep(SETTLE_MS);
      expect(published.at(-1)).toEqual(["a", "b"]);
      expect(published.length, "one coalesced refresh").toBe(1);
      expect(listCalls(), "one re-ask for the burst").toBe(2);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("writes NOTHING to Convex when the refresh finds what was last published — the cost of an empty notice is two reads", async () => {
    // 2026.8.1 → 2026.9.6 send `{}` on every metadata change: each one must be read
    // (the catalogue MAY have changed) but an identical answer is not news.
    const { gw, setRoster, listCalls } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    const describes = () => gw.requests.filter((r) => r.method === "sessions.describe").length;
    try {
      gw.push(metadataChanged(EMPTY, 1));
      await sleep(SETTLE_MS);
      expect(published).toEqual([["a"]]); // the first refresh publishes: nothing was on record
      const before = { list: listCalls(), describe: describes() };
      for (let round = 0; round < 3; round++) {
        gw.push(metadataChanged(EMPTY, 2 + round));
        await sleep(SETTLE_MS);
      }
      expect(published, "no write for an unchanged roster").toEqual([["a"]]);
      // Each notice still cost exactly one describe and one models.list.
      expect(listCalls() - before.list).toBe(3);
      expect(describes() - before.describe).toBe(3);
      // A real change is published.
      setRoster([{ id: "a" }, { id: "b" }]);
      gw.push(metadataChanged(EMPTY, 5));
      await sleep(SETTLE_MS);
      expect(published).toEqual([["a"], ["a", "b"]]);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("compares with what Convex was LAST sent, whichever path sent it", async () => {
    // A send's own publish in between moved what Convex holds; a refresh that finds the
    // earlier roster again must publish it, not take it for unchanged.
    const { gw, setRoster } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published, writer } = await connectWithPolicy(gw);
    try {
      gw.push(metadataChanged(EMPTY, 1));
      await sleep(SETTLE_MS);
      expect(published).toEqual([["a"]]);
      // The send path publishes another roster for the same chat.
      await publishSessionMeta(
        { chatId: "c1", connection: conn, agentId: "alice", sessionKey: "k" },
        writer,
        { sess: { key: "k", agentId: "alice", model: "openai/gpt-5.5" }, observedAt: 1 },
        { owner: "alice", models: [{ id: "z", label: "z" }], observedAt: 1 } as never,
      );
      expect(published.at(-1)).toEqual(["z"]);
      setRoster([{ id: "a" }]);
      gw.push(metadataChanged(EMPTY, 2));
      await sleep(SETTLE_MS);
      expect(published.at(-1)).toEqual(["a"]);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("a config.changed always publishes, even with an identical roster", async () => {
    const { gw } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    try {
      gw.push(metadataChanged(EMPTY, 1));
      await sleep(SETTLE_MS);
      gw.push({ type: "event", event: "config.changed", payload: { path: "/x", hash: "hmac-sha256:v1:r2", ts: 1 }, seq: 2 });
      await sleep(SETTLE_MS);
      expect(published).toEqual([["a"], ["a"]]);
    } finally {
      policy.dispose();
      conn.close();
    }
  });

  it("asks nothing for the notices that say the catalogue did not change", async () => {
    const { gw, listCalls } = rosterGateway([{ id: "a" }]);
    gateway = gw;
    await gw.ready;
    const { conn, policy, published } = await connectWithPolicy(gw);
    try {
      await ensureAvailableModels(conn, "alice");
      for (let seq = 1; seq <= 20; seq++) gw.push(metadataChanged(NOTHING_CHANGED, seq));
      await sleep(SETTLE_MS);
      expect(published).toEqual([]);
      expect(listCalls()).toBe(1);
      expect(gw.requests.filter((r) => r.method === "sessions.describe")).toEqual([]);
    } finally {
      policy.dispose();
      conn.close();
    }
  });
});
