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
        await ctx.db.insert("agents", {
          instanceName,
          agentId: a.agentId,
          firstSeenAt: now,
          lastSeenAt: now,
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

// Provenance of an agent in the effective (unioned) set: a DIRECT userAgents
// grant ("user"), or shared via a group the user belongs to ({ group: <key> }).
// Direct WINS on dedup, so a direct grant always reports "user". Foundation for
// the P5 "who has what" introspection screen (spec §6).
export type AgentVia = "user" | { group: string };

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
  kind: "openclaw" | "hermes";
  // Resolution health for the UI (red-team B2): deleted vs stale vs ok.
  state: "ok" | "deleted" | "stale" | "unknown";
  // Provenance for introspection (P2 §6): direct grant vs which group shares it.
  via: AgentVia;
};

const grantKey = (instanceName: string, agentId: string): string =>
  `${instanceName.length}:${instanceName}/${agentId}`;

/** THE union resolver (P2 §4). Computes the effective set of agents a user may
 *  use — direct `userAgents` ∪ agents shared by the user's groups — deduped by
 *  (instanceName, agentId) with DIRECT membership winning, and assigns ONE
 *  effective default by precedence:
 *    direct userAgents.isDefault > group default (lowest groupId, then agentId)
 *    > instance native default (isDefaultOnInstance) > code (first deterministic).
 *  The "exactly one isDefault per user" invariant stays on DIRECT userAgents
 *  (the mutations enforce it); group agents are never materialized. With NO
 *  groups the output is the user's direct rows in by_user order with `via:"user"`
 *  and `isDefault` === the row's own — i.e. byte-identical to the pre-P2 set the
 *  callers consume. Deletion is IGNORED here (resolve-time skips deleted). */
export async function getEffectiveGrants(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<EffectiveGrant[]> {
  const direct = await ctx.db
    .query("userAgents")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  // Direct grants first (they WIN on dedup). Preserve by_user order and each
  // row's own isDefault so the no-group path is identical to pre-P2.
  const out: EffectiveGrant[] = direct.map((r) => ({
    instanceName: r.instanceName,
    agentId: r.agentId,
    isDefault: r.isDefault,
    source: r.source,
    via: "user" as const,
  }));
  const seen = new Set(out.map((g) => grantKey(g.instanceName, g.agentId)));

  // Group agents: read the user's memberships, then each group's shared agents.
  const memberships = await ctx.db
    .query("groupMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  // Deterministic group order (by groupId) so the group-default tiebreak is
  // stable across calls (spec: lowest groupId, then agentId).
  const groupIds = memberships
    .map((m) => m.groupId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Per-group shared rows (sorted by agentId), cached so the default election
  // below reuses them instead of re-reading. Ordered by groupId asc to match the
  // deterministic "lowest groupId, then agentId" tiebreak.
  const sharedByGroup: Array<{ groupId: Id<"groups">; rows: Doc<"groupAgents">[] }> = [];
  for (const groupId of groupIds) {
    const group = await ctx.db.get(groupId);
    if (group === null) continue; // tolerate a dangling membership
    const shared = await ctx.db
      .query("groupAgents")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();
    // Within a group, order by agentId for a stable group-default tiebreak.
    shared.sort((a, b) =>
      a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0,
    );
    sharedByGroup.push({ groupId, rows: shared });
    for (const ga of shared) {
      const key = grantKey(ga.instanceName, ga.agentId);
      if (seen.has(key)) continue; // direct (or an earlier group) already covers it
      seen.add(key);
      out.push({
        instanceName: ga.instanceName,
        agentId: ga.agentId,
        // Group `isDefault` is provisional here; the effective default is
        // re-derived below across the WHOLE set so precedence holds.
        isDefault: false,
        source: null,
        via: { group: group.key },
      });
    }
  }

  // Effective default. Direct default wins and is ALREADY set verbatim above
  // (and the invariant guarantees at most one direct default). Only when there
  // is NO direct default do we elect ONE default among the GROUP-ONLY candidates
  // by precedence (a direct-covered agent keeps `via:"user"` and is never the
  // group/native default — direct provenance with no direct default means the
  // user simply has no default among direct agents).
  const hasDirectDefault = out.some((g) => g.via === "user" && g.isDefault);
  if (!hasDirectDefault) {
    const groupCandidates = out.filter((g) => g.via !== "user");
    if (groupCandidates.length > 0) {
      let chosen: EffectiveGrant | null = null;
      // Tier 1: the first group (lowest groupId) that marked one of its shared
      // agents as its default AND that agent is a group-only candidate here.
      for (const { rows } of sharedByGroup) {
        const def = rows.find((ga) => ga.isDefault === true);
        if (!def) continue;
        const cand = groupCandidates.find(
          (g) =>
            g.instanceName === def.instanceName && g.agentId === def.agentId,
        );
        if (cand) {
          chosen = cand;
          break;
        }
      }
      // Tier 2: instance native default (isDefaultOnInstance) among candidates.
      if (chosen === null) {
        for (const g of groupCandidates) {
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
      // Tier 3: code default — the first candidate in deterministic order.
      if (chosen === null) chosen = groupCandidates[0];
      if (chosen) chosen.isDefault = true;
    }
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
  chat: { instanceName?: string; agentId?: string },
): EnrichedUserAgent | null {
  const bound =
    chat.instanceName && chat.agentId
      ? agents.find(
          (a) =>
            a.instanceName === chat.instanceName &&
            a.agentId === chat.agentId &&
            a.state !== "deleted",
        )
      : undefined;
  const fallback =
    [...agents]
      .sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1))
      .find((a) => a.state !== "deleted") ?? null;
  return bound ?? fallback;
}

export async function enrichUserAgents(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<EnrichedUserAgent[]> {
  // Consume the shared union (P2): with NO groups this is the user's direct rows
  // in by_user order with the same isDefault, so the loop below — and therefore
  // the whole output (agents, default, states) — is identical to pre-P2.
  const grants = await getEffectiveGrants(ctx, userId);
  const out: EnrichedUserAgent[] = [];
  for (const r of grants) {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", r.instanceName).eq("agentId", r.agentId),
      )
      .first();
    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", r.instanceName))
      .first();
    const discovery = await ctx.db
      .query("instanceDiscovery")
      .withIndex("by_instance", (q) => q.eq("instanceName", r.instanceName))
      .first();
    // state priority (mirrors routing.isDeleted — Codex P2): a KNOWN deletion
    // (agent.presentInLastOk === false, set ONLY by a successful poll and never
    // erased by a failed one) wins over "stale", so a discovery blip can NOT
    // re-offer a known-deleted agent in the picker / single-agent auto-bind.
    // Then: never polled => unknown; last poll failed (but not known-deleted) =>
    // stale; successful poll with no row => deleted; else present => ok.
    let state: EnrichedUserAgent["state"] = "ok";
    if (agent && agent.presentInLastOk === false) state = "deleted";
    else if (!discovery) state = "unknown";
    else if (!discovery.lastPollOk) state = "stale";
    else if (!agent) state = "deleted";
    out.push({
      instanceName: r.instanceName,
      agentId: r.agentId,
      isDefault: r.isDefault,
      // A group-only grant has no userAgents.source; surface it as "auto" (it is
      // not a manual per-user assignment). Direct grants keep their own source.
      source: r.source ?? "auto",
      displayName: agent?.displayName ?? null,
      emoji: agent?.emoji ?? null,
      model: agent?.model ?? null,
      kind: instance?.kind ?? "openclaw",
      state,
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
    // The chip exists ONLY to disambiguate between several agents. With 0 or 1
    // agent there is nothing to disambiguate -> never surface it.
    if (agents.length <= 1) {
      return { multiAgent: false as const, multiInstance: false as const, agent: null };
    }

    // Does the user's entitled set span MORE THAN ONE instance? When it does, the
    // agent name alone can be ambiguous (the same display name can exist on two
    // gateways), so the header also shows which instance the bound agent lives on.
    const multiInstance =
      new Set(agents.map((a) => a.instanceName)).size > 1;

    // The agent the NEXT turn will actually dispatch to (shared with the sidebar
    // badge — see resolveAgentForChat: honors a non-deleted binding, else the
    // default, skipping any deleted agent).
    const resolved = resolveAgentForChat(agents, chat);
    // Inherited when the resolved agent is NOT the chat's own (live) binding — a
    // legacy/unbound chat, or a chat whose binding was deleted and re-bound.
    const inheritedDefault = !(
      resolved &&
      chat.instanceName === resolved.instanceName &&
      chat.agentId === resolved.agentId
    );
    return {
      multiAgent: true as const,
      multiInstance,
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
    // DIRECT grants ONLY (via "user"). This editor MUTATES the userAgents table
    // (assign/remove/setDefaultAgent all key on a direct row), so it must show
    // exactly what those mutations can act on -- a group-INHERITED agent has no
    // userAgents row, so removeAgent would no-op and setDefaultAgent would throw.
    // The full union WITH provenance is the read-only Accès (introspection) tab.
    // Direct entries keep their own isDefault verbatim (getEffectiveGrants only
    // elects a default among via!="user" candidates), so the star stays correct.
    const enriched = await enrichUserAgents(ctx, profile.userId);
    return enriched.filter((a) => a.via === "user");
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
    if (agent === null || agent.source !== "discovered" || !agent.presentInLastOk) {
      throw new Error(
        `Agent not assignable: ${instanceName}/${agentId} is not a discovered, present agent`,
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
    for (const r of rows) {
      const shouldBeDefault = r._id === target._id;
      if (r.isDefault !== shouldBeDefault) {
        await ctx.db.patch(r._id, { isDefault: shouldBeDefault });
      }
    }
  },
});
