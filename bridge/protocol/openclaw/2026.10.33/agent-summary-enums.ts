// VENDORED VERBATIM from openclaw/openclaw @ v2026.10.33 — packages/gateway-protocol/src/schema/agent-summary-enums.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import { Type } from "typebox";

export const AgentKindSchema = Type.Union([Type.Literal("agent"), Type.Literal("system")]);

export const AgentCreatedViaSchema = Type.Union([
  Type.Literal("operator"),
  Type.Literal("agent"),
  Type.Literal("claw"),
]);

export const AgentOwnershipSchema = Type.Union([
  Type.Literal("sole"),
  Type.Literal("legacy"),
  Type.Literal("explicit"),
]);
