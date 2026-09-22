// The discriminant that tells "a terminal WE could not decode" from "a failure
// Hermes reported" travels beside the payload, through four hops: router →
// registry relay → the turn's pre-ACK buffer → applyEvent.
//
// Two of them dropped it, and the tests stayed green because they wired the router
// straight to the turn. A propagation defect is invisible to any test that skips a
// hop — and a test that calls the SUBSCRIBER's handler proves nothing about the
// relay that feeds it, which is the mistake the first version of this file made.
import { describe, expect, it } from "vitest";
import { HermesTurnRegistry } from "../src/providers/hermes/dispatch.js";
import { routeEventDecision } from "../src/providers/hermes/ws-client.js";

type Relay = (
  type: string,
  sessionId: string,
  payload: Record<string, unknown>,
  synthetic?: "unreadable_terminal",
) => void;

/** The callback `wsClientFor` hands the WS client — the hop under test. */
function clientRelay(reg: HermesTurnRegistry): Relay {
  const client = reg.wsClientFor({
    instanceName: "prod",
    gatewayHttpBase: "http://127.0.0.1:1",
    openclawGatewayUrl: "http://127.0.0.1:1",
    openclawToken: "t",
  } as never);
  const relay = (client as unknown as { onEvent?: Relay }).onEvent;
  if (typeof relay !== "function") {
    throw new Error("the client exposes no onEvent — this test would prove nothing");
  }
  return relay;
}

describe("the registry relays the router's own account of an event", () => {
  it("the relay forwards the synthetic origin to the subscriber", () => {
    const reg = new HermesTurnRegistry();
    const seen: Array<[string, unknown]> = [];
    reg.subscribeWsSession("prod", "sid-1", {
      onEvent: (type, _payload, synthetic) => seen.push([type, synthetic]),
      onTransportLost: () => {},
    });
    const relay = clientRelay(reg);
    const decision = routeEventDecision({
      type: "message.complete",
      session_id: "sid-1",
      payload: null,
    });
    expect(decision?.synthetic).toBe("unreadable_terminal");
    relay(decision!.type, "sid-1", decision!.payload, decision!.synthetic);
    expect(seen).toEqual([["error", "unreadable_terminal"]]);
  });

  it("a genuine provider event relays nothing of ours", () => {
    const reg = new HermesTurnRegistry();
    const seen: unknown[] = [];
    reg.subscribeWsSession("prod", "sid-1", {
      onEvent: (_t, _p, synthetic) => seen.push(synthetic),
      onTransportLost: () => {},
    });
    const relay = clientRelay(reg);
    const decision = routeEventDecision({
      type: "error",
      session_id: "sid-1",
      payload: { message: "upstream model refused" },
    });
    relay(decision!.type, "sid-1", decision!.payload, decision!.synthetic);
    expect(seen).toEqual([undefined]);
  });
});
