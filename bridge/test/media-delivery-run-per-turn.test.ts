/**
 * "This turn IS a media task's delivery run" is a fact about ONE run.
 *
 * Upstream names the delivery run after the task (`<tool>:<taskId>:ok[:agent-loop]`,
 * src/agents/tools/media-generate-background-completion.ts `announceId`, queued as an agent
 * turn by src/agents/subagents/announce/subagent-announce-delivery.ts @ v2026.9.36) and it
 * ends at its own terminal like any run: nothing makes it a property of the session. The
 * normalizer lives as long as the conversation, so a flag it never cleared rode every later
 * turn — where it reclassified a retryable provider failure as the non-retryable
 * undelivered class and switched off the zero-work retry.
 *
 * The run id is verbatim from the live bench (run 2026-09-18T21-05-03-957Z, scenario
 * `async-task`); the frames around it are shape-faithful, not captured.
 */

import { describe, expect, it } from "vitest";

import type { ConvexWriter, ToolPart } from "../src/convex-writer.js";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";

const SK = "agent:alice:atrium:chat:u-repro:turn-nx797jy9g64vjv0yedbr67z3yh8envjs";
const DELIVERY_RUN = "image_generate:f21f0360-11ad-482b-a3f4-f362641459e0:ok:agent-loop";
const OWN_RUN = "webchat-cda569c4255330b00576676ec98ebd0c";

const chatFinal = (runId: string, text: string) => ({
  type: "event" as const,
  event: "chat",
  payload: {
    runId,
    sessionKey: SK,
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text }] },
  },
});
const chatError = (runId: string, errorMessage: string) => ({
  type: "event" as const,
  event: "chat",
  payload: { runId, sessionKey: SK, state: "error", errorMessage },
});

describe("the normalizer forgets a delivery run when the next turn begins", () => {
  function turn(n: Normalizer, runId: string, now: number) {
    n.beginTurn(now);
    n.noteRunStarted(runId, now + 1);
    const events = n.feed(chatFinal(runId, "Je lance la génération."), now + 2);
    const final = events.find((e) => e.type === "message.final") as
      | { mediaGeneratedUndelivered?: boolean }
      | undefined;
    return { events, final };
  }

  it("the delivery run itself still says it handed nothing over", () => {
    const n = new Normalizer(SK);
    const { events, final } = turn(n, DELIVERY_RUN, 1_000);
    expect(final?.mediaGeneratedUndelivered).toBe(true);
    expect(events.some((e) => e.type === "media.undelivered")).toBe(true);
  });

  it("the ordinary turn AFTER it carries neither the flag nor the diagnostic", () => {
    const n = new Normalizer(SK);
    turn(n, DELIVERY_RUN, 1_000);
    const { events, final } = turn(n, OWN_RUN, 2_000);
    expect(final?.mediaGeneratedUndelivered).toBe(false);
    expect(events.some((e) => e.type === "media.undelivered")).toBe(false);
  });

  it("the reset precedes the run id, so a delivery turn keeps its own flag", () => {
    // Every caller begins the turn and THEN names its run (run-manager.ts beginTurn /
    // resumeTurn): were the order reversed the reset would erase the turn it describes.
    const n = new Normalizer(SK);
    turn(n, OWN_RUN, 1_000);
    const { final } = turn(n, DELIVERY_RUN, 2_000);
    expect(final?.mediaGeneratedUndelivered).toBe(true);
  });
});

class FinalizeWriter implements ConvexWriter {
  readonly finals: { status: string; errorKind: string | null }[] = [];
  undelivered = 0;
  private n = 0;
  async startAssistant(): Promise<string> {
    return `msg_${++this.n}`;
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_m: string, _p: ToolPart): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {
    this.undelivered++;
  }
  async noteFrameGap(): Promise<void> {}
  async finalize(
    _m: string,
    status: string,
    _t: string,
    _e: string | null,
    errorKind?: string | null,
  ): Promise<void> {
    this.finals.push({ status, errorKind: errorKind ?? null });
  }
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async reportSessionRoster(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  async emitRehydrateTrace(): Promise<void> {}
}

async function settle(writer: FinalizeWriter, n: number): Promise<void> {
  for (let i = 0; i < 40 && writer.finals.length < n; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("a later turn's failure keeps its own class (bridge → sink)", () => {
  async function deliveryThen(second: (m: RunManager, now: number) => Promise<void>) {
    const writer = new FinalizeWriter();
    const manager = new RunManager("chat-f4", SK, writer);
    manager.setGatewayVersionSource(() => "2026.9.36");
    // Turn 1: the gateway-initiated delivery run, which hands over no media.
    await manager.feed(chatFinal(DELIVERY_RUN, "L’image arrivera dès qu’elle sera prête."), 1_000);
    await settle(writer, 1);
    const undeliveredAfterFirst = writer.undelivered;
    await second(manager, 20_000);
    await settle(writer, 2);
    return { writer, undeliveredAfterFirst };
  }

  it("a transient provider error stays `provider_internal`, the retryable class", async () => {
    const { writer, undeliveredAfterFirst } = await deliveryThen(async (m, now) => {
      await m.beginTurn(now, OWN_RUN, { expectedSessionId: null, dispatchOutboxId: "ob-1" });
      await m.feed(chatError(OWN_RUN, "read ECONNRESET"), now + 100);
    });
    expect(writer.finals).toHaveLength(2);
    expect(writer.finals[1]).toStrictEqual({ status: "error", errorKind: "provider_internal" });
    // …and the second turn adds no "generated but not delivered" diagnostic of its own.
    expect(writer.undelivered).toBe(undeliveredAfterFirst);
  });
});
