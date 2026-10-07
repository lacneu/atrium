// The Control UI's follow-up mode resolution, ported (follow-up-mode.ts). Each case is
// the upstream rule it pins (ui/src/lib/chat/follow-up-mode.ts:21-56,
// ui/src/pages/chat/chat-send-submit.ts:548-562, src/auto-reply/reply/queue/
// normalize.ts:7-25 at v2026.9.8).

import { describe, expect, it } from "vitest";
import {
  explicitQueueMode,
  liveRunIds,
  normalizeQueueMode,
  readSessionRunFacts,
  resolveFollowUpMode,
  resolveServerQueueMode,
} from "../src/providers/openclaw/follow-up-mode.js";

describe("normalizeQueueMode (upstream aliases)", () => {
  it.each([
    ["steer", "steer"],
    ["Steering", "steer"],
    [" interrupts ", "interrupt"],
    ["abort", "interrupt"],
    ["follow-ups", "followup"],
    ["followups", "followup"],
    ["coalesce", "collect"],
    ["queue", undefined],
    ["", undefined],
    [42, undefined],
  ])("%j → %j", (raw, want) => {
    expect(normalizeQueueMode(raw)).toBe(want);
  });
});

describe("resolveServerQueueMode / resolveFollowUpMode", () => {
  it("the session's own mode wins, then the gateway's effective mode", () => {
    expect(resolveServerQueueMode({ queueMode: "collect", effectiveQueueMode: "steer" })).toBe("collect");
    expect(resolveServerQueueMode({ effectiveQueueMode: "followup" })).toBe("followup");
  });
  it("nothing known → undefined (the gateway resolves it itself)", () => {
    expect(resolveServerQueueMode(null)).toBeUndefined();
    expect(resolveServerQueueMode({})).toBeUndefined();
  });
  it("the person's explicit choice wins over the server", () => {
    expect(resolveFollowUpMode("queue", "steer")).toBe("queue");
    expect(resolveFollowUpMode("interrupt", "followup")).toBe("interrupt");
    expect(resolveFollowUpMode(undefined, "followup")).toBe("followup");
  });
});

describe("explicitQueueMode (the run policy)", () => {
  it("only while a run is active, and never the client-side queue", () => {
    expect(explicitQueueMode({ followUpMode: "steer", applyRunPolicy: false })).toBeUndefined();
    expect(explicitQueueMode({ followUpMode: "queue", applyRunPolicy: true })).toBeUndefined();
    expect(explicitQueueMode({ followUpMode: undefined, applyRunPolicy: true })).toBeUndefined();
    expect(explicitQueueMode({ followUpMode: "steer", applyRunPolicy: true })).toBe("steer");
    expect(explicitQueueMode({ followUpMode: "collect", applyRunPolicy: true })).toBe("collect");
  });
});

describe("readSessionRunFacts / liveRunIds (chat.history reply)", () => {
  it("reads sessionInfo and inFlightRun, in-flight first, deduplicated", () => {
    const f = readSessionRunFacts({
      sessionInfo: {
        queueMode: "steer",
        effectiveQueueMode: "followup",
        hasActiveRun: true,
        activeRunIds: ["r2", "r1", "", 7],
      },
      inFlightRun: { runId: "r1" },
    });
    expect(f).toMatchObject({ queueMode: "steer", hasActiveRun: true, inFlightRunId: "r1" });
    expect(liveRunIds(f)).toEqual(["r1", "r2"]);
  });
  it("an unreadable reply is null; no facts → no live run", () => {
    expect(readSessionRunFacts(null)).toBeNull();
    expect(readSessionRunFacts({ messages: [] })).toBeNull();
    expect(liveRunIds(null)).toEqual([]);
  });
});
