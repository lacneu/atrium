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
    // early). It is a phase update → status running. (The same frame's top-level
    // sessionId ALSO emits a sessionMeta capture upsert — status running too; the
    // invariant under test is that NO upsert here is terminal.)
    const lifecycleUps = obs.observe(ERR_LIFECYCLE_ERROR, 1000);
    expect(lifecycleUps.every((u) => u.status === "running")).toBe(true);
    expect(lifecycleUps).toContainEqual({
      chatId: "chatErr",
      parentMessageId: null,
      childSessionKey: ERR_CHILD,
      status: "running",
      phase: "error",
    });
    expect(obs.size).toBe(1); // still held through lifecycle:error
    // The child's chat:error (which FOLLOWS in the capture) writes the error row —
    // but the observation STAYS ALIVE: the gateway's mid-turn overflow recovery
    // abandons an attempt with chat:error, truncates tool results, resumes the
    // same run and can finish clean (NAS capture 2026-07-03). Reaping here froze
    // a succeeded child as "failed" forever. A truly-dead child emits nothing
    // more and the TTL sweep reaps it (covered by the TTL test above).
    const chatErr = obs.observe(ERR_CHAT_ERROR, 1001);
    expect(chatErr[0]).toMatchObject({ status: "error", childSessionKey: ERR_CHILD });
    expect(obs.size).toBe(1); // NOT reaped on error — recovery stays observable
  });

  it("overflow RECOVERY: chat:error then chat:final -> the done overwrites (reap at done)", () => {
    // The exact NAS sequence (2026-07-03 14:39): precheck overflow -> attempt
    // abandoned (chat:error) -> tool results truncated -> run resumes -> clean
    // final 43s later. The observer must deliver BOTH rows so Convex ends on
    // done+resultText (upsertSubAgent allows error->done and purges the error).
    const obs = new SubAgentObserver(ERR_PARENT, "chatErr");
    const err = obs.observe(ERR_CHAT_ERROR, 1000);
    expect(err[0]).toMatchObject({ status: "error", childSessionKey: ERR_CHILD });
    expect(obs.size).toBe(1);
    const recoveredFinal = {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: ERR_CHILD,
        spawnedBy: ERR_PARENT,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "RECOVERED_OK" }],
        },
      },
    };
    const fin = obs.observe(recoveredFinal, 44_000);
    expect(fin[0]).toMatchObject({
      status: "done",
      resultText: "RECOVERED_OK",
      childSessionKey: ERR_CHILD,
    });
    expect(obs.size).toBe(0); // the REAL terminal reaps
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
  it("2026.6.10 meta: strips a trailing ', cleanup X' (renamed from ', agent X')", () => {
    // A label-less 6.10 spawn ends with ", cleanup delete" — the task must survive.
    expect(
      extractTaskName("task Réponds exactement : FORKOK, cleanup delete"),
    ).toBe("Réponds exactement : FORKOK");
    expect(extractTaskName("label doer, task do X, cleanup keep")).toBe("doer");
  });
  it("returns undefined for null / unrecognized meta", () => {
    expect(extractTaskName(null)).toBeUndefined();
    expect(extractTaskName("nonsense")).toBeUndefined();
  });
});

describe("SubAgentObserver — child TOOL capture (Inc 4: name + status only, SOC2)", () => {
  // Synthetic child tool frames in the EXACT shape captured live on the PI bench
  // (gateway 2026.6.10): a child's tool is stream:"tool" {data:{name,phase,
  // toolCallId,args}} on the child lane, spawnedBy=parent — the same shape as a
  // main-agent tool. We deliberately carry an `args` blob to assert it is NEVER
  // stored (only name + status reach the upsert).
  const PARENT = "agent:alice:atrium:chat:olivier:cap_tools";
  const CHILD = "agent:alice:subagent:tool-child-uuid";
  const toolFrame = (
    phase: string,
    name: string,
    toolCallId: string,
  ): Record<string, unknown> => ({
    event: "agent",
    payload: {
      stream: "tool",
      sessionKey: CHILD,
      spawnedBy: PARENT,
      data: { phase, name, toolCallId, args: { secret: "NEVER_STORED_CONTENT" } },
    },
  });

  it("records a tool NAME + running status on its start frame", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(toolFrame("start", "exec", "call_1"), 100);
    expect(ups.at(-1)?.tools).toEqual([
      { name: "exec", status: "running", toolCallId: "call_1" },
    ]);
  });

  it("flips the SAME tool to done on its result frame (deduped by toolCallId)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(toolFrame("start", "exec", "call_1"), 100);
    const ups = obs.observe(toolFrame("result", "exec", "call_1"), 101);
    expect(ups.at(-1)?.tools).toEqual([
      { name: "exec", status: "done", toolCallId: "call_1" },
    ]);
  });

  it("accumulates multiple tools in first-seen order", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(toolFrame("start", "exec", "call_1"), 100);
    obs.observe(toolFrame("result", "exec", "call_1"), 101);
    const ups = obs.observe(toolFrame("start", "web_search", "call_2"), 102);
    expect(ups.at(-1)?.tools).toEqual([
      { name: "exec", status: "done", toolCallId: "call_1" },
      { name: "web_search", status: "running", toolCallId: "call_2" },
    ]);
  });

  // The child's tool args/results ARE captured now -- but ONLY on the separate
  // `toolPart` (the in-app user-data detail), NEVER on the summary `tools[]` (the
  // cheap, always-loaded list). The SOC2 content-free floor applies to the
  // observability surfaces (MCP/KPI/traces), not to the user's own in-app data.
  it("keeps args/results OFF the summary tools[] (only name + status there)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(toolFrame("start", "exec", "call_1"), 100);
    expect(ups.at(-1)?.tools).toEqual([
      { name: "exec", status: "running", toolCallId: "call_1" },
    ]);
    expect(JSON.stringify(ups.at(-1)?.tools)).not.toContain(
      "NEVER_STORED_CONTENT",
    );
  });

  it("captures the tool ARGS (start) on the toolPart, keyed by toolCallId", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(toolFrame("start", "exec", "call_1"), 100);
    const part = ups.at(-1)?.toolPart;
    expect(part?.toolCallId).toBe("call_1");
    expect(part?.name).toBe("exec");
    expect(part?.status).toBe("running");
    expect(part?.argsText).toContain("NEVER_STORED_CONTENT");
    expect(part?.resultText).toBeUndefined();
  });

  it("captures the tool RESULT text + flips the toolPart to done on result", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(toolFrame("start", "exec", "call_1"), 100);
    const ups = obs.observe(
      {
        event: "agent",
        payload: {
          stream: "tool",
          sessionKey: CHILD,
          spawnedBy: PARENT,
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "call_1",
            isError: false,
            result: { content: [{ type: "text", text: "EXEC_OUTPUT_OK" }] },
          },
        },
      },
      101,
    );
    const part = ups.at(-1)?.toolPart;
    expect(part?.status).toBe("done");
    expect(part?.resultText).toContain("EXEC_OUTPUT_OK");
  });

  it("marks the toolPart status 'error' when the result frame isError", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(toolFrame("start", "exec", "call_1"), 100);
    const ups = obs.observe(
      {
        event: "agent",
        payload: {
          stream: "tool",
          sessionKey: CHILD,
          spawnedBy: PARENT,
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "call_1",
            isError: true,
            result: { content: [{ type: "text", text: "boom" }] },
          },
        },
      },
      101,
    );
    expect(ups.at(-1)?.toolPart?.status).toBe("error");
  });

  it("ignores a child sessions_spawn (anti-recursion) — never a recorded tool", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(toolFrame("start", "exec", "call_1"), 100);
    obs.observe(toolFrame("start", "sessions_spawn", "call_x"), 101); // must be ignored
    const ups = obs.observe(toolFrame("result", "exec", "call_1"), 102);
    expect(ups.at(-1)?.tools).toEqual([
      { name: "exec", status: "done", toolCallId: "call_1" },
    ]);
  });

  it("a duplicate running frame emits no redundant tools upsert (keep-alive)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(toolFrame("start", "exec", "call_1"), 100);
    const dup = obs.observe(toolFrame("start", "exec", "call_1"), 101);
    expect(dup.some((u) => u.tools !== undefined)).toBe(false);
  });

  it("bounds a pathological toolCallId before storage (codex review P2)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(toolFrame("start", "exec", "x".repeat(5000)), 100);
    expect(ups.at(-1)?.tools?.[0]?.toolCallId?.length).toBe(200);
  });
});

describe("SubAgentObserver — STATIC session meta capture (Phase 2b)", () => {
  const PARENT = "agent:alice:atrium:chat:olivier:cap_meta";
  const CHILD = "agent:alice:subagent:meta-child";
  // A child frame carrying a `payload.session` object (the shape the gateway sends).
  const sessionFrame = (
    session: Record<string, unknown>,
    extraData: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    event: "agent",
    payload: {
      stream: "tool",
      sessionKey: CHILD,
      spawnedBy: PARENT,
      session,
      data: { phase: "start", name: "exec", toolCallId: "c1", ...extraData },
    },
  });

  const FULL = {
    model: "gpt-5.5",
    modelProvider: "openai",
    thinkingLevel: "high",
    effectiveFastMode: false,
    subagentControlScope: "none",
    subagentRole: "leaf",
    spawnDepth: 1,
    totalTokens: 12523, // live telemetry — must NOT be captured
    estimatedCostUsd: 0,
  };

  it("captures the STATIC fields from payload.session (and maps the gateway names)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(sessionFrame(FULL), 100);
    const meta = ups.find((u) => u.sessionMeta)?.sessionMeta;
    expect(meta).toEqual({
      model: "gpt-5.5",
      modelProvider: "openai",
      thinkingLevel: "high",
      fastMode: false,
      controlScope: "none",
      subagentRole: "leaf",
      spawnDepth: 1,
    });
  });

  it("NEVER captures live telemetry (totalTokens / cost) — only static config", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(sessionFrame(FULL), 100);
    const serialized = JSON.stringify(ups.find((u) => u.sessionMeta)?.sessionMeta);
    expect(serialized).not.toContain("12523");
    expect(serialized).not.toContain("totalTokens");
    expect(serialized).not.toContain("estimatedCostUsd");
  });

  it("does NOT re-emit sessionMeta when only telemetry changes (no write-per-tick)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(sessionFrame(FULL), 100); // first-known emits
    // Same static config, only tokens bumped: must NOT emit a sessionMeta upsert.
    const ups = obs.observe(
      sessionFrame({ ...FULL, totalTokens: 19873 }),
      101,
    );
    expect(ups.some((u) => u.sessionMeta)).toBe(false);
  });

  it("merges last-known-non-null: a session-absent frame never wipes a captured field", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(sessionFrame({ model: "gpt-5.5" }), 100);
    // A later frame WITHOUT a session object (the common case) — no meta change.
    const ups = obs.observe(toolFrame("result", "exec", "c1"), 101);
    expect(ups.some((u) => u.sessionMeta)).toBe(false);
    // A frame that ADDS a field merges it on top of the kept model.
    const ups2 = obs.observe(sessionFrame({ thinkingLevel: "low" }), 102);
    expect(ups2.find((u) => u.sessionMeta)?.sessionMeta).toEqual({
      model: "gpt-5.5", // preserved
      thinkingLevel: "low", // added
    });
  });

  // toolFrame is defined in the tool-capture describe; redefine the minimal one here.
  function toolFrame(
    phase: string,
    name: string,
    toolCallId: string,
  ): Record<string, unknown> {
    return {
      event: "agent",
      payload: {
        stream: "tool",
        sessionKey: CHILD,
        spawnedBy: PARENT,
        data: { phase, name, toolCallId },
      },
    };
  }
});

describe("SubAgentObserver — user INTERACTION capture (Phase 2c)", () => {
  const PARENT = "agent:alice:atrium:chat:olivier:cap_ix";
  const CHILD = "agent:alice:subagent:ix-child";
  const finalFrame = (
    state: string,
    text: string,
    errorMessage?: string,
  ): Record<string, unknown> => ({
    event: "chat",
    payload: {
      sessionKey: CHILD,
      spawnedBy: PARENT,
      state,
      ...(errorMessage ? { errorMessage } : {}),
      message: { content: [{ type: "text", text }] },
    },
  });

  it("armInteraction re-opens a reaped child + routes the reply to interactionReply (NEVER resultText)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    // The child's ORIGINAL spawn finishes + is reaped.
    obs.observe(finalFrame("final", "original answer"), 100);
    expect(obs.size).toBe(0);
    // Arm an interaction — re-opens the reaped child (past the recentlyFinal guard).
    obs.armInteraction(CHILD, "interaction123", 101);
    expect(obs.size).toBe(1);
    // The child's NEXT final is the interaction reply.
    const rec = obs.observe(finalFrame("final", "the reply"), 102).at(-1);
    expect(rec?.interactionReply).toEqual({
      interactionId: "interaction123",
      status: "done",
      replyText: "the reply",
    });
    // NOT a resultText update — the original answer must never be overwritten.
    expect(rec?.resultText).toBeUndefined();
    // Placeholder status only (the flush routes it to the interaction store, not a
    // subAgents patch), so it never terminalizes the subAgents row.
    expect(rec?.status).toBe("running");
  });

  it("an interaction ERROR final -> interactionReply status error", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.armInteraction(CHILD, "ix1", 100);
    const rec = obs
      .observe(finalFrame("error", "Error: boom", "boom"), 101)
      .at(-1);
    expect(rec?.interactionReply?.interactionId).toBe("ix1");
    expect(rec?.interactionReply?.status).toBe("error");
  });
});

describe("SubAgentObserver — interaction TTL timeout (Phase 2c)", () => {
  const PARENT = "agent:alice:atrium:chat:olivier:cap_ixtt";
  const CHILD = "agent:alice:subagent:ixtt-child";
  it("a pending interaction whose reply never arrives is FAILED by the sweep (not left hanging)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1", { ttlSeconds: 10 });
    obs.armInteraction(CHILD, "ix1", 100);
    // No reply frame; the TTL elapses.
    const out = obs.sweep(200);
    expect(out.at(-1)?.interactionReply).toMatchObject({
      interactionId: "ix1",
      status: "error",
    });
    // The child was reaped (not left in the registry forever).
    expect(obs.size).toBe(0);
  });
});

describe("SubAgentObserver — spawn CONFIG + gateway kind (doc-driven Avancé)", () => {
  const PARENT = "agent:alice:atrium:chat:olivier:cap_cfg";
  const CHILD = "agent:alice:subagent:cfg-child";
  const CALLID = "call_spawn_cfg";

  const startFrame = (args: Record<string, unknown>) => ({
    event: "agent",
    payload: {
      stream: "tool",
      sessionKey: PARENT,
      data: { phase: "start", name: "sessions_spawn", toolCallId: CALLID, args },
    },
  });
  // The 2026.6.10 gateway names the result array `content` (was `contentItems`
  // <=6.5) — the observer must read either or the spawn RESULT stops registering.
  const resultFrame = (childKey: string, meta: string) => ({
    event: "agent",
    payload: {
      stream: "tool",
      sessionKey: PARENT,
      data: {
        phase: "result",
        name: "sessions_spawn",
        toolCallId: CALLID,
        result: { content: [{ text: JSON.stringify({ childSessionKey: childKey }) }] },
        meta,
      },
    },
  });

  it("captures context/runtime/mode/cleanup from the START args + taskName, via the 6.10 `content` result", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(
      startFrame({
        task: "do X",
        context: "fork",
        runtime: "subagent",
        mode: "run",
        cleanup: "delete",
      }),
      100,
    );
    const ups = obs.observe(
      resultFrame(CHILD, "label pi, task do X, cleanup delete"),
      101,
    );
    expect(ups.at(-1)).toMatchObject({
      taskName: "pi", // registration is NOT lost to the gateway field rename
      sessionMeta: {
        context: "fork",
        runtime: "subagent",
        mode: "run",
        cleanup: "delete",
      },
    });
  });

  it("BACKFILLS taskName + config when the child's own frames register it BEFORE the spawn result (race)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(startFrame({ task: "do X", runtime: "subagent", cleanup: "keep" }), 100);
    // The child's OWN frame arrives first -> lazy registration (no taskName/config yet).
    const lazy = obs.observe(
      {
        event: "agent",
        payload: {
          stream: "tool",
          sessionKey: CHILD,
          spawnedBy: PARENT,
          data: { phase: "start", name: "exec", toolCallId: "x1" },
        },
      },
      101,
    );
    expect(lazy.at(-1)?.taskName).toBeUndefined();
    // The spawn RESULT lands later -> backfills onto the existing observation.
    const ups = obs.observe(
      resultFrame(CHILD, "label doer, task do X, cleanup keep"),
      102,
    );
    expect(ups.at(-1)).toMatchObject({
      taskName: "doer",
      sessionMeta: { runtime: "subagent", cleanup: "keep" },
    });
  });

  it("captures the gateway kind from session.agentRuntime.id", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(
      {
        event: "agent",
        payload: {
          stream: "tool",
          sessionKey: CHILD,
          spawnedBy: PARENT,
          session: { agentRuntime: { id: "openclaw", source: "model" } },
          data: { phase: "start", name: "exec", toolCallId: "c1" },
        },
      },
      100,
    );
    expect(ups.find((u) => u.sessionMeta)?.sessionMeta?.gatewayKind).toBe(
      "openclaw",
    );
  });
});

describe("SubAgentObserver — extended spawn args + resolved model seed", () => {
  const PARENT = "agent:alice:atrium:chat:olivier:cap_ext";
  const CHILD = "agent:bob:subagent:ext-child";

  const spawnStart = (args: Record<string, unknown>): Record<string, unknown> => ({
    event: "agent",
    payload: {
      sessionKey: PARENT,
      stream: "tool",
      data: { name: "sessions_spawn", phase: "start", toolCallId: "tc-ext", args },
    },
  });
  const spawnResult = (json: Record<string, unknown>): Record<string, unknown> => ({
    event: "agent",
    payload: {
      sessionKey: PARENT,
      stream: "tool",
      data: {
        name: "sessions_spawn",
        phase: "result",
        toolCallId: "tc-ext",
        meta: "label ext-label, task Do the thing",
        result: { content: [{ type: "text", text: JSON.stringify(json) }] },
      },
    },
  });

  it("captures label / cwd / agentId / lightContext from the spawn args", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(
      spawnStart({
        context: "isolated",
        label: "ext-label",
        cwd: "/data/work",
        agentId: "bob",
        lightContext: true,
      }),
      100,
    );
    const ups = obs.observe(
      spawnResult({ status: "accepted", childSessionKey: CHILD }),
      101,
    );
    expect(ups.at(-1)?.sessionMeta).toMatchObject({
      context: "isolated",
      label: "ext-label",
      // Paths are stored as their LAST segment only — never the server layout.
      cwd: "work",
      agentId: "bob",
      lightContext: true,
    });
  });

  it("seeds model/provider from the spawn result's resolvedModel/resolvedProvider", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(
      spawnResult({
        status: "accepted",
        childSessionKey: CHILD,
        resolvedModel: "openai/gpt-5.5",
        resolvedProvider: "openai",
      }),
      100,
    );
    expect(ups.at(-1)?.sessionMeta).toMatchObject({
      model: "openai/gpt-5.5",
      modelProvider: "openai",
    });
  });

  it("resolved seed is fill-gaps ONLY: an effective session model already captured wins", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    // The child's own frame lands FIRST (lazy admission) with the EFFECTIVE model.
    obs.observe(
      {
        event: "agent",
        payload: {
          sessionKey: CHILD,
          spawnedBy: PARENT,
          session: { model: "gpt-5.5-effective", modelProvider: "openai" },
          stream: "tool",
          data: { phase: "start", name: "exec", toolCallId: "e1" },
        },
      },
      100,
    );
    // The straggler spawn result carries a DIFFERENT resolved value: must not clobber.
    const ups = obs.observe(
      spawnResult({
        status: "accepted",
        childSessionKey: CHILD,
        resolvedModel: "openai/other",
        resolvedProvider: "other",
      }),
      101,
    );
    const meta = ups.find((u) => u.sessionMeta)?.sessionMeta;
    // Backfill may emit for taskName, but the model fields keep the effective values.
    if (meta !== undefined) {
      expect(meta.model).toBe("gpt-5.5-effective");
      expect(meta.modelProvider).toBe("openai");
    }
  });
});

describe("SubAgentObserver — extended session statics + telemetry cadence", () => {
  const PARENT = "agent:alice:atrium:chat:olivier:cap_tel";
  const CHILD = "agent:alice:subagent:tel-child";
  const sessionFrame = (
    session: Record<string, unknown>,
    toolCallId = "t1",
  ): Record<string, unknown> => ({
    event: "agent",
    payload: {
      stream: "tool",
      sessionKey: CHILD,
      spawnedBy: PARENT,
      session,
      data: { phase: "start", name: "exec", toolCallId },
    },
  });
  const finalFrame = (): Record<string, unknown> => ({
    event: "chat",
    payload: {
      sessionKey: CHILD,
      spawnedBy: PARENT,
      state: "final",
      message: { content: [{ type: "text", text: "OK_DONE" }] },
    },
  });

  it("captures label / sessionId / spawnedWorkspaceDir as session STATICS", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(
      sessionFrame({
        label: "tel-label",
        sessionId: "sess-42",
        spawnedWorkspaceDir: "/home/node/.openclaw/workspace-alice",
      }),
      100,
    );
    expect(ups.find((u) => u.sessionMeta)?.sessionMeta).toMatchObject({
      label: "tel-label",
      sessionId: "sess-42",
      // LAST segment only — the server's filesystem layout never persists (codex P1).
      spawnedWorkspaceDir: "workspace-alice",
    });
  });

  it("an unchanged workspace path does NOT re-emit sessionMeta (compare processed value)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(
      sessionFrame({ spawnedWorkspaceDir: "/home/node/.openclaw/workspace-alice" }),
      100,
    );
    // Same path on the next frame (a NEW tool id so the frame is not a pure dup):
    // statics unchanged -> no sessionMeta upsert (write-once cadence preserved).
    const ups = obs.observe(
      sessionFrame(
        { spawnedWorkspaceDir: "/home/node/.openclaw/workspace-alice" },
        "t-again",
      ),
      101,
    );
    expect(ups.some((u) => u.sessionMeta !== undefined)).toBe(false);
  });

  it("telemetry alone NEVER emits an upsert (write cadence unchanged)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(sessionFrame({ model: "gpt-5.5", runtimeMs: 1000 }), 100);
    // Telemetry-only change on a keep-alive frame within the heartbeat window.
    const ups = obs.observe(
      sessionFrame({ model: "gpt-5.5", runtimeMs: 2000, totalTokens: 50 }, "t2"),
      101,
    );
    // t2 is a NEW tool -> a tools upsert fires, but none carries telemetry and no
    // sessionMeta re-emit happens (statics unchanged).
    expect(ups.some((u) => u.telemetry !== undefined)).toBe(false);
    expect(ups.some((u) => u.sessionMeta !== undefined)).toBe(false);
  });

  it("the TERMINAL upsert carries the last-known telemetry (final numbers)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(
      sessionFrame({
        model: "gpt-5.5",
        runtimeMs: 5400,
        totalTokens: 1234,
        estimatedCostUsd: 0.0042,
        startedAt: 1700000000000,
      }),
      100,
    );
    const ups = obs.observe(finalFrame(), 102);
    const terminal = ups.find((u) => u.status === "done");
    expect(terminal?.telemetry).toEqual({
      runtimeMs: 5400,
      totalTokens: 1234,
      estimatedCostUsd: 0.0042,
      startedAt: 1700000000000,
    });
  });

  it("a due HEARTBEAT piggybacks the last-known telemetry", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(sessionFrame({ model: "gpt-5.5", totalTokens: 77 }), 100);
    // A keep-alive frame past the 5-min heartbeat throttle -> heartbeat upsert.
    const ups = obs.observe(
      {
        event: "agent",
        payload: {
          sessionKey: CHILD,
          spawnedBy: PARENT,
          session: { totalTokens: 99 },
          stream: "assistant",
          data: {},
        },
      },
      100 + 5 * 60 + 1,
    );
    const hb = ups.find((u) => u.status === "running" && u.telemetry !== undefined);
    expect(hb?.telemetry).toMatchObject({ totalTokens: 99 });
  });
});

describe("SubAgentObserver — codex round-3 fixes (fast-child backfill + top-level sessionId)", () => {
  const PARENT = "agent:alice:atrium:chat:olivier:cap_r3";
  const CHILD = "agent:alice:subagent:r3-child";

  it("a spawn result arriving AFTER the child was reaped still backfills the spawn config (cleanup guard)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    // The FAST child finishes off its own frames first -> terminal + reaped.
    obs.observe(
      {
        event: "chat",
        payload: {
          sessionKey: CHILD,
          spawnedBy: PARENT,
          state: "final",
          message: { content: [{ type: "text", text: "FAST_OK" }] },
        },
      },
      100,
    );
    expect(obs.size).toBe(0); // reaped
    // The straggler spawn result carries cleanup:"delete" -> must STILL reach the row.
    obs.observe(
      {
        event: "agent",
        payload: {
          sessionKey: PARENT,
          stream: "tool",
          data: {
            name: "sessions_spawn",
            phase: "start",
            toolCallId: "tc-r3",
            args: { cleanup: "delete" },
          },
        },
      },
      101,
    );
    const ups = obs.observe(
      {
        event: "agent",
        payload: {
          sessionKey: PARENT,
          stream: "tool",
          data: {
            name: "sessions_spawn",
            phase: "result",
            toolCallId: "tc-r3",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ status: "accepted", childSessionKey: CHILD }),
                },
              ],
            },
          },
        },
      },
      102,
    );
    expect(ups).toHaveLength(1);
    expect(ups[0]?.sessionMeta).toMatchObject({ cleanup: "delete" });
    // The backfill re-asserts the child's TRUE final status — never "running"
    // (that would leak Session.registeredChildren as a phantom registration) and
    // never a guessed terminal (an errored child must not flip to done).
    expect(ups[0]?.status).toBe("done");
    // And the resurrection guard held: nothing was re-registered.
    expect(obs.size).toBe(0);
  });

  it("captures the TOP-LEVEL payload.sessionId (lifecycle frames without a session object)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(
      {
        event: "agent",
        payload: {
          sessionKey: CHILD,
          spawnedBy: PARENT,
          sessionId: "top-level-sess-7",
          stream: "lifecycle",
          data: { phase: "startup" },
        },
      },
      100,
    );
    expect(ups.find((u) => u.sessionMeta)?.sessionMeta).toMatchObject({
      sessionId: "top-level-sess-7",
    });
  });
});

describe("SubAgentObserver — HARNESS child tools (stream:item, real captured frames)", () => {
  // REAL harness-mode capture (codex app-server, 2026-07-01): the child's tool calls
  // ride stream:"item" frames — native stream:"tool" never fires on the child lane.
  const HARNESS_FRAMES = readFileSync(
    new URL("./fixtures/subagent_frames_harness.jsonl", import.meta.url),
    "utf-8",
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => JSON.parse(l) as Record<string, any>);
  const H_PARENT =
    "agent:alice:atrium:chat:olivier:m974f21nhs2hwqemec35kpkw2x89pg1w";
  const findH = (pred: (f: Record<string, any>) => boolean): Record<string, any> => {
    const f = HARNESS_FRAMES.find(pred);
    if (!f) throw new Error("harness fixture frame not found");
    return f;
  };
  const H_CMD_START = findH(
    (f) => f.payload?.data?.kind === "command" && f.payload?.data?.phase === "start",
  );
  const H_CMD_END = findH(
    (f) =>
      f.payload?.data?.kind === "command" &&
      f.payload?.data?.phase === "end" &&
      f.payload?.data?.status === "completed",
  );
  const H_CMD_FAILED = findH((f) => f.payload?.data?.status === "failed");
  const H_ANALYSIS = findH((f) => f.payload?.data?.kind === "analysis");
  const H_CODEX_ITEM = findH(
    (f) => f.payload?.stream === "codex_app_server.item",
  );

  it("a command item start registers the tool as RUNNING (name from the real frame)", () => {
    const obs = new SubAgentObserver(H_PARENT, "chatH");
    const ups = obs.observe(H_CMD_START, 100);
    const withTools = ups.find((u) => u.tools !== undefined);
    expect(withTools?.tools).toEqual([
      {
        name: "bash",
        status: "running",
        toolCallId: H_CMD_START.payload.data.itemId,
      },
    ]);
    // The item's human `meta` description rides as the args-equivalent detail.
    expect(withTools?.toolPart?.argsText).toBe(H_CMD_START.payload.data.meta);
  });

  it("the matching item end flips it to DONE (same itemId join key)", () => {
    const obs = new SubAgentObserver(H_PARENT, "chatH");
    obs.observe(H_CMD_START, 100);
    const ups = obs.observe(H_CMD_END, 101);
    const withTools = ups.find((u) => u.tools !== undefined);
    expect(withTools?.tools).toEqual([
      {
        name: "bash",
        status: "done",
        toolCallId: H_CMD_END.payload.data.itemId,
      },
    ]);
  });

  it("a FAILED item marks the tool-part detail status error", () => {
    // This captured frame comes from a DIFFERENT run — key the observer on ITS
    // parent (the contamination guard rightly rejects it under H_PARENT).
    const obs = new SubAgentObserver(H_CMD_FAILED.payload.spawnedBy, "chatH2");
    const ups = obs.observe(H_CMD_FAILED, 100);
    const withTools = ups.find((u) => u.tools !== undefined);
    expect(withTools?.toolPart?.status).toBe("error");
  });

  it("kind:analysis (reasoning) and codex_app_server.item shapes are NOT tools", () => {
    const obs = new SubAgentObserver(H_PARENT, "chatH");
    const a = obs.observe(H_ANALYSIS, 100);
    const c = obs.observe(H_CODEX_ITEM, 101);
    expect([...a, ...c].every((u) => u.tools === undefined)).toBe(true);
  });
});

// --- ANNOUNCE-run spawns: no tool result, item-only sighting -------------------
// A spawn issued during a gateway ANNOUNCE run emits ONLY `stream:"item"`
// frames (no `stream:"tool"` result carrying the childSessionKey), and the
// child's own frames carry no `session` object — live-pinned 2026-07-12. The
// observer must park the item sighting (task + model/agent/cleanup from its
// meta) and let the child's LAZY registration claim it.
describe("SubAgentObserver — child-lane anchor fallback (missed spawn result)", () => {
  // A child frame is NEVER "owned" by the parent turn (its runId is the
  // child's), so the strict preFeed anchor is always null for it. When the
  // spawn result was missed AND no item sighting is claimable, the session's
  // last-known message is the plausible parent — losing the anchor entirely
  // would make the announce merge impossible (two bubbles forever).
  const PARENT = "agent:alice:atrium:chat:olivier:fallbackanchor1";
  const CHILD = "agent:files:subagent:bbbb1111-2222-3333-4444-555566667777";
  const childStartup = () => ({
    event: "agent",
    payload: {
      sessionKey: CHILD,
      spawnedBy: PARENT,
      runId: "child-run",
      stream: "lifecycle",
      data: { phase: "startup" },
    },
  });

  it("lazy registration WITHOUT a sighting takes the childAnchorFallback", () => {
    const obs = new SubAgentObserver(PARENT, "chatA");
    const ups = obs.observe(childStartup(), 1000, null, "msg-last-turn");
    const reg = ups.find((u) => u.childSessionKey === CHILD);
    expect(reg?.parentMessageId).toBe("msg-last-turn");
  });

  it("AMBIGUOUS pending sightings (>1) fail closed: no fallback anchor", () => {
    // Two spawns parked (announce run) while another turn is active: the
    // child cannot be correlated to either sighting — anchoring it to the
    // active turn's message could merge its result into the wrong bubble.
    const obs = new SubAgentObserver(PARENT, "chatA");
    for (const id of ["call_1|fc_1", "call_2|fc_2"]) {
      obs.observe(
        {
          event: "agent",
          payload: {
            sessionKey: PARENT,
            runId: "announce:v1:agent:files:subagent:prev:run7",
            stream: "item",
            data: {
              name: "sessions_spawn",
              phase: "start",
              toolCallId: id,
              meta: "task T., agent files",
            },
          },
        },
        1000,
        null,
      );
    }
    const ups = obs.observe(childStartup(), 1010, null, "msg-active-turn");
    const reg = ups.find((u) => u.childSessionKey === CHILD);
    expect(reg).toBeDefined();
    expect(reg?.parentMessageId).toBeNull();
  });

  it("a sighting's null anchor is authoritative: the fallback must NOT override it", () => {
    // An announce-run spawn parks a NULL anchor awaiting the run-correlated
    // backfill — anchoring it to an unrelated last message would merge the
    // child's result into the wrong bubble.
    const obs = new SubAgentObserver(PARENT, "chatA");
    obs.observe(
      {
        event: "agent",
        payload: {
          sessionKey: PARENT,
          runId: "announce:v1:agent:files:subagent:prev:run9",
          stream: "item",
          data: {
            name: "sessions_spawn",
            phase: "start",
            toolCallId: "call_F|fc_F",
            meta: "task T., agent files",
          },
        },
      },
      1000,
      null,
    );
    const ups = obs.observe(childStartup(), 1010, null, "msg-unrelated-turn");
    const reg = ups.find((u) => u.childSessionKey === CHILD);
    expect(reg).toBeDefined();
    expect(reg?.parentMessageId).toBeNull();
    // The run-correlated path still anchors it later.
    const late = obs.noteRunAnchor(
      ["announce:v1:agent:files:subagent:prev:run9"],
      "msg-announce",
      1020,
    );
    // The re-anchor persists IMMEDIATELY (a dropped connection before the
    // next heartbeat must not lose it) and the live observation carries it.
    expect(late).toContainEqual({
      chatId: "chatA",
      parentMessageId: "msg-announce",
      // Run-keyed correlation is EXACT provenance: the merge may return to
      // this bubble even after the conversation moved on.
      anchorExact: true,
      childSessionKey: CHILD,
      status: "running",
    });
    const done = obs.observe(
      {
        event: "chat",
        payload: { sessionKey: CHILD, spawnedBy: PARENT, state: "final" },
      },
      1030,
      null,
    );
    expect(done.find((u) => u.childSessionKey === CHILD)?.parentMessageId).toBe(
      "msg-announce",
    );
  });
});

describe("SubAgentObserver — announce-run item-spawn backfill", () => {
  const PARENT = "agent:alice:atrium:chat:olivier:announcespawn1";
  const CHILD = "agent:files:subagent:aaaa1111-2222-3333-4444-555566667777";
  const META =
    "task OBJECTIF: Convertir le DOCX en PDF., agent files, model openai/gpt-5.6-sol, cleanup keep";

  const itemFrame = (phase: string, toolCallId = "call_X|fc_1") => ({
    event: "agent",
    payload: {
      sessionKey: PARENT,
      runId: "announce:v1:agent:files:subagent:prev:run0",
      stream: "item",
      data: { name: "sessions_spawn", phase, toolCallId, meta: META },
    },
  });
  const childLifecycle = () => ({
    event: "agent",
    payload: {
      sessionKey: CHILD,
      spawnedBy: PARENT,
      runId: "child-run",
      stream: "lifecycle",
      data: { phase: "startup" },
    },
  });

  it("lazy registration claims the parked item sighting (task + meta seed + anchor)", () => {
    const obs = new SubAgentObserver(PARENT, "chatA");
    // Spawn item lands BEFORE the deferred announce message opened (anchor null)…
    obs.observe(itemFrame("start"), 1000, null);
    // …then a later parent frame OF THE SAME RUN (its streamed text) knows the
    // message → backfill (run-correlated: an unrelated run must never anchor it).
    obs.observe(
      {
        event: "agent",
        payload: {
          sessionKey: PARENT,
          runId: "announce:v1:agent:files:subagent:prev:run0",
          stream: "assistant",
          data: {},
        },
      },
      1050,
      "msg-announce",
    );
    // A frame from a DIFFERENT run must NOT anchor the other sighting.
    obs.observe(
      {
        event: "agent",
        payload: { sessionKey: PARENT, runId: "webchat-unrelated", stream: "assistant", data: {} },
      },
      1060,
      "msg-unrelated",
    );
    const ups = obs.observe(childLifecycle(), 1100, null);
    const reg = ups.find((u) => u.childSessionKey === CHILD);
    expect(reg).toBeDefined();
    expect(reg?.taskName).toBe("OBJECTIF: Convertir le DOCX en PDF.");
    expect(reg?.parentMessageId).toBe("msg-announce");
    const meta = ups.find((u) => u.sessionMeta !== undefined)?.sessionMeta;
    expect(meta?.model).toBe("gpt-5.6-sol");
    expect(meta?.modelProvider).toBe("openai");
    expect(meta?.cleanup).toBe("keep");
    expect(meta?.agentId).toBe("files");
  });

  it("a child sighted inside a sub-agent ANNOUNCE run carries bornOfRun (chain-anchor inheritance key)", () => {
    const obs = new SubAgentObserver(PARENT, "chatA");
    // The spawn item lands during another child's announce run (a CHAINED
    // spawn — delivery runs emit no tool result, so the sighting is the only
    // registration source) and the deferred announce message never opened.
    obs.observe(itemFrame("start"), 1000, null);
    const ups = obs.observe(childLifecycle(), 1100, null);
    const reg = ups.find((u) => u.childSessionKey === CHILD);
    expect(reg).toBeDefined();
    // bornOfRun = the ANNOUNCE run: Convex birth-inheritance resolves the
    // carrier's row and copies its ROOT anchor — without it the chained
    // child's delivery opened its own bubble (live incident 2026-07-14).
    expect(reg?.bornOfRun).toBe("announce:v1:agent:files:subagent:prev:run0");
    expect(reg?.parentMessageId).toBeNull();
  });

  it("a tool-result-registered spawn's item END never re-parks (no cross-claim)", () => {
    const obs = new SubAgentObserver(PARENT, "chatA");
    // Normal spawn: item start → tool result (registers child1, purges sighting)
    // → item end (must NOT re-park).
    obs.observe(itemFrame("start", "call_A|fc_A"), 1000, "msg1");
    obs.observe(
      {
        event: "agent",
        payload: {
          sessionKey: PARENT,
          stream: "tool",
          data: {
            name: "sessions_spawn",
            phase: "result",
            toolCallId: "call_A|fc_A",
            meta: "task OBJECTIF: Créer le DOCX., agent files, model openai/gpt-5.6-sol, cleanup keep",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "accepted",
                    childSessionKey:
                      "agent:files:subagent:bbbb1111-2222-3333-4444-555566667777",
                  }),
                },
              ],
            },
          },
        },
      },
      1100,
      "msg1",
    );
    obs.observe(itemFrame("end", "call_A|fc_A"), 1200, "msg1");
    // The announce-run child registers lazily: it must claim NOTHING from the
    // resolved first spawn (no parked sighting left).
    const ups = obs.observe(childLifecycle(), 1250, null);
    const reg = ups.find((u) => u.childSessionKey === CHILD);
    expect(reg).toBeDefined();
    expect(reg?.taskName).toBeUndefined(); // never the FIRST child's task
  });

  it("extractTaskName strips ALL trailing metadata tokens", () => {
    expect(
      extractTaskName(
        "task OBJECTIF: Faire X., agent files, model openai/gpt-5.6-sol, cleanup keep",
      ),
    ).toBe("OBJECTIF: Faire X.");
  });
});
