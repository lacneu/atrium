// WHY a turn closed must reach the MESSAGE, not only a trace.
//
// Prod triage 2026-09-21: an `empty_response` from the previous day, still red in
// its conversation — seven tool calls, no text — and the traces that carried its
// verdict were already out of retention. `list_traces` returned nothing for the
// message or for the child key, so a red turn one day old could no longer be
// named at all.
//
// The trace channel is also CONDITIONAL: `recordGatewayPressure` fires only when
// the turn had pre-send pressure, a diagnostic class, or closed on one of the
// AUTO_CLOSE causes. An ordinary `gateway_final` matches none of those — so the
// commonest terminal of all was computed and written nowhere.
import { describe, expect, it } from "vitest";
import { TurnSink } from "../src/core/turn-sink.js";
import type {
  ConvexWriter,
  FinalizeStatus,
} from "../src/convex-writer.js";

const RUN = "webchat-cause";

type FinalizeOpts = { finalizeCause?: string | null } | undefined;

class CauseWriter implements ConvexWriter {
  finalizeOpts: FinalizeOpts;
  finalizeStatus: FinalizeStatus | null = null;
  pressureCalls = 0;
  async startAssistant(): Promise<string> {
    return "msg_cause_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(): Promise<void> {}
  async setSessionOverfull(): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {
    this.pressureCalls += 1;
  }
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(
    _messageId: string,
    status: FinalizeStatus,
    _text?: string,
    _error?: string | null,
    _errorKind?: string | null,
    opts?: FinalizeOpts,
  ): Promise<void> {
    this.finalizeStatus = status;
    this.finalizeOpts = opts;
  }
  async getRehydrationContext(): Promise<{
    history: string | null;
    turnCount: number;
  }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionRoster(): Promise<void> {}
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

async function closeTurn(
  final: Record<string, unknown>,
): Promise<CauseWriter> {
  const writer = new CauseWriter();
  const sink = new TurnSink("chat_cause", writer);
  await sink.beginTurn(RUN);
  // The terminal PAIR: the sink buffers `message.final` and flushes it when the
  // run's own status says the turn ended — the same order the normalizer emits.
  await sink.apply([
    final as never,
    { type: "run.status", status: "final" } as never,
  ]);
  // recordGatewayPressure is fire-and-forget — let it land before we read it.
  await new Promise((r) => setTimeout(r, 0));
  return writer;
}

describe("a turn's verdict is stored with the turn", () => {
  it("an ORDINARY success carries its cause — the case the trace channel skipped", async () => {
    const writer = await closeTurn({
      type: "message.final",
      text: "La réponse.",
      diagnosticFinalizeCause: "gateway_final",
    });
    expect(writer.finalizeStatus).toBe("complete");
    expect(writer.finalizeOpts?.finalizeCause).toBe("gateway_final");
    // …and it is NOT in the trace: a clean gateway terminal with no pre-send
    // pressure fires no pressure record at all, which is exactly why the verdict
    // had to move onto the message.
    expect(
      writer.pressureCalls,
      "a clean terminal writes no pressure trace — the old home did not exist here",
    ).toBe(0);
  });

  it("a SILENCE auto-close carries its cause too", async () => {
    const writer = await closeTurn({
      type: "message.final",
      text: "",
      status: "error",
      error: "the gateway went silent",
      errorKind: "response_timeout",
      diagnosticFinalizeCause: "lifecycle_finishing_timeout",
    });
    expect(writer.finalizeOpts?.finalizeCause).toBe(
      "lifecycle_finishing_timeout",
    );
  });

  it("a turn whose cause nobody named sends none — absence is not a made-up value", async () => {
    const writer = await closeTurn({
      type: "message.final",
      text: "La réponse.",
    });
    expect(writer.finalizeOpts?.finalizeCause).toBeUndefined();
  });

  it("the cause rides the finalize itself, so it cannot land without the turn", async () => {
    // Not a write of its own: a separate one can fail while the turn settles
    // anyway, and the message would then carry a terminal nobody can explain —
    // the exact gap this field exists to close.
    const writer = await closeTurn({
      type: "message.final",
      text: "La réponse.",
      diagnosticFinalizeCause: "gateway_final",
    });
    expect(writer.finalizeOpts).toBeDefined();
    expect(writer.finalizeStatus).not.toBeNull();
  });
});

describe("an infrastructure end says WHICH one", () => {
  // The cause slot of `endTurn` used to feed a trace, so three close paths computed
  // a precise cause (`gateway_restarting`, `connection_saturated`, `connection_lost`)
  // and then passed the generic `external` literal anyway. It is now the turn's
  // durable verdict, and writing `external` over a known class would make the
  // record lie about the one kind of incident an operator most needs to recognise
  // after the traces expire.
  it("the writer receives the computed cause, not the generic one", async () => {
    const writer = new CauseWriter();
    const sink = new TurnSink("chat_infra", writer);
    await sink.beginTurn(RUN);
    await sink.apply([
      {
        type: "message.final",
        text: "",
        status: "error",
        error: "gateway_restarting",
        errorKind: "gateway_restarting",
        diagnosticFinalizeCause: "gateway_restarting",
      } as never,
      { type: "run.status", status: "final" } as never,
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(writer.finalizeOpts?.finalizeCause).toBe("gateway_restarting");
    expect(
      writer.finalizeOpts?.finalizeCause,
      "`external` here would name the wrong thing, durably",
    ).not.toBe("external");
  });
});
