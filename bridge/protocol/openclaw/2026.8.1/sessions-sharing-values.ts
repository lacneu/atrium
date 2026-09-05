// VENDORED VERBATIM from openclaw/openclaw @ v2026.8.1 — packages/gateway-protocol/src/schema/sessions-sharing-values.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import type { Static } from "typebox";
import { Type } from "typebox";

export const SESSION_VISIBILITY_VALUES = ["shared", "read-only", "suggest", "draft"] as const;

export const SessionVisibilitySchema = Type.Union([
  Type.Literal("shared"),
  Type.Literal("read-only"),
  Type.Literal("suggest"),
  Type.Literal("draft"),
]);

export const SessionSharingRoleSchema = Type.Union([
  Type.Literal("admin"),
  Type.Literal("owner"),
  Type.Literal("member"),
  Type.Literal("viewer"),
]);

export type SessionVisibility = Static<typeof SessionVisibilitySchema>;
export type SessionSharingRole = Static<typeof SessionSharingRoleSchema>;
