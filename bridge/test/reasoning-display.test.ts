/// <reference types="vitest" />
//
// SHOWING THE MODEL'S REASONING (0.103.0) — the bridge's links of the chain:
//   - a transcript row's `thinking` blocks become the row's `thinking` (the Control UI's
//     `extractThinking`, ui/src/lib/chat/message-extract.ts:73-90 at v2026.9.33), never its
//     text nor a block (a block would move every file's index — a file's identity);
//   - a row is told the agent's WORK NOTE (`commentary`) as the Control UI tells it
//     (`resolveAssistantReplyPhase`, ui/src/pages/chat/chat-assistant-reply.ts:20-41);
//   - the live preamble item becomes a work note once complete (tool-stream-preamble.ts);
//   - no reasoning block of any provider ever reaches the answer text;
//   - Hermes' `message.complete.reasoning` becomes the model's reasoning, its
//     `message.interim` a work note;
//   - the session's `reasoningLevel` is applied like the other knobs (admin-scoped).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  boundRowContent,
  rowIsCommentary,
  rowThinking,
  ROW_TEXT_MAX_BYTES,
  ROW_THINKING_MAX_BYTES,
  streamSegmentEntryId,
  toTranscriptRow,
} from "../src/providers/openclaw/transcript-rows.js";
import {
  completedPreamble,
  isAnswerTextPart,
  messageDisplayText,
  Normalizer,
  streamSegmentItemKey,
} from "../src/providers/openclaw/normalizer.js";
import { EVENT_REASONING, type BridgeEvent } from "../src/core/events.js";
import { applySessionSettings, parseSessionSettings } from "../src/server.js";
import { sessionPatchNeedsAdmin } from "../src/providers/openclaw/session-patch-scope.js";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import { HttpConvexWriter, type ConvexWriter } from "../src/convex-writer.js";
import type { GatewayRequester } from "../src/conf.js";
import { TurnSink } from "../src/core/turn-sink.js";
import { sleep } from "./helpers/sleep.js";

const SK = "agent:alice:atrium:chat:u-x:c1";
const meta = (id: string, seq: number) => ({ id, seq, runId: "run-1" });
const finalSig = JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" });
const commentarySig = JSON.stringify({ v: 1, id: "msg_0", phase: "commentary" });

describe("a row's reasoning (rowThinking)", () => {
  it("joins the non-empty thinking blocks, trimmed, as the Control UI's extractThinking", () => {
    expect(
      rowThinking({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "  **Plan**\n\nLire le fichier.  " },
          { type: "toolCall", id: "t1", name: "exec", arguments: {} },
          { type: "thinking", thinking: "Vérifier la date." },
        ],
      }),
    ).toEqual({ text: "**Plan**\n\nLire le fichier.\nVérifier la date.", truncated: false });
  });

  it("an EMPTY block (encrypted reasoning, gpt-6.1-sol) shows nothing — never an empty block", () => {
    expect(rowThinking({ role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Réponse" }] })).toBeNull();
    expect(rowThinking({ role: "assistant", content: [{ type: "thinking", thinking: "   " }] })).toBeNull();
    expect(rowThinking({ role: "assistant", content: "texte" })).toBeNull();
  });

  it("the gateway's display-cap sentinel is not the model's text — it is stated as a cut", () => {
    expect(rowThinking({ role: "assistant", content: [{ type: "thinking", thinking: "Début\n...(truncated)..." }] })).toEqual({ text: "Début", truncated: true });
  });

  it("a reasoning over the bound is not sent (never cut)", () => {
    const big = "x".repeat(ROW_THINKING_MAX_BYTES + 1);
    expect(rowThinking({ role: "assistant", content: [{ type: "thinking", thinking: big }] })).toBeNull();
  });
});

describe("toTranscriptRow carries the reasoning BESIDE what the row shows", () => {
  const row = (content: unknown[], extra: Record<string, unknown> = {}) =>
    toTranscriptRow({ role: "assistant", content, __openclaw: meta("e1", 3), ...extra }, undefined, { sessionKey: SK });

  it("never in the text, never in the blocks — a file keeps its block index", () => {
    const withThinking = row([
      { type: "thinking", thinking: "Je réfléchis." },
      { type: "text", text: "Voici le fichier.\nMEDIA:/home/node/.openclaw/media/outbound/a.txt", textSignature: finalSig },
    ]);
    const without = row([
      { type: "text", text: "Voici le fichier.\nMEDIA:/home/node/.openclaw/media/outbound/a.txt", textSignature: finalSig },
    ]);
    expect(withThinking?.thinking).toBe("Je réfléchis.");
    expect(withThinking?.text).not.toContain("réfléchis");
    expect(JSON.stringify(withThinking?.blocks)).not.toContain("réfléchis");
    // The identity of a `MEDIA:` file is (row, block index): the reasoning moves nothing.
    expect(withThinking?.blocks).toEqual(without?.blocks);
    expect(without?.thinking).toBeUndefined();
  });

  it("a hidden row (NO_REPLY) carries no reasoning", () => {
    expect(row([{ type: "thinking", thinking: "Rien à dire." }, { type: "text", text: "NO_REPLY" }])?.thinking).toBeUndefined();
  });

  it("only a read that asks what rows say carries it (identity reads never do)", () => {
    const identity = toTranscriptRow({ role: "assistant", content: [{ type: "thinking", thinking: "x" }], __openclaw: meta("e1", 3) });
    expect(identity?.thinking).toBeUndefined();
    expect(identity?.commentary).toBeUndefined();
  });

  it("the row's budget gives the reasoning up FIRST: what the row shows never makes room for it", () => {
    const text = "a".repeat(ROW_TEXT_MAX_BYTES - 100);
    const bounded = boundRowContent({ text, blocks: [{ type: "text", text: "b" }], thinking: "c".repeat(200) });
    expect(bounded.thinking).toBeUndefined();
    expect(bounded.text).toBe(text);
    expect(bounded.blocks).toEqual([{ type: "text", text: "b" }]);
    // …and a reasoning that fits is kept.
    expect(boundRowContent({ text: "a", blocks: [], thinking: "r" }).thinking).toBe("r");
  });
});

describe("the agent's work note (rowIsCommentary) — resolveAssistantReplyPhase", () => {
  it("a keyed stream segment is a work note, and so is its row", () => {
    const seg = { role: "assistant", content: [{ type: "text", text: "Je lance la commande." }], openclawStreamFallback: { source: "segment", itemId: "item_1" }, __openclaw: meta("e2", 4) };
    expect(rowIsCommentary(seg)).toBe(true);
    const r = toTranscriptRow(seg, undefined, { sessionKey: SK });
    expect(r?.commentary).toBe(true);
    expect(r?.entryId).toBe(streamSegmentEntryId(seg, "e2"));
  });

  it("text signed `commentary`, and no final answer, is a work note", () => {
    expect(rowIsCommentary({ role: "assistant", content: [{ type: "text", text: "Je vérifie.", textSignature: commentarySig }] })).toBe(true);
  });

  it("a final answer is never a work note — even beside commentary text (explicit phases)", () => {
    expect(rowIsCommentary({ role: "assistant", content: [{ type: "text", text: "Réponse", textSignature: finalSig }] })).toBe(false);
    expect(
      rowIsCommentary({
        role: "assistant",
        content: [
          { type: "text", text: "Je vérifie.", textSignature: commentarySig },
          { type: "text", text: "Réponse", textSignature: finalSig },
        ],
      }),
    ).toBe(false);
  });

  it("final-answer text wins over a message phase of `commentary` (mixed-phase messages keep their answer)", () => {
    expect(rowIsCommentary({ role: "assistant", phase: "commentary", content: [{ type: "text", text: "Réponse", textSignature: finalSig }] })).toBe(false);
  });

  it("an unphased row is the answer (legacy providers), a message phase decides when set", () => {
    expect(rowIsCommentary({ role: "assistant", content: [{ type: "text", text: "Réponse" }] })).toBe(false);
    expect(rowIsCommentary({ role: "assistant", phase: "commentary", content: [{ type: "text", text: "Je vérifie." }] })).toBe(true);
    expect(rowIsCommentary({ role: "user", content: [{ type: "text", text: "x", textSignature: commentarySig }] })).toBe(false);
  });
});

describe("no reasoning block ever reaches the answer text", () => {
  it("a `reasoning` / `thinking` block with a `text` is not answer text", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "SECRET_REASONING" },
        { type: "redacted_thinking", text: "SECRET_2" },
        { type: "thinking", thinking: "SECRET_3", text: "SECRET_4" },
        { type: "text", text: "La réponse." },
      ],
    };
    expect(messageDisplayText(message, SK)).toBe("La réponse.");
  });

  it("answer text types are kept, the legacy untyped part too", () => {
    expect(isAnswerTextPart({ type: "text", text: "a" })).toBe(true);
    expect(isAnswerTextPart({ type: "output_text", text: "a" })).toBe(true);
    expect(isAnswerTextPart({ text: "a" })).toBe(true);
    expect(isAnswerTextPart({ type: "reasoning", text: "a" })).toBe(false);
    expect(messageDisplayText({ role: "assistant", content: [{ text: "legacy" }] }, SK)).toBe("legacy");
  });
});

describe("the live work note: a COMPLETE preamble item (tool-stream-preamble.ts)", () => {
  it("an item still being written shows nothing; its end does, keyed like the row that persists it", () => {
    expect(completedPreamble({ kind: "preamble", phase: "update", progressText: "Je lance", itemId: "item_1" }, SK)).toBeNull();
    const note = completedPreamble({ kind: "preamble", phase: "end", progressText: "Je lance la commande.", itemId: "item_1" }, SK);
    expect(note).toEqual({ itemKey: streamSegmentItemKey("item_1"), text: "Je lance la commande." });
    // The persisted segment's entry id ends with the same key: the live note retires on it.
    const seg = { role: "assistant", content: [{ type: "text", text: "x" }], openclawStreamFallback: { source: "segment", itemId: "item_1" } };
    expect(streamSegmentEntryId(seg, "row")).toBe(`row:segment:${note!.itemKey}`);
  });

  it("NO_REPLY, an empty text, a missing item id and another kind are no note", () => {
    expect(completedPreamble({ kind: "preamble", phase: "end", progressText: "  **NO_REPLY** ", itemId: "i" }, SK)).toBeNull();
    expect(completedPreamble({ kind: "preamble", phase: "end", progressText: " ", itemId: "i" }, SK)).toBeNull();
    expect(completedPreamble({ kind: "preamble", phase: "end", progressText: "x" }, SK)).toBeNull();
    expect(completedPreamble({ kind: "tool", phase: "end", progressText: "x", itemId: "i" }, SK)).toBeNull();
  });

  it("directive tags and server paths never reach the reader", () => {
    const note = completedPreamble(
      { kind: "preamble", phase: "end", progressText: "[[reply_to_current]] Voici.\nMEDIA:/home/node/.openclaw/media/outbound/a.txt", itemId: "i" },
      SK,
    );
    expect(note?.text).not.toContain("[[");
    expect(note?.text).not.toContain("/home/node");
  });

  it("the normalizer emits it as a work note of the run, once complete", () => {
    const n = new Normalizer(SK);
    n.beginTurn(1000);
    n.noteRunStarted("run-1", 1000);
    const item = (phase: string) => ({
      event: "agent",
      payload: { runId: "run-1", sessionKey: SK, stream: "item", data: { kind: "preamble", phase, progressText: "Je lance la commande.", itemId: "item_1" } },
    });
    const notes = (ev: BridgeEvent[]) => ev.filter((e) => e.type === EVENT_REASONING);
    expect(notes(n.feed(item("update"), 1000.1))).toEqual([]);
    expect(notes(n.feed(item("end"), 1000.2))).toEqual([
      { type: EVENT_REASONING, text: "Je lance la commande.", nature: "commentary", itemKey: streamSegmentItemKey("item_1"), runId: "run-1", recvAt: 1000.2 },
    ]);
  });
});

// Codex pass 5 on 0.103.0: with the projection on, a sent OpenClaw turn opens its bubble
// only on visible content (run-manager.ts `openOnActivity`). A work note IS visible: alone,
// it opens the bubble and is written at once, not buffered until the next tool or text.
describe("a work note opens a deferred bubble (turn-sink.ts eventIsVisible)", () => {
  function recordingWriter() {
    const calls: string[] = [];
    const writer = new Proxy({} as ConvexWriter, {
      get: (_t, name) => async (...args: unknown[]) => {
        calls.push(String(name));
        if (name === "startAssistant") return "msg-1";
        if (name === "addReasoningPart") calls.push(`note:${String(args[1])}:${String((args[2] as { nature?: string } | undefined)?.nature)}`);
        return undefined;
      },
    });
    return { writer, calls };
  }
  async function deferredSink() {
    const { writer, calls } = recordingWriter();
    const sink = new TurnSink("chat_1", writer);
    await sink.beginTurn("run-1", undefined, true, false, null, { projection: true, openOnActivity: true });
    return { sink, calls };
  }

  it("a complete preamble alone opens the bubble and writes its note", async () => {
    const { sink, calls } = await deferredSink();
    expect(calls).not.toContain("startAssistant");
    await sink.apply([{ type: EVENT_REASONING, text: "Je lance la commande.", nature: "commentary", itemKey: "seg:item_1", runId: "run-1" }]);
    expect(calls).toContain("startAssistant");
    expect(calls).toContain("note:Je lance la commande.:commentary");
  });

  it("the model's reasoning alone, an empty note or a NO_REPLY note open nothing", async () => {
    for (const ev of [
      { type: EVENT_REASONING, text: "Je réfléchis.", nature: "thinking", runId: "run-1" },
      { type: EVENT_REASONING, text: "   ", nature: "commentary", runId: "run-1" },
      { type: EVENT_REASONING, text: "NO_REPLY", nature: "commentary", runId: "run-1" },
    ]) {
      const { sink, calls } = await deferredSink();
      await sink.apply([ev]);
      expect(calls).not.toContain("startAssistant");
    }
  });
});

describe("the session's reasoningLevel is a knob like the others", () => {
  it("parsed only as on/off; anything else is no intent", () => {
    expect(parseSessionSettings({ reasoningLevel: "on" })).toMatchObject({ reasoningLevel: "on" });
    expect(parseSessionSettings({ reasoningLevel: "off" })).toMatchObject({ reasoningLevel: "off" });
    expect(parseSessionSettings({ reasoningLevel: "stream" })).toBeNull();
    expect(parseSessionSettings({ showReasoning: true })).toBeNull();
  });

  it("applied by sessions.patch before the turn, admin-scoped upstream", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const conn: GatewayRequester = {
      request: async (method, params) => {
        calls.push({ method, params });
        return { payload: {} };
      },
    };
    await applySessionSettings(conn, SK, { reasoningLevel: "on" });
    expect(calls).toEqual([{ method: "sessions.patch", params: { key: SK, reasoningLevel: "on" } }]);
    expect(sessionPatchNeedsAdmin({ key: SK, reasoningLevel: "on" })).toBe(true);
  });
});

describe("Hermes: the model's reasoning and the agent's work note", () => {
  async function wsTurn(emit: (send: (t: string, p: Record<string, unknown>) => void) => void) {
    const parts: Array<{ text: string; opts?: Record<string, unknown> }> = [];
    const order: string[] = [];
    const client = {
      call: async (method: string) => {
        if (method === "session.create") return { session_id: "s1", stored_session_id: "st1" };
        if (method === "prompt.submit") return { status: "streaming" };
        return {};
      },
    } as unknown as HermesWsClient;
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addPart: async () => {},
      addToolPart: async () => {},
      addReasoningPart: async (_id: string, text: string, opts?: Record<string, unknown>) => {
        parts.push({ text, opts });
        order.push(`reasoning:${String(opts?.nature)}`);
      },
      setPhase: () => {},
      finalize: async () => {
        order.push("finalize");
      },
      reportSessionMeta: async () => {},
      heartbeat: async () => {},
      upsertSubAgent: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    } as unknown as ConvexWriter;
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      { client, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "q" },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    emit(lane);
    await run.done;
    return { parts, order };
  }

  it("message.complete.reasoning is the model's reasoning, written BEFORE the bubble settles", async () => {
    const { parts, order } = await wsTurn((send) => {
      send("message.delta", { text: "Réponse" });
      send("message.complete", { text: "Réponse", status: "complete", reasoning: "  Je compare les deux options.  " });
    });
    expect(parts).toEqual([{ text: "Je compare les deux options.", opts: { nature: "thinking" } }]);
    expect(order).toEqual(["reasoning:thinking", "finalize"]);
  });

  it("no reasoning, an empty one or a failed turn: nothing", async () => {
    for (const payload of [
      { text: "ok", status: "complete" },
      { text: "ok", status: "complete", reasoning: "   " },
      { text: "", status: "error", error: "boom", reasoning: "x" },
    ]) {
      const { parts } = await wsTurn((send) => send("message.complete", payload));
      expect(parts).toEqual([]);
    }
  });

  it("message.interim is a work note, placed in the narrative", async () => {
    const { parts } = await wsTurn((send) => {
      send("message.delta", { text: "Début.\n" });
      send("message.interim", { text: "Je vérifie la configuration.", already_streamed: false });
      send("message.complete", { text: "Début.\nFin.", status: "complete" });
    });
    expect(parts).toEqual([{ text: "Je vérifie la configuration.", opts: { nature: "commentary", textOffset: "Début.\n".length } }]);
  });
});

// Codex pass 7: the send path's describe names the session it described, so Convex trusts
// that meta for this session only (convex/lib/reasoningDisplay.ts metaDescribesSession).
describe("the send's meta names its session (server.ts, comment-stripped source pin)", () => {
  it("performSend publishes the described meta with its session key", () => {
    const src = readFileSync(join(__dirname, "../src/server.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).toContain("{ chatId: body.chatId, connection: conn, agentId: body.agentId, sessionKey },");
  });
});

// Codex pass 9: the reasoning part rides the SAME batch as the final text and the terminal
// (message.complete.reasoning); a failed write of it must cost neither.
describe("a failed reasoning write never costs the reply (turn-sink.ts, real writer)", () => {
  it("the writer answers 503 to the reasoning part: the text and the terminal still land", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      sent.push(body);
      const part = body.part as { kind?: string } | undefined;
      if (body.op === "addPart" && part?.kind === "reasoning") {
        return { ok: false, status: 503, statusText: "Service Unavailable", text: async () => "busy", json: async () => ({}) } as unknown as Response;
      }
      const ack =
        body.op === "startAssistant" ? { messageId: "m1", rec: { recording: false, sessionId: null } } : body.op === "finalize" ? { ok: true, transitioned: true } : { ok: true };
      return { ok: true, status: 200, json: async () => ack } as unknown as Response;
    }) as unknown as typeof fetch;
    const writer = new HttpConvexWriter({ convexHttpActionsUrl: "http://test.invalid", ingestSecret: "s", deltaFlushMs: 5, fetchImpl });
    const client = {
      call: async (method: string) => {
        if (method === "session.create") return { session_id: "s1", stored_session_id: "st1" };
        if (method === "prompt.submit") return { status: "streaming" };
        return {};
      },
    } as unknown as HermesWsClient;
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const run = runHermesWsTurn(
      { client, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "q" },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    lane("message.complete", { text: "Réponse complète.", status: "complete", reasoning: "Je compare." });
    await run.done;
    await sleep(60);
    expect(sent.some((b) => b.op === "addPart" && (b.part as { kind?: string }).kind === "reasoning")).toBe(true);
    // The final text rides the terminal itself.
    expect(sent.filter((b) => b.op === "finalize")).toEqual([
      expect.objectContaining({ op: "finalize", messageId: "m1", status: "complete", text: "Réponse complète." }),
    ]);
  });
});
