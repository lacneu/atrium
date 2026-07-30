/// <reference types="vitest" />
//
// The gateway's verdict on a tool's OUTPUT (lot 42 — G-51).
//
// Hermes scans what a tool returned and emits `tool.output_risk`: a risk level, the pattern
// ids it matched, and whether it REDACTED something before the model saw it. Atrium dropped
// the event, so a redaction performed on the user's behalf was invisible and a high-risk
// result looked like any other.
//
// Content-free BY CONSTRUCTION, verified rather than assumed: upstream's scanner appends a
// pattern IDENTIFIER (`pid`) or an `invisible_unicode_U+XXXX` label — never the matched
// text. That is what makes the verdict safe to store as-is.
//
// It rides the SAME part as the call it judges: `toolCallId` is the upsert key, so the
// verdict lands on that card rather than opening a second one.

import { describe, expect, it } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter } from "../src/convex-writer.js";

type Part = {
  name?: string;
  phase?: string;
  toolCallId?: string;
  risk?: { level: string; findings: string[]; redacted: boolean };
};

async function turnWith(
  emit: (send: (t: string, p: Record<string, unknown>) => void) => void,
) {
  const parts: Part[] = [];
  const client = {
    call: async (method: string) => {
      if (method === "session.create") {
        return { session_id: "rt-1", stored_session_id: "20260706_212939_aee24e" };
      }
      if (method === "prompt.submit") return { status: "streaming" };
      return {};
    },
  } as unknown as HermesWsClient;
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async (_id: string, part: Part) => {
      parts.push(part);
    },
    addReasoningPart: async () => {},
    setPhase: () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    heartbeat: async () => {},
    upsertSubAgent: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  let lane!: (t: string, p: Record<string, unknown>) => void;
  const run = runHermesWsTurn(
    {
      client,
      writer,
      chatId: "c1",
      sessionKey: "k",
      providerChatId: null,
      text: "lis cette page",
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  emit(lane);
  lane("message.complete", { text: "voilà", status: "complete" });
  await run.done;
  return parts;
}

describe("a risk verdict reaches the card it is about", () => {
  it("carries the level, the pattern ids and the redaction flag", async () => {
    const parts = await turnWith((send) =>
      send("tool.output_risk", {
        tool_id: "call_42",
        name: "web_fetch",
        risk: "high",
        findings: ["prompt_injection_imperative", "invisible_unicode_U+200B"],
        redacted: true,
      }),
    );
    const card = parts.find((p) => p.risk !== undefined);
    expect(card, "the whole event used to be dropped").toBeDefined();
    // The SAME KEY the lifecycle uses (`hws:<native id>`), so this UPSERTS onto the
    // existing card instead of opening a second one. Sending the raw id was a real
    // regression my fake writer could not see, because it collects parts instead of
    // upserting them.
    expect(card!.toolCallId).toBe("hws:call_42");
    expect(card!.name).toBe("web_fetch");
    expect(card!.risk!.level).toBe("high");
    expect(card!.risk!.findings).toEqual([
      "prompt_injection_imperative",
      "invisible_unicode_U+200B",
    ]);
    expect(card!.risk!.redacted).toBe(true);
  });

  it("a verdict with no tool id is dropped — it would open a card of its own", async () => {
    const parts = await turnWith((send) =>
      send("tool.output_risk", { name: "web_fetch", risk: "high" }),
    );
    expect(parts.filter((p) => p.risk !== undefined)).toEqual([]);
  });

  it("a missing risk level defaults to low, not to nothing", async () => {
    // Upstream defaults the same way (`metadata.get("risk") or "low"`). A verdict without a
    // level is still a verdict — it says a scan RAN.
    const parts = await turnWith((send) =>
      send("tool.output_risk", { tool_id: "c1", name: "exec", findings: [] }),
    );
    const card = parts.find((p) => p.risk !== undefined)!;
    expect(card.risk!.level).toBe("low");
    expect(card.risk!.redacted).toBe(false);
  });

  it("a label outside the scanner's SHAPES is refused, not truncated", async () => {
    // A type check plus a length cap was not the promise: it let a divergent gateway store
    // sixteen arbitrary fragments under the word "findings" (raised in review). Only the
    // two shapes upstream can produce are kept — a pattern identifier, or an
    // `invisible_unicode_U+XXXX` label.
    const parts = await turnWith((send) =>
      send("tool.output_risk", {
        tool_id: "c1",
        name: "exec",
        risk: "high",
        findings: [
          "prompt_injection_imperative",
          "invisible_unicode_U+200B",
          "Jean Dupont, 12 rue des Lilas",
          "x".repeat(200),
        ],
      }),
    );
    const card = parts.find((p) => p.risk !== undefined)!;
    expect(card.risk!.findings.slice(0, 2)).toEqual([
      "prompt_injection_imperative",
      "invisible_unicode_U+200B",
    ]);
    // …and what was refused is COUNTED, because "a scan found things we could not name" is
    // a fact worth keeping while the strings themselves are what the rule forbids.
    expect(card.risk!.findings[2]).toBe("«unnamed»×2");
  });

  it("an UNKNOWN level is named unknown, not stored verbatim", async () => {
    const parts = await turnWith((send) =>
      send("tool.output_risk", {
        tool_id: "c1",
        name: "exec",
        risk: "catastrophique-selon-le-gateway",
        findings: [],
      }),
    );
    expect(parts.find((p) => p.risk !== undefined)!.risk!.level).toBe("unknown");
  });

  it("the count of findings is still bounded", async () => {
    const parts = await turnWith((send) =>
      send("tool.output_risk", {
        tool_id: "c1",
        name: "exec",
        risk: "high",
        findings: Array.from({ length: 40 }, (_, i) => `pattern_${i}`),
      }),
    );
    const f = parts.find((p) => p.risk !== undefined)!.risk!.findings;
    expect(f.length).toBe(17); // 16 kept + the refusal count
    expect(f[16]).toBe("«unnamed»×24");
  });

  it("a non-string finding is refused, not coerced", async () => {
    const parts = await turnWith((send) =>
      send("tool.output_risk", {
        tool_id: "c1",
        name: "exec",
        findings: ["ok", 42, null],
      }),
    );
    const card = parts.find((p) => p.risk !== undefined)!;
    expect(card.risk!.findings).toEqual(["ok"]);
  });
});
