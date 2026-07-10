import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { FORK_MESSAGE_CAP } from "./chatFork";
import { effectiveOrder } from "./lib/messageOrder";

const modules = import.meta.glob("./**/*.ts");

// Branch-in-a-new-chat. The discriminating properties:
//   - the fork contains EXACTLY the history up to the branch point, in the
//     SOURCE's logical order (orderTime-preserved), and NOTHING after it;
//   - the fork is a fresh gateway session (no openclawChatId) — the rehydration
//     re-grounding depends on it;
//   - the rolling summary rides over ONLY when it cannot leak later turns;
//   - a foreign message can never seed a fork (IDOR).

async function seedChat(
  t: ReturnType<typeof convexTest>,
  opts?: { messages?: number },
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "alice",
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
      title: "Projet IFOA",
      openclawChatId: "gw-thread-1", // the source HAS a live gateway binding
      // The user's per-chat knob intent — the branch must keep it.
      sessionSettings: { model: "opus", thinkingLevel: "high" },
      // Gateway meta: static fields (model, WINDOW size = the rehydration
      // budget) must ride; the source session's USAGE measures must NOT.
      sessionMeta: {
        model: "gpt-5.5",
        contextTokens: 272000,
        totalTokens: 15968,
        estimatedCostUsd: 0.42,
      },
    });
    const n = opts?.messages ?? 3;
    const ids: Id<"messages">[] = [];
    for (let i = 0; i < n; i++) {
      const role = i % 2 === 0 ? ("user" as const) : ("assistant" as const);
      ids.push(
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role,
          status: "complete" as const,
          text: `msg-${i}`,
          updatedAt: 1000 + i,
        }),
      );
    }
    return { userId, chatId, ids };
  });
}

describe("chatFork.forkChat", () => {
  test("the fork carries EXACTLY the history up to the branch point, order preserved, session fresh", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, ids } = await seedChat(t, { messages: 5 });
    const as = t.withIdentity({ subject: `${userId}|session` });
    // Branch from message index 3 (the 2nd assistant reply) — msg-4 must NOT ride.
    const { chatId: forkId } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[3]!,
    });
    const state = await t.run(async (ctx) => {
      const fork = await ctx.db.get(forkId as Id<"chats">);
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", forkId as Id<"chats">))
        .collect();
      const srcMsgs = await Promise.all(ids.map((id) => ctx.db.get(id)));
      return { fork, msgs, srcMsgs };
    });
    // Same binding + title, provenance marker, and NO gateway binding (fresh
    // session → rehydration re-grounds the agent on first send).
    expect(state.fork!.instanceName).toBe("prod");
    expect(state.fork!.agentId).toBe("main");
    expect(state.fork!.title).toBe("Projet IFOA");
    expect(state.fork!.forkedFromChatId).toBe(chatId);
    expect(state.fork!.openclawChatId).toBeUndefined();
    // First-turn rehydration signal armed (consumed by the dispatch at ACK).
    expect(state.fork!.forkPendingRehydration).toBe(true);
    // The per-chat session knobs continue in the branch.
    expect(state.fork!.sessionSettings).toEqual({
      model: "opus",
      thinkingLevel: "high",
    });
    // Session meta: statics ride (model chip, contextTokens = the rehydration
    // budget); the SOURCE session's usage measures do not (fresh session).
    expect(state.fork!.sessionMeta?.model).toBe("gpt-5.5");
    expect(state.fork!.sessionMeta?.contextTokens).toBe(272000);
    expect(state.fork!.sessionMeta?.totalTokens).toBeUndefined();
    expect(state.fork!.sessionMeta?.estimatedCostUsd).toBeUndefined();
    // Same top-of-list placement as createChat (source has no sortKey → min 0).
    expect(state.fork!.archived).toBe(false);
    expect(state.fork!.sortKey).toBeLessThan(0);
    // History = messages 0..3 inclusive, in SOURCE logical order.
    const ordered = [...state.msgs].sort(
      (a, b) => effectiveOrder(a) - effectiveOrder(b),
    );
    expect(ordered.map((m) => m.text)).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
    ]);
    // orderTime preserves the SOURCE order exactly (copies sort as history even
    // though their _creationTime is fresh).
    expect(ordered.map((m) => m.orderTime)).toEqual(
      state.srcMsgs.slice(0, 4).map((m) => effectiveOrder(m!)),
    );
    // Correlation fields never ride.
    expect(ordered.every((m) => m.runId === undefined)).toBe(true);
  });

  test("IDOR: a message from SOMEONE ELSE's chat can never seed a fork", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await seedChat(t); // owned by alice
    const intruderId = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: u,
        role: "user" as const,
        canonical: "mallory",
      });
      return u;
    });
    const asIntruder = t.withIdentity({ subject: `${intruderId}|session` });
    await expect(
      asIntruder.mutation(api.chatFork.forkChat, { branchMessageId: ids[1]! }),
    ).rejects.toThrow(/forbidden/);
  });

  test("a HIDDEN utility chat never forks", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedChat(t);
    const msgId = await t.run(async (ctx) => {
      const hidden = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        kind: "documentary" as const,
      });
      return await ctx.db.insert("messages", {
        chatId: hidden,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "fetch",
        updatedAt: 1,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await expect(
      as.mutation(api.chatFork.forkChat, { branchMessageId: msgId }),
    ).rejects.toThrow(/not_forkable/);
  });

  test("file/media parts ride with their files-table pairing (same storageId, no blob copy); tool parts do not", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, ids } = await seedChat(t);
    const storageId = await t.run(async (ctx) => {
      const sid = await ctx.storage.store(new Blob(["PDF"], { type: "application/pdf" }));
      await ctx.db.insert("messageParts", {
        messageId: ids[1]!,
        order: 1,
        part: {
          kind: "file" as const,
          storageId: sid,
          filename: "rapport.pdf",
          mimeType: "application/pdf",
        },
      });
      await ctx.db.insert("messageParts", {
        messageId: ids[1]!,
        order: 2,
        part: {
          kind: "tool" as const,
          name: "exec",
          phase: "completed",
          input: "big blob",
        },
      });
      // The delegation MARKER rides (it gates the in-context sub-agent cards).
      await ctx.db.insert("messageParts", {
        messageId: ids[1]!,
        order: 3,
        part: {
          kind: "tool" as const,
          name: "sessions_spawn",
          phase: "completed",
        },
      });
      // Source files row (the invariant pairing on the ORIGINAL) — carries
      // row-level metadata the part does not (origin:"pasted" = hidden by
      // default in Settings > Files; the copy must stay hidden too).
      await ctx.db.insert("files", {
        userId,
        chatId,
        messageId: ids[1]!,
        storageId: sid,
        filename: "rapport.pdf",
        mimeType: "application/pdf",
        kind: "file" as const,
        direction: "outbound" as const,
        createdAt: 1,
        origin: "pasted" as const,
      });
      return sid;
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { chatId: forkId } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[1]!,
    });
    const state = await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", forkId as Id<"chats">))
        .collect();
      const copied = msgs.find((m) => m.text === "msg-1")!;
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", copied._id))
        .collect();
      const fileRows = await ctx.db
        .query("files")
        .withIndex("by_storage", (q) => q.eq("storageId", storageId))
        .collect();
      return { parts, fileRows, forkChatRows: fileRows.filter((f) => f.chatId === (forkId as Id<"chats">)) };
    });
    // File part + the delegation MARKER copied; the ordinary tool part NOT.
    const kinds = state.parts
      .map((p) => (p.part.kind === "tool" ? p.part.name : p.part.kind))
      .sort();
    expect(kinds).toEqual(["file", "sessions_spawn"]);
    // The files invariant holds in the fork: a paired row exists for the copy,
    // carrying the source row's origin (a pasted-guard file stays hidden).
    expect(state.forkChatRows.length).toBe(1);
    expect(state.forkChatRows[0]!.origin).toBe("pasted");
  });

  test("the rolling summary rides ONLY when its watermark stays within the branch point", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, ids } = await seedChat(t, { messages: 5 });
    const orders = await t.run(async (ctx) => {
      const msgs = await Promise.all(ids.map((id) => ctx.db.get(id)));
      return msgs.map((m) => effectiveOrder(m!));
    });
    // Summary covering up to message 1 (BEFORE the branch at 3) → must ride.
    await t.run(async (ctx) => {
      await ctx.db.insert("chatSummaries", {
        chatId,
        summary: "Résumé des débuts.",
        watermarkOrderTime: orders[1]!,
        coveredCount: 2,
        updatedAt: 1,
        failureCount: 0,
        nextEligibleAt: 0,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { chatId: fork1 } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[3]!,
    });
    const carried = await t.run((ctx) =>
      ctx.db
        .query("chatSummaries")
        .withIndex("by_chat", (q) => q.eq("chatId", fork1 as Id<"chats">))
        .first(),
    );
    expect(carried?.summary).toBe("Résumé des débuts.");
    expect(carried?.failureCount).toBe(0);

    // Now a summary whose watermark covers message 4 (AFTER a branch at 1) →
    // must NOT ride (it would leak later turns into the fork's agent context).
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("chatSummaries")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .first();
      await ctx.db.patch(row!._id, { watermarkOrderTime: orders[4]! });
    });
    const { chatId: fork2 } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[1]!,
    });
    const leaked = await t.run((ctx) =>
      ctx.db
        .query("chatSummaries")
        .withIndex("by_chat", (q) => q.eq("chatId", fork2 as Id<"chats">))
        .first(),
    );
    expect(leaked).toBeNull();
  });

  test("a chat longer than the cap forks the NEWEST window before the branch point", async () => {
    const t = convexTest(schema, modules);
    const { userId, ids } = await seedChat(t, { messages: FORK_MESSAGE_CAP + 20 });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const branchIdx = ids.length - 1;
    const { chatId: forkId } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[branchIdx]!,
    });
    const msgs = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", forkId as Id<"chats">))
        .collect(),
    );
    expect(msgs.length).toBe(FORK_MESSAGE_CAP);
    // The NEWEST window is kept (the oldest 20 dropped): the last copied text is
    // the branch message, the first is msg-20.
    const ordered = [...msgs].sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
    expect(ordered[0]!.text).toBe("msg-20");
    expect(ordered[ordered.length - 1]!.text).toBe(`msg-${branchIdx}`);
  });

  test("streaming (in-flight) messages never ride into the fork", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, ids } = await seedChat(t, { messages: 3 });
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 2000,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    // Branch from the last terminal ASSISTANT reply; the streaming row is later
    // anyway, but even a streaming row BEFORE the branch would be skipped.
    const { chatId: forkId } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[1]!,
    });
    const msgs = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", forkId as Id<"chats">))
        .collect(),
    );
    expect(msgs.every((m) => m.status !== "streaming")).toBe(true);
    expect(msgs.length).toBe(2); // msgs 0..1 — the streaming row never rides
  });

  test("a MULTI-AGENT source keeps per-message attribution + routing state, but never the live session segment", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, ids } = await seedChat(t, { messages: 3 });
    await t.run(async (ctx) => {
      // Source is a per-turn-routed chat whose CURRENT last agent postdates
      // the branch point (the user kept routing after the reply we branch
      // from) — the fork must derive from the COPIED slice, never from this.
      await ctx.db.patch(chatId, {
        perTurnRouting: true,
        lastRoutedInstanceName: "prod",
        lastRoutedAgentId: "late-specialist",
        routingSegment: "turn:abc123", // the LIVE gateway session segment
        // Describes the LATE agent's session — must not ride into the fork.
        sessionMeta: { model: "late-model", contextTokens: 8000 },
      });
      // The copied assistant reply was routed to a specialist.
      await ctx.db.patch(ids[1]!, {
        routedInstanceName: "prod",
        routedAgentId: "specialist",
      });
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { chatId: forkId } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[1]!,
    });
    const state = await t.run(async (ctx) => {
      const fork = await ctx.db.get(forkId as Id<"chats">);
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", forkId as Id<"chats">))
        .collect();
      return { fork, msgs };
    });
    // Chat-level routing state rides (the composer defaults to the same agent,
    // switch detection stays correct)...
    expect(state.fork!.perTurnRouting).toBe(true);
    expect(state.fork!.lastRoutedAgentId).toBe("specialist");
    expect(state.fork!.lastRoutedInstanceName).toBe("prod");
    // ...but NEVER the live segment: sharing it would make the fork resume the
    // ORIGINAL chat's gateway session (context bleed between the two threads).
    expect(state.fork!.routingSegment).toBeUndefined();
    // Nor the session meta: on a multi-agent source it describes whichever
    // agent spoke LAST (possibly after the branch), not the branch's agent.
    expect(state.fork!.sessionMeta).toBeUndefined();
    // Per-message attribution rides (the agent chip on copied replies).
    const copiedReply = state.msgs.find((m) => m.text === "msg-1")!;
    expect(copiedReply.routedAgentId).toBe("specialist");
    expect(copiedReply.routedInstanceName).toBe("prod");
  });

  test("the read window is ANCHORED at the branch point: an old branch in a long chat copies ITS past, never a head-window slice", async () => {
    const t = convexTest(schema, modules);
    // Far more messages AFTER the branch point than the read bound: a take
    // from the chat HEAD would either miss the branch or amputate its history.
    const { userId, ids } = await seedChat(t, {
      messages: FORK_MESSAGE_CAP * 2 + 10,
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { chatId: forkId } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[1]!, // the OLDEST assistant reply
    });
    const msgs = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", forkId as Id<"chats">))
        .collect(),
    );
    const ordered = [...msgs].sort((a, b) => effectiveOrder(a) - effectiveOrder(b));
    // Exactly the branch point's own past: msg-0 + msg-1, nothing later.
    expect(ordered.map((m) => m.text)).toEqual(["msg-0", "msg-1"]);
  });

  test("a USER message never seeds a fork (a queued row's sentinel orderTime would corrupt the copy order)", async () => {
    const t = convexTest(schema, modules);
    const { userId, ids } = await seedChat(t, { messages: 3 });
    const as = t.withIdentity({ subject: `${userId}|session` });
    // ids[0] is a COMPLETE user message — status alone does not qualify it:
    // only settled ASSISTANT replies are valid branch points (server-enforced;
    // the UI offers the action nowhere else).
    await expect(
      as.mutation(api.chatFork.forkChat, { branchMessageId: ids[0]! }),
    ).rejects.toThrow(/bad_branch_point/);
  });

  test("the one-shot rehydration flag is consumed at the gateway ACK (dispatch), NOT by message terminals", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, ids } = await seedChat(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { chatId: forkId } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[1]!,
    });
    // (t.run serializes undefined -> null on return; normalize to a boolean.)
    const flag = () =>
      t.run(async (ctx) => {
        const fork = await ctx.db.get(forkId as Id<"chats">);
        return fork!.forkPendingRehydration === true;
      });

    // A message terminal must NOT consume it: a Hermes WS submit-failure
    // finalizes an error row though nothing was delivered (the retry still
    // needs the signal), and the stuck-stream watchdog terminates rows without
    // stream.finalize at all — terminals over/under-approximate delivery.
    const failedMsg = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: forkId as Id<"chats">,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 1,
      }),
    );
    await t.mutation(internal.stream.finalize, {
      messageId: failedMsg,
      status: "error" as const,
      error: "boom",
    });
    expect(await flag()).toBe(true);

    // The gateway ACK is the acceptance point: the dispatch calls
    // consumeForkRehydration only then (and only for a no-attachment turn).
    await t.mutation(internal.bridge.consumeForkRehydration, {
      chatId: forkId as Id<"chats">,
    });
    expect(await flag()).toBe(false);
  });

  test("TERMINAL sub-agent result cards ride re-keyed (a delegated turn's answer survives); running ones don't", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, ids } = await seedChat(t, { messages: 3 });
    await t.run(async (ctx) => {
      // The delegated reply settled EMPTY — its visible answer lives in the
      // subAgents row (AssistantEmptyState correlates by parentMessageId).
      await ctx.db.patch(ids[1]!, { text: "" });
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: ids[1]!,
        childSessionKey: "agent:main:subagent:u1",
        taskName: "recherche",
        status: "done" as const,
        resultText: "Voici les 10 actualités demandées.",
        createdAt: 1,
        updatedAt: 1,
      });
      // A child still RUNNING at fork time must NOT ride: no observer will
      // ever settle the copy (it would show "waiting" forever in the fork).
      await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId: ids[1]!,
        childSessionKey: "agent:main:subagent:u2",
        status: "running" as const,
        createdAt: 2,
        updatedAt: 2,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { chatId: forkId } = await as.mutation(api.chatFork.forkChat, {
      branchMessageId: ids[1]!,
    });
    const state = await t.run(async (ctx) => {
      const copiedReply = (
        await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) => q.eq("chatId", forkId as Id<"chats">))
          .collect()
      ).find((m) => m.role === "assistant" && m.text === "")!;
      const rows = await ctx.db
        .query("subAgents")
        .withIndex("by_chat", (q) => q.eq("chatId", forkId as Id<"chats">))
        .collect();
      return { copiedReply, rows };
    });
    expect(state.rows.length).toBe(1);
    expect(state.rows[0]!.status).toBe("done");
    expect(state.rows[0]!.resultText).toBe("Voici les 10 actualités demandées.");
    // Re-keyed to the COPY — the fork's empty bubble correlates and renders
    // the child's result instead of a blank "generic" card.
    expect(state.rows[0]!.parentMessageId).toBe(state.copiedReply._id);
    // The GLOBAL childSessionKey is never duplicated (by_child is one-row-per-
    // key: a reused key would let a late update of the real child patch the
    // copy). The fork prefix keeps the parsed TAIL intact.
    expect(state.rows[0]!.childSessionKey).toBe(
      `fork:${forkId}:agent:main:subagent:u1`,
    );
  });

  test("a branch point still STREAMING is refused (no silent one-message-early fork)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t);
    const streamingId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 2000,
      }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` });
    await expect(
      as.mutation(api.chatFork.forkChat, { branchMessageId: streamingId }),
    ).rejects.toThrow(/bad_branch_point/);
  });
});
