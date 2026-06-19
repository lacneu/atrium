// Bridge health — ACTIVE monitoring (distinct from the passive `anomalies` scan).
//
// A cron (`pollBridgeHealth`) GETs the bridge's unauthenticated /health every
// minute and upserts a singleton `bridgeHealth` doc. The Settings health badge
// reads it (admin), and the chat availability gate reads a light projection
// (any active user) to grey out the composer when the bridge is down — BEFORE a
// send is persisted. SECURITY: /health is non-secret (state codes + host only),
// and BRIDGE_URL lives in deployment env, never a table/browser.

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
import { requireActive, requirePermission } from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { bridgeHealthTarget } from "./schema";
import { maxRawInboundBytes } from "./lib/attachmentLimits";
import { resolveHealthPollTargets } from "./lib/bridgeRouting";

const HEALTH_KEY = "singleton";
// A snapshot older than this means the poller itself is wedged/dead -> treat the
// bridge as unavailable (3 missed 60s polls).
const STALE_MS = 3 * 60 * 1000;

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" ? x : null);

/** Flatten one target from the bridge /health JSON. Defensive: the body came
 *  over the network, so validate every field; return null on a bad shape. */
export function normalizeTarget(raw: unknown): {
  key: string;
  instanceName: string | null;
  canonical: string;
  agentId: string;
  gatewayHost: string;
  state: string;
  lastOkAt: number | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
  attempts: number;
  okCount: number;
  errorCount: number;
  lastDownstreamRejectCode: string | null;
  lastDownstreamRejectAt: number | null;
  downstreamRejectCount: number;
  gatewayVersion: string | null;
} | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const key = str(o.key);
  const canonical = str(o.canonical);
  const agentId = str(o.agentId);
  const gatewayHost = str(o.gatewayHost);
  const state = str(o.state);
  if (!key || !canonical || !agentId || !gatewayHost || !state) return null;
  const le =
    typeof o.lastError === "object" && o.lastError !== null
      ? (o.lastError as Record<string, unknown>)
      : null;
  // Downstream rejection (the gateway refused the request) — a pre-this-release
  // bridge omits it, so it is parsed defensively and defaults to absent.
  const dr =
    typeof o.lastDownstreamReject === "object" &&
    o.lastDownstreamReject !== null
      ? (o.lastDownstreamReject as Record<string, unknown>)
      : null;
  return {
    key,
    instanceName: str(o.instanceName),
    canonical,
    agentId,
    gatewayHost,
    state,
    lastOkAt: num(o.lastOkAt),
    lastErrorCode: le ? str(le.code) : null,
    lastErrorAt: le ? num(le.at) : null,
    attempts: num(o.attempts) ?? 0,
    okCount: num(o.okCount) ?? 0,
    errorCount: num(o.errorCount) ?? 0,
    lastDownstreamRejectCode: dr ? str(dr.code) : null,
    lastDownstreamRejectAt: dr ? num(dr.at) : null,
    downstreamRejectCount: num(o.downstreamRejectCount) ?? 0,
    // Per-instance gateway version (Model M): each bridge's /health reports its own
    // gateway's version, so the connection row shows it per instance (the compat
    // poller is a singleton and can't).
    gatewayVersion: str(o.gatewayVersion),
  };
}

export interface Availability {
  /** Do we have any health data yet? (false -> fail OPEN, never block blindly) */
  known: boolean;
  /** Is the chat path usable right now? GLOBAL gate = the bridge PROCESS is
   *  reachable + the poller is fresh. Deliberately NOT gated on a single target's
   *  error (see computeAvailability) so one agent never locks out every chat. */
  available: boolean;
  /** A target (agent) is erroring while the bridge is up: informational +
   *  NON-blocking. The per-send failDispatch bubble surfaces the specific failure
   *  in the affected chat; the composer stays usable everywhere. */
  degraded: boolean;
  /** Non-secret reason when NOT available (for the banner). */
  reason: string | null;
  checkedAt: number | null;
  /** Max RAW inbound-attachment bytes, DERIVED from the gateway's maxPayload (the
   *  composer rejects bigger files upfront). null when maxPayload is not yet known
   *  -> the composer fails OPEN (the bridge frame guard is the backstop). */
  maxInboundBytes: number | null;
}

/** Pure availability decision from a health doc (testable without auth). Fail
 *  OPEN: no data -> available (the failDispatch bubble is still the backstop, so
 *  we never block a working chat on missing/initial telemetry). */
export function computeAvailability(
  doc: Doc<"bridgeHealth"> | null,
  now: number,
): Availability {
  if (doc === null)
    return {
      known: false,
      available: true,
      degraded: false,
      reason: null,
      checkedAt: null,
      maxInboundBytes: null,
    };
  const stale = now - doc.checkedAt > STALE_MS;
  const anyTargetError = doc.targets.some((t) => t.state === "error");
  // GLOBAL availability gates ONLY on "the bridge process is reachable AND the
  // poller is fresh". A SINGLE agent/target in `error` must NOT grey out the
  // composer for EVERY user/chat — that was a global-readonly DEADLOCK: one agent's
  // failed send (e.g. an attachment the gateway can't process) locked everyone out,
  // and the target stays `error` until a SUCCESSFUL send, which the lockout itself
  // prevents, so it never cleared without a manual bridge restart. A per-agent error
  // is surfaced per-chat by the failDispatch bubble; here it is only `degraded`.
  const available = doc.reachable && !stale;
  const reason = !doc.reachable
    ? (doc.lastError ?? "unreachable")
    : stale
      ? "stale"
      : null;
  return {
    known: true,
    available,
    degraded: anyTargetError,
    reason,
    checkedAt: doc.checkedAt,
    // Derived from the gateway-announced maxPayload — never a hardcoded size.
    maxInboundBytes:
      typeof doc.maxPayload === "number"
        ? maxRawInboundBytes(doc.maxPayload)
        : null,
  };
}

async function readDoc(ctx: QueryCtx): Promise<Doc<"bridgeHealth"> | null> {
  return await ctx.db
    .query("bridgeHealth")
    .withIndex("by_key", (q) => q.eq("key", HEALTH_KEY))
    .unique();
}

/** Cron: poll the bridge /health and upsert the snapshot. Tolerant — an
 *  unreachable/HTTP-error/non-JSON bridge becomes reachable:false with a reason
 *  code, never a thrown action (a thrown action would retry and never record). */
export const pollBridgeHealth = internalAction({
  args: {},
  handler: async (ctx) => {
    // Model M: poll EACH instance's own bridge (resolvePollTargets) and AGGREGATE
    // into the singleton — the bridge /health targets already carry instanceName,
    // so the existing per-target UI shows every instance with no UI change. Each
    // instance's targets are tagged with that bridge's maxPayload (so the dispatch
    // can derive the inbound cap per routed instance). Backward-compatible: with a
    // single env BRIDGE_URL the loop runs once and the doc is byte-identical to the
    // old single-bridge behaviour (incl. the http_/unreachable lastError codes).
    const instances = await ctx.runQuery(
      internal.agents.listInstancesForPoll,
      {},
    );
    const pollTargets = resolveHealthPollTargets(instances, {
      envUrl: process.env.BRIDGE_URL?.trim() || null,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
    });
    if (pollTargets.length === 0) {
      await ctx.runMutation(internal.bridgeHealth.upsertBridgeHealth, {
        reachable: false,
        lastError: "not_configured",
        targets: [],
      });
      return;
    }

    const allTargets: Doc<"bridgeHealth">["targets"] = [];
    const maxPayloads: number[] = [];
    let anyReachable = false;
    let status: string | undefined;
    let startedAt: number | undefined;
    let lastError: string | undefined; // used only when NOTHING is reachable

    for (const { name, url } of pollTargets) {
      try {
        const res = await fetch(`${url}/health`, { method: "GET" });
        if (!res.ok) {
          lastError = `http_${res.status}`;
          continue; // this instance is down this cycle; others may be up
        }
        const body = (await res.json()) as Record<string, unknown>;
        anyReachable = true;
        if (status === undefined && typeof body.status === "string") {
          status = body.status;
        }
        if (startedAt === undefined && typeof body.startedAt === "number") {
          startedAt = body.startedAt;
        }
        const mp = typeof body.maxPayload === "number" ? body.maxPayload : null;
        if (mp !== null) maxPayloads.push(mp);
        const its = (Array.isArray(body.targets) ? body.targets : [])
          .map(normalizeTarget)
          .filter((t): t is NonNullable<typeof t> => t !== null)
          // When we KNOW the instance (per-instance bridgeUrl, or the served name),
          // FORCE it (never trust the body to attribute another instance); when name
          // is null (env bridge, no served name) keep the bridge's self-reported one
          // (backward-compat). Always tag this instance's frame limit.
          .map((t) => ({ ...t, instanceName: name ?? t.instanceName, maxPayload: mp }));
        allTargets.push(...its);
      } catch {
        lastError = "unreachable";
      }
    }

    await ctx.runMutation(internal.bridgeHealth.upsertBridgeHealth, {
      reachable: anyReachable,
      status,
      startedAt,
      lastError: anyReachable ? undefined : (lastError ?? "unreachable"),
      // Doc-level cap = the MIN across reachable instances (conservative for the
      // GLOBAL composer gate, which doesn't know the chat's instance). The precise
      // per-instance value lives on each target for maxPayloadInternal.
      maxPayload: maxPayloads.length > 0 ? Math.min(...maxPayloads) : null,
      targets: allTargets,
    });
  },
});

export const upsertBridgeHealth = internalMutation({
  args: {
    reachable: v.boolean(),
    status: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    maxPayload: v.optional(v.union(v.number(), v.null())),
    targets: v.array(bridgeHealthTarget),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await readDoc(ctx);
    // Set fields EXPLICITLY (incl. undefined) so a recovered poll CLEARS the old
    // lastError instead of leaving a stale code behind.
    const fields = {
      reachable: args.reachable,
      status: args.status,
      startedAt: args.startedAt,
      lastError: args.lastError,
      maxPayload: args.maxPayload,
      targets: args.targets,
      checkedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("bridgeHealth", { key: HEALTH_KEY, ...fields });
  },
});

/** Admin: full health snapshot for the Settings badge / health view. */
export const getBridgeHealth = query({
  args: {},
  handler: async (ctx) => {
    // Per-tab RBAC: Bridge tab readable by any user granted bridge.read (admins
    // via wildcard). getBridgeAvailability stays requireActive (chat gate).
    await requirePermission(ctx, PERMISSIONS.BRIDGE_READ);
    const doc = await readDoc(ctx);
    if (doc === null) return null;
    return {
      reachable: doc.reachable,
      status: doc.status ?? null,
      startedAt: doc.startedAt ?? null,
      checkedAt: doc.checkedAt,
      lastError: doc.lastError ?? null,
      targets: doc.targets,
    };
  },
});

/** Any active user: light availability projection for the chat composer gate. */
export const getBridgeAvailability = query({
  args: {},
  handler: async (ctx): Promise<Availability> => {
    await requireActive(ctx);
    return computeAvailability(await readDoc(ctx), Date.now());
  },
});

/** Internal (no auth): the availability projection for the /api/v1 diagnose route,
 *  which runs the key permission check itself. Same computeAvailability output. */
export const availabilityInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<Availability> =>
    computeAvailability(await readDoc(ctx), Date.now()),
});

/** Internal (no auth): the gateway's last-reported WS frame limit (maxPayload), or
 *  null if unknown. The dispatch derives the inbound-attachment cap from it to fail
 *  an over-cap attachment with a clear error instead of silently dropping it. */
export const maxPayloadInternal = internalQuery({
  args: { instanceName: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { instanceName }): Promise<number | null> => {
    const doc = await readDoc(ctx);
    if (doc === null) return null;
    // Prefer the routed instance's OWN frame limit (Model M): find a target for
    // this instance that reported a maxPayload. Fall back to the doc-level (MIN
    // across instances — conservative), then null (the dispatch uses the default).
    if (instanceName != null) {
      for (const t of doc.targets) {
        if (
          t.instanceName === instanceName &&
          typeof t.maxPayload === "number"
        ) {
          return t.maxPayload;
        }
      }
    }
    return doc.maxPayload ?? null;
  },
});
