// Inbound attachment transport classification (Phase 3, shared-fs large media).
//
// The split is MODEL-NATIVE vs TOOL-READ — NOT "image vs non-image":
//   - MODEL-NATIVE: a multimodal MODEL decodes the bytes directly (Vision images).
//     These MUST be inline (base64 in the chat.send frame) so the model sees them,
//     and are therefore bounded by the gateway maxPayload. A huge image that can't
//     fit is a DOCUMENTED LIMIT (there is no "vision via path"), not a bug.
//   - TOOL-READ: a tool reads the file BY PATH (transcription / docling /
//     office-to-md). Whenever the frame can carry it, it rides INLINE too — as a
//     native `chat.send` attachment the GATEWAY owns: it offloads the bytes to its
//     own media store, copies them into the session's sandbox workspace when the
//     agent is sandboxed, extracts text/PDF content into the prompt, and cleans up.
//     Only what the frame CANNOT carry goes BY REFERENCE — the bridge streams the
//     bytes to a shared volume and injects the gateway-visible path — so any size
//     still works (video / audio / large docs), bypassing the WS frame ceiling.
//
// Why the native leg first (OpenClaw 2026.9.6, read in its source and measured on
// the bench): a path Atrium writes beside the gateway is not an attachment to it.
// No media fact is recorded, nothing is staged into a sandbox, and an agent whose
// file tools are confined (`tools.fs.workspaceOnly`, or a Docker sandbox) is
// refused by its own `read` tool on that path ("Path escapes sandbox root") — the
// attachment then reaches the agent only if it thinks of a shell. The gateway's own
// attachment path (`chat.send` attachments → `prestageMediaPathOffloads` →
// `stageSandboxMedia`) is the one every OpenClaw client uses, and the one the
// gateway makes readable.
//
// Reference transport only applies when the routed instance is in `shared-fs`
// inbound mode; otherwise everything is inline (today's behaviour + the existing
// ATTACHMENT_TOO_LARGE gate for oversize files).

import { base64ByteLength, base64FitsFrame } from "./attachmentLimits";

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

/** Any `image/*` type, decodable or not. Used for the ones that are NOT. */
function isImageMime(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== "string") return false;
  return mimeType.toLowerCase().trim().startsWith("image/");
}

/** One attachment, as the planner needs to see it. `size` is the stored blob's byte
 *  count, `null` when it could not be read. */
export interface PlannedAttachment {
  mimeType: string | null | undefined;
  size: number | null;
}

/**
 * Decide how each inbound attachment reaches the gateway, in the order given.
 *
 * `inline` mode: everything inline (the frame check that follows is the dispatch's).
 *
 * `shared-fs` mode:
 *   - a model-native raster image is inline, always — the model needs the bytes;
 *   - any OTHER `image/*` (svg, tiff, heic, …) is a reference, always. The gateway
 *     classifies by `image/` prefix and would hand those bytes to the model as an
 *     image it cannot decode — the 2026-09-11 SVG defect, which leaves the file to
 *     nobody. As a reference, a tool can still open it;
 *   - every other file is inline when it fits the frame BESIDE what must ride inline
 *     (the raster images are reserved first, whatever their position, so a document
 *     placed before a photo can never push the photo over the frame), and a
 *     reference otherwise. Files are admitted in order: the first ones that fit go
 *     native, the rest by reference — never a refusal for size;
 *   - an EMPTY file, or one whose size is unknown, is a reference: the gateway
 *     refuses an empty payload outright (`empty-payload`, the whole turn with it),
 *     and a size we cannot read is a size we cannot budget.
 */
export function planAttachmentTransports(opts: {
  inboundMediaMode: "inline" | "shared-fs";
  attachments: readonly PlannedAttachment[];
  maxPayload: number;
}): AttachmentTransport[] {
  if (opts.inboundMediaMode !== "shared-fs") {
    return opts.attachments.map(() => "inline");
  }
  let reserved = 0;
  for (const a of opts.attachments) {
    if (isModelNativeMime(a.mimeType)) reserved += base64ByteLength(a.size ?? 0);
  }
  return opts.attachments.map((a): AttachmentTransport => {
    if (isModelNativeMime(a.mimeType)) return "inline";
    if (isImageMime(a.mimeType)) return "reference";
    if (a.size === null || !Number.isFinite(a.size) || a.size <= 0) {
      return "reference";
    }
    const next = reserved + base64ByteLength(a.size);
    if (!base64FitsFrame(next, opts.maxPayload)) return "reference";
    reserved = next;
    return "inline";
  });
}
