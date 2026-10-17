/// <reference types="vite/client" />
//
// CODEX REVIEW 1 of the transcript redesign — the three findings, reproduced then fixed:
//   1. deployment order (Convex → frontend → bridge): rows from a 0.100.1 bridge carry no
//      blocks, so their layout must not claim the bubble's tool cards;
//   2. a file copied while its run is still live is shown at once, not at the run's end;
//   3. a remote `MEDIA:` https reference is shown as is (never copied, never "refused").

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
type View = {
  _id: Id<"messages">;
  role: string;
  runId?: string;
  text: string;
  status: string;
  rowLayout?: Array<{ entryId: string; blocks?: boolean; files?: Array<{ blockIndex: number; remoteUrl?: string }> }>;
  rowFiles?: Array<{ entryId: string; blockIndex: number; state: string; url?: string; fileId?: string }>;
  parts: Array<{ kind: string; transcriptFileId?: string; toolCallId?: string }>;
};
async function view(t: T, ids: { userId: Id<"users">; chatId: Id<"chats"> }): Promise<View[]> {
  const all = (await t.withIdentity({ subject: ids.userId }).query(api.messages.listByChat, { chatId: ids.chatId as string })) as unknown as View[];
  return all.filter((m) => m.role === "assistant");
}
async function sha256Hex(bytes: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("finding 1 — a 0.100.1 bridge's rows do not claim the bubble's tool cards", () => {
  // The exact row shape a 0.100.1 bridge sends in `on`: identity facts and the text, NO
  // `blocks`, NO `transcriptPosition` (bridge/src/convex-writer.ts at v0.100.1,
  // `TranscriptRowReport`).
  const v0100Row: Row = { entryId: "a1", seq: 3, role: "assistant", runId: "r-old", hidden: false, visible: true, toolCallIds: ["call-1"], text: "Fait." };

  test("its layout says the rows carry no blocks; the live tool part stays on the bubble", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const m = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: "r-old", turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    await t.mutation(internal.stream.addPart, {
      messageId: m,
      part: { kind: "tool", name: "exec", phase: "completed", toolCallId: "call-1", textOffset: 0 },
      boundInstanceName: "prod",
    } as never);
    await apply(t, ids.chatId, [v0100Row], over("r-old"));
    const b = (await view(t, ids)).find((x) => x._id === m)!;
    expect(b.rowLayout).toBeDefined();
    expect(b.rowLayout!.some((r) => r.blocks === true)).toBe(false);
    expect(b.parts.filter((p) => p.kind === "tool").map((p) => p.toolCallId)).toEqual(["call-1"]);
  });

  test("a current bridge's rows say they carry their blocks", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(t, ids.chatId, [{ ...v0100Row, entryId: "a2", runId: "r-new", blocks: [{ type: "text", text: "Fait." }] }], over("r-new"));
    const b = (await view(t, ids)).find((x) => x.runId === "r-new")!;
    expect(b.rowLayout!.every((r) => r.blocks === true)).toBe(true);
  });
});

describe("finding 2 — a file copied while its run is live is shown at once", () => {
  test("the live bubble carries the derived part before the run ends; the settled layout keeps it, once", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-live";
    const m = (await t.mutation(internal.stream.startAssistant, { chatId: ids.chatId, runId: R, turnSessionKey: SK, boundInstanceName: "prod" } as never)) as Id<"messages">;
    const row: Row = {
      entryId: "f1",
      seq: 5,
      role: "assistant",
      runId: R,
      hidden: false,
      visible: true,
      text: "Voici.",
      blocks: [{ type: "text", text: "Voici." }, { type: "file", kind: "document", artifactId: "artifact_managed_media_7", label: "rapport.txt", mimeType: "text/plain" }],
    };
    // The row arrives while the run is live (no terminal, the session busy).
    await apply(t, ids.chatId, [row], { hasActiveRun: true, activeRunIds: [R] });
    const file = (await t.run((ctx) => ctx.db.query("transcriptFiles").collect()))[0]!;
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["RAPPORT"])));
    await t.mutation(internal.transcriptFiles.finalizeCopy, {
      boundInstanceName: "prod",
      fileId: file._id,
      storageId,
      sha256: await sha256Hex("RAPPORT"),
      sizeBytes: 7,
      mimeType: "text/plain",
    });
    let b = (await view(t, ids)).find((x) => x._id === m)!;
    expect(b.status).toBe("streaming");
    expect(b.parts.filter((p) => p.transcriptFileId === file._id)).toHaveLength(1);
    // The run ends: the layout names it under its row, still one part.
    await apply(t, ids.chatId, [row], over(R));
    b = (await view(t, ids)).find((x) => x._id === m)!;
    expect(b.rowFiles?.map((f) => [f.entryId, f.state, f.fileId])).toEqual([["f1", "copied", file._id]]);
    expect(b.parts.filter((p) => p.transcriptFileId !== undefined)).toHaveLength(1);
  });
});

describe("finding 3 — a remote MEDIA: https reference is shown as is", () => {
  // src/gateway/chat-display-projection.media.test.ts:257 (the reference is preserved for
  // the client) and ui/src/lib/chat/message-normalizer.test.ts:836 (relative and remote
  // keep their order): the Control UI renders it from its URL — `isLocalAssistantAttachment
  // Source` false, `resolveManagedAttachmentAvailability` → `{status:"available", url}`
  // (chat-message-attachments.ts:127-134), the compact card's `downloadHref`.
  test("no copy record, never refused; the view serves its URL under its row, in order", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const R = "run-remote";
    await apply(
      t,
      ids.chatId,
      [
        {
          entryId: "g1",
          seq: 7,
          role: "assistant",
          runId: R,
          hidden: false,
          visible: true,
          text: "Generated artifacts",
          blocks: [
            { type: "text", text: "Generated artifacts" },
            { type: "file", kind: "image", mediaSource: "image.png", label: "image.png", mimeType: "image/png" },
            { type: "file", kind: "image", remote: true, url: "https://example.com/remote.png", label: "remote.png", mimeType: "image/png" },
            { type: "file", kind: "audio", mediaSource: "voice.ogg", label: "voice.ogg", mimeType: "audio/ogg" },
          ],
        },
      ],
      over(R),
    );
    const files = await t.run((ctx) => ctx.db.query("transcriptFiles").collect());
    expect(files.map((f) => f.label).sort()).toEqual(["image.png", "voice.ogg"]);
    expect(files.some((f) => f.state === "refused")).toBe(false);
    const b = (await view(t, ids)).find((x) => x.runId === R)!;
    expect(b.rowFiles!.map((f) => [f.blockIndex, f.state, f.url ?? null])).toEqual([
      [1, "pending", null],
      [2, "remote", "https://example.com/remote.png"],
      [3, "pending", null],
    ]);
    expect(b.text).toContain("remote.png");
  });

  test("an http (not https) or malformed URL is never kept as a remote reference", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await apply(
      t,
      ids.chatId,
      [
        {
          entryId: "h1",
          seq: 9,
          role: "assistant",
          runId: "r-h",
          hidden: false,
          visible: true,
          text: "x",
          blocks: [{ type: "text", text: "x" }, { type: "file", kind: "image", remote: true, url: "http://insecure.test/a.png", label: "a.png" }],
        },
      ],
      over("r-h"),
    );
    const b = (await view(t, ids)).find((x) => x.runId === "r-h")!;
    expect(b.rowFiles?.some((f) => f.state === "remote")).toBe(false);
  });
});
