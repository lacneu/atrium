// Phase 2 of the transcript redesign, the PURE half: what a live `session.message`
// carries into the store (CU-16, upstream `applySessionMessagePayload`), what a
// `sessions.changed` asks of the reconciler (upstream `handleSessionsChangedEvent`),
// and the input guard a `chat.history` reply carries (`pendingInputs`,
// `inputReceipts`). Each case is pinned against the upstream rule it mirrors
// (citations in transcript-rows.ts).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { chatHistoryParams } from "../src/core/rpc-params.js";
import {
  admitLiveRow,
  classifySessionsChanged,
  parseHistoryReply,
  readInputReceipts,
  readPendingInputs,
  readUnreadableReceipts,
} from "../src/providers/openclaw/transcript-rows.js";

const KEY = "agent:alice:atrium:chat:u-1:c1";
const ev = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  sessionKey: KEY,
  message,
  ...extra,
});
const assistant = (meta: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "text", text: "réponse" }],
  __openclaw: meta,
});
const NONE = { activeRunId: null, recentTerminalRunId: null };

describe("CU-16 — which live rows are applied now (session-message-apply.ts:65-130)", () => {
  it("a user row is always admitted, and placed by its send identity", () => {
    const a = admitLiveRow(
      ev({ role: "user", content: "q", __openclaw: { id: "u1", seq: 4, idempotencyKey: "webchat-s:user" } }),
      NONE,
    );
    expect(a).toMatchObject({ admitted: true, why: "user", role: "user" });
    expect(a.row).toMatchObject({ entryId: "u1", seq: 4, sendId: "webchat-s" });
  });

  it("an assistant row of a run OTHER than the foreground one is admitted when sequenced", () => {
    const a = admitLiveRow(ev(assistant({ id: "a1", seq: 5, runId: "announce:v1:k:r" })), {
      activeRunId: "webchat-s",
      recentTerminalRunId: null,
    });
    expect(a).toMatchObject({ admitted: true, why: "previous_run" });
    // …but not unsequenced: no position to place it at.
    const b = admitLiveRow(ev(assistant({ id: "a1", runId: "announce:v1:k:r" })), {
      activeRunId: "webchat-s",
      recentTerminalRunId: null,
    });
    expect(b.admitted).toBe(false);
  });

  it("the foreground run's own row is admitted only with its producer PROVEN by the event", () => {
    const ctx = { activeRunId: "webchat-s", recentTerminalRunId: null };
    const proven = admitLiveRow(ev(assistant({ id: "a2", seq: 6, runId: "webchat-s" }), { runId: "webchat-s" }), ctx);
    expect(proven).toMatchObject({ admitted: true, why: "producer" });
    // clientRunId describes the event, not the transcript ownership (upstream comment).
    const unproven = admitLiveRow(ev(assistant({ id: "a2", seq: 6, runId: "webchat-s" })), ctx);
    expect(unproven).toMatchObject({ admitted: false, why: "unadmitted" });
  });

  it("with no foreground run, only the run whose terminal was just observed may finish", () => {
    const row = ev(assistant({ id: "a3", seq: 7, runId: "webchat-s" }), { runId: "webchat-s" });
    expect(admitLiveRow(row, { activeRunId: null, recentTerminalRunId: "webchat-s" }).admitted).toBe(true);
    expect(admitLiveRow(row, { activeRunId: null, recentTerminalRunId: "webchat-other" }).admitted).toBe(false);
    expect(admitLiveRow(row, NONE).admitted).toBe(false);
  });

  it("a tool row with a stored image is admitted for its proven producer", () => {
    const tool = {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "image", artifactId: "art-1" }],
      __openclaw: { id: "t1", seq: 8, runId: "webchat-s" },
    };
    const ctx = { activeRunId: "webchat-s", recentTerminalRunId: null };
    expect(admitLiveRow(ev(tool, { runId: "webchat-s" }), ctx)).toMatchObject({ admitted: true, why: "tool_image" });
    const noImage = { ...tool, content: [{ type: "text", text: "ok" }] };
    expect(admitLiveRow(ev(noImage, { runId: "webchat-s" }), ctx).admitted).toBe(false);
  });

  it("a row with neither id, key nor seq is dropped; an imported row too", () => {
    expect(admitLiveRow(ev({ role: "user", content: "q" }), NONE)).toMatchObject({ admitted: false, why: "unidentified" });
    expect(
      admitLiveRow(ev({ role: "user", content: "q", __openclaw: { id: "x", seq: 1, importedFrom: "cli" } }), NONE),
    ).toMatchObject({ admitted: false, why: "imported" });
    expect(admitLiveRow({ sessionKey: KEY }, NONE)).toMatchObject({ admitted: false, why: "unreadable" });
  });

  it("the envelope's position counts when the row's own metadata lacks it", () => {
    const a = admitLiveRow(
      ev({ role: "user", content: "q", __openclaw: { idempotencyKey: "webchat-s:user" } }, { messageId: "u7", messageSeq: 7 }),
      NONE,
    );
    expect(a.row).toMatchObject({ entryId: "u7", seq: 7 });
  });

  it("carries the snapshot's hasActiveRun, and a user row with only a key is admitted but unplaced", () => {
    const a = admitLiveRow(
      ev({ role: "user", content: "q", __openclaw: { idempotencyKey: "webchat-s:user" } }, { hasActiveRun: true }),
      NONE,
    );
    expect(a).toMatchObject({ admitted: true, row: null, hasActiveRun: true });
  });
});

describe("sessions.changed — what it asks of the reconciler (chat-state-events.ts:343-457)", () => {
  it.each([
    [{ reason: "reset" }, { reset: true, read: true, why: "reset" }],
    [{ phase: "reset" }, { reset: true, read: true, why: "reset" }],
    [{ reason: "new" }, { reset: true, read: true, why: "new" }],
    [{ reason: "compact" }, { reset: false, read: true, why: "compact" }],
    [{ phase: "message" }, { reset: false, read: true, why: "message_batch" }],
    [{ reason: "send" }, { reset: false, read: true, why: "custody" }],
    [{ reason: "agent.run.started" }, { reset: false, read: true, why: "custody" }],
    [{ reason: "agent.input.settled" }, { reset: false, read: true, why: "custody" }],
    [{ phase: "end", runId: "r" }, { reset: false, read: true, why: "run_end" }],
    [{ phase: "error", runId: "r" }, { reset: false, read: true, why: "run_end" }],
  ])("%j → %j", (payload, expected) => {
    expect(classifySessionsChanged({ sessionKey: KEY, ...payload })).toEqual(expected);
  });

  it.each([
    [{ reason: "patch" }],
    [{ reason: "chat.title" }],
    [{ phase: "start", runId: "r" }],
    [{ phase: "model", runId: "r" }],
    // A display-suppressed message names itself: no batch to recover (:589-606).
    [{ phase: "message", messageId: "m", messageSeq: 3 }],
    [{}],
  ])("%j asks nothing", (payload) => {
    expect(classifySessionsChanged({ sessionKey: KEY, ...payload })).toEqual({ reset: false, read: false, why: null });
  });
});

describe("the input guard a chat.history reply carries", () => {
  it("pendingInputs: identity only, bounded, 9.7+ flags kept", () => {
    const facts = readPendingInputs({
      items: [
        { id: "p1", runId: "webchat-a", message: { role: "user", content: "SECRET" }, acceptedAt: 1, state: "queued", queued: true },
        { id: "p2", runId: "webchat-b", message: {}, acceptedAt: 2, state: "interrupted" },
        { id: "p3", message: {}, acceptedAt: 3, state: "cancelled" },
        { id: "p4", runId: "x".repeat(257), message: {}, acceptedAt: 4, state: "queued" },
        { id: "p5", runId: "webchat-c", state: "bogus" },
      ],
      total: 7,
      queuedCount: 1,
    });
    expect(facts).toEqual({
      total: 7,
      queuedCount: 1,
      items: [
        { runId: "webchat-a", state: "queued", queued: true },
        { runId: "webchat-b", state: "interrupted" },
        { state: "cancelled" },
        { state: "queued" },
      ],
    });
    expect(JSON.stringify(facts)).not.toContain("SECRET");
    const many = readPendingInputs({ items: Array.from({ length: 40 }, (_, i) => ({ runId: `r${i}`, state: "queued" })), total: 40 });
    expect(many!.items).toHaveLength(20);
    expect(readPendingInputs(undefined)).toBeNull();
  });

  it("a page is COMPLETE only when it is the whole list: no older page, every item kept", () => {
    const item = (runId: string) => ({ id: runId, runId, message: {}, acceptedAt: 1, state: "queued" });
    expect(readPendingInputs({ items: [item("a")], total: 1 })!.complete).toBe(true);
    expect(readPendingInputs({ items: [], total: 0, queuedCount: 0 })!.complete).toBe(true);
    // An older page exists.
    expect(readPendingInputs({ items: [item("a")], total: 1, nextBefore: 5 })!.complete).toBeUndefined();
    // More inputs than the page shows.
    expect(readPendingInputs({ items: [item("a")], total: 3 })!.complete).toBeUndefined();
    // An item Atrium could not read (unknown state, oversize id) leaves the page unproven.
    expect(readPendingInputs({ items: [{ ...item("a"), state: "bogus" }], total: 1 })!.complete).toBeUndefined();
    expect(readPendingInputs({ items: [item("x".repeat(300))], total: 1 })!.complete).toBeUndefined();
  });

  it("inputReceipts: pending (with 9.7+ queued/cancelled flags) and consumed; anything else dropped", () => {
    expect(
      readInputReceipts([
        { runId: "a", state: "pending" },
        { runId: "b", state: "pending", queued: true },
        { runId: "c", state: "pending", cancelled: true },
        { runId: "d", state: "consumed", consumedByEventId: "e1" },
        { runId: "e", state: "lost" },
        { state: "pending" },
      ]),
    ).toEqual([
      { runId: "a", state: "pending" },
      { runId: "b", state: "pending", queued: true },
      { runId: "c", state: "pending", cancelled: true },
      { runId: "d", state: "consumed" },
    ]);
    expect(readInputReceipts(undefined)).toBeNull();
  });

  it("a delta reply carries both; a reset reply neither", () => {
    const read = parseHistoryReply({
      kind: "delta",
      deltaCursor: "c:2",
      messages: [],
      pendingInputs: { items: [], total: 0 },
      inputReceipts: [{ runId: "a", state: "consumed", consumedByEventId: "x" }],
    });
    expect(read).toMatchObject({ pendingInputs: { total: 0, items: [] }, inputReceipts: [{ runId: "a", state: "consumed" }] });
    expect(parseHistoryReply({ kind: "reset" })).toMatchObject({ pendingInputs: null, inputReceipts: null });
  });

  it("inputRunIds reach the wire only when non-empty, and only to a gateway that knows them", () => {
    const p = { sessionKey: KEY, limit: 80 };
    expect(chatHistoryParams({ ...p, inputRunIds: ["a"] }, "2026.9.8")).toMatchObject({ inputRunIds: ["a"] });
    expect(chatHistoryParams({ ...p, inputRunIds: [] }, "2026.9.8")).not.toHaveProperty("inputRunIds");
    expect(chatHistoryParams({ ...p, inputRunIds: ["a"] }, "2026.8.1")).not.toHaveProperty("inputRunIds");
    expect(chatHistoryParams({ ...p, inputRunIds: ["a"] }, null)).not.toHaveProperty("inputRunIds");
  });
});

// ── REAL 2026.9.8 shapes (bench run 2026-10-04T17-59-21-910Z, minimised by allowlist) ──

const LIVE = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/session-events-2026.9.8.json"),
    "utf-8",
  ),
) as {
  frames: Array<{ event: string; payload: Record<string, unknown> }>;
  historyReplies: Array<Record<string, unknown>>;
};

describe("the captured 2026.9.8 session events read as the Control UI reads them", () => {
  const messages = LIVE.frames.filter((f) => f.event === "session.message");
  const changes = LIVE.frames.filter((f) => f.event === "sessions.changed");

  it("the capture holds user, assistant (with and without a producer run) and custom rows", () => {
    const roles = messages.map((f) => (f.payload.message as { role: string }).role);
    expect(new Set(roles)).toEqual(new Set(["user", "assistant", "custom"]));
    expect(messages.some((f) => typeof f.payload.runId === "string")).toBe(true);
  });

  it("every captured row is placed by identity: entry id = messageId, seq = messageSeq", () => {
    for (const f of messages) {
      const a = admitLiveRow(f.payload, { activeRunId: null, recentTerminalRunId: null });
      expect(a.row, JSON.stringify(f.payload.messageId)).not.toBeNull();
      expect(a.row!.entryId).toBe(f.payload.messageId);
      expect(a.row!.seq).toBe(f.payload.messageSeq);
      expect(a.hasActiveRun).toBe(f.payload.hasActiveRun);
    }
  });

  it("a user row carries its send identity; an assistant row its producer run", () => {
    const sendIds: string[] = [];
    for (const f of messages) {
      const a = admitLiveRow(f.payload, { activeRunId: null, recentTerminalRunId: null });
      const role = (f.payload.message as { role: string }).role;
      if (role === "user") {
        expect(a.admitted).toBe(true);
        expect(a.row!.sendId).toBeTruthy();
        sendIds.push(a.row!.sendId!);
      }
      if (role === "assistant") expect(a.row!.runId).toBeTruthy();
    }
    // Atrium's own sends carry its key; another client's (a gateway-side send) its own.
    expect(sendIds.some((id) => /^webchat-[0-9a-f]{64}$/.test(id))).toBe(true);
  });

  it("an assistant row whose producer the event proves is admitted while its run is in the foreground", () => {
    const proven = messages.find(
      (f) => (f.payload.message as { role: string }).role === "assistant" && typeof f.payload.runId === "string",
    )!;
    const runId = proven.payload.runId as string;
    expect(admitLiveRow(proven.payload, { activeRunId: runId, recentTerminalRunId: null })).toMatchObject({
      admitted: true,
      why: "producer",
    });
    // …and without a run in the foreground nor a finished one, it waits for the read.
    expect(admitLiveRow(proven.payload, { activeRunId: null, recentTerminalRunId: null }).admitted).toBe(false);
  });

  it("every captured sessions.changed is classified as the Control UI would act on it", () => {
    const seen = new Map<string, ReturnType<typeof classifySessionsChanged>>();
    for (const f of changes) {
      seen.set(String(f.payload.reason ?? `phase:${String(f.payload.phase)}`), classifySessionsChanged(f.payload));
    }
    for (const reason of ["send", "agent.run.started", "agent.input.settled"]) {
      expect(seen.get(reason)).toEqual({ reset: false, read: true, why: "custody" });
    }
    expect(seen.get("phase:end")).toEqual({ reset: false, read: true, why: "run_end" });
    expect(seen.get("phase:message")).toEqual({ reset: false, read: true, why: "message_batch" });
    for (const quiet of ["phase:start", "phase:model", "activity-summary", "patch", "create", "participants", "cron-binding", "profile-identity"]) {
      expect(seen.get(quiet), quiet).toEqual({ reset: false, read: false, why: null });
    }
  });

  it("the captured replies carry the guard: a queued pending input and its pending receipt", () => {
    for (const reply of LIVE.historyReplies) {
      const read = parseHistoryReply(reply)!;
      expect(read).not.toBeNull();
      expect(read.pendingInputs!.items[0]).toMatchObject({ state: "queued" });
      expect(read.pendingInputs!.total).toBe(1);
      expect(read.pendingInputs!.queuedCount).toBe(0);
      expect(read.inputReceipts).toEqual([{ runId: read.pendingInputs!.items[0]!.runId, state: "pending" }]);
    }
  });
});

describe("review 11 — a receipt Atrium cannot interpret is observed, never an absence", () => {
  it("unknown states keep their ids; id-less entries are counted; known ones are not unreadable", () => {
    expect(
      readUnreadableReceipts([
        { runId: "a", state: "pending" },
        { runId: "b", state: "superseded" },
        { runId: "c" },
        { state: "pending" },
        { state: "weird" },
        "junk",
      ]),
    ).toEqual({ ids: ["b", "c"], unattributed: 3, states: ["superseded", "<undefined>", "weird", "<undefined>"] });
    expect(readUnreadableReceipts(undefined)).toEqual({ ids: [], unattributed: 0, states: [] });
  });

  it("parseHistoryReply carries them beside the readable receipts", () => {
    const read = parseHistoryReply({ kind: "delta", deltaCursor: "c", messages: [], inputReceipts: [{ runId: "a", state: "lost" }] })!;
    expect(read.inputReceipts).toEqual([]);
    expect(read.unreadableReceipts).toMatchObject({ ids: ["a"], unattributed: 0 });
  });
});
