// The closed vocabularies of an answered refusal's trace shape (dispatch-errors.ts
// `answeredRefusalShape`). A LEAF module on purpose — no imports — so Convex's lockstep test
// (convex/lib/gatewayAnswer.test.ts) can read it without pulling the bridge's runtime into
// the app's type graph.

/** The gateway's error codes — a CLOSED vocabulary. Upstream declares them in
 *  `ErrorCodes` (packages/gateway-protocol/src/gateway-error-details.ts at v2026.9.9), a
 *  module the bridge does not vendor; `answered-refusal-vocabulary.test.ts` confronts this
 *  list with that source at `DRIFT_VENDORED_VERSION` (and with the vendored worker error
 *  codes, always). Convex keeps its own copy (convex/lib/gatewayAnswer.ts), held to this
 *  one by a lockstep test. */
export const GATEWAY_ERROR_CODES: readonly string[] = [
  "AGENT_TIMEOUT",
  "APPROVAL_NOT_FOUND",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "NOT_LINKED",
  "NOT_PAIRED",
  "UNAVAILABLE",
];

/** The `details` field NAMES the gateway's refusals are documented to carry — a CLOSED
 *  vocabulary, never "anything that looks like an identifier": a name is copied into a
 *  trace administrators read, so only a name upstream wrote may be. Sources at v2026.9.9:
 *  `AgentDatabaseAdmissionRefusal` (vendored schema/agent-database-admission.ts), the
 *  worker error details (vendored worker-protocol-primitives.ts), and every
 *  `*ErrorDetails` shape of gateway-error-details.ts. Same confrontation test. */
export const GATEWAY_DETAIL_KEYS: readonly string[] = [
  "agentId",
  "cause",
  "code",
  "currentCount",
  "currentRevisionHash",
  "cwd",
  "embeddedOwnerId",
  "expectedRevisionHash",
  "idempotencyKey",
  "jobId",
  "limit",
  "missingScope",
  "paths",
  "reason",
  "recoveryAction",
  "repairHint",
  "requiredScopes",
  "sessionId",
  "source",
];

/** The fixed value a code outside `GATEWAY_ERROR_CODES` becomes: never the string received. */
export const OTHER_GATEWAY_CODE = "other";
/** Bound on `unknownDetailKeyCount`: "this many or more". */
export const MAX_UNKNOWN_DETAIL_KEYS = 16;
