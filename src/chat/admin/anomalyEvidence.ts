// Pure parsing of an anomaly row's drill-down evidence for the Anomalies tab — kept out
// of the component file so it is testable without rendering anything.

import type { DispatchErrorContext } from "@/lib/dispatchErrorInfo";

// Parse the drill-down evidence (root cause + failing-run anchor). Two detectors
// carry it: dispatch_failures (code + sample) and the lost-report alarm (sample
// only — a delivery has no dominant error code, and gating on one left its rows
// showing "—" with no way to reach the very runs the alarm exists to have
// investigated). Other kinds return empty -> "—".
const DRILLABLE_KINDS = new Set([
  "openclaw.dispatch_failures",
  "assistant.announce_errors",
]);
/** Per-cause classes whose evidence names its cause (`cause`) AND where it sits
 *  (`agents`, `providers`): the cause column shows the fix, filled with them. Only the
 *  causes whose remedy is a command for one agent are listed. */
const CAUSE_WITH_FIX_KINDS = new Set([
  "assistant.cause.provider_auth_revoked",
  "assistant.cause.provider_permission_denied",
  "assistant.cause.provider_auth_failed",
]);
export function parseDispatchEvidence(r: { kind: string; evidence?: string | null }): {
  dominantCode?: string;
  sampleCorrelationId?: string;
  context?: DispatchErrorContext;
} {
  const withFix = CAUSE_WITH_FIX_KINDS.has(r.kind);
  if ((!DRILLABLE_KINDS.has(r.kind) && !withFix) || !r.evidence) return {};
  try {
    const e = JSON.parse(r.evidence) as {
      dominantCode?: string;
      cause?: string;
      sampleCorrelationId?: string;
      agents?: unknown;
      providers?: unknown;
    };
    if (withFix) {
      // ONE agent and ONE provider fill the command; anything else keeps the
      // placeholders rather than print a command aimed at a guess.
      const agents = Array.isArray(e.agents) ? e.agents.filter((a) => typeof a === "string") : [];
      const providers = Array.isArray(e.providers)
        ? e.providers.filter((p) => typeof p === "string")
        : [];
      const agentRef = agents.length === 1 ? (agents[0] as string) : undefined;
      return {
        dominantCode: e.cause,
        sampleCorrelationId: e.sampleCorrelationId,
        context: {
          ...(agentRef !== undefined
            ? { agentId: agentRef.slice(agentRef.lastIndexOf("/") + 1) }
            : {}),
          ...(providers.length === 1 ? { provider: providers[0] as string } : {}),
        },
      };
    }
    return {
      dominantCode: e.dominantCode,
      sampleCorrelationId: e.sampleCorrelationId,
    };
  } catch {
    return {};
  }
}

