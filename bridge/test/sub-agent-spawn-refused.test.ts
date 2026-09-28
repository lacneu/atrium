/**
 * A spawn the gateway REFUSED is a delegation that never started — not a child.
 *
 * Upstream mints the child key before the child session exists and returns it with
 * the failures that follow (OpenClaw v2026.9.6 subagent-spawn.ts:192-197: the child
 * session patch; :231-235, :264-268, :600-613), under the contract's refusal members
 * `status: "error" | "forbidden"` (subagent-spawn-contract.ts:86-89). The observer
 * took the key as proof of acceptance and registered a RUNNING child: in production
 * (2026-09-23) two spawns refused with "child session patch failed" on a full gateway
 * disk became rows that held the conversation's next message for the whole TTL and
 * then read as 15-minute timeouts with zero tools used.
 *
 * Built on the 2026.9.6 golden spawn result, with its payload replaced by the refusal
 * upstream returns (synthetic reason text, no client data).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SPAWN_REFUSED_CODE,
  SubAgentObserver,
} from "../src/providers/openclaw/sub-agent-observer.js";

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
const REASON = "child session patch failed: synthetic storage refusal";

const SPAWN_RESULT = FRAMES.find(
  (f) => f.payload?.data?.name === "sessions_spawn" && f.payload?.data?.phase === "result",
);
if (SPAWN_RESULT === undefined) throw new Error("golden spawn result not found");

/** The golden spawn result carrying upstream's refusal payload instead. */
function refused(
  status: "error" | "forbidden",
  shape: "details" | "echo" = "details",
): Frame {
  const frame = structuredClone(SPAWN_RESULT) as Frame;
  const payload = { status, error: REASON, childSessionKey: CHILD };
  const result = frame.payload.data.result;
  result.content = [{ type: "text", text: JSON.stringify(payload) }];
  if (shape === "details") result.details = payload;
  else delete result.details;
  return frame;
}

describe("a refused sessions_spawn", () => {
  it("settles at once as a failure that never started — never a running child", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const ups = obs.observe(refused("error"), 100, "msgA");
    const rows = ups.filter((u) => u.childSessionKey === CHILD);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "error",
      errorCode: SPAWN_REFUSED_CODE,
      parentMessageId: "msgA",
      anchorExact: true,
    });
    expect(rows[0]?.errorMessage).toContain("child session patch failed");
    expect(ups.some((u) => u.status === "running")).toBe(false);
  });

  it("holds nothing, so the TTL never invents a timeout for it", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    obs.observe(refused("error"), 100, "msgA");
    expect(obs.nextTimeout(100)).toBeNull();
    expect(obs.sweep(100 + 60 * 60)).toEqual([]);
  });

  it("reads the refusal from the JSON echo when a gateway sends no `details`", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const row = obs
      .observe(refused("error", "echo"), 100, "msgA")
      .find((u) => u.childSessionKey === CHILD);
    expect(row?.status).toBe("error");
    expect(row?.errorCode).toBe(SPAWN_REFUSED_CODE);
    expect(row?.errorMessage).toContain("child session patch failed");
  });

  it("treats `forbidden` the same way", () => {
    const obs = new SubAgentObserver(PARENT, "chat1");
    const row = obs
      .observe(refused("forbidden"), 100, "msgA")
      .find((u) => u.childSessionKey === CHILD);
    expect(row?.status).toBe("error");
    expect(row?.errorCode).toBe(SPAWN_REFUSED_CODE);
  });

  it("an ACCEPTED spawn flagged isError by the codex runtime still registers a running child", () => {
    const frame = structuredClone(SPAWN_RESULT) as Frame;
    frame.payload.data.isError = true;
    frame.payload.data.result.success = false;
    frame.payload.data.result.details.status = "accepted";
    const obs = new SubAgentObserver(PARENT, "chat1");
    const row = obs.observe(frame, 100, "msgA").find((u) => u.childSessionKey === CHILD);
    expect(row?.status).toBe("running");
    expect(row?.errorCode).toBeUndefined();
  });
});
