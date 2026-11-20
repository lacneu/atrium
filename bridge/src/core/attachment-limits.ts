// The ONE inbound-attachment size limit, DERIVED from the gateway's WS frame limit
// (`policy.maxPayload`, captured live in openclaw-client). Inbound attachments ride
// the JSON WS as inline base64, so the entire chat.send frame (base64 of the file
// ≈ raw×4/3, plus the envelope) must fit inside `maxPayload`. Nothing here is a
// hardcoded FILE size — every limit is computed from the gateway-announced
// `maxPayload`, so it tracks the gateway automatically.
//
// Kept byte-identical with `src/lib/attachmentLimits.ts` (composer reject-upfront)
// and `convex/lib/attachmentLimits.ts` (dispatch fail-not-skip): three separate
// module trees, same math (same idiom as the session-key helpers).

// Room reserved for the chat.send envelope AROUND the base64 content — the
// sessionKey, the message text, filename/mimeType, and JSON punctuation. Fixed and
// generous so the derived cap is stable; it is NOT a magic file-size number.
export const FRAME_ENVELOPE_OVERHEAD_BYTES = 128 * 1024; // 128 KiB

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

/** Does a base64 payload of `base64Bytes` (plus envelope) fit the gateway frame? */
export function base64FitsFrame(
  base64Bytes: number,
  maxPayload: number,
): boolean {
  return base64Bytes + FRAME_ENVELOPE_OVERHEAD_BYTES <= maxPayload;
}

// ---------------------------------------------------------------------------------
// PER-ATTACHMENT ceilings (`hello-ok.policy.attachments`, OpenClaw 2026.8.1+).
//
// The frame limit above bounds the whole `chat.send`; the gateway ALSO bounds each
// attachment's DECODED size, and it says so in the handshake "so clients can validate
// a file before sending" (packages/gateway-protocol/src/schema/frames.ts). `maxBytes`
// is `agents.defaults.mediaMaxMb` (20 MiB by default) capped at the gateway's own
// frame budget; `maxImageBytes` is that capped at 6 MiB, the size past which the
// agent side drops an image (src/gateway/chat-attachment-policy.ts). A file under the
// frame limit and over its ceiling is refused by the gateway after it was sent.
// ---------------------------------------------------------------------------------

/** The gateway's decoded-size ceilings for ONE attachment. */
export interface AttachmentCeilings {
  /** Any attachment. */
  maxBytes: number;
  /** An image (never above `maxBytes`). */
  maxImageBytes: number;
}

const positiveInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;

/**
 * The ceilings a `hello-ok.policy` advertises, or null.
 *
 * Null means UNKNOWN — a gateway older than 2026.8.1, or a malformed object — and an
 * unknown ceiling refuses nothing here: the gateway still enforces its own. Both
 * values are required (the upstream schema's shape); a zero would refuse every file.
 */
export function readAttachmentCeilings(policy: unknown): AttachmentCeilings | null {
  if (typeof policy !== "object" || policy === null) return null;
  const advertised = (policy as Record<string, unknown>).attachments;
  if (typeof advertised !== "object" || advertised === null) return null;
  const a = advertised as Record<string, unknown>;
  const maxBytes = positiveInt(a.maxBytes);
  const maxImageBytes = positiveInt(a.maxImageBytes);
  if (maxBytes === null || maxImageBytes === null) return null;
  return { maxBytes, maxImageBytes: Math.min(maxBytes, maxImageBytes) };
}

/** Is this DECLARED type an image to the gateway? It decides on the type it sniffs;
 *  a client only has the declared one, and tests it the way the Control UI does
 *  (`mimeType.startsWith("image/")`). */
function isImageMime(mimeType: unknown): boolean {
  return typeof mimeType === "string" && mimeType.trim().toLowerCase().startsWith("image/");
}

/** The ceiling an attachment of this declared type faces. */
export function attachmentCeilingFor(mimeType: unknown, ceilings: AttachmentCeilings): number {
  return isImageMime(mimeType) ? ceilings.maxImageBytes : ceilings.maxBytes;
}

/** Decoded byte length of a base64 string — the gateway's own measure
 *  (src/media/attachment-processor.ts prepareMediaAttachment). */
export function decodedBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * The first inline attachment the gateway would refuse for its size, or null.
 *
 * Strictly greater, like the gateway (`size > maxBytes`): a file exactly at the
 * ceiling is accepted there and must be here. Entries that are not attachments are
 * skipped — shaping the list is not this check's business.
 */
export function firstOversizedAttachment(
  attachments: unknown,
  ceilings: AttachmentCeilings | null | undefined,
): { index: number; decodedBytes: number; ceiling: number; image: boolean } | null {
  if (!ceilings || !Array.isArray(attachments)) return null;
  for (const [index, entry] of attachments.entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const { content, mimeType } = entry as { content?: unknown; mimeType?: unknown };
    if (typeof content !== "string") continue;
    const decodedBytes = decodedBase64Bytes(content);
    const ceiling = attachmentCeilingFor(mimeType, ceilings);
    if (decodedBytes > ceiling) {
      return { index, decodedBytes, ceiling, image: isImageMime(mimeType) };
    }
  }
  return null;
}
