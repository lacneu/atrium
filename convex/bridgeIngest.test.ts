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

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test , vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const URL = "/bridge/ingest";

// The per-bridge secret of the fixture instance ("prod"), minted by
// seedAssistantMessage for EACH test's own convexTest world. Ingest is
// per-bridge ONLY — there is no shared-secret fallback to configure. Module
// variable is safe: tests in a file run sequentially.
let SECRET = "";

// Type WITH the schema (not the bare `ReturnType<typeof convexTest>`, which erases
// it to a generic DataModel where `ctx.db.query("messageParts").withIndex(...)`
// only sees system indexes). `convex deploy` runs tsc over convex/**, test files
// included — so this must typecheck, not just run under vitest's esbuild.
type T = TestConvex<typeof schema>;

/** A chat + a streaming assistant message to attach parts to — plus the "prod"
 *  instance and ITS per-bridge secret (stored into the module `SECRET`), since
 *  the ingest endpoint authenticates per-bridge only. */
async function seedAssistantMessage(t: T) {
  const seeded = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" as const });
    const instanceId = await ctx.db.insert("instances", {
      name: "prod",
      gatewayUrl: "ws://prod",
    });
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
    return { admin, instanceId, userId, chatId, messageId };
  });
  const minted = await t
    .withIdentity({ subject: `${seeded.admin}|session` })
    .action(api.bridgeAuth.mintBridgeSecret, { instanceId: seeded.instanceId });
  SECRET = minted.plaintext;
  return seeded;
}

/** Mint ONLY the per-bridge auth (admin + "prod" instance + secret into the
 *  module SECRET) — for tests that build their own chat fixtures. */
async function seedAuthOnly(t: T) {
  const seeded = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" as const });
    const instanceId = await ctx.db.insert("instances", {
      name: "prod",
      gatewayUrl: "ws://prod",
    });
    return { admin, instanceId };
  });
  const minted = await t
    .withIdentity({ subject: `${seeded.admin}|session` })
    .action(api.bridgeAuth.mintBridgeSecret, { instanceId: seeded.instanceId });
  SECRET = minted.plaintext;
}

async function storedBlob(t: T, bytes: string) {
  return await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
}

function post(t: T, body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== null) headers["Authorization"] = auth;
  return t.fetch(URL, { method: "POST", headers, body: JSON.stringify(body) });
}

async function partsOf(t: T, messageId: Id<"messages">) {
  return await t.run((ctx) =>
    ctx.db
      .query("messageParts")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
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

  test("write-amplification: per-delta appendDelta/setSnapshot apply the stream op but write NO trace", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    await post(t, { op: "appendDelta", messageId, text: "Hel" });
    await post(t, { op: "appendDelta", messageId, text: "lo" });
    await post(t, { op: "setSnapshot", messageId, text: "Hello world" });

    // The stream ops APPLIED — the live text lives in the streamingText row now
    // (NOT message.liveText / the messages doc, so loadChatView isn't churned)...
    const live = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("streamingText")
            .withIndex("by_message", (q) => q.eq("messageId", messageId))
            .first()
        )?.text,
    );
    expect(live).toBe("Hello world");

    // ...but NONE of these high-frequency deltas wrote an openclaw.ingest trace
    // (the write-amplification fix — only startAssistant/finalize/parts are traced).
    // Robust to whether the seed emitted any trace: assert no per-delta op appears.
    const traces = await tracesByKind(t, "openclaw.ingest");
    const ops = traces.map((tr) => JSON.parse(tr.meta ?? "{}").op);
    expect(ops).not.toContain("appendDelta");
    expect(ops).not.toContain("setSnapshot");
  });

  test("streaming lifecycle: startAssistant creates the live-text row; deltas update it WITHOUT churning the message doc; finalize sets message.text + deletes the row", async () => {
    const t = convexTest(schema, modules);
    await seedAuthOnly(t);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      return await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
      });
    });
    const startRes = await post(t, { op: "startAssistant", chatId, runId: "r1" });
    const { messageId } = (await startRes.json()) as {
      messageId: Id<"messages">;
    };
    const rowOf = () =>
      t.run((ctx) =>
        ctx.db
          .query("streamingText")
          .withIndex("by_message", (q) => q.eq("messageId", messageId))
          .first(),
      );
    const msg = () => t.run((ctx) => ctx.db.get(messageId));

    // startAssistant created the row (empty); the messages doc text stays "" — the
    // live text never lands on the doc loadChatView reads (the whole point).
    expect((await rowOf())?.text).toBe("");
    expect((await msg())?.text).toBe("");

    await post(t, { op: "appendDelta", messageId, text: "Hel" });
    await post(t, { op: "setSnapshot", messageId, text: "Hello there" });
    expect((await rowOf())?.text).toBe("Hello there");
    expect((await msg())?.text).toBe(""); // messages doc UNCHANGED during streaming

    await post(t, {
      op: "finalize",
      messageId,
      status: "complete",
      text: "Hello there!",
    });
    const final = await msg();
    expect(final?.status).toBe("complete");
    expect(final?.text).toBe("Hello there!");
    expect(await rowOf()).toBeNull(); // INVARIANT: row deleted with the flip
  });

  // THE perf invariant (subscription split): loadChatView (read by the heavy,
  // window-wide `listByChat`) reads `messages` + `messageParts`, NEVER
  // `streamingText`. So a turn's text deltas — the dominant high-frequency churn —
  // must leave loadChatView's ENTIRE read-set byte-identical, which is what makes
  // `listByChat` provably NOT re-run per token. Asserting the whole message doc
  // (not just .text) + messageParts are deep-equal across K deltas locks that:
  // if NOTHING loadChatView reads changes, the reactive query cannot fire.
  test("text deltas leave loadChatView's read-set (messages doc + messageParts) byte-identical — listByChat is delta-stable", async () => {
    const t = convexTest(schema, modules);
    await seedAuthOnly(t);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      return await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
      });
    });
    const { messageId } = (await (
      await post(t, { op: "startAssistant", chatId, runId: "r1" })
    ).json()) as { messageId: Id<"messages"> };

    const readSet = () =>
      t.run(async (ctx) => ({
        msg: await ctx.db.get(messageId),
        parts: await ctx.db
          .query("messageParts")
          .withIndex("by_message", (q) => q.eq("messageId", messageId))
          .collect(),
      }));

    // Snapshot loadChatView's read-set right after the message exists, then drive
    // many text deltas (mix of appendDelta + setSnapshot, the two text ops).
    const before = await readSet();
    for (let i = 0; i < 5; i++) {
      await post(t, { op: "appendDelta", messageId, text: `tok${i} ` });
    }
    await post(t, { op: "setSnapshot", messageId, text: "tok0 tok1 tok2 tok3 tok4 final" });
    const after = await readSet();

    // The ENTIRE message doc is unchanged (updatedAt included — no doc patch at all)
    // and no parts were inserted: loadChatView's read-set never moved.
    expect(after.msg).toEqual(before.msg);
    expect(after.parts).toEqual(before.parts);

    // The text DID accumulate — it just lives on the streamingText row (read only by
    // the cheap getStreamingText), proving the data was relocated, not lost.
    const liveRow = await t.run((ctx) =>
      ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .first(),
    );
    expect(liveRow?.text).toBe("tok0 tok1 tok2 tok3 tok4 final");
  });

  test("finalize with EMPTY final text recovers the streamingText row's accumulated text", async () => {
    const t = convexTest(schema, modules);
    await seedAuthOnly(t);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      return await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
      });
    });
    const { messageId } = (await (
      await post(t, { op: "startAssistant", chatId })
    ).json()) as { messageId: Id<"messages"> };
    await post(t, { op: "appendDelta", messageId, text: "streamed " });
    await post(t, { op: "appendDelta", messageId, text: "answer" });
    // Empty final text (e.g. an error/aborted turn that produced no final event):
    // finalize must fall back to the accumulated live text, not wipe it.
    await post(t, { op: "finalize", messageId, status: "complete", text: "" });
    const m = await t.run((ctx) => ctx.db.get(messageId));
    expect(m?.text).toBe("streamed answer"); // recovered from the row, not lost
  });

  // Deploy-cutover finalize: a turn streaming across the upgrade carries its partial on
  // the legacy `liveText` with NO row. finalize must fall back to that liveText (the
  // `stRow?.text ?? message.liveText ?? message.text` chain) and clear liveText — the
  // empty-text test above only covers the row branch, not this legacy one.
  test("finalize with EMPTY text falls back to legacy liveText when there is no row", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t); // streaming, NO row
    await t.run((ctx) =>
      ctx.db.patch(messageId, { liveText: "streamed before deploy" }),
    );

    await post(t, { op: "finalize", messageId, status: "complete", text: "" });

    const m = await t.run((ctx) => ctx.db.get(messageId));
    expect(m?.status).toBe("complete");
    expect(m?.text).toBe("streamed before deploy"); // recovered from liveText
    expect(m?.liveText).toBeUndefined(); // legacy field cleared on finalize
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
    expect(JSON.parse(denied[0].meta ?? "{}").reason).toBe("no_token");
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

  test("a secret resolving to NO instance -> 401 reason unknown_secret (fails closed)", async () => {
    // Per-bridge only: there is no deployment-env shared secret at all — an
    // unknown Bearer fails closed regardless of any env state.
    const t = convexTest(schema, modules);
    const res = await post(t, { op: "getUploadUrl" }, "Bearer anything");
    expect(res.status).toBe(401);
    const denied = await tracesByKind(t, "openclaw.ingest.denied");
    expect(JSON.parse(denied[0].meta ?? "{}").reason).toBe("unknown_secret");
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
    await seedAuthOnly(t);
    const res = await t.fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("unknown op -> 400", async () => {
    const t = convexTest(schema, modules);
    await seedAuthOnly(t);
    const res = await post(t, { op: "noSuchOp" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "unknown op" });
  });
});

describe("streamingText split — migration & heartbeat edge cases", () => {
  // P2a: a message mid-stream across the deploy carries legacy `liveText` but no
  // streamingText row; the first post-deploy appendDelta must KEEP that prefix.
  test("appendDelta on a legacy-liveText message (no row) preserves the prefix", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    await t.run((ctx) => ctx.db.patch(messageId, { liveText: "before deploy " }));

    await post(t, { op: "appendDelta", messageId, text: "after" });

    const row = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("streamingText")
          .withIndex("by_message", (q) => q.eq("messageId", messageId))
          .first()
      )?.text,
    );
    expect(row).toBe("before deploy after"); // prefix preserved, not orphaned
  });

  // P2b: a turn streaming ONLY parts (no text deltas) must keep its heartbeat fresh
  // via addPart, else the watchdog (which keys off streamingText.updatedAt) reaps it.
  test("addPart refreshes the streaming heartbeat (a parts-only turn isn't seen as stuck)", async () => {
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedAssistantMessage(t);
    // A row whose heartbeat is STALE (as if the last text delta was long ago).
    await t.run((ctx) =>
      ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "partial",
        updatedAt: 1,
      }),
    );

    await post(t, {
      op: "addPart",
      messageId,
      part: { kind: "tool", name: "exec", phase: "completed" },
    });

    const after = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("streamingText")
          .withIndex("by_message", (q) => q.eq("messageId", messageId))
          .first()
      )?.updatedAt,
    );
    expect(after).toBeGreaterThan(1); // heartbeat bumped by the (text-less) part
  });

  // A late delta racing finalize: finalize already deleted the row + set a terminal
  // status, then a retried appendDelta/setSnapshot arrives. It must NOT recreate a
  // row — no finalize will run again to delete it, so it would leak a phantom live row
  // that getStreamingText returns forever. The op is dropped (turn already ended).
  test("a late appendDelta after finalize does NOT recreate a phantom streamingText row", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    // Simulate the finished turn: terminal status, no streamingText row.
    await t.run((ctx) =>
      ctx.db.patch(messageId, { status: "complete", text: "final answer" }),
    );

    // A retried frame arrives after the turn ended — accepted (200) but a no-op.
    const res = await post(t, { op: "appendDelta", messageId, text: "late tokens" });
    expect(res.status).toBe(200);
    await post(t, { op: "setSnapshot", messageId, text: "late snapshot" });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .first();
      expect(row).toBeNull(); // no phantom row created for a finished turn
      // The finalized message is untouched (the late frames never reach the doc).
      const msg = await ctx.db.get(messageId);
      expect(msg?.status).toBe("complete");
      expect(msg?.text).toBe("final answer");
    });
  });
});

describe("bridge_ingest httpAction: calibrate (delivery recorder clock)", () => {
  test("authed calibrate -> 200 with a numeric serverNow", async () => {
    const t = convexTest(schema, modules);
    await seedAuthOnly(t);
    const res = await post(t, { op: "calibrate" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serverNow?: unknown };
    expect(typeof body.serverNow).toBe("number");
  });

  test("calibrate without the bridge secret -> 401", async () => {
    const t = convexTest(schema, modules);
    const res = await post(t, { op: "calibrate" }, null);
    expect(res.status).toBe(401);
  });
});

describe("bridge_ingest httpAction: upsertSubAgent dispatch", () => {
  const CHILD = "agent:alice:subagent:50a9857b-5b2f-40ce-867d-2e20d2e2b737";

  async function subAgentsOf(t: T, chatId: Id<"chats">) {
    return await t.run((ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect(),
    );
  }

  test("authed upsertSubAgent -> 200, upserts ONE row by childSessionKey", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedAssistantMessage(t);

    const r1 = await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: CHILD,
      taskName: "do the thing",
      status: "running",
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });

    const r2 = await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: CHILD,
      status: "done",
      resultText: "SUBAGENT_PONG_42",
    });
    expect(r2.status).toBe(200);

    const rows = await subAgentsOf(t, chatId);
    expect(rows).toHaveLength(1); // upsert, not append
    expect(rows[0]).toMatchObject({
      childSessionKey: CHILD,
      status: "done",
      resultText: "SUBAGENT_PONG_42",
      taskName: "do the thing",
    });
  });

  test("SOC2: the openclaw.ingest trace carries structural meta only — never the result/task content", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedAssistantMessage(t);
    await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: CHILD,
      taskName: "SECRET_TASK_PHRASE",
      status: "done",
      resultText: "SECRET_RESULT_PHRASE",
      phase: "startup",
    });
    const traces = await tracesByKind(t, "openclaw.ingest");
    const last = traces[traces.length - 1]!;
    const meta = JSON.parse(last.meta!);
    expect(meta).toMatchObject({
      op: "upsertSubAgent",
      status: "done",
      phase: "startup",
      hasResult: true,
      ok: true,
    });
    // NEVER the child's task text or result content.
    expect(last.meta).not.toContain("SECRET_TASK_PHRASE");
    expect(last.meta).not.toContain("SECRET_RESULT_PHRASE");
    // The child session key (a path-like id, not content) is also not logged.
    expect(last.meta).not.toContain(CHILD);
  });

  test("upsertSubAgent without the bridge secret -> 401, writes NO row", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedAssistantMessage(t);
    const res = await post(
      t,
      { op: "upsertSubAgent", chatId, childSessionKey: CHILD, status: "running" },
      null,
    );
    expect(res.status).toBe(401);
    expect(await subAgentsOf(t, chatId)).toHaveLength(0);
  });
});

describe("addPart tool upsert (interleaved-run anchors)", () => {
  // Lot B: a start and its completed share the provider toolCallId — ONE part
  // row, phase/input/output fused, and the START's textOffset (the narrative
  // anchor) preserved against the completed's later offset.
  test("start then completed with the same toolCallId collapse into ONE row, anchor preserved", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    const r1 = await post(t, {
      op: "addPart",
      messageId,
      part: {
        kind: "tool",
        name: "web_search",
        phase: "start",
        toolCallId: "t1",
        textOffset: 10,
        input: { q: "x" },
      },
    });
    expect(r1.status).toBe(200);
    const r2 = await post(t, {
      op: "addPart",
      messageId,
      part: {
        kind: "tool",
        name: "web_search",
        phase: "completed",
        toolCallId: "t1",
        textOffset: 50,
        input: { q: "x" },
        output: { hits: 3 },
      },
    });
    expect(r2.status).toBe(200);
    const rows = await t.run((ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    const part = rows[0]!.part;
    expect(part).toMatchObject({
      kind: "tool",
      name: "web_search",
      phase: "completed",
      toolCallId: "t1",
      textOffset: 10, // the START's anchor wins — the card never moves
      output: { hits: 3 },
    });
  });

  test("parts WITHOUT a toolCallId keep the append-only path (two rows)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    for (const phase of ["start", "completed"]) {
      await post(t, {
        op: "addPart",
        messageId,
        part: { kind: "tool", name: "message", phase },
      });
    }
    const rows = await t.run((ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
  });

  test("distinct toolCallIds never fuse (two concurrent tools, two cards)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    for (const id of ["t1", "t2"]) {
      await post(t, {
        op: "addPart",
        messageId,
        part: {
          kind: "tool",
          name: "exec",
          phase: "start",
          toolCallId: id,
          textOffset: 0,
        },
      });
    }
    const rows = await t.run((ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("finalize discardStreamText (NO_REPLY sentinel purge, atomic)", () => {
  test("a live row holding the sentinel is NOT resurrected by the fallback", async () => {
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedAssistantMessage(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "NO_REPLY",
        boundInstance: "prod",
        updatedAt: Date.now(),
      });
    });
    const res = await post(t, {
      op: "finalize",
      messageId,
      status: "error",
      text: "",
      error: "The agent ended the turn without producing any response.",
      errorKind: "empty_response_silent",
      discardStreamText: true,
    });
    expect(res.status).toBe(200);
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.text).toBe(""); // the sentinel never becomes the bubble text
    expect(msg?.errorCode).toBe("empty_response_silent");
  });
});

describe("sweepStreams (bridge boot-time orphan sweep)", () => {
  test("a STALE stream of the calling instance is closed; fresh and foreign ones survive", async () => {
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedAssistantMessage(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      // Stale row of THIS instance (bound stamp) — must be swept.
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "partial answer",
        boundInstance: "prod",
        updatedAt: now - 400_000,
      });
    });
    const res = await post(t, { op: "sweepStreams" });
    expect(res.status).toBe(200);
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(messageId),
      rows: await ctx.db.query("streamingText").collect(),
    }));
    expect(after.msg?.status).toBe("error");
    expect(after.msg?.error).toBe("connection_lost");
    expect(after.msg?.text).toBe("partial answer"); // preserved
    expect(after.rows).toHaveLength(0);
  });

  test("sweeping a DOCUMENTARY chat's stream releases its pendingFetch lock (codex P1)", async () => {
    // The sweep deletes the stream row — the watchdog can never see it later,
    // so the specialized-chat job locks must be released HERE, like the
    // watchdog path does.
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedAssistantMessage(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, {
        kind: "documentary" as const,
        pendingFetch: { sourceMessageId: messageId, createdAt: now - 500_000 },
      });
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "",
        boundInstance: "prod",
        updatedAt: now - 400_000,
      });
    });
    const res = await post(t, { op: "sweepStreams" });
    expect(res.status).toBe(200);
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.pendingFetch).toBeUndefined(); // lock released, not stranded
  });

  test("sweeping a blocker DRAINS the queued follow-up behind it", async () => {
    const t = convexTest(schema, modules);
    const { messageId, chatId, userId } = await seedAssistantMessage(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "partial",
        boundInstance: "prod",
        updatedAt: now - 400_000,
      });
      // A queued follow-up parked behind the (orphaned) in-flight turn.
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "q1",
        text: "queued follow-up",
        attachmentIds: [],
        status: "queued" as const,
      });
    });
    await post(t, { op: "sweepStreams" });
    const outbox = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", chatId).eq("status", "queued"),
        )
        .collect(),
    );
    expect(outbox).toHaveLength(0); // promoted by the drain, not stuck
  });

  test("a FRESH skip schedules ONE deferred re-run (orphan closed after the grace)", async () => {
    // Fake timers from the START: convex-test arms its scheduler with real
    // setTimeout otherwise, and a later vi.useFakeTimers cannot see it.
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedAssistantMessage(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "fresh orphan",
        boundInstance: "prod",
        updatedAt: Date.now() - 5_000, // within the grace at sweep time
      });
    });
    await post(t, { op: "sweepStreams" });
    // Still streaming right after the boot sweep (grace)…
    let msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("streaming");
    // …then the grace elapses (age the row instead of faking timers) and the
    // deferred re-run closes it.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .first();
      if (row) await ctx.db.patch(row._id, { updatedAt: Date.now() - 400_000 });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.error).toBe("connection_lost");
  });

  test("a FRESH row (rolling-restart overlap) is left alone", async () => {
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedAssistantMessage(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "live",
        boundInstance: "prod",
        updatedAt: Date.now(), // fresh
      });
    });
    await post(t, { op: "sweepStreams" });
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(messageId),
      rows: await ctx.db.query("streamingText").collect(),
    }));
    expect(after.msg?.status).toBe("streaming");
    expect(after.rows).toHaveLength(1);
  });

  test("ANOTHER instance's stale stream is untouched (per-bridge scope)", async () => {
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedAssistantMessage(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "other's turn",
        boundInstance: "someone-else",
        updatedAt: Date.now() - 400_000,
      });
    });
    await post(t, { op: "sweepStreams" });
    const after = await t.run((ctx) => ctx.db.get(messageId));
    expect(after?.status).toBe("streaming"); // not ours to sweep
  });
});
