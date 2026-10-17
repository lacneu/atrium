/// <reference types="vite/client" />
//
// A BUBBLE RENDERED BY ITS ROWS (final design §3.4, step 3) and NO VISIBLE DUPLICATE
// (Olivier's R4 decision) — the Convex half: the row layout the projection writes, the
// parts it derives, the view `listByChat` serves, what `diagnose_chat` names.
//
// The rows are those of the 2026.9.33 golden corpus (bridge/test/fixtures/
// transcript-2026.9.33/): the Denis shape (a resume run whose code-mode `message` sends
// carry two managed files then a `MEDIA:` reference) and the R4 case (the same file sent
// by two rows: two artifact ids, the same bytes).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { composeBubble, type PlanRow } from "./lib/bubbleProjection";

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
const RUN = "announce:requester-settle:alice:x:1fe3d5c5-1320-45ac-b11f-60b2987e65e5:yield-1";
const SRC = "M-WCtPtLqwIScHKjz_RlYtCESxjAfvCr8hzVGJfF3Hw";
const ART_DOC = "artifact_managed_media_03d85d8e-b298-4812-b5a1-3fffb6ad2e8b";
const ART_IMG = "artifact_managed_image_0e844b10-2d50-44ce-a329-983b99c8b328";
const MEDIA_PATH = "/home/node/.openclaw/media/outbound/probe-refonte-a.txt";

type Row = Record<string, unknown>;
const base = (entryId: string, seq: number, rawSeq: number, extra: Row = {}): Row => ({
  entryId,
  seq,
  role: "assistant",
  runId: RUN,
  hidden: false,
  visible: true,
  transcriptPosition: { source: SRC, rawSeq },
  ...extra,
});

/** The Denis resume run as the corpus rows read (seq 15-26 of chat-history-tail.json). */
function denisRows(): Row[] {
  return [
    base("r15", 15, 26, {
      visible: false,
      text: "",
      blocks: [{ type: "tool", toolCallId: "exec-1", name: "exec", status: "call" }],
    }),
    // seq 17: the nested `message` call, displayed BEFORE the mirror it wrote (activity).
    base("r17", 17, 28, {
      role: "custom",
      visible: false,
      transcriptPosition: { source: SRC, rawSeq: 28, activity: { afterRawSeq: 26, scopeId: "attempt", startOrder: 1 } },
      blocks: [
        { type: "tool", toolCallId: "msg-1", name: "message", status: "call" },
        { type: "tool", toolCallId: "msg-1", name: "message", status: "result" },
      ],
    }),
    base("r16", 16, 27, {
      text: "PROBE_SEND_DONE Voici les deux fichiers demandés.",
      deliveryMirror: true,
      idempotencyKind: "message-tool",
      blocks: [
        { type: "text", text: "PROBE_SEND_DONE Voici les deux fichiers demandés." },
        { type: "file", kind: "document", artifactId: ART_DOC, mimeType: "text/plain", sizeBytes: 16, label: "probe-refonte-a.txt" },
        { type: "file", kind: "image", artifactId: ART_IMG, mimeType: "image/png", sizeBytes: 1795, label: "probe-refonte-img.png" },
      ],
    }),
    base("r23", 23, 36, {
      text: "PROBE_SUMMARY Les fichiers sont envoyés.",
      deliveryMirror: true,
      blocks: [
        { type: "text", text: "PROBE_SUMMARY Les fichiers sont envoyés." },
        { type: "file", kind: "document", mediaSource: MEDIA_PATH, mimeType: "text/plain", label: "probe-refonte-a.txt" },
      ],
    }),
    base("r26", 26, 40, { text: "Délégation terminée.", stopReason: "stop", blocks: [{ type: "text", text: "Délégation terminée." }] }),
  ];
}

async function seed(t: T) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "alice" });
    return { userId, chatId };
  });
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}

function apply(t: T, chatId: Id<"chats">, rows: Row[], extra: Row = {}) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${Math.random()}`,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    ...extra,
  } as never);
}

const terminal = (runId: string) => ({ runId, status: "completed", at: Date.now() });

async function sha256Hex(bytes: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Copy every pending file of the chat with `bytesOf(file)` (the bridge's report). */
async function copyAll(t: T, bytesOf: (f: { label?: string; artifactId?: string }) => string) {
  const files = await t.run((ctx) => ctx.db.query("transcriptFiles").collect());
  for (const f of files) {
    if (f.state !== "pending") continue;
    const bytes = bytesOf(f);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
    await t.mutation(internal.transcriptFiles.finalizeCopy, {
      boundInstanceName: "prod",
      fileId: f._id,
      storageId,
      sha256: await sha256Hex(bytes),
      sizeBytes: new TextEncoder().encode(bytes).length,
      mimeType: f.mimeType ?? "application/octet-stream",
    });
  }
}

async function view(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }) {
  const all = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as Array<{
    _id: Id<"messages">;
    role: string;
    text: string;
    rowLayout?: Array<{ entryId: string; start: number; end: number; files?: Array<{ blockIndex: number }>; tools?: Array<{ toolCallId: string }> }>;
    rowFiles?: Array<{ entryId: string; blockIndex: number; state: string; reason?: string; sha256?: string; fileId?: string }>;
    displayHidden?: Array<{ entryId: string; rule: string; blockIndex?: number }>;
    parts: Array<{ kind: string; transcriptFileId?: string; toolCallId?: string; name?: string }>;
  }>;
  return all.filter((m) => m.role === "assistant");
}

describe("upstream src/gateway/server.chat-history-cursor.test.ts:295 — the display order", () => {
  // "composes nested completions identically after cursor catch-up and fresh history":
  // physical [cached, exec, wait, second(after exec, 1), first(after exec, 0), later(after
  // second, 2)] is shown [cached, exec, first, second, wait, later].
  test("nested activity rows follow the row they are after, by start order", () => {
    const pos = (rawSeq: number, activity?: { afterRawSeq: number; startOrder: number }): PlanRow["position"] => ({
      source: "S",
      rawSeq,
      ...(activity !== undefined ? { activity: { ...activity, scopeId: "attempt" } } : {}),
    });
    const r = (entryId: string, seq: number, position: PlanRow["position"]): PlanRow => ({
      entryId,
      seq,
      role: "assistant",
      runId: "R",
      hidden: false,
      visible: true,
      text: entryId,
      ...(position !== undefined ? { position } : {}),
    });
    const { layout } = composeBubble([
      r("cached", 1, pos(1)),
      r("exec", 2, pos(2)),
      r("wait", 3, pos(3)),
      r("second", 4, pos(4, { afterRawSeq: 2, startOrder: 1 })),
      r("first", 5, pos(5, { afterRawSeq: 2, startOrder: 0 })),
      r("later", 6, pos(6, { afterRawSeq: 4, startOrder: 2 })),
    ]);
    expect(layout.map((l) => l.entryId)).toEqual(["cached", "exec", "first", "second", "wait", "later"]);
  });

  test("rows without a position keep their seq order (the fallback)", () => {
    const { layout } = composeBubble(
      [3, 1, 2].map((seq) => ({ entryId: `e${seq}`, seq, role: "assistant", runId: "R", hidden: false, visible: true, text: `t${seq}` })),
    );
    expect(layout.map((l) => l.entryId)).toEqual(["e1", "e2", "e3"]);
  });
});

describe("a bubble born from rows is complete: text, files under their row, tool cards", () => {
  test("the Denis run: display order, files under the mirror, the MEDIA: reference under its row, cards", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, denisRows(), { terminals: [terminal(RUN)], hasActiveRun: false });
    // Born COMPLETE (before any copy lands): its tool cards are parts already.
    const [born] = await view(t, ids);
    expect(born!.parts.filter((p) => p.kind === "tool").map((p) => p.toolCallId)).toEqual(["exec-1", "msg-1"]);
    // …STORED parts, not only the view's reconciliation: the archive, the files list and the
    // trash read parts.
    const stored = await t.run((ctx) => ctx.db.query("messageParts").collect());
    expect(stored.filter((p) => p.part.kind === "tool").map((p) => (p.part as { toolCallId?: string }).toolCallId)).toEqual(["exec-1", "msg-1"]);
    await copyAll(t, (f) => (f.label === "probe-refonte-img.png" ? "PNGBYTES" : "PROBE_REFONTE_OK"));
    const [bubble] = await view(t, ids);
    expect(bubble).toBeDefined();
    // The gateway's display order: the nested call (17) before the mirror it wrote (16).
    expect(bubble!.rowLayout!.map((r) => r.entryId)).toEqual(["r15", "r17", "r16", "r23", "r26"]);
    const at = (entryId: string) => bubble!.rowLayout!.find((r) => r.entryId === entryId)!;
    expect(bubble!.text.slice(at("r16").start, at("r16").end)).toBe("PROBE_SEND_DONE Voici les deux fichiers demandés.");
    expect(at("r16").files!.map((f) => f.blockIndex)).toEqual([1, 2]);
    expect(at("r23").files!.map((f) => f.blockIndex)).toEqual([1]);
    expect(at("r17").tools!.map((x) => x.toolCallId)).toEqual(["msg-1"]);
    // The cache keeps the names of the files (search, summarizer, export).
    expect(bubble!.text.endsWith("Fichiers : probe-refonte-a.txt, probe-refonte-img.png, probe-refonte-a.txt")).toBe(true);
    // Every file copied, each with a derived part the view links back to its record.
    expect(bubble!.rowFiles!.map((f) => [f.entryId, f.blockIndex, f.state])).toEqual([
      ["r16", 1, "copied"],
      ["r16", 2, "copied"],
      ["r23", 1, "copied"],
    ]);
    const derived = bubble!.parts.filter((p) => p.transcriptFileId !== undefined).map((p) => p.transcriptFileId);
    expect(new Set(derived)).toEqual(new Set(bubble!.rowFiles!.map((f) => f.fileId)));
    // …and the tool cards of a bubble never followed live, one per call.
    expect(bubble!.parts.filter((p) => p.kind === "tool").map((p) => [p.toolCallId, p.name])).toEqual([
      ["exec-1", "exec"],
      ["msg-1", "message"],
    ]);
  });

  test("a file not copied yet is shown pending; gone and refused are shown with their reason", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, denisRows(), { terminals: [terminal(RUN)], hasActiveRun: false });
    const files = await t.run((ctx) => ctx.db.query("transcriptFiles").collect());
    await t.mutation(internal.transcriptFiles.noteCopyFailure, { boundInstanceName: "prod", fileId: files[0]!._id, outcome: "gone", reason: "artifact_not_found" });
    await t.mutation(internal.transcriptFiles.noteCopyFailure, { boundInstanceName: "prod", fileId: files[1]!._id, outcome: "refused", reason: "too_large" });
    const [bubble] = await view(t, ids);
    expect(bubble!.rowFiles!.map((f) => [f.state, f.reason ?? null])).toEqual([
      ["gone", "artifact_not_found"],
      ["refused", "too_large"],
      ["pending", null],
    ]);
    expect(bubble!.parts.filter((p) => p.transcriptFileId !== undefined)).toEqual([]);
  });

  test("a stale MEDIA: copy (the row's later structured rewrite) is never shown: only CURRENT blocks", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // First read: the row still carried its `MEDIA:` line; the rewrite replaced it by a
    // managed block (bench run 2026-10-16T18-23-45-516Z, media-outbound: files 2, blocks 1).
    const first = base("m1", 5, 9, {
      text: "Voici.",
      blocks: [{ type: "text", text: "Voici." }, { type: "file", kind: "document", mediaSource: MEDIA_PATH, label: "bench-media.txt" }],
    });
    await apply(t, ids.chatId, [first], { kind: "live", textsOnly: true });
    const rewritten = { ...first, blocks: [{ type: "text", text: "Voici." }, { type: "file", kind: "document", artifactId: ART_DOC, label: "bench-media.txt" }] };
    await apply(t, ids.chatId, [rewritten], { terminals: [terminal(RUN)], hasActiveRun: false });
    await copyAll(t, () => "BENCH");
    expect((await t.run((ctx) => ctx.db.query("transcriptFiles").collect())).length).toBe(2);
    const [bubble] = await view(t, ids);
    expect(bubble!.rowFiles!.map((f) => f.state)).toEqual(["copied"]);
    const derived = bubble!.parts.filter((p) => p.transcriptFileId !== undefined);
    expect(derived).toHaveLength(1);
    expect(derived[0]!.transcriptFileId).toBe(bubble!.rowFiles![0]!.fileId);
    // …and the file shown is the CURRENT block's (the managed copy), never the stale one.
    const current = (await t.run((ctx) => ctx.db.query("transcriptFiles").collect())).find((f) => f.artifactId === ART_DOC)!;
    expect(bubble!.rowFiles![0]!.fileId).toBe(current._id);
  });
});

describe("Olivier's R4 decision: no visible duplicate, storage faithful", () => {
  // Corpus same-file-two-rows.json: seq 48 sends the txt (and a png), seq 55 sends the txt
  // again — two artifact ids, the same 17 bytes.
  const r4 = (): Row[] => [
    base("s48", 48, 70, {
      text: "CODEMODE_SEND_DONE Voici les deux fichiers demandés.",
      blocks: [
        { type: "text", text: "CODEMODE_SEND_DONE Voici les deux fichiers demandés." },
        { type: "file", kind: "document", artifactId: "artifact_managed_media_5952df0c", label: "bench-codemode-a.txt" },
        { type: "file", kind: "image", artifactId: "artifact_managed_image_b38e93de", label: "bench-codemode-img.png" },
      ],
    }),
    base("s55", 55, 80, {
      text: "CODEMODE_RESEND Voici à nouveau le fichier texte.",
      blocks: [
        { type: "text", text: "CODEMODE_RESEND Voici à nouveau le fichier texte." },
        { type: "file", kind: "document", artifactId: "artifact_managed_media_a2f0cb47", label: "bench-codemode-a.txt" },
      ],
    }),
  ];

  test("the same bytes under two artifact ids: stored twice, shown ONCE (the first row's)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, r4(), { terminals: [terminal(RUN)], hasActiveRun: false });
    await copyAll(t, (f) => (f.label === "bench-codemode-img.png" ? "PNG" : "BENCH_CODEMODE_OK"));
    // Storage: three records, three copies — nothing merged at write.
    const stored = await t.run((ctx) => ctx.db.query("transcriptFiles").collect());
    expect(stored.map((f) => f.state)).toEqual(["copied", "copied", "copied"]);
    const [bubble] = await view(t, ids);
    expect(bubble!.displayHidden).toEqual([
      { messageId: String(bubble!._id), entryId: "s55", rule: "same_sha256_in_group", blockIndex: 1 },
    ]);
  });

  // Upstream src/gateway/chat-display-projection.reconciliation.test.ts:70 "preserves
  // distinct durable answers even when one run produced identical text": the STORAGE keeps
  // both rows, as upstream; the DISPLAY withholds the repeat, by name (R4 — Atrium
  // deliberately does not reproduce the Control UI's visible duplicate).
  test("a row repeating a shown text, with no new file: stored, withheld by name", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(
      t,
      ids.chatId,
      [base("a1", 2, 2, { text: "Le train part à midi." }), base("a2", 3, 3, { text: "Le train part  à midi.\n" })],
      { terminals: [terminal(RUN)], hasActiveRun: false },
    );
    expect(await t.run((ctx) => ctx.db.query("transcriptRows").collect())).toHaveLength(2);
    const [bubble] = await view(t, ids);
    expect(bubble!.displayHidden).toEqual([{ messageId: String(bubble!._id), entryId: "a2", rule: "repeated_text_in_group" }]);
  });

  test("diagnose_chat names every withheld element", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, r4(), { terminals: [terminal(RUN)], hasActiveRun: false });
    await copyAll(t, (f) => (f.label === "bench-codemode-img.png" ? "PNG" : "BENCH_CODEMODE_OK"));
    const report = (await t.query(internal.transcriptProjection.projectionReportInternal, { chatId: ids.chatId as string })) as {
      display?: { hiddenFiles: number; hiddenRows: number; decisions: Array<{ rule: string; entryId: string }> };
    } | null;
    expect(report?.display).toMatchObject({ hiddenFiles: 1, hiddenRows: 0, decisions: [{ rule: "same_sha256_in_group", entryId: "s55" }] });
  });
});

describe("deletion and legacy bubbles", () => {
  test("deleting a bubble purges the files its rows showed, and releases their blobs", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, denisRows(), { terminals: [terminal(RUN)], hasActiveRun: false });
    await copyAll(t, () => "BYTES");
    const [bubble] = await view(t, ids);
    await t.withIdentity({ subject: ids.userId }).mutation(api.messages.deleteMessage, { messageId: bubble!._id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("transcriptFiles").collect())).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("blobReleases").collect())).length).toBeGreaterThanOrEqual(3);
  });

  test("a bubble the rows never composed keeps the old view: no layout, no row files", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("messages", { chatId: ids.chatId, userId: ids.userId, role: "assistant" as const, status: "complete" as const, text: "ancien", updatedAt: 1 }),
    );
    const [bubble] = await view(t, ids);
    expect(bubble).not.toHaveProperty("rowLayout");
    expect(bubble).not.toHaveProperty("rowFiles");
    expect(bubble).not.toHaveProperty("displayHidden");
  });
});

// Step 3's remaining upstream tests (final design §4, « Tests amont repris »), reproduced
// at the scale Atrium renders: a bubble per (run, segment), its rows in display order.
describe("upstream grouping and identity tests, as bubbles", () => {
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

  // ui/src/pages/chat/chat-thread-grouping.test.ts:419 — "classifies … before an unscoped
  // delivery notice": the delivery mirror (`model: "delivery-mirror"`) stays VISIBLE in its
  // group whatever the answer before it. In Atrium: a mirror row is a row like any other —
  // its text is shown where the gateway wrote it, in its run's bubble.
  test("chat-thread-grouping.test.ts:419 — a delivery mirror is shown in its run's bubble, in place", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "completed-run";
    await apply(
      t,
      ids.chatId,
      [
        said("ans", 3, R, "File verified — café 雪 🦞", { stopReason: "stop" }),
        said("mirror", 4, R, "Gateway restart config-patch ok", { deliveryMirror: true, stopReason: "stop" }),
      ],
      { terminals: [terminal(R)], hasActiveRun: false },
    );
    const [bubble] = (await view(t, ids)).filter((m) => m.rowLayout?.some((l) => l.entryId === "mirror"));
    expect(bubble!.rowLayout!.map((l) => l.entryId)).toEqual(["ans", "mirror"]);
    expect(bubble!.text).toBe("File verified — café 雪 🦞\n\nGateway restart config-patch ok");
  });

  // ui/src/pages/chat/chat-thread-grouping.test.ts:570 — "keeps independent-run trailing
  // activity with its presentation owner": an INDEPENDENT run's activity is never absorbed
  // into the answer's group. In Atrium: rows of another run never join the answer's bubble.
  test("chat-thread-grouping.test.ts:570 — an independent run's rows are never absorbed into the answer's bubble", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(
      t,
      ids.chatId,
      [
        said("c", 2, "reply", "Checking"),
        said("w", 3, "reply", "Watching"),
        { entryId: "t1", seq: 4, role: "assistant", runId: "wake-1", hidden: false, visible: false, blocks: [{ type: "tool", toolCallId: "call-1", name: "read", status: "call" }] },
        { entryId: "t1r", seq: 5, role: "toolresult", runId: "wake-1", hidden: false, visible: true, blocks: [{ type: "tool", toolCallId: "call-1", name: "read", status: "result" }] },
      ],
      { terminals: [terminal("reply"), terminal("wake-1")], hasActiveRun: false },
    );
    const reply = (await view(t, ids)).find((m) => m.rowLayout?.some((l) => l.entryId === "w"))!;
    expect(reply.rowLayout!.map((l) => l.entryId)).toEqual(["c", "w"]);
    expect(reply.parts.filter((p) => p.kind === "tool")).toEqual([]);
  });

  // packages/gateway-client/src/session-projection-duplicate-final.test.ts:52 — "keeps
  // durable replay idempotent despite contradictory same-run history": the saved final
  // (`stopReason: "toolUse"`) and a later tool row, replayed, stay exactly [saved, later].
  test("session-projection-duplicate-final.test.ts:52 — a durable replay changes nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "announce:repro";
    const rows = [
      said("saved", 217, R, "Selected answer", { stopReason: "toolUse" }),
      said("later-tool", 218, R, "Checking another file.", {
        stopReason: "toolUse",
        blocks: [
          { type: "text", text: "Checking another file." },
          { type: "tool", toolCallId: "read-next", name: "read", status: "call" },
        ],
      }),
    ];
    await apply(t, ids.chatId, rows, { terminals: [terminal(R)], hasActiveRun: false });
    const first = (await view(t, ids)).find((m) => m.rowLayout?.some((l) => l.entryId === "saved"))!;
    for (let replay = 0; replay < 2; replay++) {
      await apply(t, ids.chatId, structuredClone(rows), { hasActiveRun: false });
      const again = (await view(t, ids)).filter((m) => m.rowLayout?.some((l) => l.entryId === "saved"));
      expect(again).toHaveLength(1);
      expect(again[0]!.text).toBe(first.text);
      expect(again[0]!.rowLayout).toEqual(first.rowLayout);
    }
    expect(first.text).toBe("Selected answer\n\nChecking another file.");
    const stored = await t.run((ctx) => ctx.db.query("transcriptRows").collect());
    expect(stored.filter((r) => r.entryId === "saved")).toHaveLength(1);
  });

  // ui/src/pages/chat/chat-thread.test.ts:1473 — "collapses a replay of the same canonical
  // user prompt": the same `__openclaw.id` is one row, however often it is read.
  test("chat-thread.test.ts:1473 — the same canonical id read twice is one row", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const user: Row = { entryId: "canonical-replayed-user", seq: 1, role: "user", runId: "replayed-user-run", sendId: "replayed-user-run", hidden: false, visible: true };
    await apply(t, ids.chatId, [user]);
    await apply(t, ids.chatId, [{ ...user }], { kind: "live", deltaCursor: undefined });
    const stored = await t.run((ctx) => ctx.db.query("transcriptRows").collect());
    expect(stored.filter((r) => r.entryId === "canonical-replayed-user")).toHaveLength(1);
  });
});
