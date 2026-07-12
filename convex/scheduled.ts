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
            error: "bridge_unreachable",
            jobs: [],
          };
        }
      }),
    );
  },
});
