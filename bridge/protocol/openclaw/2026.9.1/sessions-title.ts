// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.1 — packages/gateway-protocol/src/schema/sessions-title.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Optional creation-only inference; never creates or renames a session. */
export const SessionsTitlePrepareParamsSchema = closedObject({
  agentId: NonEmptyString,
  message: Type.String({ maxLength: 1_000 }),
  model: Type.Optional(NonEmptyString),
  catalogId: Type.Optional(NonEmptyString),
  incognito: Type.Optional(Type.Boolean()),
});

export const SessionsTitlePrepareResultSchema = closedObject({
  title: Type.Union([Type.String({ minLength: 1, maxLength: 60 }), Type.Null()]),
});

export type SessionsTitlePrepareParams = Static<typeof SessionsTitlePrepareParamsSchema>;
export type SessionsTitlePrepareResult = Static<typeof SessionsTitlePrepareResultSchema>;
