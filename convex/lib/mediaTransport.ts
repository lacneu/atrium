// Inbound attachment transport classification (Phase 3, shared-fs large media).
//
// The split is MODEL-NATIVE vs TOOL-READ — NOT "image vs non-image" (they happen
// to coincide today, but the criterion is the PURPOSE, which keeps edge cases
// correct):
//   - MODEL-NATIVE: a multimodal MODEL consumes the bytes directly (Vision images).
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
 * Whether a MIME type is consumed directly by a multimodal model (Vision) and
 * therefore MUST ride inline. Broad `image/*` membership: the criterion is "reaches
 * the model as data", which images do and tool-read files (video/audio/docs) do not.
 */
export function isModelNativeMime(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
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
