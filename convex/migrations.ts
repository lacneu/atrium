// One-time data migrations, operator-invoked via `npx convex run`.
//
// stampNullInstanceChats — the R1 backfill for the per-bridge ingest isolation
// rollout. `chats.instanceName` is OPTIONAL; the normal new-chat flow always
// stamps it (useStartNewChat) and dispatch REBINDS a legacy chat on its next
// turn (bindChatTarget), so null-primary chats are a LEGACY-ONLY residue. R2
// (per-bridge-only ingest) denies a null-primary chat, so this stamps them
// FIRST — using the SAME resolver dispatch would (`resolveTargetForChat`), so
// the stamp is behavior-preserving (exactly what the next dispatch would bind).
// A chat whose owner has no resolvable agent is left null: it cannot be
// dispatched, so no bridge will ever ingest for it — leaving it null denies
// nothing real. Idempotent + self-chaining: one invocation drains the table.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { resolveTargetForChat } from "./routing";
import { maskCredentialId } from "./lib/chatRenderState";

const BATCH = 200;

export const stampNullInstanceChats = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    { cursor },
  ): Promise<{ done: boolean; stamped: number; leftNull: number }> => {
    const page = await ctx.db
      .query("chats")
      .paginate({ numItems: BATCH, cursor: cursor ?? null });

    let stamped = 0;
    let leftNull = 0;
    for (const chat of page.page) {
      if (chat.instanceName !== undefined) continue; // already bound — skip
      const resolution = await resolveTargetForChat(ctx, chat, chat.userId);
      if (resolution.target === null) {
        // Underivable (no resolvable agent) → cannot be dispatched → no bridge
        // ingests for it → safe to leave null.
        leftNull++;
        continue;
      }
      await ctx.db.patch(chat._id, {
        instanceName: resolution.target.instanceName,
        agentId: resolution.target.agentId,
        // Behavior-preserving REQUIRES dropping the pre-binding provider
        // session too: without the migration, the next dispatch would rebind
        // via bindChatTarget, which clears it (a session minted before binding
        // may belong to a different agent than the resolved target).
        openclawChatId: undefined,
      });
      stamped++;
    }

    if (!page.isDone) {
      // Self-chain the next batch so ONE invocation drains the whole table.
      await ctx.scheduler.runAfter(0, internal.migrations.stampNullInstanceChats, {
        cursor: page.continueCursor,
      });
    }
    return { done: page.isDone, stamped, leftNull };
  },
});

// Confirm the rollout precondition BEFORE R2 (per-bridge-only): the count of
// chats still lacking an instance binding. R2 is safe to ship once this is the
// residual, underivable-only set (or zero). Convex allows only ONE paginated
// query per function, so this counts ONE page and returns the cursor; re-run
// with it (`{cursor}`) until `done` on a table larger than one page. For the
// legacy-only residue, one call covers it.
export const countNullInstanceChats = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (
    ctx,
    { cursor },
  ): Promise<{ nullInstance: number; scanned: number; done: boolean; cursor: string | null }> => {
    const page = await ctx.db
      .query("chats")
      .paginate({ numItems: 2048, cursor: cursor ?? null });
    return {
      nullInstance: page.page.filter((c) => c.instanceName === undefined).length,
      scanned: page.page.length,
      done: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

// maskStoredCredentialIds — clear the credential id from rows written BEFORE the
// masker existed.
//
// Every door that persists a gateway failure sentence now masks it, so no NEW row can
// hold a profile id. The rows already stored still do, and they are served by a dozen
// readers: the chat query, the sub-agent queries, a feedback snapshot, a sub-agent
// report, the dev helpers. Masking each READER would mean finding all of them and
// keeping that list correct forever (codex enumerated five and did not claim to be
// done). Fixing the ROWS makes every reader safe at once, including the ones nobody
// has written yet.
//
// Idempotent — the masker is a no-op on an already-masked value — and self-chaining,
// one table at a time so each invocation uses ONE paginated query (the Convex rule).
// Two of these are SNAPSHOTS, and that is the point: they FREEZE the sentence, so it
// outlives the row it was copied from. Fixing the live rows alone left a feedback
// report and a sub-agent report holding the id forever (codex) — and the reported
// incident was found IN one of those snapshots.
const CREDENTIAL_TABLES = [
  "messages",
  "subAgents",
  "subAgentInteractions",
  "feedback",
  "subAgentReports",
] as const;

/** How much of a table one transaction may read.
 *
 *  A ROW COUNT is the wrong bound here, and reasoning about which table holds "short"
 *  values was wrong twice: this query reads whole DOCUMENTS, and a message near the 1
 *  MiB document limit, or a sub-agent row with a 128 k-character result, makes any
 *  fixed count unsafe (codex). So the page is bounded in BYTES, well under Convex's 16
 *  MiB per-transaction read limit, with headroom for the patches this mutation then
 *  writes. The row count stays only as a ceiling for tables of small rows.
 *
 *  The cost of being wrong in this direction is a few more scheduled pages. */
const PAGE_BYTES = 4_000_000;

function pageSizeFor(table: (typeof CREDENTIAL_TABLES)[number]): number {
  // A snapshot table's worst-case row (~850 KB for `subAgentReports`: four 10 KB fields
  // per captured child, plus parentText and sessionMetaJson) fits about five times into
  // the byte budget; the count is the cheaper bound to hit first.
  return table === "subAgentReports" || table === "feedback" ? 5 : BATCH;
}

export const maskStoredCredentialIds = internalMutation({
  args: {
    table: v.optional(
      v.union(
        v.literal("messages"),
        v.literal("subAgents"),
        v.literal("subAgentInteractions"),
        v.literal("feedback"),
        v.literal("subAgentReports"),
      ),
    ),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (
    ctx,
    { table, cursor },
  ): Promise<{ done: boolean; table: string; masked: number }> => {
    const current = table ?? CREDENTIAL_TABLES[0];
    // BOUNDED IN BYTES as well as in rows — see `pageSizeFor`. A page that exceeds the
    // transaction's read limit throws before scheduling the next one, which leaves the
    // backfill silently unfinished (codex).
    const page = await ctx.db.query(current).paginate({
      numItems: pageSizeFor(current),
      maximumBytesRead: PAGE_BYTES,
      cursor: cursor ?? null,
    });

    let masked = 0;
    for (const row of page.page) {
      if (current === "messages") {
        const before = (row as { error?: string }).error;
        const after = maskCredentialId(before);
        if (after !== before) {
          await ctx.db.patch(row._id, { error: after });
          masked++;
        }
      } else if (current === "feedback") {
        // `row` is a union across the tables above, so the table name alone does not
        // narrow it — the cast is what tells the compiler which document this is.
        const fb = row as Doc<"feedback">;
        const before = fb.snapshot.messageError;
        const after = maskCredentialId(before);
        if (after !== before) {
          await ctx.db.patch(fb._id, {
            snapshot: { ...fb.snapshot, messageError: after },
          });
          masked++;
        }
      } else if (current === "subAgentReports") {
        const rep = row as Doc<"subAgentReports">;
        const children = rep.snapshot.children;
        const next = children.map((c) => ({
          ...c,
          errorMessage: maskCredentialId(c.errorMessage),
        }));
        if (next.some((c, i) => c.errorMessage !== children[i]?.errorMessage)) {
          await ctx.db.patch(rep._id, {
            snapshot: { ...rep.snapshot, children: next },
          });
          masked++;
        }
      } else {
        const before = (row as { errorMessage?: string }).errorMessage;
        const after = maskCredentialId(before);
        if (after !== before) {
          await ctx.db.patch(row._id, { errorMessage: after });
          masked++;
        }
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.maskStoredCredentialIds, {
        table: current,
        cursor: page.continueCursor,
      });
    } else {
      // …and on to the next table, so ONE invocation drains all five.
      const next = CREDENTIAL_TABLES[CREDENTIAL_TABLES.indexOf(current) + 1];
      if (next !== undefined) {
        await ctx.scheduler.runAfter(0, internal.migrations.maskStoredCredentialIds, {
          table: next,
        });
      }
    }
    return { done: page.isDone, table: current, masked };
  },
});
