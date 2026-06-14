// Admin-facing presentation of a dispatch root-cause CODE.
//
// The backend ships only a stable, non-PHI CODE on a failed-dispatch trace /
// anomaly (see convex/bridge.ts + bridge/src/core/dispatch-errors.ts). This map
// turns that code into something an admin can ACT on: a short label and a
// concrete fix hint — the difference between "a dispatch failed" and "fix
// OPENCLAW_AGENT_ID". Strings are i18n'd (m.error_*); unknown/new codes degrade
// gracefully to the raw code. Pure lookup → unit-testable, no React.

import { m } from "@/paraglide/messages.js";

export interface DispatchErrorInfo {
  /** Short label for the cause. */
  label: string;
  /** Concrete, actionable fix hint for an operator. */
  hint: string;
}

// code → resolver (re-localizes FR↔EN at call time via Paraglide).
const INFO: Record<string, () => DispatchErrorInfo> = {
  AGENT_NOT_FOUND: () => ({
    label: m.error_agent_not_found_label(),
    hint: m.error_agent_not_found_hint(),
  }),
  AUTH_TOKEN_MISMATCH: () => ({
    label: m.error_auth_token_mismatch_label(),
    hint: m.error_auth_token_mismatch_hint(),
  }),
  DEVICE_SIGNING_FAILED: () => ({
    label: m.error_device_signing_failed_label(),
    hint: m.error_device_signing_failed_hint(),
  }),
  SESSION_SCOPE_DENIED: () => ({
    label: m.error_session_scope_denied_label(),
    hint: m.error_session_scope_denied_hint(),
  }),
  GATEWAY_TIMEOUT: () => ({
    label: m.error_gateway_timeout_label(),
    hint: m.error_gateway_timeout_hint(),
  }),
  GATEWAY_DISCONNECTED: () => ({
    label: m.error_gateway_disconnected_label(),
    hint: m.error_gateway_disconnected_hint(),
  }),
  BRIDGE_UNREACHABLE: () => ({
    label: m.error_bridge_unreachable_label(),
    hint: m.error_bridge_unreachable_hint(),
  }),
  INVALID_REQUEST: () => ({
    label: m.error_invalid_request_label(),
    hint: m.error_invalid_request_hint(),
  }),
  NOT_CONFIGURED: () => ({
    label: m.error_not_configured_label(),
    hint: m.error_not_configured_hint(),
  }),
  UNROUTED: () => ({
    label: m.error_unrouted_label(),
    hint: m.error_unrouted_hint(),
  }),
  UPSTREAM_ERROR: () => ({
    label: m.error_upstream_error_label(),
    hint: m.error_upstream_error_hint(),
  }),
  UNKNOWN: () => ({
    label: m.error_unknown_label(),
    hint: m.error_unknown_hint(),
  }),
};

/** Look up the admin info for a dispatch error code; falls back to the raw code. */
export function dispatchErrorInfo(
  code: string | undefined | null,
): DispatchErrorInfo {
  if (!code) return INFO.UNKNOWN!();
  return INFO[code]?.() ?? { label: code, hint: m.error_uncategorized_hint() };
}
