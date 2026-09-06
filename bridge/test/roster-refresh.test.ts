// The refresh that makes the roster follow the gateway WITHOUT a turn: describe the
// session, ask the roster under the DESCRIBED agent, push the meta with the fence stamp
// — and the Session wires it through the roster policy, the way it wires the frame-gap
// report.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import {
  ROSTER_NOTIFY_DEBOUNCE_MS,
  attachRosterPolicy,
  publishDescribedSession,
  publishSessionMeta,
  refreshAfterConfigChange,
} from "../src/providers/openclaw/models-roster.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { SessionRegistry } from "../src/session.js";
import { modelsConnSpy } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

const NOTICE = { hash: "hmac-sha256:v1:rev-2" };
const answers = (map: Record<string, (params: unknown) => unknown>) => (method: string, params: unknown) => {
  const a = map[method];
  if (a === undefined) return {};
  return a(params);
};
const session = (conn: ReturnType<typeof modelsConnSpy>["conn"]) => ({ connection: conn, sessionKey: "k", chatId: "c1", agentId: "Alice" });
/** Records every meta publish as `[chatId, meta]`, and every roster-alone report. */
function writerSpy() {
  const reported: [string, Record<string, unknown>][] = [];
  const rosters: { chatId: string; models: { id: string }[]; owner: string; observedAt: number }[] = [];
  return {
    reported,
    rosters,
    metas: () => reported.map(([, m]) => m),
    writer: {
      reportSessionMeta: async (chatId: string, meta: Record<string, unknown>) => { reported.push([chatId, meta]); },
      reportSessionRoster: async (chatId: string, roster: { models: { id: string }[]; owner: string; observedAt: number }) => { rosters.push({ chatId, ...roster }); },
    },
  };
}
const modelIds = (meta: Record<string, unknown>) => (meta.availableModels as { id: string }[] | undefined)?.map((m) => m.id);

describe("refreshAfterConfigChange / publishDescribedSession — describe, ask, push", () => {
  it("pushes the roster under the DESCRIBED agent — the knobs stamped by the describe, the roster by ITS answer — and reports its epoch", async () => {
    const { conn, calls } = modelsConnSpy(
      answers({
        "sessions.describe": () => ({ session: { key: "k", model: "openai/gpt-5.5", agentId: "alice" } }),
        "models.list": async () => {
          await sleep(20); // the gateway is reloading: the roster answers well after the describe
          return { models: [{ id: "openai/gpt-5.5" }, { id: "openai/gpt-6-astra" }] };
        },
      }),
    );
    const { reported, writer } = writerSpy();
    const before = Date.now();
    await sleep(2);
    expect(await refreshAfterConfigChange(session(conn), writer, NOTICE)).toEqual({ published: true, rosterEpoch: 0 });
    // The described agent (`alice`), not the routed spelling (`Alice`): one key per agent.
    expect(calls.find((c) => c.method === "models.list")?.params).toEqual({ agentId: "alice" });
    const [chatId, meta] = reported[0]!;
    expect(chatId).toBe("c1");
    expect(modelIds(meta)).toEqual(["openai/gpt-5.5", "openai/gpt-6-astra"]);
    expect(meta.availableModelsOwner).toBe("alice");
    expect(meta.observedAt as number).toBeGreaterThan(before);
    // Two clocks. A send that described DURING the wait is stamped between the two; with
    // one stamp for both, Convex's knob watermark discarded the very roster this refresh
    // exists to publish, and the policy recorded the refresh as done.
    expect(meta.rosterObservedAt as number).toBeGreaterThanOrEqual((meta.observedAt as number) + 20);
  });

  it("a roster whose EVERY model the gateway marks unavailable is its transient state: the last good roster is kept, not `[]`", async () => {
    let cooldown = false;
    const { conn } = modelsConnSpy(
      answers({
        "sessions.describe": () => ({ session: { key: "k", agentId: "alice" } }),
        "models.list": () =>
          cooldown
            ? { models: [{ id: "a", available: false, unavailableReason: "cooldown" }] }
            : { models: [{ id: "a" }] },
      }),
    );
    const { metas, writer } = writerSpy();
    await refreshAfterConfigChange(session(conn), writer, NOTICE);
    cooldown = true;
    conn.rosterEpoch += 1;
    expect(await refreshAfterConfigChange(session(conn), writer, NOTICE), "the roster in hand is the pre-change one").toEqual({ published: true, rosterEpoch: 0 });
    expect(modelIds(metas()[1]!), "served the last good roster; retried on the failure bound").toEqual(["a"]);
  });

  it("a payload without a `models` array is not an empty roster: nothing in hand, the field omitted", async () => {
    const { conn } = modelsConnSpy(
      answers({
        "sessions.describe": () => ({ session: { key: "k", agentId: "alice" } }),
        "models.list": () => ({}),
      }),
    );
    const { metas, writer } = writerSpy();
    expect(await refreshAfterConfigChange(session(conn), writer, NOTICE)).toEqual({ published: true, rosterEpoch: -1 });
    expect(metas()[0]!.availableModels).toBeUndefined();
  });

  it("a failed describe pushes NOTHING", async () => {
    const { conn } = modelsConnSpy(answers({ "sessions.describe": () => { throw new Error("timeout"); } }));
    const { reported, writer } = writerSpy();
    expect(await refreshAfterConfigChange(session(conn), writer, NOTICE)).toEqual({ published: false, rosterEpoch: -1 });
    expect(reported).toEqual([]);
  });

  it("a failed ask with NO roster in hand publishes without the field (Convex keeps the roster on record) and reports no epoch", async () => {
    const { conn } = modelsConnSpy(
      answers({
        "sessions.describe": () => ({ session: { key: "k", agentId: "alice" } }),
        "models.list": () => { throw new Error("unknown agent id"); },
      }),
    );
    const { metas, writer } = writerSpy();
    expect(await refreshAfterConfigChange(session(conn), writer, NOTICE)).toEqual({ published: true, rosterEpoch: -1 });
    expect(metas()[0]!.availableModels).toBeUndefined();
  });

  it("a connection closed meanwhile (the chat re-bound) publishes nothing on a config change", async () => {
    const { conn } = modelsConnSpy(
      answers({
        "sessions.describe": () => ({ session: { key: "k", agentId: "alice" } }),
        "models.list": () => ({ models: [{ id: "a" }] }),
      }),
    );
    const { reported, writer } = writerSpy();
    conn.isClosed = true;
    expect((await refreshAfterConfigChange(session(conn), writer, NOTICE)).published).toBe(false);
    expect(reported).toEqual([]);
  });

  it("a knob patch publishes AT ONCE with the roster in hand, re-asks off its path and reports a NEWER answer alone under its own stamp", async () => {
    let roster = [{ id: "a" }];
    const { conn, countOf } = modelsConnSpy(
      answers({
        "sessions.describe": () => ({ session: { key: "k", agentId: "alice" } }),
        "models.list": () => ({ models: roster }),
      }),
    );
    const { metas, rosters, writer } = writerSpy();
    await publishDescribedSession(session(conn), writer);
    expect(modelIds(metas()[0]!), "nothing in hand yet: WAITED for the answer, published with it (a first turn's picker)").toEqual(["a"]);
    await sleep(5);
    expect(rosters, "…and nothing to report alone").toEqual([]);
    await publishDescribedSession(session(conn), writer);
    await sleep(5);
    expect([modelIds(metas()[1]!), rosters.length], "the cache is current: in the meta, and not reported twice").toEqual([["a"], 0]);
    roster = [{ id: "a" }, { id: "b" }];
    conn.rosterEpoch += 1; // a frame gap: the lost frame may have been a config change
    await publishDescribedSession(session(conn), writer);
    expect(modelIds(metas()[2]!), "served as is, at once").toEqual(["a"]);
    await sleep(5);
    expect(countOf("models.list"), "…re-asked behind").toBe(2);
    expect(rosters.map((r) => [r.chatId, r.owner, r.models.map((m) => m.id)]), "…and the new answer reached Convex on its own").toEqual([["c1", "alice", ["a", "b"]]]);
    expect(rosters[0]!.observedAt).toBeGreaterThanOrEqual(metas()[2]!.observedAt as number);
  });
});

describe("the policy disposes itself, whenever the connection ends", () => {
  it("attached to a connection that is ALREADY closed, it disposes at once instead of throwing", () => {
    // The transport calls a close listener immediately when the connection is over, so
    // the policy's own disposal runs while it is still being attached — the Session
    // builds it in its constructor, and a throw there takes the whole session down.
    const { conn } = modelsConnSpy(() => ({}));
    conn.isClosed = true;
    const closedAtOnce = {
      ...conn,
      onClosed(listener: () => void) {
        listener();
        return () => {};
      },
    };
    const { writer } = writerSpy();
    const policy = attachRosterPolicy(
      { connection: closedAtOnce, sessionKey: "k", chatId: "c1", agentId: "alice" },
      writer,
    );
    expect(closedAtOnce.listeners().configChanged, "the notice subscription was released").toBe(0);
    policy.dispose(); // idempotent
  });
});

describe("the session attaches the policy to its connection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("acquire wires onConfigChanged; a notice ends in a publish through the instance's writer", async () => {
    const { conn } = modelsConnSpy(
      answers({
        "sessions.describe": () => ({ session: { key: "k", agentId: "alice" } }),
        "models.list": () => ({ models: [{ id: "openai/gpt-6-astra" }] }),
      }),
    );
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const config = { openclawGatewayUrl: "ws://127.0.0.1:1", openclawToken: "t", deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" } } as unknown as BridgeConfig;
    const { reported, writer } = writerSpy();
    const reg = new SessionRegistry(servedMap(config, writer as never));
    await reg.acquire({ chatId: "c1", openclawChatId: "oc1", agentId: "alice", canonical: "alice" });
    expect(conn.listeners().configChanged, "the session attached the policy").toBe(1);
    conn.emitConfigChanged(NOTICE);
    await sleep(ROSTER_NOTIFY_DEBOUNCE_MS * 2 + 100); // the window is jittered up to 2×
    expect(reported.map(([c, m]) => [c, (m.availableModels as { id: string }[]).map((x) => x.id)])).toEqual([["c1", ["openai/gpt-6-astra"]]]);
    reg.closeAll();
    expect(conn.listeners(), "closing the session disposed the policy through the connection").toEqual({ configChanged: 0, closed: 0 });
  });
});

describe("publishSessionMeta — the ONE publish unit, unconditional", () => {
  const described = { sess: { key: "k", agentId: "alice", thinkingLevel: "low" }, observedAt: 1 };
  it("publishes the describe it was given, stamped as given, with the roster it was given under ITS stamp", async () => {
    const { conn, calls } = modelsConnSpy(() => ({}));
    const { metas, rosters, writer } = writerSpy();
    await publishSessionMeta(session(conn), writer, described, { models: [{ id: "a", label: "a" }], owner: "alice", observedAt: 5 });
    await sleep(2);
    expect(calls, "no describe, no ask: the roster was handed over").toEqual([]);
    expect([metas()[0]!.thinkingLevel, metas()[0]!.observedAt, metas()[0]!.rosterObservedAt, metas()[0]!.availableModelsOwner]).toEqual(["low", 1, 5, "alice"]);
    expect(rosters).toEqual([]);
  });
  it("with nothing in hand (`null`) it publishes WITHOUT the roster field but WITH the owner — Convex keeps a roster for the same owner only; `[]` is published", async () => {
    const { conn } = modelsConnSpy(() => ({}));
    const { metas, writer } = writerSpy();
    await publishSessionMeta(session(conn), writer, described, null);
    await publishSessionMeta(session(conn), writer, described, { models: [], owner: "alice", observedAt: 5 });
    expect([metas()[0]!.availableModels, metas()[0]!.rosterObservedAt, metas()[0]!.availableModelsOwner]).toEqual([undefined, undefined, "alice"]);
    expect(metas()[1]!.availableModels).toEqual([]);
  });
});

