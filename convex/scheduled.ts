// Settings ▸ Personal ▸ Scheduled: the user's gateway cron jobs, read
// on-demand through the bridge (/cron-list — LAZY, never on the turn path).
//
// Model: gateway cron jobs belong to an AGENT (OpenClaw pins agentId per job,
// default-agent when omitted; Hermes instances are single-agent). A user's
// scheduled jobs = the jobs of the agents they are entitled to (effective
// grants) — the same association that scopes every other agent surface.
// Capability-gated per instance (`cronList`), so unsupported gateways simply
// contribute an honest "unsupported" entry instead of an error.

import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { requireActive, requirePermission } from "./lib/access";
import { PERMISSIONS } from "./lib/rbac";
import { enrichUserAgents } from "./agents";
import { postBridge } from "./agentFiles";
import { capabilitiesForInstance, type CompatTarget } from "./lib/compat";
import {
  filterJobsForAgents,
  MAX_JOBS_SHOWN,
  parseCronListResponse,
} from "./lib/scheduled";

/** Per-instance targets for the caller's cron listing: the user's entitled
 *  agentIds, the instance default agent, its bridgeUrl and the capability
 *  verdict — everything the action needs, resolved in ONE query. */
export const myCronTargets = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Caller identity propagates from the action's runQuery — auth lives HERE
    // (queries have db access; the action ctx does not). Same server gate as
    // the Files tab: real-identity chats.read permission (TAB_PERMISSION is
    // cosmetic), then the EFFECTIVE identity scopes the data.
    await requirePermission(ctx, PERMISSIONS.CHATS_READ);
    const { userId } = await requireActive(ctx);
    const agents = await enrichUserAgents(ctx, userId);
    const byInstance = new Map<
      string,
      { agentIds: string[]; kind: "openclaw" | "hermes" }
    >();
    for (const a of agents) {
      if (a.state === "deleted") continue;
      const entry = byInstance.get(a.instanceName) ?? {
        agentIds: [],
        kind: a.kind,
      };
      if (!entry.agentIds.includes(a.agentId)) entry.agentIds.push(a.agentId);
      byInstance.set(a.instanceName, entry);
    }
    const compatDoc = await ctx.db.query("bridgeCompat").first();
    const compatTargets = (compatDoc?.targets ?? []) as CompatTarget[];
    const targets: {
      instanceName: string;
      kind: "openclaw" | "hermes";
      agentIds: string[];
      defaultAgentId: string | null;
      bridgeUrl: string | null;
      supported: boolean;
      manageSupported: boolean;
    }[] = [];
    for (const [instanceName, entry] of byInstance) {
      const inst = await ctx.db
        .query("instances")
        .withIndex("by_name", (q) => q.eq("name", instanceName))
        .first();
      if (inst === null) continue;
      // A job WITHOUT an agentId runs on the GATEWAY's own default agent — the
      // discovery-stamped isDefaultOnInstance flag — NOT on Atrium's routing
      // default (instances.defaultAgentId is an app-side override an admin can
      // point anywhere). Resolving against the wrong one would show a user
      // cron metadata of an agent they hold no grant on, or hide their own.
      // Bounded like every catalogue read (an instance's agent list is tens of
      // rows; the cap only guards against pathological growth). Only agents
      // STILL present on the gateway qualify: a replaced default keeps its
      // stale isDefaultOnInstance flag with presentInLastOk=false — resolving
      // to it would attribute every null-agent job to a deleted agent and
      // hide them all.
      const gatewayDefault = (
        await ctx.db
          .query("agents")
          .withIndex("by_instance", (q) => q.eq("instanceName", instanceName))
          .take(500)
      ).find((a) => a.isDefaultOnInstance && a.presentInLastOk !== false)
        ?.agentId;
      // The compat snapshot's per-instance target already carries the RESOLVED
      // capability map for that instance's provider+version — the same source
      // every other capability gate reads.
      const cap = capabilitiesForInstance(compatTargets, instanceName);
      targets.push({
        instanceName,
        kind: entry.kind,
        agentIds: entry.agentIds,
        defaultAgentId: gatewayDefault ?? null,
        bridgeUrl: inst.bridgeUrl ?? null,
        supported: cap?.capabilities?.cronList === true,
        manageSupported: cap?.capabilities?.cronManage === true,
      });
    }
    return targets;
  },
});

/** The caller's scheduled gateway jobs, grouped per instance. Read-only. */
export const listMyCrons = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    {
      instanceName: string;
      kind: "openclaw" | "hermes";
      supported: boolean;
      manageSupported: boolean;
      error: string | null;
      jobs: {
        id: string | null;
        name: string | null;
        enabled: boolean | null;
        schedule: string | null;
        nextRunAtMs: number | null;
        lastRunStatus: string | null;
        agentId: string;
      }[];
    }[]
  > => {
    const targets = await ctx.runQuery(internal.scheduled.myCronTargets, {});
    // One probe per instance, IN PARALLEL: gateways are independent, and a
    // slow/unreachable one (50s client budget) must cost wall-clock once, not
    // once per instance — serialized worst cases would starve the action's
    // own time budget with a handful of degraded gateways.
    return Promise.all(
      targets.map(async (t) => {
        if (!t.supported) {
          return {
            instanceName: t.instanceName,
            kind: t.kind,
            supported: false,
            manageSupported: false,
            error: null,
            jobs: [],
          };
        }
        try {
          // Above the bridge's worst case: a COLD operator connection (connect
          // budget up to ~30s) + the 15s cron.list RPC — a shorter client abort
          // would misreport a slow-but-healthy gateway as bridge_unreachable.
          const { status, data } = await postBridge(
            "/cron-list",
            { instanceName: t.instanceName },
            50_000,
            t.bridgeUrl,
          );
          const jobs = status === 200 ? parseCronListResponse(data) : null;
          if (jobs === null) {
            return {
              instanceName: t.instanceName,
              kind: t.kind,
              supported: true,
              manageSupported: t.manageSupported,
              error: `bridge_${status}`,
              jobs: [],
            };
          }
          // Human-scale output cap AFTER the per-user filter (a shared
          // instance's foreign jobs must not crowd out the caller's own).
          const mine = filterJobsForAgents(
            jobs,
            t.agentIds,
            t.defaultAgentId,
          ).slice(0, MAX_JOBS_SHOWN);
          return {
            instanceName: t.instanceName,
            kind: t.kind,
            supported: true,
            manageSupported: t.manageSupported,
            error: null,
            jobs: mine.map((j) => ({
              id: j.id,
              name: j.name,
              enabled: j.enabled,
              schedule: j.schedule,
              nextRunAtMs: j.nextRunAtMs,
              lastRunStatus: j.lastRunStatus,
              agentId: j.effectiveAgentId,
            })),
          };
        } catch {
          return {
            instanceName: t.instanceName,
            kind: t.kind,
            supported: true,
            manageSupported: t.manageSupported,
            error: "bridge_unreachable",
            jobs: [],
          };
        }
      }),
    );
  },
});


// ===========================================================================
// Management (update / remove / run-now / history) — every op is OWNERSHIP-
// gated: the job's agent (or the instance default when unpinned) must be one
// of the caller's effective agents, the same fail-closed rule as the listing.
// The bridge accepts only a CLOSED patch field set (name/enabled/schedule/
// message) — a raw gateway patch could re-attribute the job via agentId.
// ===========================================================================

/** What the UI may offer: provider surface (Hermes has no update/run/
 *  history) INTERSECTED with the versioned `cronManage` capability — an
 *  older gateway that only lists must not be offered actions that would
 *  fail with an unknown RPC method. */
function cronCapabilitiesFor(
  kind: "openclaw" | "hermes",
  manageSupported: boolean,
): {
  canEdit: boolean;
  canRunNow: boolean;
  canHistory: boolean;
  canToggle: boolean;
  canDelete: boolean;
} {
  const full = kind === "openclaw" && manageSupported;
  return {
    canEdit: full,
    canRunNow: full,
    canHistory: full,
    // Hermes pause WORKS but its list API cannot show disabled jobs (no
    // include_disabled on the 0.18 WS RPC) — a paused job would vanish from
    // the tab with no way back. Never offer an action whose effect is an
    // unrecoverable disappearance: toggle is OpenClaw-only.
    canToggle: full,
    canDelete: manageSupported,
  };
}

type CronTargets = {
  instanceName: string;
  kind: "openclaw" | "hermes";
  agentIds: string[];
  defaultAgentId: string | null;
  bridgeUrl: string | null;
  supported: boolean;
  manageSupported: boolean;
}[];

/** The detail shape the bridge returns for op:"get" (normalized there). */
export type CronJobDetailView = {
  id: string | null;
  name: string | null;
  enabled: boolean | null;
  schedule: string | null;
  scheduleKind: string | null;
  scheduleExpr: string | null;
  tz: string | null;
  message: string | null;
  messageTruncated: boolean;
  payloadKind: string | null;
  deliveryMode: string | null;
  agentId: string | null;
  nextRunAtMs: number | null;
  lastRunStatus: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
};

const DETAIL_FIELD_CAP = 400;
const DETAIL_MESSAGE_CAP = 4000;
const DETAIL_MAX_EPOCH_MS = 8.64e15; // Date-representable (Intl throws beyond)

function detailStr(v: unknown, cap = DETAIL_FIELD_CAP): string | null {
  return typeof v === "string" && v !== "" ? v.slice(0, cap) : null;
}
function detailNum(v: unknown): number | null {
  return typeof v === "number" &&
    Number.isFinite(v) &&
    Math.abs(v) <= DETAIL_MAX_EPOCH_MS
    ? v
    : null;
}

/** Normalize the bridge's job detail defensively — every field re-typed and
 *  bounded (an old/drifted bridge must not crash the panel with an object
 *  name or an out-of-range timestamp), and FAIL CLOSED on the ownership-
 *  deciding `agentId`: it must be PRESENT and string|null, or the whole
 *  detail is rejected (a missing pin must never read as "default agent"). */
function detailFrom(data: unknown): CronJobDetailView | null {
  if (typeof data !== "object" || data === null) return null;
  const job = (data as Record<string, unknown>).job;
  if (typeof job !== "object" || job === null) return null;
  const j = job as Record<string, unknown>;
  if (!("agentId" in j)) return null;
  // The ownership-deciding field gets STRICT treatment (never normalized):
  // explicit null = the gateway default agent; a non-empty string within the
  // cap = a pin; anything else (empty, oversized — truncation could collide
  // with a real agent id — or mistyped) rejects the whole detail.
  if (
    j.agentId !== null &&
    (typeof j.agentId !== "string" ||
      j.agentId === "" ||
      j.agentId.length > DETAIL_FIELD_CAP)
  ) {
    return null;
  }
  return {
    id: detailStr(j.id),
    name: detailStr(j.name),
    enabled: typeof j.enabled === "boolean" ? j.enabled : null,
    schedule: detailStr(j.schedule),
    scheduleKind: detailStr(j.scheduleKind),
    scheduleExpr: detailStr(j.scheduleExpr),
    tz: detailStr(j.tz),
    message: detailStr(j.message, DETAIL_MESSAGE_CAP),
    messageTruncated: j.messageTruncated === true,
    payloadKind: detailStr(j.payloadKind),
    deliveryMode: detailStr(j.deliveryMode),
    agentId: j.agentId as string | null,
    nextRunAtMs: detailNum(j.nextRunAtMs),
    lastRunStatus: detailStr(j.lastRunStatus),
    createdAtMs: detailNum(j.createdAtMs),
    updatedAtMs: detailNum(j.updatedAtMs),
  };
}

/** Resolve the caller's target for `instanceName` + assert the job is theirs.
 *  Returns the (provider-shaped) detail so callers reuse the probe read. */
async function requireOwnedCronJob(
  ctx: { runQuery: (ref: never, args: Record<string, never>) => Promise<unknown> },
  instanceName: string,
  jobId: string,
): Promise<{
  target: CronTargets[number];
  detail: CronJobDetailView | null;
}> {
  const targets = (await ctx.runQuery(
    internal.scheduled.myCronTargets as never,
    {},
  )) as CronTargets;
  const target = targets.find((t) => t.instanceName === instanceName);
  if (!target) throw new ConvexError({ code: "unknown_instance" });
  if (!target.supported) throw new ConvexError({ code: "unsupported" });
  // The ownership probe itself is a cron.get — a list-only gateway (cronList
  // without cronManage, e.g. OpenClaw < 2026.7.1) has no verified shape for
  // it: answer "unsupported" up front instead of a raw bridge error.
  if (!target.manageSupported) throw new ConvexError({ code: "unsupported" });

  if (target.kind === "openclaw") {
    const { status, data } = await postBridge(
      "/cron-manage",
      { instanceName, op: "get", jobId },
      50_000,
      target.bridgeUrl,
    );
    if (status === 404) throw new ConvexError({ code: "not_found" });
    if (status !== 200) throw new ConvexError({ code: `bridge_${status}` });
    const detail = detailFrom(data);
    if (detail === null) throw new ConvexError({ code: "not_found" });
    // The probe must describe THE requested job: a drifted gateway answering
    // with another job's detail would otherwise authorize a mutation that
    // still targets the caller-supplied jobId (confused-deputy).
    if (detail.id !== jobId) throw new ConvexError({ code: "not_found" });
    // Fail closed exactly like the list filter: a malformed pin ("__invalid__")
    // matches no effective agent; a null pin resolves to the instance default.
    const effective = detail.agentId ?? target.defaultAgentId;
    if (effective === null || !target.agentIds.includes(effective)) {
      throw new ConvexError({ code: "forbidden" });
    }
    return { target, detail };
  }

  // Hermes: no per-job get — assert existence via the (filtered) listing; a
  // single-agent instance means ownership = the caller holds that agent.
  const { status, data } = await postBridge(
    "/cron-list",
    { instanceName },
    50_000,
    target.bridgeUrl,
  );
  if (status !== 200) throw new ConvexError({ code: `bridge_${status}` });
  const jobs = parseCronListResponse(data);
  if (jobs === null) throw new ConvexError({ code: "bridge_malformed" });
  const mine = filterJobsForAgents(jobs, target.agentIds, target.defaultAgentId);
  const summary = mine.find((j) => j.id === jobId);
  if (summary === undefined) throw new ConvexError({ code: "not_found" });
  return {
    target,
    detail: {
      id: summary.id,
      name: summary.name,
      enabled: summary.enabled,
      schedule: summary.schedule,
      scheduleKind: null,
      scheduleExpr: null,
      tz: null,
      message: null,
      messageTruncated: false,
      payloadKind: null,
      deliveryMode: null,
      agentId: summary.effectiveAgentId,
      nextRunAtMs: summary.nextRunAtMs,
      lastRunStatus: summary.lastRunStatus,
      createdAtMs: null,
      updatedAtMs: null,
    },
  };
}

const cronPatchValidator = v.object({
  name: v.optional(v.string()),
  enabled: v.optional(v.boolean()),
  message: v.optional(v.string()),
  schedule: v.optional(
    v.union(
      v.object({
        kind: v.literal("cron"),
        expr: v.string(),
        tz: v.optional(v.string()),
      }),
      v.object({ kind: v.literal("every"), everyMs: v.number() }),
      v.object({ kind: v.literal("at"), at: v.string() }),
    ),
  ),
});

/** One job's live detail + what the provider lets the UI do with it. */
export const getCronDetail = action({
  args: { instanceName: v.string(), jobId: v.string() },
  handler: async (
    ctx,
    { instanceName, jobId },
  ): Promise<{
    job: CronJobDetailView;
    capabilities: ReturnType<typeof cronCapabilitiesFor>;
    kind: "openclaw" | "hermes";
  }> => {
    const { target, detail } = await requireOwnedCronJob(
      ctx as never,
      instanceName,
      jobId,
    );
    return {
      job: detail as CronJobDetailView,
      capabilities: cronCapabilitiesFor(target.kind, target.manageSupported),
      kind: target.kind,
    };
  },
});

/** The job's recent run history (status + result summary). OpenClaw only. */
export const listCronRuns = action({
  args: {
    instanceName: v.string(),
    jobId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { instanceName, jobId, limit },
  ): Promise<
    {
      ts: number | null;
      runAtMs: number | null;
      status: string | null;
      summary: string | null;
      error: string | null;
      durationMs: number | null;
      model: string | null;
    }[]
  > => {
    const { target } = await requireOwnedCronJob(ctx as never, instanceName, jobId);
    if (target.kind !== "openclaw" || !target.manageSupported) {
      throw new ConvexError({ code: "unsupported" });
    }
    const { status, data } = await postBridge(
      "/cron-manage",
      { instanceName, op: "runs", jobId, ...(limit !== undefined ? { limit } : {}) },
      50_000,
      target.bridgeUrl,
    );
    if (status !== 200) throw new ConvexError({ code: `bridge_${status}` });
    const raw = (data as { entries?: unknown[] } | null)?.entries;
    if (!Array.isArray(raw)) return [];
    // Same defensive re-typing as the detail: a divergent bridge response
    // must not reach React with an out-of-range timestamp (Intl throws) or
    // an object where a string is expected, and stays bounded.
    const out: {
      ts: number | null;
      runAtMs: number | null;
      status: string | null;
      summary: string | null;
      error: string | null;
      durationMs: number | null;
      model: string | null;
    }[] = [];
    for (const e of raw) {
      if (typeof e !== "object" || e === null) continue;
      const r = e as Record<string, unknown>;
      out.push({
        ts: detailNum(r.ts),
        runAtMs: detailNum(r.runAtMs),
        status: detailStr(r.status, 40),
        summary: detailStr(r.summary, 800),
        error: detailStr(r.error, 400),
        durationMs: detailNum(r.durationMs),
        model: detailStr(r.model, 120),
      });
      if (out.length >= 50) break;
    }
    return out;
  },
});

/** Patch a job (name / enabled / schedule / message). Hermes: enabled only. */
export const updateCron = action({
  args: {
    instanceName: v.string(),
    jobId: v.string(),
    patch: cronPatchValidator,
  },
  handler: async (ctx, { instanceName, jobId, patch }): Promise<null> => {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) throw new ConvexError({ code: "invalid_patch" });
    const { target } = await requireOwnedCronJob(ctx as never, instanceName, jobId);
    if (!target.manageSupported) throw new ConvexError({ code: "unsupported" });
    if (target.kind === "hermes") {
      // No Hermes updates at all: the only candidate (enabled flip) would
      // make the paused job invisible to its own list API (see
      // cronCapabilitiesFor) — fail closed instead of stranding the job.
      throw new ConvexError({ code: "unsupported" });
    }
    // Worst case with a COLD operator connection: connect (~30s) + cron.get
    // (15s, message patches read the payload kind first) + cron.update (15s)
    // — a 50s abort would misreport a slow-but-successful update as failed.
    const { status, data } = await postBridge(
      "/cron-manage",
      { instanceName, op: "update", jobId, patch },
      75_000,
      target.bridgeUrl,
    );
    if (status === 501) throw new ConvexError({ code: "unsupported" });
    if (status !== 200) {
      const code =
        (data as { error?: { code?: string } } | null)?.error?.code ??
        `bridge_${status}`;
      throw new ConvexError({ code });
    }
    await ctx.runMutation(internal.agentFiles.auditFromAction, {
      action: "cron.update",
      resource: "cron",
      resourceId: `${instanceName}:${jobId}`,
    });
    return null;
  },
});

/** Delete a job (both providers). */
export const removeCron = action({
  args: { instanceName: v.string(), jobId: v.string() },
  handler: async (ctx, { instanceName, jobId }): Promise<null> => {
    const { target } = await requireOwnedCronJob(ctx as never, instanceName, jobId);
    if (!target.manageSupported) throw new ConvexError({ code: "unsupported" });
    const { status, data } = await postBridge(
      "/cron-manage",
      { instanceName, op: "remove", jobId },
      50_000,
      target.bridgeUrl,
    );
    if (status !== 200) {
      const code =
        (data as { error?: { code?: string } } | null)?.error?.code ??
        `bridge_${status}`;
      throw new ConvexError({ code });
    }
    await ctx.runMutation(internal.agentFiles.auditFromAction, {
      action: "cron.remove",
      resource: "cron",
      resourceId: `${instanceName}:${jobId}`,
    });
    return null;
  },
});

/** Trigger the job NOW (force run). OpenClaw only. */
export const runCronNow = action({
  args: { instanceName: v.string(), jobId: v.string() },
  handler: async (
    ctx,
    { instanceName, jobId },
  ): Promise<{ ran: boolean | null; runId: string | null; reason: string | null }> => {
    const { target } = await requireOwnedCronJob(ctx as never, instanceName, jobId);
    if (target.kind !== "openclaw" || !target.manageSupported) {
      throw new ConvexError({ code: "unsupported" });
    }
    // connect (~30s) + cron.run (30s) — keep network margin beyond 60s.
    const { status, data } = await postBridge(
      "/cron-manage",
      { instanceName, op: "run", jobId },
      75_000,
      target.bridgeUrl,
    );
    if (status !== 200) {
      const code =
        (data as { error?: { code?: string } } | null)?.error?.code ??
        `bridge_${status}`;
      throw new ConvexError({ code });
    }
    const run = (data as { run?: Record<string, unknown> } | null)?.run ?? {};
    const result = {
      ran: typeof run.ran === "boolean" ? run.ran : null,
      runId: typeof run.runId === "string" ? run.runId : null,
      reason: typeof run.reason === "string" ? run.reason : null,
    };
    // Audit only what actually happened: a business-level refusal (ran:false,
    // no runId) mutated nothing — logging it as an executed run would make
    // the audit trail contradict the UI's honest "did not start".
    if (result.ran === true || result.runId !== null) {
      await ctx.runMutation(internal.agentFiles.auditFromAction, {
        action: "cron.run",
        resource: "cron",
        resourceId: `${instanceName}:${jobId}`,
      });
    }
    return result;
  },
});
