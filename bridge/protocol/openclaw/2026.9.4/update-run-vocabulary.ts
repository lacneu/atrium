// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.4 — packages/gateway-protocol/src/update-run-vocabulary.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
export const UPDATE_RUN_DRIVER_LIMIT = 8;

export const UPDATE_RUN_PHASES = [
  "requested",
  "staging",
  "validating",
  "repairing",
  "activating",
  "restarting",
  "verifying",
  "finished",
] as const;
export const UPDATE_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "rolled-back",
  "skipped",
] as const;
export const UPDATE_RUN_TRIGGERS = [
  "chat",
  "control-ui",
  "cli",
  "campaign",
  "mac-app",
  "api",
] as const;
export const UPDATE_RUN_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
] as const;
