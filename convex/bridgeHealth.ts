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
    typeof o.lastDownstreamReject === "object" && o.lastDownstreamReject !== null
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
}

/** Pure availability decision from a health doc (testable without auth). Fail
 *  OPEN: no data -> available (the failDispatch bubble is still the backstop, so
 *  we never block a working chat on missing/initial telemetry). */
export function computeAvailability(
  doc: Doc<"bridgeHealth"> | null,
  now: number,
): Availability {
  if (doc === null)
    return { known: false, available: true, degraded: false, reason: null, checkedAt: null };
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
  const reason = !doc.reachable ? (doc.lastError ?? "unreachable") : stale ? "stale" : null;
  return { known: true, available, degraded: anyTargetError, reason, checkedAt: doc.checkedAt };
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
    const bridgeUrl = process.env.BRIDGE_URL;
    if (!bridgeUrl) {
      await ctx.runMutation(internal.bridgeHealth.upsertBridgeHealth, {
        reachable: false,
        lastError: "not_configured",
        targets: [],
      });
      return;
    }
    try {
      const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/health`, {
        method: "GET",
      });
      if (!res.ok) {
        await ctx.runMutation(internal.bridgeHealth.upsertBridgeHealth, {
          reachable: false,
          lastError: `http_${res.status}`,
          targets: [],
        });
        return;
      }
      const body = (await res.json()) as Record<string, unknown>;
      const targets = (Array.isArray(body.targets) ? body.targets : [])
        .map(normalizeTarget)
        .filter((t): t is NonNullable<typeof t> => t !== null);
      await ctx.runMutation(internal.bridgeHealth.upsertBridgeHealth, {
        reachable: true,
        status: typeof body.status === "string" ? body.status : undefined,
        startedAt: typeof body.startedAt === "number" ? body.startedAt : undefined,
        targets,
      });
    } catch {
      await ctx.runMutation(internal.bridgeHealth.upsertBridgeHealth, {
        reachable: false,
        lastError: "unreachable",
        targets: [],
      });
    }
  },
});

export const upsertBridgeHealth = internalMutation({
  args: {
    reachable: v.boolean(),
    status: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
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
