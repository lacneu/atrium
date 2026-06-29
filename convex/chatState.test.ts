/// <reference types="vite/client" />
//
// chatStateInternal — the diagnostic inspector behind GET /api/v1/chat-state.
// THE SOC2 contract test: seed a chat with a unique sentinel in EVERY content
// slot (message text, raw error, tool name-args/input/output, reasoning text,
// provenance source/items, file name, mime name= param) and assert NONE of them
// appear in the serialized response — the auditable no-content proof. Also pins
// the structural projection (tool name base, hasInput/Output, mimeType base,
// hasFilename/hasStorageUrl, presence-only reasoning/provenance), the normalized
// errorCode, the bucketed textLen, and the shared runStatusKind derivation.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { assessChat } from "./lib/diagnose";

const modules = import.meta.glob("./**/*.ts");

describe("chatStateInternal", () => {
  test("structural projection + NO content leak (sentinel proof)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const cid = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "SENTINEL_BODYTEXT lorem ipsum",
        // Raw free-form gateway error (the PHI-risk field) — must normalize away.
        error: "SENTINEL_ERR patient Jean Dupont at /records/x",
        runId: "webchat-run-z",
        updatedAt: Date.now() - 30 * 60 * 1000, // stale -> stuckStreaming
      });
      const storageId = await ctx.storage.store(new Blob(["x"]));
      // One part of every kind, each carrying a sentinel in its content slots.
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 0,
        part: {
          kind: "tool" as const,
          name: "bash",
          phase: "done",
          input: { cmd: "SENTINEL_TOOLIN" },
          output: "SENTINEL_TOOLOUT",
        },
      });
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 1,
        part: { kind: "reasoning" as const, text: "SENTINEL_REASONING" },
      });
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 2,
        part: {
          kind: "file" as const,
          storageId,
          filename: "SENTINEL_FILENAME.pdf",
          mimeType: 'application/pdf; name="SENTINEL_MIMEPARAM.pdf"',
        },
      });
      await ctx.db.insert("messageParts", {
        messageId: mid,
        order: 3,
        part: {
          kind: "provenance" as const,
          v: 1,
          pluginId: "lightrag",
          source: "SENTINEL_PROVSOURCE.pdf",
          group: "documents" as const,
          retrieval: { route: "lightrag" },
          // A findable DOCUMENT item (file_name + score) and a CONTEXT excerpt (text).
          // The SOC2 structure must expose their KINDS + presence booleans, never the
          // file_name string, the score number, the raw emitter `type`, or the text.
          items: [
            {
              file_name: "SENTINEL_PROVFILENAME.pdf",
              title: "SENTINEL_PROVTITLE",
              score: 0.7777,
              type: "SENTINEL_PROVTYPE",
            },
            { text: "SENTINEL_PROVITEM" },
          ],
        },
      });
      return cid;
    });

    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    expect(state.ok).toBe(true);
    if (!state.ok) return;

    // (1) AUDITABLE NO-CONTENT PROOF: not a single sentinel anywhere.
    const serialized = JSON.stringify(state);
    for (const sentinel of [
      "SENTINEL_BODYTEXT",
      "SENTINEL_ERR",
      "SENTINEL_TOOLIN",
      "SENTINEL_TOOLOUT",
      "SENTINEL_REASONING",
      "SENTINEL_FILENAME",
      "SENTINEL_MIMEPARAM",
      "SENTINEL_PROVSOURCE",
      "SENTINEL_PROVITEM",
      "SENTINEL_PROVFILENAME",
      "SENTINEL_PROVTITLE",
      "SENTINEL_PROVTYPE",
      "0.7777", // the score VALUE — only the hasScore boolean may survive
    ]) {
      expect(serialized).not.toContain(sentinel);
    }

    // (2) Structural projection is present + correct.
    const msg = state.messages[0]!;
    expect(msg.status).toBe("streaming");
    expect(msg.stuckStreaming).toBe(true);
    expect(msg.runStatusKind).toBe("generating"); // streaming + has text
    expect(msg.textLenBucket).toBe("1-100");
    expect(msg.errorCode).toBe("unknown"); // raw error normalized away
    const byKind = Object.fromEntries(msg.parts.map((p) => [p.kind, p]));
    expect(byKind.tool).toMatchObject({
      name: "bash", // base tool name IS exposed (safe per spec)
      hasInput: true,
      hasOutput: true,
    });
    expect(byKind.file).toMatchObject({
      mimeType: "application/pdf", // base only, name= param stripped
      hasFilename: true,
    });
    expect(byKind.reasoning).toEqual({ kind: "reasoning" }); // presence only
    // Provenance now carries the SOC2-safe STRUCTURE (kinds + booleans + counts +
    // allowlisted labels) — the diagnostic signal that lets the MCP see "this turn's
    // documents carry no score" without any content. The sentinel source folded to
    // "other"; no file_name / score / text / raw `type` survived (asserted above).
    expect(byKind.provenance).toEqual({
      kind: "provenance",
      structure: {
        group: "documents",
        source: "other",
        retrievalRoute: "lightrag",
        itemCount: 2,
        hasExcerpts: true,
        items: [
          // `present` lists the field NAMES that reached Convex (never values). "title"
          // here is THE diagnostic for "the readable name reached Convex" — if a real
          // document's present[] lacks "title", the emitting plugin isn't sending it.
          // (The context item's text was stripped by the compact projection, so "text"
          // is absent from present[]; the part-level hasExcerpts:true still proves it.)
          {
            kind: "document",
            hasFileName: true,
            hasScore: true,
            present: ["type", "score", "file_name", "title"],
          },
          { kind: "context", hasFileName: false, hasScore: false, present: [] },
        ],
      },
    });
  });

  // Post-split, a streaming message's heartbeat + live length live on the streamingText
  // ROW, not the (empty) message doc. chatStateInternal must derive stuckStreaming,
  // ageSeconds and textLenBucket from the ROW. This pins the `live ? live.* : mDoc.*`
  // branch the sentinel test above does NOT exercise (it has no row, so it only hits the
  // mDoc fallback). A regression to reading mDoc here would report an active stream as
  // empty + stuck. Also re-proves the no-leak contract for the row's text.
  test("derives heartbeat + textLen from the streamingText ROW (not the empty message doc), no leak", async () => {
    const t = convexTest(schema, modules);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const cid = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      const mid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "", // the real new-model shape: doc text is empty while streaming
        // STALE doc heartbeat — if the derivation read THIS it would report stuck.
        runId: "webchat-run-live",
        updatedAt: Date.now() - 30 * 60 * 1000,
      });
      // The live text + a FRESH heartbeat are on the row. 50 chars -> "1-100" bucket;
      // an empty-doc regression would bucket as 0. The sentinel proves no text leak.
      await ctx.db.insert("streamingText", {
        messageId: mid,
        chatId: cid,
        text: "SENTINEL_LIVETEXT " + "x".repeat(32), // 50 chars total
        updatedAt: Date.now(),
      });
      return cid;
    });

    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    expect(state.ok).toBe(true);
    if (!state.ok) return;

    // The row's live text NEVER leaks (only its bucketed length is emitted).
    expect(JSON.stringify(state)).not.toContain("SENTINEL_LIVETEXT");

    const msg = state.messages[0]!;
    // FRESH row heartbeat wins over the STALE doc updatedAt -> not stuck, generating.
    expect(msg.stuckStreaming).toBe(false);
    expect(msg.runStatusKind).toBe("generating"); // streaming + hasText (from the row)
    // Length comes from the row (50), not the empty doc (which would not be "1-100").
    expect(msg.textLenBucket).toBe("1-100");
  });

  test("L2: surfaces attachedDocCount + documentary kind + pendingDocFetch age, never a reference", async () => {
    const t = convexTest(schema, modules);
    const { convId, docId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const convId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      const srcMsg = await ctx.db.insert("messages", {
        chatId: convId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "hi",
        attachedDocCount: 2,
        updatedAt: Date.now(),
      });
      // A documentAttachments row with a PHI-like reference: chat-state must NEVER
      // pull it (it reads the denormalized count only, not the rows).
      await ctx.db.insert("documentAttachments", {
        userId,
        sourceMessageId: srcMsg,
        entryKey: "k",
        reference: "SENTINEL_DOCREF.pdf",
        status: "ready" as const,
        createdAt: 1,
        updatedAt: 1,
      });
      const docId = await ctx.db.insert("chats", {
        userId,
        kind: "documentary" as const,
        title: "Documents",
        updatedAt: 0,
        pendingFetch: { sourceMessageId: srcMsg, createdAt: Date.now() - 13 * 60 * 1000 },
      });
      return { convId, docId };
    });

    const conv = await t.query(internal.messages.chatStateInternal, { chatId: convId });
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;
    expect(conv.messages[0]!.attachedDocCount).toBe(2);
    expect(conv.kind).toBeNull(); // a conversational chat
    expect(conv.pendingDocFetch).toBeNull();
    // The reference NEVER leaks through chat-state.
    expect(JSON.stringify(conv)).not.toContain("SENTINEL_DOCREF");

    const doc = await t.query(internal.messages.chatStateInternal, { chatId: docId });
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.kind).toBe("documentary");
    expect(doc.pendingDocFetch).not.toBeNull();
    expect(doc.pendingDocFetch!.ageSeconds).toBeGreaterThan(700); // stale -> stuck
  });

  // ROUTING (G1) + the dispatch JOIN KEY (G4) + the CONTENT-FREE sub-agent summary
  // (G3). The SOC2 contract again: every NEW field carries STRUCTURE only. The
  // sub-agent rows seed content in EVERY content slot (taskName / errorMessage /
  // resultText / phase) and the outbox seeds its text — none may surface. The
  // hasTaskName/errorCategory teeth: a naive `taskName`/`errorMessage` projection
  // would leak the seeded sentinel (asserted absent), so the guard has real bite.
  test("surfaces routing + bounded sub-agent summary + outbox join key, NO content leak", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId, userMsgId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const cid = await ctx.db.insert("chats", {
        userId,
        updatedAt: 0,
        perTurnRouting: true,
        lastRoutedInstanceName: "inst-b",
        lastRoutedAgentId: "agent-b",
        routingSegment: "turn:seg-123",
      });
      const uid = await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "hello",
        routedInstanceName: "inst-b",
        routedAgentId: "agent-b",
        updatedAt: Date.now(),
      });
      const obId = await ctx.db.insert("outbox", {
        chatId: cid,
        userId,
        clientMessageId: "cmid-1",
        messageId: uid,
        text: "SENTINEL_OUTBOXTEXT",
        attachmentIds: [],
        status: "sent" as const,
      });
      // A FAILED sub-agent (content in every slot, incl. PHI in the error) and a
      // fresh RUNNING one (no taskName -> hasTaskName must read false).
      await ctx.db.insert("subAgents", {
        chatId: cid,
        childSessionKey: "agent:x:subagent:erruuid000000",
        taskName: "SENTINEL_SUBTASK",
        status: "error" as const,
        errorMessage: "SENTINEL_SUBERR 429 rate limit for Jean Dupont",
        resultText: "SENTINEL_SUBRESULT",
        phase: "SENTINEL_SUBPHASE",
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      });
      await ctx.db.insert("subAgents", {
        chatId: cid,
        childSessionKey: "agent:x:subagent:rununresidual",
        status: "running" as const,
        phase: "SENTINEL_RUNPHASE",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { chatId: cid, outboxId: obId, userMsgId: uid };
    });

    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    expect(state.ok).toBe(true);
    if (!state.ok) return;

    // (1) AUDITABLE NO-CONTENT PROOF: no sub-agent / outbox sentinel anywhere.
    const serialized = JSON.stringify(state);
    for (const sentinel of [
      "SENTINEL_OUTBOXTEXT",
      "SENTINEL_SUBTASK",
      "SENTINEL_SUBERR",
      "SENTINEL_SUBRESULT",
      "SENTINEL_SUBPHASE", // phase is free-form gateway text -> treated as content
      "SENTINEL_RUNPHASE",
      "Jean Dupont", // PHI inside the raw error must never escape the classifier
    ]) {
      expect(serialized).not.toContain(sentinel);
    }

    // (2) Chat-level routing (non-secret slugs + the opaque session segment).
    expect(state.routing).toEqual({
      perTurnRouting: true,
      lastRoutedInstanceName: "inst-b",
      lastRoutedAgentId: "agent-b",
      routingSegment: "turn:seg-123",
    });

    // (3) Per-message routing + the dispatch JOIN KEY (chatId:outboxId reconstructs
    // the turn's send/dispatch/rehydrate chain in list_traces).
    const m = state.messages[0]!;
    expect(m.messageId).toBe(userMsgId);
    expect(m.routedInstanceName).toBe("inst-b");
    expect(m.routedAgentId).toBe("agent-b");
    expect(m.outbox).toEqual({ outboxId, status: "sent" });
    expect(state.outboxTruncated).toBe(false);

    // (4) Sub-agent summary: counts + samples, content-free. errorCategory is the
    // FIXED enum ("429" -> api_error), NOT the text; hasTaskName is a BOOLEAN.
    expect(state.subAgents.total).toBe(2);
    expect(state.subAgents.byStatus).toEqual({
      running: 1,
      done: 0,
      error: 1,
      aborted: 0,
    });
    const failed = state.subAgents.failedSample[0]!;
    expect(failed.status).toBe("error");
    expect(failed.errorCategory).toBe("api_error");
    expect(failed.hasTaskName).toBe(true);
    const running = state.subAgents.runningSample[0]!;
    expect(running.status).toBe("running");
    expect(running.hasTaskName).toBe(false); // no taskName seeded
  });

  // INTEGRATION: a STALE running sub-agent flows chatStateInternal -> assessChat ->
  // subagent_stuck. The pure assessChat tests hand-feed ageSeconds; ONLY this
  // exercises the real ageSeconds = (now - updatedAt)/1000 derivation in
  // loadSubAgentSummary against the diagnose threshold — i.e. it would catch
  // "diagnose silently never fires subagent_stuck in prod". This is the exact
  // composition the GET /api/v1/diagnose route performs.
  test("integration: a STALE running sub-agent -> chatStateInternal -> assessChat -> subagent_stuck", async () => {
    const t = convexTest(schema, modules);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const cid = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      // A COMPLETED visible turn (so it is NOT a stuck stream, which would win) +
      // a sub-agent stuck 'running' with a 30-min-stale heartbeat (> the 20-min
      // STUCK_SUBAGENT_SECONDS threshold).
      await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "ok",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("subAgents", {
        chatId: cid,
        childSessionKey: "agent:x:subagent:stalerun0000",
        status: "running" as const,
        createdAt: Date.now() - 30 * 60 * 1000,
        updatedAt: Date.now() - 30 * 60 * 1000,
      });
      return cid;
    });

    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    const assessment = assessChat(state, {
      known: true,
      available: true,
      degraded: false,
      reason: null,
    });
    expect(assessment.class).toBe("subagent_stuck");
    expect(assessment.severity).toBe("high");
    expect(assessment.suggestedTool).toBeNull();
  });

  // Codex P2 regression: with MORE running sub-agents than the cap, the STALEST
  // (stuck) one must still reach the sample so subagent_stuck fires. A newest-first
  // sample would drop exactly the oldest running rows the stuck check needs — here
  // the stale child is inserted FIRST (oldest creation) + many fresher ones follow,
  // so a creation-ordered desc sample would drop it and mis-report "healthy".
  test("Codex P2: > cap running sub-agents, the STALEST is stuck -> subagent_stuck (not dropped)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const cid = await ctx.db.insert("chats", { userId, updatedAt: 0 });
      await ctx.db.insert("messages", {
        chatId: cid,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "ok",
        updatedAt: Date.now(),
      });
      // The STUCK child: oldest creation AND stalest heartbeat (30 min > 20 min).
      // Inserted first so a creation-desc sample would evict it under the cap.
      await ctx.db.insert("subAgents", {
        chatId: cid,
        childSessionKey: "agent:x:subagent:stalestone0",
        status: "running" as const,
        createdAt: Date.now() - 40 * 60 * 1000,
        updatedAt: Date.now() - 30 * 60 * 1000,
      });
      // 25 FRESH running children (> cap=20), all newer-created + fresh heartbeat.
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("subAgents", {
          chatId: cid,
          childSessionKey: `agent:x:subagent:fresh${i}`,
          status: "running" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return cid;
    });

    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    // The cap was hit -> truncated is honest.
    expect(state.subAgents.truncated).toBe(true);
    // The stalest (stuck) child is in the running sample despite the cap.
    expect(
      state.subAgents.runningSample.some((s) => s.ageSeconds > 20 * 60),
    ).toBe(true);

    // End-to-end: diagnose fires subagent_stuck (NOT healthy).
    const assessment = assessChat(state, {
      known: true,
      available: true,
      degraded: false,
      reason: null,
    });
    expect(assessment.class).toBe("subagent_stuck");
  });

  test("bad / unknown chatId returns ok:false (never throws)", async () => {
    const t = convexTest(schema, modules);
    const bad = await t.query(internal.messages.chatStateInternal, {
      chatId: "not-a-real-id",
    });
    expect(bad.ok).toBe(false);
  });
});
