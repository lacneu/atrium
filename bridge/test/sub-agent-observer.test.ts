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

const PARENT1 = "agent:alice:atrium:chat:olivier:subagentcap1782588406379";
const PARENT2 = "agent:alice:atrium:chat:olivier:subagentcap1782589051772";
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

// --- the captured ERROR run (lifecycle:error THEN chat:error) -----------------
// Ground truth for the round-7 terminalization-ordering fix: in this capture the
// child's `lifecycle:error` frame arrives BEFORE its authoritative `chat:error`.
const ERROR_FRAMES = readFileSync(
  new URL("./fixtures/subagent_frames_error.jsonl", import.meta.url),
  "utf-8",
)
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"))
  .map((l) => JSON.parse(l) as Record<string, any>);
const ERR_PARENT = "agent:alice:atrium:chat:olivier:subagentcap1782608531897";
const ERR_CHILD = "agent:alice:subagent:49f9a3fd-5ffd-4779-b1ed-5e24040dd946";
const findErr = (pred: (f: Record<string, any>) => boolean): Record<string, any> => {
  const f = ERROR_FRAMES.find(pred);
  if (!f) throw new Error("error fixture frame not found");
  return f;
};
const ERR_LIFECYCLE_ERROR = findErr(
  (f) =>
    f.payload?.sessionKey === ERR_CHILD &&
    typeof f.payload?.stream === "string" &&
    f.payload.stream.endsWith("lifecycle") &&
    f.payload?.data?.phase === "error",
);
const ERR_CHAT_ERROR = findErr(
  (f) => f.event === "chat" && f.payload?.sessionKey === ERR_CHILD && f.payload?.state === "error",
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

describe("SubAgentObserver — keep-alive heartbeat (anti false-reap, P1.1)", () => {
  // A non-terminal child chat delta = a keep-alive frame (no status/lifecycle change).
  const childDelta = (now: unknown) => ({
    type: "event",
    event: "chat",
    payload: {
      sessionKey: CHILD1,
      spawnedBy: PARENT1,
      state: "streaming", // NOT a terminal state
      message: { role: "assistant", content: [{ type: "text", text: "thinking…" }] },
    },
    _t: now, // unused; documents the frame is the same shape across ticks
  });

  it("emits a THROTTLED running heartbeat on keep-alive frames (≤ once per window), bumping updatedAt without a phase", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    obs.observe(SPAWN_RESULT_1, 1000); // register: running, lastUpsertAt = 1000s
    // Within the 5-min (300s) window: keep-alive frames do NOT upsert (no churn).
    expect(obs.observe(childDelta(1100), 1100)).toEqual([]); // +100s
    expect(obs.observe(childDelta(1299), 1299)).toEqual([]); // +299s
    // At the window boundary: ONE running heartbeat (refreshes the Convex updatedAt).
    const hb = obs.observe(childDelta(1300), 1300); // +300s
    expect(hb).toHaveLength(1);
    expect(hb[0]).toMatchObject({ childSessionKey: CHILD1, status: "running" });
    expect(hb[0]!.phase).toBeUndefined(); // pure heartbeat — never changes status/phase
    // Throttle resets from the heartbeat: the next window is silent again, then fires.
    expect(obs.observe(childDelta(1450), 1450)).toEqual([]); // +150s since hb
    expect(obs.observe(childDelta(1600), 1600)).toHaveLength(1); // +300s since hb
  });

  it("emits a heartbeat each ~5 min across a 20-min span (cadence that keeps updatedAt fresh)", () => {
    // This proves the heartbeat CADENCE; the reaper-skip half (a fresh updatedAt is
    // not reaped) lives in the Convex `reaper does NOT touch a FRESH running row` test.
    const obs = new SubAgentObserver(PARENT1, "chatA");
    obs.observe(SPAWN_RESULT_1, 0); // T0
    // A child that only streams deltas for 20 min still emits a heartbeat each window.
    let beats = 0;
    for (let t = 60; t <= 20 * 60; t += 60) {
      // one keep-alive per minute
      if (obs.observe(childDelta(t), t).length > 0) beats++;
    }
    // ~4 heartbeats over 20 min (at 300/600/900/1200s) — each refreshes updatedAt well
    // inside the 20-min reaper TTL, so the live child is never marked stale.
    expect(beats).toBeGreaterThanOrEqual(3);
    expect(obs.size).toBe(1); // still tracked, never reaped
  });

  it("does NOT heartbeat once the child is REAPED (chat:final → terminal → no resurrection)", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    obs.observe(SPAWN_RESULT_1, 1000);
    obs.observe(CHILD_FINAL_1, 1001); // chat:final → done → reaped
    expect(obs.size).toBe(0);
    // A keep-alive long after the window: NO heartbeat (the child is gone/recentlyFinal).
    expect(obs.observe(childDelta(2000), 2000)).toEqual([]);
  });
});

describe("SubAgentObserver — a lifecycle phase is NEVER a terminal (round-7 P1)", () => {
  // The held send queue must release ONLY when the child is TRULY done — its
  // chat:final/chat:error frame — never on the earlier lifecycle:end/error phase
  // (which precedes it), else a queued follow-up dispatches into the still-finishing
  // child and reopens the routing race the hold closes.
  it("lifecycle:end keeps the child RUNNING (not done); only chat:final terminalizes + reaps", () => {
    const obs = new SubAgentObserver(PARENT1, "chatA");
    obs.observe(SPAWN_RESULT_1, 1000);
    const lifecycleEnd = {
      type: "event",
      event: "agent",
      payload: {
        sessionKey: CHILD1,
        spawnedBy: PARENT1,
        stream: "codex_app_server.lifecycle",
        data: { phase: "end" },
      },
    };
    // lifecycle:end is a PHASE update — status stays running (queue NOT released).
    expect(obs.observe(lifecycleEnd, 1001)).toEqual([
      { chatId: "chatA", parentMessageId: null, childSessionKey: CHILD1, status: "running", phase: "end" },
    ]);
    expect(obs.size).toBe(1); // NOT reaped — still held
    // chat:final is the authoritative terminal (done + result) that drains the queue.
    const fin = obs.observe(CHILD_FINAL_1, 1002);
    expect(fin[0]).toMatchObject({ status: "done", resultText: "SUBAGENT_PONG_42" });
    expect(obs.size).toBe(0);
  });

  it("REAL error fixture: lifecycle:error stays RUNNING; the FOLLOWING chat:error is the terminal", () => {
    // Verifies the captured order: lifecycle:error arrives BEFORE chat:error.
    expect(ERROR_FRAMES.indexOf(ERR_LIFECYCLE_ERROR)).toBeLessThan(
      ERROR_FRAMES.indexOf(ERR_CHAT_ERROR),
    );
    const obs = new SubAgentObserver(ERR_PARENT, "chatErr");
    // The child's lifecycle:error must NOT terminalize (it would drain the held queue
    // early). It is a phase update → status running.
    expect(obs.observe(ERR_LIFECYCLE_ERROR, 1000)).toEqual([
      { chatId: "chatErr", parentMessageId: null, childSessionKey: ERR_CHILD, status: "running", phase: "error" },
    ]);
    expect(obs.size).toBe(1); // still held through lifecycle:error
    // The child's chat:error (which FOLLOWS in the capture) is the real terminal + reap.
    const chatErr = obs.observe(ERR_CHAT_ERROR, 1001);
    expect(chatErr[0]).toMatchObject({ status: "error", childSessionKey: ERR_CHILD });
    expect(obs.size).toBe(0); // reaped only at chat:error
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
