/// <reference types="vite/client" />
//
// `POST /bridge/ingest` httpAction DISPATCH (convex/bridge_ingest.ts). Closes the
// disclosed coverage gap: both ENDS of the outbound-media write were covered
// (the bridge POSTs the op; files.test.ts covers stream.addPart(media) -> part +
// files row) but the httpAction that AUTHENTICATES the bridge and ROUTES the op
// was never exercised. This drives the real route via convex-test's `t.fetch`,
// asserting the addMediaPart path end-to-end (media part + files-row invariant),
// the mimeType default, the Bearer gate (every reject reason), the SOC2 trace
// shape (structural meta only — NEVER filename/path/content), and the
// part-free `mediaTrace` diagnostic.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const SECRET = "test-ingest-secret";
const URL = "/bridge/ingest";

let prevSecret: string | undefined;
beforeEach(() => {
  prevSecret = process.env.BRIDGE_INGEST_SECRET;
  process.env.BRIDGE_INGEST_SECRET = SECRET;
});
afterEach(() => {
  if (prevSecret === undefined) delete process.env.BRIDGE_INGEST_SECRET;
  else process.env.BRIDGE_INGEST_SECRET = prevSecret;
});

type T = ReturnType<typeof convexTest>;

/** A chat + a streaming assistant message to attach parts to. */
async function seedAssistantMessage(t: T) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u",
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
    return { userId, chatId, messageId };
  });
}

async function storedBlob(t: T, bytes: string) {
  return await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
}

function post(t: T, body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== null) headers["Authorization"] = auth;
  return t.fetch(URL, { method: "POST", headers, body: JSON.stringify(body) });
}

async function partsOf(t: T, messageId: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", messageId as never))
      .collect(),
  );
}

async function tracesByKind(t: T, kind: string) {
  return await t.run(async (ctx) => {
    const all = await ctx.db.query("traceEvents").collect();
    return all.filter((e) => e.kind === kind);
  });
}

describe("bridge_ingest httpAction: addMediaPart dispatch", () => {
  test("authed addMediaPart -> 200, creates a media part + the paired files row", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    const storageId = await storedBlob(t, "outbound-md-bytes");

    const res = await post(t, {
      op: "addMediaPart",
      messageId,
      storageId,
      filename: "report---abc.md",
      mimeType: "text/markdown",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const parts = await partsOf(t, messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0].part).toMatchObject({
      kind: "media",
      filename: "report---abc.md",
      mimeType: "text/markdown",
      storageId,
    });

    // INVARIANT: a media part is mirrored to a `files` row (Settings -> Fichiers).
    const files = await t.run((ctx) => ctx.db.query("files").collect());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ direction: "outbound", messageId });
  });

  test("empty mimeType defaults to application/octet-stream on the part", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    const storageId = await storedBlob(t, "x");

    const res = await post(t, {
      op: "addMediaPart",
      messageId,
      storageId,
      filename: "blob.bin",
      mimeType: "",
    });
    expect(res.status).toBe(200);

    const parts = await partsOf(t, messageId);
    expect(parts[0].part).toMatchObject({
      kind: "media",
      mimeType: "application/octet-stream",
    });
  });

  test("SOC2: the openclaw.ingest trace carries structural meta only, NEVER the filename", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    const storageId = await storedBlob(t, "secret-bytes");
    const filename = "patient-record-2026.md"; // PHI-shaped: must NOT leak into a trace

    await post(t, {
      op: "addMediaPart",
      messageId,
      storageId,
      filename,
      mimeType: "text/markdown",
    });

    const traces = await tracesByKind(t, "openclaw.ingest");
    expect(traces).toHaveLength(1);
    const meta = JSON.parse(traces[0].meta ?? "{}");
    expect(meta).toMatchObject({ op: "addMediaPart", partKind: "media", mimeType: "text/markdown", ok: true });
    expect(meta).toHaveProperty("bytes"); // number | null — proves "did the bytes land"
    // The whole trace row, serialized, must not contain the filename anywhere.
    expect(JSON.stringify(traces[0])).not.toContain(filename);
    expect(traces[0].meta).not.toContain("filename");
    expect(traces[0].principalType).toBe("system");
    expect(traces[0].direction).toBe("inbound");
  });
});

describe("bridge_ingest httpAction: Bearer gate (every reject reason)", () => {
  test("missing Authorization -> 401, writes NO part, denied trace reason bad_secret", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    const storageId = await storedBlob(t, "x");

    const res = await post(
      t,
      { op: "addMediaPart", messageId, storageId, filename: "f.md", mimeType: "text/markdown" },
      null,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(await partsOf(t, messageId)).toHaveLength(0);

    const denied = await tracesByKind(t, "openclaw.ingest.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].status).toBe(401);
    expect(JSON.parse(denied[0].meta ?? "{}").reason).toBe("bad_secret");
  });

  test("wrong secret -> 401, writes NO part", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    const storageId = await storedBlob(t, "x");

    const res = await post(
      t,
      { op: "addMediaPart", messageId, storageId, filename: "f.md", mimeType: "text/markdown" },
      "Bearer not-the-secret",
    );
    expect(res.status).toBe(401);
    expect(await partsOf(t, messageId)).toHaveLength(0);
  });

  test("secret UNSET on the deployment -> 401 reason secret_unset (fails closed)", async () => {
    delete process.env.BRIDGE_INGEST_SECRET;
    const t = convexTest(schema, modules);
    const res = await post(t, { op: "getUploadUrl" }, "Bearer anything");
    expect(res.status).toBe(401);
    const denied = await tracesByKind(t, "openclaw.ingest.denied");
    expect(JSON.parse(denied[0].meta ?? "{}").reason).toBe("secret_unset");
  });
});

describe("bridge_ingest httpAction: mediaTrace diagnostic + malformed input", () => {
  test("mediaTrace -> 200, records an openclaw.media trace and creates NO message part", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    const res = await post(t, {
      op: "mediaTrace",
      messageId,
      phase: "dropped",
      reason: "too_large",
      bytesBucket: "1m-8m",
      mimeBase: "application",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // SOC2 diagnostic: a trace, but NO part and NO file row.
    expect(await partsOf(t, messageId)).toHaveLength(0);
    const media = await tracesByKind(t, "openclaw.media");
    expect(media).toHaveLength(1);
    expect(JSON.parse(media[0].meta ?? "{}")).toMatchObject({
      op: "mediaTrace",
      phase: "dropped",
      reason: "too_large",
      bytesBucket: "1m-8m",
      mimeBase: "application",
    });
  });

  test("invalid JSON body -> 400", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("unknown op -> 400", async () => {
    const t = convexTest(schema, modules);
    const res = await post(t, { op: "noSuchOp" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "unknown op" });
  });
});
