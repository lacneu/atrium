// Global conversation search (topbar palette). Full-text over the caller's own
// message bodies + an in-JS match over their chat titles, returned as a bounded,
// ranked, one-row-per-chat result set the command palette renders.
//
// ACCESS CONTROL (load-bearing): every result branch is scoped to the EFFECTIVE
// user — message hits via the search index's `userId` filter field, title hits
// via the `by_user`-loaded chat set. There is exactly one identity gate per
// branch; dropping either would leak another user's content.
//
// IMPERSONATION: scoped to the effective user (impersonation-aware), exactly
// like `messages.listByChat` — an admin "acting as" a user searches that user's
// conversations. This is a READ; like every other read in this app it is NOT
// audited (queries cannot write, and we keep reads side-effect-free). Only
// cross-identity WRITES are audited (see lib/audit).
//
// PHI: returns the caller's OWN message snippets to the caller — same exposure
// as listByChat. Never logged.

import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireActive } from "./lib/access";
import {
  buildSnippet,
  queryTerms,
  titleMatches,
  type SearchHit,
} from "./lib/search";

// Below this length a query is a no-op (avoids indexing-noise + empty-token
// matches). Mirrored client-side as the "skip" threshold.
const MIN_QUERY_LEN = 2;
// Bounded reads (Convex guideline: never unbounded). Message hits pulled from
// the index, and the final result cap the palette renders.
const MESSAGE_HITS = 40;
const MAX_RESULTS = 25;

export const searchConversations = query({
  args: { query: v.string() },
  handler: async (ctx, { query: rawQuery }): Promise<SearchHit[]> => {
    const { userId } = await requireActive(ctx);
    const trimmed = rawQuery.trim();
    if (trimmed.length < MIN_QUERY_LEN) return [];
    const terms = queryTerms(trimmed);

    // The caller's chats, loaded once (bounded by sidebar size). Serves BOTH as
    // the title-match source and as the owner-scoped lookup that resolves a
    // message hit's chat title — a message whose chat is not in this set is not
    // owned by the caller and is dropped.
    const chats = await ctx.db
      .query("chats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const chatById = new Map(chats.map((c) => [c._id, c]));

    const results: SearchHit[] = [];
    const seen = new Set<string>();

    // 1) Title matches first — the strongest "this conversation is about X"
    // signal. Recency-ordered for a stable list.
    const titleSorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const chat of titleSorted) {
      if (chat.archived) continue;
      if (!titleMatches(chat.title, terms)) continue;
      if (seen.has(chat._id)) continue;
      seen.add(chat._id);
      results.push({
        chatId: chat._id,
        title: chat.title ?? null,
        snippet: "",
        matchedIn: "title",
        at: chat.updatedAt,
      });
      if (results.length >= MAX_RESULTS) return results;
    }

    // 2) Full-text message hits, in the index's relevance order, SCOPED to the
    // caller via the `userId` filter field. One row per chat (best hit wins).
    const msgHits = await ctx.db
      .query("messages")
      .withSearchIndex("search_text", (q) =>
        q.search("text", trimmed).eq("userId", userId),
      )
      .take(MESSAGE_HITS);

    for (const m of msgHits) {
      const chat = chatById.get(m.chatId);
      if (!chat || chat.archived) continue; // owner-scoped + skip archived
      if (seen.has(m.chatId)) continue;
      seen.add(m.chatId);
      results.push({
        chatId: m.chatId,
        title: chat.title ?? null,
        snippet: buildSnippet(m.text, terms),
        matchedIn: "message",
        role: m.role,
        at: m._creationTime,
      });
      if (results.length >= MAX_RESULTS) break;
    }

    return results;
  },
});
