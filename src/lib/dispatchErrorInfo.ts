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

/** What an anomaly's evidence can say about WHERE the cause sits, for the hints whose
 *  fix names an agent or a provider. Ids only. */
export interface DispatchErrorContext {
  agentId?: string;
  provider?: string;
}

// code → resolver (re-localizes FR↔EN at call time via Paraglide).
const INFO: Record<string, (ctx: DispatchErrorContext) => DispatchErrorInfo> = {
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
  // Named connection ends: an operator reading "socket closed" would go looking
  // for a network fault, when the gateway had in fact ANNOUNCED its restart, or
  // hung up because we were reading too slowly. Different investigations.
  GATEWAY_RESTARTING: () => ({
    label: m.error_gateway_restarting_label(),
    hint: m.error_gateway_restarting_hint(),
  }),
  CONNECTION_SATURATED: () => ({
    label: m.error_connection_saturated_label(),
    hint: m.error_connection_saturated_hint(),
  }),
  DISPATCH_STALLED: () => ({
    label: m.error_dispatch_stalled_label(),
    hint: m.error_dispatch_stalled_hint(),
  }),
  ATTACHMENT_TOO_LARGE: () => ({
    label: m.error_attachment_too_large_label(),
    hint: m.error_attachment_too_large_hint(),
  }),
  ATTACHMENT_REJECTED: () => ({
    label: m.error_attachment_rejected_label(),
    hint: m.error_attachment_rejected_hint(),
  }),
  BRIDGE_UNREACHABLE: () => ({
    label: m.error_bridge_unreachable_label(),
    hint: m.error_bridge_unreachable_hint(),
  }),
  INVALID_REQUEST: () => ({
    label: m.error_invalid_request_label(),
    hint: m.error_invalid_request_hint(),
  }),
  chat_request_conflict: () => ({
    label: m.error_chat_request_conflict_label(),
    hint: m.error_chat_request_conflict_hint(),
  }),
  NOT_CONFIGURED: () => ({
    label: m.error_not_configured_label(),
    hint: m.error_not_configured_hint(),
  }),
  UNROUTED: () => ({
    label: m.error_unrouted_label(),
    hint: m.error_unrouted_hint(),
  }),
  message_too_large: () => ({
    label: m.error_message_too_large_label(),
    hint: m.error_message_too_large_hint(),
  }),
  subagent_reply_pending: () => ({
    label: m.error_subagent_reply_pending_label(),
    hint: m.error_subagent_reply_pending_hint(),
  }),
  attachment_name_too_long: () => ({
    label: m.error_attachment_name_too_long_label(),
    hint: m.error_attachment_name_too_long_hint(),
  }),
  attachment_path_refused: () => ({
    label: m.error_attachment_path_refused_label(),
    hint: m.error_attachment_path_refused_hint(),
  }),
  attachment_staging_failed: () => ({
    label: m.error_attachment_staging_failed_label(),
    hint: m.error_attachment_staging_failed_hint(),
  }),
  attachment_cleanup_unconfirmed: () => ({
    label: m.error_attachment_cleanup_unconfirmed_label(),
    hint: m.error_attachment_cleanup_unconfirmed_hint(),
  }),
  // The provider refused the credential this AGENT used. The hint is READ-ONLY diagnosis:
  // a per-agent login would write a separate copy into that agent's own store
  // (upstream src/agents/auth-profiles/shared-store-bootstrap.ts:229-245) and mask the
  // instance's shared login, which is not a fix. The commands exist in v2026.9.6
  // (src/cli/models-cli.ts:331-336 `models auth list`, :524-531 `models auth order get`).
  // Filled from the anomaly when it names exactly one agent and one provider; the
  // placeholders stay otherwise, so a command never aims at a guess.
  provider_auth_revoked: (ctx) => ({
    label: m.error_provider_auth_revoked_label(),
    hint: m.error_provider_auth_revoked_hint({
      agentId: ctx.agentId ?? "<agentId>",
      provider: ctx.provider ?? "<provider>",
    }),
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
  ctx: DispatchErrorContext = {},
): DispatchErrorInfo {
  if (!code) return INFO.UNKNOWN!(ctx);
  return INFO[code]?.(ctx) ?? { label: code, hint: m.error_uncategorized_hint() };
}
