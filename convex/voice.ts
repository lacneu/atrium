import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireActive } from "./lib/access";
import { parseInstanceConfig } from "./lib/instanceConfig";

/** The voice (read-aloud) settings the CHAT surface needs — resolved from the
 *  chat's instance config. Owner-scoped (any chat member reads their own chat);
 *  exposes ONLY the voice fields, never the whole instance config (that stays
 *  admin-only). Null chat/instance → disabled defaults.
 *
 *  KNOWN LIMIT: a per-turn-routed chat (multi-agent) resolves voice from the
 *  chat's PRIMARY instance — replies routed to another instance read with the
 *  primary's settings. Refining to per-message resolution is a follow-up. */
export const voiceConfigForChat = query({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const disabled = {
      enabled: false,
      lang: "auto" as string,
      rate: 1,
      autoRead: false,
    };
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return disabled;
    const chat = await ctx.db.get(id);
    if (chat === null) return disabled;
    if (chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
    // Legacy chats (pre multi-instance) carry no instanceName yet still route
    // to a gateway. When the deployment has a SINGLE instance, that is
    // unambiguously the one — resolve to it; with several, stay disabled
    // rather than guess (codex P2).
    let inst = chat.instanceName
      ? await ctx.db
          .query("instances")
          .withIndex("by_name", (q) => q.eq("name", chat.instanceName!))
          .first()
      : null;
    if (inst === null && !chat.instanceName) {
      const all = await ctx.db.query("instances").take(2);
      if (all.length === 1) inst = all[0] ?? null;
    }
    if (inst === null) return disabled;
    const cfg = parseInstanceConfig(inst.config);
    if (cfg === "invalid") return disabled;
    return {
      enabled: cfg.voiceEnabled === true,
      lang: cfg.voiceLang ?? "auto",
      rate: cfg.voiceRate ?? 1,
      autoRead: cfg.voiceAutoRead === true,
    };
  },
});
