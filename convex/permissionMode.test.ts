/// <reference types="vite/client" />
//
// THE CONVERSATION'S EXECUTION-PERMISSION CHOICE (convex/permissionMode.ts).
//
// The owner chooses, `full` only as an Atrium administrator; everyone in the room sees
// the choice; it is applied at once (bridge /permission-mode) with every outcome
// recorded, and every later turn carries it to the bridge, which applies it to that
// turn's session and guards the send with it — so Convex sends no meta-derived guard
// then (it would describe the session BEFORE the choice and refuse the very turn).

import { readFileSync } from "node:fs";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { MAX_REAPPLIES_PER_REVISION, readPermissionModeResponse } from "./permissionMode";
import {
  dispatchPermissionChoice,
  permissionChoiceRefusal,
} from "./lib/permissionMode";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function seed(
  t: T,
  opts: {
    ownerRole?: "user" | "admin";
    kind?: "openclaw" | "hermes";
    guestRole?: "user" | "admin";
    /** Atrium manages execution permissions on the instance (default: yes). */
    managed?: boolean;
    /** The bridge's compat snapshot for the instance: declaring `permissionModes`
     *  (default), declaring other capabilities only, or no snapshot at all. */
    compat?: "confirmed" | "lacking" | "none";
  } = {},
) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: owner,
      role: opts.ownerRole ?? "user",
      canonical: "owner",
      name: "owner",
      email: "owner@example.com",
    });
    const guest = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: guest,
      role: opts.guestRole ?? "user",
      canonical: "guest",
      name: "guest",
      email: "guest@example.com",
    });
    await ctx.db.insert("instances", {
      name: "alpha",
      gatewayUrl: "ws://gw",
      ...(opts.kind === "hermes" ? { kind: "hermes" as const } : {}),
      ...(opts.managed === false ? {} : { managePermissionModes: true }),
    });
    if ((opts.compat ?? "confirmed") !== "none") {
      await ctx.db.insert("bridgeCompat", {
        key: "singleton",
        reachable: true,
        bridgeVersion: "0.85.1",
        protocolVersion: 2,
        compat: null,
        fetchedAt: Date.now(),
        targets: [
          {
            instanceName: "alpha",
            provider: opts.kind === "hermes" ? "hermes" : "openclaw",
            gatewayVersion: "2026.9.6",
            capabilities:
              opts.compat === "lacking"
                ? { knobModel: true }
                : { knobModel: true, permissionModes: true },
            versionBeyondValidated: false,
          },
        ],
      });
    }
    await ctx.db.insert("agents", {
      instanceName: "alpha",
      agentId: "alice",
      displayName: "Alice",
      enabled: true,
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
      defaultPermissionMode: "full",
    });
    const chatId = await ctx.db.insert("chats", {
      userId: owner,
      updatedAt: 1,
      instanceName: "alpha",
      agentId: "alice",
      sessionMeta: {
        permissionMode: "workspace",
        permissionModePending: false,
        visibility: "shared",
        accessAt: 10,
      },
    });
    await ctx.db.insert("chatParticipants", {
      chatId,
      userId: guest,
      role: "member",
      addedBy: owner,
      addedAt: 1,
    } as never);
    return { owner, guest, chatId };
  });
}

function fakeBridge(answer: (path: string, body: Record<string, unknown>) => Response) {
  const prevUrl = process.env.BRIDGE_URL;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_URL = "http://bridge.test";
  process.env.BRIDGE_SHARED_SECRET = "s3cret";
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = new URL(String(input)).pathname;
    calls.push({ path, body });
    return answer(path, body);
  });
  return {
    calls,
    restore: () => {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    },
  };
}

/** The chat's current choice revision. */
const rev = async (t: T, chatId: Id<"chats">) =>
  (await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeRevision ?? 0;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("who may choose", () => {
  test("the rule itself", () => {
    const r = (choice: "guarded" | "full" | "default", isOwner: boolean, isAdmin: boolean, anyManaged = true) =>
      permissionChoiceRefusal({ choice, isOwner, isAdmin, anyManaged });
    expect(r("guarded", false, true)).toBe("not_owner");
    expect(r("full", true, false)).toBe("full_requires_admin");
    expect(r("full", true, true)).toBeNull();
    // "default" is the operator's own configuration — always allowed, even when it is full.
    expect(r("default", true, false)).toBeNull();
    // Nothing to choose where the gateway's operator manages permissions — admins included.
    expect(r("guarded", true, true, false)).toBe("not_managed");
  });

  test("the owner chooses; the choice is stored pending and applied at once", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, {
      chatId,
      mode: "read-only",
    });
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.permissionModeChoice).toBe("read-only");
    expect(chat?.permissionModeApply).toMatchObject({ mode: "read-only", status: "pending" });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((s) => s.name)).toContain("permissionMode:dispatchPermissionMode");
  });

  test("a participant cannot choose — not even a room member who is an administrator", async () => {
    const t = convexTest(schema, modules);
    const { guest, chatId } = await seed(t, { guestRole: "admin" });
    await expect(
      t.withIdentity({ subject: guest }).mutation(api.permissionMode.setPermissionMode, {
        chatId,
        mode: "guarded",
      }),
    ).rejects.toThrow(/Forbidden/);
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.permissionModeChoice).toBeUndefined();
  });

  test("full: refused to a non-admin owner, allowed to an admin owner", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await expect(
      t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, { chatId, mode: "full" }),
    ).rejects.toThrow(/full_requires_admin/);
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2, { ownerRole: "admin" });
    await t2
      .withIdentity({ subject: s2.owner })
      .mutation(api.permissionMode.setPermissionMode, { chatId: s2.chatId, mode: "full" });
    expect((await t2.run((ctx) => ctx.db.get(s2.chatId)))?.permissionModeChoice).toBe("full");
  });
});

describe("what every reader sees", () => {
  test("the participant sees the owner's choice and the agent's default, and cannot pick full", async () => {
    const t = convexTest(schema, modules);
    const { owner, guest, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, {
      chatId,
      mode: "guarded",
    });
    const seen = await t.withIdentity({ subject: guest }).query(api.permissionMode.permissionControl, { chatId });
    expect(seen).toMatchObject({
      viewerRole: "participant",
      viewerIsAdmin: false,
      choice: "guarded",
      agentDefault: "full",
    });
    expect(seen.apply?.status).toBe("pending");
  });
});

describe("applied at once, every outcome recorded", () => {
  const choose = async (
    t: T,
    owner: Id<"users">,
    chatId: Id<"chats">,
    mode: "default" | "read-only" | "guarded" | "workspace" | "full",
  ) => {
    await t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, { chatId, mode });
    await t.action(internal.permissionMode.dispatchPermissionMode, { chatId, userId: owner, mode, revision: await rev(t, chatId) });
    return (await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply;
  };

  test("applied: the bridge is asked with the routing and the choice, full never authorized for a non-admin", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const bridge = fakeBridge(() => json(200, { ok: true, result: "applied", mode: "guarded" }));
    try {
      const apply = await choose(t, owner, chatId, "guarded");
      expect(apply).toMatchObject({ mode: "guarded", status: "applied" });
      const call = bridge.calls.find((c) => c.path === "/permission-mode");
      expect(call?.body).toMatchObject({
        chatId,
        instanceName: "alpha",
        agentId: "alice",
        choice: "guarded",
        fullAuthorized: false,
      });
    } finally {
      bridge.restore();
    }
  });

  test("an admin owner's full is authorized to the bridge", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { ownerRole: "admin" });
    const bridge = fakeBridge(() => json(200, { ok: true, result: "applied", mode: "full" }));
    try {
      await choose(t, owner, chatId, "full");
      expect(bridge.calls.find((c) => c.path === "/permission-mode")?.body).toMatchObject({
        choice: "full",
        fullAuthorized: true,
      });
    } finally {
      bridge.restore();
    }
  });

  test("a refusal is recorded with its reason — never shown as applied", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const bridge = fakeBridge(() =>
      json(409, { ok: false, error: { code: "permission_mode_not_applied", reason: "active_run" } }),
    );
    try {
      expect(await choose(t, owner, chatId, "read-only")).toMatchObject({
        mode: "read-only",
        status: "failed",
        reason: "active_run",
      });
    } finally {
      bridge.restore();
    }
  });

  test("an unreachable bridge is recorded as such", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const prev = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    process.env.BRIDGE_URL = "http://bridge.test";
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    try {
      expect(await choose(t, owner, chatId, "guarded")).toMatchObject({ status: "failed", reason: "bridge_unreachable" });
    } finally {
      vi.unstubAllGlobals();
      if (prev === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prev;
      delete process.env.BRIDGE_URL;
    }
  });

  test("a Hermes session is not asked anything: the choice waits for an OpenClaw one", async () => {
    const t = convexTest(schema, modules);
    // A conversation that only reaches Hermes has nothing to choose…
    const th = convexTest(schema, modules);
    const h = await seed(th, { kind: "hermes" });
    await expect(
      th.withIdentity({ subject: h.owner }).mutation(api.permissionMode.setPermissionMode, { chatId: h.chatId, mode: "guarded" }),
    ).rejects.toThrow(/not_managed/);
    // …and when the session the next turn uses is a Hermes one (the room moved on), the
    // choice waits for the next OpenClaw session.
    const { owner, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" });
    await t.run(async (ctx) => {
      const inst = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "alpha")).first();
      await ctx.db.patch(inst!._id, { kind: "hermes" });
    });
    const bridge = fakeBridge(() => json(200, { ok: true }));
    try {
      await t.action(internal.permissionMode.dispatchPermissionMode, { chatId, userId: owner, mode: "guarded", revision: await rev(t, chatId) });
      expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply).toMatchObject({
        status: "deferred",
        reason: "not_openclaw",
      });
      expect(bridge.calls.filter((c) => c.path === "/permission-mode")).toEqual([]);
    } finally {
      bridge.restore();
    }
  });

  test("an outcome for an older choice never overwrites the current one's", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" });
    await t.mutation(internal.permissionMode.recordPermissionModeApply, {
      chatId,
      revision: 0,
      mode: "read-only",
      status: "failed",
      reason: "rejected",
    });
    expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply).toMatchObject({
      mode: "guarded",
      status: "pending",
    });
  });

  test("the bridge's answers, read — with what each says about the GATEWAY", async () => {
    expect(await readPermissionModeResponse(json(200, { ok: true, result: "unchanged" }))).toEqual({
      status: "applied",
      effect: "applied",
    });
    expect(await readPermissionModeResponse(json(200, { ok: true, result: "deferred" }))).toEqual({
      status: "deferred",
      effect: "none",
    });
    expect(
      await readPermissionModeResponse(json(200, { ok: true, result: "applied", savedNotApplied: true })),
    ).toEqual({ status: "applied", reason: "saved_not_applied", effect: "applied" });
    // Refused BEFORE any patch: definitely nothing changed.
    expect(await readPermissionModeResponse(json(409, { ok: false, error: { code: "instance_not_served" } }))).toEqual({
      status: "failed",
      reason: "instance_not_served",
      effect: "none",
    });
    for (const reason of ["scope_refused", "active_run", "rejected", "not_managed", "session_not_established", "unsupported_gateway", "full_not_authorized"]) {
      expect(
        (await readPermissionModeResponse(json(409, { ok: false, error: { code: "permission_mode_not_applied", reason } })))
          .effect,
      ).toBe("none");
    }
    // A 5xx says nothing about the gateway.
    expect(await readPermissionModeResponse(new Response("boom", { status: 502 }))).toEqual({
      status: "failed",
      reason: "bridge_error",
      effect: "uncertain",
    });
    expect(
      (await readPermissionModeResponse(json(502, { ok: false, error: { code: "upstream_failed" } }))).effect,
    ).toBe("uncertain");
  });
});

describe("every turn carries the choice, and no meta-derived guard", () => {
  test("the dispatch rule", () => {
    const d = (
      choice: "guarded" | "full" | undefined,
      provider: string,
      managed: boolean,
      ownerIsAdmin: boolean,
    ) => dispatchPermissionChoice({ choice, provider, managed, ownerIsAdmin });
    // Managed: an absent choice IS "default" — enforced like any choice.
    expect(d(undefined, "openclaw", true, true)).toEqual({ choice: "default", fullAuthorized: false });
    // Not managed: nothing applied, whatever is stored.
    expect(d("guarded", "openclaw", false, true)).toBeNull();
    expect(d(undefined, "openclaw", false, true)).toBeNull();
    expect(d("guarded", "hermes", true, true)).toBeNull();
    expect(d("full", "openclaw", true, false)).toEqual({ choice: "full", fullAuthorized: false });
    expect(d("full", "openclaw", true, true)).toEqual({ choice: "full", fullAuthorized: true });
  });

  const sendOnce = async (t: T, owner: Id<"users">, chatId: Id<"chats">) => {
    const sends: Array<Record<string, unknown>> = [];
    const bridge = fakeBridge((path, body) => {
      if (path === "/send") sends.push(body);
      return json(200, { ok: true });
    });
    try {
      const { outboxId } = await t.withIdentity({ subject: owner }).mutation(api.send.sendMessage, {
        chatId,
        text: "bonjour",
        clientMessageId: `c-${sends.length}-${Math.random()}`,
      });
      await t.action(internal.bridge.dispatch, { outboxId });
    } finally {
      bridge.restore();
    }
    return sends[0];
  };

  test("managed, nothing chosen: the conversation's choice is 'default', enforced, no meta guard", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const send = await sendOnce(t, owner, chatId);
    expect(send?.permissionModeChoice).toBe("default");
    expect(send?.permissionModesManaged).toBe(true);
    expect(send && "expectedPermissionMode" in send).toBe(false);
  });

  test("NOT managed: exactly as before the lot — the meta's mode rides as the guard, nothing applied, even with a stored choice", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { managed: false });
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "read-only" }));
    const send = await sendOnce(t, owner, chatId);
    expect(send?.expectedPermissionMode).toBe("workspace");
    expect(send && "permissionModeChoice" in send).toBe(false);
    expect(send && "permissionModesManaged" in send).toBe(false);
  });

  test("the flag is re-read at every dispatch: switched off, the next turn applies nothing", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "guarded" }));
    expect((await sendOnce(t, owner, chatId))?.permissionModeChoice).toBe("guarded");
    await t.run(async (ctx) => {
      const inst = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "alpha")).first();
      await ctx.db.patch(inst!._id, { managePermissionModes: undefined });
    });
    const after = await sendOnce(t, owner, chatId);
    expect(after && "permissionModeChoice" in after).toBe(false);
  });

  test("a choice: carried for the bridge to apply, and the stale meta guard is NOT sent", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "read-only" }));
    const send = await sendOnce(t, owner, chatId);
    expect(send?.permissionModeChoice).toBe("read-only");
    expect(send && "expectedPermissionMode" in send).toBe(false);
    expect(send && "permissionModeFullAuthorized" in send).toBe(false);
  });

  test("full is re-authorized on the owner's role AT DISPATCH", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { ownerRole: "admin" });
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "full" }));
    expect((await sendOnce(t, owner, chatId))?.permissionModeFullAuthorized).toBe(true);
    // The owner is no longer an administrator: the stored `full` is not authorized any
    // more — the bridge refuses the turn by name rather than running it under full.
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", owner))
        .unique();
      await ctx.db.patch(p!._id, { role: "user" });
    });
    const after = await sendOnce(t, owner, chatId);
    expect(after?.permissionModeChoice).toBe("full");
    expect(after && "permissionModeFullAuthorized" in after).toBe(false);
  });

  test("a target KNOWN not to take modes (an older bridge): the turn is refused by name, never POSTed", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { compat: "lacking" });
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "read-only" }));
    const send = await sendOnce(t, owner, chatId);
    expect(send).toBeUndefined();
    const failed = await t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).filter(
        (m) => m.errorCode === "permission_mode_not_applied",
      ),
    );
    expect(failed.length).toBeGreaterThan(0);
  });

  test("…but 'default' still goes (it asks nothing of the gateway), and a declaring target takes any choice", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { compat: "lacking" });
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "default" }));
    expect((await sendOnce(t, owner, chatId))?.permissionModeChoice).toBe("default");
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2);
    await t2.run((ctx) => ctx.db.patch(s2.chatId, { permissionModeChoice: "guarded" }));
    expect((await sendOnce(t2, s2.owner, s2.chatId))?.permissionModeChoice).toBe("guarded");
  });

  test("the on-the-spot apply on such a target is recorded as unsupported, not as a bridge error", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { compat: "lacking" });
    const bridge = fakeBridge(() => json(404, { ok: false, error: "not found" }));
    try {
      await t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" });
      await t.action(internal.permissionMode.dispatchPermissionMode, { chatId, userId: owner, mode: "guarded", revision: await rev(t, chatId) });
      expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply).toMatchObject({
        status: "failed",
        reason: "unsupported_gateway",
      });
      expect(bridge.calls.filter((c) => c.path === "/permission-mode")).toEqual([]);
    } finally {
      bridge.restore();
    }
  });

});

describe("an instance whose operator manages permissions", () => {
  test("the owner — even an administrator — cannot choose: not_managed", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { managed: false, ownerRole: "admin" });
    await expect(
      t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" }),
    ).rejects.toThrow(/not_managed/);
  });

  test("every reader is told the next target is not managed", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { managed: false });
    const seen = await t.withIdentity({ subject: owner }).query(api.permissionMode.permissionControl, { chatId });
    expect([seen.managed, seen.anyManaged]).toEqual([false, false]);
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2);
    const on = await t2.withIdentity({ subject: s2.owner }).query(api.permissionMode.permissionControl, { chatId: s2.chatId });
    expect([on.managed, on.anyManaged]).toEqual([true, true]);
  });

  test("the on-the-spot apply is never POSTed there: deferred, not_managed", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" });
    await t.run(async (ctx) => {
      const inst = await ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "alpha")).first();
      await ctx.db.patch(inst!._id, { managePermissionModes: undefined });
    });
    const bridge = fakeBridge(() => json(200, { ok: true, result: "applied" }));
    try {
      await t.action(internal.permissionMode.dispatchPermissionMode, { chatId, userId: owner, mode: "guarded", revision: await rev(t, chatId) });
      expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply).toMatchObject({
        status: "deferred",
        reason: "not_managed",
      });
      expect(bridge.calls.filter((c) => c.path === "/permission-mode")).toEqual([]);
    } finally {
      bridge.restore();
    }
  });

  test("the admin setting: on persists, omitted clears to off (the safe side); admins only", async () => {
    const t = convexTest(schema, modules);
    const { owner, guest } = await seed(t, { ownerRole: "admin", managed: false });
    const inst = await t.run((ctx) => ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "alpha")).first());
    const base = { instanceId: inst!._id, name: "alpha", gatewayUrl: "ws://gw" };
    await t.withIdentity({ subject: owner }).mutation(api.admin.upsertInstance, { ...base, managePermissionModes: true });
    expect((await t.run((ctx) => ctx.db.get(inst!._id)))?.managePermissionModes).toBe(true);
    await t.withIdentity({ subject: owner }).mutation(api.admin.upsertInstance, base);
    expect((await t.run((ctx) => ctx.db.get(inst!._id)))?.managePermissionModes).toBeUndefined();
    await expect(
      t.withIdentity({ subject: guest }).mutation(api.admin.upsertInstance, { ...base, managePermissionModes: true }),
    ).rejects.toThrow(/admin/);
  });
});

// Codex review (2026-09-27), P1: a non-default choice was refused only when a snapshot
// EXPLICITLY lacked `permissionModes` — with NO snapshot (a fresh deployment, a rolling
// deploy) an older bridge ignored the new fields and ran the turn under the gateway's
// mode. Now POSITIVE confirmation is required.
describe("a choice rides only to a bridge CONFIRMED to take it", () => {
  const sendVia = async (t: T, owner: Id<"users">, chatId: Id<"chats">) => {
    const sends: Array<Record<string, unknown>> = [];
    const bridge = fakeBridge((path, body) => {
      if (path === "/send") sends.push(body);
      return json(200, { ok: true });
    });
    try {
      const { outboxId } = await t.withIdentity({ subject: owner }).mutation(api.send.sendMessage, {
        chatId,
        text: "bonjour",
        clientMessageId: `c-${Math.random()}`,
      });
      await t.action(internal.bridge.dispatch, { outboxId });
    } finally {
      bridge.restore();
    }
    const failed = await t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).some(
        (m) => m.errorCode === "permission_mode_not_applied",
      ),
    );
    return { send: sends[0], failed };
  };

  test("no snapshot at all + a non-default choice: refused by name, never POSTed", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { compat: "none" });
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "read-only" }));
    const r = await sendVia(t, owner, chatId);
    expect(r.send).toBeUndefined();
    expect(r.failed).toBe(true);
  });

  test("no snapshot + nothing chosen (= default): sent WITH the meta guard, so an older bridge keeps the pre-lot protection", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { compat: "none" });
    const r = await sendVia(t, owner, chatId);
    expect(r.send?.permissionModeChoice).toBe("default");
    expect(r.send?.expectedPermissionMode).toBe("workspace");
  });

  test("confirmed + default: the bridge guards with what it applies — no meta guard", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const r = await sendVia(t, owner, chatId);
    expect(r.send?.permissionModeChoice).toBe("default");
    expect(r.send && "expectedPermissionMode" in r.send).toBe(false);
  });

  test("the on-the-spot apply is not POSTed to an unconfirmed bridge either", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { compat: "none" });
    const bridge = fakeBridge(() => json(200, { ok: true, result: "applied" }));
    try {
      await t.withIdentity({ subject: owner }).mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" });
      await t.action(internal.permissionMode.dispatchPermissionMode, { chatId, userId: owner, mode: "guarded", revision: await rev(t, chatId) });
      expect(bridge.calls.filter((c) => c.path === "/permission-mode")).toEqual([]);
      expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply).toMatchObject({ status: "failed" });
    } finally {
      bridge.restore();
    }
  });
});

// Codex review (2026-09-27), P2: two on-the-spot applies raced — the older one could
// land LAST and leave the session under the older mode while the newer read "applied".
describe("choice revisions", () => {
  test("each choice bumps the revision; its apply carries it", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { ownerRole: "admin" });
    const as = t.withIdentity({ subject: owner });
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "full" });
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "read-only" });
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.permissionModeRevision).toBe(2);
    expect(chat?.permissionModeApply).toMatchObject({ mode: "read-only", revision: 2, status: "pending" });
  });

  test("an OLDER apply that changed the gateway after the newer one: dropped, and the newer choice is applied again", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { ownerRole: "admin" });
    const as = t.withIdentity({ subject: owner });
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "full" }); // rev 1
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "read-only" }); // rev 2
    // rev 2 applied first…
    await t.mutation(internal.permissionMode.recordPermissionModeApply, { chatId, mode: "read-only", revision: 2, status: "applied" });
    const before = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length;
    // …then rev 1's "full" lands LAST.
    await t.mutation(internal.permissionMode.recordPermissionModeApply, { chatId, mode: "full", revision: 1, status: "applied" });
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.permissionModeApply).toMatchObject({ mode: "read-only", revision: 2, status: "pending" });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.length).toBe(before + 1);
    expect(scheduled[scheduled.length - 1]?.name).toBe("permissionMode:dispatchPermissionMode");
    expect(scheduled[scheduled.length - 1]?.args[0]).toMatchObject({ mode: "read-only", revision: 2 });
  });

  test("an older apply that did NOT change the gateway is simply dropped", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const as = t.withIdentity({ subject: owner });
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" }); // rev 1
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "read-only" }); // rev 2
    const before = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length;
    await t.mutation(internal.permissionMode.recordPermissionModeApply, { chatId, mode: "guarded", revision: 1, status: "failed", reason: "rejected" });
    expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply).toMatchObject({ mode: "read-only", status: "pending" });
    expect((await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).length).toBe(before);
  });

  test("a superseded dispatch never POSTs", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const as = t.withIdentity({ subject: owner });
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" }); // rev 1
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "read-only" }); // rev 2
    const bridge = fakeBridge(() => json(200, { ok: true, result: "applied" }));
    try {
      await t.action(internal.permissionMode.dispatchPermissionMode, { chatId, userId: owner, mode: "guarded", revision: 1 });
      expect(bridge.calls.filter((c) => c.path === "/permission-mode")).toEqual([]);
    } finally {
      bridge.restore();
    }
  });
});

// Codex review (2026-09-27), P2: the owner's role was read once in getChatRouting and
// that value rode the send — a demotion (or a new choice) before the POST still sent
// the older decision. The last gate (the transaction that stamps the send) decides.
describe("the last gate decides what rides", () => {
  const pendingRow = async (t: T, owner: Id<"users">, chatId: Id<"chats">) =>
    (
      await t.withIdentity({ subject: owner }).mutation(api.send.sendMessage, {
        chatId,
        text: "bonjour",
        clientMessageId: `g-${Math.random()}`,
      })
    ).outboxId;
  const gate = (t: T, outboxId: Id<"outbox">) =>
    t.mutation(internal.bridge.lastGateBeforeSend, {
      outboxId,
      target: { instanceName: "alpha", agentId: "alice" },
    });

  test("the owner's role and the choice are read at the gate", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { ownerRole: "admin" });
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "full" }));
    const outboxId = await pendingRow(t, owner, chatId);
    const first = await gate(t, outboxId);
    expect(first.kind === "send" && first.permission.choice).toEqual({ choice: "full", fullAuthorized: true });
    // Demoted before the POST: the gate says so.
    await t.run(async (ctx) => {
      const p = await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", owner)).unique();
      await ctx.db.patch(p!._id, { role: "user" });
    });
    await t.run((ctx) => ctx.db.patch(outboxId, { sentToInstance: undefined }));
    const second = await gate(t, outboxId);
    expect(second.kind === "send" && second.permission.choice).toEqual({ choice: "full", fullAuthorized: false });
    // A new choice before the POST: the gate carries it.
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "read-only" }));
    const third = await gate(t, outboxId);
    expect(third.kind === "send" && third.permission.choice?.choice).toBe("read-only");
  });

  test("an unconfirmed bridge with a non-default choice is refused AT the gate, before the send is stamped", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { compat: "none" });
    await t.run((ctx) => ctx.db.patch(chatId, { permissionModeChoice: "guarded" }));
    const outboxId = await pendingRow(t, owner, chatId);
    expect((await gate(t, outboxId)).kind).toBe("permission_refused");
    expect((await t.run((ctx) => ctx.db.get(outboxId)))?.sentToInstance).toBeUndefined();
  });
});

describe("the /send body is built from the gate's decision (source pin, comment-stripped)", () => {
  const src = readFileSync(new URL("./bridge.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  test("choice, authorization and guard come from `gate.permission`", () => {
    expect(src).toMatch(/const permissionChoice = gate\.permission\.choice;/);
    expect(src).toMatch(/gate\.permission\.choice === null \|\| gate\.permission\.withMetaGuard/);
    expect(src).toMatch(/permissionModeChoice: permissionChoice\.choice,/);
    expect(src).not.toMatch(/routing\.permission\.choice/);
  });
});

// Codex pass 4 (2026-09-27): an OLDER apply whose answer is UNCERTAIN (a 5xx, a transport
// failure after the POST left) may still have changed the gateway after a newer choice
// was applied — it was dropped as a mere failure.
describe("a stale apply whose effect on the gateway is uncertain", () => {
  const twoChoices = async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const as = t.withIdentity({ subject: owner });
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" }); // rev 1
    await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "read-only" }); // rev 2
    await t.mutation(internal.permissionMode.recordPermissionModeApply, { chatId, mode: "read-only", revision: 2, status: "applied" });
    return { t, owner, chatId };
  };
  const scheduledCount = (t: T) =>
    t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);

  test("the older apply answering 502 after the newer one was applied: the current choice is re-applied", async () => {
    const { t, owner, chatId } = await twoChoices();
    const before = await scheduledCount(t);
    const bridge = fakeBridge(() => new Response("boom", { status: 502 }));
    try {
      // The older dispatch reached its POST before the newer choice (simulated: its
      // outcome is recorded through the same path the action uses).
      await t.mutation(internal.permissionMode.recordPermissionModeApply, {
        chatId,
        mode: "guarded",
        revision: 1,
        status: "failed",
        reason: "bridge_error",
        uncertain: true,
      });
    } finally {
      bridge.restore();
    }
    expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply).toMatchObject({
      mode: "read-only",
      revision: 2,
      status: "pending",
      repairs: 1,
    });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.length).toBe(before + 1);
    expect(scheduled[scheduled.length - 1]?.args[0]).toMatchObject({ mode: "read-only", revision: 2 });
    void owner;
  });

  test("end to end: a newer choice lands while the older POST is in flight, the older answers 502 or never answers ⇒ re-applied", async () => {
    for (const failure of ["502", "transport"] as const) {
      const t = convexTest(schema, modules);
      const { owner, chatId } = await seed(t);
      const as = t.withIdentity({ subject: owner });
      await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "guarded" }); // rev 1
      const bridge = fakeBridge(() => new Response("unused", { status: 500 }));
      // The older POST is in flight when the owner picks again; then it fails uncertainly.
      vi.stubGlobal("fetch", async () => {
        await as.mutation(api.permissionMode.setPermissionMode, { chatId, mode: "read-only" }); // rev 2
        if (failure === "transport") throw new TypeError("socket hang up");
        return new Response("boom", { status: 502 });
      });
      try {
        await t.action(internal.permissionMode.dispatchPermissionMode, { chatId, userId: owner, mode: "guarded", revision: 1 });
      } finally {
        bridge.restore();
      }
      expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply, failure).toMatchObject({
        mode: "read-only",
        revision: 2,
        status: "pending",
        repairs: 1,
      });
    }
  });

  test("an older apply refused DEFINITELY (before any patch) is simply dropped", async () => {
    const { t, chatId } = await twoChoices();
    const before = await scheduledCount(t);
    await t.mutation(internal.permissionMode.recordPermissionModeApply, {
      chatId,
      mode: "guarded",
      revision: 1,
      status: "failed",
      reason: "active_run",
    });
    expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply).toMatchObject({
      mode: "read-only",
      status: "applied",
    });
    expect(await scheduledCount(t)).toBe(before);
  });

  test("bounded: past MAX_REAPPLIES_PER_REVISION the current choice is shown failed, nothing more scheduled", async () => {
    const { t, chatId } = await twoChoices();
    for (let i = 0; i < MAX_REAPPLIES_PER_REVISION; i++) {
      await t.mutation(internal.permissionMode.recordPermissionModeApply, {
        chatId, mode: "guarded", revision: 1, status: "failed", reason: "bridge_error", uncertain: true,
      });
    }
    const before = await scheduledCount(t);
    await t.mutation(internal.permissionMode.recordPermissionModeApply, {
      chatId, mode: "guarded", revision: 1, status: "applied",
    });
    expect(await scheduledCount(t)).toBe(before);
    expect((await t.run((ctx) => ctx.db.get(chatId)))?.permissionModeApply).toMatchObject({
      revision: 2,
      status: "failed",
      reason: "reapply_exhausted",
      repairs: MAX_REAPPLIES_PER_REVISION,
    });
  });
});

