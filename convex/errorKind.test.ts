import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// Needed by the trace assertions below: `traceStream` swallows every failure by design
// ("never break the primary stream write on a trace error"), so without the modules loaded a
// trace that never ran would be indistinguishable from a code the allowlist dropped.
const modules = import.meta.glob("./**/*.ts");

// Gateway errorKind persistence (the context_length hard-overflow chain):
// stream.finalize now accepts the gateway's stable failure class
// (ChatErrorEventSchema.errorKind: refusal|timeout|rate_limit|context_length)
// and persists it into the message's EXISTING `errorCode` field — the same
// field the curated dispatch codes use — so loadChatView projects it with no
// new plumbing and the UI maps it to an actionable localized headline.

async function seedStreamingMessage(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
    return { chatId, messageId };
  });
}

describe("stream.finalize errorKind -> errorCode", () => {
  test("a context_length error persists the kind as the message errorCode", async () => {
    const t = convexTest(schema);
    const { messageId } = await seedStreamingMessage(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      text: "",
      error: "Context window exceeded for this model",
      errorKind: "context_length",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.error).toBe("Context window exceeded for this model");
    expect(msg?.errorCode).toBe("context_length");
  });

  test("the gateway's STORAGE classes reach the message AND the trace", async () => {
    // The chain this defect is about: the bridge classifies the gateway's sentence, and the
    // class has to survive the trace's non-PHI allowlist to reach the per-cause anomaly plane.
    // Missing from that list, the code was dropped from the trace and the two cause classes
    // were unreachable — the failure counted only in the generic stream-error channel and the
    // diagnostic API said "unknown" (codex).
    for (const errorKind of ["gateway_storage_busy", "gateway_storage_unavailable"]) {
      const t = convexTest(schema, modules);
      const { messageId } = await seedStreamingMessage(t);
      await t.mutation(internal.stream.finalize, {
        messageId,
        status: "error",
        text: "",
        error:
          "⚠️ Agent run failed: the Gateway state database was full (SQLite: database or disk is full). Free disk space on the Gateway host and retry.",
        errorKind,
      });
      const msg = await t.run((ctx) => ctx.db.get(messageId));
      expect(msg?.errorCode, errorKind).toBe(errorKind);
      const traces = await t.run((ctx) =>
        ctx.db.query("traceEvents").collect(),
      );
      // `meta` is a JSON STRING on the row — read it the way the detector reads it
      // (anomalies.ts:283,302,347), not as an object.
      const finalize = traces.find((ev) => {
        if (typeof ev.meta !== "string") return false;
        return (JSON.parse(ev.meta) as { phase?: string }).phase === "finalize";
      });
      expect(finalize, `${errorKind}: no finalize trace`).toBeDefined();
      expect(
        (JSON.parse(finalize!.meta as string) as { errorCode?: string }).errorCode,
        errorKind,
      ).toBe(errorKind);
    }
  });

  test("a clean finalize leaves errorCode untouched (absent)", async () => {
    const t = convexTest(schema);
    const { messageId } = await seedStreamingMessage(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "réponse",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.errorCode).toBeUndefined();
  });
});

// A DELIVERY run (announce settle, task delivery, talk consult) is exempt from the
// bridge's empty-response verdict: its item cards usually ARE the content, and it
// often merges into an already-complete bubble. But a delivery that brings NEITHER
// text NOR a file leaves the reader an empty bubble with no cause and nothing to
// count — live: four consecutive empty replies (prod-ms73vsdw…), and a vade-mecum
// whose delegated task timed out (prod-ms7bybmm…). Decided HERE because only the
// stored message shows what the reader actually has.
describe("a delivery run that delivered nothing", () => {
  const CHILD_KEY = "agent:files:subagent:9af5b6c1-d161-4994-a5df-6e256c5b4336";
  const ANNOUNCE_RUN = `announce:v1:${CHILD_KEY}:650150d5-fa3d-4c7c-825c-e6684997f82d`;
  const SETTLE_RUN =
    "announce:requester-settle:fabien:agent:fabien:atrium:chat:u:c:1fb3b330-5fd8-4a5b-b966-7a40e040c2bb:yield-1";

  async function seedDelivery(
    t: ReturnType<typeof convexTest>,
    runId: string,
    text?: string,
  ) {
    const { messageId, chatId } = await seedStreamingMessage(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, {
        runId,
        ...(text !== undefined ? { text } : {}),
      });
    });
    return { messageId, chatId };
  }

  test("neither text nor file: the turn is NAMED empty_response, not silent", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, SETTLE_RUN);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    // Same shape as the bridge's own empty-response verdict: an error the reader
    // can read, and a cause the anomaly plane can count.
    expect(msg?.status).toBe("error");
    expect(msg?.errorCode).toBe("empty_response");
    expect(msg?.error).toBe(
      "The delivery finished without bringing anything (no text, no file).",
    );
    // COUNTED, not just displayed: the detector reads the finalize trace, and it
    // keys on both fields — a row left `streamStatus: "complete"` is invisible to
    // `streamFinalizeClass`, and one without the code falls back to the generic
    // "N stream errors" bucket the per-cause plane exists to replace.
    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    const finalize = traces
      .map((ev) =>
        typeof ev.meta === "string"
          ? (JSON.parse(ev.meta) as {
              phase?: string;
              streamStatus?: string;
              errorCode?: string;
            })
          : null,
      )
      .find((m) => m?.phase === "finalize");
    expect(finalize, "no finalize trace").toBeDefined();
    expect(finalize?.streamStatus).toBe("error");
    expect(finalize?.errorCode).toBe("empty_response");
    // And SILENT in the sidebar: `lastAssistantAt` is the arrival cue (flash,
    // unread dot, reply sound). A failed delivery must not announce a reply.
    const chat = await t.run((ctx) => ctx.db.get(msg!.chatId));
    expect(chat?.lastAssistantAt).toBeUndefined();
  });

  test("a delivery that brings TEXT is untouched", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, SETTLE_RUN);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "voici le document",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
  });

  test("a delivery that brings a FILE is untouched — the card IS the content", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, SETTLE_RUN);
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "file",
          storageId,
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
        },
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
  });

  test("a REAL announce merge is never stamped — the bubble shows the parent's reply", async () => {
    // Built through the merge path itself (startAssistant reopens the parent,
    // parks its text as the prefix and seeds the live row with it), because the
    // rule that holds this case is the FINAL TEXT one: with no new text, the
    // finalize recomposes what the reader already has. A test that only patched
    // `text` onto a bubble would prove the fallback, not the merge.
    const t = convexTest(schema, modules);
    const { chatId, parentId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "alice",
      });
      const parentId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "La tâche est lancée.",
        runId: "webchat-parent-run",
        finalizedAt: 2000,
        updatedAt: 2000,
      });
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: parentId,
        anchorExact: true,
        childSessionKey: CHILD_KEY,
        status: "done" as const,
        createdAt: 1500,
        updatedAt: 2500,
      });
      return { chatId, parentId };
    });
    const reopened = await t.mutation(internal.stream.startAssistant, {
      chatId,
      runId: ANNOUNCE_RUN,
    });
    expect(reopened).toBe(parentId);
    // The announce brings nothing of its own: the merge closes on the prefix.
    await t.mutation(internal.stream.finalize, {
      messageId: parentId,
      status: "complete",
      text: "",
    });
    const msg = await t.run((ctx) => ctx.db.get(parentId));
    expect(msg?.text).toBe("La tâche est lancée.\n\n");
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
  });

  test("a delivery whose only act was to MOVE THE PLAN is untouched", async () => {
    // `advancePlanPart` inserts the estimated plan part BEFORE the finalize, and
    // the reader watches the checklist move — that card is content.
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, SETTLE_RUN);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "plan",
          steps: [
            { step: "Lire le dossier", status: "completed" as const },
            { step: "Rédiger la note", status: "in_progress" as const },
          ],
          estimated: true,
        },
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
  });

  test("a CLEARED plan is a tombstone, not content — still empty_response", async () => {
    // An empty step list is how a plan is cleared, and the client hides it
    // (src/chat/planView.ts). The probe reads the plan the reader SHOWS —
    // greatest stamp — not the presence of a plan row.
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, SETTLE_RUN);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "plan",
          steps: [{ step: "Rédiger la note", status: "in_progress" as const }],
          stamp: 1000,
        },
      });
      await ctx.db.insert("messageParts", {
        messageId,
        order: 1,
        part: { kind: "plan", steps: [], stamp: 2000 },
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.errorCode).toBe("empty_response");
  });

  test("a file part whose BLOB IS GONE renders nothing — still empty_response", async () => {
    // The client drops a media part with no resolved url, so the row alone is
    // not the delivery: the reader has nothing to open.
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, SETTLE_RUN);
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "file",
          storageId,
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
        },
      });
      await ctx.storage.delete(storageId);
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.errorCode).toBe("empty_response");
  });

  test("a bubble with MORE parts than the probe reads is left alone", async () => {
    // Inconclusive beats a wrong verdict: evidence we did not finish reading
    // cannot name a failure (the sink's own doctrine on its truncated sets).
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, SETTLE_RUN);
    await t.run(async (ctx) => {
      for (let i = 0; i < 65; i++) {
        await ctx.db.insert("messageParts", {
          messageId,
          order: i,
          part: { kind: "tool", name: "read", phase: "done" },
        });
      }
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
  });

  test("a file that lands AFTER the verdict takes the error card back", async () => {
    // The bridge deliberately lets a slow upload attach its file after the
    // final. The verdict was true when taken and is false now — an error card
    // over a delivered document is the same silence defect, mirrored.
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedDelivery(t, SETTLE_RUN);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    expect(await t.run((ctx) => ctx.db.get(messageId))).toMatchObject({
      status: "error",
      errorCode: "empty_response",
    });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["pdf"])));
    await t.mutation(internal.stream.addPart, {
      messageId,
      expectedRunId: SETTLE_RUN,
      part: {
        kind: "file",
        storageId,
        filename: "vade-mecum.pdf",
        mimeType: "application/pdf",
      },
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
    expect(msg?.error).toBeUndefined();
    // The reply DID arrive: the sidebar's arrival cue is given back.
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.lastAssistantAt).toBeTypeOf("number");
    // …and the observability plane is told, on the SAME correlation as the
    // finalize it compensates — otherwise the operator keeps an anomaly (and the
    // chart a point) for a delivery the reader received.
    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    const repair = traces.find(
      (ev) =>
        typeof ev.meta === "string" &&
        (JSON.parse(ev.meta) as { phase?: string }).phase ===
          "finalize_repaired",
    );
    expect(repair, "no repair trace").toBeDefined();
    expect(
      (JSON.parse(repair!.meta as string) as { errorCode?: string }).errorCode,
    ).toBe("empty_response");
    const failed = traces.find(
      (ev) =>
        typeof ev.meta === "string" &&
        (JSON.parse(ev.meta) as { phase?: string }).phase === "finalize",
    );
    expect(repair!.correlationId).toBe(failed!.correlationId);
  });

  test("a LATE file whose blob is already gone does not clear the error", async () => {
    // The inverse rule is storage-aware too: the client drops a part with no
    // url, so clearing the card here would trade a true failure for a false
    // arrival cue.
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedDelivery(t, SETTLE_RUN);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    const storageId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.storage.delete(id);
      return id;
    });
    await t.mutation(internal.stream.addPart, {
      messageId,
      expectedRunId: SETTLE_RUN,
      part: {
        kind: "file",
        storageId,
        filename: "vade-mecum.pdf",
        mimeType: "application/pdf",
      },
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.errorCode).toBe("empty_response");
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.lastAssistantAt).toBeUndefined();
  });

  test("a REBROADCAST repairs a delivery whose file lost its blob", async () => {
    // The replay window dedupes media on filename+mimeType (the storageId always
    // differs on a re-upload). A DEAD row must not shadow the fresh one, or the
    // rebroadcast — the only repair path for this bubble — would delete the good
    // bytes and leave the reader with the same empty delivery.
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedDelivery(t, ANNOUNCE_RUN);
    await t.run(async (ctx) => {
      const msg = (await ctx.db.get(messageId))!;
      const dead = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        announceRun: ANNOUNCE_RUN,
        part: {
          kind: "file",
          storageId: dead,
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
        },
      });
      // The paired `files` row the live path always writes (the invariant).
      await ctx.db.insert("files", {
        userId: msg.userId,
        chatId,
        messageId,
        storageId: dead,
        filename: "vade-mecum.pdf",
        mimeType: "application/pdf",
        kind: "file" as const,
        direction: "outbound" as const,
        category: "pdf" as const,
        createdAt: Date.now(),
      });
      await ctx.storage.delete(dead);
      // The armed window: what a rebroadcast/error-resume sets up.
      await ctx.db.patch(messageId, {
        status: "error" as const,
        errorCode: "empty_response",
        announceReplayArmed: Date.now() + 60_000,
        announceReplayRun: ANNOUNCE_RUN,
      });
    });
    const fresh = await t.run((ctx) => ctx.storage.store(new Blob(["pdf-2"])));
    await t.mutation(internal.stream.addPart, {
      messageId,
      expectedRunId: ANNOUNCE_RUN,
      part: {
        kind: "file",
        storageId: fresh,
        filename: "vade-mecum.pdf",
        mimeType: "application/pdf",
      },
    });
    const parts = await t.run((ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    // REPLACED, not stacked: the dead row would otherwise stay in the user's
    // file list forever as an "unavailable" download beside the good copy.
    expect(parts).toHaveLength(1);
    expect(
      parts[0]!.part.kind === "file" ? parts[0]!.part.storageId : null,
    ).toBe(fresh);
    const fileRows = await t.run((ctx) => ctx.db.query("files").collect());
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]!.storageId).toBe(fresh);
    // The fresh bytes survived (a dedup would have reclaimed them).
    expect(await t.run((ctx) => ctx.storage.getUrl(fresh))).not.toBeNull();
    // …and the delivery is no longer a failure.
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
  });

  test("a REPLAY over a file the reader can open takes the card back", async () => {
    // The finalize's probe stands down when storage cannot answer, so a bubble
    // can carry a file while the error card stands. The rebroadcast changes
    // nothing visible — it dedupes — but it is the moment we can SEE the file
    // resolves, and an error card over a document the reader opens is the same
    // silence defect mirrored.
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedDelivery(t, ANNOUNCE_RUN);
    const alive = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        announceRun: ANNOUNCE_RUN,
        part: {
          kind: "file",
          storageId: id,
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
        },
      });
      await ctx.db.patch(messageId, {
        status: "error" as const,
        error: "The delivery finished without bringing anything (no text, no file).",
        errorCode: "empty_response",
        announceReplayArmed: Date.now() + 60_000,
        announceReplayRun: ANNOUNCE_RUN,
      });
      return id;
    });
    const replayed = await t.run((ctx) => ctx.storage.store(new Blob(["pdf"])));
    await t.mutation(internal.stream.addPart, {
      messageId,
      expectedRunId: ANNOUNCE_RUN,
      part: {
        kind: "file",
        storageId: replayed,
        filename: "vade-mecum.pdf",
        mimeType: "application/pdf",
      },
    });
    // Deduped: one part, the original blob, and the replayed bytes reclaimed.
    const parts = await t.run((ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    expect(parts).toHaveLength(1);
    expect(await t.run((ctx) => ctx.storage.getUrl(alive))).not.toBeNull();
    // …and the card is gone.
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
    expect(msg?.error).toBeUndefined();
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.lastAssistantAt).toBeTypeOf("number");
    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    expect(
      traces.some(
        (ev) =>
          typeof ev.meta === "string" &&
          (JSON.parse(ev.meta) as { phase?: string }).phase ===
            "finalize_repaired",
      ),
      "the observability plane was not told",
    ).toBe(true);
  });

  test("an operator REPAIR of a file already there clears the card too", async () => {
    // Same moment as the replay, reached by the other door: the repair path's
    // "already attached" branch returns success without moving anything — and
    // that success is itself the proof the reader has the document.
    const t = convexTest(schema, modules);
    const { messageId, chatId } = await seedDelivery(t, SETTLE_RUN);
    const attached = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "file",
          storageId: id,
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
        },
      });
      await ctx.db.patch(messageId, {
        status: "error" as const,
        errorCode: "empty_response",
      });
      return id;
    });
    const duplicate = await t.run((ctx) => ctx.storage.store(new Blob(["pdf"])));
    await t.mutation(internal.stream.addPart, {
      messageId,
      repair: true,
      // The repair path posts `media` (what the operator API attaches); the
      // bubble may already carry the same name as a `file` part.
      part: {
        kind: "media",
        storageId: duplicate,
        filename: "vade-mecum.pdf",
        mimeType: "application/pdf",
      },
    });
    const parts = await t.run((ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    expect(parts).toHaveLength(1);
    expect(await t.run((ctx) => ctx.storage.getUrl(attached))).not.toBeNull();
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.lastAssistantAt).toBeTypeOf("number");
  });

  test("the repair verdict reads the WHOLE bubble, not the probe's window", async () => {
    // The finalize probe stops at its cap because a truncated read must not NAME
    // a failure. This path can only take one back — and a file sitting behind 64
    // tool cards is exactly the bubble an operator is repairing.
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, SETTLE_RUN);
    await t.run(async (ctx) => {
      for (let i = 0; i < 65; i++) {
        await ctx.db.insert("messageParts", {
          messageId,
          order: i,
          part: { kind: "tool", name: "read", phase: "done" },
        });
      }
      const storageId = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 65,
        part: {
          kind: "file",
          storageId,
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
        },
      });
      await ctx.db.patch(messageId, {
        status: "error" as const,
        errorCode: "empty_response",
      });
    });
    await t.mutation(internal.stream.reconcileDeliveryVerdict, { messageId });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
  });

  test("the verdict KEEPS the merge resumable — prefix and replay window", async () => {
    // The naming makes the turn an error, and an error is exactly the state a
    // rebroadcast resumes from: the pre-merge prefix and the armed window are
    // what let a replayed announce recompose (and replace a dead attachment)
    // instead of opening a second bubble.
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, ANNOUNCE_RUN);
    const armedUntil = Date.now() + 60_000;
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, {
        announcePrefix: "",
        announceReplayArmed: armedUntil,
        announceReplayRun: ANNOUNCE_RUN,
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("error");
    expect(msg?.errorCode).toBe("empty_response");
    expect(msg?.announcePrefix).toBe("");
    expect(msg?.announceReplayArmed).toBe(armedUntil);
  });

  test("the replacement never gives two parts the same order", async () => {
    // `order` is the ONLY thing loadChatView sorts a bubble on, and a tool part
    // without a provider id takes its identity from its position — a collision
    // would reshuffle cards the reader already saw.
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, ANNOUNCE_RUN);
    await t.run(async (ctx) => {
      const dead = await ctx.storage.store(new Blob(["pdf"]));
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        announceRun: ANNOUNCE_RUN,
        part: {
          kind: "file",
          storageId: dead,
          filename: "vade-mecum.pdf",
          mimeType: "application/pdf",
        },
      });
      // Order 2, not 1: an EARLIER repair already left a gap, which is the state
      // this rule is about — a length-derived order lands straight on this row.
      await ctx.db.insert("messageParts", {
        messageId,
        order: 2,
        announceRun: ANNOUNCE_RUN,
        part: { kind: "reasoning", text: "…" },
      });
      await ctx.storage.delete(dead);
      await ctx.db.patch(messageId, {
        announceReplayArmed: Date.now() + 60_000,
        announceReplayRun: ANNOUNCE_RUN,
      });
    });
    const fresh = await t.run((ctx) => ctx.storage.store(new Blob(["pdf-2"])));
    await t.mutation(internal.stream.addPart, {
      messageId,
      expectedRunId: ANNOUNCE_RUN,
      part: {
        kind: "file",
        storageId: fresh,
        filename: "vade-mecum.pdf",
        mimeType: "application/pdf",
      },
    });
    const parts = await t.run((ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    const orders = parts.map((p) => p.order);
    expect(new Set(orders).size, `duplicate order in ${orders.join(",")}`).toBe(
      orders.length,
    );
  });

  test("an ORDINARY turn is left to the bridge's own verdict", async () => {
    // Convex must not double-judge: the sink decides empty turns, with the signals
    // (yield, spawned children, async task) only it can see.
    const t = convexTest(schema, modules);
    const { messageId } = await seedDelivery(t, "webchat-abc123");
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete");
    expect(msg?.errorCode).toBeUndefined();
  });
});
