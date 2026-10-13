// `chat.gateway_pressure` at the trust boundary: WHETHER the pre-turn counters were
// measured, and WHY not — decided here from the body, never taken on the sender's word.
//
// The bridge (bridge/src/core/pressure-telemetry.ts) explains what the gateway provides
// at v2026.9.8: a gateway-initiated run gets no pre-send describe and no session snapshot,
// and no chat terminal carries usage. This side re-derives the verdict so an older or
// divergent bridge cannot store a silent null, and allowlists the cause vocabulary.

/** The three counters the trace reports. */
export const PRESSURE_COUNTERS = ["totalTokens", "contextTokens", "fillPct"] as const;
export type PressureCounter = (typeof PRESSURE_COUNTERS)[number];

/** Mirrors the bridge's PRESSURE_TELEMETRY_CAUSES; `unknown` = a bridge that gave none. */
export const PRESSURE_TELEMETRY_CAUSES: ReadonlySet<string> = new Set([
  "gateway_initiated_run",
  "presend_describe_unavailable",
  "describe_without_counters",
  "fill_undetermined",
  "unknown",
]);

const validCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Is this counter's value one the trace may store? */
export function validPressureCounter(name: PressureCounter, v: unknown): v is number {
  return name === "contextTokens" ? validCount(v) && v > 0 : validCount(v);
}

export type PressureVerdict =
  | { status: "present" }
  | { status: "partial" | "missing"; missing: PressureCounter[]; cause: string };

/**
 * The verdict on the counters a trace will store (`fillPct` as the ingest resolved it).
 * The cause: the bridge's, when allowlisted; otherwise what an older bridge's own labels
 * prove (`pressureSource` / `turnOrigin`); otherwise `unknown`. PURE.
 */
export function pressureVerdict(
  stored: Record<PressureCounter, unknown>,
  body: { telemetryCause?: unknown; pressureSource?: unknown; turnOrigin?: unknown },
): PressureVerdict {
  const missing = PRESSURE_COUNTERS.filter((name) => !validPressureCounter(name, stored[name]));
  if (missing.length === 0) return { status: "present" };
  const status = missing.length === PRESSURE_COUNTERS.length ? "missing" : "partial";
  const sent = typeof body.telemetryCause === "string" ? body.telemetryCause : null;
  const cause =
    sent !== null && PRESSURE_TELEMETRY_CAUSES.has(sent)
      ? sent
      : body.pressureSource === "absent"
        ? body.turnOrigin === "gateway_initiated"
          ? "gateway_initiated_run"
          : body.turnOrigin === "dispatch"
            ? "presend_describe_unavailable"
            : "unknown"
        : body.pressureSource === "presend_describe"
          ? missing.includes("totalTokens") || missing.includes("contextTokens")
            ? "describe_without_counters"
            : "fill_undetermined"
          : "unknown";
  return { status, missing, cause };
}

/** A gateway version the trace may carry: STRICTLY a release number (`2026.9.8`,
 *  `2026.7.2-beta.5`) — nothing a free string could smuggle in (codex phase 6 pass 2). */
export const GATEWAY_VERSION_RE = /^\d{1,4}\.\d{1,3}\.\d{1,3}(?:-(?:alpha|beta|rc)\.\d{1,3})?$/;
export function gatewayVersionLabel(v: unknown): string | null {
  return typeof v === "string" && GATEWAY_VERSION_RE.test(v) ? v : null;
}
