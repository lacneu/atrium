// Reconcile the DECLARED provisioning keys into service accounts.
//
// The declaration lives in one environment value (see lib/provisionKeys); this
// module makes the database agree with it. Nothing here mints a secret and
// nothing returns one — the platform owns generation, Atrium owns only the hash.
//
// Runs from two places, for two different reasons:
//   - a cron, so rotation and revocation take effect on their own;
//   - an authentication MISS whose presented key matches a declaration, so a host
//     provisioned seconds ago works on its FIRST call instead of waiting out an
//     interval. That is the install path: the platform writes the variable and
//     immediately calls the API.

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { hashKey } from "./lib/apikeys";
import { seedBuiltinRoles } from "./lib/rbac";
import {
  parseDeclaredKeys,
  provisionAccountName,
  PROVISION_KEYS_ENV,
} from "./lib/provisionKeys";

/**
 * Disable a key the declaration wants but that already belongs to someone else.
 * Called from EVERY path that abandons a label, because a colliding key left live
 * would be refused only while the declaration stands, then valid again with its
 * original role the moment the entry is withdrawn.
 */
async function retireCollidingKey(
  ctx: MutationCtx,
  key: Doc<"apiKeys"> | null,
  label: string,
): Promise<void> {
  if (key === null || key.disabled) return;
  await ctx.db.patch(key._id, { disabled: true });
  console.log(
    `[provision-keys] "${label}" declares a secret already bound to another account — that key is now DISABLED`,
  );
}

/** The role every declared key is bound to. Deliberately fixed: the declaration
 *  says WHICH hosts may provision, never what else they could do. */
const PROVISION_ROLE = "provisioner";
/** Declaration-managed accounts examined per revocation pass. */
const REVOKE_BATCH = 100;
/** ACTIVE keys of one account read per reconciliation. Only one should normally be
 *  active; the margin catches a state left inconsistent by an earlier failure. */
const KEY_HISTORY_SCAN = 50;
/** Revocation pages walked per run before handing the rest to a continuation. */
const PASSES_PER_RUN = 100;

/**
 * Make the service accounts match the declaration. IDEMPOTENT by construction —
 * a steady state performs no writes at all, which matters because this runs on an
 * interval and on every authentication miss.
 */
export const applyDeclaredKeys = internalMutation({
  args: {
    declared: v.array(v.object({ label: v.string(), hash: v.string() })),
    /**
     * Hashes of AMBIGUOUS entries. They authorise nothing, but a colliding key
     * must still be retired here: leaving it to the authentication path meant a
     * holder who simply waited for the faulty declaration to be corrected kept the
     * key — and its original, wider role.
     */
    quarantinedHashes: v.optional(v.array(v.string())),
    /** Where the revocation sweep resumes; absent starts at the beginning. */
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { declared, cursor, quarantinedHashes }) => {
    // The role must exist before an account can reference it.
    await seedBuiltinRoles(ctx);
    const wanted = new Map(declared.map((entry) => [entry.label, entry.hash]));
    let created = 0;
    let rotated = 0;
    let revoked = 0;

    for (const [label, hash] of wanted) {
      const name = provisionAccountName(label);
      // `.take(2)`, NOT `.unique()`. Service-account names are not unique in the
      // schema and the admin mutations never enforced it, so two hand-made
      // accounts can share this name — and `.unique()` would THROW, killing the
      // whole reconciliation: every other label's rotation and revocation with it.
      // Ambiguity here is treated like any other unclaimed account: left alone.
      // THE HASH FIRST. Retiring a colliding key has to happen before any reason
      // to skip this label: leaving it live would have it refused only while the
      // declaration stands, then valid again with its MANUAL role the moment the
      // entry is withdrawn — the opposite of the revocation this promises.
      const declaredHashOwner = await ctx.db
        .query("apiKeys")
        .withIndex("by_hash", (query) => query.eq("hashedKey", hash))
        .first();

      const named = await ctx.db
        .query("serviceAccounts")
        .withIndex("by_name", (query) => query.eq("name", name))
        .take(2);
      if (named.length > 1) {
        await retireCollidingKey(ctx, declaredHashOwner, label);
        console.log(
          `[provision-keys] several accounts are named "${name}" — leaving them alone; resolve the duplicate by hand`,
        );
        continue;
      }
      const account = named[0] ?? null;
      const accountId =
        account?._id ??
        (await ctx.db.insert("serviceAccounts", {
          name,
          roleKey: PROVISION_ROLE,
          disabled: false,
          description: `Declared via ${PROVISION_KEYS_ENV} for host "${label}".`,
          // NO AUTHOR, deliberately. An automated install runs before any human has
          // signed in, so there is nobody to attribute this to — and reading "the
          // first user" would make an administrator appear to have authorised
          // something they never saw. Dereferencing that absent user is also what
          // used to throw on a brand-new deployment: the very scenario this exists
          // for.
          managedBy: PROVISION_KEYS_ENV,
        }));
      if (account !== null) {
        // OWNERSHIP IS CLAIMED, not inferred. An account created by hand whose name
        // happens to match the convention must not be adopted, re-roled, or have
        // its keys disabled.
        if (account.managedBy !== PROVISION_KEYS_ENV) {
          await retireCollidingKey(ctx, declaredHashOwner, label);
          console.log(
            `[provision-keys] "${name}" exists but is not declaration-managed — leaving it alone`,
          );
          continue;
        }
        if (account.disabled || account.roleKey !== PROVISION_ROLE) {
          // A previously revoked label came back, or someone re-pointed the account
          // at another role. The declaration is the source of truth.
          await ctx.db.patch(accountId, {
            disabled: false,
            roleKey: PROVISION_ROLE,
          });
        }
      }

      // Read exactly what the loop needs, and nothing that grows without bound.
      // Every rotation keeps its predecessor disabled for audit, so an account
      // accumulates keys for as long as the deployment lives: reading them all
      // eventually exceeds Convex's limits, and reading a bounded PAGE of them
      // returned the OLDEST — past ~50 rotations the current key fell outside the
      // window and stopped being maintained.
      //
      // So: the declared key is fetched by its HASH (a point lookup), and the
      // still-ACTIVE keys come from an index that carries `disabled`. Both are
      // bounded by how many keys are live, which is one or two.
      const byHash = declaredHashOwner;
      const matching =
        byHash !== null && byHash.serviceAccountId === accountId
          ? byHash
          : undefined;
      const keys = await ctx.db
        .query("apiKeys")
        .withIndex("by_account_disabled", (query) =>
          query.eq("serviceAccountId", accountId).eq("disabled", false),
        )
        .take(KEY_HISTORY_SCAN);
      if (matching !== undefined && matching.disabled) {
        // The declaration went BACK to a secret it had rotated away from. Its row
        // still exists, disabled — so no insert happened, and the loop below then
        // disabled the current one, leaving the account with no usable key at all
        // despite a perfectly valid declaration. Re-enable it instead.
        await ctx.db.patch(matching._id, { disabled: false });
        rotated += 1;
      }
      if (matching === undefined) {
        // A hash may exist on ANOTHER account — a label renamed while its secret
        // stayed the same. Two rows sharing a hash make `apiKeys.findByHash`
        // resolve `.unique()` over both and THROW, so every call with that key
        // would fail by exception rather than authenticate or be refused. Refuse
        // the entry instead, and say so: the audit row of the previous label is
        // worth more than silently making the deployment unable to answer.
        if (byHash !== null) {
          // The secret is already a key SOMEWHERE ELSE. Refusing the entry is not
          // enough on its own: the colliding key keeps resolving to its original
          // account, and `authenticateApiKey` only consults the declaration for
          // declaration-MANAGED accounts. So a secret declared for a host would go
          // on authenticating with whatever role that other account holds —
          // possibly far wider than `provisioner` — and would survive the
          // declaration being withdrawn.
          //
          // Retire the colliding key. Whoever writes the declaration already holds
          // the authority to create provisioning accounts, so this grants nothing
          // new; it makes a misconfiguration fail closed instead of quietly
          // widening a host's permissions. Loudly, because the operator must know
          // which key stopped working and why.
          if (!byHash.disabled) {
            await ctx.db.patch(byHash._id, { disabled: true });
            console.log(
              `[provision-keys] "${label}" declares a secret already bound to another account — that key is now DISABLED; give the label its own secret`,
            );
          } else {
            console.log(
              `[provision-keys] "${label}" declares a secret bound to another (already disabled) account — refused; give the label its own secret`,
            );
          }
          continue;
        }
        await ctx.db.insert("apiKeys", {
          serviceAccountId: accountId,
          hashedKey: hash,
          // Display-only. NEVER derived from the secret: a prefix taken from the
          // plaintext would leak part of it into every listing and audit row.
          prefix: `declared:${label}`,
          lastFour: "----",
          disabled: false,
          createdAt: Date.now(),
        });
        if (account === null) created += 1;
        else rotated += 1;
      }
      // ROTATION: any other key on this account is a superseded declaration.
      for (const key of keys) {
        if (key.hashedKey === hash || key.disabled) continue;
        await ctx.db.patch(key._id, { disabled: true });
      }
    }

    // Retire any key a QUARANTINED secret collides with, on the same terms as an
    // unambiguous collision. The entry itself stays refused; this only makes sure
    // the key it clashes with cannot outlive the mistake.
    for (const hash of quarantinedHashes ?? []) {
      const colliding = await ctx.db
        .query("apiKeys")
        .withIndex("by_hash", (query) => query.eq("hashedKey", hash))
        .first();
      await retireCollidingKey(ctx, colliding, "(ambiguous entry)");
    }

    // REVOCATION: an account whose label left the declaration. Disabled, never
    // deleted — the trace of what it did must outlive it.
    //
    // Read through the MANAGED index and BOUNDED: walking the whole
    // `serviceAccounts` table in one transaction eventually exceeds Convex's
    // read/write limits, which would make the cron fail durably and leave every
    // declaration unreconciled — the same failure mode the instance-deletion
    // sweep was rebuilt to avoid. A full batch reschedules another pass; only
    // ACTIVE accounts are touched, so the chain converges.
    // PAGINATE BY POSITION, not by progress. Ranging from a cursor is what lets a
    // pass move PAST accounts that are still declared: keying the next pass on
    // "did we revoke anything" stalled the sweep behind a full page of legitimate
    // accounts, and every later withdrawal beyond that page kept its access for
    // ever while the cron re-read the same rows.
    const page = await ctx.db
      .query("serviceAccounts")
      .withIndex("by_managed_disabled", (query) =>
        query.eq("managedBy", PROVISION_KEYS_ENV).eq("disabled", false),
      )
      .paginate({ numItems: REVOKE_BATCH, cursor: cursor ?? null });
    for (const account of page.page) {
      if (wanted.has(account.name.slice("provision:".length))) continue;
      await ctx.db.patch(account._id, { disabled: true });
      revoked += 1;
    }
    return {
      created,
      rotated,
      revoked,
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * Read the declaration, hash each secret, and apply it.
 *
 * An ACTION because hashing is async crypto, which a mutation may not do — the
 * same reason `apiKeys.mintApiKey` is one. The plaintext never leaves this
 * function: the mutation receives hashes only, so no secret can reach a mutation
 * argument, an audit row or a log line.
 */
export const reconcileProvisionKeys = internalAction({
  args: {
    /** Where the revocation sweep resumes. Absent starts at the beginning. */
    cursor: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { cursor: resumeFrom },
  ): Promise<{ applied: number; rejected: string[] }> => {
    const { keys, rejected, quarantined } = parseDeclaredKeys(
      process.env[PROVISION_KEYS_ENV],
    );
    if (rejected.length > 0) {
      // Named, because a silently ignored entry looks exactly like a working one
      // from the platform's side — and the label is not a secret.
      console.log(
        `[provision-keys] ignoring malformed or duplicate entries: ${rejected.join(", ")}`,
      );
    }
    const declared = await Promise.all(
      keys.map(async ({ label, secret }) => ({
        label,
        hash: await hashKey(secret),
      })),
    );
    const quarantinedHashes = await Promise.all(
      quarantined.map((secret) => hashKey(secret)),
    );
    let cursor: string | null = resumeFrom ?? null;
    for (let pass = 0; pass < PASSES_PER_RUN; pass += 1) {
      const outcome: { nextCursor: string | null } = await ctx.runMutation(
        internal.provisionKeys.applyDeclaredKeys,
        {
          declared,
          quarantinedHashes,
          ...(cursor === null ? {} : { cursor }),
        },
      );
      cursor = outcome.nextCursor;
      if (cursor === null) break;
    }
    // RESUME rather than stop. Ending the loop without carrying the cursor meant
    // the next cron started from the beginning and re-walked the same pages for
    // ever, so any withdrawn account past that bound kept its access — the
    // declarative revocation this promises, silently not happening at scale.
    if (cursor !== null) {
      await ctx.scheduler.runAfter(
        0,
        internal.provisionKeys.reconcileProvisionKeys,
        { cursor },
      );
    }
    return { applied: declared.length, rejected };
  },
});

/**
 * Disable ONE key row the declaration no longer vouches for.
 *
 * Targeted on purpose. Running the full reconciliation here instead was an
 * amplification: it does not remove the row from the `by_hash` index — a
 * withdrawal disables the ACCOUNT — so every subsequent request with the revoked
 * key started another complete pass, letting its holder drive hashing, sweeps and
 * mutations up to the pre-authentication rate limit. Disabling the row makes the
 * refusal cheap from the second attempt on.
 */
export const disableDeclaredKey = internalMutation({
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, { keyId }) => {
    const key = await ctx.db.get(keyId);
    if (key === null || key.disabled) return;
    await ctx.db.patch(keyId, { disabled: true });
  },
});
