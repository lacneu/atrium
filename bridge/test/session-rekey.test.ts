/**
 * Phase 2: the SessionRegistry derives the gateway session key from the per-turn
 * ROUTED agent + canonical (body), and keeps AT MOST ONE live connection per
 * chatId. A rebind (deleted agent → default = new agentId, or a changed
 * canonical) yields a new key → the stale connection must be CLOSED, not left
 * looping (advisor #2: no connection leak / cross-write).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRegistry, TalkCallActiveError } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { InstanceBundle } from "../src/session.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";

/** Minimal fake connection: never yields a frame; completes only on close.
 *  `framesEnded` flips true once the consumer loop has drained the generator —
 *  i.e. the loop saw `done` and stopped feeding the chat (the no-cross-write
 *  property after a re-key). */
function fakeConn() {
  let closed = false;
  let framesEnded = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    get isClosed() {
      return closed;
    },
    get framesEnded() {
      return framesEnded;
    },
    close() {
      closed = true;
      release();
    },
    // The session subscribes to session events on connect (W2 / G-09): the fake
    // models a connection, so it answers RPCs.
    async request() {
      return { payload: {} };
    },
    // The real connection caches `models.list` per owner here; `ensureAvailableModels`
    // reads it on the send path, inside the rehydration try block.
    modelsByOwner: new Map(),
    rosterEpoch: 0,
    onConfigChanged: () => () => {},
    onClosed: () => () => {},
    async *frames() {
      try {
        await gate;
      } finally {
        framesEnded = true;
      }
    },
  };
}


const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
} as unknown as BridgeConfig;

afterEach(() => vi.restoreAllMocks());

describe("SessionRegistry — body-routed keys + re-key", () => {
  it("builds the session key from the ROUTED agent + canonical (not env)", async () => {
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConn() as never,
    );
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const s = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-b",
      canonical: "alice",
    });
    expect(s.sessionKey).toBe("agent:agent-b:atrium:chat:alice:oc1");
    reg.closeAll();
  });

  it("reuses the SAME session for identical routing", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const r = { chatId: "c1", openclawChatId: "oc1", agentId: "agent-a", canonical: "alice" };
    const a = await reg.acquire(r);
    const b = await reg.acquire(r);
    expect(b).toBe(a);
    expect(connect).toHaveBeenCalledTimes(1);
    reg.closeAll();
  });

  it("RE-KEYS (closes old, connects new) when the agent changes on the same chat", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const first = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-a",
      canonical: "alice",
    });
    const second = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-b", // rebind to a different agent
      canonical: "alice",
    });
    expect(second).not.toBe(first);
    expect(first.connection.isClosed).toBe(true); // stale one closed → no leak
    expect(second.sessionKey).toBe("agent:agent-b:atrium:chat:alice:oc1");
    expect(connect).toHaveBeenCalledTimes(2);
    reg.closeAll();
  });

  it("REFUSES the re-key while a gateway-owned voice call is live on the socket", async () => {
    // Until 2026-09-19 the registry logged this and re-keyed anyway, and the gateway
    // ended the call with the socket. Convex now checks the freeze at every door, but
    // each of those checks is a read taken BEFORE the POST — two concurrent mints, or
    // a call started while the dispatch was still encoding attachments, both slipped
    // through (codex P1, pass 3). This is the one place that decides with the socket
    // in hand, and the only one a client that never asked Convex must also obey.
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const first = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-a",
      canonical: "alice",
    });
    first.holdForVoiceCall("vs-1", 30 * 60_000);
    await expect(
      reg.acquire({
        chatId: "c1",
        openclawChatId: "oc1",
        agentId: "agent-b", // the switch that would cut the call
        canonical: "alice",
      }),
    ).rejects.toThrow(TalkCallActiveError);
    // …and the call's socket is untouched: still open, still the same session.
    expect(first.connection.isClosed).toBe(false);
    expect(connect).toHaveBeenCalledTimes(1);
    reg.closeAll();
  });

  it("a CONSULT extends every live hold — the direct lane's only proof of life", async () => {
    // The relayed lane extends by id when the offer is spent. The DIRECT lane has no
    // such moment: the browser talks to the provider and the bridge never hears about
    // it, so its hold expired after the pending window while the call went on — and a
    // typed turn could then re-key the socket out from under the agent the voice model
    // is consulting (codex P1, pass 12). A consult cannot NAME the call, but it has
    // just proven one is happening.
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConn() as never,
    );
    let now = Math.floor(Date.now() / 1000);
    const reg = new SessionRegistry(servedMap(config, {} as never), () => now);
    const first = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-a",
      canonical: "alice",
    });
    first.holdForVoiceCall("vs-1", 2 * 60_000);
    now += 90; // inside the pending window…
    expect(first.extendLiveVoiceCalls(30 * 60_000)).toBe(1);
    now += 5 * 60; // …and now well past where it WOULD have expired
    await expect(
      reg.acquire({
        chatId: "c1",
        openclawChatId: "oc1",
        agentId: "agent-b",
        canonical: "alice",
      }),
    ).rejects.toThrow(TalkCallActiveError);
    reg.closeAll();
  });

  it("a consult never pushes a call past its OWN ceiling", async () => {
    // The gateway allows two calls per owning socket, and a consult cannot say which
    // one it belongs to. Extending every live hold to "now + 30 min" therefore pushed
    // an unrelated call half an hour past the TTL the gateway armed for it, freezing
    // the chat's agent long after anything was live (codex P2, pass 13). A consult
    // may only prolong WITHIN each hold's own ceiling.
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConn() as never,
    );
    let now = 1_000;
    const reg = new SessionRegistry(servedMap(config, {} as never), () => now);
    const s = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-a",
      canonical: "alice",
    });
    // Call B: held for the full call window, so it is STILL LIVE when the consult
    // lands — that is the whole point, and a hold that had already lapsed would make
    // this test pass whatever the code did.
    s.holdForVoiceCall("vs-b", 30 * 60_000);
    // …a consult 29 minutes later, belonging to some OTHER call on this socket.
    now = 1_000 + 29 * 60;
    expect(s.holdsVoiceCall(now)).toBe(true); // the race really exists
    s.extendLiveVoiceCalls(30 * 60_000);
    // B still dies at ITS ceiling, not 30 minutes from the consult.
    now = 1_000 + 30 * 60 + 1;
    expect(s.holdsVoiceCall(now)).toBe(false);
    reg.closeAll();
  });

  it("a consult on a socket holding NOTHING extends nothing — it cannot create a hold", async () => {
    // Extension may only prolong what exists: minting a hold from a consult would
    // freeze a chat that is not on a call at all.
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConn() as never,
    );
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const s = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-a",
      canonical: "alice",
    });
    expect(s.extendLiveVoiceCalls(30 * 60_000)).toBe(0);
    await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-b",
      canonical: "alice",
    });
    reg.closeAll();
  });

  it("does NOT refuse a caller acquiring the SAME routing during a call", async () => {
    // The refusal is about a RE-KEY, not about a call being up — and six routes
    // acquire during a turn (`/send`, `/patch`, `/reset`, `/compact`,
    // `/subagent-send`, `/talk-session`). Every one of them acquires the CHAT'S OWN
    // routing, which during a call is the call's own agent, so the key matches and
    // the session is REUSED. Pinned because "they all happen to match" is exactly the
    // kind of reasoning that stops being true after one refactor: if the refusal ever
    // widened to any acquire during a call, a delegated sub-agent's send and every
    // settings patch would start failing mid-conversation.
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const routing = {
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-a",
      canonical: "alice",
    };
    const first = await reg.acquire(routing);
    first.holdForVoiceCall("vs-1", 30 * 60_000);
    // The same routing, while the call is live: the SAME session, no throw.
    await expect(reg.acquire(routing)).resolves.toBe(first);
    expect(connect).toHaveBeenCalledTimes(1);
    reg.closeAll();
  });

  it("re-keys normally once the call is released", async () => {
    // The refusal is about a LIVE call, not about the chat having had one: a hangup
    // must not leave the conversation stuck on that agent.
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => fakeConn() as never,
    );
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const first = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-a",
      canonical: "alice",
    });
    first.holdForVoiceCall("vs-1", 30 * 60_000);
    first.releaseVoiceCall("vs-1");
    const second = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-b",
      canonical: "alice",
    });
    expect(second).not.toBe(first);
    expect(first.connection.isClosed).toBe(true);
    reg.closeAll();
  });

  it("stale session's consumer loop TERMINATES after re-key (no cross-write)", async () => {
    const conns: Array<ReturnType<typeof fakeConn>> = [];
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      const c = fakeConn();
      conns.push(c);
      return c as never;
    });
    const reg = new SessionRegistry(servedMap(config, {} as never));
    await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-a",
      canonical: "alice",
    });
    await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-b", // re-key
      canonical: "alice",
    });
    await sleep(10); // let the old consumer observe the closed connection
    const [oldConn, newConn] = conns;
    expect(oldConn!.isClosed).toBe(true);
    // The old loop drained its generator → it can no longer feed the chat under
    // the stale agent's session key (the cross-write the re-key prevents).
    expect(oldConn!.framesEnded).toBe(true);
    expect(newConn!.framesEnded).toBe(false); // the new (live) session keeps reading
    reg.closeAll();
  });

  it("reconnects when the existing connection is closed", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(servedMap(config, {} as never));
    const r = { chatId: "c1", openclawChatId: null, agentId: "agent-a", canonical: "alice" };
    const a = await reg.acquire(r);
    a.connection.close();
    const b = await reg.acquire(r);
    expect(b).not.toBe(a);
    expect(connect).toHaveBeenCalledTimes(2);
    reg.closeAll();
  });

  it("RE-ROUTES (new session, right gateway) when the SAME chat+agent routes to a DIFFERENT instance", async () => {
    // One bridge, two gateways exposing the SAME agent ids -> identical sessionKey.
    // The cached session is bound to instance A's connection; a later turn routing the
    // SAME chat to instance B must NOT reuse it (that would answer from the wrong
    // gateway). Regression guard: WITHOUT the instanceName check in acquire, `b === a`
    // and only gwA is ever connected.
    const urls: string[] = [];
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async (url: string) => {
        urls.push(url);
        return fakeConn() as never;
      },
    );
    const mk = (name: string, url: string): InstanceBundle => ({
      config: { ...config, instanceName: name, openclawGatewayUrl: url },
      writer: {} as never,
      mediaProvider: {} as never,
    });
    const reg = new SessionRegistry(
      new Map<string, InstanceBundle>([
        ["olivier", mk("olivier", "ws://gw-a")],
        ["jerome", mk("jerome", "ws://gw-b")],
      ]),
    );
    const base = { chatId: "c1", openclawChatId: "oc1", agentId: "alice", canonical: "u" };
    const a = await reg.acquire({ ...base, instanceName: "olivier" });
    const b = await reg.acquire({ ...base, instanceName: "jerome" });
    expect(b).not.toBe(a); // re-keyed on the instance change, not reused
    expect(a.connection.isClosed).toBe(true); // stale (wrong-gateway) session closed
    expect(b.instanceName).toBe("jerome");
    expect(urls).toEqual(["ws://gw-a", "ws://gw-b"]); // each routed to its OWN gateway
    reg.closeAll();
  });
});
