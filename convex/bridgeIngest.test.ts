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
import { api, internal } from "./_generated/api";
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

async function liveTextOf(t: T, messageId: Id<"messages">) {
  return await t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("streamingText")
          .withIndex("by_message", (q) => q.eq("messageId", messageId))
          .first()
      )?.text,
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

  // --- G-14: nothing the user has read may shrink ---------------------------
  // A snapshot is the gateway's full view of ONE growing answer. A shorter one
  // is a stale/out-of-order frame, and before this guard it silently truncated a
  // reply already on screen. Convex is the durable lock: it refuses the shrink,
  // records the two LENGTHS (never the text), and TELLS the bridge so its local
  // liveText mirror does not diverge.
  test("snapshot regression: a SHORTER snapshot never overwrites the displayed reply, is traced by length, and is reported unapplied", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    await post(t, { op: "setSnapshot", messageId, text: "the full answer, all of it" });
    const res = await post(t, { op: "setSnapshot", messageId, text: "the full" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applied: false });

    const live = await liveTextOf(t, messageId);
    expect(live).toBe("the full answer, all of it");

    const regressions = (await tracesByKind(t, "assistant.stream"))
      .map((tr) => JSON.parse(tr.meta ?? "{}"))
      .filter((m) => m.phase === "snapshot_regression");
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ oldLen: 26, newLen: 8 });
    // SOC2: the trace carries lengths, never a character of the reply.
    expect(JSON.stringify(regressions[0])).not.toContain("the full");
  });

  test("snapshot regression: a DECLARED shrink (replace:true — compaction reset, sentinel purge, upstream replace) still applies", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    await post(t, { op: "setSnapshot", messageId, text: "invalidated prefix" });
    const res = await post(t, { op: "setSnapshot", messageId, text: "", replace: true });

    expect(await res.json()).toMatchObject({ ok: true, applied: true });
    expect(await liveTextOf(t, messageId)).toBe("");
    const regressions = (await tracesByKind(t, "assistant.stream"))
      .map((tr) => JSON.parse(tr.meta ?? "{}"))
      .filter((m) => m.phase === "snapshot_regression");
    expect(regressions).toHaveLength(0);
  });

  test("snapshot growth is untouched: a LONGER snapshot replaces the text as before", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    await post(t, { op: "setSnapshot", messageId, text: "the full" });
    const res = await post(t, { op: "setSnapshot", messageId, text: "the full answer" });

    expect(await res.json()).toMatchObject({ ok: true, applied: true });
    expect(await liveTextOf(t, messageId)).toBe("the full answer");
  });

  test("codex P1: a finalize whose text is SHORTER than what already streamed keeps the streamed reply", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    await post(t, { op: "setSnapshot", messageId, text: "the full answer, all of it" });
    // The terminal write is where the reply the user KEEPS is decided: the guard
    // on setSnapshot would otherwise be defeated one write later.
    await post(t, { op: "finalize", messageId, status: "complete", text: "the full" });

    const kept = await t.run(async (ctx) => (await ctx.db.get(messageId))?.text);
    expect(kept).toBe("the full answer, all of it");
    const regressions = (await tracesByKind(t, "assistant.stream"))
      .map((tr) => JSON.parse(tr.meta ?? "{}"))
      .filter((m) => m.phase === "snapshot_regression");
    expect(regressions).toHaveLength(1);
  });

  test("codex P1: a final that DIFFERS (an authoritative re-render) still wins, even when shorter", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    await post(t, { op: "setSnapshot", messageId, text: "réponse partielle déjà str" });
    // Not a prefix of what streamed: this is the gateway's own rendering of the
    // answer, not the same text cut short. It must not be second-guessed.
    await post(t, {
      op: "finalize",
      messageId,
      status: "complete",
      text: "réponse complète livrée",
    });

    const kept = await t.run(async (ctx) => (await ctx.db.get(messageId))?.text);
    expect(kept).toBe("réponse complète livrée");
  });

  test("codex P1: clearSessionState re-authorizes atomically (a rebound chat is protected)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedAssistantMessage(t);
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
        observedAt: 1_000,
      });
      // The chat is rebound to ANOTHER instance between the HTTP check and the
      // mutation.
      await ctx.db.patch(chatId, { instanceName: "other-instance" });
    });

    // Driven at the MUTATION, which is where the atomic re-check lives: the
    // HTTP check happened BEFORE the rebind, so only this barrier can stop it.
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.stream.clearSessionStateAfterReset, {
          chatId,
          resetStartedAt: 2_000,
          boundInstanceName: "prod",
        }),
      ),
    ).rejects.toThrow();

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull).toBe(true);
  });

  test("codex P1: the ingest boundary BUCKETS timeoutPhase (a divergent bridge cannot inject text)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedAssistantMessage(t);

    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 1,
      contextTokens: 2,
      timeoutPhase: "waiting on user request: transférer 4000 EUR à Jean",
    });

    const traces = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    // `traces[traces.length - 1]`, not `.at(-1)`: the tsc `convex deploy` runs
    // over convex/** targets an older lib than vitest's esbuild, so `.at` does
    // not exist there — a test that only runs under vitest would have BROKEN
    // THE DEPLOY (the file's own header warns about exactly this).
    expect(traces[traces.length - 1]?.timeoutPhase).toBe("other");
    // The metadata-only contract holds even against a bridge we did not write.
    expect(JSON.stringify(traces)).not.toContain("transférer");
  });

  test("the compaction CAUSE reaches the trace (it was computed and dropped)", async () => {
    // G-09 exists to answer "why did the gateway compact". The bridge derived the
    // cause and POSTed it; the ingest projected every OTHER field and silently
    // omitted this one, so no trace ever carried it — the measurement existed and
    // was invisible, which is the failure mode this whole program keeps hitting.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedAssistantMessage(t);

    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 1,
      contextTokens: 2,
      compaction: "midturn",
      compactionReason: "overflow",
    });
    const traces = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    expect(traces[traces.length - 1]?.compactionReason).toBe("overflow");
  });

  // WHICH FIGURE DECIDED. A percentage without its provenance cannot be told
  // apart from a gateway-measured one, and the two mean different things: the
  // counter branch is blind to tool schemas and injected context, which is
  // exactly what fills a window. Prod showed a turn dying of `context_length` at
  // a displayed 51 % with nothing to say where that 51 % came from.
  test("the send path's fill reading arrives WITH its source", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedAssistantMessage(t);
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      // Deliberately INCONSISTENT with the raw ratio (1/2 = 50 %): the stored
      // figure must be the one the send path derived, not one re-derived here.
      totalTokens: 1,
      contextTokens: 2,
      fillPct: 97,
      fillSource: "gateway_estimate",
      compaction: null,
    });
    const traces = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    const last = traces[traces.length - 1];
    expect(last?.fillPct, "the trace re-derives its own blinder reading").toBe(
      97,
    );
    expect(
      last?.fillSource,
      "the figure is stored stripped of what produced it",
    ).toBe("gateway_estimate");
  });

  // A WINDOW WITHOUT ITS OWNER CANNOT BE INTERPRETED.
  test("the model the window belongs to reaches the trace", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedAssistantMessage(t);
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 230_766,
      contextTokens: 372_000,
      fillPct: 75,
      fillSource: "counter",
      model: "gpt-5.6-sol",
      compaction: null,
    });
    const traces = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    const last = traces[traces.length - 1];
    expect(
      last?.model,
      "a window of 372000 is indistinguishable from one of 272000 without it",
    ).toBe("gpt-5.6-sol");
  });

  test("an older bridge's unattributed fill claims no source", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedAssistantMessage(t);
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 1,
      contextTokens: 2,
      compaction: null,
    });
    const traces = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    const last = traces[traces.length - 1];
    expect(last?.fillPct).toBe(50);
    expect(
      last?.fillSource,
      "an unattributed figure borrows a label it did not earn",
    ).toBeUndefined();
  });

  // A MEASUREMENT AND ITS PROVENANCE ARE ONE FACT. Validated apart, a divergent
  // or half-upgraded bridge could produce a figure whose label was rejected —
  // which then reads as unattributed, i.e. exactly the ambiguity this lot exists
  // to remove — or a source with nothing to attribute.
  test("a half-formed pair collapses to UNKNOWN, never half-stored", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedAssistantMessage(t);
    // A figure whose label is not one we know.
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 1,
      contextTokens: 2,
      fillPct: 42,
      fillSource: "wishful_thinking",
      compaction: null,
    });
    // And the mirror: a label with no figure behind it.
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 1,
      contextTokens: 2,
      fillPct: null,
      fillSource: "gateway_estimate",
      compaction: null,
    });
    const traces = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    // And the third shape a half-upgraded bridge can send: a source with the
    // measurement field entirely ABSENT rather than null.
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 1,
      contextTokens: 2,
      fillSource: "gateway_estimate",
      compaction: null,
    });
    const traces3 = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    const orphanNoField = traces3[traces3.length - 1];
    expect(
      orphanNoField?.fillPct,
      "an orphan source falls through to the legacy ratio and hides behind it",
    ).toBeNull();
    expect(orphanNoField?.fillSource).toBeUndefined();

    const [rejectedLabel, orphanSource] = traces.slice(-2);
    expect(
      rejectedLabel?.fillPct,
      "a figure whose label was refused is kept anyway, and reads unattributed",
    ).toBeNull();
    expect(rejectedLabel?.fillSource).toBeUndefined();
    expect(
      orphanSource?.fillSource,
      "a provenance is stored with no measurement to attribute",
    ).toBeUndefined();
    expect(orphanSource?.fillPct).toBeNull();
  });

  test("a measured UNKNOWN is not answered with a ratio of our own", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedAssistantMessage(t);
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 1,
      contextTokens: 2,
      // The send path looked and could not tell (a counter stated stale, no
      // usable budget). That is an answer, not an absence.
      fillPct: null,
      fillSource: null,
      compaction: null,
    });
    const traces = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    const last = traces[traces.length - 1];
    expect(
      last?.fillPct,
      "a reading the send path declined to state is re-derived here anyway",
    ).toBeNull();
    expect(last?.fillSource).toBeUndefined();
  });

  test("a REFUSED compaction is named as a refusal, not as a failure", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedAssistantMessage(t);

    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 1,
      contextTokens: 2,
      compactionReason: "already_active",
      compactionRefused: true,
    });
    const traces = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    expect(traces[traces.length - 1]?.compactionRefused).toBe(true);
    expect(traces[traces.length - 1]?.compactionReason).toBe("already_active");
  });

  test("the boundary BUCKETS the compaction reason too (no gateway sentence)", async () => {
    // Same discipline as timeoutPhase: the bridge already buckets this, and the
    // boundary does it again because a divergent bridge is not a trusted source.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedAssistantMessage(t);

    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 1,
      contextTokens: 2,
      compactionReason: "compacting after: virement de 4000 EUR à Jean",
    });
    const traces = (await tracesByKind(t, "chat.gateway_pressure")).map((tr) =>
      JSON.parse(tr.meta ?? "{}"),
    );
    // DROPPED, not coerced: an unrecognized value must not read as a measurement.
    expect(traces[traces.length - 1]?.compactionReason).toBeUndefined();
    expect(JSON.stringify(traces)).not.toContain("virement");
  });

  test("codex P2: an ordinary meta refresh does NOT erase the session-overfull verdict", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedAssistantMessage(t);

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionOverfull, {
        chatId,
        overfull: true,
      });
    });
    // Every send refreshes the meta from `sessions.describe`. Rebuilt from
    // scratch, it used to drop the verdict right before the turn it exists to
    // pre-announce.
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { model: "gpt-5", totalTokens: 1234, contextTokens: 272_000 },
      });
    });

    const meta = await t.run(async (ctx) => (await ctx.db.get(chatId))?.sessionMeta);
    expect(meta?.sessionOverfull).toBe(true);
    expect(meta?.model).toBe("gpt-5"); // …and the refresh still applied
  });

  test("codex P1: a final REPEATING a snapshot the row already refused never wins, prefix or not", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    await post(t, { op: "setSnapshot", messageId, text: "the revised full answer" });
    // A stale frame that is NOT a prefix of the displayed text: refused live…
    const refused = await post(t, { op: "setSnapshot", messageId, text: "the draft" });
    expect(await refused.json()).toMatchObject({ applied: false });
    // …and it comes back as the turn's final. The length test alone would let it
    // through (it is not a prefix); the remembered refusal does not.
    await post(t, { op: "finalize", messageId, status: "complete", text: "the draft" });

    const kept = await t.run(async (ctx) => (await ctx.db.get(messageId))?.text);
    expect(kept).toBe("the revised full answer");
  });

  test("codex P2: an authorized `replace` does not let the refused final walk back in", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    await post(t, { op: "setSnapshot", messageId, text: "abcdef" });
    await post(t, { op: "setSnapshot", messageId, text: "abc" }); // refused
    // A DECLARED shrink then replaces the displayed text with something shorter…
    await post(t, { op: "setSnapshot", messageId, text: "XYZ", replace: true });
    // …so the stale final is no longer "shorter than displayed". The remembered
    // refusal has to stand on its own.
    await post(t, { op: "finalize", messageId, status: "complete", text: "abc" });

    const kept = await t.run(async (ctx) => (await ctx.db.get(messageId))?.text);
    expect(kept).toBe("XYZ");
  });

  test("codex P1: an ERROR finalize may still carry a shorter partial (no guard)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);

    await post(t, { op: "setSnapshot", messageId, text: "a long partial reply here" });
    await post(t, {
      op: "finalize",
      messageId,
      status: "error",
      text: "cut",
      error: "gateway error",
    });

    const kept = await t.run(async (ctx) => (await ctx.db.get(messageId))?.text);
    expect(kept).toBe("cut");
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

describe("a retried finalize does not inflate the ingest traces", () => {
  test("the SECOND finalize of the same message writes no trace", async () => {
    // The bridge now retries a finalize whose response was lost, so a duplicate call
    // is expected. The mutation is a no-op — the trace must be one too, or every
    // recovered network blip skews the finalize counters the detector reads.
    const t = convexTest(schema, modules);
    // The ingest route is per-bridge authenticated: mint the secret first (the
    // default `post` Authorization reads the module SECRET this sets).
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
    const { messageId } = (await startRes.json()) as { messageId: Id<"messages"> };
    const finalizeBody = {
      op: "finalize" as const,
      messageId,
      status: "complete" as const,
      text: "the answer",
      error: null,
    };
    await post(t, finalizeBody);
    const afterFirst = await t.run(async (ctx) =>
      (await ctx.db.query("traceEvents").collect()).filter((e) => {
        try {
          return (JSON.parse(e.meta ?? "{}") as { op?: string }).op === "finalize";
        } catch {
          return false;
        }
      }).length,
    );
    expect(afterFirst).toBe(1);
    // The retry lands on an already-terminal message.
    await post(t, finalizeBody);
    const afterRetry = await t.run(async (ctx) =>
      (await ctx.db.query("traceEvents").collect()).filter((e) => {
        try {
          return (JSON.parse(e.meta ?? "{}") as { op?: string }).op === "finalize";
        } catch {
          return false;
        }
      }).length,
    );
    expect(afterRetry).toBe(1);
  });
});

describe("finalize relays the session-drop flag (lot 31)", () => {
  // THE hop that was broken while every other test was green. Four hops carry this flag:
  // the turn → the sink → `writer.finalize` → the posted op → **this endpoint** → the
  // mutation. The bridge tests spy on the writer, the writer test reads the posted body,
  // and `providerSessionClear.test.ts` calls the mutation directly — so a variant that
  // did not declare the field, and a relay that did not forward it, sat exactly in the
  // gap between them. In production the session was never cleared.

  async function seedWithSession(t: T, stored: string) {
    await seedAssistantMessage(t);
    return await t.run(async (ctx) => {
      const msg = await ctx.db
        .query("messages")
        .filter((q) => q.eq(q.field("status"), "streaming"))
        .first();
      if (msg === null) throw new Error("no streaming message seeded");
      await ctx.db.patch(msg.chatId, { openclawChatId: stored });
      return { chatId: msg.chatId, messageId: msg._id };
    });
  }

  const chatState = async (t: T, chatId: Id<"chats">) =>
    await t.run(async (ctx) => {
      const c = await ctx.db.get(chatId);
      return {
        stored: c?.openclawChatId ?? "«cleared»",
        epoch: c?.providerResetCount ?? 0,
      };
    });

  test("a silence terminal clears the stored session end to end", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedWithSession(t, "20260706_212939_aee24e");
    const res = await post(t, {
      op: "finalize",
      messageId,
      status: "error",
      text: "",
      error: "Hermes stopped sending before the reply was complete.",
      errorKind: "response_timeout",
      clearProviderSession: "20260706_212939_aee24e",
    });
    expect(res.status).toBe(200);
    expect(await chatState(t, chatId)).toEqual({ stored: "«cleared»", epoch: 1 });
  });

  test("the relay carries the ID, not a flag — a chat on a NEWER session is untouched", async () => {
    // The companion of the test above, and the one that pins the SHAPE. If this hop ever
    // degraded the id to a bare `true` — a plausible "simplification" — the clear would
    // fire unconditionally and wipe a binding that works. That regression leaves the
    // first test green and reddens only this one.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedWithSession(t, "20260707_101010_bbbbbb");
    const res = await post(t, {
      op: "finalize",
      messageId,
      status: "error",
      text: "",
      error: "Hermes stopped sending before the reply was complete.",
      errorKind: "response_timeout",
      clearProviderSession: "20260706_212939_aee24e", // the OLD turn's session
    });
    expect(res.status).toBe(200);
    expect(await chatState(t, chatId)).toEqual({
      stored: "20260707_101010_bbbbbb",
      epoch: 0,
    });
  });

  test("an ordinary terminal posted the same way leaves it alone", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seedWithSession(t, "20260706_212939_aee24e");
    const res = await post(t, {
      op: "finalize",
      messageId,
      status: "complete",
      text: "voilà",
    });
    expect(res.status).toBe(200);
    expect(await chatState(t, chatId)).toEqual({
      stored: "20260706_212939_aee24e",
      epoch: 0,
    });
  });
});

// THE BOUNDARY IS WHERE THE FIELD WAS BEING LOST.
//
// The bridge sent `declaredTimeoutMs`; the ingest op did not declare it and did
// not relay it. Every task written through the REAL writer therefore landed with
// no bound at all, fell back to the refreshable 24 h net, and could never raise
// an overrun. The reaper tests inserted the field by hand and so proved nothing
// about production — the exact mistake this repo has a rule about.
describe("a task's declared deadline survives the ingest boundary", () => {
  test("the row lands with the bound AND an absolute deadline derived from it", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedAssistantMessage(t);
    await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: "task:8074f478-9142-420e-88fa-e473ea4c27e4",
      kind: "task",
      taskName: "image_generate",
      status: "running",
      declaredTimeoutMs: 300_000,
    });
    const row = await t.run(async (ctx) => {
      const rows = await ctx.db.query("subAgents").collect();
      return rows.find(
        (r) =>
          r.childSessionKey === "task:8074f478-9142-420e-88fa-e473ea4c27e4",
      );
    });
    expect(
      row?.declaredTimeoutMs,
      "the bound is dropped at the boundary, so nothing downstream can use it",
    ).toBe(300_000);
    // The absolute moment the reaper ranges on — derived server-side, never sent.
    expect(row?.taskDeadlineAt ?? 0).toBeGreaterThan(row!.createdAt + 300_000);
  });

  test("an absurd or hostile bound is refused, not stored", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedAssistantMessage(t);
    for (const [key, bad] of [
      ["task:neg", -1],
      ["task:zero", 0],
      ["task:huge", 40 * 60 * 60 * 1000],
    ] as const) {
      await post(t, {
        op: "upsertSubAgent",
        chatId,
        childSessionKey: key,
        kind: "task",
        status: "running",
        declaredTimeoutMs: bad,
      });
    }
    const rows = await t.run((ctx) => ctx.db.query("subAgents").collect());
    for (const key of ["task:neg", "task:zero", "task:huge"]) {
      const r = rows.find((x) => x.childSessionKey === key);
      expect(
        r?.taskDeadlineAt,
        `${key}: an implausible figure became a deadline`,
      ).toBeUndefined();
    }
  });

  test("a bound arriving AFTER the row exists is still adopted", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedAssistantMessage(t);
    // The reconciliation can create the row from a registry sighting before the
    // tool's own ack is relayed — and the ack's first attempt can fail and be
    // retried after that. Applied on the insert path alone, the bound would
    // never reach those rows: the original defect, on a realistic order.
    await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: "task:late",
      kind: "task",
      status: "running",
    });
    await post(t, {
      op: "upsertSubAgent",
      chatId,
      childSessionKey: "task:late",
      kind: "task",
      status: "running",
      declaredTimeoutMs: 300_000,
    });
    const row = await t.run(async (ctx) => {
      const rows = await ctx.db.query("subAgents").collect();
      return rows.find((r) => r.childSessionKey === "task:late");
    });
    expect(row?.taskDeadlineAt ?? 0).toBeGreaterThan(0);
    expect(row?.declaredTimeoutMs).toBe(300_000);
  });

  test("two bounds: the TIGHTER one wins", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedAssistantMessage(t);
    for (const ms of [600_000, 300_000, 900_000]) {
      await post(t, {
        op: "upsertSubAgent",
        chatId,
        childSessionKey: "task:tighten",
        kind: "task",
        status: "running",
        declaredTimeoutMs: ms,
      });
    }
    const row = await t.run(async (ctx) => {
      const rows = await ctx.db.query("subAgents").collect();
      return rows.find((r) => r.childSessionKey === "task:tighten");
    });
    expect(
      row?.declaredTimeoutMs,
      "a later, laxer bound talked the guard into being more patient",
    ).toBe(300_000);
  });
});

// The plan stamp orders what the reader sees (convex/lib/planOrder.ts). It arrives
// three ways — inside `part` on addPart, and as an ARGUMENT of clearPlan and
// advancePlan — and each way is network input. `addPart`'s screen is tested at the
// mutation (convex/clearPlan.test.ts); these two live only on this route, so they
// are tested on the route.
describe("bridge_ingest httpAction: the plan stamp is screened on every op", () => {
  test("advancePlan: a non-positive stamp is dropped, a usable one is kept", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    await t.run((ctx) =>
      ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "plan" as const,
          steps: [
            { step: "un", status: "completed" as const },
            { step: "deux", status: "in_progress" as const },
            { step: "trois", status: "pending" as const },
            { step: "quatre", status: "pending" as const },
          ],
        },
      }),
    );

    expect(
      (await post(t, { op: "advancePlan", messageId, count: 1, stamp: -1 }))
        .status,
    ).toBe(200);
    const dropped = (await partsOf(t, messageId)).find((p) => p.order === 1);
    expect(dropped?.part).not.toHaveProperty("stamp");

    expect(
      (await post(t, { op: "advancePlan", messageId, count: 1, stamp: 7 }))
        .status,
    ).toBe(200);
    const kept = (await partsOf(t, messageId)).find((p) => p.order === 2);
    expect(kept?.part).toMatchObject({ stamp: 7 });
  });

  test("advancePlan: a stamp posted in MILLISECONDS is dropped (the unit regression)", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedAssistantMessage(t);
    await t.run((ctx) =>
      ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "plan" as const,
          steps: [
            { step: "un", status: "completed" as const },
            { step: "deux", status: "in_progress" as const },
            { step: "trois", status: "pending" as const },
          ],
        },
      }),
    );
    expect(
      (
        await post(t, {
          op: "advancePlan",
          messageId,
          count: 1,
          stamp: Date.now(),
        })
      ).status,
    ).toBe(200);
    const written = (await partsOf(t, messageId)).find((p) => p.order === 1);
    expect(written?.part).not.toHaveProperty("stamp");
  });

  test("clearPlan: an unusable stamp is dropped, a usable one is kept", async () => {
    const CHILD = "agent:files:subagent:aaaaaaaa-0000-4000-8000-000000000001";
    const RUN = `announce:v1:${CHILD}:bbbbbbbb-0000-4000-8000-000000000002`;
    // Each op carries its OWN screen: covering the millisecond regression on
    // advancePlan alone would leave clearPlan free to reintroduce it (codex).
    const MILLISECONDS = Date.now();
    const SKEWED_SECONDS = Date.now() / 1000 + 3_600;
    for (const [stamp, expected] of [
      [0, undefined],
      [-1, undefined],
      [MILLISECONDS, undefined],
      [SKEWED_SECONDS, SKEWED_SECONDS],
      [9, 9],
    ] as const) {
      const t = convexTest(schema, modules);
      const { chatId, messageId } = await seedAssistantMessage(t);
      await t.run(async (ctx) => {
        await ctx.db.insert("messageParts", {
          messageId,
          order: 0,
          part: {
            kind: "plan" as const,
            steps: [{ step: "un", status: "completed" as const }],
          },
        });
        await ctx.db.insert("subAgents", {
          chatId,
          childSessionKey: CHILD,
          status: "done" as const,
          parentMessageId: messageId,
          anchorExact: true,
          createdAt: 900,
          updatedAt: 950,
        });
      });

      const res = await post(t, { op: "clearPlan", chatId, runId: RUN, stamp });
      expect(res.status).toBe(200);
      const tombstone = (await partsOf(t, messageId)).find((p) => p.order === 1);
      expect((tombstone?.part as { stamp?: number } | undefined)?.stamp).toBe(
        expected,
      );
    }
  });
});
