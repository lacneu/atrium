// Bridge version & compatibility — ACTIVE snapshot of the bridge /capabilities.
//
// A cron (`pollBridgeCompat`, every 5 minutes) GETs the bridge's unauthenticated
// /capabilities and upserts a singleton `bridgeCompat` doc: bridgeVersion /
// protocolVersion, the CompatManifest (per-provider support ranges + validated
// versions) and per-instance capability targets. Distinct from `bridgeHealth`
// (1-minute liveness): the compat manifest only changes on a bridge/gateway
// upgrade, so it gets a SLOWER cadence and a FAILED poll preserves the
// last-good snapshot (serve last-good, like agent discovery) — /health already
// answers "is the bridge up right now". An OLD bridge without the additive
// fields stores compat:null (the frontend has a legacy policy for that).
// SECURITY: /capabilities is non-secret (names/versions/capability booleans);
// BRIDGE_URL lives in deployment env, never a table/browser.

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  QueryCtx,
} from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  requireActive,
  requireOwnedChat,
  requirePermission,
} from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { bridgeCompatTarget } from "./schema";
import {
  capabilitiesForInstance,
  normalizeCapabilitiesBody,
  summarizeCompat,
  type CompatSummary,
} from "./lib/compat";
import { resolveTargetForChat } from "./routing";

const COMPAT_KEY = "singleton";

async function readDoc(ctx: QueryCtx): Promise<Doc<"bridgeCompat"> | null> {
  return await ctx.db
    .query("bridgeCompat")
    .withIndex("by_key", (q) => q.eq("key", COMPAT_KEY))
    .unique();
}

/** Cron: poll the bridge /capabilities and upsert the snapshot. Tolerant — an
 *  unreachable/HTTP-error/non-JSON bridge records a failure REASON CODE while
 *  preserving the last-good compat data, never a thrown action (a thrown
 *  action would retry and never record). */
export const pollBridgeCompat = internalAction({
  args: {},
  handler: async (ctx) => {
    const bridgeUrl = process.env.BRIDGE_URL;
    if (!bridgeUrl) {
      await ctx.runMutation(internal.compat.recordCompatFailure, {
        error: "not_configured",
      });
      return;
    }
    try {
      const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/capabilities`, {
        method: "GET",
      });
      if (!res.ok) {
        await ctx.runMutation(internal.compat.recordCompatFailure, {
          error: `http_${res.status}`,
        });
        return;
      }
      const body: unknown = await res.json();
      // Defensive normalization of the network body; a LEGACY bridge (no
      // additive fields) lands as nulls + empty targets — stored as-is so the
      // readers can apply the legacy policy. BRIDGE_INSTANCE_NAME (the instance
      // THIS single bridge serves — Convex owns instance identity) lets the
      // normalizer attribute + resolve the served instance from the bridge's
      // top-level gatewayVersion, so the version-gated UI resolves even with no
      // live session and no OPENCLAW_INSTANCE_NAME on the bridge.
      const normalized = normalizeCapabilitiesBody(
        body,
        process.env.BRIDGE_INSTANCE_NAME ?? null,
      );
      await ctx.runMutation(internal.compat.upsertBridgeCompat, normalized);
    } catch {
      await ctx.runMutation(internal.compat.recordCompatFailure, {
        error: "unreachable",
      });
    }
  },
});

/** Successful poll: full explicit overwrite of the singleton (clears any stale
 *  lastError, exactly like upsertBridgeHealth). */
export const upsertBridgeCompat = internalMutation({
  args: {
    bridgeVersion: v.union(v.string(), v.null()),
    protocolVersion: v.union(v.number(), v.null()),
    compat: v.any(),
    targets: v.array(bridgeCompatTarget),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await readDoc(ctx);
    const fields = {
      reachable: true,
      lastError: undefined,
      bridgeVersion: args.bridgeVersion,
      protocolVersion: args.protocolVersion,
      compat: args.compat,
      targets: args.targets,
      fetchedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("bridgeCompat", { key: COMPAT_KEY, ...fields });
  },
});

/** FAILED poll: record the outcome (reachable:false + reason code + fetchedAt)
 *  while PRESERVING the last-good manifest/targets — compat is slow-moving
 *  metadata, and a bridge blip must not flip the frontend to the legacy
 *  policy. First-ever failure inserts an empty stub (compat:null). */
export const recordCompatFailure = internalMutation({
  args: { error: v.string() },
  handler: async (ctx, { error }) => {
    const now = Date.now();
    const existing = await readDoc(ctx);
    if (existing) {
      await ctx.db.patch(existing._id, {
        reachable: false,
        lastError: error,
        fetchedAt: now,
      });
    } else {
      await ctx.db.insert("bridgeCompat", {
        key: COMPAT_KEY,
        reachable: false,
        lastError: error,
        bridgeVersion: null,
        protocolVersion: null,
        compat: null,
        targets: [],
        fetchedAt: now,
      });
    }
  },
});

/** Full compat snapshot for the Settings Bridge tab (same gate as
 *  getBridgeHealth: any user granted bridge.read; admins via wildcard).
 *  `configuredInstances` rides along (same source as agents.listInstanceNames,
 *  the list resolveInstanceClaim resolves against) so snapshotTabGate can fail
 *  CLOSED when a CONFIGURED instance is missing from the live targets — the
 *  bridge's default-instance write could land on it (Codex review P2). */
export const getBridgeCompat = query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, PERMISSIONS.BRIDGE_READ);
    const doc = await readDoc(ctx);
    if (doc === null) return null;
    const instances = await ctx.db.query("instances").collect();
    return {
      reachable: doc.reachable,
      lastError: doc.lastError ?? null,
      bridgeVersion: doc.bridgeVersion,
      protocolVersion: doc.protocolVersion,
      compat: doc.compat,
      targets: doc.targets,
      configuredInstances: instances.map((r) => r.name),
      fetchedAt: doc.fetchedAt,
    };
  },
});

/** One instance's provider/version/capabilities (bridge.read — introspection
 *  surface). null = instance unknown to the snapshot (legacy bridge / never
 *  polled) -> the frontend's legacy policy. Direct singleton read — no N+1. */
export const forInstance = query({
  args: { instanceName: v.string() },
  handler: async (ctx, { instanceName }) => {
    await requirePermission(ctx, PERMISSIONS.BRIDGE_READ);
    const doc = await readDoc(ctx);
    if (doc === null) return null;
    return capabilitiesForInstance(doc.targets, instanceName);
  },
});

/** The capabilities behind a CHAT, for capability-driven chat UI: any ACTIVE
 *  user, OWN chats only. Resolves the chat's instance from its binding, falling
 *  back to the routing resolver (the same instance a dispatch would use) for
 *  legacy unbound chats. Direct singleton read after that — no N+1. */
export const forChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const chat = await requireOwnedChat(ctx, userId, chatId);
    const instanceName =
      chat.instanceName ??
      (await resolveTargetForChat(ctx, chat, userId)).target?.instanceName ??
      null;
    if (instanceName === null) return null;
    const doc = await readDoc(ctx);
    if (doc === null) return null;
    return capabilitiesForInstance(doc.targets, instanceName);
  },
});

/** Internal: the /api/v1/compat summary (the httpAction cannot touch the db;
 *  it runs this AFTER its own auth + permission check). */
export const compatInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<CompatSummary> => {
    return summarizeCompat(await readDoc(ctx));
  },
});
