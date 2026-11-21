// The ONE inbound-attachment size limit, DERIVED from the gateway's WS frame limit
// (`policy.maxPayload`, captured by the bridge and reported in /health). Inbound
// attachments ride the JSON WS as inline base64, so the whole chat.send frame
// (base64 ≈ raw×4/3 + envelope) must fit `maxPayload`. Nothing here is a hardcoded
// FILE size — every limit is computed from the gateway-announced `maxPayload`.
//
// Byte-identical with `bridge/src/core/attachment-limits.ts` (the bridge frame
// guard) and `src/lib/attachmentLimits.ts` (the composer reject-upfront): three
// separate module trees, same math (same idiom as the session-key helpers).

// Room reserved for the chat.send envelope around the base64 content (sessionKey,
// message, filename/mimeType, JSON punctuation). Fixed + generous; NOT a magic
// file-size number.
export const FRAME_ENVELOPE_OVERHEAD_BYTES = 128 * 1024; // 128 KiB

// OpenClaw's OWN default WS frame limit — the value every 2026.x hello-ok reports.
// Used as the CONSERVATIVE fallback when the bridge has not yet reported a real
// per-instance maxPayload (cold poll / old bridge): the dispatch AND the composer
// both cap at this so an oversize upload is rejected with a clear "too large"
// instead of being accepted then failing downstream. Derived knowledge (the
// gateway default), not a magic number; it auto-corrects to the real value once
// the bridge publishes it.
export const DEFAULT_GATEWAY_MAX_PAYLOAD = 26214400; // 25 MiB

/** base64 byte length of a raw byte count (4 output chars per 3 input bytes). */
export function base64ByteLength(rawBytes: number): number {
  return 4 * Math.ceil(rawBytes / 3);
}

/** Max RAW file bytes whose base64 + envelope still fits `maxPayload`. 0 if the
 *  frame is too small to carry any payload. Aligned to the base64 quantum (3 raw
 *  bytes -> 4 chars) so `base64ByteLength(result) <= usable` ALWAYS holds — a plain
 *  `floor(usable*3/4)` can round UP past the frame (usable=6 -> raw=4 -> base64=8). */
export function maxRawInboundBytes(maxPayload: number): number {
  const usable = maxPayload - FRAME_ENVELOPE_OVERHEAD_BYTES;
  if (usable <= 0) return 0;
  return Math.floor(usable / 4) * 3;
}

/** Does a base64 payload of `base64Bytes` (plus envelope) fit `maxPayload`? Used
 *  by the dispatch to check the AGGREGATE frame size across all attachments. */
export function base64FitsFrame(base64Bytes: number, maxPayload: number): boolean {
  return base64Bytes + FRAME_ENVELOPE_OVERHEAD_BYTES <= maxPayload;
}

// ---------------------------------------------------------------------------------
// PER-ATTACHMENT ceilings (the gateway's `hello-ok.policy.attachments`, OpenClaw
// 2026.8.1+), carried by the bridge beside the frame limit. The frame limit bounds the
// whole `chat.send`; the gateway ALSO bounds each attachment's decoded size, an image
// more tightly (6 MiB), and refuses the whole send for one file over it.
//
// THE RULE: an early refusal here is never stricter than the gateway's own decision
// for that send. A ceiling that is not known — no socket of the bridge vouches for it,
// the instance is not named, the snapshot is stale — refuses nothing; the gateway's
// own refusal remains. Same rule as `bridge/src/core/attachment-limits.ts`.
// ---------------------------------------------------------------------------------

/** The gateway's decoded-size ceilings for ONE attachment; a null member is unknown. */
export interface AttachmentCeilings {
  maxBytes: number | null;
  maxImageBytes: number | null;
}

const knownCeiling = (n: number | null | undefined): number | null =>
  typeof n === "number" && n > 0 ? n : null;

/** The two stored numbers as ceilings, or null when neither is known. */
export function attachmentCeilingsOf(stored: {
  attachmentMaxBytes?: number | null;
  attachmentMaxImageBytes?: number | null;
}): AttachmentCeilings | null {
  const maxBytes = knownCeiling(stored.attachmentMaxBytes);
  const maxImageBytes = knownCeiling(stored.attachmentMaxImageBytes);
  return maxBytes === null && maxImageBytes === null ? null : { maxBytes, maxImageBytes };
}

/** How many leading bytes `isKnownImageSignature` reads. */
export const IMAGE_SIGNATURE_BYTES = 12;

/**
 * Do these FIRST BYTES say "image" the way the gateway will?
 *
 * The gateway does not trust the declared type: it sniffs the payload's first bytes
 * (src/media/sniff-mime-from-base64.ts → `detectMime`, file-type's `fileTypeFromBuffer`
 * on the first 192 bytes) and a type it recognises wins over the declared one
 * (src/media/attachment-processor.runtime.ts; in chat-attachments.ts before 2026.9.9).
 * A CAF recording declared `image/png` is audio to it and faces the FILE ceiling.
 *
 * So the image ceiling is applied early only on a POSITIVE identification, by the
 * signatures of the four formats the gateway certainly reads as `image/*`: PNG, JPEG,
 * GIF and WebP. Anything else — other image formats included — is "not known to be an
 * image": the image ceiling is not applied early, and the gateway decides.
 */
export function isKnownImageSignature(head: Uint8Array | null | undefined): boolean {
  if (!head || head.length < 12) return false;
  const at = (offset: number, ...bytes: number[]): boolean =>
    bytes.every((b, i) => head[offset + i] === b);
  return (
    at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) || // PNG
    at(0, 0xff, 0xd8, 0xff) || // JPEG
    at(0, 0x47, 0x49, 0x46, 0x38) || // GIF8
    (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) // RIFF….WEBP
  );
}

/** The ceiling a file faces, or null when none is known. A file identified as an image
 *  faces the image ceiling and the file one. */
export function attachmentCeilingFor(
  knownImage: boolean,
  ceilings: AttachmentCeilings | null,
): number | null {
  if (ceilings === null) return null;
  if (!knownImage) return ceilings.maxBytes;
  const known = [ceilings.maxImageBytes, ceilings.maxBytes].filter(
    (n): n is number => n !== null,
  );
  return known.length > 0 ? Math.min(...known) : null;
}

/** Would the gateway refuse an inline attachment of `size` bytes for its size? Strictly
 *  greater, like the gateway; never when the ceiling is unknown. */
export function exceedsAttachmentCeiling(
  size: number,
  knownImage: boolean,
  ceilings: AttachmentCeilings | null,
): boolean {
  const ceiling = attachmentCeilingFor(knownImage, ceilings);
  return ceiling !== null && size > ceiling;
}
