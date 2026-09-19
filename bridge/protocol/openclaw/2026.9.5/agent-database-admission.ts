// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.5 — packages/gateway-protocol/src/schema/agent-database-admission.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const AgentDatabaseAdmissionRefusalProperties = {
  agentId: NonEmptyString,
  paths: Type.Array(NonEmptyString),
  reason: NonEmptyString,
  repairHint: NonEmptyString,
};

export const AgentDatabaseAdmissionRefusalSchema = Type.Union([
  closedObject({
    ...AgentDatabaseAdmissionRefusalProperties,
    embeddedOwnerId: NonEmptyString,
    code: Type.Literal("agent-database-ownership-mismatch"),
  }),
  closedObject({
    ...AgentDatabaseAdmissionRefusalProperties,
    code: Type.Union([
      Type.Literal("agent-database-inspection-pending"),
      Type.Literal("agent-database-inspection-failed"),
    ]),
  }),
]);
