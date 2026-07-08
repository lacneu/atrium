import { v } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireActive } from "./lib/access";
import { parseInstanceConfig } from "./lib/instanceConfig";
import { postBridge } from "./agentFiles";

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
      engine: "browser" as string,
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
      // The gateway engine only exists on providers with a synthesize RPC —
      // a hermes instance resolves to browser whatever its config says.
      engine:
        cfg.voiceEngine === "gateway" &&
        (inst as { kind?: string }).kind !== "hermes"
          ? "gateway"
          : "browser",
    };
  },
});

/** INTERNAL: chat-member gate + the routing facts the gateway-TTS action needs
 *  (instance name, its bridge URL, and whether the instance opted into the
 *  gateway engine). Throws on foreign chats. */
export const gatewayTtsRoute = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) throw new Error("chat not found");
    const chat = await ctx.db.get(id);
    if (chat === null) throw new Error("chat not found");
    if (chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }
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
    if (inst === null) throw new Error("no instance for chat");
    const cfg = parseInstanceConfig(inst.config);
    return {
      instanceName: inst.name,
      bridgeUrl:
        typeof (inst as { bridgeUrl?: unknown }).bridgeUrl === "string"
          ? ((inst as { bridgeUrl?: string }).bridgeUrl ?? null)
          : null,
      engineEnabled:
        cfg !== "invalid" &&
        cfg.voiceEnabled === true &&
        cfg.voiceEngine === "gateway" &&
        (inst as { kind?: string }).kind !== "hermes",
    };
  },
});

/** Synthesize `text` with the CHAT INSTANCE's gateway voice (OpenClaw
 *  tts.convert via the bridge). Returns small base64 audio for direct
 *  playback. Guarded: chat membership + the instance must have opted into the
 *  gateway engine; text bounded (the read-aloud use case, not batch TTS). */
export const gatewayTts = action({
  args: { chatId: v.string(), text: v.string() },
  handler: async (
    ctx,
    { chatId, text },
  ): Promise<{ mime: string; audioBase64: string }> => {
    // Read-aloud clips only: ~1500 chars ≈ 90s of 48kbps mp3 ≈ ~700KB base64
    // — safely inside the Convex value-size ceiling the answer must fit in.
    if (text.length === 0 || text.length > 1_500) {
      throw new Error("invalid text length");
    }
    const route: {
      instanceName: string;
      bridgeUrl: string | null;
      engineEnabled: boolean;
    } = await ctx.runQuery(internal.voice.gatewayTtsRoute, { chatId });
    if (!route.engineEnabled) {
      throw new Error("gateway voice not enabled for this instance");
    }
    const { status, data } = await postBridge(
      "/tts",
      { instanceName: route.instanceName, method: "convert", text },
      // TTS synthesis of a long reply can exceed the fast-op default.
      90_000,
      route.bridgeUrl,
    );
    if (status !== 200) throw new Error(`bridge tts -> HTTP ${status}`);
    const payload = (data as { payload?: { mime?: string; audioBase64?: string } })
      ?.payload;
    if (!payload?.audioBase64) throw new Error("no audio returned");
    return {
      mime: payload.mime || "audio/mpeg",
      audioBase64: payload.audioBase64,
    };
  },
});

