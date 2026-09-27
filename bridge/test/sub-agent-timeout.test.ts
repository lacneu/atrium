/**
 * A sub-agent cut off by its time limit is CLASSED, and the limit it hit is known.
 *
 * Production, 2026-09-27 (gateway 2026.9.6): a child spawned with `runTimeoutSeconds: 900`
 * produced nothing for 14m46s and the gateway ended it. Its `chat` error frame carried
 * `errorKind: "timeout"` — minted from the run's recorded terminal classification
 * (upstream src/gateway/server-chat.ts:725-730 at v2026.9.6; vocabulary
 * packages/gateway-protocol/src/schema/logs-chat.ts:356-362) — beside upstream's generic
 * sentence advising to raise `agents.defaults.timeoutSeconds`
 * (src/agents/embedded-agent-runner/run/terminal-timeout.ts:50-55). The observer read only
 * the sentence, which the shared classifier has no class for, so the reader was shown that
 * advice cut at 120 characters — wrong advice, since the limit in force was the spawn's own.
 *
 * Shapes: the 2026.9.6 golden `spawn-chain-merge` (its first child's tool `start`, spawn
 * `result` and `chat` final); the error frame is that final re-shaped to the error payload
 * upstream builds (server-chat.ts:1220-1247: `state:"error"`, `errorMessage`, `errorKind`,
 * no message). The spawn's `runTimeoutSeconds` argument is set on the captured `start`
 * frame — the capture's own spawn declared none.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SubAgentObserver } from "../src/providers/openclaw/sub-agent-observer.js";

type Frame = Record<string, any>;
const FRAMES: Frame[] = readFileSync(
  new URL("./fixtures/golden/2026.9.6/spawn-chain-merge.jsonl", import.meta.url),
  "utf-8",
)
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"))
  .map((l) => (JSON.parse(l) as { frame: Frame }).frame);

const PARENT = "agent:id2:atrium:chat:id3-id4:id5-id6";
const CHILD = "agent:id9:subagent:00000000-0000-4000-8000-000000000010";
const UPSTREAM_TIMEOUT_TEXT =
  "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";

const pick = (pred: (f: Frame) => boolean): Frame => {
  const f = FRAMES.find(pred);
  if (f === undefined) throw new Error("golden frame not found");
  return structuredClone(f);
};
const spawnStart = (runTimeoutSeconds?: unknown): Frame => {
  const f = pick(
    (x) =>
      x.payload?.stream === "tool" &&
      x.payload?.data?.name === "sessions_spawn" &&
      x.payload?.data?.phase === "start",
  );
  if (runTimeoutSeconds !== undefined) f.payload.data.args.runTimeoutSeconds = runTimeoutSeconds;
  return f;
};
const spawnResult = () =>
  pick(
    (x) =>
      x.payload?.stream === "tool" &&
      x.payload?.data?.name === "sessions_spawn" &&
      x.payload?.data?.phase === "result",
  );
const childError = (errorKind?: string, errorMessage = UPSTREAM_TIMEOUT_TEXT): Frame => {
  const f = pick(
    (x) => x.event === "chat" && x.payload?.sessionKey === CHILD && x.payload?.state === "final",
  );
  f.payload.state = "error";
  delete f.payload.message;
  f.payload.errorMessage = errorMessage;
  if (errorKind !== undefined) f.payload.errorKind = errorKind;
  f.payload.stopReason = "error";
  return f;
};

function run(errorKind?: string, runTimeoutSeconds?: unknown, errorMessage?: string) {
  const obs = new SubAgentObserver(PARENT, "chat1");
  obs.observe(spawnStart(runTimeoutSeconds), 100, "msgA");
  const reg = obs.observe(spawnResult(), 101, "msgA").find((u) => u.childSessionKey === CHILD);
  const term = obs
    .observe(childError(errorKind, errorMessage), 1000)
    .find((u) => u.childSessionKey === CHILD && u.status === "error");
  return { reg, term };
}

describe("a sub-agent's time-limit failure", () => {
  it("is classed `timeout` from the gateway's own errorKind", () => {
    const { term } = run("timeout", 900);
    expect(term?.errorCode).toBe("timeout");
    // The gateway's sentence is still kept, for the panel's detail.
    expect(term?.errorMessage).toContain("Request timed out");
  });

  it("carries the limit the spawn declared, on the registration AND the terminal write", () => {
    const { reg, term } = run("timeout", 900);
    expect(reg?.runTimeoutSeconds).toBe(900);
    expect(term?.runTimeoutSeconds).toBe(900);
  });

  it("an undeclared or malformed limit is never invented", () => {
    for (const bad of [undefined, "900", 12.5, -1, Number.NaN]) {
      const { reg, term } = run("timeout", bad);
      expect(reg?.runTimeoutSeconds).toBeUndefined();
      expect(term?.runTimeoutSeconds).toBeUndefined();
    }
    // 0 is a real declaration upstream ("no limit"), kept as such.
    expect(run("timeout", 0).reg?.runTimeoutSeconds).toBe(0);
  });

  it("an errorKind outside the gateway's vocabulary falls back to the text classifier", () => {
    expect(run("unknown").term?.errorCode).toBeUndefined();
    expect(run("bogus").term?.errorCode).toBeUndefined();
    expect(
      run("unknown", undefined, "Context overflow: prompt too large for the model.").term
        ?.errorCode,
    ).toBe("context_length");
  });

  it("every gateway class is taken as-is", () => {
    for (const kind of ["refusal", "rate_limit", "context_length", "timeout"]) {
      expect(run(kind).term?.errorCode).toBe(kind);
    }
  });
});

/**
 * The OTHER timeout path: the run budget expires while the child WAITS ON A TOOL.
 *
 * Captured live 2026-09-27 on 2026.9.6 (bench, `runTimeoutSeconds: 30`, the child polling
 * a background `sleep 120`; gateway log "embedded run timeout: … timeoutMs=29996"). The
 * attempt records the timeout internally only — `mergeTerminal({kind:"timeout", phase:
 * "prompt", source:"run_budget"})` (run/attempt-execution-phase.ts:193-194) — while the
 * broadcast lifecycle terminal is built from `state.timeoutPhase`, set only through the
 * terminal meta (embedded-agent-subscribe.handlers.lifecycle.ts:200-230,
 * embedded-agent-subscribe.ts:461), which this path never sets. What reaches the wire is
 * a plain abort, indistinguishable from a cancellation: `lifecycle end` with
 * `aborted:false, stopReason:"aborted", livenessState:"paused"`, no `timeoutPhase`, no
 * `status`, no `errorKind`, then `chat` `state:"aborted"`. Upstream's own classifier calls
 * that a cancellation (packages/normalization-core/src/agent-run-terminal-outcome.ts,
 * `resolveAgentRunLifecycleTerminalFacts`: "A mechanical abort is cancellation unless
 * the producer records a timeout"). Atrium must not invent the class it was not given.
 * Shapes: the captured frames, ids replaced, the receipt trimmed to its structural keys.
 */
describe("a run-budget timeout during a TOOL wait reaches the wire as a plain abort", () => {
  const KEY = "agent:files:subagent:6fab0bfb-4483-4d58-9102-70e3421ec5d3";
  const RUN = "402c35bf-dcac-448f-a4c2-55075bdbb52b";
  const SPAWNER = "agent:alice:atrium:chat:u-repro:turn-nx7bkjdbpv4nk1f437mgk4h2518f75da";
  const terminalData = {
    startedAt: 1790532523014,
    aborted: false,
    stopReason: "aborted",
    replayInvalid: true,
    livenessState: "paused",
    terminalReply: { disposition: "empty" },
  };
  const frames = [
    { type: "event", event: "agent", payload: { runId: RUN, stream: "lifecycle", sessionKey: KEY, agentId: "files", spawnedBy: SPAWNER, data: { phase: "start", startedAt: 1790532523761 } } },
    { type: "event", event: "agent", payload: { runId: RUN, stream: "lifecycle", sessionKey: KEY, agentId: "files", spawnedBy: SPAWNER, data: { phase: "finishing", endedAt: 1790532553824, ...terminalData } } },
    { type: "event", event: "agent", payload: { runId: RUN, stream: "lifecycle", sessionKey: KEY, agentId: "files", spawnedBy: SPAWNER, data: { phase: "end", endedAt: 1790532553835, executionSettled: true, ...terminalData } } },
    { type: "event", event: "chat", payload: { runId: RUN, sessionKey: KEY, agentId: "files", spawnedBy: SPAWNER, seq: 114, state: "aborted", stopReason: "aborted" } },
  ];

  it("the child settles `aborted`, with no failure class guessed", () => {
    const obs = new SubAgentObserver(SPAWNER, "chat1");
    const ups = frames.flatMap((f, i) => obs.observe(f, 100 + i, null, "msgA"));
    const term = ups.find((u) => u.childSessionKey === KEY && u.status !== "running");
    expect(term?.status).toBe("aborted");
    expect(term?.errorCode).toBeUndefined();
    expect(term?.childRunId).toBe(RUN);
  });
});
