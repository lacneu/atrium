/// <reference types="vite/client" />
//
// NON-INTERACTIVE instance provisioning (POST /api/v1/instances/provision).
//
// Driven THROUGH THE HTTP BOUNDARY with a real minted API key, never by calling
// the action directly. That is deliberate: the route is where the payload is
// validated, kind-discriminated and assembled, and a suite that starts at the
// action would pass while the route silently dropped a field on the way in —
// exactly the defect that shipped in 0.71.8, where fixtures inserted a field by
// hand that the ingest path was discarding.
//
// What is pinned here is the pair of contracts the feature is sold on:
//   - REPLAY-SAFETY, because the caller is a control plane that retries on
//     timeout: a second call must not fork the routing key, must not rotate a
//     secret the installed bridge is using, and must report that it changed
//     nothing;
//   - PARITY with a hand-created instance: provisioning grants NOTHING, so a new
//     entity's gateway stays invisible until an admin curates it. Ungranted users
//     fall into the default-allow all-pool, so a single stray `enabled: true`
//     would expose the new instance company-wide.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { hashKey } from "./lib/apikeys";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const PROVISION_KEY = "oc_test_provisioner_key";
const READONLY_KEY = "oc_test_observer_key";

/** Seed two service accounts: one that may provision, one that may not. */
async function seed(t: TestConvex<typeof schema>) {
  const provisionHash = await hashKey(PROVISION_KEY);
  const observerHash = await hashKey(READONLY_KEY);
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
    const mk = async (roleKey: string, hashedKey: string) => {
      const serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: `svc-${roleKey}`,
        roleKey,
        disabled: false,
        createdByUserId: admin,
      });
      await ctx.db.insert("apiKeys", {
        serviceAccountId,
        hashedKey,
        prefix: `oc_test_${roleKey}`,
        lastFour: "key1",
        disabled: false,
        createdAt: Date.now(),
      });
      return serviceAccountId;
    };
    await mk("provisioner", provisionHash);
    await mk("observer", observerHash);
    return { admin };
  });
}

type ProvisionBody = Record<string, unknown>;
type ProvisionResponse = {
  ok: boolean;
  error?: string;
  instance?: string;
  outcome?: "created" | "updated" | "unchanged";
  bridgeSecret?: "minted" | "rotated" | "existing";
  secret?: string;
};

async function provision(
  t: TestConvex<typeof schema>,
  body: ProvisionBody,
  key: string = PROVISION_KEY,
): Promise<{ status: number; json: ProvisionResponse }> {
  const res = await t.fetch("/api/v1/instances/provision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as ProvisionResponse };
}

const OPENCLAW: ProvisionBody = {
  name: "compta",
  gatewayUrl: "ws://compta.internal",
  kind: "openclaw",
};

const instances = (t: TestConvex<typeof schema>) =>
  t.run((ctx) => ctx.db.query("instances").collect());

/** Does this plaintext still authenticate as a bridge? */
const resolves = async (t: TestConvex<typeof schema>, plaintext: string) => {
  const hash = await hashKey(plaintext);
  const row = await t.run((ctx) =>
    ctx.runQuery(internal.bridgeAuth.resolveBridgeInstanceBySecretHash, { hash }),
  );
  return row !== null;
};

describe("provisioning is replay-safe", () => {
  test("a retried create patches by NAME instead of forking the routing key", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const first = await provision(t, OPENCLAW);
    expect(first.status).toBe(200);
    expect(first.json.outcome).toBe("created");

    // The control plane's HTTP client timed out and retried the same payload.
    const second = await provision(t, OPENCLAW);
    expect(second.status).toBe(200);
    expect(second.json.outcome).toBe("unchanged");

    // ONE row. `name` is the routing key that agents, userAgents, chats and
    // instanceDiscovery all reference — two rows sharing it would have the script
    // configure one while the bridge routes to the other.
    const rows = await instances(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("compta");
  });

  test("a replay does NOT rotate the secret the installed bridge is using", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const first = await provision(t, OPENCLAW);
    expect(first.json.bridgeSecret).toBe("minted");
    const plaintext = first.json.secret;
    expect(typeof plaintext).toBe("string");
    expect(await resolves(t, plaintext!)).toBe(true);

    const second = await provision(t, OPENCLAW);
    expect(second.json.bridgeSecret).toBe("existing");
    // No plaintext on a replay: only the hash is stored, so there is nothing
    // truthful to return — and the installed bridge already holds it.
    expect(second.json.secret).toBeUndefined();
    // The decisive assertion: the FIRST secret must still authenticate. A mint on
    // replay would have deleted it and locked the bridge out of its own gateway.
    expect(await resolves(t, plaintext!)).toBe(true);
  });

  test("rotation happens ONLY when asked for explicitly, and invalidates the old secret", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const first = await provision(t, OPENCLAW);
    const old = first.json.secret!;

    const rotated = await provision(t, {
      ...OPENCLAW,
      rotateBridgeSecret: true,
    });
    expect(rotated.json.bridgeSecret).toBe("rotated");
    expect(typeof rotated.json.secret).toBe("string");
    expect(rotated.json.secret).not.toBe(old);
    // One active secret per instance: the previous one must stop resolving,
    // otherwise "rotation" would leave a second working credential behind.
    expect(await resolves(t, old)).toBe(false);
    expect(await resolves(t, rotated.json.secret!)).toBe(true);
  });

  test("an unchanged replay does not even touch the row", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);
    const before = (await instances(t))[0]!;

    await provision(t, OPENCLAW);
    const after = (await instances(t))[0]!;
    // Same document, untouched. The qualification criterion is a second pass with
    // NO persistent change — a patch that rewrites identical values still bumps
    // the row and would show up as a change in any diff taken against it.
    expect(after._id).toBe(before._id);
    expect(after).toEqual(before);
  });
});

describe("provisioning grants nothing", () => {
  test("no agent, no user access and no group access are created", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);

    const granted = await t.run(async (ctx) => ({
      agents: await ctx.db.query("agents").collect(),
      userAgents: await ctx.db.query("userAgents").collect(),
      groupAgents: await ctx.db.query("groupAgents").collect(),
    }));
    // Parity with a hand-created instance. Ungranted users fall into the
    // default-allow all-pool (agents.ts: `direct.length > 0 ? direct :
    // allPoolKeys`), gated only by `enabled` — so a single row written here would
    // expose a new entity's gateway to everyone who has no grant of their own.
    expect(granted.agents).toEqual([]);
    expect(granted.userAgents).toEqual([]);
    expect(granted.groupAgents).toEqual([]);
  });
});

describe("the permission is the gate", () => {
  test("a key without instances.provision is refused and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const res = await provision(t, OPENCLAW, READONLY_KEY);
    expect(res.status).toBe(403);
    expect(await instances(t)).toEqual([]);
  });

  test("an unauthenticated call is refused", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await t.fetch("/api/v1/instances/provision", {
      method: "POST",
      body: JSON.stringify(OPENCLAW),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await instances(t)).toEqual([]);
  });
});

describe("a pre-existing duplicate name is refused, never silently resolved", () => {
  test("two rows sharing a name yield 409 rather than patching whichever sorts first", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "twin", gatewayUrl: "ws://a" });
      await ctx.db.insert("instances", { name: "twin", gatewayUrl: "ws://b" });
    });

    const res = await provision(t, { name: "twin", gatewayUrl: "ws://c" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("instance_name_ambiguous");
    // Neither row was touched — a guess here is worse than a refusal.
    const rows = await instances(t);
    expect(rows.map((r) => r.gatewayUrl).sort()).toEqual(["ws://a", "ws://b"]);
  });
});

describe("partial payloads never wipe what an admin set", () => {
  test("an omitted field is LEFT ALONE and an explicit null CLEARS it", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, { ...OPENCLAW, gatewayHttpUrl: "http://media" });

    // The control plane replays without the field it never manages.
    const replay = await provision(t, OPENCLAW);
    expect(replay.json.outcome).toBe("unchanged");
    expect((await instances(t))[0]!.gatewayHttpUrl).toBe("http://media");

    // Only an EXPLICIT null unsets it — the caller saying so, not omitting it.
    const cleared = await provision(t, { ...OPENCLAW, gatewayHttpUrl: null });
    expect(cleared.json.outcome).toBe("updated");
    expect((await instances(t))[0]!.gatewayHttpUrl).toBeUndefined();
  });

  test("admin-owned settings survive a provisioning replay", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);
    const id = (await instances(t))[0]!._id as Id<"instances">;
    // Things the admin UI owns and provisioning must never roll back.
    await t.run((ctx) =>
      ctx.db.patch(id, { streamTransport: "sse", defaultAgentId: "chosen" }),
    );

    await provision(t, { ...OPENCLAW, displayName: "Comptabilité" });
    const row = (await instances(t))[0]!;
    expect(row.streamTransport).toBe("sse");
    expect(row.defaultAgentId).toBe("chosen");
    expect(row.displayName).toBe("Comptabilité");
  });
});

describe("the payload is kind-discriminated", () => {
  test("a Hermes instance takes its transport", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await provision(t, {
      name: "hermes-rh",
      gatewayUrl: "ws://rh",
      kind: "hermes",
      transport: "rest",
    });
    expect(res.status).toBe(200);
    const row = (await instances(t))[0]!;
    expect(row.kind).toBe("hermes");
    expect(row.transport).toBe("rest");
  });

  test("a field that does not apply to the kind is REFUSED, not ignored", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // The schema says `transport` is ignored for OpenClaw. Accepting it would let
    // a control plane believe a setting took effect when nothing reads it.
    const wrongTransport = await provision(t, { ...OPENCLAW, transport: "ws" });
    expect(wrongTransport.status).toBe(400);
    // Symmetrically, the gateway-version/media overrides are OpenClaw's.
    const wrongVersion = await provision(t, {
      name: "hermes-rh",
      gatewayUrl: "ws://rh",
      kind: "hermes",
      gatewayVersion: "2026.7.1",
    });
    expect(wrongVersion.status).toBe(400);
    expect(await instances(t)).toEqual([]);
  });

  test("an unknown kind is refused", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await provision(t, { ...OPENCLAW, kind: "gemini" });
    expect(res.status).toBe(400);
    expect(await instances(t)).toEqual([]);
  });
});

describe("the routing key is validated where it can still be fixed", () => {
  test("a malformed name is refused at CREATE", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await provision(t, { ...OPENCLAW, name: "bad name/../x" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_instance_name");
    expect(await instances(t)).toEqual([]);
  });

  test("but an instance that ALREADY carries a legacy name stays updatable", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "legacy name", gatewayUrl: "ws://old" }),
    );
    // Rejecting it here would strand an instance created before the rule existed:
    // the name cannot be changed (it is the routing key), so the script could
    // never manage it again.
    const res = await provision(t, {
      name: "legacy name",
      gatewayUrl: "ws://new",
    });
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe("updated");
    expect((await instances(t))[0]!.gatewayUrl).toBe("ws://new");
  });
});

describe("a minted secret stays attributable", () => {
  test("the service principal is recorded on the bridgeAuth row", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);
    const row = (await t.run((ctx) => ctx.db.query("bridgeAuth").collect()))[0]!;
    // `auditLog` cannot hold this — it requires two Id<"users"> and an API key has
    // no user identity. Without this field a minted bridge secret, which unlocks
    // an instance's encrypted gateway credentials, would have no owner at all.
    expect(row.createdByPrincipal).toBeTruthy();
    expect(row.createdBy).toBeUndefined();
  });
});
