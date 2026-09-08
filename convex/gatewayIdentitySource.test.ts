/// <reference types="vite/client" />
//
// WHICH STRING names a person to their gateway, per instance.
//
// A deployment can put an identity proxy in front of the SAME gateway an Atrium
// bridge talks to (Authelia, Keycloak, Authentik). The proxy names people the way
// it knows them — their address — while Atrium has always named them by its own
// stable key. A gateway profile is keyed by that exact string, so the same human
// arrives as TWO profiles: one when they open the gateway's Control UI, one when
// they write in a conversation. `instances.identitySource` lets an operator make
// the two agree, per instance, because a community's deployments are not alike.
//
// Two properties are pinned here, and the second is the one with teeth:
//
//   1. the value is derived from the INSTANCE's stated posture, never guessed;
//   2. EVERY door that opens a person's socket derives it the same way. A door
//      that forgot would name the same person differently depending on which
//      request happened to open the socket first — compact before send, and their
//      gateway profile changes. That is the `mentions` defect's shape (a body
//      rebuilt field by field), and the reason the derivation is one function.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const CHILD = "agent:main:subagent:ix-identity";

type Posture = {
  authMode?: "token" | "trusted-proxy";
  identitySource?: "canonical" | "email";
  /** The address on the `users` row — rewritten by the auth library on every
   *  sign-in, so this is what the provider says TODAY. */
  email?: string;
  /** The address frozen on `profiles` — what an administrator sees, filled once. */
  profileEmail?: string;
};

/** A routable chat on an instance with the given posture. */
async function world(t: ReturnType<typeof convexTest>, posture: Posture) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("instances", {
      name: "primary",
      gatewayUrl: "wss://gw.example.org",
      ...(posture.authMode ? { authMode: posture.authMode } : {}),
      ...(posture.identitySource
        ? { identitySource: posture.identitySource }
        : {}),
    });
    const userId = await ctx.db.insert("users", {
      ...(posture.email ? { email: posture.email } : {}),
    });
    const stored = posture.profileEmail ?? posture.email;
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u-olivier",
      ...(stored ? { email: stored } : {}),
    });
    await ctx.db.insert("userAgents", {
      userId,
      instanceName: "primary",
      agentId: "main",
      isDefault: true,
      source: "manual" as const,
      createdAt: 0,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      archived: false,
      updatedAt: Date.now(),
      instanceName: "primary",
    });
    await ctx.db.insert("subAgents", {
      chatId,
      childSessionKey: CHILD,
      status: "done" as const,
      createdAt: 0,
      updatedAt: 0,
    });
    return { userId: userId as Id<"users">, chatId: chatId as Id<"chats"> };
  });
}

/** What the DISPATCH door names this person. */
async function dispatchName(
  t: ReturnType<typeof convexTest>,
  ids: { userId: Id<"users">; chatId: Id<"chats"> },
) {
  const routing = await t.query(internal.bridge.getChatRouting, {
    chatId: ids.chatId,
    userId: ids.userId,
  });
  return routing?.gatewayUser;
}

/** What the SUB-AGENT INTERACTION door names the same person. */
async function subAgentName(
  t: ReturnType<typeof convexTest>,
  ids: { userId: Id<"users">; chatId: Id<"chats"> },
) {
  const prep = await t
    .withIdentity({ subject: `${ids.userId}|session` })
    .mutation(internal.subAgentInteractions.prepareInteraction, {
      chatId: ids.chatId,
      childSessionKey: CHILD,
      userText: "keep going",
    });
  return (prep.routing as { gatewayUser?: string }).gatewayUser;
}

describe("the name is the instance's stated posture", () => {
  test("a token instance names nobody differently — the body is unchanged", async () => {
    // Every deployment that has not asked for any of this. The absence is the
    // point: the send body is byte-identical to the one that shipped before.
    const t = convexTest(schema, modules);
    const ids = await world(t, { email: "olivier@example.org" });
    expect(await dispatchName(t, ids)).toBeUndefined();
  });

  test("trusted proxy alone still names by the Atrium key (the default)", async () => {
    const t = convexTest(schema, modules);
    const ids = await world(t, {
      authMode: "trusted-proxy",
      email: "olivier@example.org",
    });
    expect(await dispatchName(t, ids)).toBeUndefined();
  });

  test("asked for the address, the address is what the gateway is told", async () => {
    const t = convexTest(schema, modules);
    const ids = await world(t, {
      authMode: "trusted-proxy",
      identitySource: "email",
      email: "olivier@example.org",
    });
    expect(await dispatchName(t, ids)).toBe("olivier@example.org");
  });

  test("asked for the address of a profile that has none, names the key", async () => {
    // Never nobody: a connection that names no one is refused by the gateway
    // (`trusted_proxy_user_missing`), which would take the conversation with it.
    const t = convexTest(schema, modules);
    const ids = await world(t, {
      authMode: "trusted-proxy",
      identitySource: "email",
    });
    expect(await dispatchName(t, ids)).toBe("u-olivier");
  });
});

describe("every door that opens a person's socket agrees", () => {
  test("the sub-agent door names them exactly as the dispatch door does", async () => {
    // Both acquire the OWNER's socket on the bridge. Disagreeing here does not
    // fail anything loudly — it silently gives one human two gateway profiles,
    // and which one they get depends on what they did first.
    const t = convexTest(schema, modules);
    const ids = await world(t, {
      authMode: "trusted-proxy",
      identitySource: "email",
      email: "olivier@example.org",
    });
    // ONE interaction: the door refuses a second while one is pending.
    const viaSubAgent = await subAgentName(t, ids);
    expect(viaSubAgent).toBe(await dispatchName(t, ids));
    expect(viaSubAgent).toBe("olivier@example.org");
  });

  test("…and both stay silent on an instance that asked for nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await world(t, { email: "olivier@example.org" });
    expect(await subAgentName(t, ids)).toBeUndefined();
    expect(await dispatchName(t, ids)).toBeUndefined();
  });
});

describe("the address is the one the provider states today", () => {
  test("a changed address is what the gateway is told, not the frozen copy", async () => {
    // `ensureProfile` fills `profiles.email` only when MISSING and never overwrites
    // it, while the auth library rewrites the `users` row from the provider's claims
    // on every sign-in. Someone who changed their address therefore has two values
    // on file. Reading the frozen one would hand the gateway a name the proxy in
    // front of it no longer injects — two profiles again, for exactly the people
    // whose name changed, and nothing would say so.
    const t = convexTest(schema, modules);
    const ids = await world(t, {
      authMode: "trusted-proxy",
      identitySource: "email",
      email: "olivier.new@example.org",
      profileEmail: "olivier.old@example.org",
    });
    expect(await dispatchName(t, ids)).toBe("olivier.new@example.org");
  });

  test("the two sources cannot disagree — both are normalized", async () => {
    // The provider normalizes what it writes to the `users` row; the profile copy
    // keeps whatever its issuer stated, because it is a display value. Emitting one
    // or the other raw would make the same person's name depend on which copy
    // happened to be available.
    const t = convexTest(schema, modules);
    const viaProfile = await world(t, {
      authMode: "trusted-proxy",
      identitySource: "email",
      profileEmail: "  Olivier@Example.ORG ",
    });
    expect(await dispatchName(t, viaProfile)).toBe("olivier@example.org");
  });

  test("falls back to the stored copy when the users row carries none", async () => {
    // The development sign-in creates identities with no address at all, and a row
    // written before the provider stated one keeps only the profile copy.
    const t = convexTest(schema, modules);
    const ids = await world(t, {
      authMode: "trusted-proxy",
      identitySource: "email",
      profileEmail: "olivier.only@example.org",
    });
    expect(await dispatchName(t, ids)).toBe("olivier.only@example.org");
  });
});

describe("an edit that does not mention the naming must not undo it", () => {
  // `admin.upsertInstance` rebuilds the row field by field, and Convex DELETES a
  // field patched with `undefined`. A caller that predates this argument — an older
  // client, a provisioning script — would therefore reset the instance to the Atrium
  // key and hand every person the second gateway profile the setting exists to
  // merge. No error, no log: the deployment simply stops converging.
  async function adminOn(t: ReturnType<typeof convexTest>) {
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "admin" as const,
        canonical: "u-admin",
      });
      return uid;
    });
    return t.withIdentity({ subject: `${userId}|session` });
  }

  test("omitting identitySource PRESERVES it", async () => {
    const t = convexTest(schema, modules);
    const as = await adminOn(t);
    const instanceId = await t.run((ctx) =>
      ctx.db.insert("instances", {
        name: "primary",
        gatewayUrl: "wss://gw.example.org",
        authMode: "trusted-proxy" as const,
        identitySource: "email" as const,
      }),
    );
    // An edit of something else entirely, from a caller that says nothing about it.
    await as.mutation(api.admin.upsertInstance, {
      instanceId,
      name: "primary",
      gatewayUrl: "wss://gw.example.org",
      displayName: "Primary",
      authMode: "trusted-proxy" as const,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(instanceId)))?.identitySource,
    ).toBe("email");
  });

  test("…and \"canonical\" is still the way to ask for the key back", async () => {
    // Preserving must not make the setting one-way: the explicit value has to work.
    const t = convexTest(schema, modules);
    const as = await adminOn(t);
    const instanceId = await t.run((ctx) =>
      ctx.db.insert("instances", {
        name: "primary",
        gatewayUrl: "wss://gw.example.org",
        authMode: "trusted-proxy" as const,
        identitySource: "email" as const,
      }),
    );
    await as.mutation(api.admin.upsertInstance, {
      instanceId,
      name: "primary",
      gatewayUrl: "wss://gw.example.org",
      authMode: "trusted-proxy" as const,
      identitySource: "canonical" as const,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(instanceId)))?.identitySource,
    ).toBe("canonical");
  });
});

describe("the upgrade step is performable by the person told to perform it", () => {
  // MEASURED, 2026-09-08: `npx convex run admin:backfillProfileEmailLower '{}'` —
  // the command the release documented as mandatory — answers
  // "Unauthorized: authentication required", because `npx convex run` establishes no
  // signed-in app user while the mutation calls requireAdmin. An operator following
  // the procedure to the letter could not perform it, and the failure it prevents
  // (a second account per person) is silent.
  //
  // The CLI entry point is internal: the Convex CLI carries the deployment key, which
  // is what authorizes an internal function. Pinned here as a NON-authenticated call
  // succeeding, so re-gating it turns this red instead of only breaking a terminal.
  test("the CLI entry point runs without a signed-in user", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "u-someone",
        email: "Someone@Example.ORG",
      });
    });
    const res = await t.mutation(
      internal.admin.backfillProfileEmailLowerCli,
      {},
    );
    expect(res).toMatchObject({ updated: 1, isDone: true });
    // …and it did the work: the normalized key the duplicate guard reads.
    expect(
      (await t.run((ctx) => ctx.db.query("profiles").first()))?.emailLower,
    ).toBe("someone@example.org");
  });

  test("the in-app entry point still refuses a non-administrator", async () => {
    // The CLI door must not have opened the in-app one.
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "u-someone",
      });
      return uid;
    });
    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .mutation(api.admin.backfillProfileEmailLower, {}),
    ).rejects.toThrow();
  });
});
