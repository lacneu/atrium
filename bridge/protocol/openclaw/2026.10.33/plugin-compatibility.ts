// VENDORED VERBATIM from openclaw/openclaw @ v2026.10.33 — packages/gateway-protocol/src/schema/plugin-compatibility.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PluginSdkDeprecationNoticeSchema = closedObject({
  code: Type.Literal("deprecated-sdk-api"),
  severity: Type.Literal("info"),
  message: NonEmptyString,
  removalDate: Type.Optional(NonEmptyString),
  migrationGuideUrl: NonEmptyString,
  apis: Type.Array(
    closedObject({
      id: NonEmptyString,
      displayName: NonEmptyString,
      replacement: NonEmptyString,
      removeAfter: Type.Optional(NonEmptyString),
    }),
  ),
});
