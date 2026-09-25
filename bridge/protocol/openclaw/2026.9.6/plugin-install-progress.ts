// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.6 — packages/gateway-protocol/src/schema/plugin-install-progress.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Request-scoped installer facts; no package output or local paths cross this boundary. */
export const PluginInstallActivitySchema = closedObject({
  activityId: NonEmptyString,
  stage: Type.Union([
    Type.Literal("resolve"),
    Type.Literal("download"),
    Type.Literal("extract"),
    Type.Literal("files"),
    Type.Literal("dependencies"),
    Type.Literal("runtime"),
  ]),
  status: Type.Union([Type.Literal("started"), Type.Literal("completed"), Type.Literal("failed")]),
});
export const PluginsInstallProgressEventSchema = closedObject({
  ...PluginInstallActivitySchema.properties,
  requestId: NonEmptyString,
});
export type PluginInstallActivity = Static<typeof PluginInstallActivitySchema>;
export type PluginsInstallProgressEvent = Static<typeof PluginsInstallProgressEventSchema>;
