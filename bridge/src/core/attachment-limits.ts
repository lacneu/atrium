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
// attachment's DECODED size, and says so in the handshake "so clients can validate a
// file before sending" (packages/gateway-protocol/src/schema/frames.ts). What it
// ENFORCES per send is `agents.defaults.mediaMaxMb` (20 MiB by default,
// server-methods/chat-send-attachments.ts) and, for an image, 6 MiB
// (chat-attachments.ts). What it ADVERTISES is those two capped at its own frame budget
// (chat-attachment-policy.ts resolveChatAttachmentPolicy).
//
// THE RULE EVERYTHING BELOW SERVES: an early refusal here is never stricter than the
// gateway's own decision for that send. A ceiling that is unknown refuses nothing.
// ---------------------------------------------------------------------------------

/** The gateway's decoded-size ceilings for ONE attachment. A null member is a limit
 *  this side does not know (or that the frame check above already owns). */
export interface AttachmentCeilings {
  /** Any attachment. */
  maxBytes: number | null;
  /** An image. */
  maxImageBytes: number | null;
}

const positiveInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;

/** What the gateway keeps of the frame for the envelope when it caps the ceilings it
 *  advertises (upstream `WS_FRAME_ENVELOPE_SLACK_BYTES`, src/shared/
 *  chat-attachment-frame-budget.ts; in chat-attachment-policy.ts before 2026.9.9). */
const GATEWAY_FRAME_SLACK_BYTES = 256 * 1024;

/** The gateway's own frame budget for one attachment
 *  (`resolveChatAttachmentFrameBudgetBytes`). */
function gatewayFrameBudgetBytes(maxPayload: number): number {
  return Math.max(0, Math.floor(((maxPayload - GATEWAY_FRAME_SLACK_BYTES) * 3) / 4));
}

/**
 * The ceilings a `hello-ok.policy` advertises that the gateway really enforces, or
 * null when it advertises none it does (a gateway older than 2026.8.1, a malformed
 * object).
 *
 * An advertised value EQUAL TO THE GATEWAY'S FRAME BUDGET is dropped: it is the cap of
 * the advertisement, not the configured limit — with the default 20 MiB the gateway
 * advertises 19 464 192 and accepts a 19.5 MB file that fits the frame. The frame
 * check above owns that bound; refusing on the advertised number would refuse a file
 * the gateway takes. Without `maxPayload` the cap cannot be told from a limit, and
 * nothing is kept.
 */
export function readAttachmentCeilings(policy: unknown): AttachmentCeilings | null {
  if (typeof policy !== "object" || policy === null) return null;
  const p = policy as Record<string, unknown>;
  const advertised = p.attachments;
  if (typeof advertised !== "object" || advertised === null) return null;
  const maxPayload = positiveInt(p.maxPayload);
  if (maxPayload === null) return null;
  const budget = gatewayFrameBudgetBytes(maxPayload);
  const enforced = (v: unknown): number | null => {
    const n = positiveInt(v);
    return n !== null && n < budget ? n : null;
  };
  const a = advertised as Record<string, unknown>;
  const maxBytes = enforced(a.maxBytes);
  const maxImageBytes = enforced(a.maxImageBytes);
  if (maxBytes === null && maxImageBytes === null) return null;
  return { maxBytes, maxImageBytes };
}

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

/** The ceiling an attachment faces, or null when none is known. One identified as an
 *  image faces the image ceiling AND the file one (the gateway checks both). */
export function attachmentCeilingFor(
  knownImage: boolean,
  ceilings: AttachmentCeilings,
): number | null {
  if (!knownImage) return ceilings.maxBytes;
  const known = [ceilings.maxImageBytes, ceilings.maxBytes].filter(
    (n): n is number => n !== null,
  );
  return known.length > 0 ? Math.min(...known) : null;
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
    const { content } = entry as { content?: unknown };
    if (typeof content !== "string") continue;
    const decodedBytes = decodedBase64Bytes(content);
    // The declared `mimeType` is not consulted: the gateway sniffs the bytes.
    const image = isKnownImageSignature(Buffer.from(content.slice(0, 16), "base64"));
    const ceiling = attachmentCeilingFor(image, ceilings);
    if (ceiling !== null && decodedBytes > ceiling) {
      return { index, decodedBytes, ceiling, image };
    }
  }
  return null;
}
