// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.6 — packages/gateway-protocol/src/schema/sessions-provider-review.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SessionProviderReviewProjectionSchema = closedObject({
  id: NonEmptyString,
  runId: NonEmptyString,
  explanation: Type.Optional(Type.String({ maxLength: 65_536 })),
  continuationMessage: Type.Optional(Type.String({ maxLength: 1_024 })),
  canContinue: Type.Boolean(),
});

export const SessionsProviderReviewContinueParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  sessionId: NonEmptyString,
  reviewId: NonEmptyString,
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
});

export type SessionProviderReviewProjection = Static<typeof SessionProviderReviewProjectionSchema>;
export type SessionsProviderReviewContinueParams = Static<
  typeof SessionsProviderReviewContinueParamsSchema
>;
