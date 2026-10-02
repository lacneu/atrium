// The size of a `chat.send` request AS IT GOES ON THE WIRE.
//
// The gateway's WebSocket refuses a frame larger than its `policy.maxPayload` by
// CLOSING the connection (live-verified: a 20.9 MiB pptx, base64 ≈ 27.9 MiB against
// a 25 MiB cap → GATEWAY_DISCONNECTED). The earlier gates size parts of the frame —
// the composer and Convex the attachments, the bridge the history it prepends — and
// the user's text is bounded by none of them. Only the whole request, measured the
// way the client serializes it (openclaw-client.ts `request`:
// `JSON.stringify({ type: "req", id, method, params })`), says whether it fits.

/** A request id is a `randomUUID()`: 36 characters, the same on every request. */
const REQUEST_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

/** Characters that JSON leaves untouched and UTF-8 stores in one byte each — the
 *  whole base64 alphabet plus padding. */
function isPlainBase64(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const plain =
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x61 && c <= 0x7a) || // a-z
      (c >= 0x30 && c <= 0x39) || // 0-9
      c === 0x2b || // +
      c === 0x2f || // /
      c === 0x3d; // =
    if (!plain) return false;
  }
  return true;
}

/** Bytes a string occupies inside a JSON frame (UTF-8 after escaping, quotes not
 *  counted). A base64 body is its length; anything else is measured for real. */
function jsonStringBytes(text: string): number {
  return isPlainBase64(text)
    ? text.length
    : Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/**
 * The exact byte size of the request frame the client will write for `method` with
 * `params`. The `chat.send` measure is `chatSendFrameBytes` in chat-send.ts — the one
 * door that names that method.
 *
 * Exact, not estimated: the frame is serialized with the attachments' `content`
 * emptied, and each content's own on-wire size is added back — so a multi-megabyte
 * base64 body is scanned once rather than copied into a second string.
 */
export function requestFrameBytes(
  method: string,
  params: Record<string, unknown>,
): number {
  let contentBytes = 0;
  const attachments = Array.isArray(params.attachments)
    ? params.attachments.map((a: unknown) => {
        if (
          typeof a === "object" &&
          a !== null &&
          typeof (a as { content?: unknown }).content === "string"
        ) {
          contentBytes += jsonStringBytes((a as { content: string }).content);
          return { ...(a as Record<string, unknown>), content: "" };
        }
        return a;
      })
    : undefined;
  const shell = attachments === undefined ? params : { ...params, attachments };
  return (
    Buffer.byteLength(
      JSON.stringify({
        type: "req",
        id: REQUEST_ID_PLACEHOLDER,
        method,
        params: shell,
      }),
      "utf8",
    ) + contentBytes
  );
}

/**
 * The bridge REFUSED a send whose frame does not fit the gateway's `maxPayload`, even
 * without any history it could have taken back off. Sent, it would have made the
 * gateway close the connection. Recognised by TYPE (dispatch-errors.ts): a refusal we
 * decide is never left to how it is phrased.
 */
export class FrameTooLargeError extends Error {
  constructor(
    readonly frameBytes: number,
    readonly maxPayload: number,
  ) {
    super(
      `send withheld: the message and its files make a ${frameBytes}-byte frame, over the gateway's maxPayload ${maxPayload}`,
    );
    this.name = "FrameTooLargeError";
  }
}
