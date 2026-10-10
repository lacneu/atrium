// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.8 — packages/gateway-protocol/src/schema/canvas.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

export const CANVAS_DOCUMENT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const WIDGET_HTML_MAX_UTF8_BYTES = 10 * 1024 * 1024;

export const CanvasDocumentPreviewParamsSchema = closedObject({
  html: Type.String({
    maxLength: CANVAS_DOCUMENT_PREVIEW_MAX_BYTES,
    description: "Caller-owned HTML, limited to 2 MiB of UTF-8 data by the Gateway.",
  }),
});

export const CanvasDocumentViewParamsSchema = closedObject({
  docId: Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!\\.{1,2}$)[A-Za-z0-9._-]+$" }),
});

export const CanvasDocumentViewResultSchema = closedObject({
  html: Type.String({ maxLength: WIDGET_HTML_MAX_UTF8_BYTES }),
  sandboxUrl: Type.String(),
  sandboxPort: Type.Integer({ minimum: 1, maximum: 65535 }),
  sandboxOrigin: Type.Optional(Type.String()),
});

export type CanvasDocumentPreviewParams = Static<typeof CanvasDocumentPreviewParamsSchema>;
export type CanvasDocumentViewParams = Static<typeof CanvasDocumentViewParamsSchema>;
export type CanvasDocumentViewResult = Static<typeof CanvasDocumentViewResultSchema>;
