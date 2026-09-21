// THE SENTENCE THE AGENT WROTE AND NOBODY SAW.
//
// `sessions_yield` takes two strings, and upstream's schema says they are
// opposites (src/agents/tools/sessions-yield-tool.ts:25-31):
//   `message`        — "Private context for the resumed turn; not sent to the user."
//   `acknowledgment` — "Optional waiting reply for an otherwise-silent interactive
//                       parent turn."
//
// A parent that hands off answers nothing of its own, so the bubble arrives with a
// plan card, a sub-agent card, and not one word. The agent HAD written the word:
// production, 2026-09-20 — "Les trois propositions de la page 4 sont en préparation.
// Je te les livre ici après contrôle." It never reached the reader, because the
// gateway does not put it on the lifecycle terminal (agent-job.ts carries `yielded`
// and not this) and nothing here read the tool call's own arguments.

import { describe, expect, it } from "vitest";

import type { ConvexWriter, FinalizeStatus, ToolPart } from "../src/convex-writer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";

const SK = "agent:main:atrium:chat:u-test:c-1";
const RUN = "webchat-yield-run";

class CaptureWriter implements ConvexWriter {
  readonly finals: { status: FinalizeStatus; text: string }[] = [];
  /** RECORDED, not discarded. Dropping these made the privacy assertion below
   *  vacuous: it only ever read the reply TEXT, while the leak was in the
   *  PERSISTED tool part the chat renders. */
  readonly toolParts: ToolPart[] = [];
  async startAssistant(): Promise<string> {
    return "msg_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_m: string, p: ToolPart): Promise<void> {
    this.toolParts.push(p);
  }
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async noteFrameGap(): Promise<void> {}
  async finalize(
    _messageId: string,
    status: FinalizeStatus,
    text: string,
  ): Promise<void> {
    this.finals.push({ status, text });
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

const ACK = "Les trois propositions sont en préparation. Je te les livre ici après contrôle.";
const PRIVATE = "Attendre la livraison puis vérifier les fichiers.";

/** The real wire shape: an `agent` frame on the `tool` stream, arguments under
 *  `args` — exactly as the live bench captures it. */
const agentTool = (data: Record<string, unknown>) => ({
  type: "event" as const,
  event: "agent",
  payload: { runId: RUN, sessionKey: SK, stream: "tool", data },
});

const yieldTool = (
  args: Record<string, unknown>,
  /** The gateway's PAYLOAD. A refusal comes back through `jsonResult` with no
   *  `isError`, so it is a successful call carrying `{status:"error"}` — the
   *  default here is the success it used to be assumed to always be. */
  result: unknown = { details: { status: "yielded" } },
) => [
  agentTool({ phase: "start", name: "sessions_yield", toolCallId: "y1", args }),
  agentTool({
    phase: "result",
    name: "sessions_yield",
    toolCallId: "y1",
    args,
    result,
  }),
];

/** The lifecycle terminal, shape as captured on the live bench: a silent turn is
 *  closed by THIS, not by an empty `chat` final. */
const lifecycleEnd = () => ({
  type: "event" as const,
  event: "agent",
  payload: {
    runId: RUN,
    sessionKey: SK,
    stream: "lifecycle",
    data: {
      phase: "end",
      stopReason: "stop",
      aborted: false,
      livenessState: "working",
      yielded: true,
      startedAt: 1000,
      endedAt: 2000,
    },
  },
});

const finalFrame = (text: string) => ({
  type: "event" as const,
  event: "chat",
  payload: {
    runId: RUN,
    sessionKey: SK,
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text }] },
  },
});

async function runTurn(frames: unknown[]): Promise<CaptureWriter> {
  const writer = new CaptureWriter();
  const manager = new RunManager("chat-1", SK, writer);
  await manager.beginTurn(1000, RUN);
  let t = 1010;
  for (const f of frames) await manager.feed(f as never, (t += 10));
  // A yielded turn produces no `chat` final of its own: the lifecycle terminal
  // arms a grace and the turn settles on its expiry. `endTurn` is that expiry,
  // called explicitly so the test does not race a real timer.
  await manager.endTurn(t + 10, "final", null, "recv_timeout");
  await new Promise((r) => setTimeout(r, 0));
  return writer;
}

describe("a hand-off speaks with the acknowledgment it was given", () => {
  it("an otherwise-silent parent shows the waiting reply", async () => {
    const w = await runTurn([
      ...yieldTool({ message: PRIVATE, acknowledgment: ACK }),
      lifecycleEnd(),
    ]);
    expect(w.finals).toHaveLength(1);
    expect(w.finals[0]?.text).toBe(ACK);
  });

  it("the PRIVATE `message` is never shown, whatever else happens", async () => {
    // Upstream states it outright: private context for the resumed turn. Leaking
    // it would put the parent's internal instruction to itself in front of the
    // user — pinned separately from the happy path because it is the one mistake
    // here that cannot be walked back.
    const w = await runTurn([
      ...yieldTool({ message: PRIVATE, acknowledgment: ACK }),
      lifecycleEnd(),
    ]);
    expect(w.finals[0]?.text).not.toContain(PRIVATE);
    // AND it is not in the stored tool part either — which is where it actually
    // was: the chat renders `input` in a <pre>, lifts a preview into the header
    // and prints the output. Serialized whole so a value nested anywhere in the
    // payload cannot slip past a key-by-key check.
    const yieldPart = w.toolParts.find((p) => p.name === "sessions_yield");
    expect(yieldPart, "the yield must still be recorded as a card").toBeDefined();
    expect(JSON.stringify(yieldPart)).not.toContain(PRIVATE);
    // The acknowledgment is NOT collateral damage: showing it is its purpose.
    expect(JSON.stringify(yieldPart)).toContain(ACK);
  });

  it("an acknowledgment of NO_REPLY is SILENCE, not the word", async () => {
    // `NO_REPLY` is the protocol sentinel for "say nothing" — the gateway's own
    // spawn note tells the agent to answer exactly that when a child completion
    // lands after its final answer. The reply text is checked for it BEFORE the
    // acknowledgment is promoted into that text, so this road bypassed the check
    // and would have settled a bubble reading "NO_REPLY".
    const w = await runTurn([
      ...yieldTool({ message: PRIVATE, acknowledgment: "NO_REPLY" }),
      lifecycleEnd(),
    ]);
    expect(w.finals[0]?.text).toBe("");
  });

  it("a REFUSED yield is not a hand-off — the phase alone lied", async () => {
    // A gateway that refuses a yield answers through `jsonResult`, which sets no
    // `isError`: the refusal arrives as a SUCCESSFUL call in phase "completed"
    // carrying `{status:"error"}`. Read as a hand-off, it exempted the
    // empty-response guard AND promoted the acknowledgment into the reply — a turn
    // that delegated nothing settling as a calm "I'm on it", with no error and no
    // anomaly anywhere.
    const w = await runTurn([
      ...yieldTool(
        { message: PRIVATE, acknowledgment: ACK },
        {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "No pending child completion is owned by this turn.",
              }),
            },
          ],
          details: {
            status: "error",
            error: "No pending child completion is owned by this turn.",
          },
        },
      ),
      lifecycleEnd(),
    ]);
    expect(
      w.finals[0]?.text,
      "nothing was handed off, so nothing may speak for it",
    ).not.toBe(ACK);
  });

  it("a yield with NO acknowledgment stays silent — nothing is invented", async () => {
    const w = await runTurn([
      ...yieldTool({ message: PRIVATE }),
      lifecycleEnd(),
    ]);
    expect(w.finals[0]?.text).toBe("");
  });

  it("text the model actually WROTE wins — the acknowledgment never appends", async () => {
    // The condition is upstream's own: "an otherwise-silent … parent turn". A
    // parent that spoke has already answered; adding the waiting line after it
    // would read as a contradiction ("here it is" followed by "it is coming").
    const w = await runTurn([
      ...yieldTool({ message: PRIVATE, acknowledgment: ACK }),
      finalFrame("Voici le résultat."),
    ]);
    expect(w.finals[0]?.text).toBe("Voici le résultat.");
  });

  it("a BLANK acknowledgment is not a reply", async () => {
    const w = await runTurn([
      ...yieldTool({ message: PRIVATE, acknowledgment: "   " }),
      lifecycleEnd(),
    ]);
    expect(w.finals[0]?.text).toBe("");
  });

  it("a yield that did NOT complete carries nothing", async () => {
    // A started-but-unfinished yield handed off to no one; its acknowledgment
    // describes a wait that is not happening.
    const w = await runTurn([
      agentTool({
        phase: "start",
        name: "sessions_yield",
        toolCallId: "y1",
        args: { acknowledgment: ACK },
      }),
      lifecycleEnd(),
    ]);
    expect(w.finals[0]?.text).toBe("");
  });
});
