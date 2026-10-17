/// <reference types="vite/client" />
//
// THE POINTS LEFT OPEN AFTER STEPS 3-4, CLOSED (coordinator, 2026-10-16): a run of tool
// calls only is shown; a row naming no run is shown with its presentation owner; a derived
// part the current rows no longer name is gone from storage (export and archive included);
// a bubble every row of which was retracted goes; after a rollback the row's copy wins
// over a live file. Each case cites the upstream behaviour it reproduces (v2026.9.33).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { composedTurnBody } from "./chatSummaries";

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

const SK = "agent:main:atrium:chat:u:c1";
type Row = Record<string, unknown>;

async function seed(t: T, mode: "on" | "shadow" = "on") {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: mode } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    return { userId, chatId };
  });
  await read(t, ids.chatId, [], { kind: "page" });
  return ids;
}

let clock = 1_000;
function read(t: T, chatId: Id<"chats">, rows: Row[], extra: Row = {}) {
  clock += 10;
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind: "delta",
    deltaCursor: `c:${clock}`,
    readAt: clock,
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
const over = (...runs: string[]) => ({
  terminals: runs.map((runId) => ({ runId, status: "completed", at: Date.now() })),
  hasActiveRun: false,
  activeRunIds: [],
});

const said = (entryId: string, seq: number, runId: string | undefined, text: string, extra: Row = {}): Row => ({
  entryId,
  seq,
  role: "assistant",
  ...(runId !== undefined ? { runId } : {}),
  hidden: false,
  visible: true,
  text,
  blocks: [{ type: "text", text }],
  ...extra,
});
const toolCall = (entryId: string, seq: number, runId: string | undefined, id: string): Row => ({
  entryId,
  seq,
  role: "assistant",
  ...(runId !== undefined ? { runId } : {}),
  hidden: false,
  visible: false,
  blocks: [{ type: "tool", toolCallId: id, name: "read", status: "call" }],
});
const toolResult = (entryId: string, seq: number, runId: string | undefined, id: string): Row => ({
  entryId,
  seq,
  role: "toolresult",
  ...(runId !== undefined ? { runId } : {}),
  hidden: false,
  visible: true,
  blocks: [{ type: "tool", toolCallId: id, name: "read", status: "result" }],
});

type View = {
  _id: Id<"messages">;
  role: string;
  runId?: string;
  text: string;
  rowLayout?: Array<{ entryId: string; files?: Array<{ blockIndex: number }>; tools?: Array<{ toolCallId: string }> }>;
  rowFiles?: Array<{ entryId: string; blockIndex: number; fileId?: string; state: string }>;
  parts: Array<{ kind: string; transcriptFileId?: string; toolCallId?: string; filename?: string }>;
};
async function view(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }): Promise<View[]> {
  const all = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as View[];
  return all.filter((m) => m.role === "assistant");
}
const cards = (m: View) => (m.rowLayout ?? []).flatMap((l) => (l.tools ?? []).map((x) => x.toolCallId));

async function sha256Hex(bytes: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function copyAll(t: T, bytes: string) {
  const files = await t.run((ctx) => ctx.db.query("transcriptFiles").collect());
  for (const f of files) {
    if (f.state !== "pending") continue;
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

// ui/src/pages/chat/chat-thread-grouping.test.ts:570 — "keeps %s trailing activity with its
// presentation owner", the whole table: [user, commentary "Checking", final "Watching"]
// then two (toolCall, toolResult) pairs owned by the same run, by independent runs
// `wake-1`/`wake-2`, or by no run. Upstream: same-run and unscoped activity stays with the
// reply's work; independent activity is shown on its own ("activity-run"). Atrium, one
// bubble per run: the same.
describe("chat-thread-grouping.test.ts:570 — trailing activity and its presentation owner", () => {
  for (const ownership of ["same-run", "independent-run", "unscoped"] as const) {
    test(ownership, async () => {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const runOf = (i: number) => (ownership === "unscoped" ? undefined : ownership === "same-run" ? "reply" : `wake-${i}`);
      const rows: Row[] = [
        { entryId: "u", seq: 1, role: "user", runId: "reply", sendId: "reply", hidden: false, visible: true },
        said("c", 2, "reply", "Checking"),
        said("w", 3, "reply", "Watching"),
        ...[1, 2].flatMap((i) => [toolCall(`call-${i}`, 2 + 2 * i, runOf(i), `call-${i}`), toolResult(`res-${i}`, 3 + 2 * i, runOf(i), `call-${i}`)]),
      ];
      await read(t, ids.chatId, rows, over("reply", "wake-1", "wake-2"));
      const bubbles = await view(t, ids);
      const reply = bubbles.find((m) => m.runId === "reply")!;
      if (ownership === "independent-run") {
        expect(cards(reply)).toEqual([]);
        // Each independent run is shown by its own cards (upstream: its "activity-run").
        expect(bubbles.filter((m) => m.runId?.startsWith("wake-")).map((m) => [m.runId, cards(m)])).toEqual([
          ["wake-1", ["call-1"]],
          ["wake-2", ["call-2"]],
        ]);
      } else {
        expect(cards(reply)).toEqual(["call-1", "call-2"]);
        expect(reply.rowLayout!.map((l) => l.entryId).slice(0, 2)).toEqual(["c", "w"]);
        expect(bubbles).toHaveLength(1);
      }
    });
  }

  test("a live bubble whose run wrote only tool calls is laid out by its rows (its cards under them)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: "tool-live", turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    await read(t, ids.chatId, [toolCall("tl1", 20, "tool-live", "y-1"), toolResult("tl1r", 21, "tool-live", "y-1")], over("tool-live"));
    const b = (await view(t, ids)).find((x) => x._id === m)!;
    expect(cards(b)).toEqual(["y-1"]);
  });

  test("a run of tool calls only, never shown live, is born with its cards and their parts", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await read(t, ids.chatId, [toolCall("t1", 10, "tools-only", "x-1"), toolResult("t1r", 11, "tools-only", "x-1")], over("tools-only"));
    const [b] = await view(t, ids);
    expect(b).toMatchObject({ runId: "tools-only", text: "" });
    expect(cards(b!)).toEqual(["x-1"]);
    expect(b!.parts.filter((p) => p.kind === "tool").map((p) => p.toolCallId)).toEqual(["x-1"]);
  });
});

// ui/src/pages/chat/chat-thread-grouping.test.ts:419 — "classifies … before an unscoped
// delivery notice": the delivery mirror with no `__openclaw` run stays VISIBLE after the
// answer. Atrium: it joins its presentation owner's bubble, in place; with no owner (a
// person's message right before it), it is a bubble of its own. Never lost.
describe("chat-thread-grouping.test.ts:419 — an unscoped delivery mirror is never lost", () => {
  test("after an answer: shown in the answer's bubble, in place", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await read(
      t,
      ids.chatId,
      [
        said("ans", 3, "completed-run", "File verified — café 雪 🦞", { stopReason: "stop" }),
        said("mirror", 4, undefined, "Gateway restart config-patch ok", { deliveryMirror: true, stopReason: "stop" }),
      ],
      over("completed-run"),
    );
    const [b] = await view(t, ids);
    expect(b!.rowLayout!.map((l) => l.entryId)).toEqual(["ans", "mirror"]);
    expect(b!.text).toBe("File verified — café 雪 🦞\n\nGateway restart config-patch ok");
    const stored = await t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).find((r) => r.entryId === "mirror"));
    expect(stored).toMatchObject({ runId: "completed-run", presentationOwner: true });
  });

  test("right after a person's message: its own bubble, never the previous turn's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await read(
      t,
      ids.chatId,
      [
        said("ans", 3, "r1", "Réponse."),
        { entryId: "u2", seq: 4, role: "user", runId: "r2", sendId: "r2", hidden: false, visible: true },
        said("notice", 5, undefined, "Gateway restart config-patch ok", { deliveryMirror: true }),
      ],
      over("r1"),
    );
    const bubbles = await view(t, ids);
    const own = bubbles.find((m) => m.rowLayout?.some((l) => l.entryId === "notice"))!;
    expect(own.runId).toBe("unscoped:notice");
    expect(own.text).toBe("Gateway restart config-patch ok");
    expect(bubbles.find((m) => m.runId === "r1")!.text).toBe("Réponse.");
  });

  test("off/shadow store the row as before (no owner inferred)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, "shadow");
    await read(t, ids.chatId, [said("ans", 3, "r1", "x"), said("mirror", 4, undefined, "y")], over("r1"));
    const stored = await t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).find((r) => r.entryId === "mirror"));
    expect(stored?.runId).toBeUndefined();
    expect(stored?.presentationOwner).toBeUndefined();
  });
});

// The row replaced its `MEDIA:` copy by its managed block (the gateway's structured
// rewrite, seen on the bench: the same row read first with the MEDIA line, then with the
// attachment block). The derived part of the old copy goes with the layout that named it:
// the viewer, the export and the archive never see it.
describe("a derived part the current rows no longer name is gone from storage", () => {
  test("viewer, archive (messageParts, files) and the Markdown export see the current copy only", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-media";
    const withMedia = said("m1", 5, R, "Voici.", {
      blocks: [{ type: "text", text: "Voici." }, { type: "file", kind: "document", mediaSource: "/home/node/.openclaw/media/outbound/a.txt", label: "a.txt" }],
    });
    await read(t, ids.chatId, [withMedia], over(R));
    await copyAll(t, "AAA");
    let [b] = await view(t, ids);
    const first = b!.parts.filter((p) => p.transcriptFileId !== undefined);
    expect(first).toHaveLength(1);
    // The rewrite: same row, the managed block at the same place.
    await read(t, ids.chatId, [
      { ...withMedia, blocks: [{ type: "text", text: "Voici." }, { type: "file", kind: "document", artifactId: "artifact_managed_media_1", label: "a.txt" }] },
    ]);
    await copyAll(t, "AAA");
    [b] = await view(t, ids);
    const derived = b!.parts.filter((p) => p.transcriptFileId !== undefined);
    expect(derived).toHaveLength(1);
    expect(derived[0]!.transcriptFileId).not.toBe(first[0]!.transcriptFileId);
    // Storage faithful: both copies are kept as transcript files.
    expect(await t.run((ctx) => ctx.db.query("transcriptFiles").collect())).toHaveLength(2);
    // The archive: one part, one files row.
    const asUser = t.withIdentity({ subject: ids.userId });
    const parts = (await asUser.query(api.archiveExport.exportChatSection, { chatId: ids.chatId, section: "messageParts" })) as { rows: Array<Record<string, unknown>> };
    expect(parts.rows.filter((r) => (r.part as { kind: string }).kind === "media")).toHaveLength(1);
    const files = (await asUser.query(api.archiveExport.exportChatSection, { chatId: ids.chatId, section: "files" })) as { rows: unknown[] };
    expect(files.rows).toHaveLength(1);
  });
});

// The Markdown export, the search and the summarizer read the bubble's text — the derived
// cache that names its files. After the row replaced its `MEDIA:` copy (`brouillon.txt`) by
// its managed block (`rapportfinal.txt`), each sees the current copy only.
describe("Markdown export, search and summarizer see the current copy only", () => {
  test("the cache, the export, the search and the summarizer's turn body", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-cache";
    const first = said("m1", 5, R, "Voici le rapport.", {
      blocks: [{ type: "text", text: "Voici le rapport." }, { type: "file", kind: "document", mediaSource: "/home/node/.openclaw/media/outbound/brouillon.txt", label: "brouillon.txt" }],
    });
    await read(t, ids.chatId, [first], over(R));
    await copyAll(t, "R");
    await read(t, ids.chatId, [
      { ...first, blocks: [{ type: "text", text: "Voici le rapport." }, { type: "file", kind: "document", artifactId: "artifact_managed_media_2", label: "rapportfinal.txt" }] },
    ]);
    await copyAll(t, "R");
    const doc = (await t.run(async (ctx) => (await ctx.db.query("messages").collect()).find((m) => m.runId === R)))!;
    expect(doc.text).toBe("Voici le rapport.\n\nFichiers : rapportfinal.txt");
    const asUser = t.withIdentity({ subject: ids.userId });
    const reference = await asUser.query(api.chatExport.getChatReference, { chatId: ids.chatId });
    const exported = await asUser.query(api.chatExport.exportByReference, { reference });
    expect(exported?.markdown).toContain("rapportfinal.txt");
    expect(exported?.markdown).not.toContain("brouillon.txt");
    const hitNew = await asUser.query(api.search.searchConversations, { query: "rapportfinal" });
    const hitOld = await asUser.query(api.search.searchConversations, { query: "brouillon" });
    expect(hitNew.length).toBeGreaterThan(0);
    expect(hitOld).toEqual([]);
    const body = composedTurnBody(doc, { byMsg: new Map(), unsettled: new Set() } as never, "fr" as never, undefined);
    expect(body).toContain("rapportfinal.txt");
    expect(body).not.toContain("brouillon.txt");
  });
});

// §3.3: « marquée retracted et jamais rendue ». A bubble born from a row seen only live,
// whose covering durable read does not return it, keeps no text the transcript does not hold.
describe("a bubble every row of which was retracted goes", () => {
  test("born from a live-only row, retracted by the covering read: the bubble is removed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await read(t, ids.chatId, [said("r59", 59, "before", "Avant.")], over("before"));
    await live(t, ids.chatId, [said("ghost", 60, "ghost-run", "Texte fantôme.")]);
    await read(t, ids.chatId, [], over("ghost-run"));
    expect((await view(t, ids)).some((m) => m.text.includes("Texte fantôme."))).toBe(true);
    // The durable read spans seq 60 and does not return it.
    await read(t, ids.chatId, [said("r59", 59, "before", "Avant."), said("r61", 61, "after", "Après.")], over("after"));
    const bubbles = await view(t, ids);
    expect(bubbles.some((m) => m.text.includes("Texte fantôme."))).toBe(false);
    expect(bubbles.find((m) => m.runId === "before")!.text).toBe("Avant.");
    const ghost = await t.run(async (ctx) => (await ctx.db.query("transcriptRows").collect()).find((r) => r.entryId === "ghost"));
    expect(ghost?.retracted).toBe(true);
    expect(ghost?.messageId).toBeUndefined();
  });
});

// Final design §5 and Olivier's R4 decision: after `on` → `shadow`, the turns follow the
// old path again — a live file is attached as before (no rule by name or path: a duplicate
// is possible once, at the switch, and stays stored). What the READER sees is still decided
// by R4: in a mixed group, a live part whose bytes a row already shows is withheld.
describe("rollback to shadow: R4 holds over a mixed group, storage stays faithful", () => {
  test("a live part with the bytes a row shows is withheld at display (same bubble, then another of the group)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-r";
    await read(
      t,
      ids.chatId,
      [said("m1", 5, R, "Voici.", { blocks: [{ type: "text", text: "Voici." }, { type: "file", kind: "document", artifactId: "artifact_managed_media_9", label: "bench-settle.txt" }] })],
      over(R),
    );
    await copyAll(t, "SETTLE");
    const [b] = await view(t, ids);
    await t.run(async (ctx) => {
      const inst = (await ctx.db.query("instances").collect())[0]!;
      await ctx.db.patch(inst._id, { config: { transcriptProjection: "shadow" } as never });
    });
    const add = async (messageId: Id<"messages">, filename: string, bytes: string) => {
      const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
      await t.mutation(internal.stream.addPart, {
        messageId,
        part: { kind: "media", storageId, filename, mimeType: "text/plain" },
        boundInstanceName: "prod",
      } as never);
      return storageId;
    };
    // Same bubble: the same bytes under another name (no rule by name), and other bytes.
    const dup = await add(b!._id, "copie.txt", "SETTLE");
    const other = await add(b!._id, "autre.txt", "AUTRE");
    // Another bubble of the same display group (shadow-era, no row layout).
    const later = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId: ids.chatId, userId: ids.userId, role: "assistant" as const, status: "complete" as const, text: "suite", runId: "after-rollback", turnSessionKey: SK, boundInstance: "prod", displayGroupId: b!._id, updatedAt: 2 }),
    );
    await t.run((ctx) => ctx.db.patch(b!._id, { displayGroupId: b!._id }));
    const dupLater = await add(later, "bench-settle.txt", "SETTLE");
    // Storage: every part kept.
    const stored = await t.run((ctx) => ctx.db.query("messageParts").collect());
    expect(stored.filter((p) => p.part.kind === "media")).toHaveLength(4);
    // Display: the two duplicates withheld by their bytes (sha256), never by name or path.
    const all = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as Array<{
      _id: Id<"messages">;
      displayHidden?: Array<{ rule: string; storageId?: string }>;
    }>;
    const hidden = all.flatMap((m) => (m.displayHidden ?? []).filter((d) => d.storageId !== undefined).map((d) => d.storageId));
    expect(hidden.sort()).toEqual([String(dup), String(dupLater)].sort());
    expect(hidden).not.toContain(String(other));
  });
});
