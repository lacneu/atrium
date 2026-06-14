import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeOpenClawAgent } from "../src/server.js";

// LIVE-captured OpenClaw 2026.6.1 `agents.list` RPC payload (Spike #0). The RPC
// shape diverges from the CLI: default is a LIST-level `defaultId` (not a per-agent
// flag), display name is `name`/`identity.name`, emoji is `identity.emoji`, model is
// `model.primary`. This fixture pins that the normalizer absorbs it.
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/agents-list-6.1.json", import.meta.url)),
    "utf8",
  ),
) as { defaultId: string; agents: unknown[] };

describe("normalizeOpenClawAgent — live 6.1 RPC shape", () => {
  test("maps name / identity.emoji / model.primary, default via list-level defaultId", () => {
    const agents = fixture.agents.map((a) =>
      normalizeOpenClawAgent(a, fixture.defaultId),
    );
    const agentA = agents.find((a) => a?.agentId === "agent-a")!;
    expect(agentA).not.toBeNull();
    expect(agentA.displayName).toBe("Agent A");
    expect(agentA.model).toBe("openai/gpt-5.5");
    expect(agentA.isDefaultOnInstance).toBe(true); // via defaultId, not a per-agent flag

    const agentB = agents.find((a) => a?.agentId === "agent-b")!;
    expect(agentB.emoji).toBe("⚔️"); // identity.emoji
    expect(agentB.model).toBe("openai/gpt-5.5");
    expect(agentB.isDefaultOnInstance).toBe(false);
  });

  test("CLI shape still works (id / identityName / model string / per-agent isDefault)", () => {
    const a = normalizeOpenClawAgent({
      id: "x",
      identityName: "X",
      identityEmoji: "🛠️",
      model: "gpt-5.5",
      isDefault: true,
    });
    expect(a?.agentId).toBe("x");
    expect(a?.displayName).toBe("X");
    expect(a?.emoji).toBe("🛠️");
    expect(a?.model).toBe("gpt-5.5");
    expect(a?.isDefaultOnInstance).toBe(true);
  });

  test("idless / shapeless entry → null", () => {
    expect(normalizeOpenClawAgent({})).toBeNull();
    expect(normalizeOpenClawAgent(null)).toBeNull();
    expect(normalizeOpenClawAgent("nope")).toBeNull();
  });
});
