/**
 * Unit tests for the SubAgentObserver — the persistent, chat-level registry that
 * records the sub-agents a chat's agent spawns (sessions_spawn). Driven by the
 * REAL captured 2026.6.5 frames (test/fixtures/subagent_frames.jsonl), so the
 * parsing + lifecycle are proven against ground truth, not a hand-made mock.
 *
 * Covers the mandatory guarantees:
 *   - register on the parent's sessions_spawn tool result (running + childKey + task)
 *   - child lifecycle phase -> running + phase
 *   - child chat:final -> done + resultText, observation REAPED (FD-leak guardrail 1)
 *   - TTL sweep reaps a stalled observation (guardrail 2)
 *   - max-concurrent cap bounds the registry (guardrail 3)
 *   - a child of ANOTHER chat (different spawnedBy) is NEVER observed (contamination)
 *   - resultText has server-paths stripped (SOC2)
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SubAgentObserver,
  extractTaskName,
} from "../src/providers/openclaw/sub-agent-observer.js";

// --- load the real captured frames -------------------------------------------
const FIXTURE = readFileSync(
  new URL("./fixtures/subagent_frames.jsonl", import.meta.url),
  "utf-8",
);
const FRAMES = FIXTURE.split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"))
  .map((l) => JSON.parse(l) as Record<string, any>);

const PARENT1 = "agent:alice:webchat:chat:olivier:subagentcap1782588406379";
const PARENT2 = "agent:alice:webchat:chat:olivier:subagentcap1782589051772";
const CHILD1 = "agent:alice:subagent:50a9857b-5b2f-40ce-867d-2e20d2e2b737";
const CHILD2 = "agent:alice:subagent:b50901b0-2f75-45c4-8ffc-47db32472afb";

const find = (pred: (f: Record<string, any>) => boolean): Record<string, any> => {
  const f = FRAMES.find(pred);
  if (!f) throw new Error("fixture frame not found");
  return f;
};

const SPAWN_RESULT_1 = find((f) => f.payload?.data?.name === "sessions_spawn");
const CHILD_STARTUP_1 = find(
  (f) =>
    f.payload?.sessionKey === CHILD1 &&
    typeof f.payload?.stream === "string" &&
    f.payload.stream.endsWith("lifecycle") &&
    f.payload?.data?.phase === "startup",
);
const CHILD_FINAL_1 = find(
  (f) => f.event === "chat" && f.payload?.sessionKey === CHILD1 && f.payload?.state === "final",
);
const CHILD_FINAL_2 = find(
  (f) => f.event === "chat" && f.payload?.sessionKey === CHILD2 && f.payload?.state === "final",
);
const PARENT_FINAL_2 = find(
  (f) =>
    f.event === "chat" &&
    f.payload?.sessionKey === PARENT2 &&
    f.payload?.state === "final" &&
    f.payload?.spawnedBy === undefined,
);

describe("SubAgentObserver — registration & lifecycle (real frames)", () => {
  it("registers on the parent's sessions_spawn tool result (running + childKey + task)", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    const out = obs.observe(SPAWN_RESULT_1, 1000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      chatId: "chatA",
      childSessionKey: CHILD1,
      status: "running",
      taskName: "Reply with exactly the token SUBAGENT_PONG_42 and nothing else.",
    });
    expect(obs.size).toBe(1);
  });

  it("ignores the spawn-result isError/success:false flag (codex quirk) and still registers", () => {
    // The captured spawn result is flagged isError:true / success:false yet the
    // child DID run — registration must key on childSessionKey presence, not the flag.
    expect(SPAWN_RESULT_1.payload.data.isError).toBe(true);
    const obs = new SubAgentObserver(PARENT1, "chatA");
    expect(obs.observe(SPAWN_RESULT_1, 1000)).toHaveLength(1);
  });

  it("child lifecycle phase -> running + phase", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    obs.observe(SPAWN_RESULT_1, 1000);
    const out = obs.observe(CHILD_STARTUP_1, 1001);
    expect(out).toEqual([
      { chatId: "chatA", parentMessageId: null, childSessionKey: CHILD1, status: "running", phase: "startup" },
    ]);
  });

  it("child chat:final -> done + resultText, and the observation is REAPED", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    obs.observe(SPAWN_RESULT_1, 1000);
    expect(obs.size).toBe(1);
    const out = obs.observe(CHILD_FINAL_1, 1002);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "done", resultText: "SUBAGENT_PONG_42", childSessionKey: CHILD1 });
    // Guardrail 1: final-reap removed it from the registry.
    expect(obs.size).toBe(0);
  });

  it("result-DEPENDENT run: child final carries the child's answer (ZULU_DELTA_777)", () => {
    const obs = new SubAgentObserver(PARENT2, "chatB");
    const out = obs.observe(CHILD_FINAL_2, 2000);
    expect(out[0]).toMatchObject({ status: "done", resultText: "ZULU_DELTA_777" });
    expect(obs.size).toBe(0);
  });

  it("a child frame works even with NO prior spawn registration (lazy admission)", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    // Only the child final is seen (the spawn result was missed).
    const out = obs.observe(CHILD_FINAL_1, 1000);
    expect(out[0]).toMatchObject({ status: "done", resultText: "SUBAGENT_PONG_42" });
  });
});

describe("SubAgentObserver — contamination isolation", () => {
  it("a child of ANOTHER chat (different spawnedBy) is NEVER observed", () => {
    // Observer is for PARENT2/chatB; run-1's child frames carry spawnedBy=PARENT1.
    const obs = new SubAgentObserver(PARENT2, "chatB");
    expect(obs.observe(CHILD_STARTUP_1, 1000)).toEqual([]);
    expect(obs.observe(CHILD_FINAL_1, 1001)).toEqual([]);
    expect(obs.size).toBe(0);
  });

  it("another chat's parent-lane final is not mistaken for a child frame", () => {
    // PARENT_FINAL_2 is a PARENT-lane final (no spawnedBy); an observer for PARENT1
    // must ignore it entirely.
    const obs = new SubAgentObserver(PARENT1, "chatA");
    expect(obs.observe(PARENT_FINAL_2, 1000)).toEqual([]);
    expect(obs.size).toBe(0);
  });

  it("a frame whose child key IS the parent key is never registered (defense-in-depth)", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    const selfFrame = {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: PARENT1, // == parent lane
        spawnedBy: PARENT1, // malformed: parent claims to be its own child
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "X" }] },
      },
    };
    expect(obs.observe(selfFrame, 1000)).toEqual([]);
    expect(obs.size).toBe(0);
  });

  it("another chat's spawn result is not registered here", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    // run-2's spawn would be on PARENT2's lane — synthesize from the real shape.
    const foreignSpawn = {
      type: "event",
      event: "agent",
      payload: {
        sessionKey: PARENT2,
        stream: "tool",
        data: {
          phase: "result",
          name: "sessions_spawn",
          meta: "task X, agent alice",
          result: { contentItems: [{ text: JSON.stringify({ childSessionKey: CHILD2 }) }] },
        },
      },
    };
    expect(obs.observe(foreignSpawn, 1000)).toEqual([]);
    expect(obs.size).toBe(0);
  });
});

describe("SubAgentObserver — FD-leak guardrails", () => {
  it("TTL sweep reaps a stalled RUNNING child with a VISIBLE timed-out status (Bug C silent-hang)", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA", { ttlSeconds: 10 });
    obs.observe(SPAWN_RESULT_1, 1000);
    expect(obs.size).toBe(1);
    expect(obs.nextTimeout(1000)).toBe(10);
    expect(obs.sweep(1005)).toEqual([]); // not yet stalled -> no terminal upsert
    expect(obs.size).toBe(1);
    // Past TTL: reaped AND a visible terminal status is emitted (NOT left running) so the
    // user SEES the sub-agent stopped responding while the parent waits.
    const swept = obs.sweep(1011);
    expect(swept).toHaveLength(1);
    expect(swept[0]!.status).toBe("error");
    expect(swept[0]!.errorMessage).toMatch(/timed out/i);
    expect(obs.size).toBe(0);
  });

  it("a child frame resets the TTL clock (keep-alive)", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA", { ttlSeconds: 10 });
    obs.observe(SPAWN_RESULT_1, 1000);
    obs.observe(CHILD_STARTUP_1, 1009); // refreshes lastFrameAt to 1009
    expect(obs.sweep(1011)).toEqual([]); // 1011 - 1009 = 2 < 10 -> still alive, no upsert
    expect(obs.size).toBe(1);
  });

  it("max-concurrent cap bounds the registry; excess children are refused", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA", { maxConcurrent: 2 });
    const childFrame = (key: string) => ({
      type: "event",
      event: "agent",
      payload: {
        sessionKey: key,
        spawnedBy: PARENT1,
        stream: "codex_app_server.lifecycle",
        data: { phase: "startup" },
      },
    });
    expect(obs.observe(childFrame("agent:alice:subagent:c1"), 1000)).toHaveLength(1);
    expect(obs.observe(childFrame("agent:alice:subagent:c2"), 1000)).toHaveLength(1);
    // Third exceeds the cap -> refused (no upsert), registry stays at 2.
    expect(obs.observe(childFrame("agent:alice:subagent:c3"), 1000)).toEqual([]);
    expect(obs.size).toBe(2);
  });

  it("clear() drops all observations (connection close)", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    obs.observe(SPAWN_RESULT_1, 1000);
    expect(obs.size).toBe(1);
    obs.clear();
    expect(obs.size).toBe(0);
    expect(obs.nextTimeout(1000)).toBeNull();
  });

  it("a stray frame for an already-reaped child does not resurrect it", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    obs.observe(SPAWN_RESULT_1, 1000);
    obs.observe(CHILD_FINAL_1, 1001); // done -> reaped
    expect(obs.size).toBe(0);
    // A late duplicate child frame must NOT re-create the observation.
    expect(obs.observe(CHILD_STARTUP_1, 1002)).toEqual([]);
    expect(obs.size).toBe(0);
  });
});

describe("SubAgentObserver — result sanitization (SOC2)", () => {
  it("strips server paths / MEDIA: directives from resultText", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    const childFinalWithPath = {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: CHILD1,
        spawnedBy: PARENT1,
        state: "final",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Here is the file\nMEDIA:/home/node/.openclaw/media/outbound/secret-report.pdf",
            },
          ],
        },
      },
    };
    const out = obs.observe(childFinalWithPath, 1000);
    expect(out[0]!.resultText).toBe("Here is the file");
    expect(out[0]!.resultText).not.toContain("/home/node");
  });
});

describe("extractTaskName (labeled vs plain spawn meta)", () => {
  it("plain meta: returns the task text (greedy past a comma in the task)", () => {
    expect(extractTaskName("task latest_ai_news_today, agent alice")).toBe(
      "latest_ai_news_today",
    );
    expect(extractTaskName("task do a, b and c, agent alice")).toBe("do a, b and c");
  });
  it("LABELED meta: prefers the short label over the task (codex P3 — the error fixture's form)", () => {
    expect(
      extractTaskName("label timeout_child, task block on sleep 600, agent alice"),
    ).toBe("timeout_child");
  });
  it("returns undefined for null / unrecognized meta", () => {
    expect(extractTaskName(null)).toBeUndefined();
    expect(extractTaskName("nonsense")).toBeUndefined();
  });
});
