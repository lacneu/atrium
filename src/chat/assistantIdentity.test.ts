/// <reference types="vite/client" />
//
// The assistant turn's display name: agent display name when the user has
// multiple agents, else the charte graphique's brand label. The branch is only
// reachable live with multi-agent data, so pin it here.

import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import {
  assistantDisplayName,
  runWaitingLabel,
  DEFAULT_IDENTITY,
  type AssistantIdentity,
} from "./assistantIdentity";

const base: AssistantIdentity = {
  label: "Atrium",
  logoUrl: null,
  logoMasked: false,
  isDefault: true,
  initials: "A",
  agentName: null,
  agentEmoji: null,
};

describe("assistantDisplayName", () => {
  test("uses the responding agent's name when present (multi-agent)", () => {
    expect(assistantDisplayName({ ...base, agentName: "Alice" })).toBe("Alice");
  });

  test("falls back to the brand label when there is no agent (single-agent)", () => {
    expect(assistantDisplayName({ ...base, label: "Ataraxis" })).toBe(
      "Ataraxis",
    );
  });

  test("the agent name wins even when the brand label differs", () => {
    // Avatar follows the charte (label), name follows the agent — they can differ.
    expect(
      assistantDisplayName({ ...base, label: "Ataraxis", agentName: "Bob" }),
    ).toBe("Bob");
  });

  test("the default identity yields the default brand label", () => {
    expect(assistantDisplayName(DEFAULT_IDENTITY)).toBe("Atrium");
  });
});

describe("runWaitingLabel", () => {
  test("uses the 'L'agent {name}' phrasing when an agent is responding", () => {
    const label = runWaitingLabel({ ...base, agentName: "Alice" });
    expect(label).toBe(m.chat_run_taking_longer_agent({ name: "Alice" }));
    expect(label).toContain("Alice");
  });

  test("single-agent fallback uses the brand label WITHOUT the agent prefix", () => {
    // The brand is not an agent, so it must not read "L'agent Atrium".
    const label = runWaitingLabel({ ...base, label: "Atrium", agentName: null });
    expect(label).toBe(m.chat_run_taking_longer({ name: "Atrium" }));
    expect(label).not.toBe(m.chat_run_taking_longer_agent({ name: "Atrium" }));
  });
});
