// Per-tab search-param schemas for the filtered admin routes (TanStack Router
// `validateSearch`). Each schema is a thin (de)serializer over the existing,
// already-tested filter primitives in `src/chat/admin/filters/types.ts` — it
// SHAPES + GUARDS the URL search record; it does NOT re-derive coercion.
//
// Two load-bearing rules baked in here (see docs/ROUTING_RESEARCH.md §3.4):
//
//  1. TIME RANGE IS STORED AS TOKENS, NEVER RESOLVED EPOCHS. `from`/`to` carry
//     a relative token ("now-30d"/"now") OR an absolute epoch-ms number-string.
//     The component decodes (`decodeRange`) to a `TimeRange`, then resolves to
//     live `{from,to}` ms at component level via `useResolvedRange` (30s tick +
//     minute snap). Putting resolved epochs in the URL would re-key the Convex
//     subscription every 30s → history spam + loading flicker.
//
//  2. EVERY FIELD DEGRADES SAFELY. `validateSearch` MUST be total: a throw
//     becomes a router error boundary, not a default. So every field is
//     `.optional()` / `.default()` / `.catch()` — a malformed/missing param
//     falls to a safe default in ONE place, never crashes the route.
//
// `adv` (advanced predicates) is carried as ONE url-safe JSON param. The schema
// only validates it is an optional string; the component parses + validates +
// drops malformed rows (`parseAdv` below) — keeping the schema total and the
// per-row coercion next to the typed `Predicate`.

import { z } from "zod";
import type { Predicate, TimeRange } from "@/chat/admin/filters/types";

// Op tokens accepted in an advanced predicate (mirrors the backend `Op`).
const OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte"] as const;
type OpToken = (typeof OPS)[number];

// Trace window sizes (top-level `limit` query arg — NOT inside `filter`).
const LIMIT_OPTIONS = [50, 100, 200, 500] as const;
type LimitValue = (typeof LIMIT_OPTIONS)[number];

// The shared default relative window for the time-ranged tabs (traces/audit/
// anomalies). Wide (30d) so older/seeded rows surface; re-resolves to NOW.
export const DEFAULT_FROM = "now-30d";
export const DEFAULT_TO = "now";

// KPI defaults to a tighter live window (mirrors KpiTab's previous default).
export const KPI_DEFAULT_FROM = "now-24h";

/**
 * Decode the URL `from`/`to` token pair into a `TimeRange`. A pair of
 * finite-number strings is an ABSOLUTE range (pinned epoch ms); anything else
 * is a RELATIVE range (Grafana tokens that re-resolve to "now" on load). Pure
 * + total: unparseable input falls back to the supplied relative defaults.
 */
export function decodeRange(
  from: string | undefined,
  to: string | undefined,
  defaultFrom: string = DEFAULT_FROM,
  defaultTo: string = DEFAULT_TO,
): TimeRange {
  const f = from ?? defaultFrom;
  const t = to ?? defaultTo;
  const fn = Number(f);
  const tn = Number(t);
  // Both numeric → absolute epoch-ms range. (Empty string coerces to 0, which
  // is not what we want, so guard against empty explicitly.)
  if (f !== "" && t !== "" && Number.isFinite(fn) && Number.isFinite(tn)) {
    return { kind: "absolute", from: fn, to: tn };
  }
  return { kind: "relative", from: f, to: t };
}

/**
 * Encode a `TimeRange` back to the URL token pair. A relative range stores its
 * tokens verbatim; an absolute range stores epoch-ms as number-strings. Inverse
 * of `decodeRange`.
 */
export function encodeRange(range: TimeRange): { from: string; to: string } {
  if (range.kind === "absolute") {
    return { from: String(range.from), to: String(range.to) };
  }
  return { from: range.from, to: range.to };
}

/**
 * Encode a `Predicate[]` as one url-safe JSON param (or `undefined` when empty,
 * so an empty advanced filter stays out of the URL). Inverse of `parseAdv`.
 */
export function encodeAdv(predicates: Predicate[]): string | undefined {
  if (predicates.length === 0) return undefined;
  return JSON.stringify(predicates);
}

/**
 * Parse the URL `adv` JSON param back into a validated `Predicate[]`. Robust by
 * construction: anything that is not a well-formed predicate row is DROPPED
 * (never throws, never crashes the route). The value is already JSON-typed, so
 * we validate `typeof value ∈ {string,number,boolean}` and `op ∈ Op` directly —
 * we do NOT route it through `coercePredicateValue` (which expects a raw string
 * and would crash on a number).
 */
export function parseAdv(adv: string | undefined): Predicate[] {
  if (!adv) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(adv);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Predicate[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const field = r.field;
    const op = r.op;
    const value = r.value;
    if (typeof field !== "string" || field === "") continue;
    if (typeof op !== "string" || !OPS.includes(op as OpToken)) continue;
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }
    out.push({ field, op: op as OpToken, value });
  }
  return out;
}

// --- Shared field builders -------------------------------------------------

// Free-text search box. Always optional; empty/missing → no `q` filter.
const q = z.string().optional();

// A relative-or-absolute time token. We keep it loose (any string) because the
// real validation/normalization happens in `decodeRange` — a token the picker
// never produces still degrades to a safe relative range there.
const timeToken = z.string().optional();

// The advanced-predicate JSON blob — validated structurally by `parseAdv`, so
// the schema only guards "optional string".
const adv = z.string().optional();

// A quick-select filter value: an optional string. `.catch(undefined)` keeps
// the field total even if a non-string sneaks in via a hand-edited URL.
const optionalToken = z.string().optional().catch(undefined);

// --- Per-tab schemas (one per FILTERED route) ------------------------------
//
// Each schema is `validateSearch`'d on its route. `useSearch()` then returns
// exactly that tab's typed subset. URL keys match the §3.4 table verbatim.

export const tracesSearchSchema = z.object({
  q,
  // Which sub-tool is open: latency monitoring vs the activity-trace explorer.
  // A real search param (not component state) so each sub-tab is a navigable,
  // shareable URL.
  section: z.enum(["latency", "events"]).default("events").catch("events"),
  kind: z.string().default("all").catch("all"),
  limit: z
    .coerce
    .number()
    .pipe(
      z.union([
        z.literal(LIMIT_OPTIONS[0]),
        z.literal(LIMIT_OPTIONS[1]),
        z.literal(LIMIT_OPTIONS[2]),
        z.literal(LIMIT_OPTIONS[3]),
      ]),
    )
    .catch(100 as LimitValue),
  statusClass: z.enum(["2xx", "4xx", "5xx"]).optional().catch(undefined),
  principalType: z.enum(["user", "service", "system"]).optional().catch(undefined),
  direction: z.enum(["inbound", "outbound", "internal"]).optional().catch(undefined),
  roleKey: optionalToken,
  from: timeToken,
  to: timeToken,
  adv,
});
export type TracesSearch = z.infer<typeof tracesSearchSchema>;

export const auditSearchSchema = z.object({
  q,
  action: optionalToken,
  // "yes" | "no" toggle (mapped to a bool query arg by the component).
  impersonated: z.enum(["yes", "no"]).optional().catch(undefined),
  resource: optionalToken,
  from: timeToken,
  to: timeToken,
  adv,
});
export type AuditSearch = z.infer<typeof auditSearchSchema>;

export const anomaliesSearchSchema = z.object({
  q,
  // The URL `status` key maps to the backend `anomalyStatus` arg. "all" is an
  // explicit token (→ undefined arg) so the default open-only view is
  // preserved AND degrades safely on garbage.
  status: z
    .enum(["open", "acknowledged", "resolved", "all"])
    .default("open")
    .catch("open"),
  severity: z.enum(["info", "warn", "critical"]).optional().catch(undefined),
  kind: optionalToken,
  from: timeToken,
  to: timeToken,
});
export type AnomaliesSearch = z.infer<typeof anomaliesSearchSchema>;

export const kpiSearchSchema = z.object({
  from: timeToken,
  to: timeToken,
});
export type KpiSearch = z.infer<typeof kpiSearchSchema>;

export const serviceAccountsSearchSchema = z.object({
  q,
  // active | disabled (mapped to the `disabled` bool by the component).
  status: z.enum(["active", "disabled"]).optional().catch(undefined),
});
export type ServiceAccountsSearch = z.infer<typeof serviceAccountsSearchSchema>;

export const usersSearchSchema = z.object({
  q,
  role: optionalToken,
});
export type UsersSearch = z.infer<typeof usersSearchSchema>;

export const groupsSearchSchema = z.object({
  q,
  mode: z.enum(["per-user", "shared"]).optional().catch(undefined),
});
export type GroupsSearch = z.infer<typeof groupsSearchSchema>;

/** /settings/voice — the voice tab's sub-tabs (read-aloud / dictation / talk),
 *  each a navigable URL. */
export const voiceSearchSchema = z.object({
  section: z
    .enum(["readaloud", "dictation", "talk"])
    .default("readaloud")
    .catch("readaloud"),
});
export type VoiceSearch = z.infer<typeof voiceSearchSchema>;

/** /settings/bridge — one navigable sub-tab per provider card. Free-form
 *  string (bounded length): the provider set is data-driven (a deployment may
 *  serve any subset); the tab falls back to its first bucket when the URL
 *  names an absent provider. */
export const bridgeSearchSchema = z.object({
  section: z.string().max(32).default("openclaw").catch("openclaw"),
});

