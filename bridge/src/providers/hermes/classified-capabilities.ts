// The capability surface Hermes PUBLISHES about itself, and what Atrium has said about it.
//
// G-70's Hermes half. The mirror of `CLASSIFIED_EVENTS` on the OpenClaw side, and it
// exists for the same reason: `GET /v1/capabilities` is upstream's own statement of what
// it offers, and a capability nobody has looked at should be known BEFORE a user meets
// the feature that needed it.
//
// Kept as a literal rather than read from `protocol/hermes/features/<version>.json`: the
// bridge runs from `dist/` in a container where `protocol/` is not on disk.
// `hermes-features-coverage.test.ts` asserts this set EQUALS the manifest, so it cannot
// drift from the classification it mirrors.

/** Capability names someone has classified — read, or deliberately not read with a reason. */
export const CLASSIFIED_HERMES_CAPABILITIES: ReadonlySet<string> = new Set([
  "admin_config_rw",
  "approval_events",
  "audio_api",
  "chat_completions",
  "chat_completions_streaming",
  "cors",
  "jobs_admin",
  "memory_write_api",
  "realtime_voice",
  "responses_api",
  "responses_streaming",
  "run_approval_response",
  "run_events_sse",
  "run_status",
  "run_stop",
  "run_submission",
  "session_chat",
  "session_chat_streaming",
  "session_continuity_header",
  "session_fork",
  "session_key_header",
  "session_resources",
  "skills_api",
  "tool_progress_events",
]);
