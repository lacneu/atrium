// Agent discovery cache + the M:N user↔agent join (userAgents). See
// docs/MULTI_AGENT_REDESIGN.md. The bridge `/agents` is the source of truth; this
// module caches it RESILIENTLY (a failed poll never empties the cache nor flips
// per-agent presence) and is the authorization whitelist for chat binding +
// dispatch. NO secrets — non-secret instance/agent NAMES only.

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireActive, requireAdmin } from "./lib/access";
import { resolvePollTargets } from "./lib/bridgeRouting";
import { resolveTargetForTurn } from "./routing";
import { normalizeAgentTypes, resolveAgentTypes } from "./lib/agentTypes";

// Normalized agent descriptor the bridge `/agents` returns (and the poller relays
// into the cache). Matches bridge `NormalizedAgent` (server.ts).
const agentDescriptor = v.object({
  agentId: v.string(),
  displayName: v.union(v.string(), v.null()),
  emoji: v.union(v.string(), v.null()),
  model: v.union(v.string(), v.null()),
  isDefaultOnInstance: v.boolean(),
});

// ===========================================================================
// DISCOVERY CACHE (resilient — red-team B2 / blind-spot-1)
// ===========================================================================

async function upsertInstanceDiscovery(
  ctx: MutationCtx,
  instanceName: string,
  patch:
    | { ok: true; now: number }
    | { ok: false; error: string; now: number },
): Promise<void> {
  const existing = await ctx.db
    .query("instanceDiscovery")
    .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
    .first();
  if (patch.ok) {
    // IDEMPOTENT WRITE: the ONLY consumer-read field is the `lastPollOk` BOOLEAN
    // (enrichUserAgents / groups state = "stale" iff !lastPollOk; there is NO
    // time-based staleness on the timestamps — verified). So a steady-state
    // success (already ok, no error) changes only `lastPollAt`/`lastOkAt`, which
    // nothing reads to decide behavior. Skipping that no-op write keeps
    // instanceDiscovery — read by enrichUserAgents per grant — cache-stable across
    // polls, avoiding a per-interval invalidation of the chat queries.
    if (existing && existing.lastPollOk === true && existing.error === undefined) {
      return; // nothing a consumer reads changed
    }
    const fields = {
      instanceName,
      lastPollAt: patch.now,
      lastPollOk: true,
      lastOkAt: patch.now,
      error: undefined,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("instanceDiscovery", fields);
  } else {
    // FAILURE: preserve lastOkAt (the staleness window); never erase last-good.
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastPollAt: patch.now,
        lastPollOk: false,
        error: patch.error,
      });
    } else {
      await ctx.db.insert("instanceDiscovery", {
        instanceName,
        lastPollAt: patch.now,
        lastPollOk: false,
        error: patch.error,
      });
    }
  }
}

/** Apply a SUCCESSFUL discovery: upsert seen agents (presentInLastOk=true) and
 *  flip absent DISCOVERED rows to presentInLastOk=false (deleted on the gateway).
 *  NEVER deletes rows (a binding must still resolve to surface the re-bind). */
// Bound + re-validate the bridge's usage ride-along before storing (the wire is
// not the schema): per provider, rate-limit windows {label, usedPercent, resetAt}.
type StoredUsage = {
  provider: string;
  windows: { label: string; usedPercent: number; resetAt: number | null }[];
}[];
function normalizeUsageForStore(raw: unknown): StoredUsage | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StoredUsage = [];
  for (const p of raw.slice(0, 8)) {
    const provider = (p as { provider?: unknown })?.provider;
    const windows = (p as { windows?: unknown })?.windows;
    if (typeof provider !== "string" || !Array.isArray(windows)) continue;
    const ws = [];
    for (const w of windows.slice(0, 6)) {
      const label = (w as { label?: unknown })?.label;
      const usedPercent = (w as { usedPercent?: unknown })?.usedPercent;
      const resetAt = (w as { resetAt?: unknown })?.resetAt;
      if (typeof label !== "string" || typeof usedPercent !== "number") continue;
      ws.push({
        label: label.slice(0, 24),
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        resetAt: typeof resetAt === "number" ? resetAt : null,
      });
    }
    if (ws.length > 0) out.push({ provider: provider.slice(0, 32), windows: ws });
  }
  return out.length > 0 ? out : undefined;
}

// Subscription-usage read models. Content-free (labels/percent/reset) — safe
// for every authenticated user; the CHAT-scoped query resolves the chat's
// EFFECTIVE instance (owner-checked), the admin one lists all instances.
export const usageForChat = query({
  args: {
    chatId: v.id("chats"),
    // MULTI-AGENT per-turn: the composer's ACTIVE target (what the NEXT send
    // will use) — per-option AUTHENTICATED below, so a user can only read the
    // quota of instances their grants actually reach (codex P2).
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { chatId, routedAgent }) => {
    const { userId } = await requireActive(ctx);
    const chat = await ctx.db.get(chatId);
    if (chat === null || chat.userId !== userId) return null;
    // ALWAYS resolve the EFFECTIVE target (chosen per-turn agent, or the chat's
    // own resolution): a chat whose agent access was revoked resolves to a null
    // target — return null rather than leaking the revoked instance's quota
    // through the raw binding (codex P2 ×2).
    const resolved = await resolveTargetForTurn(
      ctx,
      chat,
      userId,
      routedAgent ?? null,
    );
    if (resolved.target === null) return null;
    const instanceName = resolved.target.instanceName;
    const row = await ctx.db
      .query("instanceUsage")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .first();
    if (!row) return null;
    return { usage: row.usage, updatedAt: row.updatedAt };
  },
});

export const usageForInstances = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("instanceUsage").collect();
    return rows.map((r) => ({
      instanceName: r.instanceName,
      usage: r.usage,
      updatedAt: r.updatedAt,
    }));
  },
});

export const recordInstanceUsage = internalMutation({
  args: {
    instanceName: v.string(),
    usage: v.array(
      v.object({
        provider: v.string(),
        windows: v.array(
          v.object({
            label: v.string(),
            usedPercent: v.number(),
            resetAt: v.union(v.number(), v.null()),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, { instanceName, usage }) => {
    const existing = await ctx.db
      .query("instanceUsage")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .first();
    const fields = { instanceName, usage, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("instanceUsage", fields);
  },
});

export const applyDiscovery = internalMutation({
  args: {
    instanceName: v.string(),
    agents: v.array(agentDescriptor),
    // Set ONLY when the poller has CONFIRMED (via the bridge `count`) that the
    // gateway genuinely returned zero agents — so an empty list flips absent rows
    // to deleted instead of being ignored. Default false keeps the belt-and-
    // suspenders guard for every other path (a shape-drifted [] never mass-deletes).
    allowEmpty: v.optional(v.boolean()),
  },
  handler: async (ctx, { instanceName, agents, allowEmpty }) => {
    const now = Date.now();
    await upsertInstanceDiscovery(ctx, instanceName, { ok: true, now });

    const existing = await ctx.db
      .query("agents")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .collect();
    const byId = new Map(existing.map((e) => [e.agentId, e]));
    const seen = new Set<string>();

    for (const a of agents) {
      seen.add(a.agentId);
      const cur = byId.get(a.agentId);
      // The fields any CONSUMER reads (enrichUserAgents / the picker). `lastSeenAt`
      // is a heartbeat NOTHING reads, so it is DELIBERATELY excluded from the
      // change check below.
      const next = {
        displayName: a.displayName ?? undefined,
        emoji: a.emoji ?? undefined,
        model: a.model ?? undefined,
        isDefaultOnInstance: a.isDefaultOnInstance,
        source: "discovered" as const,
        presentInLastOk: true,
      };
      if (cur) {
        // IDEMPOTENT WRITE: only patch when a consumer-visible field actually
        // CHANGED. A steady-state poll that re-sees identical agents must NOT
        // rewrite the row — that would invalidate every reactive query reading
        // `agents` (enrichUserAgents -> chat sidebar/header chip, new-chat picker)
        // on EVERY poll interval, forcing a re-execution storm that a constrained
        // backend can't keep up with. Bumping `lastSeenAt` alone never justifies a
        // write (no one reads it). `presentInLastOk` IS in the check, so a
        // deleted->returned recovery still writes (routing-critical).
        const changed =
          cur.displayName !== next.displayName ||
          cur.emoji !== next.emoji ||
          cur.model !== next.model ||
          cur.isDefaultOnInstance !== next.isDefaultOnInstance ||
          cur.source !== next.source ||
          cur.presentInLastOk !== next.presentInLastOk;
        if (changed) await ctx.db.patch(cur._id, { ...next, lastSeenAt: now });
      } else {
        // Opt-in strict: a NEWLY discovered agent arrives DISABLED — an admin must
        // enable it before it is routable/grantable. Stamping `enabled: false` at
        // INSERT (never on the patch path above, which must not clobber an admin's
        // choice) makes the state EXPLICIT and, crucially, closes the rollout-window
        // hole: a legacy pre-feature agent is `enabled: undefined` (grandfathered by
        // backfillEnabledOnce), while an agent discovered AFTER this deploy — even in
        // the ≤1-tick window before the first backfill run — is `false` and so is
        // skipped by the backfill (which only grandfathers `undefined`), never
        // auto-enabled. See backfillEnabledOnce.
        await ctx.db.insert("agents", {
          instanceName,
          agentId: a.agentId,
          firstSeenAt: now,
          lastSeenAt: now,
          enabled: false,
          ...next,
        });
      }
    }
    // Discovered rows absent from this successful poll => deleted on the gateway.
    // GUARD (red-team MAJOR 1): flip presence when the poll returned agents, OR
    // when `allowEmpty` confirms a GENUINELY empty gateway (Codex P2 — a real
    // "last agent deleted" must mark them deleted, not be ignored). A shape-drifted
    // [] (allowEmpty unset) still NEVER mass-deletes.
    if (agents.length > 0 || allowEmpty) {
      for (const e of existing) {
        if (e.source === "discovered" && e.presentInLastOk && !seen.has(e.agentId)) {
          await ctx.db.patch(e._id, { presentInLastOk: false });
        }
      }
    }
  },
});

/** Record a FAILED discovery: serve last-good, never empty / never flip presence. */
export const recordDiscoveryFailure = internalMutation({
  args: { instanceName: v.string(), error: v.string() },
  handler: async (ctx, { instanceName, error }) => {
    await upsertInstanceDiscovery(ctx, instanceName, {
      ok: false,
      error,
      now: Date.now(),
    });
  },
});

/** Cron: poll the bridge `/agents` (+ `/capabilities`) for every instance and
 *  cache the result resiliently. Mono-tenant Phase 1: the bridge ignores
 *  `?instance` and returns its single gateway's agents; the loop still works for
 *  one or many instances. */
export const pollAgentDiscovery = internalAction({
  args: {},
  handler: async (ctx) => {
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!sharedSecret) return; // not configured — nothing to poll

    // Model M: poll EACH instance's OWN bridge (resolvePollTargets) — each hits its
    // own gateway, so there is NO cross-instance cache corruption (the reason the
    // mono-tenant version polled only the served instance). An instance without its
    // own bridgeUrl falls back to the env BRIDGE_URL only when it is the served /
    // sole instance, so the env bridge's agents are never cached under another name.
    const instances = await ctx.runQuery(
      internal.agents.listInstancesForPoll,
      {},
    );
    const targets = resolvePollTargets(instances, {
      envUrl: process.env.BRIDGE_URL?.trim() || null,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
    });

    for (const { name: instanceName, url: base } of targets) {
      await discoverInstanceAgents(ctx, instanceName, base, sharedSecret);
    }
  },
});

/**
 * Discover + ingest ONE instance's agents from its bridge `/agents`, applying the SAME
 * resilient fail-closed policy as the cron (a shape-drift / old-bridge response serves
 * last-good; a genuinely empty new-bridge response flips deleted agents out). Shared by
 * the cron loop AND the on-demand "force sync" (forceInstanceSync) so the manual path is
 * scoped to ONE instance — never waiting on or mutating other instances. NEVER throws;
 * records the failure. Returns the outcome for the manual caller: `reached` is false ONLY
 * on a transport error (bridge unreachable); `synced` is true ONLY when discovery actually
 * APPLIED (agents found, or a genuinely-empty new-bridge response) — false when it
 * recorded a failure (HTTP error / not-paired / shape-drift). So the UI can tell "synced"
 * from "bridge answered but could not sync yet (pair the device first)".
 */
export async function discoverInstanceAgents(
  ctx: ActionCtx,
  instanceName: string,
  base: string,
  sharedSecret: string,
): Promise<{
  synced: boolean;
  reached: boolean;
  httpStatus: number | null;
  agentCount: number;
}> {
  try {
    const res = await fetch(
      `${base}/agents?instance=${encodeURIComponent(instanceName)}`,
      { method: "GET", headers: { Authorization: sharedSecret } },
    );
    if (!res.ok) {
      await ctx.runMutation(internal.agents.recordDiscoveryFailure, {
        instanceName,
        error: `http_${res.status}`,
      });
      return { synced: false, reached: true, httpStatus: res.status, agentCount: 0 };
    }
    const body = (await res.json()) as {
      usage?: unknown;
      agents?: Array<Record<string, unknown>>;
      count?: number;
    };
    const list = Array.isArray(body.agents) ? body.agents : [];
    // Raw gateway agent count (pre-normalization) from a NEW bridge; null when the bridge
    // is old (no `count`) — then we can't disambiguate, fail closed.
    const rawCount = typeof body.count === "number" ? body.count : null;
    const agents = list
      .map((a) => ({
        agentId: String(a.agentId ?? ""),
        displayName: typeof a.displayName === "string" ? a.displayName : null,
        emoji: typeof a.emoji === "string" ? a.emoji : null,
        model: typeof a.model === "string" ? a.model : null,
        isDefaultOnInstance: a.isDefaultOnInstance === true,
      }))
      .filter((a) => a.agentId.length > 0);
    if (agents.length === 0) {
      // GENUINELY empty gateway (new bridge confirms rawCount===0): apply the empty
      // discovery so deleted agents flip to presentInLastOk=false — otherwise we keep
      // routing to a deleted agent (Codex P2). Otherwise fail CLOSED (serve last-good):
      // rawCount===null = old bridge (can't tell); rawCount>0 = shape-drift.
      if (rawCount === 0) {
        await ctx.runMutation(internal.agents.applyDiscovery, {
          instanceName,
          agents: [],
          allowEmpty: true,
        });
        // genuinely empty -> applied
        return { synced: true, reached: true, httpStatus: 200, agentCount: 0 };
      }
      await ctx.runMutation(internal.agents.recordDiscoveryFailure, {
        instanceName,
        error: rawCount === null ? "empty_discovery" : "shape_drift",
      });
      return { synced: false, reached: true, httpStatus: 200, agentCount: 0 };
    }
    await ctx.runMutation(internal.agents.applyDiscovery, { instanceName, agents });
    // Usage ride-along -> the DEDICATED table (never instanceDiscovery: that one
    // is cache-stable for the chat queries). Best-effort, last-good semantics:
    // an absent/empty snapshot never clears the previous one.
    const usage = normalizeUsageForStore(body.usage);
    if (usage !== undefined) {
      await ctx.runMutation(internal.agents.recordInstanceUsage, {
        instanceName,
        usage,
      });
    }
    return { synced: true, reached: true, httpStatus: 200, agentCount: agents.length };
  } catch {
    await ctx.runMutation(internal.agents.recordDiscoveryFailure, {
      instanceName,
      error: "unreachable",
    });
    return { synced: false, reached: false, httpStatus: null, agentCount: 0 };
  }
}

/** Internal: the configured instance names (for the poller loop). */
export const listInstanceNames = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const rows = await ctx.db.query("instances").collect();
    return rows.map((r) => r.name);
  },
});

/** Internal: instance names + their per-instance bridgeUrl (Model M poller fan-out). */
export const listInstancesForPoll = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<Array<{ name: string; bridgeUrl: string | null }>> => {
    const rows = await ctx.db.query("instances").collect();
    return rows.map((r) => ({ name: r.name, bridgeUrl: r.bridgeUrl ?? null }));
  },
});

// ===========================================================================
// READ — discovered agents (admin) + the user's agents (picker / editor)
// ===========================================================================

/** Admin: discovered agents for one instance + the poll outcome (Instances tab). */
export const listAgentsForInstance = query({
  args: { instanceName: v.string() },
  handler: async (ctx, { instanceName }) => {
    await requireAdmin(ctx);
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .collect();
    const discovery = await ctx.db
      .query("instanceDiscovery")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .first();
    // The instance's admin-chosen default agent (live, so the dialog reflects a
    // setInstanceDefaultAgent immediately). `.first()` mirrors routing's name lookup.
    const inst = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    return {
      agents: agents.map((a) => ({
        agentId: a.agentId,
        displayName: a.displayName ?? null,
        emoji: a.emoji ?? null,
        model: a.model ?? null,
        description: a.description ?? null,
        isDefaultOnInstance: a.isDefaultOnInstance ?? false,
        enabled: a.enabled === true,
        // Effective agent TYPE(s) — never empty (conversational by default).
        types: resolveAgentTypes(a.types),
        source: a.source,
        presentInLastOk: a.presentInLastOk,
      })),
      defaultAgentId: inst?.defaultAgentId ?? null,
      discovery: discovery
        ? {
            lastPollAt: discovery.lastPollAt,
            lastPollOk: discovery.lastPollOk,
            lastOkAt: discovery.lastOkAt ?? null,
            error: discovery.error ?? null,
          }
        : null,
    };
  },
});

// Admin: ALL discovered agents grouped by instance name — one read for the whole
// Instances table's "Agents" column (vs one per-row query). Presence + the native
// instance default only; non-secret. Agents are DISCOVERED from the bridge (never
// admin-entered — the prod-bug fix), so this is read-only.
export const listAllInstanceAgents = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const agents = await ctx.db.query("agents").take(2000);
    const byInstance: Record<
      string,
      Array<{
        agentId: string;
        displayName: string | null;
        emoji: string | null;
        isDefaultOnInstance: boolean;
        enabled: boolean;
        presentInLastOk: boolean;
      }>
    > = {};
    for (const a of agents) {
      (byInstance[a.instanceName] ??= []).push({
        agentId: a.agentId,
        displayName: a.displayName ?? null,
        emoji: a.emoji ?? null,
        isDefaultOnInstance: a.isDefaultOnInstance ?? false,
        enabled: a.enabled === true,
        presentInLastOk: a.presentInLastOk,
      });
    }
    return byInstance;
  },
});

// ===========================================================================
// ADMIN curation — per-instance enabled set + default agent (Phase 1: INERT,
// set-but-not-read; ENFORCEMENT + routing land in Phase 2/3).
// ===========================================================================

async function instanceByName(
  ctx: MutationCtx,
  name: string,
): Promise<Doc<"instances"> | null> {
  return await ctx.db
    .query("instances")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
}

/** The enabled agentIds for an instance, sorted (deterministic default election). */
// Agent ids ELIGIBLE to be an instance's default: ENABLED and currently PRESENT on
// the gateway (presentInLastOk !== false; undefined = present). An enabled-but-ABSENT
// agent is excluded — the UI hides absent agents, so a default pointing at one would
// render as "no default" (the invariant is exactly-one VISIBLE default). Sorted for a
// stable, deterministic pick.
async function eligibleDefaultAgentIds(
  ctx: MutationCtx,
  instanceName: string,
): Promise<string[]> {
  const agents = await ctx.db
    .query("agents")
    .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
    .collect();
  return agents
    .filter((a) => a.enabled === true && a.presentInLastOk !== false)
    .map((a) => a.agentId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Admin: enable/disable a DISCOVERED agent for an instance (the downstream
 *  availability gate — Phase 2 enforces it).
 *
 *  INVARIANT: an instance with >=1 ENABLED agent always has exactly one default
 *  (0 enabled => no default, which is allowed). So:
 *   - enabling when there is no valid default (e.g. the first/only selected agent)
 *     makes THIS agent the default;
 *   - disabling the default re-elects another enabled agent, or clears it when
 *     none remain. */
export const setAgentEnabled = mutation({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { instanceName, agentId, enabled }) => {
    await requireAdmin(ctx);
    const agent = await agentRow(ctx, instanceName, agentId);
    if (agent === null) throw new Error("Not found: agent");
    await ctx.db.patch(agent._id, { enabled });

    const inst = await instanceByName(ctx, instanceName);
    if (inst === null) return;
    const ids = await eligibleDefaultAgentIds(ctx, instanceName);

    // Heal the default on EVERY toggle: if the current default is no longer ELIGIBLE
    // (disabled OR gone absent — including a default that was already absent before
    // this toggle of a DIFFERENT agent), re-elect. Prefer the just-enabled agent when
    // it is itself eligible (a single new selection becomes the default); else the
    // first eligible; else clear (ids[0] is undefined for an empty set → 0 eligible =
    // no default, which is allowed).
    const valid =
      inst.defaultAgentId != null && ids.includes(inst.defaultAgentId);
    if (!valid) {
      const next = enabled && ids.includes(agentId) ? agentId : ids[0];
      await ctx.db.patch(inst._id, { defaultAgentId: next });
    }
  },
});

/** Longest admin-entered specialty blurb we store — a picker subtitle, not a
 *  bio. Mirrored by the UI's maxLength. */
export const AGENT_DESCRIPTION_MAX_CHARS = 280;

/** ADMIN curation: the one-or-two-sentence specialty blurb users see in the
 *  agent pickers. Empty/whitespace clears it. Preserved across discovery
 *  polls (applyDiscovery never writes it). */
export const setAgentDescription = mutation({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    description: v.string(),
  },
  handler: async (ctx, { instanceName, agentId, description }) => {
    await requireAdmin(ctx);
    const agent = await agentRow(ctx, instanceName, agentId);
    if (agent === null) throw new Error("Not found: agent");
    const trimmed = description.trim();
    if (trimmed.length > AGENT_DESCRIPTION_MAX_CHARS) {
      throw new Error(
        `Invalid description: exceeds ${AGENT_DESCRIPTION_MAX_CHARS} characters`,
      );
    }
    await ctx.db.patch(agent._id, {
      description: trimmed.length === 0 ? undefined : trimmed,
    });
  },
});

/** Admin: set the instance's default agent. The agent must be discovered AND
 *  enabled. There is NO "clear" — with >=1 enabled agent the default is always
 *  set (the invariant lives in setAgentEnabled); you change it by picking another.
 *  Set-but-INERT in Phase 1 (routing consumes it in Phase 3). */
export const setInstanceDefaultAgent = mutation({
  args: { instanceName: v.string(), agentId: v.string() },
  handler: async (ctx, { instanceName, agentId }) => {
    await requireAdmin(ctx);
    const inst = await instanceByName(ctx, instanceName);
    if (inst === null) throw new Error("Not found: instance");
    const agent = await agentRow(ctx, instanceName, agentId);
    if (agent === null) throw new Error("Not found: agent");
    if (agent.enabled !== true) {
      throw new Error("Refused: the default agent must be enabled first");
    }
    // An ABSENT agent (gone from the gateway) is hidden in the UI, so making it the
    // default would render as "no default" — refuse it (mirror the election filter).
    if (agent.presentInLastOk === false) {
      throw new Error("Refused: the default agent is absent from the gateway");
    }
    await ctx.db.patch(inst._id, { defaultAgentId: agentId });
  },
});

/** Admin: set the TYPE(s) of a discovered agent (convex/lib/agentTypes catalogue).
 *  Every code MUST be in the catalogue (throws on an unknown one — never silently
 *  dropped); the list is de-duplicated + catalogue-ordered. An empty list is stored
 *  as-is and READS back as the default (conversational) via resolveAgentTypes, so an
 *  agent always carries at least one type. PRESERVED across discovery polls. */
export const setAgentTypes = mutation({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    types: v.array(v.string()),
  },
  handler: async (ctx, { instanceName, agentId, types }) => {
    await requireAdmin(ctx);
    const agent = await agentRow(ctx, instanceName, agentId);
    if (agent === null) throw new Error("Not found: agent");
    // Throws on an unknown code; normalises (dedup + catalogue order).
    const normalized = normalizeAgentTypes(types);
    await ctx.db.patch(agent._id, { types: normalized });
  },
});

const AGENT_CASCADE_BATCH = 500;

/** Admin: PERMANENTLY remove a now-ABSENT agent (gateway no longer reports it)
 *  from an instance's list, CASCADING to every group's and user's selection of it.
 *  Only a gateway-absent agent can be removed — a still-present one would just be
 *  re-discovered (disable it instead). DESTRUCTIVE (it deletes group/user
 *  preferences), so the UI confirms first. Idempotent. */
export const removeInstanceAgent = mutation({
  args: { instanceName: v.string(), agentId: v.string() },
  handler: async (ctx, { instanceName, agentId }) => {
    await requireAdmin(ctx);
    const agent = await agentRow(ctx, instanceName, agentId);
    if (agent === null) return; // idempotent — already gone
    if (agent.presentInLastOk) {
      throw new Error(
        "Refused: agent is still present on the gateway — disable it instead of removing it",
      );
    }
    await ctx.db.delete(agent._id);

    // Cascade — every user's grant of this agent (paginated via by_instance_agent).
    // Maintain the per-user "exactly one default" invariant (like removeAgent /
    // deleteInstance): if the purged grant was a user's DIRECT default and they still
    // have other agents, re-elect the first remaining as their default — else the user
    // would be left with agents but no default (UI/effective-resolution would drift to
    // an implicit pick or a group default instead of a real direct default).
    for (;;) {
      const batch = await ctx.db
        .query("userAgents")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", instanceName).eq("agentId", agentId),
        )
        .take(AGENT_CASCADE_BATCH);
      for (const r of batch) {
        await ctx.db.delete(r._id);
        if (r.isDefault === true) {
          const remaining = await ctx.db
            .query("userAgents")
            .withIndex("by_user", (q) => q.eq("userId", r.userId))
            .collect();
          if (remaining.length > 0 && !remaining.some((x) => x.isDefault === true)) {
            await ctx.db.patch(remaining[0]._id, { isDefault: true });
          }
        }
      }
      if (batch.length < AGENT_CASCADE_BATCH) break;
    }
    // Cascade — every group's share of this agent (per-instance set is small).
    const groupRows = await ctx.db
      .query("groupAgents")
      .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
      .collect();
    for (const r of groupRows) {
      if (r.agentId === agentId) await ctx.db.delete(r._id);
    }
    // Re-elect / clear the instance default if it pointed at the removed agent —
    // to an ELIGIBLE (present + enabled) agent, never an absent one (or clear).
    const inst = await instanceByName(ctx, instanceName);
    if (inst && inst.defaultAgentId === agentId) {
      const ids = await eligibleDefaultAgentIds(ctx, instanceName);
      await ctx.db.patch(inst._id, { defaultAgentId: ids[0] });
    }
  },
});

// Provenance of an agent in the effective (CASCADE) set: a DIRECT userAgents
// grant ("user" — the per-user restriction), shared via a group the user belongs
// to ({ group: <key> }), or available because the user belongs to NO group at all
// and therefore sees every discovered agent ("all"). Foundation for the P5
// "who has what" introspection screen (spec §6).
export type AgentVia = "user" | "all" | { group: string };

// The raw user↔agent union BEFORE enrichment/state classification: direct
// userAgents ∪ the agents of the user's groups, deduped by (instanceName,
// agentId) with DIRECT membership winning. `isDefault` is the EFFECTIVE default
// per the precedence (direct default > group default > instance native > code),
// computed WITHOUT regard to deletion (resolve-time skips deleted, exactly as
// pre-P2). Shared by enrichUserAgents (adds `state` + UI fields) AND
// routing.resolveTargetForChat (keeps its own `isDeleted` loop) so the union
// lives in ONE place and the no-group path stays byte-identical.
type EffectiveGrant = {
  instanceName: string;
  agentId: string;
  isDefault: boolean;
  // Carried through for direct grants so enrichment can preserve the existing
  // `source` field verbatim; group-only grants have no userAgents.source.
  source: "manual" | "auto" | null;
  via: AgentVia;
};

type EnrichedUserAgent = {
  instanceName: string;
  agentId: string;
  isDefault: boolean;
  source: "manual" | "auto";
  displayName: string | null;
  emoji: string | null;
  model: string | null;
  // Admin-entered specialty blurb (what this agent is for) — picker subtitle.
  description: string | null;
  kind: "openclaw" | "hermes";
  // Admin enablement state — greys a non-enabled agent in the access editors.
  enabled: boolean;
  // Resolution health for the UI (red-team B2): deleted vs stale vs ok.
  state: "ok" | "deleted" | "stale" | "unknown";
  // Provenance for introspection (P2 §6): direct grant vs which group shares it.
  via: AgentVia;
};

const grantKey = (instanceName: string, agentId: string): string =>
  `${instanceName.length}:${instanceName}/${agentId}`;

// One entry of the POOL a user may draw agents from (see getAgentPool).
type PoolEntry = {
  instanceName: string;
  agentId: string;
  // {group} for the group pool, "all" for the no-group pool.
  via: AgentVia;
  // The RANK (0-based, lowest groupId first) of the lowest group that marked this
  // agent as ITS default -- the "lowest-groupId default wins" precedence. null when
  // no group marked it. For the all-pool there are no groups, so it is 0 when the
  // agent is the instance NATIVE default (isDefaultOnInstance), else null. The REAL
  // effective default is elected in getEffectiveGrants (lowest rank wins).
  defaultRank: number | null;
};

/** The POOL a user may be granted agents FROM. Two regimes:
 *   - in ANY group: the union of the user's groups' shared agents (deduped, the
 *     earlier group by groupId winning), each carrying `via:{group}` and the
 *     group's own default flag;
 *   - in NO group: ALL discovered agents (a groupless user is unconstrained),
 *     each `via:"all"` with the gateway's native-default flag.
 *  Deterministic order so the code-default tiebreak is stable. `inGroup` lets
 *  callers (and the cascade) distinguish the two regimes. PURE-ish (ctx reads). */
/** The user's GROUP pool: the union of their groups' shared agents (deduped, the
 *  lowest-rank group winning, the lowest-groupId group's default preserved).
 *  `existingGroups` counts memberships that resolve to a LIVE group -- 0 means "no
 *  group regime" (an all-dangling membership never flips the user in-group with an
 *  empty pool, which would strip every direct grant). CHEAP: only group reads,
 *  NEVER the full agents scan -- so a no-group user with direct grants skips the
 *  all-pool entirely (the cascade returns the direct rows). */
async function resolveGroupPool(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<{ existingGroups: number; pool: PoolEntry[] }> {
  const memberships = await ctx.db
    .query("groupMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const groupIds = memberships
    .map((m) => m.groupId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pool: PoolEntry[] = [];
  const seen = new Set<string>();
  let rank = 0; // 0-based rank among EXISTING groups (lowest groupId first).
  for (const groupId of groupIds) {
    const group = await ctx.db.get(groupId);
    if (group === null) continue; // dangling membership -> ignore entirely
    const shared = await ctx.db
      .query("groupAgents")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    shared.sort((a, b) =>
      a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0,
    );
    for (const ga of shared) {
      const key = grantKey(ga.instanceName, ga.agentId);
      if (seen.has(key)) {
        // Already added by an earlier (lower-rank) group. Record THIS group's
        // default ONLY if no earlier group already claimed one for this agent --
        // the LOWEST-rank default wins, so a later group can never override an
        // earlier group's own default (lowest-groupId precedence).
        if (ga.isDefault === true) {
          const existing = pool.find(
            (p) =>
              p.instanceName === ga.instanceName && p.agentId === ga.agentId,
          );
          if (existing && existing.defaultRank === null) {
            existing.defaultRank = rank;
          }
        }
        continue;
      }
      seen.add(key);
      pool.push({
        instanceName: ga.instanceName,
        agentId: ga.agentId,
        via: { group: group.key },
        defaultRank: ga.isDefault === true ? rank : null,
      });
    }
    rank++;
  }
  return { existingGroups: rank, pool };
}

/** The no-group ALL pool: every DISCOVERED agent (manual rows excluded -- they are
 *  the unverified fallback the assign/group mutations reject, so they must NOT
 *  become globally bindable: createChat + dispatch authorize against this set).
 *  The EXPENSIVE full agents scan, so callers load it LAZILY -- only when a
 *  groupless user has NO direct restriction. Ordered (instanceName, agentId). */
/** ONE indexed collect of the assignable pool: DISCOVERED + PRESENT agents (the
 *  no-group regime, by design, is "every discovered agent"). Narrowed via
 *  by_source_present so it never scans manual/deleted rows or the whole table.
 *  Returned in the index's NATURAL order so a caller building a keep-FIRST
 *  `(instanceName,agentId)` map mirrors `by_instance_agent.first()` exactly. Shared
 *  by the all-pool grant resolution, the display-context preload, AND the all-pool
 *  default election so a groupless user's enrichment reads this set ONCE, not 2-3x:
 *  the double read previously hit Convex's 32,000 docs-scanned cap at ~16k agents
 *  (a deployment with a very large catalogue should still scope users into groups). */
async function collectPresentAgents(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"agents">[]> {
  return await ctx.db
    .query("agents")
    .withIndex("by_source_present", (q) =>
      q.eq("source", "discovered").eq("presentInLastOk", true),
    )
    .collect();
}

/** PURE transform (no DB read): present-agent docs -> ordered all-pool entries.
 *  Sorts a COPY so the caller's natural-order docs (for the keep-first display map)
 *  are never mutated. NOT capped/truncated -- a cap would make agents beyond it
 *  invisible + unbindable (and could read-only existing chats). */
function poolFromPresentAgents(all: Doc<"agents">[]): PoolEntry[] {
  const sorted = [...all].sort((a, b) =>
    a.instanceName !== b.instanceName
      ? a.instanceName < b.instanceName
        ? -1
        : 1
      : a.agentId < b.agentId
        ? -1
        : a.agentId > b.agentId
          ? 1
          : 0,
  );
  return sorted.map((a) => ({
    instanceName: a.instanceName,
    agentId: a.agentId,
    via: "all" as const,
    defaultRank: a.isDefaultOnInstance === true ? 0 : null,
  }));
}

/** ONE-TIME BACKFILL (opt-in enablement rollout): grandfather every currently
 *  PRESENT discovered agent whose `enabled` was never set (undefined) to
 *  `enabled: true`, so enforcing the opt-in gate does not make agents that are
 *  in use today disappear. An EXPLICITLY disabled agent (enabled:false) is left
 *  untouched. Idempotent — re-running only touches still-unset rows. Admin-only.
 */
// The appMeta singleton row key (mirrors admin.ts / charts.ts).
const APP_META_KEY = "singleton";

/** ONE-SHOT auto-backfill (deploy rollout), cron-driven and guarded by an
 *  appMeta flag: grandfather existing PRESENT agents to `enabled:true` so the
 *  opt-in gate never hides an agent that was in use before this change. It runs
 *  ONCE (a later newly-discovered agent stays opt-in). Both the READ and the
 *  WRITE are paginated so a large catalog cannot exceed a single mutation's
 *  limits (which would abort before the flag is set → agents hidden forever).
 *  Cheap no-op after completion. */
export const backfillEnabledOnce = internalMutation({
  args: {},
  handler: async (ctx) => {
    const meta = await ctx.db
      .query("appMeta")
      .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
      .unique();
    // No singleton yet = not bootstrapped; retry once bootstrap creates it.
    if (meta === null || meta.agentEnabledBackfillDone === true) {
      return { skipped: true };
    }
    // Stamp the rollout start on the FIRST tick so the grandfather set is
    // exactly the agents that existed at deploy — a new agent discovered
    // during a multi-page backfill (or before the first tick) stays opt-in.
    const startedAt =
      meta.agentEnabledBackfillStartedAt ?? Date.now();
    const page = await ctx.db
      .query("agents")
      .withIndex("by_source_present", (q) =>
        q.eq("source", "discovered").eq("presentInLastOk", true),
      )
      .paginate({
        cursor: meta.agentEnabledBackfillCursor ?? null,
        numItems: 500,
      });
    // Empty catalog on the FIRST page = a fresh/purged install (an UPGRADE keeps
    // its discovered rows). Nothing to grandfather → mark done so every agent is
    // opt-in from the start (never auto-enable a later new agent).
    if (page.page.length === 0 && page.isDone) {
      await ctx.db.patch(meta._id, { agentEnabledBackfillDone: true });
      return { skipped: false, done: true, updated: 0 };
    }
    let updated = 0;
    for (const a of page.page) {
      // Only pre-rollout agents are grandfathered; a newer one stays opt-in.
      if (a.enabled === undefined && a._creationTime <= startedAt) {
        await ctx.db.patch(a._id, { enabled: true });
        updated++;
      }
    }
    if (page.isDone) {
      await ctx.db.patch(meta._id, {
        agentEnabledBackfillDone: true,
        agentEnabledBackfillCursor: null,
        agentEnabledBackfillStartedAt: undefined,
      });
      return { skipped: false, done: true, updated };
    }
    await ctx.db.patch(meta._id, {
      agentEnabledBackfillCursor: page.continueCursor,
      agentEnabledBackfillStartedAt: startedAt,
    });
    return { skipped: false, done: false, updated };
  },
});

async function loadAllAgentsPool(
  ctx: QueryCtx | MutationCtx,
): Promise<PoolEntry[]> {
  return poolFromPresentAgents(await collectPresentAgents(ctx));
}

/** The POOL a user may be granted agents FROM (group agents if in any group, else
 *  every discovered agent). For the per-user editor dialog (which needs the WHOLE
 *  pool). `inGroup` lets the UI explain WHAT the pool is. */
export async function getAgentPool(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<{
  inGroup: boolean;
  pool: PoolEntry[];
  // The present-agent docs collected for the all-pool (null for an in-group user),
  // so a caller that also needs display fields reuses this read instead of a second
  // collect (the same dedupe as enrichUserAgents).
  presentDocs: Doc<"agents">[] | null;
}> {
  const { existingGroups, pool } = await resolveGroupPool(ctx, userId);
  if (existingGroups > 0) return { inGroup: true, pool, presentDocs: null };
  const docs = await collectPresentAgents(ctx);
  return { inGroup: false, pool: poolFromPresentAgents(docs), presentDocs: docs };
}

/** THE cascade resolver. The effective set of agents a user may use:
 *    pool       = getAgentPool (group agents if in any group, else ALL agents)
 *    restricted = the user's DIRECT `userAgents` that fall WITHIN that pool
 *    effective  = restricted (if any) ELSE the whole pool
 *  So a per-user direct selection RESTRICTS within the pool; with none, the user
 *  gets the whole pool; with NO group AND no selection, every agent. A direct
 *  grant OUTSIDE the pool (legacy union-era, or a lost group) is dropped. ONE
 *  effective default is elected by precedence: a direct default in the effective
 *  set > the pool's marked default (group.isDefault by lowest groupId/agentId, or
 *  the all-pool native default) > the instance native default > first
 *  deterministic. Deletion is IGNORED here (resolve-time skips deleted). */
/** Enablement enforcement mode. Until the one-shot backfill has grandfathered
 *  existing agents (agentEnabledBackfillDone), a legacy `enabled:undefined`
 *  row must stay usable — so the gate is OPT-OUT (only an explicitly disabled
 *  agent is blocked). Once the backfill is done, it flips to OPT-IN (an agent
 *  must be explicitly enabled). This removes the deploy-time rollout window
 *  where legacy agents would otherwise be hidden. */
export async function agentEnablementStrict(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  const meta = await ctx.db
    .query("appMeta")
    .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
    .unique();
  return meta?.agentEnabledBackfillDone === true;
}

/** Is an agent doc USABLE under the current enforcement mode? `strict`
 *  (opt-in) requires enabled===true for a PRESENT agent; non-strict (rollout)
 *  only blocks an explicitly disabled one. An absent/deleted or missing agent
 *  is never blocked here (presence is a separate axis). A `source:"manual"` agent
 *  (admin fallback — never enumerated by discovery, so the backfill never
 *  grandfathers it) is ALWAYS opt-OUT: it stays usable unless EXPLICITLY disabled,
 *  so strict mode can never silently drop a valid legacy grant to one. */
function agentUsable(
  agent: Doc<"agents"> | null,
  strict: boolean,
): boolean {
  if (agent === null || agent.presentInLastOk === false) return true;
  const optIn = strict && agent.source === "discovered";
  return optIn ? agent.enabled === true : agent.enabled !== false;
}

/** THE single enablement gate for the effective-grants OUTPUT (opt-in): keep a
 *  grant unless its agent is PRESENT-but-not-enabled. An absent/deleted or
 *  missing agent stays (resilient display; enablement is a separate axis from
 *  presence). Applied at every return of getEffectiveGrantsWithPool so no
 *  sub-path (direct / all-pool / group) can leak a disabled agent, and the
 *  restricted-MODE decision above stays on the RAW sets (never widened).
 *  `presentDocsCache` (the all-pool docs, when available) avoids per-grant reads
 *  on the hot path. */
async function filterEnabledGrants(
  ctx: QueryCtx | MutationCtx,
  grants: EffectiveGrant[],
  strict: boolean,
  presentDocsCache?: Doc<"agents">[] | null,
): Promise<EffectiveGrant[]> {
  const byKey = new Map<string, Doc<"agents">>();
  for (const d of presentDocsCache ?? [])
    byKey.set(grantKey(d.instanceName, d.agentId), d);
  const out: EffectiveGrant[] = [];
  for (const g of grants) {
    let agent = byKey.get(grantKey(g.instanceName, g.agentId)) ?? null;
    if (agent === null) {
      agent = await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", g.instanceName).eq("agentId", g.agentId),
        )
        .first();
    }
    if (agentUsable(agent, strict)) out.push(g);
  }
  return out;
}

async function getEffectiveGrantsWithPool(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<{ grants: EffectiveGrant[]; presentDocs: Doc<"agents">[] | null }> {
  const strict = await agentEnablementStrict(ctx);
  const direct = await ctx.db
    .query("userAgents")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  // CHEAP first: only the group regime (no full agents scan). A no-group user with
  // direct grants is resolved entirely from `direct` below, so the all-pool scan is
  // deferred -- it runs ONLY for a groupless user with NO direct restriction.
  const { existingGroups, pool: groupPool } = await resolveGroupPool(ctx, userId);
  const inGroup = existingGroups > 0;

  // RESTRICTION = the user's direct grants. For an IN-GROUP user the group is the
  // boundary, so keep only direct grants WITHIN the pool (a stale grant the user
  // lost group access to is dropped). For a NO-GROUP user there is no boundary, so
  // ALL direct grants count -- byte-identical to pre-P2 (and never dropped just
  // because the agent is momentarily absent from the discovery table). With direct
  // grants present, the user sees EXACTLY those (the narrowing): each keeps its
  // own isDefault (the mutation invariant guarantees <=1), and -- like pre-P2 -- a
  // default-less direct set is left default-less (resolveAgentForChat then falls
  // back to first-by-order). NO election runs over a direct set.
  const restricted = inGroup
    ? direct.filter((r) =>
        groupPool.some(
          (p) => p.instanceName === r.instanceName && p.agentId === r.agentId,
        ),
      )
    : direct;
  if (restricted.length > 0) {
    const out = restricted.map((r) => ({
      instanceName: r.instanceName,
      agentId: r.agentId,
      isDefault: r.isDefault,
      source: r.source,
      via: "user" as const,
    }));
    if (inGroup && !out.some((g) => g.isDefault)) {
      out[0]!.isDefault = true;
    }
    // Enablement gate applied at the OUTPUT, never on the restricted-MODE
    // decision — a user with direct grants stays narrowed, never widened.
    const gatedDirect = await filterEnabledGrants(ctx, out, strict);
    // Re-elect a default if the gate dropped the chosen one (exactly-one).
    if (gatedDirect.length > 0 && !gatedDirect.some((g) => g.isDefault)) {
      gatedDirect[0]!.isDefault = true;
    }
    return { grants: gatedDirect, presentDocs: null };
  }

  // No direct restriction (or in-group with EVERY direct grant out-of-pool): the
  // WHOLE pool, with ONE elected default by precedence. The all-pool is scanned HERE
  // (lazily) -- only reached for a groupless user with no direct grants -- and the
  // collected docs are RETURNED so enrichUserAgents reuses them for the display map
  // (loadAgentContext) instead of a SECOND by_source_present collect (the read that
  // previously doubled the docs-scanned count and hit the 32k cap at ~16k agents).
  let presentDocs: Doc<"agents">[] | null = null;
  let pool: PoolEntry[];
  if (inGroup) {
    pool = groupPool;
  } else {
    presentDocs = await collectPresentAgents(ctx);
    pool = poolFromPresentAgents(presentDocs);
  }
  const out: EffectiveGrant[] = pool.map((p) => ({
    instanceName: p.instanceName,
    agentId: p.agentId,
    isDefault: false,
    source: null,
    via: p.via,
  }));
  if (out.length > 0) {
    let chosen: EffectiveGrant | null = null;
    // Tier 1: the pool's elected default by precedence -- the LOWEST defaultRank
    // (the lowest-groupId group that marked the agent default; for the all-pool the
    // native default at rank 0). Lowest rank wins; ties fall to pool order.
    let bestRank = Infinity;
    for (const p of pool) {
      if (p.defaultRank === null || p.defaultRank >= bestRank) continue;
      const g = out.find(
        (x) => x.instanceName === p.instanceName && x.agentId === p.agentId,
      );
      if (g) {
        chosen = g;
        bestRank = p.defaultRank;
      }
    }
    // Tier 2: instance NATIVE default among the pool -- ONLY for a GROUP pool, where
    // defaultRank encodes `group.isDefault` (NOT `isDefaultOnInstance`), so this
    // point-read lookup adds a DISTINCT signal Tier 1 didn't cover. SKIPPED for the
    // all-pool: there defaultRank ALREADY == `isDefaultOnInstance` (set in
    // poolFromPresentAgents), so Tier 1 found any native default; a Tier-2 pass would
    // re-read the same field, find nothing new, and fall to Tier 3 anyway -- but at
    // the cost of N point reads that blow the 4,096-call cap for a default-less
    // catalogue. Skipping it is byte-identical AND removes that cliff. Group pools
    // are small (bounded), so the point reads there stay safe.
    if (chosen === null && inGroup) {
      for (const g of out) {
        const agent = await ctx.db
          .query("agents")
          .withIndex("by_instance_agent", (q) =>
            q.eq("instanceName", g.instanceName).eq("agentId", g.agentId),
          )
          .first();
        if (agent?.isDefaultOnInstance) {
          chosen = g;
          break;
        }
      }
    }
    // Tier 3: code default — the first pool entry in deterministic order.
    if (chosen === null) chosen = out[0];
    if (chosen) chosen.isDefault = true;
  }

  // OUTPUT enablement gate (all-pool reuses presentDocs as the cache → no extra
  // reads; the group pool point-reads its bounded set). A disabled agent's grant
  // is dropped here even though the pool built it (so the restricted-mode
  // decision could stay on raw sets).
  const gated = await filterEnabledGrants(ctx, out, strict, presentDocs);
  // Re-elect a default if the gate removed the chosen one (keep exactly-one).
  if (gated.length > 0 && !gated.some((g) => g.isDefault)) {
    gated[0]!.isDefault = true;
  }
  return { grants: gated, presentDocs };
}

/** The effective grant SET -- the wrapper used everywhere the pool DOCS aren't
 *  needed (routing, the chat-creation gate, agentFiles, the sorted header view).
 *  enrichUserAgents + the admin pool editor use the *WithPool variant so they can
 *  reuse the single all-pool collect for the display map instead of re-reading it. */
export async function getEffectiveGrants(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<EffectiveGrant[]> {
  return (await getEffectiveGrantsWithPool(ctx, userId)).grants;
}

/**
 * Effective agent SET per user, batched for the admin users list (the Agents
 * column). Mirrors getEffectiveGrants' cascade SET -- NOT its default election (the
 * column needs the set + a preview, not the elected default):
 *   in any group -> direct grants INSIDE the group pool, else the whole group pool
 *   no group     -> direct grants, else EVERY present discovered agent (all-pool)
 *
 * BOUNDED reads (NEVER a full-table collect): calling getEffectiveGrants per row
 * would re-run loadAllAgentsPool's all-pool scan for every groupless user (N times),
 * but the naive batch's mirror -- collecting the whole agents/userAgents/
 * groupMembers/groupAgents tables -- is just as unsafe: it ties this list query to
 * unbounded historical rows (deleted agents, grants/groups of NON-visible users) and
 * re-runs on any unrelated change to them (Codex P2). So instead:
 *   - the all-pool is read ONCE via by_source_present (present discovered only -- the
 *     SAME index loadAllAgentsPool uses; its rows also carry every present agent's
 *     displayName for the labels);
 *   - direct grants + memberships are read PER VISIBLE USER via by_user;
 *   - only the groups those users actually belong to are read (get + by_group).
 * Reads scale with what is DISPLAYED, not with deployment history.
 *
 * Label fallback: a granted agent that is absent from the all-pool (deleted/manual)
 * has no discovered displayName, so it renders by agentId (taken from the grant row)
 * -- present agents always resolve to their displayName. A discriminating test
 * cross-checks this helper's set against getEffectiveGrants directly.
 *
 * Returns count + a label-sorted, capped preview keyed by userId (string).
 */
export async function effectiveAgentsForUsers(
  ctx: QueryCtx | MutationCtx,
  userIds: Id<"users">[],
): Promise<Map<string, { count: number; preview: string[] }>> {
  const PREVIEW_CAP = 24;

  // 1. All-pool ONCE via the present-discovered index (NOT a full agents scan).
  //    These rows ARE every present discovered agent, so they also supply the
  //    displayName labels for the whole pool + any present granted agent.
  const allPoolRows = await ctx.db
    .query("agents")
    .withIndex("by_source_present", (q) =>
      q.eq("source", "discovered").eq("presentInLastOk", true),
    )
    .collect();
  const displayByKey = new Map<string, string>();
  const agentIdByKey = new Map<string, string>(); // label fallback for absent rows
  const allPoolKeys: string[] = [];
  // Opt-in enablement gate (must MIRROR getEffectiveGrantsWithPool — this batched
  // path is a duplicate; a divergence is the "no drift" test's failure). A grant
  // is included iff the agent is NOT a present-but-not-enabled one: the all-pool
  // carries only ENABLED present agents; a direct/group grant to a present agent
  // that is not enabled is dropped; an absent/deleted agent stays (resilient).
  const presentKeys = new Set<string>();
  const enabledKeys = new Set<string>();
  const disabledKeys = new Set<string>(); // present + explicitly enabled:false
  for (const a of allPoolRows) {
    const key = grantKey(a.instanceName, a.agentId);
    presentKeys.add(key);
    agentIdByKey.set(key, a.agentId);
    if (a.displayName) displayByKey.set(key, a.displayName);
    if (a.enabled === true) enabledKeys.add(key);
    if (a.enabled === false) disabledKeys.add(key);
    allPoolKeys.push(key); // RAW (all present) — the output gate narrows below.
  }
  // Present MANUAL agents (admin fallback) are NOT in the discovered pool above, so
  // the point-read path (agentUsable) treats them as OPT-OUT: usable unless
  // EXPLICITLY disabled. Mirror that here or the batched admin summary drifts from
  // routing — an explicitly-disabled manual grant would look effective (codex P3).
  const manualPresent = await ctx.db
    .query("agents")
    .withIndex("by_source_present", (q) =>
      q.eq("source", "manual").eq("presentInLastOk", true),
    )
    .collect();
  const manualDisabledKeys = new Set<string>();
  for (const a of manualPresent) {
    const key = grantKey(a.instanceName, a.agentId);
    if (a.displayName) displayByKey.set(key, a.displayName);
    agentIdByKey.set(key, a.agentId);
    if (a.enabled === false) manualDisabledKeys.add(key);
  }
  // Mirror filterEnabledGrants (opt-out during rollout, opt-in once the
  // backfill is done). A key not in presentKeys (absent/deleted) is kept.
  const strict = await agentEnablementStrict(ctx);
  const grantIncluded = (key: string): boolean => {
    if (manualDisabledKeys.has(key)) return false; // present manual, disabled
    if (!presentKeys.has(key)) return true; // absent/deleted/manual-not-disabled
    if (enabledKeys.has(key)) return true; // explicitly enabled
    // present + not explicitly enabled: unset is kept during rollout,
    // blocked under opt-in; explicit false is always blocked.
    return !strict && !disabledKeys.has(key);
  };

  // 2. Direct grants + memberships, BOUNDED to the visible users (by_user). Reads
  //    are independent, so run them in parallel; the Maps are only consumed after
  //    every read settles (no read-during-write).
  const directByUser = new Map<string, string[]>();
  const groupIdsByUser = new Map<string, Id<"groups">[]>();
  await Promise.all(
    userIds.map(async (userId) => {
      const direct = await ctx.db
        .query("userAgents")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      const keys: string[] = [];
      for (const ua of direct) {
        const key = grantKey(ua.instanceName, ua.agentId);
        agentIdByKey.set(key, ua.agentId);
        keys.push(key);
      }
      directByUser.set(userId as string, keys);
      const mems = await ctx.db
        .query("groupMembers")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      groupIdsByUser.set(
        userId as string,
        mems.map((m) => m.groupId),
      );
    }),
  );

  // 3. Only the DISTINCT groups those users belong to -> existence (dangling check)
  //    + their shared pool, read by_group (never the whole groupAgents table).
  const distinctGroups = new Map<string, Id<"groups">>();
  for (const gids of groupIdsByUser.values())
    for (const g of gids) distinctGroups.set(g as string, g);
  const existingGroupIds = new Set<string>();
  const agentsByGroup = new Map<string, string[]>();
  await Promise.all(
    [...distinctGroups.values()].map(async (groupId) => {
      const group = await ctx.db.get(groupId);
      if (group === null) return; // dangling membership -> group not existing
      existingGroupIds.add(groupId as string);
      const shared = await ctx.db
        .query("groupAgents")
        .withIndex("by_group", (q) => q.eq("groupId", groupId))
        .collect();
      const keys: string[] = [];
      for (const ga of shared) {
        const key = grantKey(ga.instanceName, ga.agentId);
        agentIdByKey.set(key, ga.agentId);
        keys.push(key);
      }
      agentsByGroup.set(groupId as string, keys);
    }),
  );

  const labelOf = (key: string): string =>
    displayByKey.get(key) ?? agentIdByKey.get(key) ?? key;

  // 4. Per-user cascade SET (in-memory).
  const out = new Map<string, { count: number; preview: string[] }>();
  for (const userId of userIds) {
    const uid = userId as string;
    const direct = directByUser.get(uid) ?? [];
    // EXISTING-group memberships only: a dangling membership (deleted group) never
    // flips the user in-group with an empty pool -- mirrors resolveGroupPool.
    const memberGroups = (groupIdsByUser.get(uid) ?? []).filter((g) =>
      existingGroupIds.has(g as string),
    );

    let effective: string[];
    if (memberGroups.length > 0) {
      // RAW group pool for the restriction decision (never gated here) —
      // mirrors getEffectiveGrantsWithPool, so a direct grant to a now-disabled
      // group agent does NOT widen the user to the whole pool.
      const poolSet = new Set<string>();
      for (const g of memberGroups)
        for (const k of agentsByGroup.get(g as string) ?? []) poolSet.add(k);
      const restricted = direct.filter((k) => poolSet.has(k));
      effective = restricted.length > 0 ? restricted : [...poolSet];
    } else {
      effective = direct.length > 0 ? direct : allPoolKeys;
    }
    // OUTPUT enablement gate (opt-in) — applied AFTER the mode decision.
    const uniq = [...new Set(effective)].filter(grantIncluded);
    const labels = uniq.map(labelOf).sort((a, b) => a.localeCompare(b));
    out.set(uid, { count: uniq.length, preview: labels.slice(0, PREVIEW_CAP) });
  }
  return out;
}

/**
 * Resolve a DOCUMENTARY agent the user is ENTITLED to (L2 "Joindre les documents").
 * Intersects the user's effective grants (the dispatch-time authorization boundary —
 * NEVER a global agent) with the agents whose effective type includes "documentary",
 * skipping ones deleted on the gateway. Returns the user's DEFAULT documentary agent
 * when it is documentary, else the first documentary grant; null if none. PURE-ish
 * (ctx reads only); reused by the availability query AND the L2 dispatch so they can
 * never disagree on the target.
 */
export async function resolveDocumentaryTarget(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<{ instanceName: string; agentId: string; displayName: string } | null> {
  // getEffectiveGrants MARKS isDefault but does NOT reorder its output (the array is
  // direct-then-group insertion order). Sort a LOCAL copy default-first so the user's
  // default documentary agent wins when it is documentary; non-defaults keep their
  // relative order, so a non-documentary default falls through to the first
  // documentary grant. Do NOT reorder getEffectiveGrants itself (shared by the header
  // chip + sidebar badge + dispatch — a semantics change across three consumers).
  const grants = [...(await getEffectiveGrants(ctx, userId))].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault),
  );
  for (const g of grants) {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", g.instanceName).eq("agentId", g.agentId),
      )
      .first();
    if (agent === null || agent.presentInLastOk === false) continue; // unknown/deleted
    if (resolveAgentTypes(agent.types).includes("documentary")) {
      return {
        instanceName: g.instanceName,
        agentId: g.agentId,
        displayName: agent.displayName ?? g.agentId,
      };
    }
  }
  return null;
}

/**
 * Resolve the user's DEDICATED SUMMARIZER agent on a REQUIRED instance (hybrid
 * rehydration): the admin marks an agent `type:"summarizer"` to own the
 * conversation-summary jobs; default-first among the user's grants, exactly like
 * resolveDocumentaryTarget. The instance is REQUIRED equal to the summarized
 * chat's instance — conversation content never leaves its gateway. Null = no
 * dedicated agent granted there (the engine falls back to the chat's own agent).
 */
/**
 * The agent that will curate an over-budget agent file: the first GRANTED,
 * present agent typed "curator" on the REQUIRED instance (the file lives on that
 * gateway — content never crosses instances). null -> no curator available (the
 * feature stays off; there is no unsafe fallback for a lossy rewrite).
 */
export async function resolveCuratorTarget(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  requiredInstance: string,
): Promise<{ instanceName: string; agentId: string } | null> {
  const grants = [...(await getEffectiveGrants(ctx, userId))].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault),
  );
  for (const g of grants) {
    if (g.instanceName !== requiredInstance) continue;
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", g.instanceName).eq("agentId", g.agentId),
      )
      .first();
    if (agent === null || agent.presentInLastOk === false) continue;
    if (resolveAgentTypes(agent.types).includes("curator")) {
      return { instanceName: g.instanceName, agentId: g.agentId };
    }
  }
  return null;
}

/**
 * The instance-DESIGNATED converter agent for `instanceName`, or null. Unlike the
 * curator/documentary/summarizer resolvers (which pick a TYPED agent from the
 * REQUESTING USER's grants), conversion is an INSTANCE-LEVEL service: the admin
 * names one agentId in the instance config (`converterAgentId`), and it serves
 * every user of that instance regardless of their personal pool. The designation
 * IS the authorization — this does NOT require the agent to be in the caller's
 * grants NOR enabled (the admin explicitly chose it). It still verifies the agent
 * is a KNOWN, PRESENT agent of the instance, so a deleted/renamed designee falls
 * back to null (→ the viewer's download fallback) instead of dispatching to a
 * ghost. Content never crosses instances: the file's own instance converts it.
 */
export async function resolveConverterTarget(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
): Promise<{ instanceName: string; agentId: string } | null> {
  const instance = await ctx.db
    .query("instances")
    .withIndex("by_name", (q) => q.eq("name", instanceName))
    .first();
  const agentId = instance?.config?.converterAgentId;
  if (!agentId) return null; // conversion not configured for this instance
  const agent = await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
  if (agent === null || agent.presentInLastOk === false) return null; // gone
  return { instanceName, agentId };
}

export async function resolveSummarizerTarget(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  requiredInstance: string,
): Promise<{ instanceName: string; agentId: string } | null> {
  const grants = [...(await getEffectiveGrants(ctx, userId))].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault),
  );
  for (const g of grants) {
    if (g.instanceName !== requiredInstance) continue;
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", g.instanceName).eq("agentId", g.agentId),
      )
      .first();
    if (agent === null || agent.presentInLastOk === false) continue;
    if (resolveAgentTypes(agent.types).includes("summarizer")) {
      return { instanceName: g.instanceName, agentId: g.agentId };
    }
  }
  return null;
}

/**
 * Is a documentary agent available to the caller? Drives the "Joindre les documents"
 * action's enablement (the capability gate — like the bridge-capability pattern).
 * Returns the agent's non-secret display label, or null.
 */
export const documentaryAvailable = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    const target = await resolveDocumentaryTarget(ctx, userId);
    return target ? { displayName: target.displayName } : null;
  },
});

/** SINGLE resolver for "which agent does this chat route to" — used by BOTH the
 *  header chip (getChatAgent) AND the sidebar bridge badge (messages.listChats),
 *  so they can never drift from each other or from dispatch. Mirrors dispatch's
 *  resolveTargetForChat EXACTLY: honor the chat's binding unless that agent is
 *  DELETED, else fall back to the default (skipping a deleted default) → first
 *  non-deleted assignment. `null` only when every assigned agent is deleted.
 *  Pure (operates on already-enriched agents); batch `enrichUserAgents` ONCE and
 *  map many chats through this — never call it per-chat with its own reads. */
export function resolveAgentForChat(
  agents: EnrichedUserAgent[],
  // A MULTI-AGENT (`perTurnRouting`) chat is NOT locked by its creation-time PRIMARY being
  // revoked — the user routes each turn to a CHOSEN agent and dispatch (resolveTargetForTurn)
  // ignores the chat binding, so a primary restriction must not read-only the whole chat.
  chat: { instanceName?: string; agentId?: string; perTurnRouting?: boolean },
  // Whether the chat's bound agent still EXISTS as a discovered agent. Mirrors the
  // dispatch (resolveTargetForChat): a bound agent NOT in the effective set is
  // READ-ONLY only when it still exists (a RESTRICTION); when it is GONE (purged by
  // removeInstanceAgent) the chat falls back/rebinds like any deleted agent.
  boundAgentExists: boolean,
): { agent: EnrichedUserAgent | null; readOnly: boolean } {
  if (chat.instanceName && chat.agentId) {
    const inSet = agents.find(
      (a) =>
        a.instanceName === chat.instanceName && a.agentId === chat.agentId,
    );
    if (inSet) {
      // In the user's effective set: honor the binding unless the agent was
      // DELETED on the gateway (then fall through to the default below).
      if (inSet.state !== "deleted") return { agent: inSet, readOnly: false };
    } else if (boundAgentExists && !chat.perTurnRouting) {
      // SINGLE-AGENT chat bound to an agent the user is NO LONGER entitled to but that still
      // EXISTS (an admin narrowed their set): READ-ONLY — never silently re-route to a
      // DIFFERENT agent (the dispatch enforces `agent_restricted`). A PURGED agent (no row)
      // falls through to the fallback below. A PER-TURN chat is explicitly NOT locked here —
      // it routes per-turn to its other usable agents (dispatch would succeed).
      return { agent: null, readOnly: true };
    }
  }
  const fallback =
    [...agents]
      .sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1))
      .find((a) => a.state !== "deleted") ?? null;
  // A PER-TURN chat with a binding but NO usable agent LEFT is read-only (a clean proactive
  // lock — preserving the all-revoked lock the restriction branch no longer provides for it).
  // Single-agent chats are unaffected (perTurnRouting falsy → readOnly false, original).
  const readOnly =
    chat.perTurnRouting === true &&
    Boolean(chat.instanceName && chat.agentId) &&
    fallback === null;
  return { agent: fallback, readOnly };
}

// Pre-loaded per-instance metadata (instances + discovery). The tables are tiny
// (one row per instance), so loading them ONCE and looking up in-memory keeps
// agentDisplay at a single indexed read per agent — bounding the cost when a
// caller enriches MANY agents (the groupless all-pool) on the listChats /
// getChatAgent hot paths, instead of 2 reads PER agent.
type AgentContext = {
  instanceByName: Map<string, Doc<"instances">>;
  discoveryByInstance: Map<string, Doc<"instanceDiscovery">>;
  // Present DISCOVERED agents keyed by grantKey, loaded in ONE collect so
  // agentDisplay resolves them WITHOUT a per-grant `by_instance_agent` point read.
  // This is the load-bearing fix for the prod "too many system operations" timeout
  // on listMyAgents/listChats/getChatAgent: a groupless user's effective set is the
  // whole all-pool (N agents), and enriching it was N sequential point reads on a
  // saturated backend. A grant NOT present here (a deleted/manual/absent agent --
  // few) still falls back to the exact same point read in agentDisplay.
  agentByKey: Map<string, Doc<"agents">>;
};

async function loadAgentContext(
  ctx: QueryCtx | MutationCtx,
  // Preload the present-agent pool into agentByKey. ONLY worth it when the caller
  // will enrich MANY agents (a groupless user's all-pool) -- there, one collect
  // beats N point reads. For a FEW grants (a restricted/group user, the raw-grants
  // editor) it would collect the WHOLE pool to serve a handful, RE-introducing the
  // unbounded read this fix removes (Codex P2) -- so those callers pass false and
  // agentDisplay point-reads each (bounded by the small grant count).
  preloadPresentAgents = false,
  // OPTIONAL: the present-agent docs the caller ALREADY collected for the all-pool
  // (getEffectiveGrantsWithPool / getAgentPool). Passing them is the dedupe -- the
  // display map is built from that SAME read instead of a second by_source_present
  // collect. Same docs, same index order, so the keep-FIRST map is identical.
  presentDocs?: Doc<"agents">[],
): Promise<AgentContext> {
  const instances = await ctx.db.query("instances").collect();
  const discovery = await ctx.db.query("instanceDiscovery").collect();
  // Keep the FIRST row per name (NOT `new Map(map(...))`, which keeps the LAST):
  // duplicate instance/discovery names are a live-caught case the rest of the code
  // tolerates via indexed `.first()`, so agentDisplay must resolve the SAME row as
  // routing (else e.g. a Hermes badge while dispatch routes the first OpenClaw row).
  const instanceByName = new Map<string, Doc<"instances">>();
  for (const i of instances) {
    if (!instanceByName.has(i.name)) instanceByName.set(i.name, i);
  }
  const discoveryByInstance = new Map<string, Doc<"instanceDiscovery">>();
  for (const d of discovery) {
    if (!discoveryByInstance.has(d.instanceName)) {
      discoveryByInstance.set(d.instanceName, d);
    }
  }
  // Present discovered agents in ONE indexed collect (by_source_present is ordered
  // _creationTime-ascending within (discovered,true), so keep-FIRST on a duplicate
  // key mirrors `by_instance_agent .first()` exactly -- same row agentDisplay's point
  // read would pick). applyDiscovery keeps one row per (instance,agentId), so a
  // collision is the rare defensively-tolerated duplicate. Skipped unless the caller
  // enriches the all-pool (else a few-grant caller would over-read the whole pool).
  const agentByKey = new Map<string, Doc<"agents">>();
  if (preloadPresentAgents) {
    const presentAgents = presentDocs ?? (await collectPresentAgents(ctx));
    for (const a of presentAgents) {
      const key = grantKey(a.instanceName, a.agentId);
      if (!agentByKey.has(key)) agentByKey.set(key, a);
    }
  }
  return { instanceByName, discoveryByInstance, agentByKey };
}

/** Shared display + resolution-state for one agent ref. State priority (mirrors
 *  routing.isDeleted -- Codex P2): a KNOWN deletion (agent.presentInLastOk ===
 *  false, set ONLY by a successful poll, never erased by a failed one) wins over
 *  "stale"; never polled => unknown; last poll failed => stale; successful poll
 *  with no row => deleted; else ok. Reused by the effective list (enrichUserAgents),
 *  the per-user editor (raw direct grants), and the pool query so they can never
 *  drift on what "deleted/stale" means. `cx` (loadAgentContext) batches the small
 *  instance + discovery tables so this is ONE indexed read per agent. */
async function agentDisplay(
  ctx: QueryCtx | MutationCtx,
  instanceName: string,
  agentId: string,
  cx: AgentContext,
): Promise<{
  displayName: string | null;
  emoji: string | null;
  model: string | null;
  description: string | null;
  kind: "openclaw" | "hermes";
  enabled: boolean;
  state: EnrichedUserAgent["state"];
}> {
  // Present discovered agents are pre-loaded in cx.agentByKey (ONE collect for the
  // whole enrichment, not a point read per grant). Only a non-present grant
  // (deleted/manual/absent -- few) reaches the indexed fallback, whose `.first()`
  // semantics cx.agentByKey already mirrors for the present case.
  const agent =
    cx.agentByKey.get(grantKey(instanceName, agentId)) ??
    (await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", instanceName).eq("agentId", agentId),
      )
      .first());
  const instance = cx.instanceByName.get(instanceName) ?? null;
  const discovery = cx.discoveryByInstance.get(instanceName) ?? null;
  let state: EnrichedUserAgent["state"] = "ok";
  if (agent && agent.presentInLastOk === false) state = "deleted";
  else if (!discovery) state = "unknown";
  else if (!discovery.lastPollOk) state = "stale";
  else if (!agent) state = "deleted";
  return {
    displayName: agent?.displayName ?? null,
    emoji: agent?.emoji ?? null,
    model: agent?.model ?? null,
    description: agent?.description ?? null,
    kind: instance?.kind ?? "openclaw",
    // Admin enablement state — the user-access editor greys a non-enabled
    // agent (the assign mutation rejects it; opt-in gate).
    enabled: agent?.enabled === true,
    state,
  };
}

export async function enrichUserAgents(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<EnrichedUserAgent[]> {
  // Consume the shared union (P2): with NO groups this is the user's direct rows
  // in by_user order with the same isDefault, so the loop below — and therefore
  // the whole output (agents, default, states) — is identical to pre-P2.
  // WithPool returns the all-pool docs it collected (non-null IFF the all-pool was
  // taken — the only set big enough to need the batched preload), so the display map
  // reuses that SAME read instead of a second by_source_present collect.
  const { grants, presentDocs } = await getEffectiveGrantsWithPool(ctx, userId);
  const cx = await loadAgentContext(
    ctx,
    presentDocs !== null,
    presentDocs ?? undefined,
  );
  const out: EnrichedUserAgent[] = [];
  for (const r of grants) {
    // UTILITY-ONLY grants (summarizer/documentary without "conversational") are
    // consumed by dedicated Atrium actions, never by the user's chat surfaces —
    // hide them from the picker/chip/multiAgent count (and routing refuses them).
    // Resolve the row via the SAME cache agentDisplay uses (a Map hit on the
    // all-pool path — no per-grant point read on the hot list; the indexed
    // fallback only serves the few non-present grants, like agentDisplay's).
    const typeRow =
      cx.agentByKey.get(grantKey(r.instanceName, r.agentId)) ??
      (await ctx.db
        .query("agents")
        .withIndex("by_instance_agent", (q) =>
          q.eq("instanceName", r.instanceName).eq("agentId", r.agentId),
        )
        .first());
    if (
      typeRow != null &&
      !resolveAgentTypes(typeRow.types).includes("conversational")
    ) {
      continue;
    }
    const d = await agentDisplay(ctx, r.instanceName, r.agentId, cx);
    out.push({
      instanceName: r.instanceName,
      agentId: r.agentId,
      isDefault: r.isDefault,
      // A group-only grant has no userAgents.source; surface it as "auto" (it is
      // not a manual per-user assignment). Direct grants keep their own source.
      source: r.source ?? "auto",
      ...d,
      via: r.via,
    });
  }
  return out;
}

/** The EFFECTIVE user's agents (impersonation-aware — red-team M3). Feeds the
 *  new-chat picker + the chat-creation gate. */
export const listMyAgents = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    return enrichUserAgents(ctx, userId);
  },
});

/** The agent a chat is (or will be) routed to + whether the user has a CHOICE.
 *  Powers the chat-header agent chip, which the frontend shows ONLY when
 *  `multiAgent` (the user's explicit requirement: surface "which agent" only
 *  when more than one is associated — a single-agent user never sees clutter).
 *
 *  `agent` mirrors dispatch's resolveTargetForChat default fallback: the chat's
 *  bound agent when set AND still in the user's list, else the user's default —
 *  so the chip names the agent the NEXT turn actually dispatches to (a legacy/
 *  unbound chat shows the default, not "none"). Owner-scoped; impersonation-aware
 *  (effective user, like listMyAgents); tolerant of a malformed/deleted chatId
 *  (returns null, never throws — same contract as messages.getSessionMeta). */
export const getChatAgent = query({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return null;
    const chat = await ctx.db.get(id);
    if (chat === null) return null;
    if (chat.userId !== userId) {
      throw new Error("Forbidden: chat not owned by user");
    }

    const agents = await enrichUserAgents(ctx, userId);
    // Is the chat's bound agent still PRESENT? (Mirrors the dispatch: a not-in-set
    // binding is read-only only when the agent is present -- a restriction -- vs
    // gone, i.e. purged OR gateway-deleted (presentInLastOk:false), which falls
    // back.)
    const boundRow =
      chat.instanceName && chat.agentId
        ? await ctx.db
            .query("agents")
            .withIndex("by_instance_agent", (q) =>
              q
                .eq("instanceName", chat.instanceName!)
                .eq("agentId", chat.agentId!),
            )
            .first()
        : null;
    const boundAgentExists =
      boundRow !== null && boundRow.presentInLastOk !== false;
    // The agent the NEXT turn dispatches to + whether the chat is READ-ONLY (bound
    // to an agent the user is no longer entitled to). Computed independently of the
    // chip so even a single-agent user gets the read-only lock + reason.
    const { agent: resolved, readOnly } = resolveAgentForChat(
      agents,
      chat,
      boundAgentExists,
    );
    // The chip exists ONLY to disambiguate between several agents. With 0 or 1
    // agent there is nothing to disambiguate -> never surface the chip; readOnly
    // still rides along so the chat view can lock the composer.
    if (agents.length <= 1) {
      return {
        multiAgent: false as const,
        multiInstance: false as const,
        readOnly,
        // The resolved agent rides along even mono-agent (additive): the header
        // chip still gates on multiAgent, but the Session panel's AGENT section
        // names the agent + its gateway instance for EVERY user. Same projected
        // shape as the multi-agent branch (one union member for consumers).
        agent: resolved
          ? {
              instanceName: resolved.instanceName,
              agentId: resolved.agentId,
              displayName: resolved.displayName,
              emoji: resolved.emoji,
              state: resolved.state,
              isDefault: resolved.isDefault,
              inheritedDefault: !(
                chat.instanceName === resolved.instanceName &&
                chat.agentId === resolved.agentId
              ),
            }
          : null,
      };
    }

    // Does the user's entitled set span MORE THAN ONE instance? When it does, the
    // agent name alone can be ambiguous (the same display name can exist on two
    // gateways), so the header also shows which instance the bound agent lives on.
    const multiInstance =
      new Set(agents.map((a) => a.instanceName)).size > 1;

    // `resolved` + `readOnly` computed above (shared with the early single-agent
    // return). Inherited when the resolved agent is NOT the chat's own (live)
    // binding — a
    // legacy/unbound chat, or a chat whose binding was deleted and re-bound.
    const inheritedDefault = !(
      resolved &&
      chat.instanceName === resolved.instanceName &&
      chat.agentId === resolved.agentId
    );
    return {
      multiAgent: true as const,
      multiInstance,
      // READ-ONLY: the chat is bound to an agent the user is no longer entitled to
      // (admin narrowed their set). The chat view disables the composer + shows a
      // reason; the dispatch enforces it as `agent_restricted`.
      readOnly,
      agent: resolved
        ? {
            instanceName: resolved.instanceName,
            agentId: resolved.agentId,
            displayName: resolved.displayName,
            emoji: resolved.emoji,
            state: resolved.state,
            isDefault: resolved.isDefault,
            inheritedDefault,
          }
        : null,
    };
  },
});

/** Admin: one user's agents (the Users Access editor). */
export const listUserAgents = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    await requireAdmin(ctx);
    const profile = await ctx.db.get(profileId);
    if (profile === null) throw new Error("Not found: profile");
    // RAW direct grants (via "user"). This editor MUTATES the userAgents table
    // (assign/remove/setDefaultAgent all key on a direct row), so it must show
    // exactly the rows those mutations act on -- read STRAIGHT from userAgents, NOT
    // via the effective cascade (which may narrow a direct grant OUT of the
    // effective set for an in-group user; the admin must still be able to manage
    // it). Each keeps its own isDefault (the star). Enriched for display.
    const direct = await ctx.db
      .query("userAgents")
      .withIndex("by_user", (q) => q.eq("userId", profile.userId))
      .collect();
    const cx = await loadAgentContext(ctx);
    const out: EnrichedUserAgent[] = [];
    for (const r of direct) {
      const d = await agentDisplay(ctx, r.instanceName, r.agentId, cx);
      out.push({
        instanceName: r.instanceName,
        agentId: r.agentId,
        isDefault: r.isDefault,
        source: r.source ?? "auto",
        ...d,
        via: "user",
      });
    }
    return out;
  },
});

/** Admin: the POOL a user may be restricted WITHIN (the Users Access editor offers
 *  exactly this, so an out-of-pool pick can't silently no-op). `inGroup` lets the
 *  UI say WHAT the pool is: the user's groups' shared agents, or — for a groupless
 *  user — every discovered agent. Display fields + `state` mirror enrichUserAgents
 *  so the dialog renders the same way as the effective list. */
export const listAgentPoolForUser = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    await requireAdmin(ctx);
    const profile = await ctx.db.get(profileId);
    if (profile === null) throw new Error("Not found: profile");
    const { inGroup, pool, presentDocs } = await getAgentPool(ctx, profile.userId);
    // A groupless user's pool IS the all-pool (many) -> batch, reusing the SAME docs
    // getAgentPool already collected (no second by_source_present read); a group pool
    // is curated (few) -> point-read.
    const cx = await loadAgentContext(ctx, !inGroup, presentDocs ?? undefined);
    const agents = [];
    for (const p of pool) {
      const d = await agentDisplay(ctx, p.instanceName, p.agentId, cx);
      agents.push({ instanceName: p.instanceName, agentId: p.agentId, ...d });
    }
    return { inGroup, agents };
  },
});

// ===========================================================================
// WRITE — userAgents (admin). Invariants: assign only DISCOVERED+present agents;
// exactly one default whenever >=1 row (by_user RANGE READ — red-team H3); remove
// re-elects a default (red-team H2).
// ===========================================================================

async function userIdOfProfile(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
): Promise<Id<"users">> {
  const profile = await ctx.db.get(profileId);
  if (profile === null) throw new Error("Not found: profile");
  return profile.userId;
}

async function agentRow(
  ctx: MutationCtx,
  instanceName: string,
  agentId: string,
): Promise<Doc<"agents"> | null> {
  return await ctx.db
    .query("agents")
    .withIndex("by_instance_agent", (q) =>
      q.eq("instanceName", instanceName).eq("agentId", agentId),
    )
    .first();
}

/** Admin: grant a user access to a DISCOVERED agent. First agent becomes default. */
export const assignAgent = mutation({
  args: {
    profileId: v.id("profiles"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { profileId, instanceName, agentId }) => {
    await requireAdmin(ctx);
    // Only DISCOVERED + currently-present agents are assignable. This is what
    // makes "Agent X no longer exists" structurally impossible for the admin
    // (red-team M1: manual/unverified is a separate, later path).
    const agent = await agentRow(ctx, instanceName, agentId);
    const strict = await agentEnablementStrict(ctx);
    if (
      agent === null ||
      agent.source !== "discovered" ||
      !agent.presentInLastOk ||
      (strict ? agent.enabled !== true : agent.enabled === false)
    ) {
      throw new Error(
        `Agent not assignable: ${instanceName}/${agentId} is not a discovered, present, enabled agent`,
      );
    }
    const userId = await userIdOfProfile(ctx, profileId);
    // RANGE READ over by_user (H3) — also serves as the dedupe + first-agent check.
    const existing = await ctx.db
      .query("userAgents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    if (existing.some((r) => r.instanceName === instanceName && r.agentId === agentId)) {
      return; // idempotent — already assigned
    }
    const isFirst = existing.length === 0;
    await ctx.db.insert("userAgents", {
      userId,
      instanceName,
      agentId,
      isDefault: isFirst, // first agent is the default; else admin sets it
      source: "manual",
      createdAt: Date.now(),
    });
  },
});

/** Admin: revoke an agent. If it was the default and others remain, RE-ELECT
 *  one (red-team H2 — never leave a user with agents but no default). */
export const removeAgent = mutation({
  args: {
    profileId: v.id("profiles"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { profileId, instanceName, agentId }) => {
    await requireAdmin(ctx);
    const userId = await userIdOfProfile(ctx, profileId);
    const rows = await ctx.db
      .query("userAgents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const target = rows.find(
      (r) => r.instanceName === instanceName && r.agentId === agentId,
    );
    if (!target) return; // idempotent
    await ctx.db.delete(target._id);
    if (target.isDefault) {
      const remaining = rows.filter((r) => r._id !== target._id);
      if (remaining.length > 0) {
        await ctx.db.patch(remaining[0]._id, { isDefault: true });
      }
    }
  },
});

/** Admin: set a user's default agent. Clears the previous default in the SAME
 *  mutation (range read over by_user — H3: OCC serializes concurrent writes). */
export const setDefaultAgent = mutation({
  args: {
    profileId: v.id("profiles"),
    instanceName: v.string(),
    agentId: v.string(),
  },
  handler: async (ctx, { profileId, instanceName, agentId }) => {
    await requireAdmin(ctx);
    const userId = await userIdOfProfile(ctx, profileId);
    const rows = await ctx.db
      .query("userAgents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const target = rows.find(
      (r) => r.instanceName === instanceName && r.agentId === agentId,
    );
    if (!target) throw new Error("Not found: userAgent (assign it first)");
    // Defense in depth (the UI already greys the star): a present-but-disabled
    // agent must never be promoted to default — it is not routable, so a filled
    // star on it is a dead end. A stale client or a direct admin API call is
    // rejected here, mirroring assignAgent's own gate. An absent/deleted agent is
    // left alone (agentUsable is opt-out for those — resilient display).
    const agent = await agentRow(ctx, instanceName, agentId);
    if (!agentUsable(agent, await agentEnablementStrict(ctx))) {
      throw new Error(
        `Agent not default-able: ${instanceName}/${agentId} is disabled`,
      );
    }
    for (const r of rows) {
      const shouldBeDefault = r._id === target._id;
      if (r.isDefault !== shouldBeDefault) {
        await ctx.db.patch(r._id, { isDefault: shouldBeDefault });
      }
    }
  },
});
