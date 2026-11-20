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
// more tightly (6 MiB by default), and refuses the whole send for one file over it.
// Same rule as `bridge/src/core/attachment-limits.ts` (the bridge's last guard).
// ---------------------------------------------------------------------------------

/** The gateway's decoded-size ceilings for ONE attachment. */
export interface AttachmentCeilings {
  maxBytes: number;
  maxImageBytes: number;
}

/** The two stored numbers as ceilings, or null when either is unknown. */
export function attachmentCeilingsOf(stored: {
  attachmentMaxBytes?: number | null;
  attachmentMaxImageBytes?: number | null;
}): AttachmentCeilings | null {
  const { attachmentMaxBytes: maxBytes, attachmentMaxImageBytes: maxImageBytes } = stored;
  return typeof maxBytes === "number" &&
    maxBytes > 0 &&
    typeof maxImageBytes === "number" &&
    maxImageBytes > 0
    ? { maxBytes, maxImageBytes: Math.min(maxBytes, maxImageBytes) }
    : null;
}

/** Is this DECLARED type an image to the gateway? Its own clients test
 *  `mimeType.startsWith("image/")` — every `image/*`, decodable by a model or not. */
export function isGatewayImageMime(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.trim().toLowerCase().startsWith("image/");
}

/** Would the gateway refuse an inline attachment of `size` bytes for its size? Strictly
 *  greater, like the gateway; never when the ceilings are unknown. */
export function exceedsAttachmentCeiling(
  size: number,
  mimeType: string | null | undefined,
  ceilings: AttachmentCeilings | null,
): boolean {
  if (ceilings === null) return false;
  return size > (isGatewayImageMime(mimeType) ? ceilings.maxImageBytes : ceilings.maxBytes);
}
