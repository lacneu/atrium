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
