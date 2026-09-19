// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.5 — packages/gateway-protocol/src/schema/model-runtime-options.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { WorkerExecutionModeSchema } from "./environments.js";
import { NonEmptyString } from "./primitives.js";

/** Model option shown in selectors and model catalog results. */
export const GatewayAgentRuntimeSchema = closedObject({
  id: NonEmptyString,
  fallback: Type.Optional(Type.Union([Type.Literal("openclaw"), Type.Literal("none")])),
  cloudPlacementSupported: Type.Optional(Type.Boolean()),
  cloudPlacementExecutionMode: Type.Optional(WorkerExecutionModeSchema),
  devicePlacement: Type.Optional(
    closedObject({
      requiredNodeCommands: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 32,
        uniqueItems: true,
      }),
      consumesWorkerSlot: Type.Boolean(),
    }),
  ),
  devicePlacementSupported: Type.Optional(Type.Boolean()),
  source: Type.Union([
    Type.Literal("env"),
    Type.Literal("agent"),
    Type.Literal("defaults"),
    Type.Literal("model"),
    Type.Literal("provider"),
    Type.Literal("implicit"),
    Type.Literal("session"),
    Type.Literal("session-key"),
  ]),
});

export const GatewayThinkingLevelOptionSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
});

export const GatewayContextWindowOptionSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  contextWindow: Type.Integer({ minimum: 1 }),
});
