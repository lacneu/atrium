/// <reference types="vite/client" />
//
// Instance deletion at SCALE, and its resumption.
//
// The cascade used to run entirely in the mutation that deleted the instance:
// unbounded `.collect()` over agents and grants, then a further read of every
// affected user's remaining grants. Small instances succeeded and large ones
// failed durably against Convex's per-transaction limits — the exact instances a
// control plane most needs to remove.
//
// What is pinned here is the split that fixed it, and its edges:
//   - CREDENTIALS are never deferred. The encrypted gateway secrets and the
//     per-bridge auth secret go in the SAME transaction as the instance row,
//     because an instance reported deleted whose bridge secret still resolves is
//     a security failure rather than a throughput one.
//   - everything name-bound is swept in bounded batches that reschedule.
//   - a dropped chain is recoverable: the job row is the evidence, and the reaper
//     re-arms it.

import { readFileSync } from "node:fs";

import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hashKey } from "./lib/apikeys";
import { CASCADE_TUNING } from "./lib/instanceCascade";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const PROVISION_KEY = "oc_test_cascade_provisioner";
const NAME = "bigco";

async function seed(t: TestConvex<typeof schema>) {
  const provisionHash = await hashKey(PROVISION_KEY);
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
    const serviceAccountId = await ctx.db.insert("serviceAccounts", {
      name: "svc-provisioner",
      roleKey: "provisioner",
      disabled: false,
      createdByUserId: admin,
    });
    await ctx.db.insert("apiKeys", {
      serviceAccountId,
      hashedKey: provisionHash,
      prefix: "oc_test_cascade",
      lastFour: "test",
      disabled: false,
      createdAt: Date.now(),
    });
    return admin;
  });
}

/** An instance far larger than one sweep batch, with grants on TWO instances so
 *  the default re-election has somewhere to land. */
async function seedLargeInstance(
  t: TestConvex<typeof schema>,
  agentCount: number,
  userCount: number,
): Promise<{ instanceId: Id<"instances">; users: Id<"users">[] }> {
  return await t.run(async (ctx) => {
    const instanceId = await ctx.db.insert("instances", {
      name: NAME,
      gatewayUrl: "ws://bigco",
    });
    await ctx.db.insert("instances", {
      name: "survivor",
      gatewayUrl: "ws://survivor",
    });
    await ctx.db.insert("instanceDiscovery", {
      instanceName: NAME,
      lastPollAt: Date.now(),
      lastPollOk: true,
      lastOkAt: Date.now(),
    });
    for (let i = 0; i < agentCount; i += 1) {
      await ctx.db.insert("agents", {
        instanceName: NAME,
        agentId: `agent-${i}`,
        source: "discovered",
        presentInLastOk: true,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        enabled: true,
      });
    }
    const users: Id<"users">[] = [];
    for (let u = 0; u < userCount; u += 1) {
      const userId = await ctx.db.insert("users", {});
      users.push(userId);
      // The grant that will DISAPPEAR, and which carried the default.
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: NAME,
        agentId: "agent-0",
        isDefault: true,
        source: "manual",
        createdAt: Date.now(),
      });
      // A grant on another instance, which must inherit the default.
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "survivor",
        agentId: "keeper",
        isDefault: false,
        source: "manual",
        createdAt: Date.now(),
      });
    }
    return { instanceId, users };
  });
}

const deprovision = (t: TestConvex<typeof schema>) =>
  t.fetch("/api/v1/instances/deprovision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PROVISION_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: NAME }),
  });

const countFor = async (t: TestConvex<typeof schema>, name: string) =>
  await t.run(async (ctx) => ({
    instances: (await ctx.db.query("instances").collect()).filter(
      (row) => row.name === name,
    ).length,
    agents: (await ctx.db.query("agents").collect()).filter(
      (row) => row.instanceName === name,
    ).length,
    userAgents: (await ctx.db.query("userAgents").collect()).filter(
      (row) => row.instanceName === name,
    ).length,
    discovery: (await ctx.db.query("instanceDiscovery").collect()).filter(
      (row) => row.instanceName === name,
    ).length,
    secrets: (await ctx.db.query("instanceSecrets").collect()).length,
    bridgeAuth: (await ctx.db.query("bridgeAuth").collect()).length,
    jobs: (await ctx.db.query("instanceCascades").collect()).length,
  }));

/**
 * Let the REAL scheduler drain the chain.
 *
 * An earlier version of this helper called the sweep in a loop itself. That drove
 * the passes by hand, so it proved the batching converged but said NOTHING about
 * the chain re-arming — removing the `scheduler.runAfter` left every assertion
 * green. Running the scheduler is the only way the self-rescheduling contract is
 * actually observed.
 */
async function drain(t: TestConvex<typeof schema>): Promise<void> {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("instance deletion at scale", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  test("CREDENTIALS go with the instance row, in the very first transaction", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { instanceId } = await seedLargeInstance(
      t,
      CASCADE_TUNING.CASCADE_BATCH * 2,
      CASCADE_TUNING.REELECT_BATCH * 2,
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("instanceSecrets", {
        instanceId,
        field: "token",
        secret: { v: 1, alg: "a", keyRef: "k", iv: "i", ciphertext: "c" },
        source: "provisioner",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("bridgeAuth", {
        instanceId,
        hashedSecret: "hash",
        prefix: "p",
        lastFour: "l",
        createdAt: Date.now(),
      });
    });

    const response = await deprovision(t);
    expect(response.status).toBe(200);

    // BEFORE draining anything: the instance is unreachable and no credential
    // survives. Deferring either would leave a window where a stale bridge secret
    // still resolves to an instance the caller was told is gone.
    const immediately = await countFor(t, NAME);
    expect(immediately.instances).toBe(0);
    expect(immediately.secrets).toBe(0);
    expect(immediately.bridgeAuth).toBe(0);
    // And the unbounded remainder is deliberately still there, with a job to prove
    // it is owed rather than forgotten.
    expect(immediately.agents).toBeGreaterThan(0);
    expect(immediately.jobs).toBe(1);
  });

  test("an instance far larger than one batch is removed COMPLETELY", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { users } = await seedLargeInstance(
      t,
      CASCADE_TUNING.CASCADE_BATCH * 2 + 7,
      CASCADE_TUNING.REELECT_BATCH * 3 + 3,
    );

    await deprovision(t);
    // Nothing has swept yet: the first transaction only removed the instance and
    // its credentials, which is what makes several scheduled passes necessary.
    const midway = await countFor(t, NAME);
    expect(midway.agents).toBeGreaterThan(CASCADE_TUNING.CASCADE_BATCH);
    expect(midway.jobs).toBe(1);

    await drain(t);

    const after = await countFor(t, NAME);
    expect(after).toMatchObject({
      instances: 0,
      agents: 0,
      userAgents: 0,
      discovery: 0,
      jobs: 0,
    });

    // Every user keeps exactly one default, on the instance that survived. Losing
    // the default is how a user ends up with agents they cannot dispatch to.
    const defaults = await t.run(async (ctx) =>
      Promise.all(
        users.map(async (userId) => {
          const rows = (await ctx.db.query("userAgents").collect()).filter(
            (row) => row.userId === userId,
          );
          return {
            total: rows.length,
            defaults: rows.filter((row) => row.isDefault === true).length,
            instances: rows.map((row) => row.instanceName),
          };
        }),
      ),
    );
    for (const entry of defaults) {
      expect(entry.total).toBe(1);
      expect(entry.defaults).toBe(1);
      expect(entry.instances).toEqual(["survivor"]);
    }
  });

  test("a dropped chain is re-armed by the reaper, and a live one is left alone", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await seedLargeInstance(t, CASCADE_TUNING.CASCADE_BATCH + 1, 2);
    await deprovision(t);

    // The scheduled chain dies here (a pass that throws is NOT retried by the
    // scheduler). Without a durable job row the remaining grants would point at an
    // instance that no longer exists, for ever.
    const stillOwed = await countFor(t, NAME);
    expect(stillOwed.jobs).toBe(1);
    expect(stillOwed.agents).toBeGreaterThan(0);

    // A job that just made progress must NOT be re-armed: two chains for one name
    // would double the work and race each other.
    expect(
      await t.run((ctx) =>
        ctx.runMutation(internal.instanceCascade.reapStalledCascades, {}),
      ),
    ).toBe(0);

    // Age it past the staleness window.
    await t.run(async (ctx) => {
      const job = (await ctx.db.query("instanceCascades").collect())[0]!;
      await ctx.db.patch(job._id, { updatedAt: Date.now() - 60 * 60 * 1000 });
    });
    expect(
      await t.run((ctx) =>
        ctx.runMutation(internal.instanceCascade.reapStalledCascades, {}),
      ),
    ).toBe(1);

    await drain(t);
    expect(await countFor(t, NAME)).toMatchObject({ agents: 0, jobs: 0 });
  });

  test("the name cannot be REUSED while its sweep is still owed", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await seedLargeInstance(t, CASCADE_TUNING.CASCADE_BATCH + 1, 2);
    await deprovision(t);

    // The control plane recreates the same name immediately — delete-then-recreate
    // is its ordinary flow. The sweep still running matches rows by NAME ALONE and
    // cannot tell the old instance's agents from the new one's, so letting this
    // through would have the background chain delete LIVE data.
    const reused = await t.fetch("/api/v1/instances/provision", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PROVISION_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: NAME, gatewayUrl: "ws://reborn" }),
    });
    expect(reused.status).toBe(409);
    expect((await reused.json()).error).toBe("instance_name_sweeping");

    // Once the sweep completes the name is free again.
    await drain(t);
    const accepted = await t.fetch("/api/v1/instances/provision", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PROVISION_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: NAME, gatewayUrl: "ws://reborn" }),
    });
    expect(accepted.status).toBe(200);
  });

  test("a sweep that finds the name LIVE again abandons rather than delete live data", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await seedLargeInstance(t, CASCADE_TUNING.CASCADE_BATCH + 1, 1);
    await deprovision(t);

    // Force the state the first lock exists to prevent, to prove the second lock
    // holds on its own: the name is live again while a sweep is still owed.
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: NAME, gatewayUrl: "ws://reborn" }),
    );
    const before = await countFor(t, NAME);

    await drain(t);

    // Nothing further was deleted. Orphan rows are the cost, and they are the
    // strictly better outcome than erasing a live instance's agents and grants.
    const after = await countFor(t, NAME);
    expect(after.agents).toBe(before.agents);
    expect(after.userAgents).toBe(before.userAgents);
    expect(after.jobs).toBe(0);
  });

  test("the ADMIN form is refused the same reused name", async () => {
    const t = convexTest(schema, modules);
    const admin = await seed(t);
    await seedLargeInstance(t, CASCADE_TUNING.CASCADE_BATCH + 1, 2);
    await deprovision(t);

    // Guarding the provisioner alone left this open, and it is the WORSE half: the
    // sweep abandons on finding the name live, so the old agents and grants stay —
    // now attached to the replacement. Everyone authorised on the gateway that was
    // removed silently inherits access to the one that took its place.
    await expect(
      t
        .withIdentity({ subject: `${admin}|session` })
        .mutation(api.admin.upsertInstance, {
          name: NAME,
          gatewayUrl: "ws://reborn",
        }),
    ).rejects.toThrow("instance_name_sweeping");

    // Updating an EXISTING instance is untouched: a sweep only ever runs for a name
    // no instance serves, so a patch cannot collide with one.
    const survivor = (await t.run((ctx) =>
      ctx.db.query("instances").collect(),
    )).find((row) => row.name === "survivor")!;
    await t
      .withIdentity({ subject: `${admin}|session` })
      .mutation(api.admin.upsertInstance, {
        instanceId: survivor._id,
        name: "survivor",
        gatewayUrl: "ws://survivor-moved",
      });
  });

  test("a user who loses their default gets a new one even holding MANY grants", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { users } = await seedLargeInstance(t, 1, 1);
    const userId = users[0]!;
    // Far more surviving grants than any bounded scan would page through. The
    // previous re-election read a fixed window and gave up when it came back full,
    // leaving this user permanently without a default — and no later pass revisits
    // them once their instance rows are gone.
    await t.run(async (ctx) => {
      for (let i = 0; i < 600; i += 1) {
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: "survivor",
          agentId: `extra-${i}`,
          isDefault: false,
          source: "manual",
          createdAt: Date.now(),
        });
      }
    });

    await deprovision(t);
    await drain(t);

    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("userAgents").collect()).filter(
        (row) => row.userId === userId,
      ),
    );
    expect(rows.filter((row) => row.isDefault === true)).toHaveLength(1);
  });

  test("a grant that OUTLIVES its instance can no longer route a turn", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { users } = await seedLargeInstance(t, CASCADE_TUNING.CASCADE_BATCH + 1, 1);
    const userId = users[0]!;
    const chatId = await t.run((ctx) =>
      ctx.db.insert("chats", {
        userId,
        updatedAt: Date.now(),
        instanceName: NAME,
        agentId: "agent-0",
      }),
    );

    await deprovision(t);
    // The sweep has NOT run: the grant is still there, still authorized. Before
    // this guard, `target` resolved while the instance row did not, and the bridge
    // URL fell back to the deployment default — sending the turn to ANOTHER
    // instance's gateway, minutes after the API confirmed the deletion.
    const stillGranted = await countFor(t, NAME);
    expect(stillGranted.userAgents).toBeGreaterThan(0);

    const routing = await t.run((ctx) =>
      ctx.runQuery(internal.bridge.getChatRouting, { chatId, userId }),
    );
    // An agent whose instance no longer exists is no agent: the dispatch fails
    // `no_agent` rather than reaching the wrong place.
    expect(routing?.target ?? null).toBeNull();
  });

  test("deleting the LAST instance still blocks routing, tombstone in hand", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // One instance only — the case a "are there others?" test cannot catch, and the
    // one where the env fallback is most tempting: with nothing left, routing would
    // keep sending turns to the very bridge the instance was removed from, which
    // still holds its credentials in memory.
    const { instanceId, userId, chatId } = await t.run(async (ctx) => {
      const instanceId = await ctx.db.insert("instances", {
        name: NAME,
        gatewayUrl: "ws://only",
      });
      for (let i = 0; i < CASCADE_TUNING.CASCADE_BATCH + 1; i += 1) {
        await ctx.db.insert("agents", {
          instanceName: NAME,
          agentId: `agent-${i}`,
          source: "discovered",
          presentInLastOk: true,
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          enabled: true,
        });
      }
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: NAME,
        agentId: "agent-0",
        isDefault: true,
        source: "manual",
        createdAt: Date.now(),
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: Date.now(),
        instanceName: NAME,
        agentId: "agent-0",
      });
      return { instanceId, userId, chatId };
    });
    expect(instanceId).toBeTruthy();

    await deprovision(t);
    // No instances remain at all, so "are there others?" cannot decide. The
    // deletion tombstone is what separates this from a deployment that never had
    // an instances table, where the env fallback is the only correct route.
    expect((await countFor(t, NAME)).jobs).toBe(1);

    const routing = await t.run((ctx) =>
      ctx.runQuery(internal.bridge.getChatRouting, { chatId, userId }),
    );
    expect(routing?.target ?? null).toBeNull();
  });

  test("agent FILE CONTENT never survives to be applied to a recreated gateway", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { users } = await seedLargeInstance(t, 2, 1);
    const userId = users[0]!;
    // A curation is a PROPOSAL that `claimForApply` writes to a gateway; a revision
    // is stored file history. Both are keyed by (instanceName, agentId), so a
    // gateway recreated under the same name inherits them — and applying the old
    // proposal copies the removed instance's MEMORY.md onto the replacement.
    await t.run(async (ctx) => {
      await ctx.db.insert("agentFileCurations", {
        instanceName: NAME,
        agentId: "agent-0",
        name: "MEMORY.md",
        status: "dispatched",
        baseUpdatedAtMs: null,
        beforeSize: 10,
        beforeContent: "secrets of the departing tenant",
        budgetChars: 1000,
        requestedByUserId: userId,
        trigger: "manual",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("agentFileRevisions", {
        instanceName: NAME,
        agentId: "agent-0",
        name: "AGENTS.md",
        before: "old",
        after: "newer",
        byUserId: userId,
        at: Date.now(),
      });
    });

    // The requester's hidden curator chat is BLOCKED on that curation.
    const chatId = await t.run(async (ctx) => {
      const curation = (await ctx.db.query("agentFileCurations").collect())[0]!;
      return await ctx.db.insert("chats", {
        userId,
        kind: "curator",
        updatedAt: Date.now(),
        pendingCurate: { curationId: curation._id, createdAt: Date.now() },
      });
    });

    await deprovision(t);
    await drain(t);

    // Deleting the curation row alone would leave this chat pointing at nothing:
    // the user stuck behind a job that can never settle, and a delayed dispatch
    // free to carry the departed instance's file to a replacement gateway.
    expect(
      (await t.run((ctx) => ctx.db.get(chatId)))?.pendingCurate,
    ).toBeUndefined();

    const left = await t.run(async (ctx) => ({
      curations: (await ctx.db.query("agentFileCurations").collect()).filter(
        (row) => row.instanceName === NAME,
      ).length,
      revisions: (await ctx.db.query("agentFileRevisions").collect()).filter(
        (row) => row.instanceName === NAME,
      ).length,
    }));
    expect(left).toEqual({ curations: 0, revisions: 0 });
  });

  test("a LATE write from the removed instance cannot recreate its rows", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { users } = await seedLargeInstance(t, CASCADE_TUNING.CASCADE_BATCH + 1, 1);
    await deprovision(t);

    // A discovery poll and a file write started BEFORE the deletion land now,
    // mid-sweep. Both address the instance by NAME alone. Accepting them would
    // recreate rows of the removed instance — and the revision is file CONTENT,
    // which a gateway recreated under this name would then inherit.
    await t.run((ctx) =>
      ctx.runMutation(internal.agents.applyDiscovery, {
        instanceName: NAME,
        agents: [
          {
            agentId: "zombie",
            displayName: "Zombie",
            emoji: null,
            model: null,
            isDefaultOnInstance: false,
          },
        ],
      }),
    );
    // A curation requested before the deletion, landing after the sweep already
    // emptied that table — which it visits ONCE and never revisits.
    expect(
      await t.run((ctx) =>
        ctx.runMutation(internal.agentFileCuration.dispatchCuration, {
          instanceName: NAME,
          agentId: "agent-0",
          name: "MEMORY.md",
          content: "content of the departing tenant",
          baseUpdatedAtMs: null,
          budgetChars: 1000,
          trigger: "manual",
        }),
      ),
    ).toMatchObject({ ok: false, reason: "instance_deleted" });
    // The same poll that calls applyDiscovery calls this next.
    await t.run((ctx) =>
      ctx.runMutation(internal.agents.recordInstanceUsage, {
        instanceName: NAME,
        usage: [],
      }),
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.agentFiles.recordFileRevision, {
        instanceName: NAME,
        agentId: "agent-0",
        name: "MEMORY.md",
        before: "old",
        after: "late arrival",
      }),
    );

    const zombies = await t.run(async (ctx) => ({
      agents: (await ctx.db.query("agents").collect()).filter(
        (row) => row.agentId === "zombie",
      ).length,
      revisions: (await ctx.db.query("agentFileRevisions").collect()).filter(
        (row) => row.instanceName === NAME,
      ).length,
      curations: (await ctx.db.query("agentFileCurations").collect()).filter(
        (row) => row.instanceName === NAME,
      ).length,
      usage: (await ctx.db.query("instanceUsage").collect()).filter(
        (row) => row.instanceName === NAME,
      ).length,
    }));
    expect(zombies).toEqual({
      agents: 0,
      revisions: 0,
      curations: 0,
      usage: 0,
    });

    // And the sweep still converges — the refusals changed nothing it depends on.
    await drain(t);
    expect(await countFor(t, NAME)).toMatchObject({ agents: 0, jobs: 0 });
  });

  test("the file-bearing tables are swept in SMALL batches, by construction", async () => {
    // Not provable behaviourally: convex-test has no 16 MiB transaction ceiling to
    // trip, so a batch of 100 curations passes here and fails only in production —
    // and it fails PERMANENTLY, every pass throwing while the reaper re-arms it and
    // the name stays locked. Pinned on the source instead, so the distinction
    // between counting rows and counting megabytes cannot be refactored away in
    // silence.
    const src = readFileSync(
      new URL("./lib/instanceCascade.ts", import.meta.url),
      "utf8",
    );
    expect(CASCADE_TUNING.CONTENT_BATCH).toBeLessThan(
      CASCADE_TUNING.CASCADE_BATCH,
    );
    for (const table of ["agentFileCurations", "agentFileRevisions"]) {
      const start = src.indexOf(`.query("${table}")`);
      expect(start, `${table} is no longer swept`).toBeGreaterThan(-1);
      const clause = src.slice(start, start + 220);
      expect(
        clause,
        `${table} holds file bodies and must use CONTENT_BATCH, not the row-count batch`,
      ).toContain("CONTENT_BATCH");
    }
  });

  test("a duplicate name still blocks the name-bound sweep, credentials aside", async () => {
    const t = convexTest(schema, modules);
    const admin = await seed(t);
    const { instanceId } = await seedLargeInstance(t, 3, 1);
    // A second row serving the SAME routing key — the legacy-duplicate case the
    // admin path must survive.
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: NAME, gatewayUrl: "ws://twin" }),
    );

    // Through the REAL admin path, which shares the cascade with the endpoint.
    await t
      .withIdentity({ subject: `${admin}|session` })
      .mutation(api.admin.deleteInstance, { instanceId });

    const after = await countFor(t, NAME);
    // The twin still serves the name, so its agents and grants must survive...
    expect(after.instances).toBe(1);
    expect(after.agents).toBe(3);
    expect(after.userAgents).toBe(1);
    // ...and no sweep is owed, because there is nothing to sweep.
    expect(after.jobs).toBe(0);
  });
});
