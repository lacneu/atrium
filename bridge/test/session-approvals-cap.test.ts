// A conversation's socket declares `approvals` — the client capability that makes the
// gateway ROUTE approvals to it (server-request-context.ts canDeliverApprovals) —
// exactly where Atrium shows them (AGENT_REQUESTS_MIN_VERSION). The version is known
// only after the handshake; before it, a version is trusted only while a LIVE socket to
// the instance proves it (a version change means a gateway restart, which closes them
// all), so a downgrade can never be hidden behind a remembered version.
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import { servedMap } from "./helpers/served.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { trustedGatewayVersion } from "../src/providers/openclaw/gateway-version-hint.js";

function fakeConn(gatewayVersion: string | null) {
  let closed = false;
  let release: () => void = () => {};
  const closedListeners: Array<() => void> = [];
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    gatewayVersion,
    get isClosed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      release();
      for (const l of closedListeners) l();
    },
    async request() {
      return { payload: {} };
    },
    modelsByOwner: new Map(),
    rosterEpoch: 0,
    onConfigChanged: () => () => {},
    onClosed: (l: () => void) => {
      closedListeners.push(l);
      return () => {};
    },
    async *frames() {
      await gate;
    },
  };
}

const cfg = (instanceName: string): BridgeConfig =>
  ({
    openclawGatewayUrl: `ws://${instanceName}/ws`,
    openclawToken: "t",
    deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    instanceName,
  }) as unknown as BridgeConfig;

/** The caps each successive connect declared, and the sockets it returned. */
function recordConnects(version: () => string | null) {
  const declared: string[][] = [];
  const sockets: Array<ReturnType<typeof fakeConn>> = [];
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(async (...args: unknown[]) => {
    declared.push([...((args[7] as string[] | undefined) ?? [])]);
    const conn = fakeConn(version());
    sockets.push(conn);
    return conn as never;
  });
  return { declared, sockets };
}

const acquire = (reg: SessionRegistry, instanceName: string, chatId: string) =>
  reg.acquire({ chatId, openclawChatId: `oc-${chatId}`, agentId: "main", canonical: "alice", instanceName });

afterEach(() => vi.restoreAllMocks());

describe("the approvals reviewer capability", () => {
  it("first session: learned from the handshake, the socket is re-opened ONCE with it", async () => {
    const { declared, sockets } = recordConnects(() => "2026.9.5");
    const reg = new SessionRegistry(servedMap(cfg("boot-a")));
    await acquire(reg, "boot-a", "c1");
    expect(declared).toEqual([[], ["approvals"]]);
    expect(sockets[0]!.isClosed).toBe(true);
    // While that socket lives, the version it proves is trusted: the next conversation
    // connects right the first time.
    expect(trustedGatewayVersion("boot-a")).toBe("2026.9.5");
    await acquire(reg, "boot-a", "c2");
    expect(declared.slice(2)).toEqual([["approvals"]]);
    reg.closeAll();
  });

  it("below the floor it is never declared — an approval must not wait for a card nobody shows", async () => {
    const { declared } = recordConnects(() => "2026.9.4");
    const reg = new SessionRegistry(servedMap(cfg("old-b")));
    await acquire(reg, "old-b", "c1");
    expect(declared).toEqual([[]]);
    reg.closeAll();
  });

  it("a restart onto an older version BETWEEN two handshakes is caught by the second one", async () => {
    // 9.5 on the first handshake, 9.4 on the re-open: the capability must not survive.
    const versions = ["2026.9.5", "2026.9.4", "2026.9.4"];
    let n = 0;
    const { declared, sockets } = recordConnects(() => versions[Math.min(n++, versions.length - 1)]!);
    const reg = new SessionRegistry(servedMap(cfg("flip-d")));
    await acquire(reg, "flip-d", "c1");
    expect(declared).toEqual([[], ["approvals"], []]);
    expect(sockets.at(-1)!.isClosed).toBe(false);
    reg.closeAll();
  });

  it("a gateway that keeps flipping ends on the SAFE side: nothing announced", async () => {
    let n = 0;
    const { declared } = recordConnects(() => (n++ % 2 === 0 ? "2026.9.5" : "2026.9.4"));
    const reg = new SessionRegistry(servedMap(cfg("flap-e")));
    await acquire(reg, "flap-e", "c1");
    expect(declared.at(-1)).toEqual([]);
    reg.closeAll();
  });

  it("once every socket closed (a gateway restart), nothing is trusted — a downgrade cannot hide", async () => {
    let version = "2026.9.5";
    const { declared, sockets } = recordConnects(() => version);
    const reg = new SessionRegistry(servedMap(cfg("down-c")));
    await acquire(reg, "down-c", "c1");
    expect(trustedGatewayVersion("down-c")).toBe("2026.9.5");
    // The gateway restarts on an older version: every socket to it closes.
    for (const s of sockets) s.close();
    expect(trustedGatewayVersion("down-c")).toBeNull();
    version = "2026.9.4";
    await acquire(reg, "down-c", "c2");
    // Opened WITHOUT the capability — never announced to a gateway that would route
    // approvals to a socket Atrium does not observe them on.
    expect(declared.slice(2)).toEqual([[]]);
    reg.closeAll();
  });
});
