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
import { requireOwnedProject } from "./projects";
import { pathOf, subtreeIds } from "./lib/folderTree";
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
// Folder-scoped searches post-filter the index hits (messages carry no
// projectId — denormalizing it would rewrite every message on a folder move),
// so pull a LARGER relevance window to compensate. HONEST RECALL LIMIT: an
// in-folder message hit ranked beyond this global top-N is missed; titles are
// exhaustive over the scope either way.
const SCOPED_MESSAGE_HITS = 100;
const MAX_RESULTS = 25;

export const searchConversations = query({
  args: {
    query: v.string(),
    // Scope the search to ONE folder subtree (the folder page's search box).
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, { query: rawQuery, projectId }): Promise<SearchHit[]> => {
    const { userId } = await requireActive(ctx);
    const trimmed = rawQuery.trim();
    if (trimmed.length < MIN_QUERY_LEN) return [];
    const terms = queryTerms(trimmed);

    // The caller's folders — resolves every hit's projectPath, and (when
    // scoped) the subtree the results must belong to. Owner-bounded read.
    if (projectId !== undefined) {
      await requireOwnedProject(ctx, userId, projectId);
    }
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const projectRows = projects.map((p) => ({
      _id: p._id as string,
      parentId: (p.parentId ?? null) as string | null,
      name: p.name,
      sortKey: p.sortKey ?? 0,
    }));
    const scopeFolders =
      projectId !== undefined
        ? new Set(subtreeIds(projectRows, projectId))
        : null;
    // Path cache: chats sharing a folder share the computed path.
    const pathCache = new Map<string, string[]>();
    const projectPathOf = (pid: string | undefined): string[] | undefined => {
      if (pid === undefined) return undefined;
      const cached = pathCache.get(pid);
      if (cached !== undefined) return cached;
      const path = pathOf(projectRows, pid).map((n) => n.name);
      pathCache.set(pid, path);
      return path.length > 0 ? path : undefined;
    };

    // The caller's chats, loaded once (bounded by sidebar size). Serves BOTH as
    // the title-match source and as the owner-scoped lookup that resolves a
    // message hit's chat title — a message whose chat is not in this set is not
    // owned by the caller and is dropped.
    const chats = (
      await ctx.db
        .query("chats")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    ).filter(
      (c) =>
        c.kind === undefined && // hidden utility chats (documentary/summarizer) — never in
        // search (mirrors the sidebar exclusion). Filtering the SET here covers BOTH the
        // title-match loop AND the message-hit path (its chat lookup uses chatById below,
        // so a hit in a documentary chat resolves to undefined and is dropped).
        // Folder scope: only chats of the requested subtree survive — this set
        // gates titles AND message hits, so ONE membership rule covers both.
        (scopeFolders === null ||
          (c.projectId !== undefined && scopeFolders.has(c.projectId))),
    );
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
        projectPath: projectPathOf(chat.projectId),
      });
      if (results.length >= MAX_RESULTS) return results;
    }

    // 2) Full-text message hits, in the index's relevance order, SCOPED to the
    // caller via the `userId` filter field. One row per chat (best hit wins).
    // Folder scope is a POST-filter through chatById (see the recall note on
    // SCOPED_MESSAGE_HITS above).
    const msgHits = await ctx.db
      .query("messages")
      .withSearchIndex("search_text", (q) =>
        q.search("text", trimmed).eq("userId", userId),
      )
      .take(scopeFolders === null ? MESSAGE_HITS : SCOPED_MESSAGE_HITS);

    for (const m of msgHits) {
      const chat = chatById.get(m.chatId);
      if (!chat || chat.archived) continue; // owner-scoped + skip archived
      if (seen.has(m.chatId)) continue;
      seen.add(m.chatId);
      results.push({
        chatId: m.chatId,
        // The matched MESSAGE: selecting the hit lands the thread exactly on it
        // (?m=<id> scroll+flash + exact-term highlight). A hit OLDER than the
        // thread's loaded window simply opens the chat (the focus hook already
        // gives up gracefully after ~6s — the established ?m contract shared
        // with notification deep-links). Deliberately NO server-side window
        // probe: it would read up to WINDOW rows per distinct chat hit on every
        // keystroke of the palette (codex perf P2 beat the honesty P2).
        messageId: m._id,
        title: chat.title ?? null,
        snippet: buildSnippet(m.text, terms),
        matchedIn: "message",
        role: m.role,
        at: m._creationTime,
        projectPath: projectPathOf(chat.projectId),
      });
      if (results.length >= MAX_RESULTS) break;
    }

    return results;
  },
});
