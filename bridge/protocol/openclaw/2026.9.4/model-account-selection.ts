// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.4 — packages/gateway-protocol/src/schema/model-account-selection.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

export const ModelAuthProfileIdSchema = Type.String({ minLength: 1, maxLength: 256 });

const ChatAccountSelectionSourceSchema = Type.Optional(
  Type.Union([Type.Literal("auto"), Type.Literal("user"), Type.Literal("user-link")]),
);
const ChatAccountSelectionLabelSchema = Type.String({ minLength: 1, maxLength: 256 });
/** Configured preference only; provider failover can use a different account. */
export const ChatAccountSelectionSchema = Type.Union([
  closedObject({ kind: Type.Literal("automatic"), label: ChatAccountSelectionLabelSchema }),
  closedObject({
    kind: Type.Literal("personal"),
    label: ChatAccountSelectionLabelSchema,
    // Collaborators see the person, not private credential identifiers or labels.
    authProfileId: Type.Optional(ModelAuthProfileIdSchema),
    source: ChatAccountSelectionSourceSchema,
  }),
  closedObject({
    kind: Type.Literal("shared"),
    label: ChatAccountSelectionLabelSchema,
    authProfileId: ModelAuthProfileIdSchema,
    source: ChatAccountSelectionSourceSchema,
  }),
]);

export type ChatAccountSelection = Static<typeof ChatAccountSelectionSchema>;
