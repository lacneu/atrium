// DEV-ONLY utilities. Every function here refuses to run unless the deployment
// has OPENCLAW_ENABLE_ANON_AUTH=1 (the same flag that enables the dev Anonymous
// auth provider). Never enabled in production.

import { v } from "convex/values";
import {
  action,
  internalMutation,
  mutation,
  query,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { generateApiKey, hashKey } from "./lib/apikeys";
import { envLabel } from "./lib/envLabel";
import { recordFileForPart } from "./lib/files";
import { seedBuiltinRoles } from "./lib/rbac";
import { resolveTargetForChat } from "./routing";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";
import { enrichUserAgents } from "./agents";
import { requireRealUserId, getProfile } from "./lib/access";
import { loadLocalCrypto } from "./lib/crypto/keyProvider";
import { encryptedSecretValidator } from "./lib/crypto/convexValidator";

function assertDev() {
  if (process.env.OPENCLAW_ENABLE_ANON_AUTH !== "1") {
    throw new Error("dev.* is disabled (OPENCLAW_ENABLE_ANON_AUTH != 1)");
  }
}

// SAFETY (red-team must-fix): live tests hit ONLY the designated dev bench
// instance(s) — NEVER a protected tenant. Code-enforced, not just prose:
// routeUser + testSend refuse any instance outside this allowlist so no
// autonomous live test can reach a protected tenant. The allowlist is read
// from DEV_LIVE_INSTANCES (CSV of instance names); it defaults to "admin",
// the historical pre-multi-agent instance name kept for old bindings.
function devLiveAllowedInstances(): Set<string> {
  const csv = process.env.DEV_LIVE_INSTANCES ?? "admin";
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
function assertDevInstance(instanceName: string): void {
  const allowed = devLiveAllowedInstances();
  if (!allowed.has(instanceName)) {
    throw new Error(
      `dev live ops restricted to [${[...allowed].join(
        ", ",
      )}] — refusing "${instanceName}" (never touch protected tenants)`,
    );
  }
}

/**
 * Pick the owner for a no-chatId live send: prefer a profile that ACTUALLY has a
 * `userAgents` grant (the routed user — possibly targeted by `routeUser({email})`),
 * admin among them first; else fall back to admin/first (which resolves to a clear
 * no_agent). Dev-only, so the small whole-table read is acceptable. (Codex P3.)
 */
async function pickRoutedOwner(
  ctx: MutationCtx,
  profiles: Doc<"profiles">[],
): Promise<Doc<"profiles"> | undefined> {
  const routed = new Set(
    (await ctx.db.query("userAgents").collect()).map((u) => u.userId),
  );
  const routedProfiles = profiles.filter((p) => routed.has(p.userId));
  return (
    routedProfiles.find((p) => p.role === "admin") ??
    routedProfiles[0] ??
    profiles.find((p) => p.role === "admin") ??
    profiles[0]
  );
}

// Wipe app data (NOT the @convex-dev/auth tables, except we clear profiles so
// role bootstrap restarts cleanly). Used to reset local state between manual
// tests so the next sign-in deterministically becomes the bootstrap admin.
// Promote a profile to admin by its canonical (dev convenience for testing the
// admin UI when multiple stale anon sessions raced for the bootstrap admin).
export const makeAdmin = mutation({
  args: { canonical: v.string() },
  handler: async (ctx, { canonical }) => {
    assertDev();
    const all = await ctx.db.query("profiles").take(500);
    const match = all.find((p) => p.canonical === canonical);
    if (!match) return { ok: false, reason: "no profile with that canonical" };
    await ctx.db.patch(match._id, { role: "admin" });
    return { ok: true, profileId: match._id };
  },
});

// Force a profile's role by canonical (dev convenience): approve a pending test
// user to "user", promote to "admin", or DEMOTE to "pending" to exercise the
// approval UX. Dev-gated; never available in production.
export const setRole = mutation({
  args: {
    canonical: v.string(),
    role: v.union(v.literal("pending"), v.literal("user"), v.literal("admin")),
  },
  handler: async (ctx, { canonical, role }) => {
    assertDev();
    const all = await ctx.db.query("profiles").take(500);
    const match = all.find((p) => p.canonical === canonical);
    if (!match) {
      return { ok: false as const, reason: "no profile with that canonical" };
    }
    await ctx.db.patch(match._id, { role });
    return { ok: true as const, profileId: match._id, role };
  },
});

// DEV user switcher backend: list every profile + role (so the dev panel never
// needs the operator to know ids), marking the REAL caller. Dev-gated.
export const listUsersDev = query({
  args: {},
  handler: async (ctx) => {
    assertDev();
    const me = await requireRealUserId(ctx);
    const profiles = await ctx.db.query("profiles").take(500);
    return profiles
      .map((p) => ({
        userId: p.userId,
        profileId: p._id,
        canonical: p.canonical ?? null,
        role: (p.role as string | undefined) ?? "pending",
        name: p.name ?? null,
        email: p.email ?? null,
        isMe: p.userId === me,
      }))
      .sort((a, b) => (a.isMe === b.isMe ? 0 : a.isMe ? -1 : 1));
  },
});

// Set the CALLER's OWN role (dev escape hatch: become admin to reach Settings,
// or demote to pending to exercise the approval UX). Real identity, dev-gated.
export const setMyRole = mutation({
  args: {
    role: v.union(v.literal("pending"), v.literal("user"), v.literal("admin")),
  },
  handler: async (ctx, { role }) => {
    assertDev();
    const me = await requireRealUserId(ctx);
    const profile = await getProfile(ctx, me);
    if (!profile) return { ok: false as const, reason: "no profile" };
    await ctx.db.patch(profile._id, { role });
    return { ok: true as const, role };
  },
});

// Seed a chat with a realistic user turn + a long assistant turn, so the chat
// rendering (width, contrast, bubbles) can be exercised without a live bridge.
// Seeds for the first admin profile (the manual-test account).
export const seedChat = mutation({
  args: { canonical: v.optional(v.string()) },
  handler: async (ctx, { canonical }) => {
    assertDev();
    const profiles = await ctx.db.query("profiles").take(500);
    const owner = canonical
      ? profiles.find((p) => p.canonical === canonical)
      : (profiles.find((p) => p.role === "admin") ?? profiles[0]);
    if (!owner) return { ok: false, reason: "no profile" };
    const userId = owner.userId;
    const now = Date.now();

    const chatId = await ctx.db.insert("chats", {
      userId,
      title: "Aperçu du rendu",
      archived: false,
      sortKey: -1000,
      updatedAt: now,
    });

    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user",
      status: "complete",
      text:
        "En faite, je souhaiterais que dans mon one drive tu y dépose le fichier pdf que tu modifi, dit moi ou il se trouve et dit moi a chaque fois que tu le modifi",
      updatedAt: now,
    });

    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant",
      status: "complete",
      text: [
        "Tu as raison : c'était **Google Drive**, pas OneDrive. J'ai corrigé et je viens de l'y déposer.",
        "",
        "**Emplacement Google Drive :**",
        "",
        "- Dossier : `OpenClaw/Hindsight`",
        "- Fichier : `HINDSIGHT-GUIDE.pdf`",
        "- Lien : [drive.google.com/file/d/EXAMPLE…](https://drive.google.com/file/d/EXAMPLE_FILE_ID/view)",
        "",
        "| Détail | Valeur |",
        "| --- | --- |",
        "| Compte | `alice@example.com` |",
        "| Taille | 542 235 octets |",
        "",
        "À partir de maintenant, à chaque modification du PDF je mettrai à jour **ce même fichier Drive** avec `--replace` :",
        "",
        "```bash",
        "openclaw drive upload \\",
        "  --replace HINDSIGHT-GUIDE.pdf \\",
        "  --folder OpenClaw/Hindsight",
        "```",
        "",
        "Ceci est une réponse volontairement longue et riche pour vérifier le rendu markdown (gras, `code`, listes, lien, tableau, bloc de code) ainsi que la largeur et le contraste, en thème clair comme en thème sombre.",
      ].join("\n"),
      updatedAt: now,
    });

    return { ok: true, chatId };
  },
});

// Dev-only: seed a chat whose assistant reply carries a LightRAG provenance part in the
// EXACT shape the openclaw-knowledge plugin emits at 3.2.11 — document items that carry
// their per-document RETRIEVED content as `text` (the fix for "documents show only an
// id, no text") plus the synthesized context blob. Lets a human SEE the Sources panel
// render each document's excerpt locally, before trusting the live gateway path.
// Dev-only: seed a CLASSIFIED failed turn (gateway errorKind) into a chat so
// the error-card presentation (localized actionable headline + demoted raw
// detail) can be reviewed in the browser without provoking a real overflow.
// Dev-only: resolve a storage file's served URL (charset/content-type checks).
export const storageUrlDev = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    assertDev();
    return await ctx.storage.getUrl(storageId);
  },
});

export const seedErrorDemo = mutation({
  args: {
    chatId: v.id("chats"),
    errorKind: v.optional(v.string()), // default: context_length
  },
  handler: async (ctx, { chatId, errorKind }) => {
    assertDev();
    const chat = await ctx.db.get(chatId);
    if (!chat) return { ok: false, reason: "chat not found" };
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId: chat.userId,
      role: "assistant",
      status: "error",
      text: "",
      error:
        "The request exceeded the model's maximum context length (272000 tokens).",
      errorCode: errorKind ?? "context_length",
      updatedAt: now,
    });
    await ctx.db.patch(chatId, { updatedAt: now });
    return { ok: true, messageId };
  },
});

export const seedProvenanceDemo = mutation({
  args: { canonical: v.optional(v.string()) },
  handler: async (ctx, { canonical }) => {
    assertDev();
    const profiles = await ctx.db.query("profiles").take(500);
    const owner = canonical
      ? profiles.find((p) => p.canonical === canonical)
      : (profiles.find((p) => p.role === "admin") ?? profiles[0]);
    if (!owner) return { ok: false, reason: "no profile" };
    const userId = owner.userId;
    const now = Date.now();

    const chatId = await ctx.db.insert("chats", {
      userId,
      title: "LightRAG — nom + contenu par document (3.2.13)",
      archived: false,
      sortKey: -2000,
      updatedAt: now,
    });
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user",
      status: "complete",
      text: "Que peux-tu me dire sur le deploiement d'Helios ?",
      updatedAt: now,
    });
    const asstId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant",
      status: "complete",
      text: "Le deploiement d'Helios se fait en trois etapes reversibles. (reponse de demonstration — voir les Sources a droite : chaque document affiche maintenant son contenu recupere.)",
      updatedAt: now + 1,
    });
    await ctx.db.insert("messageParts", {
      messageId: asstId,
      order: 0,
      part: {
        kind: "provenance" as const,
        v: 1,
        pluginId: "openclaw-knowledge",
        source: "knowledge",
        group: "documents" as const,
        injected: { chars: 4000, position: "system_append", truncated: true },
        retrieval: { route: "lightrag", lightragMode: "hybrid" },
        items: [
          {
            // REAL prod shape: file_name is the opaque gdrive retrieval key; `title`
            // is the readable name (the plugin parses it from the content metadata).
            file_name: "gdrive/a1b2c3d4e5f600112233445566778899",
            title: "Guide de deploiement Helios.docx",
            type: "hybrid",
            text: "Le deploiement d'Helios se fait en trois etapes : preparation de l'environnement, application des migrations, puis bascule du trafic. Chaque etape est reversible ; un rollback restaure l'etat precedent sans perte de donnees.",
          },
          {
            file_name: "gdrive/99887766554433221100ffeeddccbbaa",
            title: "FAQ Helios.docx",
            type: "hybrid",
            text: "Q : Helios supporte-t-il le multi-tenant ? R : Oui, chaque tenant est isole par schema, sans partage de donnees.",
          },
          {
            id: "lightrag-context",
            type: "hybrid",
            context: true,
            text: 'Knowledge Graph Data (Entity): {"entity":"Helios","type":"concept","description":"Plateforme de deploiement multi-tenant."} (blob synthetise, tronque a 4000 caracteres)',
          },
        ],
      },
    });
    return { ok: true, chatId };
  },
});

// --- Observability spine: dev-gated service account + API key minting --------
//
// LIVE-VERIFY HELPER. The real mint path (apiKeys.mintApiKey) is an action that
// requires admin auth via ctx.auth, which a bare `npx convex run` cannot supply.
// This dev action mirrors that path WITHOUT requireAdmin (gated behind the dev
// flag) so the lead can mint a key from the CLI to exercise /api/v1/traces.
//
// Mirrors the action/mutation crypto split (D3): the action generates+hashes
// (Web Crypto, non-deterministic) then persists via an internalMutation.

/**
 * Internal: create-or-reuse a service account by name and persist a (already
 * hashed) API key. Also seeds built-in roles so the roleKey resolves at auth
 * time. Dev-gated. Returns the ids.
 */
export const seedApiKeyRecord = internalMutation({
  args: {
    name: v.string(),
    roleKey: v.string(),
    hashedKey: v.string(),
    prefix: v.string(),
    lastFour: v.string(),
  },
  handler: async (ctx, args) => {
    assertDev();
    await seedBuiltinRoles(ctx);

    // Attribute creation to the first admin profile if one exists (dev only).
    const admin = (await ctx.db.query("profiles").take(500)).find(
      (p) => p.role === "admin",
    );

    let account = await ctx.db
      .query("serviceAccounts")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    let serviceAccountId: Id<"serviceAccounts">;
    if (account === null) {
      serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: args.name,
        roleKey: args.roleKey,
        disabled: false,
        description: "dev-seeded service account",
        // createdByUserId is required; fall back to the admin's userId if any.
        // In a fresh dev deployment with no admin yet, seed an admin first
        // (dev.makeAdmin) — but tolerate absence by reusing the account's own
        // future id is impossible, so require an admin to exist.
        createdByUserId: requireAdminUserId(admin),
      });
    } else {
      serviceAccountId = account._id;
      // Keep the roleKey in sync with what the caller asked for.
      if (account.roleKey !== args.roleKey) {
        await ctx.db.patch(serviceAccountId, { roleKey: args.roleKey });
      }
    }

    const keyId = await ctx.db.insert("apiKeys", {
      serviceAccountId,
      hashedKey: args.hashedKey,
      prefix: args.prefix,
      lastFour: args.lastFour,
      disabled: false,
      createdAt: Date.now(),
    });
    return { serviceAccountId, keyId };
  },
});

/** Helper: a dev seed still needs a createdByUserId; require an admin profile. */
function requireAdminUserId(
  admin: { userId: Id<"users"> } | undefined,
): Id<"users"> {
  if (!admin) {
    throw new Error(
      "dev.seedApiKey: no admin profile yet — sign in once (bootstrap admin) first",
    );
  }
  return admin.userId;
}

/**
 * Dev-gated mint: generate a fresh key (CSPRNG + SHA-256, action runtime),
 * persist it for a (created-or-reused) service account, and return the plaintext
 * ONCE. Use this for live-verifying /api/v1/traces from the CLI.
 *
 *   CONVEX_AGENT_MODE=anonymous npx convex run dev:seedApiKey \
 *     '{"name":"obs-cli","roleKey":"observer"}'
 */
export const seedApiKey = action({
  args: {
    name: v.string(),
    roleKey: v.optional(v.string()), // default "observer"
  },
  handler: async (
    ctx,
    { name, roleKey },
  ): Promise<{
    serviceAccountId: Id<"serviceAccounts">;
    keyId: Id<"apiKeys">;
    plaintext: string;
    prefix: string;
    lastFour: string;
  }> => {
    const generated = generateApiKey(envLabel());
    const hashedKey = await hashKey(generated.plaintext);
    const { serviceAccountId, keyId } = await ctx.runMutation(
      internal.dev.seedApiKeyRecord,
      {
        name,
        roleKey: roleKey ?? "observer",
        hashedKey,
        prefix: generated.prefix,
        lastFour: generated.lastFour,
      },
    );
    return {
      serviceAccountId,
      keyId,
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      lastFour: generated.lastFour,
    };
  },
});

/**
 * LIVE-VERIFY HELPER for the global search index. The real path
 * (search.searchConversations) is auth-gated, so a bare `npx convex run` can't
 * exercise it. This dev-gated query runs the SAME raw `withSearchIndex` against
 * the live deployment so the production search index can be confirmed to return
 * hits (and that the `userId` filter scopes) from the CLI:
 *
 *   npx convex run dev:searchProbe '{"term":"drive"}'
 *   npx convex run dev:searchProbe '{"term":"drive","userId":"<id>"}'
 *
 * When `userId` is omitted it scopes to the first message's owner so a single
 * probe works without knowing an id.
 */
export const searchProbe = query({
  args: { term: v.string(), userId: v.optional(v.id("users")) },
  handler: async (ctx, { term, userId }) => {
    assertDev();
    let uid = userId;
    if (!uid) {
      const anyMsg = await ctx.db.query("messages").take(1);
      uid = anyMsg[0]?.userId;
    }
    if (!uid) return { ok: false as const, reason: "no messages to scope" };
    const hits = await ctx.db
      .query("messages")
      .withSearchIndex("search_text", (q) =>
        q.search("text", term).eq("userId", uid),
      )
      .take(5);
    return {
      ok: true as const,
      scopedUserId: uid,
      count: hits.length,
      chatIds: hits.map((m) => m.chatId),
    };
  },
});

/**
 * LIVE-BRIDGE ROUTING (dev-gated). Wire the test user(s) to one OpenClaw instance
 * so `bridge.dispatch` resolves a non-null target and POSTs to the bridge instead
 * of marking the outbox `failed` (the "no_agent" path). Upserts the non-secret
 * `instances` row (the bridge maps name -> token/deviceIdentity from its OWN env;
 * gatewayUrl here is display/metadata only), seeds the agent as DISCOVERED, and
 * assigns it as the default agent (userAgents) to the matching profile(s).
 *
 *   npx convex run dev:routeUser \
 *     '{"instanceName":"admin","gatewayUrl":"wss://gateway.example.org","agentId":"alice","canonical":"alice"}'
 *
 * With no `email`, routes EVERY active (user|admin) profile — foolproof on a
 * single-operator dev box where several stale sessions may exist. Pass `email`
 * to target one profile.
 */
export const routeUser = mutation({
  args: {
    instanceName: v.string(),
    gatewayUrl: v.string(),
    agentId: v.string(),
    canonical: v.string(),
    email: v.optional(v.string()),
    // Model M: the per-instance bridge endpoint dispatch POSTs to. Without it the
    // instance falls back to env BRIDGE_URL — fine for one instance, but a
    // multi-instance bench MUST set it so each chat routes to its OWN bridge.
    bridgeUrl: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { instanceName, gatewayUrl, agentId, canonical, email, bridgeUrl },
  ) => {
    assertDev();
    assertDevInstance(instanceName); // never route a profile to a protected tenant

    const now = Date.now();
    // Upsert the non-secret instance row (kind = openclaw for the dev gateway).
    const existing = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    if (existing === null) {
      await ctx.db.insert("instances", {
        name: instanceName,
        gatewayUrl,
        displayName: instanceName,
        kind: "openclaw",
        ...(bridgeUrl ? { bridgeUrl } : {}),
      });
    } else {
      await ctx.db.patch(existing._id, {
        gatewayUrl,
        kind: "openclaw",
        ...(bridgeUrl ? { bridgeUrl } : {}),
      });
    }

    // Seed the agent as DISCOVERED + a successful discovery (what the bridge
    // /agents poll would produce) so the multi-agent routing resolves it.
    const agentRow = await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", instanceName).eq("agentId", agentId),
      )
      .first();
    if (agentRow === null) {
      await ctx.db.insert("agents", {
        instanceName,
        agentId,
        source: "discovered",
        presentInLastOk: true,
        isDefaultOnInstance: true,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.patch(agentRow._id, {
        source: "discovered",
        presentInLastOk: true,
        lastSeenAt: now,
      });
    }
    const disc = await ctx.db
      .query("instanceDiscovery")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .first();
    if (disc === null) {
      await ctx.db.insert("instanceDiscovery", {
        instanceName,
        lastPollAt: now,
        lastPollOk: true,
        lastOkAt: now,
      });
    } else {
      await ctx.db.patch(disc._id, { lastPollAt: now, lastPollOk: true, lastOkAt: now });
    }

    // Assign the agent (as default) to the matching active profile(s) via the
    // M:N userAgents join — the new routing source.
    const profiles = await ctx.db.query("profiles").take(500);
    const targets = profiles.filter(
      (p) =>
        (p.role === "admin" || p.role === "user") &&
        (email ? p.email === email : true),
    );
    // Bench convenience: if an email is given but no profile has it yet, CREATE the
    // user+profile so a multi-instance setup is one call per instance (route a
    // distinct user to each bridge). Dev-only (assertDev above).
    if (email && targets.length === 0) {
      const uid = await ctx.db.insert("users", {});
      const pid = await ctx.db.insert("profiles", {
        userId: uid,
        role: "user",
        email,
      });
      const created = await ctx.db.get(pid);
      if (created !== null) targets.push(created);
    }
    const routed: Array<{ userId: Id<"users">; email: string | null; role: string }> = [];
    for (const p of targets) {
      await ctx.db.patch(p._id, { canonical });
      const userUas = await ctx.db
        .query("userAgents")
        .withIndex("by_user", (q) => q.eq("userId", p.userId))
        .collect();
      const ua = userUas.find(
        (e) => e.instanceName === instanceName && e.agentId === agentId,
      );
      // routeUser ANNOUNCES this (instance, agent) as the routed default, so make
      // it the default even on a re-run where the row already exists but is not
      // the default (else dev.testSend keeps resolving to the stale default — P3).
      if (!ua || !ua.isDefault) {
        for (const e of userUas) {
          if (e.isDefault) await ctx.db.patch(e._id, { isDefault: false });
        }
      }
      if (!ua) {
        await ctx.db.insert("userAgents", {
          userId: p.userId,
          instanceName,
          agentId,
          isDefault: true,
          source: "manual",
          createdAt: now,
        });
      } else if (!ua.isDefault) {
        await ctx.db.patch(ua._id, { isDefault: true });
      }
      routed.push({ userId: p.userId, email: p.email ?? null, role: p.role as string });
    }

    return { ok: true, instance: instanceName, gatewayUrl, routedCount: routed.length, routed };
  },
});
/**
 * LIVE-TEST TRIGGER (dev-gated). Programmatically enqueue a user turn for the
 * routed test profile — the same path the browser's send.sendMessage takes
 * (optimistic user message + outbox row + scheduled bridge.dispatch) — so the
 * live harness can drive a round-trip WITHOUT a browser click. The scheduled
 * dispatch resolves routing (userAgents) and POSTs to the bridge, which
 * connects to the gateway and streams the reply back into Convex.
 *
 *   npx convex run dev:testSend '{"text":"hello from the live harness"}'
 *
 * Returns the chatId so a follow-up run can continue the same conversation, and
 * so the harness can poll `messages` by chat for the assistant's final state.
 */
export const testSend = mutation({
  args: { text: v.string(), chatId: v.optional(v.id("chats")) },
  handler: async (ctx, { text, chatId }) => {
    assertDev();

    // Resolve the sending user: if a chatId is given, send as THAT chat's owner
    // (so the harness can drive any conversation); otherwise pick a routed profile.
    const profiles = await ctx.db.query("profiles").take(500);
    let owner: (typeof profiles)[number] | undefined;
    let boundChat: Doc<"chats"> | null = null;
    if (chatId) {
      boundChat = await ctx.db.get(chatId);
      if (!boundChat) return { ok: false as const, reason: "chat not found" };
      owner = profiles.find((p) => p.userId === boundChat!.userId);
      if (!owner) return { ok: false as const, reason: "chat owner has no profile" };
    } else {
      owner = await pickRoutedOwner(ctx, profiles);
    }
    if (!owner) return { ok: false as const, reason: "no routed profile" };
    // SAFETY: gate the ACTUAL dispatch target, not an arbitrary assignment.
    // bridge.dispatch routes via resolveTargetForChat — the chat BINDING first,
    // else the user's DEFAULT userAgents row (NOT necessarily `.first()`), and on
    // an instance that may differ from `.first()`. Gating `.first()` could thus
    // allowlist one instance while the send actually reaches another (e.g.
    // a protected tenant) (Codex P2). Resolve the same way dispatch will, then
    // THAT instance. For a fresh (no chatId) send the new chat is unbound, so a
    // synthetic unbound chat resolves to the same default the real one will.
    const resolveChat: Doc<"chats"> =
      boundChat ?? ({ userId: owner.userId } as unknown as Doc<"chats">);
    const resolution = await resolveTargetForChat(ctx, resolveChat, owner.userId);
    if (!resolution.target) {
      return {
        ok: false as const,
        reason: `test user has no resolvable agent (${
          resolution.failReason ?? "no_agent"
        }) — run dev.routeUser first`,
      };
    }
    assertDevInstance(resolution.target.instanceName);
    const userId = owner.userId;
    const now = Date.now();

    const cid: Id<"chats"> =
      chatId ??
      (await ctx.db.insert("chats", {
        userId,
        title: "Live test",
        archived: false,
        sortKey: -1000,
        updatedAt: now,
      }));

    // Mirror send.sendMessage: optimistic user message + outbox + dispatch.
    // CAVEAT (live-testing gotcha, verified 2026-07-04): this DEV helper does
    // NOT run the mid-turn QUEUE serialization (isChatBusy -> queued) that the
    // real send.sendMessage does — it dispatches directly. So sending two
    // testSend calls back-to-back on ONE chat dispatches BOTH concurrently,
    // which a real user CANNOT do (the composer queues). Do not mistake that
    // for a production race: the real path is serialized (outboxQueue tests).
    const messageId = await ctx.db.insert("messages", {
      chatId: cid,
      userId,
      role: "user",
      status: "complete",
      text,
      updatedAt: now,
    });
    await ctx.db.patch(cid, { updatedAt: now });

    const outboxId = await ctx.db.insert("outbox", {
      chatId: cid,
      userId,
      clientMessageId: `live-${messageId}`,
      messageId,
      text,
      attachmentIds: [],
      status: "pending",
    });
    await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });

    return { ok: true as const, chatId: cid, messageId, outboxId };
  },
});

/**
 * DEV-ONLY: per-turn ROUTED send — mirrors send.sendMessage WITH a `routedAgent`
 * so the live bench can drive the multi-agent per-turn router (the one path
 * dev:testSend cannot: it never stamps routedAgent). Stamps routedInstanceName/
 * routedAgentId on the user message AND routedAgent on the outbox row, exactly as
 * the real composer does, so bridge.dispatch runs beginTurnRouting + getChatRouting
 * with the routed agent (epoch-on-switch + forced rehydration). Test scaffolding,
 * not a product path.
 *   npx convex run dev:testSendRouted '{"chatId":"<id>","text":"oui","instanceName":"olivier","agentId":"bob"}'
 */
export const testSendRouted = mutation({
  args: {
    text: v.string(),
    chatId: v.optional(v.id("chats")),
    instanceName: v.string(),
    agentId: v.string(),
    // When creating a chat, the owner to use (find-or-create). Lets the bench drive a
    // SINGLE user across an alice→bob switch deterministically.
    ownerEmail: v.optional(v.string()),
  },
  handler: async (ctx, { text, chatId, instanceName, agentId, ownerEmail }) => {
    assertDev();
    assertDevInstance(instanceName);
    const routedAgent = { instanceName, agentId };

    const profiles = await ctx.db.query("profiles").take(500);
    let ownerUserId: Id<"users"> | undefined;
    if (chatId) {
      const boundChat = await ctx.db.get(chatId);
      if (!boundChat) return { ok: false as const, reason: "chat not found" };
      ownerUserId = boundChat.userId;
    } else if (ownerEmail) {
      const existing = profiles.find((p) => p.email === ownerEmail);
      if (existing) ownerUserId = existing.userId;
      else {
        const uid = await ctx.db.insert("users", {});
        await ctx.db.insert("profiles", {
          userId: uid,
          role: "user",
          email: ownerEmail,
          canonical: "u-repro",
        });
        ownerUserId = uid;
      }
    } else {
      // Pick any profile entitled to the routed agent (membership = dispatch auth).
      for (const p of profiles) {
        const uas = await ctx.db
          .query("userAgents")
          .withIndex("by_user", (q) => q.eq("userId", p.userId))
          .collect();
        if (uas.some((u) => u.instanceName === instanceName && u.agentId === agentId)) {
          ownerUserId = p.userId;
          break;
        }
      }
    }
    if (!ownerUserId) return { ok: false as const, reason: "no owner for routedAgent" };
    const userId = ownerUserId;
    const now = Date.now();

    // Ensure the owner is ENTITLED to the routed agent (membership = dispatch auth),
    // so an alice→bob switch never fails agent_restricted on a freshly-granted agent.
    const grants = await ctx.db
      .query("userAgents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    if (!grants.some((g) => g.instanceName === instanceName && g.agentId === agentId)) {
      await ctx.db.insert("userAgents", {
        userId,
        instanceName,
        agentId,
        isDefault: grants.length === 0,
        source: "manual",
        createdAt: now,
      });
    }

    const cid: Id<"chats"> =
      chatId ??
      (await ctx.db.insert("chats", {
        userId,
        title: "Live routed test",
        archived: false,
        sortKey: -1000,
        updatedAt: now,
      }));

    const messageId = await ctx.db.insert("messages", {
      chatId: cid,
      userId,
      role: "user",
      status: "complete",
      text,
      updatedAt: now,
      routedInstanceName: routedAgent.instanceName,
      routedAgentId: routedAgent.agentId,
    });
    await ctx.db.patch(cid, { updatedAt: now });

    const outboxId = await ctx.db.insert("outbox", {
      chatId: cid,
      userId,
      clientMessageId: `live-routed-${messageId}`,
      messageId,
      text,
      attachmentIds: [],
      status: "pending",
      routedAgent,
    });
    await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });

    return { ok: true as const, chatId: cid, messageId, outboxId };
  },
});

/**
 * DEV-ONLY: read the per-turn routing fields of a chat doc + its recent messages'
 * routedAgentId — the values the obs MCP cannot expose. The decisive artifact for
 * the multi-agent context-carryover diagnosis.
 *   npx convex run dev:inspectRouting '{"chatId":"<id>"}'
 */
export const inspectRouting = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    assertDev();
    const chat = await ctx.db.get(chatId);
    if (!chat) return null;
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(8);
    return {
      chat: {
        agentId: chat.agentId ?? null,
        instanceName: chat.instanceName ?? null,
        perTurnRouting: chat.perTurnRouting ?? null,
        routingSegment: chat.routingSegment ?? null,
        lastRoutedAgentId: chat.lastRoutedAgentId ?? null,
        lastRoutedInstanceName: chat.lastRoutedInstanceName ?? null,
        openclawChatId: chat.openclawChatId ?? null,
      },
      messages: msgs
        .reverse()
        .map((m) => ({
          role: m.role,
          status: m.status,
          textPreview: m.text.slice(0, 60),
          routedAgentId: m.routedAgentId ?? null,
          routedInstanceName: m.routedInstanceName ?? null,
        })),
    };
  },
});

/**
 * LIVE-HARNESS ORACLE (dev-gated, read-only). Clean view of a chat's latest
 * messages + their part kinds/names + A2 text/liveText lengths — the
 * deterministic check the live matrix polls (avoids parsing `convex data` column
 * output).
 *
 *   npx convex run dev:inspectChat '{"chatId":"<id>"}'
 */
export const inspectChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    assertDev();
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(6);
    const out = [];
    for (const m of msgs) {
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      out.push({
        role: m.role,
        status: m.status,
        textLen: m.text.length,
        liveTextLen: (m.liveText ?? "").length,
        textPreview: m.text.slice(0, 80),
        parts: parts.map((p) => ({
          kind: p.part.kind,
          name: "name" in p.part ? p.part.name : undefined,
          phase: "phase" in p.part ? p.part.phase : undefined,
        })),
      });
    }
    return out.reverse();
  },
});

/**
 * Resolve the MOST RECENT media attachment in a chat to {filename, mimeType,
 * url} + dedup signals. Used by the per-version file-exchange smoke test to
 * byte-compare the served bytes against the source file and assert exactly one
 * media part + no dead link. Dev-gated like the rest of this module.
 *   npx convex run dev:lastMediaPart '{"chatId":"<id>"}'
 */
export const lastMediaPart = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    assertDev();
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(8);
    for (const m of msgs) {
      const parts = await ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      const media = [...parts].reverse().find((p) => p.part.kind === "media");
      if (media && media.part.kind === "media") {
        return {
          filename: media.part.filename,
          mimeType: media.part.mimeType,
          url: await ctx.storage.getUrl(media.part.storageId),
          // Terminal status of the turn that produced this attachment — used by
          // the stability test to count complete vs error turns per version.
          status: m.status,
          // dedup check (must be 1) + dead-link check (must be false).
          mediaCount: parts.filter((p) => p.part.kind === "media").length,
          textHasDeadLink:
            m.text.includes("](./media/") || m.text.includes("MEDIA:"),
        };
      }
    }
    return null;
  },
});

/**
 * Last message's role/status/creationTime — used by the stability test to detect
 * a NEW assistant turn finalizing (complete/error) regardless of whether it
 * produced an attachment, so it measures app-server stability (the
 * "codex app-server client closed" irritation) rather than agent MEDIA: compliance.
 *   npx convex run dev:chatStats '{"chatId":"<id>"}'
 */
export const chatStats = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    assertDev();
    const last = await ctx.db
      .query("messages")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(1);
    const m = last[0];
    return m
      ? {
          lastRole: m.role,
          lastStatus: m.status,
          lastCreated: m._creationTime,
          // System error string (e.g. "codex app-server client closed before
          // turn completed") — non-PHI, lets the stability test classify the
          // irritation. Truncated.
          lastError: m.error ? m.error.slice(0, 100) : undefined,
        }
      : null;
  },
});

/**
 * #59 INBOUND ROUND-TRIP (dev-gated). Store a raw image blob into Convex file
 * storage, then enqueue a user turn whose outbox row carries it as a real
 * `attachments` entry + schedule the SAME `internal.bridge.dispatch`. This
 * exercises the entire PRODUCTION inbound path — storageId -> base64 in dispatch
 * -> chat.send.attachments -> gateway media/inbound -> agent vision — WITHOUT the
 * browser's assistant-ui attach widget (CDP automation cannot drive its file
 * picker; the widget wiring is verified separately by reading ConvexChat.tsx).
 *
 *   CONVEX_AGENT_MODE=anonymous npx convex run dev:seedImageAttachment \
 *     '{"base64":"<...>","filename":"carre-rouge.png","mimeType":"image/png",
 *       "text":"Quelle couleur domine ?","chatId":"<id>"}'
 *
 * IDOR NOTE: production send (send.sendMessage) enforces assertOwnsUpload; this
 * dev path inserts the outbox row directly and intentionally skips that gate
 * (unit-covered elsewhere) — it targets the dispatch resolution, not IDOR.
 */
export const seedImageAttachment = action({
  args: {
    base64: v.string(),
    filename: v.string(),
    mimeType: v.string(),
    text: v.string(),
    chatId: v.optional(v.id("chats")),
  },
  handler: async (
    ctx,
    { base64, filename, mimeType, text, chatId },
  ): Promise<
    | { ok: true; chatId: Id<"chats">; outboxId: Id<"outbox">; storageId: Id<"_storage"> }
    | { ok: false; reason: string }
  > => {
    assertDev();
    // Decode base64 -> bytes -> Blob. The default Convex action runtime provides
    // `atob` + `Blob` (no Node Buffer), mirroring the dispatch's btoa encode.
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const storageId = await ctx.storage.store(blob);
    const res = await ctx.runMutation(internal.dev.enqueueAttachmentTurn, {
      storageId,
      filename,
      mimeType,
      text,
      chatId,
    });
    if (!res.ok) return res;
    return { ok: true, chatId: res.chatId, outboxId: res.outboxId, storageId };
  },
});

/**
 * Dev-only seed for the Settings › Fichiers tab: create a chat + message + a
 * file `messagePart` AND its paired `files` row (via the real helper) for the
 * user with `canonical`, with NO agent/dispatch needed. Lets us render a
 * POPULATED Files table without a working bridge. Run:
 *   npx convex run dev:devSeedFile '{"canonical":"u-...","direction":"inbound"}'
 */
export const devSeedFile = action({
  args: {
    canonical: v.string(),
    filename: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    direction: v.optional(
      v.union(v.literal("inbound"), v.literal("outbound")),
    ),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    assertDev();
    // storage.store is action-only; persist a tiny blob then hand the storageId
    // to the mutation that writes the chat/message/part + paired files row.
    const storageId = await ctx.storage.store(new Blob(["seed-bytes"]));
    return await ctx.runMutation(internal.dev.devSeedFileRow, {
      canonical: args.canonical,
      storageId,
      filename: args.filename ?? "rapport-trimestriel.pdf",
      mimeType: args.mimeType ?? "application/pdf",
      direction: args.direction ?? "inbound",
    });
  },
});

export const devSeedFileRow = internalMutation({
  args: {
    canonical: v.string(),
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
  },
  handler: async (ctx, args) => {
    assertDev();
    const profiles = await ctx.db.query("profiles").collect();
    const profile = profiles.find((p) => p.canonical === args.canonical);
    if (!profile) return { ok: false as const, reason: "no profile" };
    const userId = profile.userId;
    const now = Date.now();
    const chatId = await ctx.db.insert("chats", {
      userId,
      title: "Conversation de démo",
      updatedAt: now,
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role:
        args.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      status: "complete" as const,
      text: "seed",
      updatedAt: now,
    });
    const part = {
      kind: "file" as const,
      storageId: args.storageId,
      filename: args.filename,
      mimeType: args.mimeType,
    };
    await ctx.db.insert("messageParts", { messageId, order: 0, part });
    await recordFileForPart(ctx, {
      messageId,
      chatId,
      userId,
      direction: args.direction,
      instanceName: undefined,
      part,
      createdAt: now,
    });
    return { ok: true as const };
  },
});

/**
 * Internal half of #59 round-trip: insert the SAME outbox row shape that
 * send.sendMessage builds (attachmentIds + attachments + a `file` messagePart)
 * and schedule the SAME dispatch. Dev-gated. Reuses testSend's owner/routing
 * resolution so the live send only ever reaches an allowlisted dev instance.
 */
export const enqueueAttachmentTurn = internalMutation({
  args: {
    storageId: v.id("_storage"),
    filename: v.string(),
    mimeType: v.string(),
    text: v.string(),
    chatId: v.optional(v.id("chats")),
  },
  handler: async (
    ctx,
    { storageId, filename, mimeType, text, chatId },
  ): Promise<
    | { ok: true; chatId: Id<"chats">; messageId: Id<"messages">; outboxId: Id<"outbox"> }
    | { ok: false; reason: string }
  > => {
    assertDev();
    const profiles = await ctx.db.query("profiles").take(500);
    let owner: (typeof profiles)[number] | undefined;
    let boundChat: Doc<"chats"> | null = null;
    if (chatId) {
      boundChat = await ctx.db.get(chatId);
      if (!boundChat) return { ok: false, reason: "chat not found" };
      owner = profiles.find((p) => p.userId === boundChat!.userId);
      if (!owner) return { ok: false, reason: "chat owner has no profile" };
    } else {
      owner = await pickRoutedOwner(ctx, profiles);
    }
    if (!owner) return { ok: false, reason: "no routed profile" };
    // SAFETY: gate the ACTUAL dispatch target (chat binding else user DEFAULT),
    // not an arbitrary `.first()` — same barrier as testSend (Codex P2). The
    // scheduled dispatch resolves via resolveTargetForChat, so gating `.first()`
    // could allowlist one instance while the attachment reaches another.
    const resolveChat: Doc<"chats"> =
      boundChat ?? ({ userId: owner.userId } as unknown as Doc<"chats">);
    const resolution = await resolveTargetForChat(ctx, resolveChat, owner.userId);
    if (!resolution.target) {
      return {
        ok: false,
        reason: `test user has no resolvable agent (${
          resolution.failReason ?? "no_agent"
        }) — run dev.routeUser first`,
      };
    }
    assertDevInstance(resolution.target.instanceName);
    const userId = owner.userId;
    const now = Date.now();

    const cid: Id<"chats"> =
      chatId ??
      (await ctx.db.insert("chats", {
        userId,
        title: "Inbound test",
        archived: false,
        sortKey: -1000,
        updatedAt: now,
      }));

    const messageId = await ctx.db.insert("messages", {
      chatId: cid,
      userId,
      role: "user",
      status: "complete",
      text,
      updatedAt: now,
    });
    // Render the attachment in the thread (faithful to send.sendMessage step 4).
    const part = { kind: "file" as const, storageId, filename, mimeType };
    await ctx.db.insert("messageParts", { messageId, order: 0, part });
    // Dev-seed parity: same paired files-row write as the real send path.
    await recordFileForPart(ctx, {
      messageId,
      chatId: cid,
      userId,
      direction: "inbound",
      part,
      createdAt: now,
    });
    await ctx.db.patch(cid, { updatedAt: now });

    const outboxId = await ctx.db.insert("outbox", {
      chatId: cid,
      userId,
      clientMessageId: `live-att-${messageId}`,
      messageId,
      text,
      attachmentIds: [storageId],
      attachments: [{ storageId, filename, mimeType }],
      status: "pending",
    });
    await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });

    return { ok: true, chatId: cid, messageId, outboxId };
  },
});

/**
 * Read an outbox row's #59-relevant fields back (dev-gated) so the round-trip
 * can assert the dispatch saw a populated `attachments` array AND marked the row
 * terminal `sent`. Complements chatStats (which reads the assistant turn).
 *   npx convex run dev:outboxStatus '{"outboxId":"<id>"}'
 */
export const outboxStatus = query({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    assertDev();
    const row = await ctx.db.get(outboxId);
    if (!row) return null;
    return {
      status: row.status,
      attachmentCount: (row.attachments ?? []).length,
      attachmentNames: (row.attachments ?? []).map((a) => a.filename),
      attachmentIdCount: row.attachmentIds.length,
    };
  },
});

/**
 * Seed a chat's `sessionMeta` (dev-gated) so the chat-header strip (model +
 * reasoning chips + context meter) can be verified in the browser WITHOUT a live
 * gateway/bridge (which writes this per turn in production). Defaults mirror the
 * real `sessions.describe` shape from the live read-only probe (image #27:
 * 62226/272000 = 22.9% ≈ 23% context used, gpt-5.5, thinking=high).
 *
 *   npx convex run dev:seedSessionMeta '{"chatId":"<id>"}'
 *   npx convex run dev:seedSessionMeta '{"chatId":"<id>","totalTokens":270000}'
 */
export const seedSessionMeta = mutation({
  args: {
    chatId: v.id("chats"),
    model: v.optional(v.string()),
    thinkingLevel: v.optional(v.string()),
    thinkingDefault: v.optional(v.string()),
    verboseLevel: v.optional(v.string()),
    totalTokens: v.optional(v.number()),
    contextTokens: v.optional(v.number()),
    estimatedCostUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertDev();
    const chat = await ctx.db.get(args.chatId);
    if (!chat) return { ok: false as const, reason: "chat not found" };
    await ctx.db.patch(args.chatId, {
      sessionMeta: {
        model: args.model ?? "gpt-5.5",
        modelProvider: "openai-codex",
        agentRuntime: "codex",
        thinkingLevel: args.thinkingLevel ?? "high",
        thinkingDefault: args.thinkingDefault ?? "high",
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
          { id: "xhigh", label: "xhigh" },
        ],
        verboseLevel: args.verboseLevel ?? "full",
        totalTokens: args.totalTokens ?? 62226,
        contextTokens: args.contextTokens ?? 272000,
        estimatedCostUsd: args.estimatedCostUsd ?? 1.78,
        updatedAt: Date.now(),
      },
    });
    return { ok: true as const, chatId: args.chatId };
  },
});

/**
 * Read a chat's live `sessionMeta` (dev-gated) — to verify the bridge's
 * sessionMeta producer (UI-2) populated it from the gateway's `sessions.describe`.
 *   npx convex run dev:peekSessionMeta '{"chatId":"<id>"}'
 */
export const peekSessionMeta = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    assertDev();
    const chat = await ctx.db.get(chatId);
    return chat?.sessionMeta ?? null;
  },
});

export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    assertDev();
    const tables = [
      "messageParts",
      "files",
      "messages",
      "outbox",
      "uploads",
      "chats",
      "projects",
      "instances",
      "instanceDiscovery",
      "agents",
      "userAgents",
      "groupAgents",
      "groupMembers",
      "groupCharts",
      "charts",
      "groups",
      "profiles",
      "appMeta",
      "auditLog",
      "serviceAccounts",
      "apiKeys",
      "roles",
      "traceEvents",
      "kpiRollups",
      "anomalies",
      "integrationCursors",
    ] as const;
    let deleted = 0;
    for (const table of tables) {
      // Bounded batches to stay within mutation limits on larger datasets.
      for (;;) {
        const batch = await ctx.db.query(table).take(200);
        if (batch.length === 0) break;
        for (const row of batch) {
          await ctx.db.delete(row._id);
          deleted++;
        }
        if (batch.length < 200) break;
      }
    }
    return { deleted };
  },
});

// ── DEV-ONLY: seed a bench instance for the PURE-CONVEX bridge path ──────────
// The real setInstanceSecret / mintBridgeSecret are admin-gated (uncallable via
// `npx convex run` without an identity). For the one-bridge-N-gateways live bench
// these mirror them UNGATED (assertDev + the live allowlist): upsert the instance's
// gatewayUrl, store the encrypted operator token + Ed25519 device identity, and mint
// a per-bridge secret. Returns the plaintext secret to put in BRIDGE_INSTANCE_SECRETS.

/** Internal: create/get the bench instance row + set its gatewayUrl (no admin gate). */
export const _ensureSeedInstance = internalMutation({
  args: { instanceName: v.string(), gatewayUrl: v.string() },
  handler: async (ctx, { instanceName, gatewayUrl }): Promise<Id<"instances">> => {
    assertDev();
    assertDevInstance(instanceName);
    const existing = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { gatewayUrl });
      return existing._id;
    }
    return await ctx.db.insert("instances", {
      name: instanceName,
      gatewayUrl,
      displayName: instanceName,
    });
  },
});

/** Internal: persist the encrypted creds + the per-bridge secret hash (no admin gate). */
export const _storeSeedCreds = internalMutation({
  args: {
    instanceId: v.id("instances"),
    tokenSecret: encryptedSecretValidator,
    deviceSecret: encryptedSecretValidator,
    hashedSecret: v.string(),
    prefix: v.string(),
    lastFour: v.string(),
  },
  handler: async (
    ctx,
    { instanceId, tokenSecret, deviceSecret, hashedSecret, prefix, lastFour },
  ) => {
    assertDev();
    const upsertSecret = async (
      field: "token" | "deviceIdentity",
      secret: typeof tokenSecret,
    ) => {
      const existing = await ctx.db
        .query("instanceSecrets")
        .withIndex("by_instance_field", (q) =>
          q.eq("instanceId", instanceId).eq("field", field),
        )
        .unique();
      if (existing) await ctx.db.patch(existing._id, { secret, updatedAt: Date.now() });
      else
        await ctx.db.insert("instanceSecrets", {
          instanceId,
          field,
          secret,
          updatedAt: Date.now(),
        });
    };
    await upsertSecret("token", tokenSecret);
    await upsertSecret("deviceIdentity", deviceSecret);
    // One active per-bridge secret per instance — replace any prior.
    for (const row of await ctx.db
      .query("bridgeAuth")
      .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
      .collect())
      await ctx.db.delete(row._id);
    // createdBy needs a user; use the first profile's user (dev box has one).
    const anyProfile = await ctx.db.query("profiles").first();
    await ctx.db.insert("bridgeAuth", {
      instanceId,
      hashedSecret,
      prefix,
      lastFour,
      createdAt: Date.now(),
      createdBy: anyProfile?.userId ?? ("seed" as Id<"users">),
    });
  },
});

export const seedInstanceCreds = action({
  args: {
    instanceName: v.string(),
    gatewayUrl: v.string(),
    token: v.string(),
    deviceIdentity: v.string(), // inline JSON {id, publicKey, privateKey}
  },
  handler: async (
    ctx,
    { instanceName, gatewayUrl, token, deviceIdentity },
  ): Promise<{ secret: string }> => {
    assertDev();
    assertDevInstance(instanceName);
    const instanceId = await ctx.runMutation(internal.dev._ensureSeedInstance, {
      instanceName,
      gatewayUrl,
    });
    const { encryptCipher } = loadLocalCrypto();
    const tokenSecret = await encryptCipher.encrypt(token, `${instanceId}:token`);
    const deviceSecret = await encryptCipher.encrypt(
      deviceIdentity,
      `${instanceId}:deviceIdentity`,
    );
    const generated = generateApiKey(envLabel());
    const hashedSecret = await hashKey(generated.plaintext);
    await ctx.runMutation(internal.dev._storeSeedCreds, {
      instanceId,
      tokenSecret,
      deviceSecret,
      hashedSecret,
      prefix: generated.prefix,
      lastFour: generated.lastFour,
    });
    return { secret: generated.plaintext };
  },
});

/** DEV-ONLY: seed a HERMES instance (kind hermes; secret = the gateway's
 *  API_SERVER_KEY under the `apiKey` field — no device identity) + its
 *  per-bridge secret. Mirrors seedInstanceCreds for the local Hermes bench. */
export const seedHermesInstance = action({
  args: {
    instanceName: v.string(),
    // ws (default): the `hermes serve` base (e.g. http://host:9119), apiKey =
    // "user:password" (dashboard basic auth) or the dashboard session token.
    // rest: the API server base (e.g. http://host:18642), apiKey = API_SERVER_KEY.
    gatewayUrl: v.string(),
    apiKey: v.string(),
    transport: v.optional(v.union(v.literal("ws"), v.literal("rest"))),
  },
  handler: async (
    ctx,
    { instanceName, gatewayUrl, apiKey, transport },
  ): Promise<{ secret: string }> => {
    assertDev();
    assertDevInstance(instanceName);
    const instanceId = await ctx.runMutation(internal.dev._ensureSeedInstance, {
      instanceName,
      gatewayUrl,
    });
    await ctx.runMutation(internal.dev._markInstanceHermes, {
      instanceId,
      bridgeUrl: "http://127.0.0.1:8790",
      transport: transport ?? "ws",
    });
    const { encryptCipher } = loadLocalCrypto();
    const apiKeySecret = await encryptCipher.encrypt(
      apiKey,
      `${instanceId}:apiKey`,
    );
    const generated = generateApiKey(envLabel());
    const hashedSecret = await hashKey(generated.plaintext);
    await ctx.runMutation(internal.dev._storeSeedHermesCreds, {
      instanceId,
      apiKeySecret,
      hashedSecret,
      prefix: generated.prefix,
      lastFour: generated.lastFour,
    });
    return { secret: generated.plaintext };
  },
});

export const _markInstanceHermes = internalMutation({
  args: {
    instanceId: v.id("instances"),
    bridgeUrl: v.optional(v.string()),
    transport: v.optional(v.union(v.literal("ws"), v.literal("rest"))),
  },
  handler: async (ctx, { instanceId, bridgeUrl, transport }) => {
    assertDev();
    await ctx.db.patch(instanceId, {
      kind: "hermes",
      ...(bridgeUrl ? { bridgeUrl } : {}),
      ...(transport ? { transport } : {}),
    });
  },
});

export const _storeSeedHermesCreds = internalMutation({
  args: {
    instanceId: v.id("instances"),
    apiKeySecret: encryptedSecretValidator,
    hashedSecret: v.string(),
    prefix: v.string(),
    lastFour: v.string(),
  },
  handler: async (
    ctx,
    { instanceId, apiKeySecret, hashedSecret, prefix, lastFour },
  ) => {
    assertDev();
    const existing = await ctx.db
      .query("instanceSecrets")
      .withIndex("by_instance_field", (q) =>
        q.eq("instanceId", instanceId).eq("field", "apiKey"),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        secret: apiKeySecret,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("instanceSecrets", {
        instanceId,
        field: "apiKey",
        secret: apiKeySecret,
        updatedAt: Date.now(),
      });
    }
    // One active per-bridge secret per instance — replace any prior.
    for (const row of await ctx.db
      .query("bridgeAuth")
      .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
      .collect())
      await ctx.db.delete(row._id);
    const anyProfile = await ctx.db.query("profiles").first();
    await ctx.db.insert("bridgeAuth", {
      instanceId,
      hashedSecret,
      prefix,
      lastFour,
      createdAt: Date.now(),
      createdBy: anyProfile?.userId ?? ("seed" as Id<"users">),
    });
  },
});

// DEV-ONLY concurrency probe (one bridge, N gateways): create K chats bound to the
// given (instance, agent) pairs for one owner and fire ALL their dispatches at once
// (scheduler.runAfter(0)), so the bridge handles concurrent turns on the SAME instance
// and across DIFFERENT instances. Each chat is independent (own session key) — the
// oracle is dev:inspectChat per returned chatId: every chat must get ITS OWN assistant
// reply, none crossed onto another, and the bridge must stay healthy.
export const concurrencyProbe = mutation({
  args: {
    ownerEmail: v.string(),
    sends: v.array(
      v.object({
        instanceName: v.string(),
        agentId: v.string(),
        text: v.string(),
      }),
    ),
  },
  handler: async (
    ctx,
    { ownerEmail, sends },
  ): Promise<Array<{ chatId: Id<"chats">; instanceName: string }>> => {
    assertDev();
    const profile = (await ctx.db.query("profiles").take(500)).find(
      (p) => p.email === ownerEmail,
    );
    if (!profile) throw new Error(`no profile for ${ownerEmail} (routeUser it first)`);
    const userId = profile.userId;
    const now = Date.now();
    const out: Array<{ chatId: Id<"chats">; instanceName: string }> = [];
    for (const s of sends) {
      assertDevInstance(s.instanceName);
      // Ensure the routing grant exists (membership = dispatch authorization).
      const grants = await ctx.db
        .query("userAgents")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      if (
        !grants.some(
          (g) => g.instanceName === s.instanceName && g.agentId === s.agentId,
        )
      ) {
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: s.instanceName,
          agentId: s.agentId,
          isDefault: false,
          source: "manual",
          createdAt: now,
        });
      }
      const chatId = await ctx.db.insert("chats", {
        userId,
        title: `probe ${s.instanceName}`,
        instanceName: s.instanceName,
        agentId: s.agentId,
        updatedAt: now,
      });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user",
        status: "complete",
        text: s.text,
        updatedAt: now,
      });
      const outboxId = await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: `probe-${messageId}`,
        messageId,
        text: s.text,
        attachmentIds: [],
        status: "pending",
      });
      await ctx.scheduler.runAfter(0, internal.bridge.dispatch, { outboxId });
      out.push({ chatId, instanceName: s.instanceName });
    }
    return out;
  },
});

// ── DEV-ONLY: load-test seeding + the all-pool scaling probe (Phase 0) ───────
// Bulk-seed a large agent catalogue under one instance so the all-pool path (a
// groupless, grantless user's enrichUserAgents) can be measured at CATALOGUE
// SCALE against the real self-hosted backend -- the ONLY place Convex's
// per-function caps (32k docs scanned / 16 MiB / 4,096 db calls) are enforced.
// Rows are inert (discovered + present, no creds, no dispatch). BLIND insert (no
// per-row existence read -- that would itself burn the 4,096 read cap during the
// seed); re-running ADDS more, so use a fresh instanceName per measurement or
// dev:reset. `offset` lets a caller batch past the 16k-writes-per-mutation cap.
export const seedAgentCatalogue = mutation({
  args: {
    instanceName: v.string(),
    count: v.number(),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, { instanceName, count, offset }) => {
    assertDev();
    const base = offset ?? 0;
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("agents", {
        instanceName,
        agentId: `bench-${base + i}`,
        source: "discovered",
        presentInLastOk: true,
        isDefaultOnInstance: false,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
    return { inserted: count, base };
  },
});

// Tear down a seeded catalogue (pairs with seedAgentCatalogue). Bounded per call
// (<=8000, under the 16k-writes-per-mutation cap); call repeatedly while moreLikely.
export const deleteAgentsByInstance = mutation({
  args: { instanceName: v.string(), max: v.optional(v.number()) },
  handler: async (ctx, { instanceName, max }) => {
    assertDev();
    const limit = max ?? 8000;
    const rows = await ctx.db
      .query("agents")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .take(limit);
    for (const r of rows) await ctx.db.delete(r._id);
    return { deleted: rows.length, moreLikely: rows.length === limit };
  },
});

// Create N chats owned by a given user (the load harness provisions a subscriber's
// chats AFTER it learns the user's id from getMe). Optionally bind each to a seeded
// (instance, agent) so getChatAgent resolves a provider kind. Returns the chatIds so
// the harness can drive synthetic /bridge/ingest streams into them. Dev-gated.
export const seedChatsForUser = mutation({
  args: {
    userId: v.id("users"),
    count: v.number(),
    instanceName: v.optional(v.string()),
    agentId: v.optional(v.string()),
  },
  handler: async (ctx, { userId, count, instanceName, agentId }) => {
    assertDev();
    const now = Date.now();
    const chatIds: Id<"chats">[] = [];
    for (let i = 0; i < count; i++) {
      const chatId = await ctx.db.insert("chats", {
        userId,
        title: `loadtest ${i}`,
        updatedAt: now,
        ...(instanceName ? { instanceName } : {}),
        ...(agentId ? { agentId } : {}),
      });
      chatIds.push(chatId);
    }
    return { chatIds };
  },
});

// Bulk-seed N alternating COMPLETE user/assistant messages into one chat, for
// perf-testing the long-thread regime (message-list render, scroll, loadChatView
// read cost) without driving N real turns. Realistic multi-sentence assistant
// bodies so each row has a representative height. Dev-gated. Inserts are bounded by
// `count` (keep well under the per-mutation write limit).
export const seedManyMessages = mutation({
  args: { chatId: v.id("chats"), count: v.number() },
  handler: async (ctx, { chatId, count }) => {
    assertDev();
    const chat = await ctx.db.get(chatId);
    if (chat === null) throw new Error("seedManyMessages: chat not found");
    const now = Date.now();
    const body =
      "This is a representative assistant reply with a few sentences of prose so " +
      "the message has a realistic height in the thread. It mentions a couple of " +
      "ideas and wraps across multiple lines the way a real answer would. ";
    for (let i = 0; i < count; i++) {
      const role = i % 2 === 0 ? ("user" as const) : ("assistant" as const);
      await ctx.db.insert("messages", {
        chatId,
        userId: chat.userId,
        role,
        status: "complete" as const,
        text:
          role === "user"
            ? `Question ${i}: how does the thread perform with many messages?`
            : `Answer ${i}. ${body.repeat(3)}`,
        updatedAt: now + i,
      });
    }
    return { seeded: count };
  },
});

// A fresh user with NO groups and NO direct grants -> enrichUserAgents resolves
// the ALL pool (every discovered+present agent). Returns the userId so the probe
// below can measure that exact path. Dev-gated.
export const makeGrantlessUser = mutation({
  args: {},
  handler: async (ctx) => {
    assertDev();
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: `loadtest-${userId}`,
    });
    return { userId };
  },
});

// Resolve enrichUserAgents for one user and report the SHAPE of the work (count +
// whether it used the all-pool). Timing is measured EXTERNALLY: Date.now() is
// frozen within a Convex transaction, so wall-clock the `npx convex run` call
// and/or read the convex dev execution log. A cap blow surfaces as a thrown error
// from the run, not a return value -- that IS the signal.
export const enrichProbe = query({
  args: { userId: v.optional(v.id("users")) },
  handler: async (ctx, { userId }) => {
    assertDev();
    let uid = userId;
    if (!uid) {
      const p = await ctx.db.query("profiles").first();
      uid = p?.userId;
    }
    if (!uid) return { ok: false as const, reason: "no profile" };
    const grants = await enrichUserAgents(ctx, uid);
    return {
      ok: true as const,
      userId: uid,
      agentCount: grants.length,
      viaAll: grants.length > 0 && grants.every((g) => g.via === "all"),
      sample: grants.slice(0, 2).map((g) => ({
        instanceName: g.instanceName,
        agentId: g.agentId,
        via: g.via,
        state: g.state,
      })),
    };
  },
});

// DEV-only: exercise the 2c sub-agent INTERACTION end-to-end. `sendToSubAgent` needs
// an authenticated user (requireActive), so the CLI/live-bench can't call it — this
// inserts the interaction as the chat OWNER + POSTs to the bridge exactly like the
// real action. The reply is recorded async by the observer (recordInteractionReply).
export const devPrepareInteraction = internalMutation({
  args: {
    chatId: v.id("chats"),
    childSessionKey: v.string(),
    userText: v.string(),
  },
  handler: async (ctx, { chatId, childSessionKey, userText }) => {
    assertDev();
    const chat = await ctx.db.get(chatId);
    if (chat === null) return null;
    const child = await ctx.db
      .query("subAgents")
      .withIndex("by_child", (q) => q.eq("childSessionKey", childSessionKey))
      .first();
    if (!child || child.chatId !== chatId) return null;
    const res = await resolveTargetForChat(ctx, chat, chat.userId);
    if (!res.target) return null;
    const target = res.target;
    // Same tenant guard as testSend: a dev live op NEVER touches a protected tenant.
    assertDevInstance(target.instanceName);
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", target.instanceName))
      .first();
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName: target.instanceName,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    const text = userText.trim().slice(0, 8000);
    const now = Date.now();
    const interactionId = await ctx.db.insert("subAgentInteractions", {
      chatId,
      childSessionKey,
      userText: text,
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
    });
    return {
      interactionId: interactionId as string,
      bridgeUrl: bridgeUrl ?? null,
      text,
      routing: {
        chatId: chatId as string,
        openclawChatId: chat.openclawChatId ?? null,
        agentId: target.agentId,
        canonical: target.canonical,
        instanceName: target.instanceName,
      },
    };
  },
});

export const testSubAgentInteraction = action({
  args: {
    chatId: v.id("chats"),
    childSessionKey: v.string(),
    text: v.string(),
    // SPIKE (attachments-to-child): inline base64 attachment(s), same shape as the
    // main dispatch — passed through /subagent-send to the child chat.send.
    attachments: v.optional(
      v.array(
        v.object({
          type: v.string(),
          mimeType: v.string(),
          fileName: v.string(),
          content: v.string(),
        }),
      ),
    ),
  },
  handler: async (
    ctx,
    { chatId, childSessionKey, text, attachments },
  ): Promise<{ ok: boolean; interactionId?: string; reason?: string }> => {
    const prep = await ctx.runMutation(internal.dev.devPrepareInteraction, {
      chatId,
      childSessionKey,
      userText: text,
    });
    if (prep === null) return { ok: false, reason: "prepare_failed" };
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!prep.bridgeUrl || !sharedSecret) {
      return { ok: false, reason: "not_configured" };
    }
    const httpRes = await fetch(
      `${prep.bridgeUrl.replace(/\/$/, "")}/subagent-send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: sharedSecret,
        },
        body: JSON.stringify({
          ...prep.routing,
          childSessionKey,
          interactionId: prep.interactionId,
          message: prep.text,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
      },
    );
    return httpRes.ok
      ? { ok: true, interactionId: prep.interactionId }
      : { ok: false, reason: `http_${httpRes.status}` };
  },
});
