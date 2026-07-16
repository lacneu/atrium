import { describe, expect, test, vi } from "vitest";
import {
  claimTalkRun,
  isRelayOwnedTalkRun,
  isTalkConsultRunId,
  observeFinalize,
  releaseTalkRun,
} from "../src/core/talk-consult.js";
import type { ConvexWriter, FinalizeStatus } from "../src/convex-writer.js";

describe("isTalkConsultRunId (run family)", () => {
  test("accepts the measured talk-<callId>-<uuid> shape, rejects the rest", () => {
    expect(isTalkConsultRunId("talk-call_X-1f2e3d4c")).toBe(true);
    expect(isTalkConsultRunId("announce:v1:a:b:c:d")).toBe(false);
    expect(isTalkConsultRunId("webchat-abcdef")).toBe(false);
    expect(isTalkConsultRunId("")).toBe(false);
    expect(isTalkConsultRunId(null)).toBe(false);
    expect(isTalkConsultRunId(undefined)).toBe(false);
  });
});

describe("claim/release (relay ownership of a talk run)", () => {
  test("claimed runs read as relay-owned until released", () => {
    const run = "talk-call_claim-abc";
    expect(isRelayOwnedTalkRun(run)).toBe(false);
    claimTalkRun(run);
    expect(isRelayOwnedTalkRun(run)).toBe(true);
    releaseTalkRun(run);
    expect(isRelayOwnedTalkRun(run)).toBe(false);
  });
});

describe("observeFinalize (the voice reply's terminal observer)", () => {
  function fakeWriter(): ConvexWriter & { finals: unknown[][]; deltas: string[] } {
    const finals: unknown[][] = [];
    const deltas: string[] = [];
    return {
      finals,
      deltas,
      async startAssistant() {
        return "m1";
      },
      async appendDelta(_m: string, text: string) {
        deltas.push(text);
      },
      async setSnapshot() {},
      async addToolPart() {},
      async addCompactionPart() {},
      async recordGatewayPressure() {},
      async addProvenancePart() {},
      async addMedia() {
        return true;
      },
      async noteMediaUndelivered() {},
      async finalize(
        messageId: string,
        status: FinalizeStatus,
        text: string,
        error: string | null,
      ) {
        finals.push([messageId, status, text, error]);
      },
      async getRehydrationContext() {
        return { history: null, turnCount: 0 };
      },
      async reportSessionMeta() {},
      async upsertSubAgent() {},
      async upsertSubAgentToolPart() {},
      async recordInteractionReply() {},
      emitRehydrateTrace() {},
    } as unknown as ConvexWriter & { finals: unknown[][]; deltas: string[] };
  }

  test("reports finalize's (status, text, error) AND still delegates to the real writer", async () => {
    const writer = fakeWriter();
    const onFinal = vi.fn();
    const observed = observeFinalize(writer, onFinal);
    await observed.appendDelta("m1", "bonjour"); // passthrough intact
    await observed.finalize("m1", "complete", "résultat final", null);
    expect(onFinal).toHaveBeenCalledWith("complete", "résultat final", null);
    expect(writer.deltas).toEqual(["bonjour"]);
    expect(writer.finals).toEqual([["m1", "complete", "résultat final", null]]);
  });

  test("error terminals report the error string", async () => {
    const writer = fakeWriter();
    const onFinal = vi.fn();
    const observed = observeFinalize(writer, onFinal);
    await observed.finalize("m1", "error", "", "context overflow");
    expect(onFinal).toHaveBeenCalledWith("error", "", "context overflow");
  });
});
