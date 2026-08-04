/**
 * The discovery poll must READ the surface Hermes publishes, ON THE PATH PRODUCTION USES
 * (G-70, Hermes half).
 *
 * Two review findings live in this file, and they are the same mistake twice:
 *
 *  * pass 6 — `client.capabilities()` existed and NOTHING called it. A definition is not
 *    a consumption.
 *  * pass 7 — the fix called it on the REST branch only. Hermes defaults to WS, and that
 *    branch returns before the call, so no real deployment would ever have produced the
 *    observation. The first version of this test passed because it forced
 *    `transport: "rest"` — it exercised the path the fix happened to touch instead of the
 *    path a user gets, which is how lot 48 shipped a feature that ran only in its tests.
 *
 * So the probe now runs BEFORE the transport fork, and both branches are covered here.
 * It is also FIRE AND FORGET: `HermesClient.json()` waits 15 s, and a diagnostic may not
 * add that to a poll an operator is waiting on. `capabilityProbeSettled()` is the seam
 * that lets a test await what production deliberately does not.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  capabilityProbeSettled,
  discoverHermesAgents,
  HermesTurnRegistry,
  resetCapabilityProbesForTests,
} from "../src/providers/hermes/dispatch.js";
import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";
import * as client from "../src/providers/hermes/client.js";
import type { BridgeConfig } from "../src/config.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";

const CAP = "«unanticipated-capability».";
const announced = (): string[] =>
  protocolDrift
    .report()
    .filter((e) => e.shape.startsWith(CAP))
    .map((e) => e.shape.slice(CAP.length));

beforeEach(() => {
  protocolDrift.resetForTests();
  resetCapabilityProbesForTests();
  vi.restoreAllMocks();
});

const cfgFor = (transport: "ws" | "rest"): BridgeConfig =>
  ({
    transport,
    instanceName: "hermes",
    gatewayHttpBase: "http://127.0.0.1:1",
    openclawGatewayUrl: "http://127.0.0.1:1",
    openclawToken: "t",
  }) as unknown as BridgeConfig;

/** A REST client whose `capabilities()` answers with `caps`. */
function stubRest(caps: unknown, hang = false): void {
  // A CONSTRUCTIBLE stub: `hermesClientFor` calls `new HermesClient(...)`, and an
  // arrow function throws "is not a constructor" there — which took the whole
  // suite down rather than failing one assertion.
  vi.spyOn(client, "HermesClient").mockImplementation(
    function () {
      return ({
        models: async () => ({ data: [{ id: "m1" }] }),
        health: async () => ({ version: "0.19.0" }),
        capabilities: hang
          ? () => new Promise(() => {}) // never settles
          : async () => caps,
      }) as unknown as client.HermesClient;
    } as never,
  );
}

/** A WS registry whose `model.options` answers, like the default transport. */
class WsReg extends HermesTurnRegistry {
  override wsClientFor(): HermesWsClient {
    return {
      call: async () => ({ providers: [{ id: "p", models: [{ id: "m1" }] }] }),
    } as unknown as HermesWsClient;
  }
}

describe("the probe runs on the transport a real deployment uses", () => {
  it("WS (the DEFAULT) reaches the ledger", async () => {
    stubRest({ features: { session_chat: true, brand_new_thing: true } });
    await discoverHermesAgents(cfgFor("ws"), new WsReg());
    await capabilityProbeSettled();
    expect(
      announced(),
      "the default transport returns EARLY — the probe must run before that fork",
    ).toEqual(["brand_new_thing"]);
  });

  it("REST reaches it too", async () => {
    stubRest({ features: { brand_new_thing: true } });
    await discoverHermesAgents(cfgFor("rest"));
    await capabilityProbeSettled();
    expect(announced()).toEqual(["brand_new_thing"]);
  });

  it("a classified capability is silent on both", async () => {
    stubRest({ features: { session_chat: true, cors: true } });
    await discoverHermesAgents(cfgFor("ws"), new WsReg());
    await capabilityProbeSettled();
    expect(announced()).toEqual([]);
  });
});

describe("the probe can never cost the poll anything", () => {
  it("a capabilities endpoint that HANGS does not delay the agent list", async () => {
    // The `.catch()` covered a fast rejection and nothing else: awaiting the probe meant
    // a route that pends cost every poll the client's full 15 s timeout (pass 7).
    stubRest(null, true);
    const got = await discoverHermesAgents(cfgFor("rest"));
    expect(got.agents, "the list must return while the probe is still in flight").toHaveLength(1);
  });

  it("an endpoint that FAILS leaves the ledger untouched", async () => {
    // Constructible, same reason as `stubRest` above.
    vi.spyOn(client, "HermesClient").mockImplementation(
      function () {
        return ({
          models: async () => ({ data: [{ id: "m1" }] }),
          health: async () => ({ version: "0.19.0" }),
          capabilities: async () => {
            throw new Error("no such route");
          },
        }) as unknown as client.HermesClient;
      } as never,
    );
    const got = await discoverHermesAgents(cfgFor("rest"));
    await capabilityProbeSettled();
    expect(got.agents).toHaveLength(1);
    expect(announced()).toEqual([]);
  });
});
