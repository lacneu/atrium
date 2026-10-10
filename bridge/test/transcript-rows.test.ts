// The transcript readers (redesign phase 1): identity facts, the Control UI's display
// predicates and the `chat.history` reply envelopes — each pinned against the upstream
// rule it mirrors, and against two REAL 2026.9.6 tail pages
// (fixtures/transcript-history-2026.9.6.json).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  normalizeRunId,
  parseHistoryReply,
  readTranscriptIdentity,
  rowDisplayFacts,
  runTerminalStatus,
  toTranscriptRow,
} from "../src/providers/openclaw/transcript-rows.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURE = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/transcript-history-2026.9.6.json"), "utf-8"),
) as Record<string, { sessionKey: string; reply: { messages: unknown[] } }>;

const meta = (o: Record<string, unknown>) => ({ __openclaw: o });

describe("readTranscriptIdentity — upstream readSessionMessageIdentity", () => {
  it("a user row: its send identity is the key minus `:user`, and so is its run", () => {
    const id = readTranscriptIdentity({
      role: "user",
      content: "bonjour",
      ...meta({ id: "e1", seq: 3, idempotencyKey: "webchat-abc:user" }),
    });
    expect(id).toMatchObject({ role: "user", id: "e1", seq: 3, sendId: "webchat-abc", runId: "webchat-abc" });
  });

  it("an assistant row: the PRODUCER run wins over its own key (persisted facts first)", () => {
    const id = readTranscriptIdentity({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      ...meta({ id: "e2", seq: 4, runId: "run-producer", idempotencyKey: "other:user" }),
    });
    expect(id?.runId).toBe("run-producer");
    expect(id?.sendId).toBeNull();
  });

  it("a MIRRORED assistant row without a producer run claims no run (only a CLI one does)", () => {
    const mirrored = readTranscriptIdentity({
      role: "assistant",
      content: "x",
      ...meta({ id: "e3", seq: 5, idempotencyKey: "k1", mirrorOrigin: "delivery-mirror" }),
    });
    expect(mirrored?.runId).toBeNull();
    expect(mirrored?.mirrorOrigin).toBe("delivery-mirror");
    const cli = readTranscriptIdentity({
      role: "assistant",
      api: "cli",
      content: "x",
      ...meta({ id: "e4", seq: 6, idempotencyKey: "cli-assistant:run-9", mirrorOrigin: "cli" }),
    });
    expect(cli?.runId).toBe("run-9");
  });

  it("a delta envelope supplies id, seq and run when the row lacks them", () => {
    const id = readTranscriptIdentity(
      { role: "assistant", content: "x" },
      { messageId: "env-id", messageSeq: 12, runId: "run-env" },
    );
    expect(id).toMatchObject({ id: "env-id", seq: 12, runId: "run-env" });
  });

  it("a STEERED user row names its target run", () => {
    const id = readTranscriptIdentity({
      role: "user",
      content: "et aussi",
      ...meta({ id: "e5", seq: 8, idempotencyKey: "k2:user", steerTargetRunId: "run-target" }),
    });
    expect(id?.steerTargetRunId).toBe("run-target");
  });

  it("an IMPORTED row is not a native identity and is never projected", () => {
    const row = {
      role: "assistant",
      content: "x",
      ...meta({ id: "e6", seq: 2, importedFrom: "codex", cliSessionId: "c", externalId: "x" }),
    };
    expect(readTranscriptIdentity(row)?.isImported).toBe(true);
    expect(toTranscriptRow(row)).toBeNull();
  });

  it("a row without id or seq cannot be placed by identity", () => {
    expect(toTranscriptRow({ role: "assistant", content: "x", ...meta({ seq: 1 }) })).toBeNull();
    expect(toTranscriptRow({ role: "assistant", content: "x", ...meta({ id: "a" }) })).toBeNull();
    expect(toTranscriptRow({ role: "assistant", content: "x", ...meta({ id: "a", seq: 0 }) })).toBeNull();
  });

  it("normalizeRunId strips exactly one `:user` suffix", () => {
    expect(normalizeRunId("k:user")).toBe("k");
    expect(normalizeRunId(":user")).toBeNull();
    expect(normalizeRunId("  k  ")).toBe("k");
    expect(normalizeRunId(42)).toBeNull();
  });
});

describe("rowDisplayFacts — the Control UI's display predicates", () => {
  const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
    role: "assistant",
    content,
    ...extra,
  });

  it("exact NO_REPLY is hidden; anything around it is not (message-visibility.ts:14)", () => {
    expect(rowDisplayFacts(assistant([{ type: "text", text: "NO_REPLY" }])).hidden).toBe(true);
    expect(rowDisplayFacts(assistant([{ type: "text", text: "  NO_REPLY \n" }])).hidden).toBe(true);
    expect(rowDisplayFacts(assistant([{ type: "text", text: "NO_REPLY." }])).hidden).toBe(false);
    expect(rowDisplayFacts(assistant([{ type: "text", text: "No reply needed" }])).hidden).toBe(false);
  });

  it("`text` takes precedence over the content blocks (gateway extractAssistantTextForSilentCheck)", () => {
    expect(rowDisplayFacts(assistant([{ type: "text", text: "hello" }], { text: "NO_REPLY" })).hidden).toBe(true);
  });

  it("a heartbeat acknowledgement is hidden; with a sender label or real content it is not", () => {
    expect(rowDisplayFacts(assistant([{ type: "text", text: "HEARTBEAT_OK" }])).hidden).toBe(true);
    expect(rowDisplayFacts(assistant([{ type: "text", text: "**HEARTBEAT_OK**" }])).hidden).toBe(true);
    expect(rowDisplayFacts(assistant([{ type: "text", text: "HEARTBEAT_OK all quiet" }])).hidden).toBe(true);
    expect(
      rowDisplayFacts(assistant([{ type: "text", text: "HEARTBEAT_OK" }], { senderLabel: "cron" })).hidden,
    ).toBe(false);
    expect(
      rowDisplayFacts(assistant([{ type: "text", text: "HEARTBEAT_OK" }, { type: "image" }])).hidden,
    ).toBe(false);
    // Beyond the 300-character ack budget the rest is a real message.
    expect(rowDisplayFacts(assistant([{ type: "text", text: `HEARTBEAT_OK ${"x".repeat(301)}` }])).hidden).toBe(false);
  });

  it("visible = text or a non-tool non-thinking block; tool activity alone is not", () => {
    expect(rowDisplayFacts(assistant([{ type: "thinking", thinking: "…" }, { type: "toolCall", id: "c" }])).visible).toBe(false);
    expect(rowDisplayFacts(assistant([{ type: "text", text: "  " }])).visible).toBe(false);
    expect(rowDisplayFacts(assistant([{ type: "image" }])).visible).toBe(true);
    expect(rowDisplayFacts({ role: "toolResult", content: [{ type: "text", text: "{}" }] }).visible).toBe(true);
  });
});

describe("parseHistoryReply — the three reply shapes (chat-history-handler.ts:599-679)", () => {
  it("a reset carries nothing but itself", () => {
    expect(parseHistoryReply({ kind: "reset" })).toMatchObject({ kind: "reset", rows: [], deltaCursor: null });
  });

  it("a delta is a list of session.message ENVELOPES", () => {
    const read = parseHistoryReply({
      kind: "delta",
      deltaCursor: "c:9",
      sessionInfo: { sessionId: "s-1", hasActiveRun: true, activeRunIds: ["run-1"] },
      messages: [
        { sessionKey: "k", message: { role: "assistant", content: "x" }, messageId: "m1", messageSeq: 9, runId: "run-1" },
        { sessionKey: "k", message: { role: "assistant", content: "y" } },
      ],
    });
    expect(read?.kind).toBe("delta");
    expect(read?.rows).toEqual([
      expect.objectContaining({ entryId: "m1", seq: 9, runId: "run-1", visible: true }),
    ]);
    expect(read?.unidentified).toBe(1);
    expect(read).toMatchObject({ deltaCursor: "c:9", sessionId: "s-1", hasActiveRun: true, activeRunIds: ["run-1"] });
  });

  it("anything else is not a reply this reader knows", () => {
    expect(parseHistoryReply(null)).toBeNull();
    expect(parseHistoryReply({ kind: "delta" })).toBeNull();
    expect(parseHistoryReply("nope")).toBeNull();
  });
});

describe("the REAL 2026.9.6 pages, read as identities", () => {
  it("announce: the turn's run, the announce run, then the next send — every row identified", () => {
    const read = parseHistoryReply(CAPTURE.announce!.reply);
    expect(read?.kind).toBe("page");
    expect(read?.unidentified).toBe(0);
    const rows = read!.rows;
    expect(rows.length).toBe(CAPTURE.announce!.reply.messages.length);
    const users = rows.filter((r) => r.role === "user");
    expect(users.map((u) => u.sendId?.slice(0, 16))).toEqual(["webchat-91b972c1", "webchat-e7ebed10"]);
    // The send key IS the run of the turn it started (chat-send-session.ts clientRunId).
    const firstTurn = rows.filter((r) => r.runId === users[0]!.sendId && r.role !== "user");
    expect(firstTurn.some((r) => r.role === "assistant" && r.visible)).toBe(true);
    // The gateway's announce run wrote into the SAME session under its own run id.
    const announceRuns = new Set(rows.filter((r) => r.runId?.startsWith("announce:v1:")).map((r) => r.runId));
    expect(announceRuns.size).toBe(1);
    // Display order is not seq order: a reader must order by seq itself.
    const seqs = CAPTURE.announce!.reply.messages.map(
      (m) => (m as { __openclaw: { seq: number } }).__openclaw.seq,
    );
    expect(seqs).not.toEqual([...seqs].sort((a, b) => a - b));
    // Code-mode `custom` rows are activity, never a reply (no visible content of their own).
    expect(rows.filter((r) => r.role === "custom").every((r) => !r.visible)).toBe(true);
  });

  it("followup: one visible reply per send, each in the run its send key names", () => {
    const rows = parseHistoryReply(CAPTURE.followup!.reply)!.rows;
    const users = rows.filter((r) => r.role === "user");
    expect(users).toHaveLength(2);
    for (const u of users) {
      const replies = rows.filter((r) => r.role === "assistant" && r.visible && r.runId === u.sendId);
      expect(replies, `send ${u.sendId?.slice(0, 16)}`).toHaveLength(1);
    }
  });
});

describe("runTerminalStatus — session-projection-run-event.ts:50-71", () => {
  it.each([
    [{ state: "delta" }, null],
    [{ state: "status" }, null],
    [{ state: "aborted" }, "aborted"],
    [{ state: "error" }, "error"],
    [{ state: "error", errorKind: "timeout" }, "timeout"],
    [{ state: "final" }, "completed"],
    [{ state: "final", stopReason: "error" }, "error"],
    [{ state: "final", message: { stopReason: "error" } }, "error"],
    [{ state: "final", yielded: true, stopReason: "end_turn" }, "yielded"],
    // `yielded` alone is not enough: upstream requires the end_turn stop.
    [{ state: "final", yielded: true }, "completed"],
  ] as const)("%j → %s", (event, expected) => {
    expect(runTerminalStatus(event)).toBe(expected);
  });
});
