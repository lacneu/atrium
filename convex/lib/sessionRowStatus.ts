// A sub-agent's status, as the gateway's SESSION ROW states it (0.101.4).
//
// The Control UI reconstructs nothing: it reads the child's session row (`sessions.list`
// / `sessions.describe`, refreshed on `sessions.changed`) and renders its `status` with
// one badge rule. This file is that rule, ported line for line, plus the mapping onto
// Atrium's four lifecycle states (which the busy hold, the drain and the counters key on).
//
// Upstream, pinned at v2026.9.33:
//   - the row's `status` vocabulary: packages/gateway-protocol/src/schema/sessions-row.ts:28-36
//     (`SessionRunStatusSchema`), `hasActiveRun` beside it;
//   - "is a run active": src/shared/session-run-state.ts:8-16 (`isSessionRunActive`);
//   - the badge: ui/src/pages/sessions/session-status.ts:17-37 (`renderSessionStatusBadge`):
//     label (queued / live / idle / the status / unknown) and kind (warn / ok / muted /
//     danger);
//   - which run the row speaks for is decided by the GATEWAY (`getDisplaySubagentRun`,
//     src/agents/subagents/registry/subagent-registry-queries.ts:285-303, applied in
//     src/gateway/session-utils-display.ts:148-162): Atrium never re-decides it.
//   - the ordering clock: the row's `snapshotAt`, "Gateway sampling time"
//     (sessions-row.ts:139-140), stamped on every presented row
//     (src/gateway/session-utils-row.ts:595-597) and the clock the Control UI orders row
//     observations by (ui/src/lib/sessions/session-row-provenance.ts:46-55). `updatedAt`
//     is not: the captured timeout pair carries the SAME `updatedAt` on `done` and on the
//     later `timeout` (bridge/test/fixtures/subagent-status-timeout-2026.9.33.json).

/** The row's run status (sessions-row.ts:28-36). */
export const SESSION_RUN_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "interrupted",
  "killed",
  "timeout",
] as const;
export type SessionRunStatus = (typeof SESSION_RUN_STATUSES)[number];

/** What the Control UI's badge SAYS (session-status.ts:20-29): the status itself, or one
 *  of the three words it derives (`live`, `idle`, `unknown`). */
export const SESSION_ROW_DISPLAYS = [
  "queued",
  "live",
  // In upstream's label table (session-status.ts:9) though the rule never reaches it: a
  // `running` row is either active (`live`) or not (`idle`).
  "running",
  "idle",
  "unknown",
  "done",
  "failed",
  "interrupted",
  "killed",
  "timeout",
] as const;
export type SessionRowDisplay = (typeof SESSION_ROW_DISPLAYS)[number];

/** The badge's colour class (session-status.ts:30-37). */
export type SessionRowKind = "warn" | "ok" | "muted" | "danger";

export function isSessionRunStatus(value: unknown): value is SessionRunStatus {
  return typeof value === "string" && (SESSION_RUN_STATUSES as readonly string[]).includes(value);
}

export function isSessionRowDisplay(value: unknown): value is SessionRowDisplay {
  return typeof value === "string" && (SESSION_ROW_DISPLAYS as readonly string[]).includes(value);
}

type SessionRunState = { status?: SessionRunStatus; hasActiveRun?: boolean };

/** src/shared/session-run-state.ts:8-16, verbatim. */
export function isSessionRunActive(state: SessionRunState): boolean {
  if (state.status && state.status !== "queued" && state.status !== "running") {
    return false;
  }
  if (typeof state.hasActiveRun === "boolean") {
    return state.hasActiveRun;
  }
  return state.status === "queued" || state.status === "running";
}

/** The badge's label (session-status.ts:18-29), as a word rather than a translation. */
export function sessionRowDisplay(row: SessionRunState): SessionRowDisplay {
  const active = isSessionRunActive(row);
  const idle = row.hasActiveRun === false && (!row.status || row.status === "running");
  return row.status === "queued"
    ? "queued"
    : active
      ? "live"
      : idle
        ? "idle"
        : row.status
          ? row.status
          : "unknown";
}

/** The badge's kind (session-status.ts:30-37). */
export function sessionRowKind(row: SessionRunState): SessionRowKind {
  const active = isSessionRunActive(row);
  const idle = row.hasActiveRun === false && (!row.status || row.status === "running");
  return row.status === "queued"
    ? "warn"
    : active || row.status === "done"
      ? "ok"
      : idle || !row.status || row.status === "interrupted"
        ? "muted"
        : "danger";
}

/** Atrium's four lifecycle states, from what the badge says. `null` = the row says
 *  nothing Atrium's enum can hold (`idle`, `unknown`): the stored state is left as it is.
 *  `failed` and `timeout` are `error` (the word stays beside it); `killed` and
 *  `interrupted` are `aborted` — the run was stopped, it did not finish. */
export function atriumStatusOfDisplay(
  display: SessionRowDisplay,
): "running" | "done" | "error" | "aborted" | null {
  switch (display) {
    case "queued":
    case "live":
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
    case "timeout":
      return "error";
    case "killed":
    case "interrupted":
      return "aborted";
    case "idle":
    case "unknown":
      return null;
  }
}
