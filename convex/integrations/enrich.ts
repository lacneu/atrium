// Trace ENRICHMENT — the inbound counterpart of ship.ts.
//
// Given a turn's `correlationId`, fetch the matching trace from the configured
// Opik / Langfuse and return a SOC2-safe STRUCTURAL projection of the spans: the
// shape of what OpenClaw actually did (span names/types, lifecycle status, timing,
// the parent tree) — NEVER input/output/message text/metadata. This lets an AI
// agent (the #7 self-correction loop) see the REAL message structure to diagnose
// an anomaly, WITHOUT ever seeing regulated data.
//
// TWO SOC2 layers, defence in depth:
//   1. We REQUEST structure only — Langfuse `fields=core,basic,time` (no `io`, no
//      `metadata`); Opik spans with input/output dropped — so the vendor never even
//      sends the PHI over the wire.
//   2. We PROJECT client-side to an explicit allowlist of structural fields — so
//      even if a vendor returns more, only the allowlisted shape ever leaves here.
//
// Correlation, two complementary handles:
//   a. The vendor trace id is DERIVED from our `correlationId` with the SAME seed
//      ship.ts uses (sha256 "lf:trace:"/"opik:trace:"), so the trace Atrium itself
//      shipped for THIS turn is found deterministically.
//   b. Langfuse ALSO list-searches by `sessionId = chatId` (Atrium sets
//      `langfuse.session.id = chatId` on every shipped span) to surface the OTHER
//      traces scoped to the same chat — including any an OpenClaw plugin emits with
//      the same session id (the user's "find the real OpenClaw structure" goal).
//      SOC2: that list is requested with `fields=core` ONLY — the Langfuse trace
//      list splits `io` (input/output/metadata) into a separate field group, so
//      `core` returns NO content; we then project to the trace `id` and discard the
//      rest, and the per-trace span fetch below is itself field-limited. Two layers,
//      no PHI on the wire. (Opik keeps the deterministic id only: its thread/trace
//      list has no equivalent guaranteed content-free projection, so we don't
//      list-search it — documented asymmetry, not an oversight.)

import { LangfuseConfig, OpikConfig } from "./config";
import { sha256Hex, uuidV7FromHex } from "./shared";

/** One span/observation, SOC2-safe: structure + lifecycle + timing only. */
export type SpanNode = {
  id: string;
  /** Operation name (the span name = what it did, e.g. "llm-call", "tool:search"). */
  name: string;
  /** Vendor observation/span type (GENERATION | SPAN | EVENT | tool | llm | ...). */
  type: string | null;
  /** Lifecycle level/status (DEFAULT | WARNING | ERROR | ...). */
  level: string | null;
  startMs: number | null;
  durationMs: number | null;
  /** Parent span id (for tree reconstruction) — never content. */
  parentId: string | null;
};

/** One trace's SOC2-safe structure. */
export type TraceStructure = {
  vendor: "langfuse" | "opik";
  traceId: string;
  spanCount: number;
  /** Count of spans by type — a quick "shape" readout. */
  typeCounts: Record<string, number>;
  spans: SpanNode[];
};

export type VendorEnrichment = {
  vendor: "langfuse" | "opik";
  configured: boolean;
  enabled: boolean;
  ok: boolean;
  /** Non-secret reason when not ok (unconfigured | disabled | http_<n> | network_error). */
  reason: string | null;
  traces: TraceStructure[];
};

export type Enrichment = {
  /** At least one vendor is configured + enabled. */
  available: boolean;
  vendors: VendorEnrichment[];
};

export type FetchImpl = typeof fetch;

const MAX_TRACES = 10; // bound per vendor (a chat session can have many)
const MAX_SPANS = 500; // bound per trace

// ---- deterministic vendor trace-id derivation (mirrors ship.ts seeds) ----

export async function langfuseTraceIdFor(correlationId: string): Promise<string> {
  return (await sha256Hex(`lf:trace:${correlationId}`)).slice(0, 32);
}

export async function opikTraceIdFor(correlationId: string, atMs: number): Promise<string> {
  return uuidV7FromHex(await sha256Hex(`opik:trace:${correlationId}`), atMs);
}

// ---- SOC2 projection (the load-bearing allowlist) ----

const str = (x: unknown): string | null => (typeof x === "string" && x.length > 0 ? x : null);
const isoToMs = (x: unknown): number | null => {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x !== "string") return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
};

/** Project ONE raw Langfuse observation -> SpanNode (allowlist; drops io/metadata). */
export function projectLangfuseObservation(raw: unknown): SpanNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (id === null) return null;
  const start = isoToMs(o.startTime);
  const end = isoToMs(o.endTime);
  return {
    id,
    name: str(o.name) ?? "(unnamed)",
    type: str(o.type),
    level: str(o.level),
    startMs: start,
    durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
    parentId: str(o.parentObservationId),
  };
}

/** Project ONE raw Opik span -> SpanNode (allowlist; drops input/output/metadata). */
export function projectOpikSpan(raw: unknown): SpanNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  if (id === null) return null;
  const start = isoToMs(o.start_time);
  const end = isoToMs(o.end_time);
  return {
    id,
    name: str(o.name) ?? "(unnamed)",
    type: str(o.type),
    level: null, // Opik spans carry no level; status lives elsewhere (kept structural)
    startMs: start,
    durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
    parentId: str(o.parent_span_id),
  };
}

function summarize(
  vendor: "langfuse" | "opik",
  traceId: string,
  spans: SpanNode[],
): TraceStructure {
  const typeCounts: Record<string, number> = {};
  for (const s of spans) {
    const k = s.type ?? "untyped";
    typeCounts[k] = (typeCounts[k] ?? 0) + 1;
  }
  return { vendor, traceId, spanCount: spans.length, typeCounts, spans };
}

// ---- Langfuse fetchers ----

function langfuseAuth(config: LangfuseConfig): string {
  const raw = `${config.publicKey}:${config.secretKey}`;
  return typeof btoa === "function" ? btoa(raw) : Buffer.from(raw, "utf-8").toString("base64");
}

/** SOC2-safe: requests ONLY structural field groups (no `io`, no `metadata`). */
async function langfuseObservations(
  config: LangfuseConfig,
  traceId: string,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; spans: SpanNode[] } | { ok: false; reason: string }> {
  const url =
    `${config.host}/api/public/v2/observations` +
    `?traceId=${encodeURIComponent(traceId)}&fields=core,basic,time&limit=${MAX_SPANS}`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Basic ${langfuseAuth(config)}` },
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = (await res.json()) as { data?: unknown };
    const data = Array.isArray(body.data) ? body.data : [];
    const spans = data
      .map(projectLangfuseObservation)
      .filter((s): s is SpanNode => s !== null);
    return { ok: true, spans };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

/**
 * Trace ids scoped to a chat session, so an OpenClaw-emitted trace sharing the same
 * session id is surfaced too. SOC2: `fields=core` excludes the `io` group (input/
 * output/metadata) AT THE VENDOR, and we project to the `id` only — no content on
 * the wire, none retained. Degrades to [] on any error (best-effort augmentation).
 */
async function langfuseTraceIdsForSession(
  config: LangfuseConfig,
  sessionId: string,
  fetchImpl: FetchImpl,
): Promise<string[]> {
  const url =
    `${config.host}/api/public/traces` +
    `?sessionId=${encodeURIComponent(sessionId)}&fields=core&limit=${MAX_TRACES}`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Basic ${langfuseAuth(config)}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: unknown };
    const data = Array.isArray(body.data) ? body.data : [];
    return data
      .map((t) =>
        typeof t === "object" && t !== null
          ? str((t as Record<string, unknown>).id)
          : null,
      )
      .filter((id): id is string => id !== null);
  } catch {
    return [];
  }
}

// ---- Opik fetchers ----

function opikHeaders(config: OpikConfig): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
  if (config.workspace.length > 0) h["Comet-Workspace"] = config.workspace;
  return h;
}

// SOC2: input/output/metadata are excluded at the vendor + projected away.
const OPIK_EXCLUDE = encodeURIComponent(
  JSON.stringify(["input", "output", "metadata"]),
);

/** SOC2-safe: drops input/output at the vendor (`exclude`) AND client-side. The
 *  `projectName` is explicit because Atrium's own traces and OpenClaw's live in
 *  DIFFERENT projects. */
async function opikSpans(
  config: OpikConfig,
  traceId: string,
  projectName: string,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; spans: SpanNode[] } | { ok: false; reason: string }> {
  // `project_name` is REQUIRED by the Opik read API — `GET /v1/private/spans`
  // 400s with "Either 'project_name' or 'project_id' query params must be
  // provided" otherwise (caught by the live probe 2026-06-18).
  const url =
    `${config.baseUrl}/v1/private/spans` +
    `?project_name=${encodeURIComponent(projectName)}` +
    `&trace_id=${encodeURIComponent(traceId)}&size=${MAX_SPANS}&exclude=${OPIK_EXCLUDE}`;
  try {
    const res = await fetchImpl(url, { headers: opikHeaders(config) });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = (await res.json()) as { content?: unknown; data?: unknown };
    const rows = Array.isArray(body.content)
      ? body.content
      : Array.isArray(body.data)
        ? body.data
        : [];
    const spans = rows.map(projectOpikSpan).filter((s): s is SpanNode => s !== null);
    return { ok: true, spans };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

/** Trace ids OpenClaw emitted for a chat, found by `thread_id` (== the gateway
 *  session key Atrium reconstructs). SOC2: `exclude` drops io at the vendor and we
 *  project to the `id` only. Returns {ok:false,reason} so the caller can surface a
 *  non-secret reason; [] just means no OpenClaw trace for this chat yet. */
async function opikTraceIdsForThread(
  config: OpikConfig,
  threadId: string,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
  const filters = encodeURIComponent(
    JSON.stringify([{ field: "thread_id", operator: "=", value: threadId }]),
  );
  const url =
    `${config.baseUrl}/v1/private/traces` +
    `?project_name=${encodeURIComponent(config.openclawProjectName)}` +
    `&size=${MAX_TRACES}&filters=${filters}&exclude=${OPIK_EXCLUDE}`;
  try {
    const res = await fetchImpl(url, { headers: opikHeaders(config) });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = (await res.json()) as { content?: unknown; data?: unknown };
    const rows = Array.isArray(body.content)
      ? body.content
      : Array.isArray(body.data)
        ? body.data
        : [];
    const ids = rows
      .map((t) =>
        typeof t === "object" && t !== null
          ? str((t as Record<string, unknown>).id)
          : null,
      )
      .filter((id): id is string => id !== null);
    return { ok: true, ids };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// ---- orchestration ----

async function enrichLangfuse(
  config: LangfuseConfig,
  opts: { correlationId: string; chatId?: string },
  fetchImpl: FetchImpl,
): Promise<VendorEnrichment> {
  const base = { vendor: "langfuse" as const, configured: config.configured, enabled: config.enabled };
  if (!config.configured) return { ...base, ok: false, reason: "unconfigured", traces: [] };
  if (!config.enabled) return { ...base, ok: false, reason: "disabled", traces: [] };

  // (a) the deterministic correlationId-derived trace (THIS turn), PLUS
  // (b) every trace scoped to the chat session (other turns + any OpenClaw-emitted
  //     trace on the same session id) — found via the `fields=core` list (content-
  //     free, see langfuseTraceIdsForSession). Dedup; the span fetch below is itself
  //     field-limited, so no PHI ever reaches this action.
  const ids = new Set<string>([await langfuseTraceIdFor(opts.correlationId)]);
  if (opts.chatId !== undefined) {
    for (const id of await langfuseTraceIdsForSession(config, opts.chatId, fetchImpl)) {
      ids.add(id);
    }
  }

  const traces: TraceStructure[] = [];
  let lastReason: string | null = null;
  for (const traceId of [...ids].slice(0, MAX_TRACES)) {
    const r = await langfuseObservations(config, traceId, fetchImpl);
    if (r.ok) {
      if (r.spans.length > 0) traces.push(summarize("langfuse", traceId, r.spans));
    } else {
      lastReason = r.reason;
    }
  }
  return { ...base, ok: lastReason === null || traces.length > 0, reason: traces.length > 0 ? null : lastReason, traces };
}

async function enrichOpik(
  config: OpikConfig,
  opts: { correlationId: string; atMs?: number; openclawThreadId?: string },
  fetchImpl: FetchImpl,
): Promise<VendorEnrichment> {
  const base = { vendor: "opik" as const, configured: config.configured, enabled: config.enabled };
  if (!config.configured) return { ...base, ok: false, reason: "unconfigured", traces: [] };
  if (!config.enabled) return { ...base, ok: false, reason: "disabled", traces: [] };

  // Two correlation handles, each reading its OWN project:
  //   (a) Atrium's OWN trace — deterministic UUIDv7 from (correlationId, at), in
  //       `projectName`. Its id bakes the ORIGINAL ship `at`; without it the id can't
  //       match, so we DON'T fabricate `now` — the Atrium leg just needs `at`.
  //   (b) OpenClaw's OWN traces — found by `thread_id` (the reconstructed gateway
  //       session key) in the SEPARATE `openclawProjectName`. This is where the rich
  //       span tree lives (Atrium's own traces carry no child spans).
  const targets: Array<{ traceId: string; project: string }> = [];
  let reason: string | null = null;

  if (opts.atMs !== undefined) {
    targets.push({
      traceId: await opikTraceIdFor(opts.correlationId, opts.atMs),
      project: config.projectName,
    });
  } else if (!opts.openclawThreadId || config.openclawProjectName.length === 0) {
    // No `at` AND no OpenClaw thread path available -> the only handle (deterministic
    // Atrium id) is unusable. Say so instead of silently returning empty.
    return { ...base, ok: false, reason: "needs_timestamp", traces: [] };
  }

  if (opts.openclawThreadId && config.openclawProjectName.length > 0) {
    const r = await opikTraceIdsForThread(config, opts.openclawThreadId, fetchImpl);
    if (r.ok) {
      for (const id of r.ids) {
        targets.push({ traceId: id, project: config.openclawProjectName });
      }
    } else {
      reason = r.reason;
    }
  }

  // Dedup by (traceId, project) and fetch each leg's spans from its OWN project.
  const seen = new Set<string>();
  const traces: TraceStructure[] = [];
  for (const t of targets.slice(0, MAX_TRACES)) {
    const key = JSON.stringify([t.project, t.traceId]);
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await opikSpans(config, t.traceId, t.project, fetchImpl);
    if (r.ok) {
      if (r.spans.length > 0) traces.push(summarize("opik", t.traceId, r.spans));
    } else {
      reason = r.reason;
    }
  }
  return { ...base, ok: reason === null || traces.length > 0, reason: traces.length > 0 ? null : reason, traces };
}

/**
 * Fetch + project the SOC2-safe trace structure for ONE turn, keyed by its
 * `correlationId` (the deterministic link to the vendor trace). Pure over its
 * inputs (configs + injected fetch) -> unit-testable.
 */
export async function enrichTraceByCorrelation(opts: {
  correlationId: string;
  /** The chat id. Enables the Langfuse `sessionId` augmentation (content-free
   *  `fields=core` list) so traces OTHER than this turn's — incl. OpenClaw-emitted
   *  ones on the same session — are surfaced. Omit for the deterministic id only. */
  chatId?: string;
  /** The reconstructed OpenClaw `thread_id` (== gateway session key, see
   *  lib/openclawThread). Enables the Opik thread-search in `openclawProjectName`
   *  so OpenClaw's OWN rich span tree for this chat is surfaced. Omit to skip it. */
  openclawThreadId?: string;
  /** The original ship-time trace timestamp. REQUIRED for the Opik Atrium-own leg
   *  (its UUIDv7 id bakes it in); Langfuse + the Opik thread-search ignore it. */
  atMs?: number;
  langfuse: LangfuseConfig;
  opik: OpikConfig;
  fetchImpl?: FetchImpl;
}): Promise<Enrichment> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const vendors = await Promise.all([
    enrichLangfuse(opts.langfuse, opts, fetchImpl),
    enrichOpik(opts.opik, opts, fetchImpl),
  ]);
  const available = vendors.some((v) => v.configured && v.enabled);
  return { available, vendors };
}
