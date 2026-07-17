// Cross-conversation references: copy a chat's REFERENCE from the sidebar,
// paste it into another chat's composer, and the referenced conversation is
// attached as a markdown FILE the agent can read — including across gateways
// (every instance's chats live in this same deployment).
//
// The reference format is the deployment's env-labeled identifier family
// (`<label>-<id>`, same as feedback.displayReference / oc_<label>_ API keys):
// one glance says WHERE it came from, and the server stays the single source
// of the format. Resolution is OWNER-scoped and silent: an unknown or foreign
// reference resolves to null (no existence leak) and the composer falls back
// to pasting plain text.

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { Doc } from "./_generated/dataModel";
import { getProfile, requireActive } from "./lib/access";
import { envLabel, formatChatReference } from "./lib/envLabel";
import { resolveLocale, type Locale } from "./lib/locales";
import { compareOrder } from "./lib/messageOrder";

// Bounded export: the newest window of the conversation, capped in messages
// AND characters (attachment pipelines enforce gateway payload caps ~1MiB —
// an export must never be the thing that trips them). Truncation keeps the
// RECENT end and says so in the header.
export const EXPORT_MESSAGE_CAP = 400;
export const EXPORT_CHAR_CAP = 700_000;

/** The deployment's reference label (prefetched by the sidebar so the
 *  clipboard write stays INSIDE the user activation — codex P1). */
export const referenceLabel = query({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    await requireActive(ctx);
    return envLabel();
  },
});

/** The copyable reference of one of the caller's chats. */
export const getChatReference = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<string> => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    if (!chat || chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
    return formatChatReference(envLabel(), chatId);
  },
});

// Export framing labels, localized to the READER's effective UI locale
// (user pref -> admin default -> base) — an English-configured account must
// not receive a French-framed transcript (codex P2). The transcript BODY
// stays verbatim whatever the locale.
const FRAMING: Record<
  Locale,
  {
    title: string;
    reference: string;
    agent: string;
    instance: string;
    exportedAt: string;
    count: string;
    truncNote: string;
    untitled: string;
    user: string;
    assistant: string;
    noText: string;
    inProgress: string;
    msgTruncated: string;
    inReplyTo: string;
  }
> = {
  fr: {
    title: "Conversation",
    reference: "Référence",
    agent: "Agent",
    instance: "instance",
    exportedAt: "Exportée le",
    count: "Messages exportés",
    truncNote:
      "Note : conversation tronquée — seuls les messages les plus récents sont inclus.",
    untitled: "(sans titre)",
    user: "Utilisateur",
    assistant: "Assistant",
    noText: "*(message sans texte — fichiers/media)*",
    inProgress: "*(réponse en cours au moment de l'export)*",
    msgTruncated: "*[… message tronqué]*",
    inReplyTo: "En réponse à",
  },
  en: {
    title: "Conversation",
    reference: "Reference",
    agent: "Agent",
    instance: "instance",
    exportedAt: "Exported at",
    count: "Messages exported",
    truncNote:
      "Note: conversation truncated — only the most recent messages are included.",
    untitled: "(untitled)",
    user: "User",
    assistant: "Assistant",
    noText: "*(message without text — files/media)*",
    inProgress: "*(reply still streaming at export time)*",
    msgTruncated: "*[… message truncated]*",
    inReplyTo: "In reply to",
  },
};

/** UTF-8 byte length (Convex value + attachment caps are BYTE-based; a
 *  char-counted budget under-measures CJK/emoji text — codex P2). */
function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes on a codepoint boundary. */
export function sliceUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const cut = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.slice(0, maxBytes),
  );
  // A codepoint split at the cut decodes to a trailing replacement char.
  return cut.replace(/\uFFFD+$/, "");
}

/** Strip an optional env-label prefix (`dev-`, `prod-`…) from a pasted
 *  reference. Pure; the label grammar mirrors lib/envLabel. */
export function stripReferenceLabel(reference: string): string {
  const match = /^([a-z0-9][a-z0-9_.]{0,15})-(.+)$/.exec(reference.trim());
  return match !== null ? match[2]! : reference.trim();
}

/**
 * Resolve a pasted reference to a markdown export of the caller's OWN chat.
 * Null (never an error) for anything else: a malformed id, another user's
 * chat, another deployment's reference — the composer then just pastes text.
 */
export const exportByReference = query({
  args: { reference: v.string() },
  handler: async (
    ctx,
    { reference },
  ): Promise<{ filename: string; markdown: string } | null> => {
    const { userId } = await requireActive(ctx);
    const raw = stripReferenceLabel(reference);
    const chatId = ctx.db.normalizeId("chats", raw);
    if (chatId === null) return null;
    const chat = await ctx.db.get(chatId);
    if (!chat || chat.userId !== userId) return null;
    const profile = await getProfile(ctx, userId);
    const meta = await ctx.db.query("appMeta").first();
    const L =
      FRAMING[resolveLocale(profile?.locale, meta?.defaultLocale)];

    // PAGINATED collection, newest-first, stopped as soon as EITHER budget is
    // spent — .take(EXPORT_MESSAGE_CAP) up front would load 400 full bodies
    // (potentially several MB) before the char cap even ran, risking the
    // function READ limit instead of the promised truncated export (codex P2).
    const collected: Doc<"messages">[] = [];
    let cursor: number | null = null;
    // COLLECTION budget carries a 25% margin over the assembly budget: the
    // scan runs in _creationTime order while truncation semantics follow the
    // LOGICAL order (a parked queued follow-up is created EARLY but sits at
    // the logical end) — the margin keeps such boundary turns collectable;
    // the byte-exact assembly below enforces the real cap (codex P2).
    let budgetLeft = EXPORT_CHAR_CAP + EXPORT_CHAR_CAP / 4;
    let truncated = false;
    // SMALL pages (8): Convex caps a document at ~1MiB and the transaction's
    // total read size — a 50-doc page of near-cap bodies could trip the read
    // limit before the char budget even ran (codex P2).
    const PAGE = 8;
    // Hard page bound: system rows count toward NO other budget, so a
    // system-heavy legacy history could otherwise page through its whole
    // length and trip the function read limits (codex P2).
    const MAX_PAGES = 120;
    let pages = 0;
    outer: while (collected.length < EXPORT_MESSAGE_CAP) {
      if (pages++ >= MAX_PAGES) {
        truncated = true;
        break;
      }
      const after: number | null = cursor;
      const page = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) =>
          after === null
            ? q.eq("chatId", chatId)
            : q.eq("chatId", chatId).lt("_creationTime", after),
        )
        .order("desc")
        .take(PAGE);
      if (page.length === 0) break;
      for (const msg of page) {
        cursor = msg._creationTime;
        if (msg.role === "system") continue;
        if (collected.length >= EXPORT_MESSAGE_CAP || budgetLeft <= 0) {
          truncated = true; // rows remain past the stop point
          break outer;
        }
        collected.push(msg);
        budgetLeft -= utf8Len(msg.text ?? "") + 80;
      }
      if (page.length < PAGE) break;
    }
    if (!truncated && (budgetLeft <= 0 || collected.length >= EXPORT_MESSAGE_CAP)) {
      // Stopped by a budget/cap estimate: only claim truncation if an OLDER
      // VISIBLE row actually exists (codex P2 — a chat that exactly fills a
      // budget must not say "only the most recent are included"). System
      // rows are excluded content, not omissions: skip them within a bound
      // (codex P2 — a run of system rows must not mask a visible one).
      let probeCursor: number | null = cursor;
      for (let hop = 0; hop < 5 && !truncated; hop++) {
        const after2: number | null = probeCursor;
        const beyond = await ctx.db
          .query("messages")
          .withIndex("by_chat", (q) =>
            after2 === null
              ? q.eq("chatId", chatId)
              : q.eq("chatId", chatId).lt("_creationTime", after2),
          )
          .order("desc")
          .take(8);
        if (beyond.length === 0) break;
        if (beyond.some((msgRow) => msgRow.role !== "system")) {
          truncated = true;
          break;
        }
        probeCursor = beyond[beyond.length - 1]!._creationTime;
        // Bound reached with rows still unread: err on claiming truncation
        // (a benign over-claim beats silently omitting a visible message).
        if (hop === 4 && beyond.length === 8) truncated = true;
      }
    }
    // Chronological reading order. compareOrder (not bare effectiveOrder):
    // queued follow-ups share the ORDER SENTINEL, and only its _creationTime
    // tie-break keeps their FIFO order (codex P2).
    collected.sort(compareOrder);

    // Per-turn attribution: a routed chat stamps routedAgentId on the USER
    // turn; the assistant reply inherits the last one seen (Track A rule) —
    // labeling every reply with the chat's primary agent would hand the
    // reading agent a wrong provenance on multi-agent chats (codex P2).
    const whoByIndex: string[] = [];
    // On a ROUTED chat, replies before the window's first routed user turn
    // have UNKNOWN provenance (their user turn fell outside the window):
    // label them a bare "Assistant" rather than mis-attributing the primary
    // agent (codex P2). Single-agent chats keep the precise label.
    const hasRouting =
      chat.perTurnRouting === true ||
      collected.some(
        (msgRow) =>
          msgRow.role === "user" && msgRow.routedAgentId !== undefined,
      );
    // Every USER turn resets the attribution: an unrouted turn on a routed
    // chat explicitly means the PRIMARY agent (the first turns of a chat
    // that later went multi-agent — codex P2). Only a reply with NO user
    // turn inside the window (true truncation boundary) stays unattributed.
    let lastRouted: string | null = null;
    let lastRoutedInstance: string | null = null;
    for (const msg of collected) {
      if (msg.role === "user") {
        lastRouted = msg.routedAgentId ?? chat.agentId ?? null;
        // The routed pair is (instance, agent): the same agent id can exist
        // on several gateways (codex P2). Only shown when it differs from
        // the chat's primary instance.
        lastRoutedInstance =
          msg.routedAgentId !== undefined
            ? (msg.routedInstanceName ?? null)
            : null;
      }
      const agentLabel = lastRouted ?? (hasRouting ? null : chat.agentId);
      const instanceSuffix =
        lastRoutedInstance !== null && lastRoutedInstance !== chat.instanceName
          ? ` @ ${lastRoutedInstance}`
          : "";
      whoByIndex.push(
        msg.role === "user"
          ? L.user
          : agentLabel !== null
            ? `${L.assistant} (${agentLabel}${instanceSuffix})`
            : L.assistant,
      );
    }

    // A still-STREAMING turn keeps its visible text in streamingText until
    // finalize — exporting mid-turn must ship that text, not "sans texte"
    // (codex P2). At most one or two live rows per chat.
    const liveText = new Map<string, string>();
    for (const msg of collected) {
      if (msg.status !== "streaming") continue;
      const live = await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", msg._id))
        .first();
      if (live !== null && live.text.length > 0) {
        liveText.set(msg._id, live.text);
      }
    }

    // Assemble from the NEWEST end within the char budget; the boundary
    // message (and even a single over-budget giant) is itself truncated so
    // the export always carries the promised recent content (codex P2).
    const sections: string[] = [];
    let remaining = EXPORT_CHAR_CAP; // UTF-8 BYTES (codex P2)
    for (let i = collected.length - 1; i >= 0; i--) {
      const msg = collected[i]!;
      const streamed = liveText.get(msg._id);
      // VERBATIM body: no trim — leading/trailing whitespace can be
      // significant (indented code) and the feature promises the transcript
      // as-is (codex P2). Emptiness alone is tested on a trimmed copy.
      const raw = streamed ?? msg.text ?? "";
      let text = raw.trim().length === 0 ? L.noText : raw;
      if (streamed !== undefined) {
        text += `\n\n${L.inProgress}`;
      }
      // Quote-reply context: without it "corrige ceci" is ambiguous to the
      // reading agent (codex P2). One blockquote line; the excerpt is
      // single-line by construction (previewFromText, server-capped).
      if (msg.role === "user" && msg.quotedExcerpt !== undefined) {
        text = `> ${L.inReplyTo} : ${msg.quotedExcerpt}\n\n${text}`;
      }
      const head = `### ${whoByIndex[i]} — ${new Date(msg.updatedAt).toISOString()}\n\n`;
      const cost = utf8Len(head) + utf8Len(text) + 2;
      if (cost > remaining) {
        const room = remaining - utf8Len(head) - 60;
        if (room > 200) {
          sections.push(
            head + sliceUtf8(text, room) + `\n\n${L.msgTruncated}\n`,
          );
        }
        truncated = true;
        break;
      }
      remaining -= cost;
      sections.push(head + text + "\n");
    }
    sections.reverse();

    const ref = formatChatReference(envLabel(), chatId);
    const header =
      `# ${L.title} : ${chat.title ?? L.untitled}\n\n` +
      `- ${L.reference} : ${ref}\n` +
      `- ${L.agent} : ${chat.agentId} (${L.instance} ${chat.instanceName})\n` +
      `- ${L.exportedAt} : ${new Date(Date.now()).toISOString()}\n` +
      `- ${L.count} : ${sections.length}\n` +
      (truncated ? `- ${L.truncNote}\n` : "") +
      `\n---\n\n`;
    return {
      filename: `conversation-${ref}.md`,
      markdown: header + sections.join("\n"),
    };
  },
});
