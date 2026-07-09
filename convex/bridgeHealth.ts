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
import {
  resolveBridgeUrlForDispatch,
  resolveHealthPollTargets,
} from "./lib/bridgeRouting";
import { canonicalForUser, resolveTargetForTurn } from "./routing";

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
  maxPayload: number | null;
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
    // Per-instance frame limit: a bridge serving instances with DIFFERENT maxPayloads
    // reports each target's own cap, so the poller keeps them distinct (not one
    // URL-level value copied onto every target). null on a pre-this-release bridge.
    maxPayload: num(o.maxPayload),
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
// The discovery-poll reason codes (instanceDiscovery.error) that mean the chat's
// gateway is genuinely UNREACHABLE — a transport failure — and so the composer
// must be blocked for this instance's chats. Everything else the poll can record
// means the gateway RESPONDED (the payload was just unusable) and last-good agents
// stay dispatchable, so it must NOT block:
//   - "unreachable"  — the fetch itself threw (connection refused / DNS / timeout).
//   - "http_502/503/504" — bad-gateway family: a proxy in front (or the gateway
//     restarting) could not serve the upstream. VERIFIED live: stopping a local
//     gateway surfaces as http_502, not "unreachable", so these MUST count as down.
// Deliberately EXCLUDED (gateway is up → do not false-block the composer):
//   - "shape_drift" / "empty_discovery" — the gateway answered, the discovery body
//     was malformed or empty (e.g. an older bridge with no `count`).
//   - "http_4xx" (auth/bad-request) and "http_500/501" — the gateway is serving and
//     erroring on THIS endpoint; a send may still succeed.
const INSTANCE_DOWN_ERRORS = new Set([
  "unreachable",
  "http_502",
  "http_503",
  "http_504",
]);

/** True when a discovery-poll `error` code denotes a real transport outage (block
 *  the composer), as opposed to a non-blocking sync failure (gateway responded). */
export function isInstanceDownError(
  error: string | null | undefined,
): boolean {
  return error != null && INSTANCE_DOWN_ERRORS.has(error);
}

export function computeAvailability(
  doc: Doc<"bridgeHealth"> | null,
  now: number,
  // When given, `degraded` + `maxInboundBytes` reflect ONLY this instance's targets
  // (one bridge, N gateways): instance B's gateway being down must not show instance
  // A as degraded, and A's inbound cap is A's gateway frame, not the doc-wide MIN.
  // `available` stays the GLOBAL bridge-reachable gate (no per-instance lockout).
  instanceName?: string | null,
  // When ALSO given, `degraded` narrows further to the chat's routed AGENT's own
  // target rows — on a multi-agent instance, another agent's erroring target must
  // not flag THIS chat's gateway as down (codex P2). `maxInboundBytes` stays
  // instance-scoped (the frame limit is the gateway's, not the agent's).
  agentId?: string | null,
  // And to the resolved CANONICAL: health targets are per instance:canonical, so on
  // a shared agent another user's erroring target must not flag this chat either.
  canonical?: string | null,
  // Per-INSTANCE liveness from the discovery poll (instanceDiscovery.lastPollOk,
  // fresh): false = the chat's gateway is UNREACHABLE (e.g. a backup) → block the
  // composer FOR THIS INSTANCE'S CHATS. This is a SELF-HEALING signal (the next
  // successful poll clears it, no user send needed), so unlike a target `error`
  // it cannot deadlock — a legit per-instance lockout. null/undefined = unknown
  // (no discovery row yet) → fail OPEN.
  instanceReachable?: boolean | null,
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
  const scoped =
    instanceName != null
      ? doc.targets.filter((t) => t.instanceName === instanceName)
      : doc.targets;
  const agentScoped = scoped.filter(
    (t) =>
      (agentId == null || t.agentId === agentId) &&
      (canonical == null || t.canonical === canonical),
  );
  const anyTargetError = agentScoped.some((t) => t.state === "error");
  // GLOBAL availability gates ONLY on "the bridge process is reachable AND the
  // poller is fresh". A SINGLE agent/target in `error` must NOT grey out the
  // composer for EVERY user/chat — that was a global-readonly DEADLOCK: one agent's
  // failed send (e.g. an attachment the gateway can't process) locked everyone out,
  // and the target stays `error` until a SUCCESSFUL send, which the lockout itself
  // prevents, so it never cleared without a manual bridge restart. A per-agent error
  // is surfaced per-chat by the failDispatch bubble; here it is only `degraded`.
  const instanceDown = instanceName != null && instanceReachable === false;
  const available = doc.reachable && !stale && !instanceDown;
  const reason = !doc.reachable
    ? (doc.lastError ?? "unreachable")
    : stale
      ? "stale"
      : instanceDown
        ? "instance_unreachable"
        : null;
  // Per-instance cap = that instance's OWN gateway frame (a scoped target's
  // maxPayload). When the instance has no target yet (idle bridge / just restarted,
  // before a send creates one) fall back to the doc-level value (the conservative MIN
  // across instances) — NEVER null, else the composer treats it as fail-open and lets
  // an oversized file through to fail later at dispatch.
  const docMaxPayload =
    typeof doc.maxPayload === "number" ? doc.maxPayload : null;
  const scopedMaxPayload =
    instanceName != null
      ? (scoped.find((t) => typeof t.maxPayload === "number")?.maxPayload ??
        docMaxPayload)
      : docMaxPayload;
  return {
    known: true,
    available,
    degraded: anyTargetError,
    reason,
    checkedAt: doc.checkedAt,
    // Derived from the gateway-announced maxPayload — never a hardcoded size.
    maxInboundBytes:
      scopedMaxPayload !== null ? maxRawInboundBytes(scopedMaxPayload) : null,
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
          // is null (one bridge / N instances, or env bridge) keep the bridge's
          // self-reported per-target instanceName. PREFER the target's OWN frame limit
          // (a bridge serving instances with different maxPayloads), falling back to
          // the URL-level value when a pre-this-release bridge omits it.
          .map((t) => ({
            ...t,
            instanceName: name ?? t.instanceName,
            maxPayload: t.maxPayload ?? mp,
          }));
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

/** Any active user: light availability projection for the chat composer gate. An
 *  optional chatId scopes `degraded` + the inbound cap to THAT chat's gateway (one
 *  bridge, N gateways) — instance B's gateway down must not grey out A's composer,
 *  and A's upload cap is A's gateway frame. Omitted → the global view (admin badge).
 *  instanceName is non-secret routing metadata; resolved from the chat's own row. */
export const getBridgeAvailability = query({
  args: {
    chatId: v.optional(v.id("chats")),
    // The agent the COMPOSER currently targets (attachment adapter): the upload cap
    // must be the TARGET gateway's frame limit. Validated below by the dispatch's
    // own authorization — a forged value can never scope-read another instance.
    routedAgent: v.optional(
      v.object({ instanceName: v.string(), agentId: v.string() }),
    ),
  },
  handler: async (ctx, { chatId, routedAgent }): Promise<Availability> => {
    const { userId } = await requireActive(ctx);
    let instanceName: string | null = null;
    let agentId: string | null = null;
    let canonical: string | null = null;
    if (chatId) {
      const chat = await ctx.db.get(chatId);
      // Only scope by a chat the CALLER owns — never read a third party's chat to
      // expose its instance's state/capacity (parity with the per-chat access gate).
      // Scope to the instance dispatch ACTUALLY routes to. resolveTargetForChat is the
      // authority: it honors chat.instanceName when the binding is valid, but REBINDS
      // to another instance when the bound agent was deleted/revoked — so the resolver
      // wins, with chat.instanceName only as a last resort (resolver found no target).
      if (chat && chat.userId === userId) {
        // Narrow `degraded` to the routed AGENT's own target for THIS user's
        // canonical (codex P2: another agent — or another user's canonical on a
        // shared agent — erroring on the same instance must not flag this chat).
        // PER-TURN routing precedence, mirroring the dispatch's own:
        //   1. the LAST SEND's explicit routing — the newest outbox row across ALL
        //      lifecycle states (pending covers a switch mid-send before
        //      confirmTurnRouting; FAILED covers the outage window itself: the
        //      switched-to agent's dead gateway fails the dispatch, lastRouted*
        //      never advances, yet the composer/retry stays on that agent),
        //   2. the last CONFIRMED routed agent (lastRouted*),
        //   3. the chat's primary binding.
        // The choice runs through resolveTargetForTurn — the dispatch's OWN
        // authorization — so a forged/revoked routedAgent yields target:null and
        // can never scope-read a non-entitled instance's state or capacity.
        // NOT "queued": a queued follow-up describes a FUTURE turn — the degraded
        // signal feeds the ACTIVE turn's RunStatus, so a queued row targeting a
        // different agent must neither hide the active agent's outage nor show a
        // false one (codex P2 round 5). pending (being dispatched NOW) outranks
        // recency; else the newest of sent/failed = the last attempted send.
        const [pendingRow, sentRow, failedRow] = await Promise.all(
          (["pending", "sent", "failed"] as const).map((status) =>
            ctx.db
              .query("outbox")
              .withIndex("by_chat_status", (q) =>
                q.eq("chatId", chatId!).eq("status", status),
              )
              .order("desc")
              .first(),
          ),
        );
        const lastAttempt = [sentRow, failedRow]
          .filter((r) => r !== null)
          .sort((a, b) => b!._creationTime - a!._creationTime)[0];
        const lastSend = pendingRow ?? lastAttempt;
        // An EXPLICIT caller target (the attachment adapter passing the composer's
        // current selection) outranks the send history — the upload cap must be the
        // gateway the NEXT send will actually hit.
        const chosen =
          routedAgent ??
          lastSend?.routedAgent ??
          (chat.lastRoutedInstanceName && chat.lastRoutedAgentId
            ? {
                instanceName: chat.lastRoutedInstanceName,
                agentId: chat.lastRoutedAgentId,
              }
            : null);
        const target = (await resolveTargetForTurn(ctx, chat, userId, chosen))
          .target;
        instanceName = target?.instanceName ?? chat.instanceName ?? null;
        agentId = target?.agentId ?? chat.agentId ?? null;
        // The user's OWN canonical, independent of target resolution — the filter
        // must stay narrow even when the resolver finds no target (else another
        // canonical's error on a shared agent shows this chat a false outage).
        canonical = await canonicalForUser(ctx, userId);
      }
    }
    // Per-instance liveness: the discovery poll (cron, activity-independent)
    // marks lastPollOk=false when an instance's gateway is unreachable — even
    // idle. A TRANSPORT-down poll blocks THIS instance's composer; unknown → fail
    // open.
    const now = Date.now();
    let instanceReachable: boolean | null = null;
    if (instanceName != null) {
      const disc = await ctx.db
        .query("instanceDiscovery")
        .withIndex("by_instance", (q) => q.eq("instanceName", instanceName!))
        .first();
      if (disc != null) {
        // Gate on the EXPLICIT poll verdict, NOT staleness: a real outage flips
        // lastPollOk=false within one poll interval (~2 min), while a stale
        // lastPollAt on a HEALTHY instance (uneven poll cadence) must not
        // false-block it. A stopped poller (bridge down) is caught by the GLOBAL
        // reachable gate instead. AND only a TRANSPORT failure blocks: a poll that
        // failed on shape_drift / empty_discovery / http_4xx (the gateway answered,
        // last-good agents still dispatchable) must NOT grey the composer — see
        // isInstanceDownError. A failed non-transport poll counts as reachable.
        instanceReachable =
          disc.lastPollOk === true || !isInstanceDownError(disc.error);
      }
    }
    return computeAvailability(
      await readDoc(ctx),
      now,
      instanceName,
      agentId,
      canonical,
      instanceReachable,
    );
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

/**
 * A CLEAR per-instance health view (instance <-> bridge <-> gateway) for the API/MCP:
 * is a bridge configured to serve it, is it available/degraded + why, the gateway version
 * + last error, and the agent-discovery state (count + freshness). Read-only aggregation
 * of the poller-maintained caches (health 1min / agents 2min / compat 5min) — no live
 * bridge call. Gated `bridge.read` at the route.
 */
export const bridgeStatusInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const doc = await readDoc(ctx);
    const instances = await ctx.db.query("instances").collect();
    const served = process.env.BRIDGE_INSTANCE_NAME ?? null;
    const isSole = instances.length === 1;
    const rows = [];
    for (const inst of instances) {
      const avail = computeAvailability(doc, now, inst.name);
      // A bridge is reachable for this instance iff it has its own bridgeUrl, or is the
      // env-served / sole instance — the same scoped routing dispatch + sync use.
      const bridgeUrlConfigured =
        resolveBridgeUrlForDispatch(
          { bridgeUrl: inst.bridgeUrl },
          { instanceName: inst.name, served, isSole },
        ) !== undefined;
      const target =
        doc?.targets.find((t) => t.instanceName === inst.name) ?? null;
      const discovery = await ctx.db
        .query("instanceDiscovery")
        .withIndex("by_instance", (q) => q.eq("instanceName", inst.name))
        .first();
      const agents = await ctx.db
        .query("agents")
        .withIndex("by_instance", (q) => q.eq("instanceName", inst.name))
        .collect();
      // PER-INSTANCE health, derived from the HEALTH DOC ONLY (NOT the global
      // `computeAvailability.available`, which stays true whenever ANY bridge answers, and
      // NOT the agents discovery, whose lastPollAt is deliberately NOT bumped on a no-change
      // success — so it can't measure freshness). The health poll runs every minute and
      // ALWAYS bumps `checkedAt`, so it is the one reliable current signal. `stale` is
      // checked BEFORE the error branches so a snapshot too old to trust (e.g. a wedged
      // poller after a target went into error) reads `stale`, never a frozen `error`.
      // `degraded`/`maxInboundBytes` from computeAvailability are already instance-scoped;
      // the discovery fields below are exposed RAW (last-good), not used for this verdict.
      const health: "no_bridge_url" | "error" | "ok" | "stale" | "unknown" =
        ((): "no_bridge_url" | "error" | "ok" | "stale" | "unknown" => {
          if (!bridgeUrlConfigured) return "no_bridge_url";
          // A FAILED agents poll is a RELIABLE per-instance failure signal: failures
          // always bump the discovery row (only a no-change SUCCESS skips the write), and
          // a recovery flips lastPollOk back to true. It is doc-independent, so it catches
          // the multi-bridge case where THIS instance's bridge is down but another answers
          // (global doc.reachable stays true, no target for this instance).
          if (discovery?.lastPollOk === false) return "error";
          if (doc === null) return "unknown"; // no health telemetry yet
          // Staleness is checked BEFORE the target/reachable branches so a snapshot too old
          // to trust (e.g. a wedged poller after a target went into error) reads `stale`,
          // never a frozen `error`/`ok`. checkedAt is bumped on EVERY poll, so it is the
          // one reliable freshness measure (unlike discovery.lastPollAt).
          if (now - doc.checkedAt > STALE_MS) return "stale";
          if (!doc.reachable) return "error";
          if (target?.state === "error") return "error";
          if (target?.state === "connected") return "ok";
          // Fresh + reachable but no per-instance target (idle, or just configured): no
          // current positive confirmation. The raw discovery/agent fields below clarify;
          // we do NOT promote a no-change-stale discovery success to `ok` here.
          return "unknown";
        })();
      rows.push({
        instanceName: inst.name,
        displayName: inst.displayName ?? inst.name,
        bridgeUrlConfigured,
        health,
        degraded: avail.degraded,
        gatewayVersion: target?.gatewayVersion ?? null,
        gatewayState: target?.state ?? null,
        lastErrorCode: target?.lastErrorCode ?? null,
        maxInboundBytes: avail.maxInboundBytes,
        agentCount: agents.filter((a) => a.presentInLastOk).length,
        agentsLastOkAt: discovery?.lastOkAt ?? null,
        discoveryOk: discovery?.lastPollOk ?? null,
        discoveryError: discovery?.error ?? null,
      });
    }
    return rows;
  },
});
