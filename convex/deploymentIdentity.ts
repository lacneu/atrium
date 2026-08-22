// Mint + read this deployment's identity. See lib/deploymentIdentity for what the
// value means and, more importantly, what it does NOT mean.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  query,
} from "./_generated/server";
import { requireActive } from "./lib/access";

/** Rows examined per commit. One in every normal state; more only after a restore
 *  that merged two databases. */
const MERGED_ROW_SCAN = 16;
import {
  DEPLOYMENT_ID_BYTES,
  formatDeploymentId,
  pickReconciledIdentity,
  readDeploymentOrigin,
} from "./lib/deploymentIdentity";

/**
 * Commit a freshly generated identity, deciding whether this deployment already
 * has one.
 *
 * THE SERIALISATION POINT. Two callers racing to mint each arrive with their own
 * candidate; the first write wins and the second reads it back, so a deployment
 * cannot end up with two identities. An identity that changed WITHIN one
 * deployment would make its own earlier archives read as foreign, silently
 * dropping the reattachment they were exported to keep.
 *
 * The one case that DOES replace it is a database restored into a different
 * deployment. The row travels with the data, so without this the clone and the
 * original would share an identity — and each would read the other's archives as
 * local, reattaching them to agents and instances that mean something else there.
 * A mismatched origin is therefore re-minted rather than kept: the worst that
 * costs is that archives exported before the move read as foreign, which is the
 * safe outcome by construction (foreign means readable, never reattached).
 */
export const commitDeploymentId = internalMutation({
  args: {
    candidate: v.string(),
    origin: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { candidate, origin }): Promise<string | null> => {
    // Bounded: a singleton in every normal state. More than one row can only come
    // from a restore that merged two databases, and the extras are collapsed
    // below; a pathological count converges over successive calls rather than
    // reading an unbounded table here.
    const rows = await ctx.db.query("deploymentIdentity").take(MERGED_ROW_SCAN);
    if (rows.length === 0) {
      await ctx.db.insert("deploymentIdentity", {
        deploymentId: candidate,
        mintedForOrigin: origin,
        mintedAt: Date.now(),
      });
      return candidate;
    }

    // WHICH row speaks for this deployment. Picking the first one arbitrarily
    // would, on a merged restore, re-mint over a row that already matches this
    // origin and delete the correct one — orphaning local archives for nothing.
    const matching =
      origin === null
        ? undefined
        : rows.find((row) => row.mintedForOrigin === origin);
    const unstamped = rows.find((row) => row.mintedForOrigin === null);
    const keep = matching ?? unstamped ?? rows[0]!;

    // AMBIGUITY IS NOT A DECISION. More than one row means a restore merged two
    // databases, and unless one of them positively speaks for THIS deployment we
    // cannot tell which. Keeping an arbitrary one would adopt some other
    // deployment's identity — its archives would then read as local here, which is
    // the single failure this whole mechanism exists to prevent — and the
    // convergence below would delete the evidence. A full window is the same
    // problem: the row that matches could be just past its edge.
    //
    // So nothing is decided and nothing is destroyed; the state is reported and
    // left for a human, exactly as a duplicate service account is.
    if (
      matching === undefined &&
      (rows.length > 1 || rows.length === MERGED_ROW_SCAN)
    ) {
      console.warn(
        `[deployment-identity] ${rows.length} identities in this database — ` +
          "leaving them alone; resolve the merge by hand",
      );
      // NULL, not one of them. Answering with an arbitrary identity is as harmful
      // as writing one: the caller stamps it onto an exported archive, and that
      // archive then reads as local wherever the same value lives. No identity is
      // the honest answer, and it is the safe one — an archive that states no
      // origin is treated as foreign: readable, never reattached.
      return null;
    }

    // A row minted here, but before the backend reported an origin. Record it now
    // WITHOUT touching the identity: leaving it null forever would make every
    // later restore undetectable, which is the one thing this field exists for.
    const backfilling =
      matching === undefined && unstamped !== undefined && origin !== null;
    // Nothing here speaks for this deployment: the database was restored
    // elsewhere. Re-mint, so the clone and its original are not confused. The cost
    // is that archives exported before the move read as foreign — the safe
    // outcome by construction, since foreign means readable, never reattached.
    const movedDeployments =
      matching === undefined && unstamped === undefined && origin !== null;

    if (movedDeployments) {
      console.warn(
        "[deployment-identity] this database was minted for another deployment — " +
          "minting a fresh identity so the two are not confused",
      );
      await ctx.db.patch(keep._id, {
        deploymentId: candidate,
        mintedForOrigin: origin,
        mintedAt: Date.now(),
      });
    } else if (backfilling) {
      await ctx.db.patch(keep._id, { mintedForOrigin: origin });
    }

    // Converge to one row whatever happened: a table that is not a singleton makes
    // every later read a coin toss.
    for (const stale of rows) {
      if (stale._id !== keep._id) await ctx.db.delete(stale._id);
    }
    return movedDeployments ? candidate : keep.deploymentId;
  },
});

/**
 * The deployment's identity, minting it on first use. IDEMPOTENT.
 *
 * `null` when this database holds an unresolved merge of several deployments:
 * there is then no identity to speak of, and saying so is what keeps an archive
 * exported from here from claiming someone else's.
 *
 * An ACTION, because the entropy is the point. A CSPRNG read is non-deterministic,
 * and a mutation is re-executed on write conflict — so whatever randomness a
 * mutation hands back cannot be assumed independent across deployments. Two
 * deployments sharing an identity is precisely the failure this value exists to
 * prevent, and this file's neighbours (`lib/apikeys`) already record the rule.
 * Generating here and committing there costs one indirection and removes the
 * question.
 */
export const ensureDeploymentId = internalAction({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const bytes = new Uint8Array(DEPLOYMENT_ID_BYTES);
    crypto.getRandomValues(bytes);
    return await ctx.runMutation(
      internal.deploymentIdentity.commitDeploymentId,
      {
        candidate: formatDeploymentId(bytes),
        origin: readDeploymentOrigin(),
      },
    );
  },
});

/**
 * Read the identity without minting one. `null` when this deployment has never
 * minted one.
 *
 * Readable by any active user: it is not a secret, and an operator comparing an
 * archive's origin against this deployment needs to see it. It is still behind
 * authentication, because an unauthenticated caller has no business enumerating
 * which deployment they have reached.
 */
export const getDeploymentId = query({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    await requireActive(ctx);
    const rows = await ctx.db.query("deploymentIdentity").take(MERGED_ROW_SCAN);
    // A query cannot reconcile — it cannot write. What it CAN do is decline to
    // vouch for an identity it has not seen reconciled: after a database is
    // restored from another deployment, the stored row still names that other
    // deployment, and answering with it would make ITS archives read as local
    // here. "Cannot say" is the safe answer, because an archive of unknown origin
    // is treated as foreign — readable, never reattached.
    return pickReconciledIdentity(rows, readDeploymentOrigin());
  },
});
