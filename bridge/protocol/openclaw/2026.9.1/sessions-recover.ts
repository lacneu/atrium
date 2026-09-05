// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.1 — packages/gateway-protocol/src/schema/sessions-recover.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ErrorShapeSchema } from "./frames.js";
import { NonEmptyString } from "./primitives.js";

/** Recovers one restart-tombstoned session into a fresh same-agent session. */
export const SessionsRecoverParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});

const SessionRecoveryContinuationOutcomeSchema = Type.Union([
  closedObject({
    status: Type.Literal("started"),
    runId: NonEmptyString,
  }),
  closedObject({
    status: Type.Literal("rejected"),
    error: ErrorShapeSchema,
  }),
]);

export const SessionsRecoverResultSchema = closedObject({
  ok: Type.Literal(true),
  key: NonEmptyString,
  sessionId: NonEmptyString,
  continuation: SessionRecoveryContinuationOutcomeSchema,
});
