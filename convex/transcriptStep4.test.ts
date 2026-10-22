/// <reference types="vite/client" />
//
// `on` TAKES NOTHING FROM THE LIVE SIDE BUT THE TEXT BEING WRITTEN (final design step 4) —
// the Convex half:
//   - a row seen only live, absent from a durable read that covers its position, is
//     RETRACTED and never rendered (§3.3; the ephemeral `aborted` row of the golden corpus);
//   - a run's error is its failure row's (`run-failed-before-reply`), not the frame's;
//   - a delivery mirror is credited to its own run only — never fused into another's bubble.
// Each case cites the upstream behaviour it reproduces (v2026.9.33).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  vi.useRealTimers();
});

const SK = "agent:alice:atrium:chat:u-probe:c1";
const YIELDED = "probe-refonte-80ee9278-2008-42a6-8293-e00368eb4de0";
const RESUME = `announce:requester-settle:alice:${SK}:1fe3d5c5-1320-45ac-b11f-60b2987e65e5:yield-1`;

type Row = Record<string, unknown>;
const said = (entryId: string, seq: number, runId: string, text: string, extra: Row = {}): Row => ({
  entryId,
  seq,
  role: "assistant",
  runId,
  hidden: false,
  visible: true,
  text,
  blocks: [{ type: "text", text }],
  ...extra,
});

async function seed(t: T) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "alice" });
    return { userId, chatId };
  });
  await read(t, ids.chatId, [], { kind: "page" });
  return ids;
}

let readClock = 1_000;
function read(t: T, chatId: Id<"chats">, rows: Row[], extra: Row = {}) {
  readClock += 10;
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${readClock}`,
    readAt: readClock,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}

function live(t: T, chatId: Id<"chats">, rows: Row[]) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "live",
    rows: rows as never,
    terminals: [],
    unidentified: 0,
  } as never);
}

const rowOf = (t: T, entryId: string) =>
  t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).find((r) => r.entryId === entryId) ?? null);

async function assistants(t: T, chatId: Id<"chats">) {
  return t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter((m) => m.role === "assistant"),
  );
}

/** The ephemeral row of the corpus (`session-message-ephemeral-aborted.json`): published
 *  live with `seq` 9, empty, `aborted`, from another transcript source; no durable read
 *  ever returns it — the durable seq 9 is the `subagent_settle` entry, which `chat.history`
 *  does not show. */
const EPHEMERAL: Row = {
  entryId: "7546448a-dba6-43ec-92c0-c8a869d2b257",
  seq: 9,
  role: "assistant",
  runId: YIELDED,
  hidden: false,
  visible: false,
  stopReason: "aborted",
  errorMessage: "Agent run aborted",
  transcriptPosition: { source: "YMItc_gVMhcsOyadjKWFyomev7aQ2oSmKyULRT18IMw", rawSeq: 14 },
};

describe("§3.3 — a row seen only live, absent from a covering durable read, is retracted", () => {
  test("the corpus' ephemeral seq 9: retracted by the tail that spans it, hidden, counted in diagnose_chat", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await live(t, chatId, [EPHEMERAL]);
    expect(await rowOf(t, EPHEMERAL.entryId as string)).toMatchObject({ liveOnly: true });
    // The durable tail: seqs 7, 10, 12 — seq 9 (the settle entry) is not shown by chat.history.
    await read(t, chatId, [said("d7", 7, YIELDED, "avant"), said("d10", 10, RESUME, "reprise"), said("d12", 12, RESUME, "suite")], {
      kind: "page",
    });
    const row = await rowOf(t, EPHEMERAL.entryId as string);
    expect(row).toMatchObject({ retracted: true, hidden: true });
    expect(row?.liveOnly).toBeUndefined();
    const report = (await t.query(internal.transcriptProjection.projectionReportInternal, { chatId: chatId as string })) as {
      retractedRows?: number;
    } | null;
    expect(report?.retractedRows).toBe(1);
    // A later live post of the same row does not bring it back…
    await live(t, chatId, [EPHEMERAL]);
    expect(await rowOf(t, EPHEMERAL.entryId as string)).toMatchObject({ retracted: true, hidden: true });
    // …a durable read of it does (a durable row always replaces a live one).
    await read(t, chatId, [{ ...EPHEMERAL, visible: false }]);
    const back = await rowOf(t, EPHEMERAL.entryId as string);
    expect(back?.retracted).toBeUndefined();
    expect(back?.hidden).toBe(false);
  });

  // upstream src/gateway/chat-display-projection.visibility.test.ts:102 — `chat.history`
  // drops the `subagent_announce` / `subagent_settle` inter-session user rows. One seen live
  // is therefore gone at the next load: retracted here, never a bubble.
  test("GW visibility.test.ts:102 — a settle user row seen live, dropped by chat.history, is retracted", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const settle: Row = {
      entryId: "settle-9",
      seq: 9,
      role: "user",
      runId: `${RESUME}:user`,
      hidden: false,
      visible: true,
      provenanceKind: "inter_session",
      provenanceSourceTool: "subagent_settle",
    };
    await live(t, chatId, [settle]);
    await read(t, chatId, [said("d8", 8, YIELDED, "avant"), said("d10", 10, RESUME, "Résultat propre.")], { terminals: [{ runId: RESUME, status: "completed", at: Date.now() }], hasActiveRun: false });
    expect(await rowOf(t, "settle-9")).toMatchObject({ retracted: true, hidden: true });
    const texts = (await assistants(t, chatId)).map((m) => m.text);
    expect(texts.join("\n")).not.toContain("subagent");
  });

  // upstream ui/src/pages/chat/chat-pane-reply-invalidation.test.ts:24 — a background reply
  // received by `session.message` while an OLDER history read is in flight is retained: the
  // stale read (no rows) never drops it, and the committed read shows it once.
  test("CUI chat-pane-reply-invalidation.test.ts:24 — a read that does not cover the live mirror never retracts it; the durable one shows it once", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const reply = said("source-reply", 2, RESUME, "Synthetic audit complete: three checks passed.", {
      deliveryMirror: true,
      stopReason: "stop",
    });
    await live(t, chatId, [reply]);
    // The read issued before the commit: nothing returned, nothing covered.
    await read(t, chatId, []);
    expect(await rowOf(t, "source-reply")).toMatchObject({ liveOnly: true });
    // …and a read that returns only an earlier row does not span seq 2 either.
    await read(t, chatId, [said("first", 1, "run-0", "bonjour")]);
    expect((await rowOf(t, "source-reply"))?.retracted).toBeUndefined();
    // The committed read: the same row, once.
    await read(t, chatId, [reply], { terminals: [{ runId: RESUME, status: "completed", at: Date.now() }], hasActiveRun: false });
    const rows = await t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).filter((r) => r.entryId === "source-reply"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.liveOnly).toBeUndefined();
    const bubbles = (await assistants(t, chatId)).filter((m) => m.text.includes("Synthetic audit complete"));
    expect(bubbles).toHaveLength(1);
  });

});

describe("step 4 — a run's error is its failure row's", () => {
  // upstream src/sessions/session-run-error.ts:35-62 writes the `custom` row
  // `run-failed-before-reply` (content "This turn ended before a reply: …"), projected with
  // its run (src/gateway/chat-display-projection.state-contention.test.ts:5); the Control UI
  // shows it as the error (ui/src/pages/chat/components/chat-message-group.ts:410-425).
  const FAILED = "run-failed-1";
  const failure: Row = {
    entryId: "fail-1",
    seq: 21,
    role: "custom",
    runId: FAILED,
    hidden: false,
    visible: true,
    errorMessage: "This turn ended before a reply: provider unavailable",
  };

  test("a run that failed before any reply, never shown live: born as an error, its text the row's", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await read(t, chatId, [failure], { terminals: [{ runId: FAILED, status: "error", at: Date.now() }], hasActiveRun: false });
    const bubble = (await assistants(t, chatId)).find((m) => m.runId === FAILED);
    expect(bubble).toMatchObject({ status: "error", error: "This turn ended before a reply: provider unavailable", text: "" });
  });

  test("the failure row decides even when the run's terminal was only inferred (an idle read)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await read(t, chatId, [failure], { hasActiveRun: false, activeRunIds: [] });
    const bubble = (await assistants(t, chatId)).find((m) => m.runId === FAILED);
    expect(bubble).toMatchObject({ status: "error", error: "This turn ended before a reply: provider unavailable" });
    expect(bubble?.closeInferred).toBeUndefined();
  });

  test("a live bubble still streaming is settled as an error with the row's text (the frame is only an overlay)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const mF = (await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: FAILED,
      turnSessionKey: SK,
      boundInstanceName: "prod",
    } as never)) as Id<"messages">;
    await read(t, chatId, [failure], { terminals: [{ runId: FAILED, status: "error", at: Date.now() }], hasActiveRun: false });
    const doc = await t.run((ctx) => ctx.db.get(mF));
    expect(doc).toMatchObject({ status: "error", error: "This turn ended before a reply: provider unavailable" });
  });

  test("an assistant row's own `errorMessage` is not shown — the Control UI never renders it", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await read(t, chatId, [said("a1", 30, "run-x", "Réponse.", { stopReason: "error", errorMessage: "raw provider text" })], {
      terminals: [{ runId: "run-x", status: "completed", at: Date.now() }],
      hasActiveRun: false,
    });
    const bubble = (await assistants(t, chatId)).find((m) => m.runId === "run-x");
    expect(bubble).toMatchObject({ status: "complete", text: "Réponse." });
    expect(bubble?.error).toBeUndefined();
  });
});

// upstream src/agents/subagents/registry/subagent-registry-lifecycle.test.ts:4232 — "credits
// only current-run requester delivery mirrors": a mirror counts for the run that wrote it.
// Here: a mirror row is placed in ITS run's bubble only; another run's bubble never takes
// its text or its files (no fusion of rows across runs).
describe("subagent-registry-lifecycle.test.ts:4232 — a mirror is its own run's only", () => {
  test("the mirror of run B, written after A's rows, never joins A's bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const B = `${RESUME}:retry-1`;
    await read(
      t,
      chatId,
      [
        said("a1", 40, RESUME, "Je reprends."),
        said("b1", 41, B, "PROBE_SEND_DONE Voici le fichier.", { deliveryMirror: true, idempotencyKind: "message-tool" }),
      ],
      { terminals: [{ runId: RESUME, status: "completed", at: Date.now() }, { runId: B, status: "completed", at: Date.now() }], hasActiveRun: false },
    );
    const all = await assistants(t, chatId);
    const a = all.find((m) => m.runId === RESUME)!;
    const b = all.find((m) => m.runId === B)!;
    expect(a.text).toBe("Je reprends.");
    expect(b.text).toBe("PROBE_SEND_DONE Voici le fichier.");
    expect(a._id).not.toBe(b._id);
  });
});

describe("the view never shows a retracted row", () => {
  test("a live row placed in a bubble, then retracted: the bubble is recomposed without it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-live";
    // The run's first durable row, then a LIVE-only row of the same run, settled.
    await read(t, ids.chatId, [said("r1", 50, R, "Première partie.")]);
    await live(t, ids.chatId, [said("ghost", 51, R, "Texte fantôme.")]);
    await read(t, ids.chatId, [said("r1", 50, R, "Première partie."), said("r3", 52, R, "Fin.")], {
      terminals: [{ runId: R, status: "completed", at: Date.now() }],
      hasActiveRun: false,
    });
    const view = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as Array<{
      role: string;
      text: string;
    }>;
    const text = view.filter((m) => m.role === "assistant").map((m) => m.text).join("\n");
    expect(text).toContain("Première partie.");
    expect(text).toContain("Fin.");
    expect(text).not.toContain("Texte fantôme.");
  });
});

// upstream src/gateway/chat-display-projection.commentary.ts:96-125 — `chat.history` splits a
// row's stream segment (its text, a `MEDIA:` line) out of the row, BEFORE the row's tool
// call; both carry the row's seq. The bridge keys the segment apart (transcript-rows.ts
// `streamSegmentEntryId`); the bubble shows it first, with its file under it (bench run
// 2026-10-16T20-26-29-405Z, yield-settle-media).
describe("a stream segment and the row it was split out of", () => {
  test("both shown, the segment first with its file, the owner's tool card after", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-seg";
    const owner: Row = {
      entryId: "row-114",
      seq: 114,
      role: "assistant",
      runId: R,
      hidden: false,
      visible: false,
      transcriptPosition: { source: "S", rawSeq: 200 },
      blocks: [{ type: "tool", toolCallId: "exec-1", name: "exec", status: "call" }],
    };
    const segment: Row = {
      ...said("row-114:segment:abc", 114, R, "SETTLE_MEDIA_DONE Le fichier est prêt."),
      streamSegment: true,
      transcriptPosition: { source: "S", rawSeq: 200 },
      blocks: [
        { type: "text", text: "SETTLE_MEDIA_DONE Le fichier est prêt." },
        { type: "file", kind: "document", mediaSource: "/home/node/.openclaw/media/outbound/bench-settle.txt", label: "bench-settle.txt" },
      ],
    };
    // The owner first in the page would sort after the segment anyway: same seq.
    await read(t, ids.chatId, [owner, segment, said("row-120", 120, R, "SETTLE_SUMMARY envoyé.")], {
      terminals: [{ runId: R, status: "completed", at: Date.now() }],
      hasActiveRun: false,
    });
    const view = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as Array<{
      role: string;
      rowLayout?: Array<{ entryId: string; files?: Array<{ blockIndex: number }>; tools?: Array<{ toolCallId: string }> }>;
    }>;
    const bubble = view.find((m) => m.role === "assistant" && m.rowLayout !== undefined)!;
    expect(bubble.rowLayout!.map((l) => l.entryId)).toEqual(["row-114:segment:abc", "row-114", "row-120"]);
    expect(bubble.rowLayout![0]!.files?.map((f) => f.blockIndex)).toEqual([1]);
    expect(bubble.rowLayout![1]!.tools?.map((x) => x.toolCallId)).toEqual(["exec-1"]);
  });
});

// The run's own error when no failure row exists (bench 2026-10-16, a run timeout under
// the embedded runtime: the runner appends an empty `aborted` assistant row, which
// suppresses `run-failed-before-reply` — session-run-error.ts:44). The Control UI then
// shows the session row's `lastRunError` (ui/src/pages/chat/chat-history-stream.ts:233-247).
describe("the run's error from the session row when no failure row exists", () => {
  const TIMED = "e023d978-1c7b-455f-889a-db9b3bfbc0ce";
  const aborted: Row = {
    entryId: "1dccdd34-4cb0-47a1-b4e0-829016f6dbff",
    seq: 4,
    role: "assistant",
    runId: TIMED,
    hidden: false,
    visible: false,
    stopReason: "aborted",
    errorMessage: "request timed out",
  };
  const lastRunFailure = {
    runId: TIMED,
    status: "timeout",
    error: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
  };

  test("never shown live: born as an error, its text the session row's", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await read(t, chatId, [aborted], { lastRunFailure, hasActiveRun: false, activeRunIds: [] });
    const bubble = (await assistants(t, chatId)).find((m) => m.runId === TIMED);
    expect(bubble).toMatchObject({ status: "error", error: lastRunFailure.error, text: "" });
  });

  test("a live bubble its terminal left without text gets the session row's", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const m = (await t.mutation(internal.stream.startAssistant, { chatId, runId: TIMED, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    await t.mutation(internal.stream.finalize, { messageId: m, status: "error" } as never);
    await read(t, chatId, [aborted], { lastRunFailure, terminals: [{ runId: TIMED, status: "timeout", at: Date.now() }], hasActiveRun: false });
    expect(await t.run((ctx) => ctx.db.get(m))).toMatchObject({ status: "error", error: lastRunFailure.error });
  });

});
