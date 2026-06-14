#!/bin/sh
# =============================================================================
# Codex YOLO wrapper — inject -c approval_policy + -c sandbox_mode
# =============================================================================
# Purpose
# -------
# The OpenClaw 5.x Codex app-server runs as a child process with its own
# approval AND sandbox layers, INDEPENDENT from OpenClaw's tools.exec /
# exec-approvals.json layer (cf. fix #82372 in 5.16-beta.2 which closed the
# previous bypass). To get full YOLO at the Codex layer we must disable
# BOTH layers — the approval policy AND the sandbox.
#
# Important: the global `--dangerously-bypass-approvals-and-sandbox` /
# `--yolo` flag listed in the top-level codex CLI reference is NOT
# accepted by the `app-server` subcommand (which is what OpenClaw spawns).
# `codex app-server --help` only exposes `-c, --config <key=value>` for
# config overrides. We must therefore go via -c, NOT via --yolo, when the
# wrapped invocation is for app-server.
#
# Solution
# --------
# Override both layers via -c, both as TOML string values:
#   -c approval_policy="never"           (Codex CLI: untrusted|on-request|never)
#   -c sandbox_mode="danger-full-access" (Codex CLI: read-only|workspace-write|
#                                                    danger-full-access)
# Together these reproduce the effect of --yolo, but at the level the
# app-server actually understands.
#
# Hardening context
# -----------------
# Our OpenClaw setup is externally hardened so this YOLO is acceptable at
# the Codex layer (defense in depth still applies at the OpenClaw + host
# layers):
#   - Container runs as a non-root user with cap_drop:ALL and
#     no-new-privileges:true (production compose).
#   - Filesystem isolated by Docker; only bind-mounts are writable.
#   - Network on a Docker bridge; gateway behind a reverse proxy, LAN-only.
#   - OpenClaw's own tools.exec / exec-approvals.json gate at the OpenClaw
#     layer (preset yolo applied separately).
#
# Wiring
# ------
# OpenClaw launches the Codex binary pointed to by OPENCLAW_CODEX_APP_
# SERVER_BIN (set in docker-compose.yml to this wrapper). OpenClaw passes
# its own args (typically `app-server [...]`); our -c overrides are
# appended at the end. If OpenClaw passes its own -c approval_policy=
# anything BEFORE ours, the last -c on the command line wins (Codex CLI
# precedence rule), so we're protected.
#
# History (lessons learned)
# -------------------------
# 2026-05-22 v1: passed `-c approval_policy="never"` only. Disabled the
# approval policy but the SANDBOX layer kept gating exec calls (printf,
# set -eu, curl), producing persistent "Codex app-server command approval"
# popups. The sandbox override was MISSING.
# 2026-05-22 v2: switched to --dangerously-bypass-approvals-and-sandbox.
# But that flag is NOT accepted by the `app-server` subcommand (only by
# the top-level codex CLI for interactive use). Result: `codex app-server
# exited code=2 stderr="error: unexpected argument '--dangerously-bypass-
# approvals-and-sandbox' found"`. Codex app-server crashed at startup.
# 2026-05-22 v3 (this file): back to -c overrides, but BOTH approval_policy
# AND sandbox_mode this time. Both are valid -c keys for app-server and
# together cover what --yolo would have done.
#
# Removal condition
# -----------------
# Remove this wrapper (revert OPENCLAW_CODEX_APP_SERVER_BIN to bare
# /usr/local/bin/codex) when OpenClaw exposes a native global passthrough
# for the Codex app-server approval/sandbox policies.
# =============================================================================

exec /usr/local/bin/codex "$@" \
    -c 'approval_policy="never"' \
    -c 'sandbox_mode="danger-full-access"'
