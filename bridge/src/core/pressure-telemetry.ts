// WHETHER a turn's `chat.gateway_pressure` counters were measured, and WHY not.
//
// The trace carries the session's context pressure BEFORE the turn (`totalTokens`,
// `contextTokens`, and the send path's `fillPct`), read from the pre-send
// `sessions.describe`. Production 2026-10-10 showed the cost of leaving a gap silent:
// 53 of 58 traces in six hours were all-null, alternating with complete ones in the same
// conversation, and nothing on them said why.
//
// What the gateway provides, read at v2026.9.8 (no supposition):
//   - NO chat terminal carries usage. `usage` is declared on the delta / final /
//     side-result frames (packages/gateway-protocol/src/schema/logs-chat.ts:406,414,483)
//     and nothing in the server-chat path fills it. The terminal kind — final, yielded,
//     aborted, error, final without a message — is therefore not what decides.
//   - The session's counters reach a CLIENT in two ways only: the `sessions.describe`
//     Atrium issues before its own `chat.send`, and the session snapshot the gateway
//     merges into TOOL events sent to the connection that issued `chat.send`
//     (registered at src/gateway/server-methods/chat-send-agent-dispatch.ts:429,449;
//     merged at src/gateway/server-chat.ts:1548-1562). A gateway-initiated run — a
//     sub-agent announce, a requester-settle wake, a task delivery — has neither: no
//     Atrium dispatch, no recipient. Its counters are absent BY CONSTRUCTION.
//   - A describe answers without `totalTokens` while the session has no fresh usage
//     (src/gateway/session-utils-row.ts:529,612-616).
//   - Every run reports its cumulative output tokens (`stream:"usage"`,
//     `data.outputTokens`, src/infra/agent-run-usage.ts:16-34): that integer rides a
//     missing reading so it still says something true. The run's announced model
//     (lifecycle `phase:"model"`) is free gateway text and is NOT carried.

/** How the send path's pre-send `sessions.describe` went: it answered with a session, it
 *  answered that there is none yet, or it FAILED (threw, timed out, or answered something
 *  unreadable). The send carries a reading even after a failure — its counters are then
 *  null for a reason that is not the session's (codex phase 6 pass 1). */
export type PresendDescribeOutcome = "answered" | "absent" | "failed";

/** The pre-turn counters, as the send path read them (null when there was no describe). */
export type PressureReading = {
  totalTokens: number | null;
  contextTokens: number | null;
  fillPct?: number | null;
  /** Absent on a reading built before the outcome was carried: read as answered. */
  describe?: PresendDescribeOutcome;
} | null;

/** The three counters the trace reports. */
export const PRESSURE_COUNTERS = ["totalTokens", "contextTokens", "fillPct"] as const;
export type PressureCounter = (typeof PRESSURE_COUNTERS)[number];

/** WHY a counter is missing — a closed list, mirrored in convex/lib/pressureTelemetry.ts. */
export const PRESSURE_TELEMETRY_CAUSES = [
  /** A run the gateway started itself: no pre-send describe, no tool-event snapshot. */
  "gateway_initiated_run",
  /** An Atrium dispatch whose pre-send describe did not happen or failed. */
  "presend_describe_unavailable",
  /** The describe answered, without counters (no fresh usage on the session yet). */
  "describe_without_counters",
  /** Counters present, but the send path could not derive a fill from them. */
  "fill_undetermined",
] as const;
export type PressureTelemetryCause = (typeof PRESSURE_TELEMETRY_CAUSES)[number];

export type PressureTelemetry =
  | { status: "present" }
  | {
      status: "partial" | "missing";
      missing: PressureCounter[];
      cause: PressureTelemetryCause;
    };

const validCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Is this counter's value one the trace may report? */
export function validCounter(name: PressureCounter, v: unknown): v is number {
  // A context window of 0 is not a window: the fill would divide by it.
  return name === "contextTokens" ? validCount(v) && v > 0 : validCount(v);
}

/** The verdict on one turn's reading. PURE. */
export function pressureTelemetry(
  reading: PressureReading,
  turnOrigin: "dispatch" | "gateway_initiated",
): PressureTelemetry {
  const value = (name: PressureCounter): unknown => (reading === null ? undefined : reading[name]);
  const missing = PRESSURE_COUNTERS.filter((name) => !validCounter(name, value(name)));
  if (missing.length === 0) return { status: "present" };
  const status = missing.length === PRESSURE_COUNTERS.length ? "missing" : "partial";
  const cause: PressureTelemetryCause =
    reading === null
      ? turnOrigin === "gateway_initiated"
        ? "gateway_initiated_run"
        : "presend_describe_unavailable"
      : reading.describe === "failed"
        ? "presend_describe_unavailable"
        : missing.includes("totalTokens") || missing.includes("contextTokens")
        ? "describe_without_counters"
        : "fill_undetermined";
  return { status, missing, cause };
}

/** What a missing reading carries besides its cause: NO gateway-supplied free string
 *  (codex phase 6 passes 2-3 — a run's announced model, even one a roster "declared", is
 *  free text and left the trace). Only a version matching a release-number pattern and
 *  an integer. The agent needs no field: the trace's `chatId` names the conversation, and
 *  so its agent, without a read on this path. */
export type MissingReadingContext = {
  gatewayVersion: string | null;
  runOutputTokens: number | null;
};

/**
 * The trace body with its telemetry made explicit. A PRESENT reading leaves the body
 * exactly as it was (0.97.0's shape, byte for byte — test/pressure-telemetry.test.ts).
 * Otherwise every counter that is not a valid number is LEFT OUT (never a silent null;
 * the fill's source goes with the fill), and the body says so: `telemetryStatus`, the
 * counters missing, the cause, and what the gateway did report for the run.
 */
export function withPressureTelemetry<B extends Record<string, unknown>>(
  body: B,
  reading: PressureReading,
  turnOrigin: "dispatch" | "gateway_initiated",
  ctx: MissingReadingContext,
): Record<string, unknown> {
  const verdict = pressureTelemetry(reading, turnOrigin);
  if (verdict.status === "present") return body;
  const out: Record<string, unknown> = { ...body };
  for (const name of verdict.missing) delete out[name];
  if (verdict.missing.includes("fillPct")) delete out.fillSource;
  return {
    ...out,
    telemetryStatus: verdict.status,
    telemetryMissing: verdict.missing,
    telemetryCause: verdict.cause,
    ...(ctx.gatewayVersion !== null ? { gatewayVersion: ctx.gatewayVersion } : {}),
    ...(ctx.runOutputTokens !== null ? { runOutputTokens: ctx.runOutputTokens } : {}),
  };
}
