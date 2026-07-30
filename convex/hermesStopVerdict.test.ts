/// <reference types="vite/client" />
//
// A Stop the provider did NOT honour must not leave the session resumable (lot 45 —
// G-41, and the deferral recorded as "un Stop pendant le silence laisse la session
// jamais déclarée non fiable").
//
// The measurement, read from the restored upstream (v2026.7.20):
//
//   * Atrium's REST transport streams a turn through
//     `POST /api/sessions/{id}/chat/stream`. That handler mints its own
//     `run_id = f"run_{uuid4().hex}"` (api_server.py:2534) and registers it NOWHERE —
//     the task goes into `_background_tasks`, never into `_active_run_agents` /
//     `_active_run_tasks`, which are written only by `POST /v1/runs` (:4926).
//   * `POST /v1/runs/{run_id}/stop` looks the run up in exactly those two maps and
//     404s `run_not_found` when both miss (:5285-5289). So on THIS transport the
//     server-side stop is a GUARANTEED 404 — not a flaky one.
//   * Nor can a disconnect stand in for it: the handler passes no `agent_ref`, so
//     nothing can reach `agent.interrupt()` (the mechanism its siblings
//     `/v1/chat/completions` and `/v1/responses` DO wire, :3155), and
//     `_run_agent` runs `run_conversation` in a THREAD EXECUTOR, which
//     `task.cancel()` cannot stop.
//   * The agent therefore runs to completion and `agent/turn_finalizer.py:322`
//     persists the turn — "on any exit path" in its own words — into the SQLite
//     transcript that `_conversation_history_for_session` reads back on the NEXT turn.
//
// The user-visible harm is the last link: after a Stop, the next turn inherits a
// reply the user never saw and believes was cancelled. THAT is what these tests pin —
// the consequence, not the verdict function.
//
// One rule, three names. `interrupted` keeps the binding; anything else drops it. The
// three names exist so a trace can tell the structural REST case (`ineffective`) from
// the rare live-socket WS case (`unknown`) afterwards, not because they behave
// differently.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const SESSION = "api_1783351043_b99e6df2";

/** A chat BOUND to a provider session, with a streaming assistant turn on it — the
 *  world a user Stop lands in. */
async function seedStreamingTurn(t: ReturnType<typeof convexTest>): Promise<{
  chatId: Id<"chats">;
  userId: Id<"users">;
  messageId: Id<"messages">;
}> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user", canonical: "alice" });
    await ctx.db.insert("userAgents", {
      userId,
      instanceName: "primary",
      agentId: "main",
      isDefault: true,
      source: "manual" as const,
      createdAt: 0,
    });
    const now = Date.now();
    const chatId = await ctx.db.insert("chats", {
      userId,
      archived: false,
      updatedAt: now,
      openclawChatId: SESSION,
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId: "run_abc",
      updatedAt: now,
    });
    return { chatId, userId, messageId };
  });
}

/** Drive the REAL abort action with a bridge that answers `body`.
 *
 *  The bodies below are the shape produced by `hermesAbortResponseBody`
 *  (bridge/src/providers/hermes/dispatch.ts), whose own test pins these key names as this
 *  reader's contract — the boundary a rename would break silently. */
async function stopWith(
  body: Record<string, unknown>,
  seeded: { chatId: Id<"chats">; userId: Id<"users">; messageId: Id<"messages"> },
  t: ReturnType<typeof convexTest>,
): Promise<void> {
  vi.stubGlobal(
    "fetch",
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
  await t.action(internal.bridge.dispatchAbort, {
    chatId: seeded.chatId,
    userId: seeded.userId,
    runId: "run_abc",
    finalizeMessageId: seeded.messageId,
  });
}

const bindingOf = (t: ReturnType<typeof convexTest>, chatId: Id<"chats">) =>
  t.run(async (ctx) => (await ctx.db.get(chatId))?.openclawChatId ?? null);

describe("a Stop the provider did not honour drops the session", () => {
  const prev = { url: process.env.BRIDGE_URL, secret: process.env.BRIDGE_SHARED_SECRET };
  beforeEach(() => {
    process.env.BRIDGE_URL = "http://127.0.0.1:8787";
    process.env.BRIDGE_SHARED_SECRET = "x";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prev.url === undefined) delete process.env.BRIDGE_URL;
    else process.env.BRIDGE_URL = prev.url;
    if (prev.secret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
    else process.env.BRIDGE_SHARED_SECRET = prev.secret;
  });

  test("`ineffective` — the next turn cannot resume the tainted session", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedStreamingTurn(t);
    await stopWith(
      { ok: true, aborted: true, interrupt: "ineffective", providerSession: SESSION },
      seeded,
      t,
    );
    // The binding is what the next dispatch reads to decide whether to resume. Emptied,
    // it mints a fresh session and carries Convex's own history instead — the record of
    // what the user ACTUALLY saw, which cannot contain the phantom reply.
    expect(
      await bindingOf(t, seeded.chatId),
      "a session whose run was never stopped must not be resumable",
    ).toBeNull();
    // …and the bubble still settles aborted: the user asked to stop.
    const msg = await t.run((ctx) => ctx.db.get(seeded.messageId));
    expect(msg?.status).toBe("aborted");
  });

  test("`unknown` drops it too — not knowing is not a reason to resume", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedStreamingTurn(t);
    await stopWith(
      { ok: true, aborted: true, interrupt: "unknown", providerSession: SESSION },
      seeded,
      t,
    );
    expect(await bindingOf(t, seeded.chatId)).toBeNull();
  });

  test("`interrupted` KEEPS the binding — the drop is not unconditional", async () => {
    // Without this, "always drop" would pass the suite identically to "drop when the
    // stop failed", and the REST 404 being a CONSTANT means no other test can tell
    // them apart.
    const t = convexTest(schema, modules);
    const seeded = await seedStreamingTurn(t);
    await stopWith(
      { ok: true, aborted: true, interrupt: "interrupted", providerSession: SESSION },
      seeded,
      t,
    );
    expect(
      await bindingOf(t, seeded.chatId),
      "a confirmed interrupt leaves the conversation exactly where it was",
    ).toBe(SESSION);
  });

  test("a bridge that reports NO verdict changes nothing (rolling deploy)", async () => {
    // An older bridge answers `{ok:true, aborted:true}`. Absent is not "failed": the
    // clear must stay opt-in, or the first deploy of this lot would drop the session of
    // every Stop served by a not-yet-updated bridge.
    const t = convexTest(schema, modules);
    const seeded = await seedStreamingTurn(t);
    await stopWith({ ok: true, aborted: true }, seeded, t);
    expect(await bindingOf(t, seeded.chatId)).toBe(SESSION);
  });

  test("the verdict names the session the BRIDGE held, and a mismatch is refused", async () => {
    // `dispatchAbort` reads routing BEFORE the /abort round-trip, and a WS turn can
    // rotate its session in that window (the tail `session.info`, lot 36). So the id
    // comes from the bridge — what it actually tried to interrupt — and the clear only
    // fires when the chat is still bound to it.
    const t = convexTest(schema, modules);
    const seeded = await seedStreamingTurn(t);
    await stopWith(
      {
        ok: true,
        aborted: true,
        interrupt: "ineffective",
        providerSession: "api_9999999999_deadbeef", // a session this chat is not on
      },
      seeded,
      t,
    );
    expect(
      await bindingOf(t, seeded.chatId),
      "clearing a binding this turn never held would cut a turn that is working",
    ).toBe(SESSION);
  });
});
