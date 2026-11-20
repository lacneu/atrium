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
