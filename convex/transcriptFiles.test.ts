/// <reference types="vite/client" />
//
// THE ROW CONTRACT WITH BLOCKS AND THE FILES IT CARRIES — the Convex half of the final
// design's steps 1 and 2 (lib/transcriptContent.ts, transcriptFiles.ts).
//
// The rows below are the ones the 2026.9.33 golden corpus yields through the bridge
// (bridge/test/fixtures/transcript-2026.9.33/, bridge/test/transcript-corpus-2026.9.33
// .test.ts): the delivery mirror seq 16 (a text, a managed attachment, a managed image) and
// seq 23 (a text and a `MEDIA:` reference). Each guarantee is pinned against the upstream
// test that fixes it, cited where it is reproduced.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { cascadeDeleteChat } from "./chats";
import { blobReference } from "./lib/blobs";
import schema from "./schema";
import { COPY_LEASE_MS, MAX_COPY_ATTEMPTS, MAX_FILES_HANDED } from "./transcriptFiles";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
/** Every OpenClaw instance is projected (0.102.0). */
type Mode = "on";

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

const SK = "agent:alice:atrium:chat:u-probe:refonte-2026-10-16t16-59-38-883z";
const RUN = "announce:requester-settle:alice:x:1fe3d5c5-1320-45ac-b11f-60b2987e65e5:yield-1";
const ART_DOC = "artifact_managed_media_03d85d8e-b298-4812-b5a1-3fffb6ad2e8b";
const ART_IMG = "artifact_managed_image_0e844b10-2d50-44ce-a329-983b99c8b328";
const MEDIA_PATH = "/home/node/.openclaw/media/outbound/probe-refonte-a-2026-10-16t16-59-38-883z.txt";

/** seq 16 of the corpus, as the bridge posts it in `on` (transcript-corpus test pins the
 *  same blocks from the captured row). */
const mirror16 = () => ({
  entryId: "e8bd9834-d360-4cd2-8302-4a51e3dde5f2",
  seq: 16,
  role: "assistant",
  runId: RUN,
  hidden: false,
  visible: true,
  text: "PROBE_SEND_DONE Voici les deux fichiers demandés.",
  blocks: [
    { type: "text", text: "PROBE_SEND_DONE Voici les deux fichiers demandés." },
    {
      type: "file",
      kind: "document",
      artifactId: ART_DOC,
      mimeType: "text/plain",
      sizeBytes: 16,
      label: "probe-refonte-a-2026-10-16t16-59-38-883z.txt",
    },
    {
      type: "file",
      kind: "image",
      artifactId: ART_IMG,
      mimeType: "image/png",
      sizeBytes: 1795,
      label: "probe-refonte-img-2026-10-16t16-59-38-883z.png",
    },
  ],
  transcriptPosition: { source: "M-WCtPtLqwIScHKjz_RlYtCESxjAfvCr8hzVGJfF3Hw", rawSeq: 27 },
  idempotencyKind: "message-tool",
  deliveryMirror: true,
  stopReason: "stop",
});

/** seq 23: a text and a `MEDIA:` reference left in it (not a managed copy). */
const mirror23 = (entryId = "221b30f1-fb50-452d-a8e3-3a5f9224e696", seq = 23) => ({
  entryId,
  seq,
  role: "assistant",
  runId: RUN,
  hidden: false,
  visible: true,
  text: "PROBE_SUMMARY Les deux fichiers ont été envoyés et le fichier texte vérifié.",
  blocks: [
    { type: "text", text: "PROBE_SUMMARY Les deux fichiers ont été envoyés et le fichier texte vérifié." },
    {
      type: "file",
      kind: "document",
      mediaSource: MEDIA_PATH,
      mimeType: "text/plain",
      label: "probe-refonte-a-2026-10-16t16-59-38-883z.txt",
    },
  ],
  idempotencyKind: "message-tool",
  deliveryMirror: true,
});

async function seed(t: T, mode: Mode, instanceName = "prod") {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    await ctx.db.insert("instances", {
      name: instanceName,
      gatewayUrl: "ws://gw",
    });
    void mode;
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName, agentId: "alice" });
    return { userId, chatId };
  });
}

function apply(t: T, chatId: Id<"chats">, rows: unknown[], extra: Record<string, unknown> = {}) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "514937bc",
    kind: "live",
    textsOnly: true,
    rows: rows as never,
    terminals: [],
    unidentified: 0,
    readAt: Date.now(),
    ...extra,
  } as never) as Promise<{ ok: boolean; filesToCopy?: Array<{ fileId: string; artifactId?: string; mediaSource?: string }> }>;
}

const files = (t: T) => t.run((ctx) => ctx.db.query("transcriptFiles").collect());

/** Hex SHA-256 (what the bridge reports for the bytes that streamed). */
async function sha256Hex(bytes: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("step 1 — the row contract with blocks (projection `on` only)", () => {
  test("the mirror's blocks and display facts are stored with the row; the text it always had is unchanged", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    const [row] = await t.run((ctx) => ctx.db.query("transcriptRows").collect());
    expect(row).toMatchObject({
      entryId: "e8bd9834-d360-4cd2-8302-4a51e3dde5f2",
      seq: 16,
      transcriptPosition: { source: "M-WCtPtLqwIScHKjz_RlYtCESxjAfvCr8hzVGJfF3Hw", rawSeq: 27 },
      idempotencyKind: "message-tool",
      deliveryMirror: true,
      stopReason: "stop",
    });
    const [doc] = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
    expect(doc?.text).toBe("PROBE_SEND_DONE Voici les deux fichiers demandés.");
    expect(doc?.blocks?.map((b) => b.type)).toEqual(["text", "file", "file"]);
    expect(doc?.blocks?.[1]).toMatchObject({ artifactId: ART_DOC, kind: "document", sizeBytes: 16 });
    expect(doc?.blocks?.[2]).toMatchObject({ artifactId: ART_IMG, kind: "image", mimeType: "image/png" });
  });

  test("a replayed row rewrites nothing: same signature, same document, no second file", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    const before = await t.run(async (ctx) => ({
      texts: await ctx.db.query("transcriptRowTexts").collect(),
      files: await ctx.db.query("transcriptFiles").collect(),
    }));
    await apply(t, chatId, [mirror16()]);
    const after = await t.run(async (ctx) => ({
      texts: await ctx.db.query("transcriptRowTexts").collect(),
      files: await ctx.db.query("transcriptFiles").collect(),
    }));
    expect(after.texts).toEqual(before.texts);
    expect(after.files.map((f) => f._id)).toEqual(before.files.map((f) => f._id));
  });

  test("a display fact that moves on a later read is updated on the row", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    await apply(t, chatId, [{ ...mirror16(), transcriptPosition: { source: "M-WCtPtLqwIScHKjz_RlYtCESxjAfvCr8hzVGJfF3Hw", rawSeq: 29 } }]);
    const [row] = await t.run((ctx) => ctx.db.query("transcriptRows").collect());
    expect(row?.transcriptPosition?.rawSeq).toBe(29);
  });

  test("a read that carries no blocks (an older bridge) keeps the stored ones", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    const { blocks: _b, ...textOnly } = mirror16();
    await apply(t, chatId, [textOnly]);
    const [doc] = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
    expect(doc?.blocks).toHaveLength(3);
  });

  test("blocks are re-bounded at the trust boundary: a malformed block is dropped, never guessed", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    const row = {
      ...mirror16(),
      blocks: [
        { type: "tool", toolCallId: "", status: "call" },
        { type: "file", kind: "image", artifactId: "a".repeat(257) },
        { type: "text", text: "ok" },
      ],
    };
    await apply(t, chatId, [row]);
    const [doc] = await t.run((ctx) => ctx.db.query("transcriptRowTexts").collect());
    // The over-long artifact id is not a managed identity: the image keeps no source.
    expect(doc?.blocks).toEqual([{ type: "file", kind: "image" }, { type: "text", text: "ok" }]);
    const [f] = await files(t);
    expect(f).toMatchObject({ state: "refused", reason: "unsupported_source" });
  });

  test("a block of an unknown shape is refused by the validator: the apply writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    const row = { ...mirror16(), blocks: [{ type: "file", kind: "spreadsheet", artifactId: "artifact_managed_media_x" }] };
    await expect(apply(t, chatId, [row])).rejects.toThrow(/Validator error/);
    expect(await t.run((ctx) => ctx.db.query("transcriptRows").collect())).toHaveLength(0);
    expect(await files(t)).toHaveLength(0);
  });
});

describe("step 2 — one record per file block, identified as the Control UI identifies it", () => {
  test("seq 16: two managed files recorded pending and handed to the bridge with the answer", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    const res = await apply(t, chatId, [mirror16()]);
    const recorded = await files(t);
    expect(recorded.map((f) => [f.artifactId, f.blockIndex, f.state])).toEqual([
      [ART_DOC, 1, "pending"],
      [ART_IMG, 2, "pending"],
    ]);
    expect(res.filesToCopy?.map((f) => f.artifactId)).toEqual([ART_DOC, ART_IMG]);
  });

  test("a handed file is LEASED: the next read does not hand it again until the lease lapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    expect((await apply(t, chatId, [])).filesToCopy ?? []).toHaveLength(0);
    vi.setSystemTime(Date.now() + COPY_LEASE_MS + 1);
    expect((await apply(t, chatId, [])).filesToCopy?.map((f) => f.artifactId)).toEqual([ART_DOC, ART_IMG]);
  });

  // Upstream src/gateway/internal-source-reply-persistence.test.ts:249 "completes exact
  // replay and refreshes history after %s": a replay with the same key keeps the SAME
  // attachmentIds — so the same artifact, however it is read again, is one copy.
  test("the same artifact read again on another row of the session is the same record (one copy)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    await apply(t, chatId, [{ ...mirror16(), entryId: "replayed-row", seq: 30 }]);
    expect((await files(t)).map((f) => f.artifactId)).toEqual([ART_DOC, ART_IMG]);
  });

  // Upstream src/agents/tools/message-tool.internal-source-reply.integration.test.ts:345
  // "publishes managed media with aligned metadata and the current run owner": two
  // concurrent identical sends make ONE row with 2 `image` + 1 `attachment` blocks.
  test("one row with two managed images and one managed attachment: three records", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    const row = {
      ...mirror16(),
      blocks: [
        { type: "text", text: "Durable image reply" },
        { type: "file", kind: "image", artifactId: "artifact_managed_image_1", label: "first.png" },
        { type: "file", kind: "image", artifactId: "artifact_managed_image_2", label: "second.png" },
        { type: "file", kind: "document", artifactId: "artifact_managed_media_3", label: "Quarterly report.json" },
      ],
    };
    await apply(t, chatId, [row]);
    await apply(t, chatId, [row]);
    expect((await files(t)).map((f) => [f.artifactId, f.blockIndex])).toEqual([
      ["artifact_managed_image_1", 1],
      ["artifact_managed_image_2", 2],
      ["artifact_managed_media_3", 3],
    ]);
  });

  // Olivier's R4 decision (refonte-finale-conception.md, 2026-10-16): storage stays faithful
  // — the same file sent by two rows (corpus same-file-two-rows.json: two artifact ids, the
  // same 17 bytes) is two records and two copies, each with its sha256; only the display
  // (step 3) shows it once.
  test("R4: the same bytes under two artifact ids are two records and two copies, both with their sha256", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    const send = (entryId: string, seq: number, artifactId: string) => ({
      ...mirror16(),
      entryId,
      seq,
      blocks: [
        { type: "text", text: "envoi" },
        { type: "file", kind: "document", artifactId, mimeType: "text/plain", sizeBytes: 17, label: "bench-codemode-a.txt" },
      ],
    });
    await apply(t, chatId, [
      send("row-48", 48, "artifact_managed_media_5952df0c-55a9-40d6-8915-9f7bbe2ff0ec"),
      send("row-55", 55, "artifact_managed_media_a2f0cb47-0a14-4e65-8d82-2fa7cbbf6b97"),
    ]);
    const recorded = await files(t);
    expect(recorded).toHaveLength(2);
    const sha = await sha256Hex("BENCH_CODEMODE_OK");
    for (const f of recorded) {
      const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["BENCH_CODEMODE_OK"])));
      const res = await t.mutation(internal.transcriptFiles.finalizeCopy, {
        boundInstanceName: "prod",
        fileId: f._id,
        storageId,
        sha256: sha,
        sizeBytes: 17,
        mimeType: "text/plain",
      });
      expect(res).toMatchObject({ ok: true, duplicate: false });
    }
    const copied = await files(t);
    expect(copied.map((f) => [f.state, f.sha256])).toEqual([
      ["copied", sha],
      ["copied", sha],
    ]);
    expect(new Set(copied.map((f) => f.storageId)).size).toBe(2);
  });

  test("seq 23: a MEDIA: reference is identified by its row and block, never by its path", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror23(), mirror23("another-row", 24)]);
    const recorded = await files(t);
    // Two rows naming the same path are two files, as the Control UI shows two attachments.
    expect(recorded.map((f) => [f.entryId, f.blockIndex, f.mediaSource, f.state])).toEqual([
      ["221b30f1-fb50-452d-a8e3-3a5f9224e696", 1, MEDIA_PATH, "pending"],
      ["another-row", 1, MEDIA_PATH, "pending"],
    ]);
    expect(recorded.every((f) => f.artifactId === undefined)).toBe(true);
  });

  test("what can never be copied is stated at once, never left pending", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    const row = {
      ...mirror16(),
      blocks: [
        { type: "file", kind: "image", remote: true, label: "remote.png" },
        { type: "file", kind: "document", errorCode: "file-not-found", label: "gone.pdf" },
        { type: "file", kind: "document", errorCode: "unsupported-format", label: "settings.toml" },
        { type: "file", kind: "image", omitted: true },
        { type: "file", kind: "document", label: "no-source.pdf" },
      ],
    };
    await apply(t, chatId, [row]);
    expect((await files(t)).map((f) => [f.state, f.reason])).toEqual([
      ["refused", "remote_source"],
      ["gone", "file-not-found"],
      ["refused", "unsupported-format"],
      ["refused", "omitted"],
      ["refused", "unsupported_source"],
    ]);
  });

  test("a tombstoned (deleted) answer's row stores no content, so no file", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await t.run((ctx) =>
      ctx.db.insert("transcriptTombstones", {
        chatId,
        sessionKey: SK,
        runId: RUN,
        segment: -1,
        fromSeq: -1,
        createdAt: 1,
      } as never),
    );
    await apply(t, chatId, [mirror16()]);
    expect(await files(t)).toHaveLength(0);
  });
});

describe("step 2 — the copy's outcome", () => {
  async function pendingFile(t: T) {
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    const [f] = await files(t);
    return { chatId, fileId: f!._id };
  }

  test("a copy whose blob is exactly what streamed is finalized `copied`", async () => {
    const t = convexTest(schema, modules);
    const { fileId } = await pendingFile(t);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    const res = await t.mutation(internal.transcriptFiles.finalizeCopy, {
      boundInstanceName: "prod",
      fileId,
      storageId,
      sha256: await sha256Hex("PROBE_REFONTE_OK"),
      sizeBytes: 16,
      mimeType: "text/plain",
    });
    expect(res).toMatchObject({ ok: true, state: "copied", duplicate: false });
    expect(await t.run((ctx) => ctx.db.get(fileId))).toMatchObject({
      state: "copied",
      storageId,
      sha256: "b973a6005c36512b5bd405e41ffc3bc5be128098b650b0ebc477f1f554a4ba68",
    });
  });

  test("the loser of a race deletes its blob; the first copy stays", async () => {
    const t = convexTest(schema, modules);
    const { fileId } = await pendingFile(t);
    const sha = await sha256Hex("PROBE_REFONTE_OK");
    const first = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    const second = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    const args = { boundInstanceName: "prod", fileId, sha256: sha, sizeBytes: 16, mimeType: "text/plain" };
    await t.mutation(internal.transcriptFiles.finalizeCopy, { ...args, storageId: first });
    const res = await t.mutation(internal.transcriptFiles.finalizeCopy, { ...args, storageId: second });
    expect(res).toMatchObject({ ok: true, duplicate: true });
    expect(await t.run((ctx) => ctx.db.system.get("_storage", second))).toBeNull();
    expect(await t.run((ctx) => ctx.db.system.get("_storage", first))).not.toBeNull();
    expect((await t.run((ctx) => ctx.db.get(fileId)))?.storageId).toBe(first);
  });

  // Codex review 16: a copy report delivered twice (an HTTP retransmission) deleted the blob
  // its first delivery had just finalized, while answering `copied`.
  test("the same report delivered again answers the same and keeps the file downloadable", async () => {
    const t = convexTest(schema, modules);
    const { fileId } = await pendingFile(t);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    const report = { boundInstanceName: "prod", fileId, storageId, sha256: await sha256Hex("PROBE_REFONTE_OK"), sizeBytes: 16, mimeType: "text/plain" };
    const first = await t.mutation(internal.transcriptFiles.finalizeCopy, report);
    const again = await t.mutation(internal.transcriptFiles.finalizeCopy, report);
    const third = await t.mutation(internal.transcriptFiles.finalizeCopy, report);
    expect(again).toEqual(first);
    expect(third).toEqual(first);
    expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(fileId))).toMatchObject({ state: "copied", storageId });
    // Nothing for the resume to repair: a copied file is never handed again.
    const leased = await t.mutation(internal.transcriptFiles.leaseDueForResume, {});
    expect(JSON.stringify(leased)).not.toContain(String(fileId));
  });

  test("a failure reported after the copy (gone, refused or retry) never undoes it", async () => {
    const t = convexTest(schema, modules);
    const { fileId } = await pendingFile(t);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    await t.mutation(internal.transcriptFiles.finalizeCopy, { boundInstanceName: "prod", fileId, storageId, sha256: await sha256Hex("PROBE_REFONTE_OK"), sizeBytes: 16, mimeType: "text/plain" });
    for (const outcome of ["gone", "refused", "retry"] as const) {
      const res = await t.mutation(internal.transcriptFiles.noteCopyFailure, { boundInstanceName: "prod", fileId, outcome, reason: "late" });
      expect(res).toEqual({ ok: true, state: "copied" });
    }
    expect(await t.run((ctx) => ctx.db.get(fileId))).toMatchObject({ state: "copied", storageId });
    expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).not.toBeNull();
  });

  test("a losing report never deletes a blob something else holds", async () => {
    // Two records of the session (R4: the same bytes under two artifact ids), each copied
    // to its own blob; a stray report names the OTHER record's blob for the first one.
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    const [a, b] = await files(t);
    const sha = await sha256Hex("PROBE_REFONTE_OK");
    const blobA = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    const blobB = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    const base = { boundInstanceName: "prod", sha256: sha, sizeBytes: 16, mimeType: "text/plain" };
    await t.mutation(internal.transcriptFiles.finalizeCopy, { ...base, fileId: a!._id, storageId: blobA });
    await t.mutation(internal.transcriptFiles.finalizeCopy, { ...base, fileId: b!._id, storageId: blobB });
    const res = await t.mutation(internal.transcriptFiles.finalizeCopy, { ...base, fileId: a!._id, storageId: blobB });
    expect(res).toMatchObject({ ok: true, duplicate: true });
    expect(await t.run((ctx) => ctx.db.system.get("_storage", blobB))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.system.get("_storage", blobA))).not.toBeNull();
  });

  test("a blob that is not what streamed is refused and deleted; the file stays pending", async () => {
    const t = convexTest(schema, modules);
    const { fileId } = await pendingFile(t);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["TRUNCATED"])));
    const res = await t.mutation(internal.transcriptFiles.finalizeCopy, {
      boundInstanceName: "prod",
      fileId,
      storageId,
      sha256: await sha256Hex("PROBE_REFONTE_OK"),
      sizeBytes: 16,
      mimeType: "text/plain",
    });
    expect(res).toMatchObject({ ok: false, reason: "checksum_mismatch" });
    expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(fileId)))?.state).toBe("pending");
  });

  test("`copied` always carries its sha256: a report without a valid one is refused (R4: the display dedup needs it)", async () => {
    const t = convexTest(schema, modules);
    const { fileId } = await pendingFile(t);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    const res = await t.mutation(internal.transcriptFiles.finalizeCopy, {
      boundInstanceName: "prod",
      fileId,
      storageId,
      sha256: "",
      sizeBytes: 16,
      mimeType: "text/plain",
    });
    expect(res).toMatchObject({ ok: false, reason: "checksum_mismatch" });
    expect((await t.run((ctx) => ctx.db.get(fileId)))?.state).toBe("pending");
    const copied = (await files(t)).filter((f) => f.state === "copied");
    expect(copied.every((f) => typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  test("another instance's bridge can neither finalize nor fail a file", async () => {
    const t = convexTest(schema, modules);
    const { fileId } = await pendingFile(t);
    await expect(
      t.mutation(internal.transcriptFiles.noteCopyFailure, {
        boundInstanceName: "intruder",
        fileId,
        outcome: "gone",
        reason: "artifact_not_found",
      }),
    ).rejects.toThrow(/forbidden: cross-instance transcript file/);
    expect((await t.run((ctx) => ctx.db.get(fileId)))?.state).toBe("pending");
  });

  test("gone after a reset, refused over the cap: stated, with their reason", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    const [doc, img] = await files(t);
    await t.mutation(internal.transcriptFiles.noteCopyFailure, {
      boundInstanceName: "prod",
      fileId: doc!._id,
      outcome: "gone",
      reason: "artifact_not_found",
    });
    await t.mutation(internal.transcriptFiles.noteCopyFailure, {
      boundInstanceName: "prod",
      fileId: img!._id,
      outcome: "refused",
      reason: "too_large",
    });
    expect((await files(t)).map((f) => [f.state, f.reason])).toEqual([
      ["gone", "artifact_not_found"],
      ["refused", "too_large"],
    ]);
    // A verdict is final: a late copy of a gone file does not resurrect it.
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    await t.mutation(internal.transcriptFiles.finalizeCopy, {
      boundInstanceName: "prod",
      fileId: doc!._id,
      storageId,
      sha256: await sha256Hex("x"),
      sizeBytes: 1,
      mimeType: "text/plain",
    });
    expect((await t.run((ctx) => ctx.db.get(doc!._id)))?.state).toBe("gone");
  });

  test("a transient failure backs off, and after MAX_COPY_ATTEMPTS is refused visibly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = convexTest(schema, modules);
    const { fileId } = await pendingFile(t);
    const retry = () =>
      t.mutation(internal.transcriptFiles.noteCopyFailure, {
        boundInstanceName: "prod",
        fileId,
        outcome: "retry",
        reason: "fetch_error",
      });
    const t0 = Date.now();
    await retry();
    expect(await t.run((ctx) => ctx.db.get(fileId))).toMatchObject({
      state: "pending",
      attempts: 1,
      nextAttemptAt: t0 + 5 * 60_000,
    });
    for (let i = 1; i < MAX_COPY_ATTEMPTS; i++) await retry();
    expect(await t.run((ctx) => ctx.db.get(fileId))).toMatchObject({
      state: "refused",
      reason: "attempts_exhausted",
      attempts: MAX_COPY_ATTEMPTS,
    });
  });

  test("the resume cron's lease hands due files by instance, and leases them", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror23()]);
    // The read leased it: the cron does not take it before the lease lapses.
    expect(await t.mutation(internal.transcriptFiles.leaseDueForResume, {})).toEqual([]);
    await t.run(async (ctx) => {
      const [f] = await ctx.db.query("transcriptFiles").collect();
      await ctx.db.patch(f!._id, { nextAttemptAt: 0 });
    });
    const groups = await t.mutation(internal.transcriptFiles.leaseDueForResume, {});
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ instanceName: "prod" });
    expect(groups[0]!.files.map((f) => f.mediaSource)).toEqual([MEDIA_PATH]);
    expect(await t.mutation(internal.transcriptFiles.leaseDueForResume, {})).toEqual([]);
  });

  // Codex review 17: the cron took the deployment's 100 oldest pending files and filtered
  // them afterwards; an unreachable instance's backlog was the same 100 every run.
  test("an unreachable instance's backlog never holds back a healthy instance's due file", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "healthy", gatewayUrl: "ws://gw2" });
      const base = { chatId, sessionKey: SK, kind: "document", state: "pending" as const, attempts: 0 };
      // Older than anything the healthy instance has, and due.
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert("transcriptFiles", { ...base, instanceName: "prod", entryId: `dead-${i}`, blockIndex: 0, nextAttemptAt: 0, updatedAt: 1 });
      }
      await ctx.db.insert("transcriptFiles", { ...base, instanceName: "healthy", entryId: "alive", blockIndex: 0, nextAttemptAt: 5, updatedAt: 1_000 });
    });
    for (let run = 0; run < 3; run++) {
      const groups = await t.mutation(internal.transcriptFiles.leaseDueForResume, {});
      expect(groups.find((g) => g.instanceName === "healthy")?.files.length ?? 0).toBe(run === 0 ? 1 : 0);
      // The unreachable one gets its bounded share each run, its lease moving it on.
      expect(groups.find((g) => g.instanceName === "prod")?.files.length).toBe(MAX_FILES_HANDED);
    }
  });
});

describe("step 2 — retention: a copy is a blob holder, and goes with its chat", () => {
  test("a copied blob held only by its transcript file is referenced (never swept as an orphan)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    const [f] = await files(t);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    await t.mutation(internal.transcriptFiles.finalizeCopy, {
      boundInstanceName: "prod",
      fileId: f!._id,
      storageId,
      sha256: await sha256Hex("PROBE_REFONTE_OK"),
      sizeBytes: 16,
      mimeType: "text/plain",
    });
    expect(await t.run((ctx) => blobReference(ctx, storageId))).toBe("transcriptFile");
  });

  test("the chat purge deletes the file records and releases their blobs", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t, "on");
    await apply(t, chatId, [mirror16()]);
    const [f] = await files(t);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["PROBE_REFONTE_OK"])));
    await t.mutation(internal.transcriptFiles.finalizeCopy, {
      boundInstanceName: "prod",
      fileId: f!._id,
      storageId,
      sha256: await sha256Hex("PROBE_REFONTE_OK"),
      sizeBytes: 16,
      mimeType: "text/plain",
    });
    await t.run((ctx) => cascadeDeleteChat(ctx, chatId, { inline: false }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await files(t)).toHaveLength(0);
    const releases = await t.run((ctx) => ctx.db.query("blobReleases").collect());
    expect(releases.map((r) => r.storageId)).toEqual([storageId]);
  });
});
