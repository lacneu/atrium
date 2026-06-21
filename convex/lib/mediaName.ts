// Shared media-filename normalization (backend + frontend, no drift).
//
// The gateway names offloaded media `<base>---<uuid>.<ext>` (its media-store id), so
// an agent-generated file surfaces as e.g.
// `openclaw-lightrag-report---4c23520c-…-….pdf`. Strip the `---<uuid>` segment so it
// reads `…-report.pdf`. Only a STRICT UUID immediately before the extension is
// removed — a user upload like `IFOA Presentation.pptx` is left untouched.
//
// Used by the frontend (display/download filename, convertMessage.displayFilename)
// AND the backend documentary correlation (matching a returned media file to a
// requested reference) — they MUST agree, hence this single source of truth.

const GATEWAY_MEDIA_ID_RE =
  /---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.[^.]+$|$)/i;

/** Remove the gateway media-store `---<uuid>` id segment, if present. */
export function stripGatewayMediaId(name: string): string {
  return name.replace(GATEWAY_MEDIA_ID_RE, "");
}
