/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { groupByInstance, filterAgents, type PickableAgent } from "./AgentPicker";

const mk = (
  instanceName: string,
  agentId: string,
  isDefault = false,
  extra: Partial<PickableAgent> = {},
): PickableAgent => ({
  instanceName,
  agentId,
  isDefault,
  displayName: null,
  emoji: null,
  model: null,
  kind: "openclaw",
  state: "ok",
  ...extra,
});

describe("groupByInstance", () => {
  test("groups by instance; the default's instance leads; default agent leads its group", () => {
    const groups = groupByInstance([
      mk("staging", "zeta"),
      mk("prod", "bravo"),
      mk("prod", "alpha", true), // default
    ]);
    expect(groups.map((g) => g.instanceName)).toEqual(["prod", "staging"]);
    expect(groups[0].agents.map((a) => a.agentId)).toEqual(["alpha", "bravo"]);
  });

  test("within a group, non-defaults sort by label", () => {
    const groups = groupByInstance([
      mk("prod", "charlie", false, { displayName: "Charlie" }),
      mk("prod", "alpha", false, { displayName: "Alpha" }),
    ]);
    expect(groups[0].agents.map((a) => a.agentId)).toEqual(["alpha", "charlie"]);
  });
});

describe("filterAgents", () => {
  const agents = [
    mk("prod", "alice", false, { displayName: "Alice", model: "gpt-5.5" }),
    mk("prod", "bob", false, { displayName: "Bob" }),
    mk("staging", "main"),
  ];
  test("empty query returns all", () => {
    expect(filterAgents(agents, "")).toHaveLength(3);
  });
  test("matches displayName / id / instance / model, case-insensitive", () => {
    expect(filterAgents(agents, "ALIC").map((a) => a.agentId)).toEqual([
      "alice",
    ]);
    expect(filterAgents(agents, "staging").map((a) => a.agentId)).toEqual([
      "main",
    ]);
    expect(filterAgents(agents, "gpt").map((a) => a.agentId)).toEqual([
      "alice",
    ]);
  });
  test("no match returns empty", () => {
    expect(filterAgents(agents, "zzz")).toHaveLength(0);
  });
  test("matches the specialty DESCRIPTION (searching a need finds the specialist)", () => {
    const withDesc = [
      ...agents,
      mk("prod", "files", false, {
        displayName: "Fichiers",
        description: "Documents Office : créer, modifier, convertir en PDF.",
      }),
    ];
    expect(filterAgents(withDesc, "convertir").map((a) => a.agentId)).toEqual([
      "files",
    ]);
    expect(filterAgents(withDesc, "OFFICE").map((a) => a.agentId)).toEqual([
      "files",
    ]);
  });
});
