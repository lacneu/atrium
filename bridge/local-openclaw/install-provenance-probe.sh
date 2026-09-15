#!/usr/bin/env bash
# Install the provenance-probe fixture plugin into the RUNNING bench gateway.
# Bench/CI tooling only — the probe emits deterministic provenance/v1 frames
# every turn so the live-protocol suite (C18) can pin the contract against a
# real gateway. Idempotent: re-running re-copies the code and re-applies config.
#   ./install-provenance-probe.sh
set -euo pipefail
cd "$(dirname "$0")"

CID=oc-local-gateway
GATEWAY_PORT="${OPENCLAW_LOCAL_PORT:-18789}"
PORT="${OPENCLAW_LOOPBACK_PORT:-18790}"
# Bounded waits: a gateway that never comes back must fail the caller, not hang it.
WAIT_S="${PROBE_INSTALL_WAIT_S:-180}"
wait_healthy() { # <url> <what>
  local deadline=$((SECONDS + WAIT_S))
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null)" == "200" ]]; do
    if (( SECONDS >= deadline )); then echo "❌ $2 not healthy after ${WAIT_S}s ($1)" >&2; exit 1; fi
    sleep 2
  done
}

echo "▶ installing provenance-probe into $CID …"
# tar pipe, NOT `docker cp`: on this (emulated) container docker cp exits 0
# without writing anything — verified live 2026-06-12.
docker exec "$CID" sh -c 'rm -rf /tmp/provenance-probe'
tar -C plugins -c provenance-probe 2>/dev/null | docker exec -i "$CID" tar -x -C /tmp 2>/dev/null
# Plugin loader refuses world-writable paths — normalize ownership + mode.
docker exec -u root "$CID" sh -c \
  'chown -R node:node /tmp/provenance-probe && chmod -R 755 /tmp/provenance-probe'

# TRACKED install via the gateway CLI (registers plugins.installs + enables).
# ⚠ NEVER set plugins.allow here: an allowlist DISABLES every stock plugin not
# named in it — model PROVIDERS included, which breaks model resolution
# ("Unknown model") for the whole gateway. Verified live 2026-06-12.
# --accept-capabilities: since 2026.9.x the CLI refuses a non-interactive install until the plugin's
# declared surface is accepted (upstream src/cli/plugin-capability-consent.ts — the flag returns the
# review token). GRANTS, stated exactly (src/plugins/hook-policy-decisions.ts): prompt injection is
# ALLOWED unless set to false — and it must stay allowed, `before_prompt_build` being a prompt-injection
# hook that `allowPromptInjection=false` blocks at registration (registry-registrars-tools-hooks.ts);
# conversation access is granted explicitly below. The hook therefore receives the prompt and the
# messages. The probe is this repo's bench fixture: its hook returns nothing (no injection) and only
# emits its reports — and it runs on EVERY turn of the gateway, sub-agents and other chats included.
docker exec "$CID" node /app/openclaw.mjs plugins install /tmp/provenance-probe --force --accept-capabilities >/dev/null
docker exec "$CID" node /app/openclaw.mjs config set plugins.entries.provenance-probe.enabled true --json >/dev/null
# The probe's hook is `before_prompt_build`, a CONVERSATION hook (upstream src/plugins/hook-types.ts
# CONVERSATION_HOOK_NAMES): for a non-bundled plugin it is blocked at load unless this is exactly true
# (src/plugins/hook-policy-decisions.ts resolveConversationAccessAllowed) — measured 2026-09-15:
# "typed hook before_prompt_build blocked because non-bundled plugins must set ...allowConversationAccess=true".
docker exec "$CID" node /app/openclaw.mjs config set plugins.entries.provenance-probe.hooks.allowConversationAccess true --json >/dev/null
# …and prompt injection PINNED to the value the hook needs: its upstream default is already "allowed",
# but a value left at false by an earlier configuration would survive a reinstall and block the hook.
docker exec "$CID" node /app/openclaw.mjs config set plugins.entries.provenance-probe.hooks.allowPromptInjection true --json >/dev/null

echo "▶ restarting gateway to load the plugin …"
docker restart "$CID" >/dev/null
wait_healthy "http://127.0.0.1:${GATEWAY_PORT}/health" "gateway"

# Re-attach the loopback sidecar (#61): the restart recreated the gateway's
# netns, orphaning oc-local-loopback — same fix as up.sh step 4c.
if docker ps -a --format '{{.Names}}' | grep -q '^oc-local-loopback$'; then
  docker restart oc-local-loopback >/dev/null 2>&1 || true
  wait_healthy "http://127.0.0.1:${PORT}/health" "loopback sidecar"
fi

docker logs "$CID" --since 30s 2>&1 | grep -i "provenance-probe\|plugins" | tail -5 || true
echo "✅ provenance-probe installed (watch gateway logs for '[provenance-probe] emitted' per turn)"
