/// <reference types="vitest" />
//
// A DEAD SOCKET is not a delivered failure (lot 31).
//
// When the bridge→Hermes WebSocket dies, the registry settles every turn subscribed on
// it. It used to do that by injecting a synthetic `error` EVENT into the turn's own event
// lane — the branch that means "Hermes told us the run failed". So the turn finalized
// while keeping its stored session, and the run may well have carried on with its tools
// on the far side of the connection that just died. There is not even a
// `session.interrupt` available here: the socket it would travel on is the one that died.
//
// This test drives the REGISTRY'S REAL `onClose`, not the turn's callback: a test that
// calls `onTransportLost` directly stays green when the wiring reverts to an injected
// event, which is exactly the shape of proof this program has already paid for twice.

import { describe, expect, it, vi } from "vitest";

/** Capture the options the registry hands the WS client, so the test can fire the REAL
 *  `onClose` the registry installed. */
const constructed: Array<{ onClose?: (reason: string) => void }> = [];
vi.mock("../src/providers/hermes/ws-client.js", () => ({
  HermesWsClient: class {
    constructor(opts: { onClose?: (reason: string) => void }) {
      constructed.push(opts);
    }
  },
}));

const { HermesTurnRegistry } = await import("../src/providers/hermes/dispatch.js");

describe("the registry's socket-close fan-out", () => {
  it("tells each subscribed turn its TRANSPORT was lost, not that Hermes errored", () => {
    constructed.length = 0;
    const reg = new HermesTurnRegistry();
    reg.wsClientFor({
      instanceName: "inst-a",
      gatewayHttpBase: "http://x",
      openclawToken: "t",
    } as never);
    const events: Array<[string, unknown]> = [];
    const lost: string[] = [];
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: (type, payload) => events.push([type, payload]),
      onTransportLost: (reason) => lost.push(reason),
    });

    const onClose = constructed[0]?.onClose;
    expect(onClose, "the registry must install an onClose").toBeTypeOf("function");
    onClose?.("socket closed");

    expect(lost).toHaveLength(1);
    // …and NOTHING went down the event lane. An `error` event there is a DELIVERED
    // gateway failure, and a turn taking that exit keeps its stored session.
    expect(events).toEqual([]);
  });

  it("leaves OTHER instances' turns alone", () => {
    constructed.length = 0;
    const reg = new HermesTurnRegistry();
    reg.wsClientFor({ instanceName: "inst-a", gatewayHttpBase: "http://x" } as never);
    reg.wsClientFor({ instanceName: "inst-b", gatewayHttpBase: "http://y" } as never);
    const lostA: string[] = [];
    const lostB: string[] = [];
    reg.subscribeWsSession("inst-a", "sid-1", {
      onEvent: () => {},
      onTransportLost: (r) => lostA.push(r),
    });
    reg.subscribeWsSession("inst-b", "sid-1", {
      onEvent: () => {},
      onTransportLost: (r) => lostB.push(r),
    });

    constructed[0]?.onClose?.("socket closed");
    expect(lostA).toHaveLength(1);
    expect(lostB).toEqual([]);
  });
});
