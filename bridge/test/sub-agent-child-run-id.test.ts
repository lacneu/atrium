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

/**
 * A child spawned INSIDE a yielded turn's continuation.
 *
 * Production, 2026-09-27 (gateway 2026.9.6): the continuation `announce:requester-settle:
 * …:<C1>:yield-1` re-delegated to a second child C2 and yielded again. A delivery run
 * carries NO tool frames to the bridge — only `item` frames without arguments or result —
 * so no spawn result ever named C2's run id, its row had none, and C2's own settle run
 * (`…:<C2>:yield-1`) found no member to join on: a second bubble. The id is learned from
 * C2's own `lifecycle start`, whose runId IS the spawn's run id by upstream construction
 * (the golden captures above and below agree).
 *
 * Shapes: the 2026.9.6 golden `spawn-chain-merge` — its second child is spawned inside a
 * delivery run by item frames only (line 207), and its lane opens with the probe plugin's
 * provenance frame (line 214) BEFORE `lifecycle start` (line 216). The item frame is
 * retargeted onto the requester-settle family the production chain ran on, and its masked
 * `meta` restored to the shape upstream emits (`task …, agent …, cleanup …`).
 */
describe("a child spawned inside a continuation learns its run id from its own startup", () => {
  type GFrame = Record<string, any>;
  const CHAIN: GFrame[] = readFileSync(
    new URL("./fixtures/golden/2026.9.6/spawn-chain-merge.jsonl", import.meta.url),
    "utf-8",
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => (JSON.parse(l) as { frame: GFrame }).frame);
  const C_PARENT = "agent:id2:atrium:chat:id3-id4:id5-id6";
  const C1_RUN = "00000000-0000-4000-8000-000000000011";
  const C2 = "agent:id9:subagent:00000000-0000-4000-8000-000000000018";
  const C2_RUN = "00000000-0000-4000-8000-000000000019";
  const SETTLE_GEN1 = `announce:requester-settle:id2:${C_PARENT}:${C1_RUN}:yield-1`;
  const pick = (pred: (f: GFrame) => boolean): GFrame => {
    const f = CHAIN.find(pred);
    if (f === undefined) throw new Error("golden frame not found");
    return structuredClone(f);
  };
  const itemSpawn = (): GFrame => {
    const f = pick(
      (x) =>
        x.payload?.stream === "item" &&
        x.payload?.data?.name === "sessions_spawn" &&
        x.payload?.data?.phase === "start" &&
        String(x.payload?.runId).startsWith("announce:v1:"),
    );
    f.payload.runId = SETTLE_GEN1;
    f.payload.data.meta = "task Rédige le rapport en PDF, agent id9, cleanup keep";
    return f;
  };
  const c2Provenance = () =>
    pick((x) => x.payload?.sessionKey === C2 && String(x.payload?.stream).endsWith(".provenance"));
  const c2Start = () =>
    pick(
      (x) =>
        x.payload?.sessionKey === C2 &&
        x.payload?.stream === "lifecycle" &&
        x.payload?.data?.phase === "start",
    );
  const c2Final = () =>
    pick((x) => x.event === "chat" && x.payload?.sessionKey === C2 && x.payload?.state === "final");

  it("the golden capture: C2's startup frame carries the run id, and no tool frame names it", () => {
    expect(c2Start().payload.runId).toBe(C2_RUN);
    expect(c2Start().payload.spawnedBy).toBe(C_PARENT);
    // No sessions_spawn TOOL frame on the delivery run: the only spawn signal is the item.
    const toolSpawnsOnDelivery = CHAIN.filter(
      (x) =>
        x.payload?.stream === "tool" &&
        x.payload?.data?.name === "sessions_spawn" &&
        String(x.payload?.runId).startsWith("announce:"),
    );
    expect(toolSpawnsOnDelivery).toHaveLength(0);
  });

  it("item-only spawn then the child's startup ⇒ run id, correlated anchor, carrier run", () => {
    const obs = new SubAgentObserver(C_PARENT, "chat1");
    obs.observe(itemSpawn(), 100, "msgB");
    const ups = obs.observe(c2Start(), 101, null, "msgB");
    const withId = ups.filter((u) => u.childSessionKey === C2 && u.childRunId !== undefined);
    expect(withId.length).toBeGreaterThan(0);
    for (const u of withId) {
      expect(u.childRunId).toBe(C2_RUN);
      expect(u.parentMessageId).toBe("msgB");
      expect(u.anchorExact).toBe(true);
      expect(u.bornOfRun).toBe(SETTLE_GEN1);
    }
  });

  it("…in the captured order too: a provenance frame opens the lane BEFORE the startup", () => {
    // The claim waits for the startup; the provenance frame alone only opens the row.
    const obs = new SubAgentObserver(C_PARENT, "chat1");
    obs.observe(itemSpawn(), 100, "msgB");
    obs.observe(c2Provenance(), 101, null, "msgB");
    const ups = obs.observe(c2Start(), 101, null, "msgB");
    const claim = ups.find((u) => u.childSessionKey === C2 && u.taskName !== undefined);
    expect(claim?.taskName).toBe("Rédige le rapport en PDF");
    const withId = ups.filter((u) => u.childSessionKey === C2 && u.childRunId !== undefined);
    expect(withId.length).toBeGreaterThan(0);
    for (const u of withId) {
      expect(u.childRunId).toBe(C2_RUN);
      expect(u.parentMessageId).toBe("msgB");
      expect(u.anchorExact).toBe(true);
      expect(u.bornOfRun).toBe(SETTLE_GEN1);
    }
  });

  it("a later run on the same lane never re-points the id", () => {
    const obs = new SubAgentObserver(C_PARENT, "chat1");
    obs.observe(itemSpawn(), 100, "msgB");
    obs.observe(c2Start(), 101, null, "msgB");
    const again = c2Start();
    again.payload.runId = "ffffffff-0000-4000-8000-00000000abcd";
    for (const u of obs.observe(again, 120, null, "msgB")) {
      if (u.childRunId !== undefined) expect(u.childRunId).toBe(C2_RUN);
    }
    const term = obs
      .observe(c2Final(), 130)
      .find((u) => u.childSessionKey === C2 && u.status === "done");
    expect(term?.childRunId).toBe(C2_RUN);
  });

  it("a frame that is not a startup names no run (an old child met mid-run after a reconnect)", () => {
    const obs = new SubAgentObserver(C_PARENT, "chat1");
    const midRun = pick(
      (x) => x.payload?.sessionKey === C2 && x.payload?.stream === "lifecycle" && x.payload?.data?.phase === "model",
    );
    const ups = obs.observe(midRun, 100, null, "msgB");
    expect(ups.every((u) => u.childRunId === undefined)).toBe(true);
    // …and a startup long after that registration is a NEW run: it names no run
    // for this spawn either, nor claims a sighting parked meanwhile.
    obs.observe(itemSpawn(), 150, "msgOther");
    const late = obs.observe(c2Start(), 200, null, "msgB");
    expect(late.every((u) => u.taskName === undefined)).toBe(true);
    expect(late.every((u) => u.childRunId === undefined)).toBe(true);
  });
});

/**
 * Codex pass 1 (P2): the deferred claim must never take ANOTHER spawn's sighting.
 *
 * A (a normal turn: tool frames) opens its lane with a provenance frame, then its exact
 * spawn result registers it, and only then its startup arrives — while B, spawned inside
 * a continuation (item frames only), has its sighting pending. Armed, A's startup took
 * B's sighting; B's startup then found none and fell back to the positional anchor, which
 * the settle join refuses: B's continuation opened a second bubble.
 * Shapes: golden 2026.9.6 spawn-chain-merge — A = its first child (item 27, tool result
 * 31, provenance 37, startup 39), B = its second (item 207 retargeted to the settle run,
 * provenance 214, startup 216).
 */
describe("the deferred startup claim only ever takes its own spawn's sighting", () => {
  type GFrame = Record<string, any>;
  const CHAIN: GFrame[] = readFileSync(
    new URL("./fixtures/golden/2026.9.6/spawn-chain-merge.jsonl", import.meta.url),
    "utf-8",
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => (JSON.parse(l) as { frame: GFrame }).frame);
  const P = "agent:id2:atrium:chat:id3-id4:id5-id6";
  const A = "agent:id9:subagent:00000000-0000-4000-8000-000000000010";
  const B = "agent:id9:subagent:00000000-0000-4000-8000-000000000018";
  const GEN1 = `announce:requester-settle:id2:${P}:00000000-0000-4000-8000-000000000011:yield-1`;
  const pick = (pred: (f: GFrame) => boolean): GFrame => {
    const f = CHAIN.find(pred);
    if (f === undefined) throw new Error("golden frame not found");
    return structuredClone(f);
  };
  const aItem = () =>
    pick((x) => x.payload?.stream === "item" && x.payload?.data?.name === "sessions_spawn" && x.payload?.data?.phase === "start" && x.payload?.runId === "webchat-id27");
  const aResult = () =>
    pick((x) => x.payload?.stream === "tool" && x.payload?.data?.name === "sessions_spawn" && x.payload?.data?.phase === "result");
  const bItem = (agent = "id9") => {
    const f = pick((x) => x.payload?.stream === "item" && x.payload?.data?.name === "sessions_spawn" && x.payload?.data?.phase === "start" && String(x.payload?.runId).startsWith("announce:v1:"));
    f.payload.runId = GEN1;
    f.payload.data.meta = `task Rédige le rapport en PDF, agent ${agent}, cleanup keep`;
    return f;
  };
  const lane = (key: string, stream: (s: string) => boolean) =>
    pick((x) => x.payload?.sessionKey === key && stream(String(x.payload?.stream)) && (x.payload?.stream !== "lifecycle" || x.payload?.data?.phase === "start"));
  const prov = (key: string) => lane(key, (s) => s.endsWith(".provenance"));
  const start = (key: string) => lane(key, (s) => s === "lifecycle");

  it("A's exact registration disarms its claim: B keeps its sighting, anchor and carrier", () => {
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(aItem(), 100, "msgA");
    obs.observe(prov(A), 101, null, "msgA");
    obs.observe(aResult(), 102, "msgA");
    obs.observe(bItem(), 103, "msgB");
    const aUps = obs.observe(start(A), 104, null, "msgB");
    for (const u of aUps) {
      expect(u.bornOfRun).toBeUndefined();
      if (u.parentMessageId !== undefined) expect(u.parentMessageId).toBe("msgA");
    }
    obs.observe(prov(B), 105, null, "msgB");
    const bUps = obs.observe(start(B), 106, null, "msgB");
    const claim = bUps.find((u) => u.childSessionKey === B && u.taskName !== undefined);
    expect(claim?.taskName).toBe("Rédige le rapport en PDF");
    expect(claim?.parentMessageId).toBe("msgB");
    expect(claim?.anchorExact).toBe(true);
    expect(claim?.bornOfRun).toBe(GEN1);
  });

  it("a sighting that names ANOTHER agent is never claimed — it waits for its own child", () => {
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(bItem("files"), 100, "msgB");
    const ups = obs.observe(start(B), 101, null, "msgB");
    expect(ups.every((u) => u.taskName === undefined && u.anchorExact !== true)).toBe(true);
    // Still pending for a child of that agent.
    const own = start(B);
    own.payload.sessionKey = "agent:files:subagent:00000000-0000-4000-8000-0000000000ff";
    const claim = obs
      .observe(own, 102, null, "msgB")
      .find((u) => u.taskName !== undefined);
    expect(claim?.taskName).toBe("Rédige le rapport en PDF");
  });
});

/**
 * Codex pass 2: the deferred claim is bound to the RUN whose frame opened the
 * observation — never to a clock.
 *  P1: a child first met MID-RUN (a reconnect cleared the observer) that later starts a
 *      NEW run must not take the sighting of a child spawned meanwhile.
 *  P2: a startup that comes late (the gateway queued the run) still claims, for as long
 *      as the sighting lives (180 s, `purgeExpiredItemSpawns`).
 * Shapes: golden 2026.9.6 spawn-chain-merge, second child (item 207 retargeted to the
 * settle run, provenance 214, startup 216, a mid-run `lifecycle model` frame).
 */
describe("the deferred claim belongs to the run that opened the observation", () => {
  type GFrame = Record<string, any>;
  const CHAIN: GFrame[] = readFileSync(
    new URL("./fixtures/golden/2026.9.6/spawn-chain-merge.jsonl", import.meta.url),
    "utf-8",
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => (JSON.parse(l) as { frame: GFrame }).frame);
  const P = "agent:id2:atrium:chat:id3-id4:id5-id6";
  const B = "agent:id9:subagent:00000000-0000-4000-8000-000000000018";
  const B_RUN = "00000000-0000-4000-8000-000000000019";
  const GEN1 = `announce:requester-settle:id2:${P}:00000000-0000-4000-8000-000000000011:yield-1`;
  const pick = (pred: (f: GFrame) => boolean): GFrame => {
    const f = CHAIN.find(pred);
    if (f === undefined) throw new Error("golden frame not found");
    return structuredClone(f);
  };
  const item = () => {
    const f = pick((x) => x.payload?.stream === "item" && x.payload?.data?.name === "sessions_spawn" && x.payload?.data?.phase === "start" && String(x.payload?.runId).startsWith("announce:v1:"));
    f.payload.runId = GEN1;
    f.payload.data.meta = "task Rédige le rapport en PDF, agent id9, cleanup keep";
    return f;
  };
  const prov = () => pick((x) => x.payload?.sessionKey === B && String(x.payload?.stream).endsWith(".provenance"));
  const start = (runId = B_RUN) => {
    const f = pick((x) => x.payload?.sessionKey === B && x.payload?.stream === "lifecycle" && x.payload?.data?.phase === "start");
    f.payload.runId = runId;
    return f;
  };
  const midRun = () => pick((x) => x.payload?.sessionKey === B && x.payload?.stream === "lifecycle" && x.payload?.data?.phase === "model");
  const NEW_RUN = "ffffffff-0000-4000-8000-00000000abcd";

  it("P1: met mid-run, then a NEW run starts while another spawn's sighting pends: no claim", () => {
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(midRun(), 100, null, "msgOld"); // after a reconnect: the lane is mid-run
    obs.observe(item(), 105, "msgB"); // a spawn issued meanwhile, for another child
    const ups = obs.observe(start(NEW_RUN), 110, null, "msgB");
    for (const u of ups) {
      expect(u.taskName).toBeUndefined();
      expect(u.bornOfRun).toBeUndefined();
      expect(u.anchorExact).not.toBe(true);
      expect(u.childRunId).toBeUndefined();
    }
  });

  it("P1: opened by a pre-startup frame, but the startup is of ANOTHER run: no claim", () => {
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(item(), 100, "msgB");
    obs.observe(prov(), 101, null, "msgB");
    const ups = obs.observe(start(NEW_RUN), 102, null, "msgB");
    expect(ups.every((u) => u.taskName === undefined && u.childRunId === undefined)).toBe(true);
  });

  it("P1: a sighting parked AFTER the lane opened is another spawn's, never claimed", () => {
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(prov(), 100, null, "msgB");
    obs.observe(item(), 105, "msgB");
    const ups = obs.observe(start(), 110, null, "msgB");
    expect(ups.every((u) => u.taskName === undefined && u.anchorExact !== true)).toBe(true);
  });

  it("P2: a startup 120 s after its provenance frame still claims (the sighting lives 180 s)", () => {
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(item(), 100, "msgB");
    obs.observe(prov(), 101, null, "msgB");
    const ups = obs.observe(start(), 221, null, "msgB");
    const claim = ups.find((u) => u.taskName !== undefined);
    expect(claim?.taskName).toBe("Rédige le rapport en PDF");
    expect(claim?.anchorExact).toBe(true);
    expect(claim?.bornOfRun).toBe(GEN1);
    expect(claim?.childRunId).toBe(B_RUN);
  });

  it("…but not once the sighting itself has expired", () => {
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(item(), 100, "msgB");
    obs.observe(prov(), 101, null, "msgB");
    const ups = obs.observe(start(), 290, null, "msgB");
    expect(ups.every((u) => u.taskName === undefined)).toBe(true);
  });
});

/**
 * Codex pass 3 (P2): the AMBIGUOUS branch obeys the same candidate filter as the single
 * one. After a restart lost child A's sighting, A's provenance opens its lane; then the
 * spawns of B and C are parked (a continuation spawning two children) before A's startup.
 * A must take nothing — not a slot, not their shared carrier, not an anchor — and B and C
 * keep their sightings. Shapes: golden 2026.9.6 spawn-chain-merge second child (item 207
 * retargeted to the settle run, provenance 214, startup 216), cloned onto other lanes.
 */
describe("ambiguous sightings are filtered like single ones", () => {
  type GFrame = Record<string, any>;
  const CHAIN: GFrame[] = readFileSync(
    new URL("./fixtures/golden/2026.9.6/spawn-chain-merge.jsonl", import.meta.url),
    "utf-8",
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => (JSON.parse(l) as { frame: GFrame }).frame);
  const P = "agent:id2:atrium:chat:id3-id4:id5-id6";
  const GOLD_B = "agent:id9:subagent:00000000-0000-4000-8000-000000000018";
  const GEN1 = `announce:requester-settle:id2:${P}:00000000-0000-4000-8000-000000000011:yield-1`;
  const pick = (pred: (f: GFrame) => boolean): GFrame => {
    const f = CHAIN.find(pred);
    if (f === undefined) throw new Error("golden frame not found");
    return structuredClone(f);
  };
  const item = (callId: string, agent: string) => {
    const f = pick((x) => x.payload?.stream === "item" && x.payload?.data?.name === "sessions_spawn" && x.payload?.data?.phase === "start" && String(x.payload?.runId).startsWith("announce:v1:"));
    f.payload.runId = GEN1;
    f.payload.data.toolCallId = callId;
    f.payload.data.meta = `task Tâche ${callId}, agent ${agent}, cleanup keep`;
    return f;
  };
  const onLane = (f: GFrame, key: string, run: string) => {
    f.payload.sessionKey = key;
    f.payload.runId = run;
    return f;
  };
  const prov = (key: string, run: string) =>
    onLane(pick((x) => x.payload?.sessionKey === GOLD_B && String(x.payload?.stream).endsWith(".provenance")), key, run);
  const start = (key: string, run: string) =>
    onLane(pick((x) => x.payload?.sessionKey === GOLD_B && x.payload?.stream === "lifecycle" && x.payload?.data?.phase === "start"), key, run);
  const A = "agent:id9:subagent:aaaaaaaa-0000-4000-8000-00000000000a";
  const B = "agent:id9:subagent:bbbbbbbb-0000-4000-8000-00000000000b";
  const C = "agent:id9:subagent:cccccccc-0000-4000-8000-00000000000c";
  const F = "agent:files:subagent:ffffffff-0000-4000-8000-00000000000f";
  const RUN = (c: string) => `${c.repeat(8)}-1111-4000-8000-000000000001`;

  it("restart: A opened BEFORE B and C were parked takes no slot, no carrier, no anchor", () => {
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(prov(A, RUN("a")), 100, null, "msgOld"); // A's own sighting was lost
    obs.observe(item("callB", "id9"), 105, "msgB");
    obs.observe(item("callC", "id9"), 106, "msgB");
    const aUps = obs.observe(start(A, RUN("a")), 110, null, "msgB");
    for (const u of aUps) {
      expect(u.bornOfRun, "A carrier").toBeUndefined();
      expect(u.anchorExact, "A anchor").not.toBe(true);
      expect(u.taskName).toBeUndefined();
    }
    // B and C still find BOTH sightings: their batch is ambiguous (no task/anchor
    // claim) but its carrier is certain, and each consumes one slot.
    for (const [key, t] of [[B, 120], [C, 121]] as const) {
      const ups = obs.observe(start(key, RUN(key === B ? "b" : "c")), t, null, "msgB");
      expect(ups.some((u) => u.bornOfRun === GEN1), key).toBe(true);
    }
  });

  it("an agent the candidates cannot be is filtered BEFORE ambiguity is decided", () => {
    // Two spawns for agent id9, one for agent files: the files child has ONE
    // candidate — its own — and claims it outright.
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(item("call1", "id9"), 100, "msgB");
    obs.observe(item("call2", "id9"), 101, "msgB");
    obs.observe(item("callF", "files"), 102, "msgB");
    const f = obs.observe(start(F, RUN("f")), 110, null, "msgB").find((u) => u.taskName !== undefined);
    expect(f?.taskName).toBe("Tâche callF");
    expect(f?.anchorExact).toBe(true);
    // The id9 children stay ambiguous among the id9 sightings only.
    const b = obs.observe(start(B, RUN("b")), 111, null, "msgB");
    expect(b.every((u) => u.taskName === undefined)).toBe(true);
    expect(b.some((u) => u.bornOfRun === GEN1)).toBe(true);
  });

  it("a child whose candidates straddle the frozen batch and another run gets NO carrier", () => {
    // Y1, Y2 under GEN1; Y3 under another run, parked after A's lane opened (so A
    // never sees it). A freezes the batch over {Y1, Y2}; B then sees {Y2, Y3}: which
    // run spawned B is unknowable, and B must carry none.
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(item("callY1", "id9"), 90, "msgB");
    obs.observe(item("callY2", "id9"), 91, "msgB");
    obs.observe(prov(A, RUN("a")), 91, null, "msgB");
    const y3 = item("callY3", "id9");
    y3.payload.runId = GEN1.replace(":yield-1", ":yield-2");
    obs.observe(y3, 92, "msgB");
    const a = obs.observe(start(A, RUN("a")), 93, null, "msgB");
    expect(a.some((u) => u.bornOfRun === GEN1)).toBe(true);
    const b = obs.observe(start(B, RUN("b")), 94, null, "msgB");
    expect(b.every((u) => u.bornOfRun === undefined && u.anchorExact !== true)).toBe(true);
  });

  it("a child outside the frozen batch is not dragged into it", () => {
    // The id9 children froze a batch; the files child's only candidate is its own
    // sighting, never part of that ambiguity: it claims it outright, with ITS run.
    const obs = new SubAgentObserver(P, "chat1");
    const fItem = item("callF", "files");
    fItem.payload.runId = GEN1.replace(":yield-1", ":yield-2");
    obs.observe(fItem, 99, "msgF");
    obs.observe(item("call1", "id9"), 100, "msgB");
    obs.observe(item("call2", "id9"), 101, "msgB");
    obs.observe(start(B, RUN("b")), 110, null, "msgB"); // ambiguous among the id9 two
    const f = obs.observe(start(F, RUN("f")), 111, null, "msgF").find((u) => u.taskName !== undefined);
    expect(f?.taskName).toBe("Tâche callF");
    expect(f?.bornOfRun).toBe(GEN1.replace(":yield-1", ":yield-2"));
    expect(f?.parentMessageId).toBe("msgF");
  });

  it("candidates under DIFFERENT runs: the carrier is not attributable, nothing recorded", () => {
    const obs = new SubAgentObserver(P, "chat1");
    obs.observe(item("call1", "id9"), 100, "msgB");
    const other = item("call2", "id9");
    other.payload.runId = GEN1.replace(":yield-1", ":yield-2");
    obs.observe(other, 101, "msgB");
    const ups = obs.observe(start(B, RUN("b")), 110, null, "msgB");
    expect(ups.every((u) => u.bornOfRun === undefined && u.anchorExact !== true)).toBe(true);
  });
});
