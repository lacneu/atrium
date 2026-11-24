// A model name on a fallback marker (schema `model_fallback` part): what the gateway
// names a model, `provider/model`. Network input from the bridge, shown to the reader —
// so a bounded, single-line slug or nothing.

export const MODEL_FALLBACK_LABEL_MAX_CHARS = 200;

export function isModelFallbackLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MODEL_FALLBACK_LABEL_MAX_CHARS &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** A gateway status notice on a bubble: one bounded piece of text, a few per bubble. */
export const GATEWAY_NOTICE_MAX_CHARS = 2000;
export const GATEWAY_NOTICES_PER_BUBBLE = 8;

export function isGatewayNoticeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= GATEWAY_NOTICE_MAX_CHARS &&
    // Line breaks and tabs are text; any other control character is not.
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}
