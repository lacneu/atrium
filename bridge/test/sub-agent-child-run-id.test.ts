/**
 * The child's RUN id reaches its sub-agent row.
 *
 * A yielded turn's continuation arrives as `announce:requester-settle:…:<childRunIds>:yield-N`
 * (OpenClaw v2026.9.6, subagent-announce.requester-settle-wake.ts:433-440). It names the
 * settled children by RUN id only — never by session key — so Convex can return it to the
 * bubble that spawned them only if each row knows its child's run id. The sessions_spawn
 * result carries it (`details.runId`, subagent-spawn.ts:682-686); these tests pin that the
 * observer records it on every path a registration can take.
 *
 * Ground truth: the 2026.9.6 golden capture `spawn-announce-merge`, where the spawn
 * result's `details.runId`, the child's own frame runId and the last segment of its
 * `announce:v1:` delivery are the SAME id.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SubAgentObserver } from "../src/providers/openclaw/sub-agent-observer.js";

type Frame = Record<string, any>;
const FRAMES: Frame[] = readFileSync(
  new URL("./fixtures/golden/2026.9.6/spawn-announce-merge.jsonl", import.meta.url),
  "utf-8",
)
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"))
  .map((l) => (JSON.parse(l) as { frame: Frame }).frame);

const PARENT = "agent:id2:atrium:chat:id3-id4:id5-id6";
const CHILD = "agent:id16:subagent:00000000-0000-4000-8000-000000000006";
const CHILD_RUN = "00000000-0000-4000-8000-000000000007";

const find = (pred: (f: Frame) => boolean): Frame => {
  const f = FRAMES.find(pred);
  if (f === undefined) throw new Error("golden frame not found");
  return f;
};
const SPAWN_RESULT = find(
  (f) => f.payload?.data?.name === "sessions_spawn" && f.payload?.data?.phase === "result",
);
const CHILD_FINAL = find(
  (f) => f.event === "chat" && f.payload?.sessionKey === CHILD && f.payload?.state === "final",
);
const CHILD_FIRST = find((f) => f.payload?.sessionKey === CHILD && f.event === "agent");

describe("the golden capture agrees on one child run id", () => {
  it("spawn result details.runId = the child's frame runId = the announce:v1 last segment", () => {
    expect(SPAWN_RESULT.payload.data.result.details.runId).toBe(CHILD_RUN);
    expect(CHILD_FINAL.payload.runId).toBe(CHILD_RUN);
    const announce = find((f) => String(f.payload?.runId ?? "").startsWith("announce:v1:"));
    expect(String(announce.payload.runId).split(":").at(-1)).toBe(CHILD_RUN);
  });
});

describe("SubAgentObserver records the child run id", () => {
  it("on registration from the spawn result", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(SPAWN_RESULT, 100, "msgA");
    const reg = ups.find((u) => u.childSessionKey === CHILD);
    expect(reg?.childRunId).toBe(CHILD_RUN);
    expect(reg?.parentMessageId).toBe("msgA");
    expect(reg?.anchorExact).toBe(true);
  });

  it("…and re-carries it on the terminal write (a lost registration write is repaired)", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(SPAWN_RESULT, 100, "msgA");
    const ups = obs.observe(CHILD_FINAL, 200);
    const term = ups.find((u) => u.childSessionKey === CHILD && u.status === "done");
    expect(term?.childRunId).toBe(CHILD_RUN);
  });

  it("when the child's own frames raced AHEAD of the spawn result", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(CHILD_FIRST, 100, null, "msgA");
    const ups = obs.observe(SPAWN_RESULT, 101, "msgA");
    const backfill = ups.find((u) => u.childSessionKey === CHILD);
    expect(backfill?.childRunId).toBe(CHILD_RUN);
  });

  it("when a FAST child finished before its spawn result was ingested", () => {
    // The child whose settle wake follows quickest — its row must still learn the id.
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(CHILD_FIRST, 100, null, "msgA");
    obs.observe(CHILD_FINAL, 150);
    const ups = obs.observe(SPAWN_RESULT, 160, "msgA");
    const late = ups.find((u) => u.childSessionKey === CHILD);
    expect(late?.childRunId).toBe(CHILD_RUN);
    expect(late?.status).toBe("done");
  });

  it("drops an id that is not in the shape upstream mints", () => {
    const forged = structuredClone(SPAWN_RESULT);
    forged.payload.data.result.details.runId = "a,b:yield-1";
    forged.payload.data.result.content = [];
    const obs = new SubAgentObserver(PARENT, "chat1");
    const reg = obs.observe(forged, 100, "msgA").find((u) => u.childSessionKey === CHILD);
    expect(reg).toBeDefined();
    expect(reg?.childRunId).toBeUndefined();
  });

  it("falls back to the JSON echo when a gateway sends no `details`", () => {
    const echoOnly = structuredClone(SPAWN_RESULT);
    delete echoOnly.payload.data.result.details;
    const obs = new SubAgentObserver(PARENT, "chat1");
    const reg = obs.observe(echoOnly, 100, "msgA").find((u) => u.childSessionKey === CHILD);
    expect(reg?.childRunId).toBe(CHILD_RUN);
  });
});
