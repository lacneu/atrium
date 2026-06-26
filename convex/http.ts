// HTTP router. @convex-dev/auth requires its OAuth callback / sign-in routes to
// be registered here. This is standard boilerplate; project-specific logic is
// in messages.ts / send.ts / stream.ts / bridge.ts.
//
// REQUIRES A LIVE DEPLOYMENT to serve these routes.

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { auth } from "./auth";
import { ingest } from "./bridge_ingest";
import { instanceCredentials } from "./bridge_credentials";
import { authenticateApiKey, principalHasPermission } from "./lib/apiAuth";
import { PERMISSIONS } from "./lib/rbac";
import { SYNC_STATUS_DETAIL } from "./instanceSync";
import { parseRange } from "./lib/timeRange";
import type { Filter } from "./lib/filters";
import { enrichTraceByCorrelation } from "./integrations/enrich";
import { langfuseConfig, opikConfig } from "./integrations/config";
import { assessChat } from "./lib/diagnose";
import { listSchemas, getSchema } from "./lib/schemaRegistry";
import { DEPLOYED_VERSION } from "./version";

const http = httpRouter();

// ---------------------------------------------------------------------------
// /api/v1 filter parsing (shared by the GET list routes).
//
// The advanced predicate DSL is NOT exposed over HTTP — only the structured
// params + `q` + the relative-time range. A bad/unparseable `from`/`to` token is
// simply DROPPED (parseRange never throws), mirroring the L3 limit-clamp: the
// route degrades silently and still returns 200, never a 400/500 on input.
// ---------------------------------------------------------------------------

/** Trim a query param to a non-empty string, or undefined. */
function strParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const t = raw.trim();
  return t === "" ? undefined : t;
}

/** Parse the shared `q` + `from`/`to` range into the base of a Filter. */
function baseFilter(url: URL, nowMs: number): Filter {
  const filter: Filter = {};
  const q = strParam(url, "q");
  if (q !== undefined) filter.q = q;
  const range = parseRange(
    { from: strParam(url, "from"), to: strParam(url, "to") },
    nowMs,
  );
  if (range.from !== undefined) filter.from = range.from;
  if (range.to !== undefined) filter.to = range.to;
  return filter;
}

/** Is the filter empty (no clauses set)? Then we pass `undefined` downstream. */
function emptyFilter(f: Filter): boolean {
  return Object.keys(f).length === 0;
}

// Registers /api/auth/* routes (OAuth start/callback, token exchange).
auth.addHttpRoutes(http);

// Bridge -> Convex ingest. The bridge worker POSTs normalized OpenClaw events
// here (Bearer BRIDGE_INGEST_SECRET) and the httpAction runs internal.stream.*.
// Served at the deployment `.site` origin.
http.route({
  path: "/bridge/ingest",
  method: "POST",
  handler: ingest,
});

// Bridge -> Convex credential fetch (step 3b). The bridge presents its PER-BRIDGE
// secret (Bearer) and receives ONLY its instance's decrypted gateway credentials.
// Served at the `.site` origin, like ingest.
http.route({
  path: "/bridge/credentials",
  method: "GET",
  handler: instanceCredentials,
});

// ===========================================================================
// /api/v1 — the key-authed observability API surface.
//
// D4: this surface can only CHECK permissions; roles/keys/service accounts are
// managed by admin-only Convex functions (apiKeys.ts), never here.
// ===========================================================================

/** Small JSON helper for the /api/v1 routes. SOC2 CC6.7: responses may carry
 *  non-PHI metadata that must never be cached by an intermediary/browser, and
 *  must not be MIME-sniffed. `no-store` + `nosniff` on every API response. */
function apiJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** PUBLIC, cacheable JSON for the published-contract routes (/api/v1/schemas). Unlike
 *  the observability `apiJson` (no-store), these carry no PHI/secrets and are versioned
 *  public docs, so a CDN/ReDoc/browser may cache them. Still nosniff. */
function publicJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Liveness probe. No auth, no PHI — just confirms the deployment serves the API.
http.route({
  path: "/api/v1/health",
  method: "GET",
  handler: httpAction(async () => {
    return apiJson({ ok: true, ts: Date.now() });
  }),
});

// Deployed-functions VERSION. PUBLIC (no auth, no PHI) — self-reports the version of
// the Convex functions bundled by the last `npx convex deploy`. The bridge/frontend
// ship their version in their Docker image, but the Convex functions are pushed by a
// SEPARATE manual step; this route makes that otherwise-invisible version checkable
// (`curl <convex-site>/api/v1/version`), so a forgotten `convex deploy` surfaces as a
// mismatch with the image versions instead of a silent failure. NO-STORE (apiJson, like
// /health): a deployment-verification check must never read a stale cached value right
// after a deploy, so it is deliberately not cacheable.
http.route({
  path: "/api/v1/version",
  method: "GET",
  handler: httpAction(async () => apiJson({ ok: true, version: DEPLOYED_VERSION })),
});

// Published CONTRACT schemas (provenance/v1 + future). PUBLIC (no auth): these are the
// machine-readable contracts an integration author validates against — served like
// public API docs (a future ReDoc surface lives next to them). No PHI, no secrets, and
// versioned/immutable, so the response is CACHEABLE (unlike the no-store observability
// routes). The MCP/CLI surface them too (they send a key; it is simply ignored here).
http.route({
  path: "/api/v1/schemas",
  method: "GET",
  handler: httpAction(async () => publicJson({ ok: true, schemas: listSchemas() })),
});

http.route({
  pathPrefix: "/api/v1/schemas/",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const id = decodeURIComponent(
      new URL(request.url).pathname.slice("/api/v1/schemas/".length),
    );
    const entry = getSchema(id);
    if (!entry) return publicJson({ ok: false, error: `unknown schema: ${id}` }, 404);
    return publicJson({
      ok: true,
      id: entry.id,
      version: entry.version,
      schema: entry.schema,
    });
  }),
});

// Recent trace events for a key-authed principal. The increment-1 proof route:
// authenticate -> require traces.read -> record an `api.call` trace -> return
// recent events. 401 on a bad/disabled/expired key, 403 when the role lacks
// traces.read.
http.route({
  path: "/api/v1/traces",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.TRACES_READ)) {
      // Attribute the denied attempt (no PHI) before returning 403.
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/traces",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: traces.read" },
        403,
      );
    }

    // Optional bounded paging (?limit=, ?kind=, ?correlationId=) + the shared
    // filter (?q=, ?from=, ?to=, ?status=, ?statusClass=, ?direction=,
    // ?principalType=, ?roleKey=). The internal query is called only AFTER the
    // permission check (httpActions cannot run the check itself). The fetch
    // helper clamps a negative/non-integer limit (L3) so it returns [] instead
    // of 500. M7: correlationId follows a chain. The advanced DSL is NOT exposed.
    const limitParam = url.searchParams.get("limit");
    const kindParam = strParam(url, "kind");
    const correlationId = strParam(url, "correlationId");
    const limit = limitParam ? Number(limitParam) : undefined;

    const filter = baseFilter(url, startedAt);
    if (kindParam !== undefined) filter.kind = kindParam;
    const statusParam = strParam(url, "status");
    const status = statusParam !== undefined ? Number(statusParam) : undefined;
    if (status !== undefined && Number.isFinite(status)) filter.status = status;
    const statusClass = strParam(url, "statusClass");
    if (statusClass === "2xx" || statusClass === "4xx" || statusClass === "5xx") {
      filter.statusClass = statusClass;
    }
    const direction = strParam(url, "direction");
    if (direction !== undefined) filter.direction = direction;
    const principalType = strParam(url, "principalType");
    if (principalType !== undefined) filter.principalType = principalType;
    const roleKey = strParam(url, "roleKey");
    if (roleKey !== undefined) filter.roleKey = roleKey;

    const events = await ctx.runQuery(
      internal.observability.recentEventsInternal,
      {
        limit: Number.isFinite(limit) ? limit : undefined,
        kind: kindParam,
        correlationId,
        filter: emptyFilter(filter) ? undefined : filter,
      },
    );

    // Record the successful call (metadata only -> redacted by the writer).
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/traces",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, events });
  }),
});

// Recent KPI rollups for a key-authed principal (increment 4). Mirrors the
// /api/v1/traces route exactly: authenticate -> require kpi.read -> record an
// `api.call` trace -> return recent rollups. 401 on a bad/disabled/expired key,
// 403 when the role lacks kpi.read.
http.route({
  path: "/api/v1/kpi",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.KPI_READ)) {
      // Attribute the denied attempt (no PHI) before returning 403.
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/kpi",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson({ ok: false, error: "missing permission: kpi.read" }, 403);
    }

    // Optional bounded filtering (?limit=, ?metric=, ?since=) + the shared time
    // range (?from=, ?to= as epoch-ms OR relative tokens). The internal query is
    // called only AFTER the permission check (httpActions cannot run it). KPI's
    // time field is the STRING hour bucket, so the internal query converts the
    // filter's epoch-ms from/to into buckets. `?metric=` stays the dedicated arg
    // (KPI's only quick filter). `?since=` is the existing bucket-string lower
    // bound. `?q=` has no search fields for KPI and is ignored downstream.
    const limitParam = url.searchParams.get("limit");
    const metricParam = strParam(url, "metric");
    const sinceParam = strParam(url, "since");
    const limit = limitParam ? Number(limitParam) : undefined;

    const filter = baseFilter(url, startedAt);
    const rollups = await ctx.runQuery(internal.kpi.kpisInternal, {
      limit: Number.isFinite(limit) ? limit : undefined,
      metric: metricParam,
      since: sinceParam,
      filter: emptyFilter(filter) ? undefined : filter,
    });

    // Record the successful call (metadata only -> redacted by the writer).
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/kpi",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, rollups });
  }),
});

// Integration status (Opik / Langfuse) for a key-authed principal — so an AI agent
// can discover whether each observability tool is wired + shipping is healthy
// before it asks for enriched trace data (the self-correction loop's first step).
// Mirrors /api/v1/traces. NON-SECRET: configured/enabled + the effective endpoints
// + shipping cursors (vendor/lastAt/failureCount/error code), NEVER a key. Gated on
// traces.read.
http.route({
  path: "/api/v1/integrations",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;
    if (!principalHasPermission(principal, PERMISSIONS.TRACES_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/integrations",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: traces.read" },
        403,
      );
    }
    const integrations = await ctx.runQuery(
      internal.integrations.status.statusInternal,
      {},
    );
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/integrations",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });
    return apiJson({ ok: true, integrations });
  }),
});

// Trace ENRICHMENT — fetch the SOC2-safe STRUCTURE of a chat's traces from the
// configured Opik/Langfuse (span names/types/lifecycle/timing/tree — NEVER
// input/output/text/metadata). The self-correction loop reads this to see the
// REAL OpenClaw message structure behind an anomaly without seeing regulated data.
// `?chatId=` (required) drives the Langfuse session query; `?correlationId=` +
// optional `?at=` (epoch ms) add the deterministic vendor-trace-id lookup (the
// Opik link). Gated on traces.read. Configs (incl. keys) stay in the action's env.
http.route({
  path: "/api/v1/trace-enrichment",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;
    if (!principalHasPermission(principal, PERMISSIONS.TRACES_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/trace-enrichment",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: traces.read" },
        403,
      );
    }
    const correlationId = strParam(url, "correlationId");
    if (!correlationId) {
      return apiJson({ ok: false, error: "correlationId is required" }, 400);
    }
    // `at` is the ORIGINAL ship-time trace timestamp (Opik's UUIDv7 bakes it in).
    // Pass it through ONLY when explicitly provided + finite — never default to now,
    // which would derive a wrong Opik id and silently return zero spans for a
    // historic trace. Absent => enrichTraceByCorrelation reports Opik needs_timestamp.
    const atParam = strParam(url, "at");
    const atNum =
      atParam !== undefined && Number.isFinite(Number(atParam))
        ? Number(atParam)
        : undefined;
    // Optional: enables the Langfuse content-free `sessionId` augmentation AND the
    // Opik thread-search (reconstructed gateway session key) so OpenClaw's OWN traces
    // for this chat surface — not just this turn's deterministic one.
    const chatId = strParam(url, "chatId");
    const openclawThreadId = chatId
      ? ((await ctx.runQuery(internal.bridge.openclawThreadForChat, {
          chatId,
        })) ?? undefined)
      : undefined;
    const ov = await ctx.runQuery(internal.integrations.ship.vendorOverrides, {});
    const enrichment = await enrichTraceByCorrelation({
      correlationId,
      chatId,
      openclawThreadId,
      atMs: atNum,
      langfuse: langfuseConfig(ov.langfuse),
      opik: opikConfig(ov.opik),
    });
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/trace-enrichment",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });
    return apiJson({ ok: true, enrichment });
  }),
});

// DIAGNOSE — one actionable assessment of a chat for the self-correction loop:
// aggregates the SOC2-safe chat-state + bridge availability and classifies the
// problem (stuck_stream / dispatch_error / attachment_problem / bridge_unavailable
// / bridge_degraded / healthy) with a `suggestedAction` and, when a safe corrective
// exists, a `suggestedTool` (e.g. reconcile_chat). Gated on traces.read. Read-only.
http.route({
  path: "/api/v1/diagnose",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;
    if (!principalHasPermission(principal, PERMISSIONS.TRACES_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/diagnose",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson({ ok: false, error: "missing permission: traces.read" }, 403);
    }
    const chatId = strParam(url, "chatId");
    if (!chatId) {
      return apiJson({ ok: false, error: "chatId is required" }, 400);
    }
    const chatState = await ctx.runQuery(internal.messages.chatStateInternal, {
      chatId,
    });
    const availability = await ctx.runQuery(
      internal.bridgeHealth.availabilityInternal,
      {},
    );
    const assessment = assessChat(chatState, availability);
    // SOC2 access log (CC6.1/CC7.2), mirroring /chat-state: WHO diagnosed WHICH chat
    // + the structural verdict (class/severity only — never content). Attributes the
    // read to the chat so a key enumerating chatIds is detectable.
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/diagnose",
      method: "GET",
      status: 200,
      chatId,
      latencyMs: Date.now() - startedAt,
      meta: JSON.stringify({
        class: assessment.class,
        severity: assessment.severity,
      }),
    });
    return apiJson({ ok: true, assessment, chatState, availability });
  }),
});

// RECONCILE-CHAT — the BOUNDED corrective the diagnose may recommend: flip this
// chat's stuck 'streaming' message(s) to error (preserving text), releasing the
// hung UI. Sensitive WRITE -> requires `selfheal`. POST { chatId }. Audited.
http.route({
  path: "/api/v1/reconcile-chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;
    if (!principalHasPermission(principal, PERMISSIONS.SELF_HEAL)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/reconcile-chat",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson({ ok: false, error: "missing permission: selfheal" }, 403);
    }
    let body: { chatId?: unknown };
    try {
      body = (await request.json()) as { chatId?: unknown };
    } catch {
      return apiJson({ ok: false, error: "invalid JSON body" }, 400);
    }
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    if (!chatId) {
      return apiJson({ ok: false, error: "chatId is required" }, 400);
    }
    const result = await ctx.runMutation(
      internal.stuckStreams.reconcileChatStuckStreams,
      { chatId, principalId: principal.id },
    );
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/reconcile-chat",
      method: "POST",
      status: result.ok ? 200 : 400,
      latencyMs: Date.now() - startedAt,
    });
    return apiJson({ ok: result.ok, reconciled: result.reconciled }, result.ok ? 200 : 400);
  }),
});

// Delivery-latency recorder control (convex/deliveryTiming.ts). Activation is a
// privileged WRITE -> `selfheal` (the agent's control permission); the report is
// read-only -> `traces.read`. Mirrors the /api/v1/traces auth + audit spine.
http.route({
  path: "/api/v1/delivery-record/start",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;
    if (!principalHasPermission(principal, PERMISSIONS.SELF_HEAL)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/delivery-record/start",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson({ ok: false, error: "missing permission: selfheal" }, 403);
    }
    const res = await ctx.runMutation(
      internal.deliveryTiming.startDeliveryRecordForAgent,
      { principalId: principal.id },
    );
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/delivery-record/start",
      method: "POST",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });
    return apiJson(
      { ok: true, sessionId: res.sessionId, autoStopAt: res.autoStopAt },
      200,
    );
  }),
});

http.route({
  path: "/api/v1/delivery-record/stop",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;
    if (!principalHasPermission(principal, PERMISSIONS.SELF_HEAL)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/delivery-record/stop",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson({ ok: false, error: "missing permission: selfheal" }, 403);
    }
    const res = await ctx.runMutation(
      internal.deliveryTiming.stopDeliveryRecordForAgent,
      {},
    );
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/delivery-record/stop",
      method: "POST",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });
    return apiJson({ ok: true, stopped: res.stopped }, 200);
  }),
});

http.route({
  path: "/api/v1/delivery-report",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;
    if (!principalHasPermission(principal, PERMISSIONS.TRACES_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/delivery-report",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: traces.read" },
        403,
      );
    }
    const report = await ctx.runQuery(
      internal.deliveryTiming.getDeliveryReportInternal,
      { sessionId: strParam(url, "sessionId") },
    );
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/delivery-report",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });
    return apiJson({ ok: true, report }, 200);
  }),
});

// ===========================================================================
// Increment 6 — anomalies + heartbeat + OpenClaw query.
//
// All four routes copy the /api/v1/traces spine EXACTLY: authenticate (401 on a
// bad/disabled/expired key) -> require a permission (403 + an attributed deny
// trace) -> record a successful `api.call` trace -> return. POST routes parse +
// validate the body AFTER the permission check (400 on a bad body) so an invalid
// payload can never reach an internal mutation's validator (which would 500).
// ===========================================================================

// Recent anomalies for a key-authed principal. Mirrors /api/v1/traces:
// authenticate -> require anomalies.read -> record an `api.call` trace -> return.
http.route({
  path: "/api/v1/anomalies",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.ANOMALIES_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/anomalies",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: anomalies.read" },
        403,
      );
    }

    // Optional bounded filtering (?status=, ?limit=, ?since=) + the shared
    // filter (?q=, ?from=, ?to=, ?severity=, ?source=, ?kind=). The internal
    // query runs only AFTER the permission check (httpActions cannot run it).
    // `?status=` maps to the lifecycle status (= anomalyStatus) and drives the
    // by_status index path; we also fold it into the filter (idempotent). L8:
    // `since` is a numeric ms watermark (keeps at >= since). L3: a negative/
    // non-integer ?limit is clamped by the fetch helper (returns [] not 500).
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam === "open" ||
      statusParam === "acknowledged" ||
      statusParam === "resolved"
        ? statusParam
        : undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const sinceParam = url.searchParams.get("since");
    const since = sinceParam !== null ? Number(sinceParam) : undefined;

    const filter = baseFilter(url, startedAt);
    if (status !== undefined) filter.anomalyStatus = status;
    const severity = strParam(url, "severity");
    if (severity !== undefined) filter.severity = severity;
    const source = strParam(url, "source");
    if (source !== undefined) filter.source = source;
    const kindParam = strParam(url, "kind");
    if (kindParam !== undefined) filter.kind = kindParam;

    const anomalies = await ctx.runQuery(internal.anomalies.anomaliesInternal, {
      status,
      limit: Number.isFinite(limit) ? limit : undefined,
      since: since !== undefined && Number.isFinite(since) ? since : undefined,
      filter: emptyFilter(filter) ? undefined : filter,
    });

    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/anomalies",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, anomalies });
  }),
});

// Report an anomaly OR a self-repair action taken (key-authed). Mirrors the
// /api/v1/traces spine: authenticate -> require anomalies.report -> validate
// body -> record an `api.call` trace -> insert the source:"agent" anomaly.
http.route({
  path: "/api/v1/anomalies",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.ANOMALIES_REPORT)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/anomalies",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: anomalies.report" },
        403,
      );
    }

    // Parse + validate the body AFTER the permission check so a bad payload can
    // never reach the internal mutation's validator (which would 500).
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiJson({ ok: false, error: "invalid JSON body" }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const kind = typeof b.kind === "string" ? b.kind : undefined;
    const severity =
      b.severity === "info" || b.severity === "warn" || b.severity === "critical"
        ? b.severity
        : undefined;
    const message = typeof b.message === "string" ? b.message : undefined;
    if (!kind || !severity || !message) {
      return apiJson(
        {
          ok: false,
          error:
            "body requires kind:string, severity:info|warn|critical, message:string",
        },
        400,
      );
    }
    const correlationId =
      typeof b.correlationId === "string" ? b.correlationId : undefined;
    // `evidence` must be a JSON STRING (D2: non-PHI). Accept a provided string by
    // parsing it back to an object (so we can fold in attribution), or take an
    // object directly; reject other types. Reporter attribution (the calling
    // service account's non-PHI id) is merged into `evidence.reportedBy` — NOT
    // into `resolvedBy`, which is reserved for resolution-time attribution.
    let evidenceObj: Record<string, unknown> = {};
    if (typeof b.evidence === "string") {
      try {
        const parsed = JSON.parse(b.evidence);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          evidenceObj = parsed as Record<string, unknown>;
        } else {
          evidenceObj = { value: parsed };
        }
      } catch {
        // Not JSON: keep the raw string under a stable key (still non-PHI bound).
        evidenceObj = { value: b.evidence };
      }
    } else if (
      b.evidence !== undefined &&
      b.evidence !== null &&
      typeof b.evidence === "object" &&
      !Array.isArray(b.evidence)
    ) {
      evidenceObj = b.evidence as Record<string, unknown>;
    } else if (b.evidence !== undefined && b.evidence !== null) {
      return apiJson({ ok: false, error: "evidence must be a JSON object/string" }, 400);
    }
    evidenceObj.reportedBy = principal.id;
    let evidence: string | undefined;
    try {
      evidence = JSON.stringify(evidenceObj);
    } catch {
      return apiJson({ ok: false, error: "evidence not serializable" }, 400);
    }

    const result = await ctx.runMutation(
      internal.anomalies.reportAnomalyInternal,
      {
        kind,
        severity,
        message,
        correlationId,
        evidence,
      },
    );

    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/anomalies",
      method: "POST",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, id: result.id });
  }),
});

// Resolve / acknowledge an anomaly (key-authed) — a self-repair surface so an
// OpenClaw agent can clear an anomaly it has handled, bounding the open set.
// Mirrors the /api/v1/traces spine: authenticate -> require anomalies.report ->
// validate body -> record an `api.call` trace -> resolve. The runMutation is
// wrapped in try/catch so a garbage anomalyId (which v.id() would reject -> 500)
// returns a 400 instead, mirroring the body-validation discipline.
http.route({
  path: "/api/v1/anomalies/resolve",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.ANOMALIES_REPORT)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/anomalies/resolve",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: anomalies.report" },
        403,
      );
    }

    // Parse + validate the body AFTER the permission check.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiJson({ ok: false, error: "invalid JSON body" }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const anomalyId =
      typeof b.anomalyId === "string" ? b.anomalyId : undefined;
    const status =
      b.status === "resolved" || b.status === "acknowledged"
        ? b.status
        : undefined;
    if (b.status !== undefined && status === undefined) {
      return apiJson(
        { ok: false, error: "status must be resolved|acknowledged" },
        400,
      );
    }
    if (!anomalyId) {
      return apiJson({ ok: false, error: "body requires anomalyId:string" }, 400);
    }

    // Resolve; a malformed id makes v.id() reject inside the mutation, which
    // would 500 — contain it and return 400 (the route never 500s on input).
    let result: { ok: boolean };
    try {
      result = await ctx.runMutation(internal.anomalies.resolveAnomalyInternal, {
        anomalyId: anomalyId as Id<"anomalies">,
        status,
        // Non-PHI resolution attribution: the calling service account's id.
        resolvedBy: principal.id,
      });
    } catch {
      return apiJson({ ok: false, error: "invalid anomalyId" }, 400);
    }

    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/anomalies/resolve",
      method: "POST",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: result.ok });
  }),
});

// Bridge version & compatibility summary (key-authed): "what does the bridge
// support, what are my instances running". Mirrors /api/v1/traces EXACTLY:
// authenticate -> require bridge.read -> record an `api.call` trace -> return.
// 401 on a bad/disabled/expired key, 403 when the role lacks bridge.read.
http.route({
  path: "/api/v1/compat",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.BRIDGE_READ)) {
      // Attribute the denied attempt (no PHI) before returning 403.
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/compat",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: bridge.read" },
        403,
      );
    }

    // The internal query is called only AFTER the permission check (httpActions
    // cannot run the check themselves). Pure summary of the singleton snapshot.
    const summary = await ctx.runQuery(internal.compat.compatInternal, {});

    // Record the successful call (metadata only -> redacted by the writer).
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/compat",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, ...summary });
  }),
});

// Per-instance bridge<->gateway health (key-authed). A CLEAR status view for an operator
// or an agent's self-supervision: is a bridge configured for the instance, available /
// degraded + why, gateway version + last error, agent-discovery freshness. Mirrors
// /api/v1/compat: authenticate -> require bridge.read -> record an api.call trace -> return.
http.route({
  path: "/api/v1/bridge-status",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;
    if (!principalHasPermission(principal, PERMISSIONS.BRIDGE_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/bridge-status",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: bridge.read" },
        403,
      );
    }
    const instances = await ctx.runQuery(
      internal.bridgeHealth.bridgeStatusInternal,
      {},
    );
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/bridge-status",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });
    return apiJson({ ok: true, instances });
  }),
});

// Force an instance sync (key-authed; selfheal = admin + the agent service-account role,
// NOT observer). The API/MCP twin of the admin "Synchroniser" button: poke the bridge
// (resolve + connect -> pairing) + pull the instance's agents NOW. Mirrors
// /api/v1/reconcile-chat (the other selfheal-gated bounded-corrective WRITE). Returns the
// SPECIFIC status + an English `detail` (the MCP consumer has no i18n) so an agent can act.
http.route({
  path: "/api/v1/instances/sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;
    if (!principalHasPermission(principal, PERMISSIONS.SELF_HEAL)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/instances/sync",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson({ ok: false, error: "missing permission: selfheal" }, 403);
    }
    // Instance NAME via ?instance= (API-friendly) or a JSON body { instance }.
    const url = new URL(request.url);
    let name = strParam(url, "instance");
    if (name === undefined) {
      try {
        const body = (await request.json()) as { instance?: unknown };
        if (typeof body.instance === "string") name = body.instance;
      } catch {
        /* no/invalid body — fall through to the required-arg check */
      }
    }
    if (!name) {
      return apiJson({ ok: false, error: "instance is required" }, 400);
    }
    // .first() (name not schema-unique); unknown name -> clean 404, never run on null.
    const instanceId = await ctx.runQuery(
      internal.instanceSync.instanceIdByName,
      { name },
    );
    if (instanceId === null) {
      return apiJson({ ok: false, error: `unknown instance: ${name}` }, 404);
    }
    const result = await ctx.runAction(
      internal.instanceSync.runInstanceSync,
      { instanceId },
    );
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/instances/sync",
      method: "POST",
      status: 200, // the API call + action ran; the sync outcome is in `status` below
      latencyMs: Date.now() - startedAt,
    });
    return apiJson({
      ok: true,
      status: result.status,
      agents: result.agents,
      detail: SYNC_STATUS_DETAIL[result.status],
    });
  }),
});

// Diagnostic chat-state inspector (key-authed). Lets an operator debug a chat
// from the terminal: per-message lifecycle (status/runId/age/partCount) — the
// signal that exposes a stuck-streaming turn (status "streaming" + large age =
// the bridge never relayed finalize). Mirrors /api/v1/traces EXACTLY:
// authenticate -> require traces.read -> record an `api.call` trace -> return.
// METADATA ONLY (no message text) — chatStateInternal returns lengths/counts.
http.route({
  path: "/api/v1/chat-state",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const url = new URL(request.url);

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.TRACES_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/chat-state",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: traces.read" },
        403,
      );
    }

    const chatId = strParam(url, "chatId");
    if (chatId === undefined) {
      return apiJson({ ok: false, error: "chatId required" }, 400);
    }
    const state = await ctx.runQuery(internal.messages.chatStateInternal, {
      chatId,
    });

    // SOC2 access log (CC6.1/CC7.2): WHO read WHICH chat + how much — non-PHI
    // counts only (detects a key scraping chatIds). No content in the trace.
    const auditMeta = state.ok
      ? JSON.stringify({
          messageCount: state.messageCount,
          stuckCount: state.stuckCount,
        })
      : JSON.stringify({ result: state.error });
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/chat-state",
      method: "GET",
      status: 200,
      chatId,
      latencyMs: Date.now() - startedAt,
      meta: auditMeta,
    });

    return apiJson(state);
  }),
});

// Heartbeat summary (key-authed) so an OpenClaw heartbeat learns whether
// anomalies appeared -> can self-repair. Mirrors /api/v1/traces:
// authenticate -> require anomalies.read -> record an `api.call` trace -> return.
http.route({
  path: "/api/v1/heartbeat",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.ANOMALIES_READ)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/heartbeat",
        method: "GET",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: anomalies.read" },
        403,
      );
    }

    const heartbeat = await ctx.runQuery(
      internal.anomalies.heartbeatInternal,
      {},
    );

    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/heartbeat",
      method: "GET",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    return apiJson({ ok: true, heartbeat });
  }),
});

// Query OpenClaw via the bridge (key-authed). Mirrors /api/v1/traces:
// authenticate -> require openclaw.query -> validate body -> record an
// `api.call` trace -> run the action. The trace is recorded status 200 (the
// request was authed + handled) even when the bridge is unconfigured/unreachable
// — the bridge outcome rides in the body ({ ok:false, reason }) so a no-op never
// feeds the API-error-ratio anomaly detector.
http.route({
  path: "/api/v1/openclaw/query",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();

    const authResult = await authenticateApiKey(ctx, request);
    if (!authResult.ok) {
      return apiJson({ ok: false, error: authResult.error }, authResult.status);
    }
    const { principal } = authResult;

    if (!principalHasPermission(principal, PERMISSIONS.OPENCLAW_QUERY)) {
      await ctx.runMutation(internal.observability.recordEvent, {
        kind: "api.call",
        direction: "inbound",
        principalType: "service",
        principalId: principal.id,
        roleKey: principal.roleKey,
        route: "/api/v1/openclaw/query",
        method: "POST",
        status: 403,
        latencyMs: Date.now() - startedAt,
      });
      return apiJson(
        { ok: false, error: "missing permission: openclaw.query" },
        403,
      );
    }

    // Parse + validate the body AFTER the permission check.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiJson({ ok: false, error: "invalid JSON body" }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const question = typeof b.question === "string" ? b.question : undefined;
    const payload = b.payload;
    if (question === undefined && payload === undefined) {
      return apiJson(
        { ok: false, error: "body requires question:string and/or payload" },
        400,
      );
    }

    // An httpAction CAN runAction. The action degrades gracefully (never throws)
    // when the bridge env is unset/unreachable -> { ok:false, reason }.
    const result = await ctx.runAction(internal.openclaw.queryOpenClaw, {
      question,
      payload,
    });

    // Record the call as handled (200) regardless of the bridge outcome (see the
    // route comment): a graceful bridge no-op must not inflate the error ratio.
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "api.call",
      direction: "inbound",
      principalType: "service",
      principalId: principal.id,
      roleKey: principal.roleKey,
      route: "/api/v1/openclaw/query",
      method: "POST",
      status: 200,
      latencyMs: Date.now() - startedAt,
    });

    // 200 envelope; the bridge result (including ok:false/reason) rides inside.
    return apiJson(result);
  }),
});

export default http;
