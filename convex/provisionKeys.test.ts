/// <reference types="vite/client" />
//
// DECLARED provisioning keys — one per provisioned host.
//
// The bootstrap problem this solves: an automation cannot ask a human to create a
// service account, and a key Atrium generated would have to be returned, captured
// and transported at the exact moment nothing is in place yet. So the platform
// generates each secret, keeps it, and DECLARES it; Atrium holds only the hash and
// never hands anything back.
//
// What is pinned here is everything that could turn that into a credential
// problem: the declaration must be the source of truth (rotation and revocation
// follow it), a malformed entry must NOT become a working key, the reconciliation
// must write nothing in a steady state, and a freshly declared key must work on
// its FIRST call rather than after an interval.

import { readFileSync } from "node:fs";

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { hashKey } from "./lib/apikeys";
import { PROVISION_KEYS_ENV } from "./lib/provisionKeys";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SECRET_A = "s".repeat(24) + "-alpha";
const SECRET_B = "s".repeat(24) + "-beta";

afterEach(() => {
  delete process.env[PROVISION_KEYS_ENV];
});

/** An ESTABLISHED deployment: a human has signed in at some point. */
async function seed(t: TestConvex<typeof schema>) {
  await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
  });
}

const declare = (value: string) => {
  process.env[PROVISION_KEYS_ENV] = value;
};

const reconcile = (t: TestConvex<typeof schema>) =>
  t.action(internal.provisionKeys.reconcileProvisionKeys, {});

const accounts = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) => ({
    services: await ctx.db.query("serviceAccounts").collect(),
    keys: await ctx.db.query("apiKeys").collect(),
  }));

/** Drive a real key-authed route, which is the only thing that proves the key
 *  actually authenticates rather than merely existing in a table. */
const callProvision = (t: TestConvex<typeof schema>, key: string) =>
  t.fetch("/api/v1/instances/provision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "compta", gatewayUrl: "ws://compta" }),
  });

describe("declared provisioning keys", () => {
  test("a declared key becomes a working provisioner, one account per host", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A} vps-b:${SECRET_B}`);

    expect(await reconcile(t)).toMatchObject({ applied: 2, rejected: [] });
    const { services } = await accounts(t);
    expect(services.map((row) => row.name).sort()).toEqual([
      "provision:vps-a",
      "provision:vps-b",
    ]);
    // The role is FIXED by the code, never taken from the declaration: the
    // platform says WHICH hosts may provision, never what else they could do.
    expect(services.every((row) => row.roleKey === "provisioner")).toBe(true);

    // And it really authenticates — a row in a table proves nothing on its own.
    expect((await callProvision(t, SECRET_A)).status).toBe(200);
  });

  test("the plaintext is never stored, and the display prefix does not leak it", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);

    const { keys } = await accounts(t);
    const stored = JSON.stringify(keys);
    expect(stored).not.toContain(SECRET_A);
    // A prefix taken from the plaintext would put part of the secret in every
    // listing and audit row; it is derived from the LABEL instead.
    expect(keys[0]!.prefix).toBe("declared:vps-a");
    expect(keys[0]!.hashedKey).toBe(await hashKey(SECRET_A));
  });

  test("a SECOND pass over an unchanged declaration writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);
    const before = await accounts(t);

    await reconcile(t);

    // Runs on an interval AND on every authentication miss, so a pass that
    // rewrote rows would churn the database for as long as the deployment lives.
    expect(await accounts(t)).toEqual(before);
  });

  test("rotation follows the declaration: the old secret stops working", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);
    expect((await callProvision(t, SECRET_A)).status).toBe(200);

    declare(`vps-a:${SECRET_B}`);
    await reconcile(t);

    expect((await callProvision(t, SECRET_B)).status).toBe(200);
    // Disabled, not deleted — but no longer an authentication.
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
  });

  test("revocation follows the declaration: a dropped host loses access", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A} vps-b:${SECRET_B}`);
    await reconcile(t);

    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);

    expect((await callProvision(t, SECRET_A)).status).toBe(200);
    expect((await callProvision(t, SECRET_B)).status).toBe(401);
    // The account survives, disabled: what it did must remain attributable.
    const { services } = await accounts(t);
    const dropped = services.find((row) => row.name === "provision:vps-b")!;
    expect(dropped.disabled).toBe(true);
  });

  test("a malformed or duplicated entry never becomes a working key", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(
      [
        "missing-separator",
        "bad!label:" + SECRET_A,
        "vps-c:short",
        `vps-a:${SECRET_A}`,
        `vps-a:${SECRET_B}`, // duplicate label — which one is current?
      ].join(","),
    );

    const result = await reconcile(t);

    // NOTHING is applied: every entry here is either unreadable or ambiguous, and
    // a half-read entry that silently became a credential is worse than one that
    // never worked.
    expect(result.applied).toBe(0);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect((await accounts(t)).services).toEqual([]);
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
  });

  test("a freshly declared key works on its FIRST call, without waiting for the cron", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // The platform writes the variable and calls the API immediately — faster than
    // any interval. Nothing has reconciled yet.
    declare(`vps-a:${SECRET_A}`);
    expect((await accounts(t)).services).toEqual([]);

    expect((await callProvision(t, SECRET_A)).status).toBe(200);

    // The authentication miss reconciled on demand, so it is persisted afterwards.
    expect((await accounts(t)).services).toHaveLength(1);
  });

  test("a BRAND-NEW deployment works before any human has signed in", async () => {
    const t = convexTest(schema, modules);
    // No seed: no users, no profiles. This is the automated install — the platform
    // declares a key and calls the API before anyone has ever opened Atrium. The
    // reconciliation used to read "the first user" for attribution and throw on its
    // absence, failing in exactly the scenario the feature exists for.
    declare(`vps-a:${SECRET_A}`);

    expect(await reconcile(t)).toMatchObject({ applied: 1 });
    expect((await callProvision(t, SECRET_A)).status).toBe(200);
    // No author is recorded rather than a borrowed one: an administrator must not
    // appear to have authorised something they never saw.
    const { services } = await accounts(t);
    expect(services[0]!.createdByUserId).toBeUndefined();
  });

  test("revocation takes effect on the NEXT CALL, not on the next interval", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);
    expect((await callProvision(t, SECRET_A)).status).toBe(200);

    // The label is withdrawn. Its key row is still ACTIVE — nothing has
    // reconciled — so resolving the hash still finds it. Honouring it until the
    // cron would contradict the documented immediate effect.
    declare(`vps-b:${SECRET_B}`);

    expect((await callProvision(t, SECRET_A)).status).toBe(401);
  });

  test("an account created BY HAND is never adopted, whatever it is called", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const handMade = await t.run(async (ctx) => {
      const admin = (await ctx.db.query("users").first())!._id;
      return await ctx.db.insert("serviceAccounts", {
        name: "provision:vps-a",
        roleKey: "observer",
        disabled: false,
        createdByUserId: admin,
      });
    });
    declare(`vps-a:${SECRET_A}`);

    await reconcile(t);

    // Ownership is CLAIMED, never inferred from the name. Adopting this account
    // would silently re-role something an administrator set up deliberately.
    const row = (await t.run((ctx) => ctx.db.get(handMade)))!;
    expect(row.roleKey).toBe("observer");
    expect(row.managedBy).toBeUndefined();
  });

  test("going BACK to a previous secret leaves a usable key", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);
    declare(`vps-a:${SECRET_B}`);
    await reconcile(t);

    // The platform reverts. The old row still exists, disabled — so nothing was
    // inserted, and the rotation pass then disabled the current one too, leaving
    // the account with no usable key at all despite a valid declaration.
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);

    expect((await callProvision(t, SECRET_A)).status).toBe(200);
    expect((await callProvision(t, SECRET_B)).status).toBe(401);
  });

  test("the SAME secret under two labels is refused, never duplicated", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // Two rows sharing a hash would make authentication resolve `.unique()` over
    // two matches — a THROW rather than an authentication or a clean refusal — and
    // attribution to a host would be meaningless.
    declare(`vps-a:${SECRET_A} vps-b:${SECRET_A}`);

    expect(await reconcile(t)).toMatchObject({ applied: 0 });
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
  });

  test("a label repeated ONCE VALID and once malformed is still refused", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // Counting only well-formed entries let the broken half be filtered out before
    // the tally, so the label looked unique and its valid key was applied — while
    // the declaration is just as ambiguous as any other duplicate.
    declare(`vps-a:${SECRET_A} vps-a:short`);

    expect(await reconcile(t)).toMatchObject({ applied: 0 });
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
  });

  test("renaming a label while KEEPING its secret is refused, not duplicated", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);

    // The old row is kept for audit, disabled or not. Inserting a second row with
    // the same hash makes `findByHash` resolve `.unique()` over both and THROW —
    // every call with that key would then fail by exception rather than
    // authenticate or be cleanly refused.
    declare(`vps-b:${SECRET_A}`);
    await reconcile(t);

    const { keys } = await accounts(t);
    const sameHash = keys.filter(
      (row) => row.hashedKey === keys[0]!.hashedKey,
    );
    expect(sameHash).toHaveLength(1);
    // And authentication still ANSWERS — refused, because vps-a's label is gone.
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
  });

  test("revocation is BOUNDED per pass and still converges", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // More declaration-managed accounts than one revocation batch. Walking the
    // whole table in a single transaction is what eventually exceeds Convex's
    // limits and makes the cron fail durably, leaving every declaration
    // unreconciled.
    await t.run(async (ctx) => {
      for (let i = 0; i < 150; i += 1) {
        await ctx.db.insert("serviceAccounts", {
          name: `provision:bulk-${i}`,
          roleKey: "provisioner",
          disabled: false,
          managedBy: PROVISION_KEYS_ENV,
        });
      }
    });
    declare(`vps-a:${SECRET_A}`);

    await reconcile(t);

    const { services } = await accounts(t);
    const bulk = services.filter((row) => row.name.startsWith("provision:bulk-"));
    expect(bulk).toHaveLength(150);
    expect(bulk.every((row) => row.disabled === true)).toBe(true);
    // ...and the declared one is untouched.
    expect((await callProvision(t, SECRET_A)).status).toBe(200);
  });

  test("two hosts SWAPPING secrets authenticate as neither", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A} vps-b:${SECRET_B}`);
    await reconcile(t);

    // Both hashes still exist somewhere, so neither reassignment can be applied —
    // a hash may not be duplicated. Checking the hash ALONE would then let each
    // key go on authenticating under the WRONG host, and attribution to a host is
    // the entire point of one key per host.
    declare(`vps-a:${SECRET_B} vps-b:${SECRET_A}`);
    await reconcile(t);

    expect((await callProvision(t, SECRET_A)).status).toBe(401);
    expect((await callProvision(t, SECRET_B)).status).toBe(401);
  });

  test("revocation reaches PAST a full page of still-declared accounts", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // A page's worth of legitimate accounts, and the withdrawn one behind them.
    // Keying the next pass on "did we revoke anything" stalled the sweep here: the
    // first page revoked nothing, so it stopped, and the withdrawn account kept
    // its access while the cron re-read the same rows for ever.
    const declaration: string[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < 120; i += 1) {
        await ctx.db.insert("serviceAccounts", {
          name: `provision:keep-${i}`,
          roleKey: "provisioner",
          disabled: false,
          managedBy: PROVISION_KEYS_ENV,
        });
        declaration.push(`keep-${i}:${"k".repeat(24)}-${i}`);
      }
      await ctx.db.insert("serviceAccounts", {
        name: "provision:withdrawn",
        roleKey: "provisioner",
        disabled: false,
        managedBy: PROVISION_KEYS_ENV,
      });
    });
    declare(declaration.join(","));

    await reconcile(t);

    const { services } = await accounts(t);
    const gone = services.find((row) => row.name === "provision:withdrawn")!;
    expect(gone.disabled).toBe(true);
    // ...and every still-declared account is untouched.
    expect(
      services.filter((row) => row.name.startsWith("provision:keep-")).every(
        (row) => row.disabled === false,
      ),
    ).toBe(true);
  });

  test("a key REDECLARED after revocation works on its next call", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);
    declare("");
    await reconcile(t);
    expect((await callProvision(t, SECRET_A)).status).toBe(401);

    // The host comes back. Its key row is FOUND — so the miss path that reconciles
    // on demand is never taken — but both the row and its account are still marked
    // revoked, and the checks that follow would refuse a key the declaration now
    // vouches for, until the next interval.
    declare(`vps-a:${SECRET_A}`);

    expect((await callProvision(t, SECRET_A)).status).toBe(200);
  });

  test("duplicate hand-made accounts do not kill the whole reconciliation", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // Service-account names are not unique in the schema, and the admin mutations
    // never enforced it. Resolving with `.unique()` THREW here, taking every other
    // label's rotation and revocation down with it.
    await t.run(async (ctx) => {
      for (const _ of [0, 1]) {
        await ctx.db.insert("serviceAccounts", {
          name: "provision:twin",
          roleKey: "observer",
          disabled: false,
        });
      }
    });
    declare(`twin:${SECRET_B} vps-a:${SECRET_A}`);

    await reconcile(t);

    // The ambiguous label is left alone, and the OTHER label is still applied.
    expect((await callProvision(t, SECRET_A)).status).toBe(200);
    expect((await callProvision(t, SECRET_B)).status).toBe(401);
  });

  test("the admin REVOKE and DELETE controls refuse rather than pretend", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);
    const admin = await t.run(async (ctx) =>
      (await ctx.db.query("users").first())!._id,
    );
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { services, keys } = await accounts(t);

    // An operator revoking a key they believe is compromised must not be told it
    // is done while the reconciliation re-enables it on its next pass. Refusing is
    // the honest answer; withdrawing the entry is what actually revokes.
    await expect(
      asAdmin.mutation(api.apiKeys.revokeApiKey, { keyId: keys[0]!._id }),
    ).rejects.toThrow(PROVISION_KEYS_ENV);
    await expect(
      asAdmin.mutation(api.apiKeys.deleteServiceAccount, {
        serviceAccountId: services[0]!._id,
      }),
    ).rejects.toThrow(PROVISION_KEYS_ENV);
    // Renaming would have the reconciliation create a SECOND account under the
    // expected name, refuse to move the hash onto it, then disable the old one —
    // the declared key answering 401 with two managed accounts to untangle.
    await expect(
      asAdmin.mutation(api.apiKeys.updateServiceAccount, {
        serviceAccountId: services[0]!._id,
        name: "renamed",
      }),
    ).rejects.toThrow(PROVISION_KEYS_ENV);

    // Minting a NEW key on that account is refused too — before the secret is
    // generated. Allowing it would hand out a plaintext that fails on its first
    // call, once the reconciliation notices the hash is not in the declaration.
    await expect(
      asAdmin.action(api.apiKeys.mintApiKey, {
        serviceAccountId: services[0]!._id,
      }),
    ).rejects.toThrow(PROVISION_KEYS_ENV);

    // The key still works, which is precisely why refusing had to be loud.
    expect((await callProvision(t, SECRET_A)).status).toBe(200);
    // The listing must SERIALISE at all: a declaration-managed account has no
    // author, and Convex refuses `undefined` inside a query result — so a bare
    // projection made the whole Service Accounts tab fail to load the moment the
    // feature was used.
    const listed = await asAdmin.query(api.apiKeys.listServiceAccounts, {});
    expect(
      listed.find((row) => row.name === "provision:vps-a")!.createdByUserId,
    ).toBeNull();
    // And the interface can SAY so rather than offering a control that is refused.
    expect(
      listed.find((row) => row.name === "provision:vps-a")!.managedBy,
    ).toBe(PROVISION_KEYS_ENV);
  });

  test("rotation stays correct past a long key HISTORY", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);
    const accountId = (await accounts(t)).services[0]!._id;

    // Every rotation keeps its predecessor disabled for audit, so the history only
    // grows. A bounded page of `by_account` returned the OLDEST rows, so past the
    // window the CURRENT key fell out of view and the next rotation stopped
    // disabling it — leaving several keys marked active at once.
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i += 1) {
        await ctx.db.insert("apiKeys", {
          serviceAccountId: accountId,
          hashedKey: `history-${i}`,
          prefix: "declared:vps-a",
          lastFour: "----",
          disabled: true,
          createdAt: Date.now(),
        });
      }
    });

    // TWO rotations are needed to expose it. The first creates its key AFTER the
    // history, so that key sits past the oldest-50 window; the second must still
    // find and disable it. Reading the oldest page never sees it, so it stays
    // active alongside the new one — two live keys where there must be one.
    const SECRET_C = "s".repeat(24) + "-gamma";
    declare(`vps-a:${SECRET_B}`);
    await reconcile(t);
    declare(`vps-a:${SECRET_C}`);
    await reconcile(t);

    const { keys } = await accounts(t);
    const active = keys.filter((row) => !row.disabled);
    expect(active).toHaveLength(1);
    expect(active[0]!.hashedKey).toBe(await hashKey(SECRET_C));
    expect((await callProvision(t, SECRET_C)).status).toBe(200);
    expect((await callProvision(t, SECRET_B)).status).toBe(401);
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
  });

  test("a REVOKED key stops costing work after its first refusal", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);
    // WITHDRAWAL, not rotation. A rotation happens to disable the old key as a
    // side effect, which hides the problem; withdrawing the label disables the
    // ACCOUNT and leaves the key row enabled, so it keeps resolving by hash.
    declare("");

    expect((await callProvision(t, SECRET_A)).status).toBe(401);
    const afterFirst = await accounts(t);
    const oldHash = await hashKey(SECRET_A);
    // The row was disabled ONCE. Running a full reconciliation here instead never
    // removes it from the by-hash index, so every later attempt would restart the
    // whole pass: hashing, sweeping and mutating on demand, for free, from an
    // unauthenticated caller.
    expect(
      afterFirst.keys.find((row) => row.hashedKey === oldHash)?.disabled,
    ).toBe(true);

    // Every later attempt is a plain lookup and a refusal — nothing written.
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
    expect(await accounts(t)).toEqual(afterFirst);
  });

  test("declaring a secret that is already a MANUAL key retires that key", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // An operator pastes, as a declared secret, a key that already belongs to a
    // hand-made account with a WIDER role. Refusing the entry alone left that key
    // resolving to its original account — and `authenticateApiKey` only consults
    // the declaration for declaration-managed accounts, so the declared host would
    // authenticate as `agent`, and keep doing so after the declaration was pulled.
    await t.run(async (ctx) => {
      const accountId = await ctx.db.insert("serviceAccounts", {
        name: "hand-made",
        roleKey: "agent",
        disabled: false,
      });
      await ctx.db.insert("apiKeys", {
        serviceAccountId: accountId,
        hashedKey: await hashKey(SECRET_A),
        prefix: "oc_manual",
        lastFour: "test",
        disabled: false,
        createdAt: Date.now(),
      });
    });

    declare(`vps-a:${SECRET_A}`);

    // BEFORE any reconciliation. The hash resolves to the MANUAL account, which
    // carries no `managedBy` — so the declaration check would be skipped and the
    // host would authenticate with that account's wider role until the next cron.
    // The refusal has to happen on this very call.
    expect((await callProvision(t, SECRET_A)).status).toBe(401);

    await reconcile(t);

    // ...and the colliding key is retired rather than left widening a host's
    // permissions through a misconfiguration.
    expect((await callProvision(t, SECRET_A)).status).toBe(401);

    // Further attempts stay refused, and must cost nothing.
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
    expect((await callProvision(t, SECRET_A)).status).toBe(401);

    // The COST is not observable from the database: a replayed reconciliation is
    // idempotent, so the rows look the same whether or not it ran. What must not
    // happen is the WORK — hashing every declared secret and walking paginated
    // mutations — on each attempt, which would let the holder of a collided secret
    // drive it from outside authentication. Pinned on the source, as the only
    // place the distinction is visible.
    const src = readFileSync(new URL("./lib/apiAuth.ts", import.meta.url), "utf8");
    const collision = src.slice(
      src.indexOf("if (serviceAccount.managedBy === undefined)"),
      src.indexOf("if (serviceAccount.managedBy !== undefined)"),
    );
    expect(collision.length, "the collision branch moved").toBeGreaterThan(100);
    expect(
      collision,
      "reconciliation in the collision branch must be guarded by key.disabled, or every attempt re-runs it",
    ).toContain("if (!key.disabled)");
    const { keys } = await accounts(t);
    expect(keys.every((row) => row.disabled)).toBe(true);
  });

  test("a colliding key is retired even when the LABEL is also ambiguous", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // Both collisions at once: the secret already belongs to a manual key, AND a
    // manual account already carries the name the label maps to. Abandoning the
    // label first left the key live — refused while the declaration stood, then
    // valid again with its manual role the moment the entry was withdrawn.
    await t.run(async (ctx) => {
      const wide = await ctx.db.insert("serviceAccounts", {
        name: "provision:vps-a",
        roleKey: "agent",
        disabled: false,
      });
      await ctx.db.insert("serviceAccounts", {
        name: "provision:vps-a",
        roleKey: "observer",
        disabled: false,
      });
      await ctx.db.insert("apiKeys", {
        serviceAccountId: wide,
        hashedKey: await hashKey(SECRET_A),
        prefix: "oc_manual",
        lastFour: "test",
        disabled: false,
        createdAt: Date.now(),
      });
    });

    declare(`vps-a:${SECRET_A}`);
    await reconcile(t);
    // Withdrawn: nothing left to refuse it on the declaration side.
    declare("");
    await reconcile(t);

    expect((await callProvision(t, SECRET_A)).status).toBe(401);
  });

  test("the revocation sweep RESUMES past its per-run bound", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    try {
      await seed(t);
      // More declaration-managed accounts than one run walks. Ending the loop
      // without carrying the cursor had the next cron restart from the beginning
      // and re-walk the same pages for ever, so anything past the bound kept its
      // access — the declarative revocation quietly not happening at scale.
      await t.run(async (ctx) => {
        for (let i = 0; i < 260; i += 1) {
          await ctx.db.insert("serviceAccounts", {
            name: `provision:bulk-${i}`,
            roleKey: "provisioner",
            disabled: false,
            managedBy: PROVISION_KEYS_ENV,
          });
        }
      });
      declare("");

      await reconcile(t);
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const { services } = await accounts(t);
      const bulk = services.filter((row) =>
        row.name.startsWith("provision:bulk-"),
      );
      expect(bulk).toHaveLength(260);
      expect(bulk.every((row) => row.disabled === true)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an AMBIGUOUS entry cannot smuggle a manual key past the collision check", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // The secret belongs to a manual account with a wider role...
    await t.run(async (ctx) => {
      const wide = await ctx.db.insert("serviceAccounts", {
        name: "hand-made",
        roleKey: "agent",
        disabled: false,
      });
      await ctx.db.insert("apiKeys", {
        serviceAccountId: wide,
        hashedKey: await hashKey(SECRET_A),
        prefix: "oc_manual",
        lastFour: "test",
        disabled: false,
        createdAt: Date.now(),
      });
    });
    // ...and it is declared TWICE, which drops it from the accepted set. Dropping
    // it silently meant nothing downstream ever looked at it, so the collision was
    // never detected and the secret kept authenticating as `agent`.
    declare(`vps-a:${SECRET_A} vps-b:${SECRET_A}`);

    // The CRON must retire it too, without waiting for anyone to present the key:
    // a holder who simply waits for the faulty declaration to be corrected would
    // otherwise keep it, with its original wider role.
    await reconcile(t);
    const { keys: afterCron } = await accounts(t);
    expect(afterCron.every((row) => row.disabled)).toBe(true);

    expect((await callProvision(t, SECRET_A)).status).toBe(401);
    // It authorises nothing either — the ambiguity is refused, not resolved.
    await reconcile(t);
    expect((await accounts(t)).services.map((row) => row.name)).toEqual([
      "hand-made",
    ]);

    // And the collision is retired DURABLY: withdrawing the faulty declaration
    // must not hand the manual key back its wider role.
    declare("");
    expect((await callProvision(t, SECRET_A)).status).toBe(401);
  });

  test("an UNDECLARED key is refused and costs no write", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    declare(`vps-a:${SECRET_A}`);

    expect((await callProvision(t, "not-a-declared-secret")).status).toBe(401);

    // A probe must not be able to make the deployment write anything.
    expect((await accounts(t)).services).toEqual([]);
  });
});
