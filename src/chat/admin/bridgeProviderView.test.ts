/// <reference types="vite/client" />
//
// The Bridge tab's provider grouping. typecheck + build never run it and the tab
// needs live admin + bridge data to reach, so pin the bucketing: connection →
// provider derivation, present-provider detection (no empty cards), ordering.

import { describe, expect, test } from "vitest";
import {
  groupBridgeByProvider,
  providerLabel,
  DEFAULT_PROVIDER,
} from "./bridgeProviderView";

const instances = [
  { name: "primary", kind: "openclaw" as const },
  { name: "hermes-1", kind: "hermes" as const },
  { name: "legacy", kind: undefined }, // no kind → defaults to openclaw
];
const targets = [
  { instanceName: "primary", id: "c1" },
  { instanceName: "hermes-1", id: "c2" },
  { instanceName: "legacy", id: "c3" },
  { instanceName: null, id: "c4" }, // unknown instance → defaults to openclaw
];
const compatTargets = [
  { instanceName: "primary", provider: "openclaw" },
  { instanceName: "hermes-1", provider: "hermes" },
];

describe("groupBridgeByProvider", () => {
  test("buckets connections to their instance's provider (incl. defaults)", () => {
    const g = groupBridgeByProvider(targets, compatTargets, instances);
    const oc = g.find((b) => b.key === "openclaw")!;
    const he = g.find((b) => b.key === "hermes")!;
    // openclaw gets primary + legacy(no-kind) + null-instance connection
    expect(oc.connections.map((c) => c.id).sort()).toEqual(["c1", "c3", "c4"]);
    expect(he.connections.map((c) => c.id)).toEqual(["c2"]);
  });

  test("OpenClaw is ordered first, others alphabetical", () => {
    const g = groupBridgeByProvider(
      [],
      [
        { instanceName: "z", provider: "zeta" },
        { instanceName: "h", provider: "hermes" },
        { instanceName: "p", provider: "openclaw" },
      ],
      [],
    );
    expect(g.map((b) => b.key)).toEqual(["openclaw", "hermes", "zeta"]);
  });

  test("a provider with only a compat target still gets a card (announced)", () => {
    const g = groupBridgeByProvider([], compatTargets, []);
    expect(g.map((b) => b.key).sort()).toEqual(["hermes", "openclaw"]);
    expect(g.find((b) => b.key === "hermes")!.compatTargets).toHaveLength(1);
  });

  test("no providers at all → no cards (only the global status would show)", () => {
    expect(groupBridgeByProvider([], [], [])).toEqual([]);
  });

  test("each bucket carries only its own instances", () => {
    const g = groupBridgeByProvider([], [], instances);
    expect(g.find((b) => b.key === "openclaw")!.instances.map((i) => i.name).sort())
      .toEqual(["legacy", "primary"]);
    expect(g.find((b) => b.key === "hermes")!.instances.map((i) => i.name)).toEqual([
      "hermes-1",
    ]);
  });
});

describe("providerLabel", () => {
  test("title-cases known + unknown providers", () => {
    expect(providerLabel("openclaw")).toBe("OpenClaw");
    expect(providerLabel("hermes")).toBe("Hermes");
    expect(providerLabel("acme")).toBe("Acme");
  });
  test("DEFAULT_PROVIDER is openclaw", () => {
    expect(DEFAULT_PROVIDER).toBe("openclaw");
  });
});
