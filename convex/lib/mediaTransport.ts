// Inbound attachment transport classification (Phase 3, shared-fs large media).
//
// The split is MODEL-NATIVE vs TOOL-READ — NOT "image vs non-image":
//   - MODEL-NATIVE: a multimodal MODEL decodes the bytes directly (Vision images).
//     These MUST be inline (base64 in the chat.send frame) so the model sees them,
//     and are therefore bounded by the gateway maxPayload. A huge image that can't
//     fit is a DOCUMENTED LIMIT (there is no "vision via path"), not a bug.
//   - TOOL-READ: a tool reads the file BY PATH (transcription / docling /
//     office-to-md). These can go BY REFERENCE — the bridge streams the bytes to a
//     shared volume and injects the gateway-visible path — so any size works
//     (video / audio / large docs), bypassing the WS frame ceiling entirely.
//
// Reference transport only applies when the routed instance is in `shared-fs`
// inbound mode; otherwise everything is inline (today's behaviour + the existing
// ATTACHMENT_TOO_LARGE gate for oversize files).

export type AttachmentTransport = "inline" | "reference";

/**
 * The image formats a multimodal model actually DECODES. Both providers Atrium
 * targets document the same four — PNG, JPEG, GIF, WebP — and nothing else.
 *
 * This is an ALLOWLIST on purpose, and the distinction is load-bearing rather than
 * pedantic. `image/*` was the old criterion, and it is wrong: `image/svg+xml` is XML
 * text, not a raster, and no Vision API decodes it. Classifying one as model-native
 * pins it to the INLINE path, where it reaches the model as bytes the model cannot
 * read — and, because inline leaves no file on disk, no tool can read it by path
 * either. The attachment therefore reaches nobody, and nothing says so: the agent
 * infers "this file is not accessible" and starts inventing workarounds.
 *
 * Observed in production on 2026-09-11: a user attached the same two SVG logos four
 * times; the agent asked each time for a re-send, then for a ZIP archive — which
 * would have worked precisely BECAUSE a ZIP is not `image/*` and would have been
 * classified tool-read. The user's own workaround is the proof of the defect.
 *
 * Anything else under `image/*` (svg+xml, tiff, bmp, heic/heif, avif, x-icon) is
 * likewise undecodable by the model, and is strictly better off tool-read: a tool
 * can open, convert or parse it, which is more than the model could ever do.
 *
 * `image/jpg` is a non-standard spelling some clients still emit; it is accepted as
 * an alias because excluding a real photograph from the model is the exact failure
 * this allowlist exists to prevent.
 */
const MODEL_NATIVE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

/**
 * Whether a MIME type is consumed directly by a multimodal model (Vision) and
 * therefore MUST ride inline. The criterion is "the model DECODES it", which the
 * four raster formats above satisfy and every other `image/*` subtype does not.
 */
export function isModelNativeMime(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== "string") return false;
  // Tolerate a parameterised header ("image/png; charset=binary") and any casing:
  // the transport must not hinge on how a client spelled the type.
  const base = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  return MODEL_NATIVE_IMAGE_MIMES.has(base);
}

/**
 * Classify how an inbound attachment should reach the gateway. Tool-read files go
 * by reference ONLY in shared-fs mode; model-native (Vision) files always inline.
 */
export function classifyAttachment(opts: {
  mimeType: string | null | undefined;
  inboundMediaMode: "inline" | "shared-fs";
}): AttachmentTransport {
  if (opts.inboundMediaMode !== "shared-fs") return "inline";
  return isModelNativeMime(opts.mimeType) ? "inline" : "reference";
}
