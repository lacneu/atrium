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
