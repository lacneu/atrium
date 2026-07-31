// Keep a SESSION's refresh-token chain bounded, so signing in keeps working.
//
// FOUND THE HARD WAY (2026-07-31). Sign-in failed with:
//
//   Uncaught Error: Too many reads in a single function execution (limit: 4096)
//     at deleteAllRefreshTokens (@convex-dev/auth/.../refreshTokens.ts)
//     at refreshSessionImpl → signInImpl
//
// `deleteAllRefreshTokens` collects EVERY refresh token of ONE session through the
// `sessionIdAndParentRefreshTokenId` index and deletes them in a loop. It is not
// paginated. The library mints a new token on every refresh and chains it to its
// parent; nothing ever prunes the chain. So a single long-lived session grows past
// 4096 tokens and its next refresh cannot complete — and because that runs inside
// sign-in, NOBODY using that session can log in again. The error names a library
// internal, so the cause is invisible from the symptom.
//
// This is a slow fuse on any long-lived deployment, not a dev-machine curiosity: the
// count grows with ordinary use, the limit is fixed, and it lands on the login path.
//
// THE FIRST VERSION OF THIS FILE WAS WRONG, and the way it was wrong is worth
// keeping: it deleted EXPIRED tokens table-wide with `.take(N)`. Without an index
// that re-reads the same first rows on every run, so it freed 2982 stale rows,
// reported "0 deleted", and never touched the session that was actually blocking —
// a prune that terminates without fixing anything looks exactly like success.
// Bounding the CHAIN is what the failing call actually needs.

import { internalMutation } from "./_generated/server";

/** Tokens kept per session, newest first. The library only ever needs the current
 *  one plus a little slack for in-flight refreshes; everything older is history that
 *  only serves to make the next `deleteAllRefreshTokens` heavier. */
const KEEP_PER_SESSION = 16;

/** Sessions examined per run, and tokens deleted per run. Both bounded so the prune
 *  can never hit the limit it exists to prevent — the same mistake, one table over. */
const SESSIONS_PER_RUN = 256;
const DELETES_PER_RUN = 1024;

/**
 * Trim every session's refresh-token chain to `KEEP_PER_SESSION`.
 *
 * Returns counts rather than logging them: the cron history then shows whether the
 * chains are actually shrinking, which is the only way to notice the budget is too
 * small for this deployment's refresh rate BEFORE sign-in breaks again.
 */
export const pruneRefreshTokenChains = internalMutation({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db.query("authSessions").take(SESSIONS_PER_RUN);
    let deleted = 0;
    let trimmedSessions = 0;
    for (const session of sessions) {
      if (deleted >= DELETES_PER_RUN) break;
      // The SAME index the failing call uses, so what is measured here is what that
      // call will have to read.
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionIdAndParentRefreshTokenId", (q) =>
          q.eq("sessionId", session._id),
        )
        .take(DELETES_PER_RUN + KEEP_PER_SESSION);
      if (tokens.length <= KEEP_PER_SESSION) continue;
      // Newest kept: `_creationTime` is the only ordering that survives a chain whose
      // parent links may be broken by an earlier partial delete.
      const ordered = [...tokens].sort(
        (a, b) => b._creationTime - a._creationTime,
      );
      trimmedSessions += 1;
      for (const doc of ordered.slice(KEEP_PER_SESSION)) {
        if (deleted >= DELETES_PER_RUN) break;
        await ctx.db.delete(doc._id);
        deleted += 1;
      }
    }
    return { sessions: sessions.length, trimmedSessions, deleted };
  },
});
