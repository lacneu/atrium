{
            "object": "hermes.api_server.capabilities", "platform": "hermes-agent",
            "model": self._model_name,
            "auth": {"type": "bearer", "required": bool(self._api_key)},
            "runtime": {
                "mode": "server_agent", "tool_execution": "server", "split_runtime": False,
                "description": (
                    "The API server creates a server-side Hermes AIAgent; "
                    "tools execute on the API-server host unless a future "
                    "explicit split-runtime mode is enabled.")},
            "features": {
                "chat_completions": True, "chat_completions_streaming": True,
                "responses_api": True, "responses_streaming": True, "run_submission": True,
                "runs_idempotency": _api_runs._idempotency_capabilities(self, store_type=RunIdempotencyStore),
                **_STATIC_FEATURE_FLAGS,
                "cors": bool(self._cors_origins),
                # Always advertised for feature-detection; enabled follows config.
                "browser_extension_control": {
                    "enabled": self._browser_control_enabled(),
                    "protocol_version": _BROWSER_CONTROL_PROTOCOL_VERSION,
                    "capabilities": sorted(BROWSER_CONTROL_CAPABILITIES),
                    "artifact_capabilities": sorted(BROWSER_CONTROL_ARTIFACT_CAPABILITIES),
                    "developer_capabilities": sorted(BROWSER_CONTROL_DEVELOPER_CAPABILITIES),
                    "developer_mode": self._browser_control_developer_mode(),
                    "artifact_transport": {
                        "upload": {"method": "POST", "path": "/v1/artifacts/upload"},
                        "download": {
                            "method": "GET", "path": "/v1/artifacts/download/{artifact_id}"},
                        "max_bytes": DEFAULT_MAX_ARTIFACT_BYTES,
                        "ttl_seconds": DEFAULT_ARTIFACT_TTL_SECONDS,
                        "allowed_mime_types": sorted(DEFAULT_ALLOWED_MIME_TYPES)},
                    "real_browser_actions": True,
                    "transports": {
                        "local_vps": "websocket-subprotocol-ticket",
                        "cloud": "authenticated-gateway-rpc"}}},
            "endpoints": {name: {"method": m, "path": p} for name, (m, p) in _CAPABILITY_ENDPOINTS},
        }

_STATIC_FEATURE_FLAGS = {
    "run_status": True, "run_events_sse": True, "run_stop": True, "run_steer": True,
    "run_approval_response": True, "tool_progress_events": True, "approval_events": True,
    "session_resources": True, "model_options": True, "session_chat": True,
    "session_chat_streaming": True, "session_fork": True, "session_model_lock": True,
    "reasoning_streaming": True,
    "admin_config_rw": False, "jobs_admin": False, "memory_write_api": False,
    "skills_api": True, "audio_api": False, "realtime_voice": False,
    "session_continuity_header": "X-Hermes-Session-Id",
    "session_key_header": "X-Hermes-Session-Key"}

_CAPABILITY_ENDPOINTS = (
    ("health", ("GET", "/health")), ("health_detailed", ("GET", "/health/detailed")),
    ("models", ("GET", "/v1/models")), ("model_options", ("GET", "/api/model/options")),
    ("chat_completions", ("POST", "/v1/chat/completions")),
    ("responses", ("POST", "/v1/responses")), ("runs", ("POST", "/v1/runs")),
    ("run_status", ("GET", "/v1/runs/{run_id}")),
    ("run_events", ("GET", "/v1/runs/{run_id}/events")),
    ("run_approval", ("POST", "/v1/runs/{run_id}/approval")),
    ("run_steer", ("POST", "/v1/runs/{run_id}/steer")),
    ("run_stop", ("POST", "/v1/runs/{run_id}/stop")), ("skills", ("GET", "/v1/skills")),
    ("toolsets", ("GET", "/v1/toolsets")), ("sessions", ("GET", "/api/sessions")),
    ("session_create", ("POST", "/api/sessions")),
    ("session", ("GET", "/api/sessions/{session_id}")),
    ("session_update", ("PATCH", "/api/sessions/{session_id}")),
    ("session_delete", ("DELETE", "/api/sessions/{session_id}")),
    ("session_messages", ("GET", "/api/sessions/{session_id}/messages")),
    ("session_fork", ("POST", "/api/sessions/{session_id}/fork")),
    ("session_chat", ("POST", "/api/sessions/{session_id}/chat")),
    ("session_chat_stream", ("POST", "/api/sessions/{session_id}/chat/stream")),
    ("session_model_lock", ("POST", "/api/sessions/{session_id}/model")),
    ("browser_control_register", ("POST", "/v1/browser-control/register")),
    ("browser_control_ws", ("GET", "/v1/browser-control/ws")),
    ("artifact_upload", ("POST", "/v1/artifacts/upload")),
    ("artifact_download", ("GET", "/v1/artifacts/download/{artifact_id}")))
