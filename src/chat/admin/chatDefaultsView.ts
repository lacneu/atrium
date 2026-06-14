// Pure view helpers for the Settings "chatDefaults" tab (CONF-4d). No React —
// the defensive payload parsing is unit-tested without mounting the component.

/**
 * Thinking levels the gateway accepts (bench-verified enum — CONF_DESIGN
 * probes). Mirrors THINKING_DEFAULTS in convex/agentFiles.ts, duplicated here
 * because that module imports the Convex server runtime (not browser-safe).
 */
export const THINKING_DEFAULT_OPTIONS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ChatDefaultsView = {
  thinkingDefault: string | null;
  fastModeDefault: boolean | null;
};

/**
 * Defensive parse of the bridge `/config-defaults {op:"get"}` payload (the
 * Convex action relays it as `unknown`). Tolerates the two plausible shapes —
 * fields at the top level or nested under `defaults` — and an unknown thinking
 * value (kept verbatim so the UI can at least show it). Missing fields = null.
 */
export function parseChatDefaults(data: unknown): ChatDefaultsView {
  const root =
    data !== null && typeof data === "object"
      ? (data as Record<string, unknown>)
      : {};
  const nested =
    root.defaults !== null && typeof root.defaults === "object"
      ? (root.defaults as Record<string, unknown>)
      : {};
  const thinking = nested.thinkingDefault ?? root.thinkingDefault;
  const fast = nested.fastModeDefault ?? root.fastModeDefault;
  return {
    thinkingDefault: typeof thinking === "string" ? thinking : null,
    fastModeDefault: typeof fast === "boolean" ? fast : null,
  };
}
