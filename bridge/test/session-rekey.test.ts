/**
 * Phase 2: the SessionRegistry derives the gateway session key from the per-turn
 * ROUTED agent + canonical (body), and keeps AT MOST ONE live connection per
 * chatId. A rebind (deleted agent → default = new agentId, or a changed
 * canonical) yields a new key → the stale connection must be CLOSED, not left
 * looping (advisor #2: no connection leak / cross-write).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
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
    async *frames() {
      try {
        await gate;
      } finally {
        framesEnded = true;
      }
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

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
    const reg = new SessionRegistry(config, {} as never);
    const s = await reg.acquire({
      chatId: "c1",
      openclawChatId: "oc1",
      agentId: "agent-b",
      canonical: "alice",
    });
    expect(s.sessionKey).toBe("agent:agent-b:webchat:chat:alice:oc1");
    reg.closeAll();
  });

  it("reuses the SAME session for identical routing", async () => {
    const connect = vi
      .spyOn(OpenClawConnection, "connect")
      .mockImplementation(async () => fakeConn() as never);
    const reg = new SessionRegistry(config, {} as never);
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
    const reg = new SessionRegistry(config, {} as never);
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
    expect(second.sessionKey).toBe("agent:agent-b:webchat:chat:alice:oc1");
    expect(connect).toHaveBeenCalledTimes(2);
    reg.closeAll();
  });

  it("stale session's consumer loop TERMINATES after re-key (no cross-write)", async () => {
    const conns: Array<ReturnType<typeof fakeConn>> = [];
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => {
      const c = fakeConn();
      conns.push(c);
      return c as never;
    });
    const reg = new SessionRegistry(config, {} as never);
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
    await tick(); // let the old consumer observe the closed connection
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
    const reg = new SessionRegistry(config, {} as never);
    const r = { chatId: "c1", openclawChatId: null, agentId: "agent-a", canonical: "alice" };
    const a = await reg.acquire(r);
    a.connection.close();
    const b = await reg.acquire(r);
    expect(b).not.toBe(a);
    expect(connect).toHaveBeenCalledTimes(2);
    reg.closeAll();
  });
});
