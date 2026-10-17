/// <reference types="vite/client" />
//
// CODEX REVIEW 2 — findings 2 and 3, end to end.
//   2. A row that carries blocks is rendered by them alone, in their order — the path a
//      real row takes: bridge `toTranscriptRow` → `applyTranscript` → `listByChat` →
//      `convertConvexMessage`, with no text cleaned by hand. The cache (`messages.text`,
//      read by the Markdown export and the search) keeps no `MEDIA:` directive a file block
//      replaced (the gateway's projection strips them: `stripAssistantMediaDirectivesForDisplay`).
//   3. ONE display de-duplication over the pieces the group shows, whatever the bubble's
//      state and the part's origin: two copies with the same bytes before any terminal show
//      one piece, and the same one after the terminal.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { toTranscriptRow } from "../../bridge/src/providers/openclaw/transcript-rows";
import { MAX_ROW_BLOCKS as BRIDGE_MAX_ROW_BLOCKS } from "../../bridge/src/providers/openclaw/row-blocks";
import { MAX_WIDGET_PARTS_PER_TURN } from "../../bridge/src/providers/openclaw/widgets";
import { LAYOUT_MAX_WIDGETS } from "../../convex/lib/bubbleProjection";
import { MAX_ROW_BLOCKS as CONVEX_MAX_ROW_BLOCKS } from "../../convex/lib/transcriptContent";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";

const modules = import.meta.glob("../../convex/**/*.ts");
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

async function seed(t: T) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: "on" } as never });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "prod", agentId: "main" });
    return { userId, chatId };
  });
  await apply(t, ids.chatId, [], { kind: "page" });
  return ids;
}
let clock = 1_000;
function apply(t: T, chatId: Id<"chats">, rows: Row[], extra: Row = {}) {
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
const over = (...runs: string[]) => ({ terminals: runs.map((runId) => ({ runId, status: "completed", at: Date.now() })), hasActiveRun: false });
async function view(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }): Promise<ConvexMessageView[]> {
  const all = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as ConvexMessageView[];
  return all.filter((m) => m.role === "assistant");
}
async function sha256Hex(bytes: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const shape = (m: ConvexMessageView) =>
  (convertConvexMessage(m).content as ReadonlyArray<{ type: string; text?: string; data?: string; filename?: string }>)
    .filter((p) => p.type === "text" || p.type === "file")
    .map((p) => (p.type === "text" ? `text:${p.text}` : `file:${p.filename}`));

describe("finding 2 — a row is rendered by its blocks, end to end", () => {
  // ui/src/lib/chat/message-normalizer.test.ts:501 — "Intro", image, "Outro", audio.
  test(":501 from the bridge to the rendering: no MEDIA: line, the pieces in order", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const row = toTranscriptRow(
      {
        role: "assistant",
        content: "Intro\nMEDIA:https://example.com/image.png\nOutro\nMEDIA:https://example.com/voice.ogg",
        __openclaw: { id: "r501", seq: 3, runId: "run-501", transcriptPosition: { source: "S", rawSeq: 3 } },
      },
      undefined,
      { sessionKey: SK },
    )!;
    await apply(t, ids.chatId, [row as unknown as Row], over("run-501"));
    const [b] = await view(t, ids);
    expect(shape(b!)).toEqual(["text:Intro", "file:image.png", "text:Outro", "file:voice.ogg"]);
    // The cache the export and the search read: no directive a file block replaced.
    expect(b!.text).not.toContain("MEDIA:");
    expect(b!.text).toBe("Intro\nOutro\n\nFichiers : image.png, voice.ogg");
    const asUser = t.withIdentity({ subject: ids.userId });
    const reference = await asUser.query(api.chatExport.getChatReference, { chatId: ids.chatId });
    const exported = await asUser.query(api.chatExport.exportByReference, { reference });
    expect(exported?.markdown).not.toContain("MEDIA:");
    expect(await asUser.query(api.search.searchConversations, { query: "MEDIA" })).toEqual([]);
  });
});

describe("finding 3 — one display de-duplication, whatever the bubble's state", () => {
  test("two copies of the same bytes before the terminal: one piece; after it: one piece, the same", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-dup";
    const m = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: R, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    const file = (entryId: string, seq: number, artifact: string): Row => ({
      entryId,
      seq,
      role: "assistant",
      runId: R,
      hidden: false,
      visible: true,
      text: `Envoi ${entryId}`,
      blocks: [{ type: "text", text: `Envoi ${entryId}` }, { type: "file", kind: "document", artifactId: artifact, label: "a.txt", mimeType: "text/plain" }],
    });
    const rows = [file("s1", 5, "artifact_managed_media_1"), file("s2", 6, "artifact_managed_media_2")];
    await apply(t, ids.chatId, rows, { hasActiveRun: true, activeRunIds: [R] });
    // The copies finish in the REVERSE order of their rows.
    const records = await t.run((ctx) => ctx.db.query("transcriptFiles").collect());
    for (const rec of [...records].sort((a, b) => (a.entryId < b.entryId ? 1 : -1))) {
      const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["SAME"])));
      await t.mutation(internal.transcriptFiles.finalizeCopy, {
        boundInstanceName: "prod",
        fileId: rec._id,
        storageId,
        sha256: await sha256Hex("SAME"),
        sizeBytes: 4,
        mimeType: "text/plain",
      });
    }
    const first = records.find((r) => r.entryId === "s1")!;
    const visible = (b: ConvexMessageView) =>
      (convertConvexMessage(b).content as ReadonlyArray<{ type: string; storageId?: string; data?: string }>).filter((p) => p.type === "file");
    let b = (await view(t, ids)).find((x) => x._id === m)!;
    expect(b.status).toBe("streaming");
    const before = visible(b);
    expect(before).toHaveLength(1);
    const firstPart = b.parts.find((p) => "transcriptFileId" in p && p.transcriptFileId === first._id) as { storageId: string };
    expect(before[0]!.storageId ?? null).toBe(firstPart.storageId);
    // The terminal: the layout shows the first row's file, once.
    await apply(t, ids.chatId, rows, over(R));
    b = (await view(t, ids)).find((x) => x._id === m)!;
    const after = visible(b);
    expect(after).toHaveLength(1);
    expect(after[0]!.storageId).toBe(firstPart.storageId);
  });
});

// CODEX REVIEW 3 — finding 2. A progressive upgrade: the run's first rows were written by a
// bridge without blocks (0.100.1), the next ones — read from the stored cursor once the
// bridge was upgraded — carry their blocks. The cards are decided ROW BY ROW: the new row
// shows its own card under it; the old row's live card stays shown; only the card the new
// row already shows is not repeated among the live ones.
describe("codex review 3, finding 2 — a cursor resume across two generations of rows", () => {
  test("the old row keeps its live card; the new row shows its own, once", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-upgrade";
    const m = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: R, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    for (const toolCallId of ["call-old", "call-new"]) {
      await t.mutation(internal.stream.addPart, {
        messageId: m,
        part: { kind: "tool", name: "exec", phase: "completed", toolCallId, textOffset: 0 },
        boundInstanceName: "prod",
      } as never);
    }
    // Before the upgrade: a 0.100.1 row — identity and text, no blocks.
    await apply(t, ids.chatId, [{ entryId: "a1", seq: 3, role: "assistant", runId: R, hidden: false, visible: true, toolCallIds: ["call-old"], text: "Je regarde." }]);
    // After it, resumed from the cursor: rows with their blocks, then the run's terminal.
    await apply(
      t,
      ids.chatId,
      [
        { entryId: "a2", seq: 5, role: "assistant", runId: R, hidden: false, visible: true, toolCallIds: ["call-new"], text: "", blocks: [{ type: "tool", toolCallId: "call-new", name: "exec", status: "call" }] },
        { entryId: "a3", seq: 7, role: "assistant", runId: R, hidden: false, visible: true, text: "Fait.", blocks: [{ type: "text", text: "Fait." }] },
      ],
      over(R),
    );
    const b = (await view(t, ids)).find((x) => x._id === m)!;
    expect(b.rowLayout!.map((r) => [r.entryId, r.blocks === true])).toEqual([
      ["a1", false],
      ["a2", true],
      ["a3", true],
    ]);
    const out = convertConvexMessage(b);
    const content = out.content as ReadonlyArray<{ type: string; text?: string; args?: { parts: Array<{ toolCallId?: string }> } }>;
    expect(content.map((p) => (p.type === "tool-call" ? `cards:${p.args!.parts.map((x) => x.toolCallId).join(",")}` : `${p.type}:${p.text ?? ""}`))).toEqual([
      "text:Je regarde.",
      "cards:call-new",
      "text:Fait.",
    ]);
    const custom = out.metadata?.custom as { toolParts: Array<{ toolCallId?: string }> };
    expect(custom.toolParts.map((p) => p.toolCallId)).toEqual(["call-old"]);
  });
});

// CODEX REVIEW 4 — finding 2. Blocks KNOWN BUT EMPTY are not blocks ABSENT. A row whose
// whole text is inbound metadata normalizes to nothing (ui/src/lib/chat/message-normalizer.ts
// :368 `stripMessageDisplayMetadata`): it shows nothing — not its raw text — and the cache
// the export and the search read (`messages.text`) never holds it. Only a row with no
// blocks at all (a 0.100.1 bridge) falls back to its text.
describe("codex review 4, finding 2 — a row normalized to nothing shows nothing", () => {
  const META = "Context: ⟦openclaw:ctx⟧\ncontexte interne";
  test("its blocks are known and empty, end to end: nothing rendered, nothing cached", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const meta = toTranscriptRow({ role: "assistant", content: META, __openclaw: { id: "m1", seq: 3, runId: "run-m" } }, undefined, { sessionKey: SK })!;
    expect(meta.blocks).toEqual([]);
    const answer = toTranscriptRow({ role: "assistant", content: "Réponse.", __openclaw: { id: "m2", seq: 4, runId: "run-m" } }, undefined, { sessionKey: SK })!;
    await apply(t, ids.chatId, [meta as unknown as Row, answer as unknown as Row], over("run-m"));
    const [b] = await view(t, ids);
    expect(b!.rowLayout!.map((r) => r.entryId)).toEqual(["m2"]);
    expect(shape(b!)).toEqual(["text:Réponse."]);
    expect(b!.text).toBe("Réponse.");
    expect(b!.text).not.toContain("contexte interne");
  });

  test("a reply made only of it: no bubble at all", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const meta = toTranscriptRow({ role: "assistant", content: META, __openclaw: { id: "m1", seq: 3, runId: "run-only" } }, undefined, { sessionKey: SK })!;
    await apply(t, ids.chatId, [meta as unknown as Row], over("run-only"));
    expect(await view(t, ids)).toEqual([]);
  });

  test("a row with NO blocks (a 0.100.1 bridge) still falls back to its text", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, [{ entryId: "o1", seq: 3, role: "assistant", runId: "run-o", hidden: false, visible: true, text: "Texte d'un ancien bridge." }], over("run-o"));
    const [b] = await view(t, ids);
    expect(shape(b!)).toEqual(["text:Texte d'un ancien bridge."]);
  });
});

// CODEX REVIEW 5 — finding 1. When every row a reader could see states its blocks, whole,
// the composition IS the bubble, even empty: the live overlay goes. After a REAL live
// stream (`startAssistant` + `setSnapshot`), a row normalized to nothing leaves no bubble;
// a row whose known blocks differ from the streamed text wins.
describe("codex review 5, finding 1 — the rows decide over what the live stream showed", () => {
  const META = "Context: ⟦openclaw:ctx⟧\ncontexte interne";
  async function streamed(t: T, chatId: Id<"chats">, runId: string, text: string) {
    const m = (await t.mutation(internal.stream.startAssistant, { chatId, runId, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    await t.mutation(internal.stream.setSnapshot, { messageId: m, text, expectedRunId: runId, boundInstanceName: "prod" } as never);
    return m;
  }
  test("streamed metadata, then its row normalized to nothing: no bubble, no cached text", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await streamed(t, ids.chatId, "run-meta", META);
    const row = toTranscriptRow({ role: "assistant", content: META, __openclaw: { id: "x1", seq: 3, runId: "run-meta" } }, undefined, { sessionKey: SK })!;
    expect(row.blocks).toEqual([]);
    await apply(t, ids.chatId, [row as unknown as Row], over("run-meta"));
    expect(await view(t, ids)).toEqual([]);
    const stored = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(stored.some((m) => (m.text ?? "").includes("contexte interne"))).toBe(false);
  });

  test("streamed text, then a row whose known blocks differ: the row wins", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = await streamed(t, ids.chatId, "run-diff", "Brouillon diffusé en direct, bien plus long que la réponse finale.");
    const row = toTranscriptRow({ role: "assistant", content: "Réponse finale.", __openclaw: { id: "x2", seq: 3, runId: "run-diff" } }, undefined, { sessionKey: SK })!;
    await apply(t, ids.chatId, [row as unknown as Row], over("run-diff"));
    const b = (await view(t, ids)).find((x) => x._id === m)!;
    expect(b.status).toBe("complete");
    expect(b.text).toBe("Réponse finale.");
    expect(b.rowLayout!.map((r) => r.entryId)).toEqual(["x2"]);
    expect(shape(b)).toEqual(["text:Réponse finale."]);
  });
});

// CODEX REVIEW 5 — finding 2. ONE set of layout bounds, shared by the planner and every
// reader (convex/lib/bubbleProjection.ts `LAYOUT_MAX_*`): whatever the layout renders has
// its files resolved; past the bounds the layout stops itself, says so, and never shows a
// generic "pending" file.
describe("codex review 5, finding 2 — what a layout renders, its readers resolve", () => {
  test("201 rows of one run, a file on the last: resolved, never a generic pending", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-201";
    const rows: Row[] = [];
    for (let i = 0; i < 200; i++) {
      rows.push({ entryId: `r${i}`, seq: 3 + i, role: "assistant", runId: R, hidden: false, visible: true, text: `ligne ${i}`, blocks: [{ type: "text", text: `ligne ${i}` }] });
    }
    rows.push({
      entryId: "last",
      seq: 203,
      role: "assistant",
      runId: R,
      hidden: false,
      visible: true,
      text: "fin",
      blocks: [{ type: "text", text: "fin" }, { type: "file", kind: "image", remote: true, url: "https://example.com/last.png", label: "last.png", mimeType: "image/png" }],
    });
    // Two reads (one apply's text bound): identities and texts of the first half, then the rest.
    await apply(t, ids.chatId, rows.slice(0, 32));
    for (let k = 32; k < rows.length; k += 32) await apply(t, ids.chatId, rows.slice(k, k + 32));
    await apply(t, ids.chatId, [], over(R));
    const [b] = await view(t, ids);
    expect(b!.rowLayout).toHaveLength(201);
    expect(b!.rowFiles).toEqual([expect.objectContaining({ entryId: "last", state: "remote", url: "https://example.com/last.png" })]);
    const files = (convertConvexMessage(b!).content as ReadonlyArray<{ type: string; data?: string; unavailable?: string }>).filter((p) => p.type === "file");
    expect(files).toEqual([expect.objectContaining({ data: "https://example.com/last.png" })]);
    expect(files.some((f) => f.unavailable !== undefined)).toBe(false);
  });
});

// The bounds the bridge and Convex each hold must agree (two packages, two constants): a
// row's block count, and the widgets one turn shows.
test("codex review 5, finding 2 — the bridge's bounds are Convex's", () => {
  expect(BRIDGE_MAX_ROW_BLOCKS).toBe(CONVEX_MAX_ROW_BLOCKS);
  expect(MAX_WIDGET_PARTS_PER_TURN).toBe(LAYOUT_MAX_WIDGETS);
});
