// Positional `sessions.get` readers (the `/lossless` route), pinned against the
// bench-captured transcript shapes; and the normalizer's message-tool diagnostics.
import { describe, expect, it } from "vitest";
import {
  extractLatestAssistantReply,
  isRestartRecoveryResumeEntry,
} from "../src/providers/openclaw/history-recovery.js";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";

// -- normalizer wiring --------------------------------------------------------

const KEY = "agent:agent-a:atrium:chat:u-x:chat1";

describe("extractLatestAssistantReply (restart-recovery transcript scan)", () => {
  it("returns the assistant reply AFTER the last user entry", () => {
    const payload = {
      messages: [
        { role: "user", content: "vieille question" },
        { role: "assistant", content: "vieille réponse" },
        { role: "user", content: "question du tour" },
        { role: "toolResult", toolName: "exec", content: "sortie outil" },
        { role: "assistant", content: [{ text: "réponse du run repris" }] },
      ],
    };
    expect(extractLatestAssistantReply(payload)).toBe("réponse du run repris");
  });

  it("returns empty while the resumed run has not answered yet (no assistant after user)", () => {
    const payload = {
      messages: [
        { role: "assistant", content: "réponse du tour PRÉCÉDENT" },
        { role: "user", content: "question du tour" },
        { role: "toolResult", toolName: "exec", content: "en cours" },
      ],
    };
    expect(extractLatestAssistantReply(payload)).toBe("");
  });

  it("never leaks a PREVIOUS turn's reply (user boundary respected)", () => {
    const payload = {
      messages: [
        { role: "assistant", content: "ancienne réponse" },
        { role: "user", content: "nouvelle question" },
      ],
    };
    expect(extractLatestAssistantReply(payload)).toBe("");
  });

  it("a FAILED attempt's entry (stopReason: error) is never the reply", () => {
    // 2026.9.3+ (read at v2026.9.4) persists a failed run's partial text as an assistant entry marked
    // `stopReason: "error"` (upstream assistant-error-transcript.ts). Read as a reply, a
    // resumed run that failed would be delivered complete, made of its truncated attempt.
    expect(
      extractLatestAssistantReply({
        messages: [
          { role: "user", content: "question du tour" },
          {
            role: "assistant",
            content: [{ type: "text", text: "début de réponse coup" }],
            stopReason: "error",
          },
        ],
      }),
    ).toBe("");
    // A real reply beside it still comes back, alone.
    expect(
      extractLatestAssistantReply({
        messages: [
          { role: "user", content: "question du tour" },
          { role: "assistant", content: "réponse", stopReason: "stop" },
          { role: "assistant", content: "tentative coupée", stopReason: "error" },
        ],
      }),
    ).toBe("réponse");
  });

  it("joins multiple assistant entries chronologically; tolerates malformed payloads", () => {
    expect(
      extractLatestAssistantReply({
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "partie 1" },
          { role: "assistant", content: "partie 2" },
        ],
      }),
    ).toBe("partie 1\n\npartie 2");
    expect(extractLatestAssistantReply(null)).toBe("");
    expect(extractLatestAssistantReply({ messages: "garbage" })).toBe("");
  });
});

// --- The gateway's own restart-recovery resume prompt is not a turn boundary ---
// Measured on the bench (OpenClaw 2026.9.4, forced restart while a reply streamed): the
// transcript becomes the user entry, then a `user` entry holding the gateway's resume prompt
// with `provenance {kind: "internal_system", sourceTool: "main_session_restart_recovery"}` and
// none of the user's text, then the resumed reply. Read as a boundary, that entry hid the
// answer from the recovery: the anchor never matched again and the turn settled as an error.
describe("restart-recovery resume prompt (2026.9.4 transcript shape)", () => {
  const resumeEntry = (extra: Record<string, unknown> = {}) => ({
    role: "user",
    content:
      "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
    provenance: {
      kind: "internal_system",
      sourceSessionKey: "agent:alice:atrium:chat:u:c",
      sourceTool: "main_session_restart_recovery",
      ...extra,
    },
  });

  it("is recognised by its provenance, and nothing else is", () => {
    expect(isRestartRecoveryResumeEntry(resumeEntry())).toBe(true);
    // Upstream normalizes the tool name (input-provenance.ts): so does the reader.
    expect(isRestartRecoveryResumeEntry(resumeEntry({ sourceTool: "  Main_Session_Restart_Recovery " }))).toBe(true);
    // Another internal_system source is a DIFFERENT turn's input, and a real user entry is a
    // real boundary: neither may be skipped.
    expect(isRestartRecoveryResumeEntry(resumeEntry({ sourceTool: "sessions_spawn" }))).toBe(false);
    expect(isRestartRecoveryResumeEntry({ ...resumeEntry(), provenance: { kind: "inter_session", sourceTool: "main_session_restart_recovery" } })).toBe(false);
    expect(isRestartRecoveryResumeEntry({ role: "user", content: "question" })).toBe(false);
    expect(isRestartRecoveryResumeEntry({ ...resumeEntry(), role: "assistant" })).toBe(false);
    expect(isRestartRecoveryResumeEntry(null)).toBe(false);
  });

  it("the reply of the resumed run is read, joined with what the interrupted run had committed", () => {
    expect(
      extractLatestAssistantReply({
        messages: [
          { role: "user", content: "analyse ça s'il te plaît" },
          { role: "assistant", content: [{ text: "début avant la coupure" }], stopReason: "toolUse" },
          resumeEntry(),
          { role: "assistant", content: [{ text: "suite après le redémarrage" }], stopReason: "stop" },
        ],
      }),
    ).toBe("début avant la coupure\n\nsuite après le redémarrage");
    // The PREVIOUS turn stays out: a real user entry still ends the scan.
    expect(
      extractLatestAssistantReply({
        messages: [
          { role: "assistant", content: "réponse du tour précédent" },
          { role: "user", content: "analyse ça s'il te plaît" },
          resumeEntry(),
          { role: "assistant", content: [{ text: "réponse reprise" }], stopReason: "stop" },
        ],
      }),
    ).toBe("réponse reprise");
  });

  it("what the interrupted run committed is NOT the reply while the resumed run is silent", () => {
    // The prompt is crossed only once the resumed run has written something. Otherwise the
    // fragment the interrupted run had committed would finalize the turn as the answer, and
    // the real reply arriving seconds later would be dropped (codex).
    expect(
      extractLatestAssistantReply({
        messages: [
          { role: "user", content: "analyse ça s'il te plaît" },
          { role: "assistant", content: [{ text: "début avant la coupure" }], stopReason: "toolUse" },
          resumeEntry(),
        ],
      }),
    ).toBe("");
    // The resumed run has STARTED but not answered: its own `toolUse` fragment is not an
    // answer either, and neither is the text committed before the restart (codex).
    expect(
      extractLatestAssistantReply({
        messages: [
          { role: "user", content: "analyse ça s'il te plaît" },
          { role: "assistant", content: [{ text: "début avant la coupure" }], stopReason: "toolUse" },
          resumeEntry(),
          { role: "assistant", content: [{ text: "je vérifie les journaux" }], stopReason: "toolUse" },
          { role: "toolResult", toolName: "exec", content: "sortie" },
        ],
      }),
    ).toBe("");
    // FAIL-CLOSED (codex): a shape whose stopReason is absent, null or unknown is not proof
    // that the resumed run finished — only an explicit terminal one is.
    for (const stopReason of [undefined, null, "weird", "aborted"]) {
      expect(
        extractLatestAssistantReply({
          messages: [
            { role: "user", content: "analyse ça s'il te plaît" },
            { role: "assistant", content: [{ text: "début avant la coupure" }], stopReason: "toolUse" },
            resumeEntry(),
            { role: "assistant", content: [{ text: "je vérifie les journaux" }], ...(stopReason === undefined ? {} : { stopReason }) },
          ],
        }),
        String(stopReason),
      ).toBe("");
    }
    // Two restarts in a row, still silent: same answer.
    expect(
      extractLatestAssistantReply({
        messages: [
          { role: "user", content: "analyse ça s'il te plaît" },
          { role: "assistant", content: [{ text: "début avant la coupure" }], stopReason: "toolUse" },
          resumeEntry(),
          resumeEntry(),
        ],
      }),
    ).toBe("");
  });

});

// --- G-16: an unreadable message-tool call is never silent -------------------
// The message tool IS the visible-reply mechanism. When its `args` cannot be
// read, the reply text may exist only in the transcript — the same situation as
// a gateway-run message tool, so it must arm the same recovery, and it must NAME
// itself if the turn still ends with nothing.
const toolStartFrame = (args: unknown) => ({
  type: "event",
  event: "agent",
  payload: {
    sessionKey: KEY,
    stream: "tool",
    data: { name: "message", phase: "start", args },
  },
});

describe("an INTER-SESSION entry inside a turn (2026.9.4)", () => {
  // A subagent announce or settle, a media generation, a harness completion, an inter-session
  // send: the gateway files them in the requester's transcript as `user` entries with
  // inter_session provenance. Some are STEERED INTO the running turn, others START a delivery
  // turn of their own — and the transcript does not separate them (codex passes 5 to 9): the
  // provenance is shared, and the idempotency key that differs is built by prefixing a
  // caller-supplied announce id, so `…:active-wake` is a shape anyone can produce. None of them
  // is crossed, and a turn bounded by one recovers NOTHING: a delay, never another turn's words.
  const interSession = (sourceTool: string, extra: Record<string, unknown> = {}) => ({
    role: "user",
    content: "Child complete",
    provenance: { kind: "inter_session", sourceTool },
    ...extra,
  });
  const resumePrompt = {
    role: "user",
    content: "[System] Your previous turn was interrupted by a gateway restart…",
    provenance: {
      kind: "internal_system",
      sourceTool: "main_session_restart_recovery",
    },
  };
  const turnEndedBy = (entry: Record<string, unknown>) => ({
    messages: [
      { role: "user", content: "question utilisateur suffisamment longue" },
      { role: "assistant", stopReason: "stop", content: "réponse du tour utilisateur" },
      entry,
      { role: "assistant", stopReason: "stop", content: "réponse du nouveau tour autonome" },
    ],
  });

  it("ends the turn: NOTHING after it is read as this turn's reply", () => {
    const payload = turnEndedBy(
      interSession("subagent_announce", {
        __openclaw: { idempotencyKey: "announce:v1:child:run-7:active-wake" },
      }),
    );
    // And the text after it — a complete, terminal reply — belongs to whatever that entry
    // started. Returning it is the inter-turn corruption this rule exists to prevent.
    expect(extractLatestAssistantReply(payload)).toBe("");
  });

  it("codex pass 9: a CALLER-CRAFTED `:active-wake` key changes nothing", () => {
    // The harness takes its announce id as a plain string and the key is that id prefixed, so a
    // delivery turn of its own can end exactly like the steer does. Keying on the suffix read
    // this autonomous turn as a continuation and merged two turns.
    const payload = turnEndedBy(
      interSession("agent_harness_task", {
        __openclaw: { idempotencyKey: "announce:harness:job:active-wake" },
      }),
    );
    expect(extractLatestAssistantReply(payload)).toBe("");
  });

  it("settle, direct announce, durable media handoff, plain send: all the same", () => {
    for (const entry of [
      interSession("subagent_settle", { __openclaw: { idempotencyKey: "announce:v1:c:r" } }),
      interSession("subagent_announce", { __openclaw: { idempotencyKey: "announce:v1:c:r" } }),
      interSession("image_generate", {
        __openclaw: { idempotencyKey: "announce:v1:c:r:agent-loop" },
      }),
      interSession("sessions_send"),
    ]) {
      const payload = turnEndedBy(entry);
      expect(extractLatestAssistantReply(payload)).toBe("");
    }
  });

  it("under a resume prompt it still stops the recovery, answered or not", () => {
    // The resumed run may well have finished; the entry between it and the prompt is one this
    // reader cannot attribute, so the turn keeps no recoverable text (codex pass 4's sequence,
    // answered the fail-closed way).
    for (const stopReason of ["toolUse", "stop"]) {
      const payload = {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", stopReason: "toolUse", content: "avant coupure" },
          resumePrompt,
          interSession("subagent_announce", {
            __openclaw: { idempotencyKey: "announce:v1:c:r:active-wake" },
          }),
          { role: "assistant", stopReason, content: "texte du tour inconnu" },
        ],
      };
      expect(extractLatestAssistantReply(payload)).toBe("");
    }
  });

  it("the resume prompt itself is still crossed — the one shape that IS proven", () => {
    const payload = {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", stopReason: "toolUse", content: "avant coupure" },
        resumePrompt,
        { role: "assistant", stopReason: "stop", content: "réponse reprise" },
      ],
    };
    expect(extractLatestAssistantReply(payload)).toBe("avant coupure\n\nréponse reprise");
  });
});

describe("G-16: message-tool args we cannot read", () => {
  it("the final event carries the unreadable count so the empty verdict can NAME its cause", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(toolStartFrame("]not json at all["), 1);
    const ev = n.endTurn(3, "final", null, "recv_timeout");
    const final = ev.find((e) => e.type === "message.final");
    expect(final).toMatchObject({ msgtoolArgsUnreadable: 1 });
  });

  it("a new turn clears the count (turn N must not label turn N+1)", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(toolStartFrame("]not json at all["), 1);
    n.beginTurn(4);
    n.noteRunStarted("r2", 4);
    const final = n.endTurn(5, "final", null, "recv_timeout").find(
      (e) => e.type === "message.final",
    );
    expect(final).toMatchObject({ msgtoolArgsUnreadable: 0 });
  });
});

// --- G-13: a final the gateway already CUT ----------------------------------
// `broadcastChatFinal` runs the reply through the DISPLAY projection, whose cap
// is 8 000 chars + the marker below (verified in the deployed 2026.7.1 build).
// The cut text is a live overlay like any other: the turn closes on the gateway's
// terminal, and the durable row — whole — replaces it when the run settles.
const MARKER = "\n...(truncated)...";

const truncatedFinalFrame = (runId: string, body: string) => ({
  type: "event",
  event: "chat",
  payload: {
    runId,
    sessionKey: KEY,
    seq: 9,
    state: "final",
    message: {
      role: "assistant",
      content: [{ type: "text", text: body + MARKER }],
    },
  },
});

describe("G-13: a gateway-truncated chat final", () => {
  it("is shown and closes the turn like any final (the durable row is whole)", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    const ev = n.feed(truncatedFinalFrame("r1", "a".repeat(8000)), 1);
    const snap = ev.find((e) => e.type === "message.snapshot");
    expect(String(snap?.text ?? "").length).toBeGreaterThan(8000);
    expect(n.finalized).toBe(true);
    expect(n.nextTimeout(2)).toBeNull();
  });
});
