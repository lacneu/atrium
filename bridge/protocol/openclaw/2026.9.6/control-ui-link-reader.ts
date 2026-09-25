// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.6 — packages/gateway-protocol/src/schema/control-ui-link-reader.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const ControlUiLinkReaderMetadataSchema = closedObject({
  hosts: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { minItems: 1, maxItems: 16 }),
  pathPattern: Type.String({ minLength: 2, maxLength: 1024 }),
  detailMethod: Type.String({ minLength: 1, maxLength: 128 }),
  previewMethod: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  imageMethod: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

export const ControlUiLinkReaderDescriptorSchema = closedObject({
  pluginId: NonEmptyString,
  id: NonEmptyString,
  label: NonEmptyString,
  icon: Type.Optional(Type.String()),
  linkReader: ControlUiLinkReaderMetadataSchema,
});
