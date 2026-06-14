#!/usr/bin/env bash
# Bring up the ephemeral local OpenClaw gateway, then auto-pair the bridge device.
#   ./up.sh                 # default version (2026.5.19)
#   OPENCLAW_VERSION=2026.6.1 ./up.sh
# Idempotent-ish: re-running reuses the existing token (./.token).
set -euo pipefail
cd "$(dirname "$0")"

# 1) Fresh token (reused across up/down of the same run; reset.sh clears it).
if [[ ! -f .token ]]; then openssl rand -hex 32 > .token; fi
export OPENCLAW_GATEWAY_TOKEN="$(cat .token)"

# 2) local.env must exist (model keys / agent overrides — may be empty).
[[ -f local.env ]] || cp local.env.example local.env

# 3) Shared media dir (host bind read by a Mac bridge).
mkdir -p media-outbound

echo "▶ starting oc-local-gateway (OpenClaw ${OPENCLAW_VERSION:-2026.5.19}) …"
docker compose up -d

echo "▶ waiting for gateway health …"
until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${OPENCLAW_LOCAL_PORT:-18789}/health 2>/dev/null)" == "200" ]]; do
  sleep 2
done
echo "✅ gateway healthy on :${OPENCLAW_LOCAL_PORT:-18789}"

# 4) CODEX HARNESS MODE (opt-in): inject the local codex login + seed so the
# agent runs on the ChatGPT subscription. ⚠ FOOTGUN: two gateways refreshing
# the SAME OpenAI account's oauth tokens rotate each other out → 401 "token
# invalidated" (observed when an auth.json was copied to a second gateway).
# The local codex account MUST be a DIFFERENT OpenAI account than any
# production gateway. Never copy this file to another gateway; re-check
# identities if either login changes. Gated behind an explicit env var as a
# standing guard.
# Seed: seed/openclaw.local.json (gitignored, your own agents/auth profile)
# wins over the generic committed seed/openclaw.json.
CODEX_AUTH="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
SEED_FILE="seed/openclaw.json"
[[ -f seed/openclaw.local.json ]] && SEED_FILE="seed/openclaw.local.json"
if [[ "${OPENCLAW_CODEX_HARNESS:-0}" != "1" ]]; then
  echo "ℹ codex harness DISABLED (default). Gateway stays unconfigured: discovery,"
  echo "  sessions.patch/config/agents.files probes work; LLM turns do not."
  echo "  Enable with: OPENCLAW_CODEX_HARNESS=1 ./up.sh"
  echo "  (safe iff ~/.codex/auth.json is a DIFFERENT OpenAI account than any production gateway)"
elif [[ -f "$CODEX_AUTH" && -f "$SEED_FILE" ]]; then
  echo "▶ enabling codex harness mode (reusing $CODEX_AUTH, seed: $SEED_FILE) …"
  docker cp "$SEED_FILE" oc-local-gateway:/home/node/.openclaw/openclaw.json
  docker exec oc-local-gateway sh -c 'mkdir -p /home/node/.openclaw/.codex'
  docker cp "$CODEX_AUTH" oc-local-gateway:/home/node/.openclaw/.codex/auth.json
  docker exec -u root oc-local-gateway chown -R node:node \
    /home/node/.openclaw/openclaw.json /home/node/.openclaw/.codex 2>/dev/null || true
  docker restart oc-local-gateway >/dev/null
  echo "▶ waiting for reconfigured gateway …"
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${OPENCLAW_LOCAL_PORT:-18789}/health 2>/dev/null)" == "200" ]]; do sleep 2; done
  echo "✅ codex harness ready (agents from $SEED_FILE, turns run on your codex subscription)"
else
  echo "ℹ codex auth or seed missing → gateway stays unconfigured (no agent turns; media-share still testable)."
fi

# 4b) Inbound media: the media/outbound bind makes docker create the parent
# /home/node/.openclaw/media root-owned, so the gateway (node) can't mkdir
# media/inbound to offload USER-sent attachments (EACCES). Make media node-owned.
docker exec -u root oc-local-gateway sh -c \
  'mkdir -p /home/node/.openclaw/media/inbound && chown -R node:node /home/node/.openclaw/media' \
  >/dev/null 2>&1 || true

# 4c) Re-attach the loopback sidecar (#61). The codex setup above did
# `docker restart oc-local-gateway`, which recreates the gateway's network
# namespace — orphaning oc-loopback (network_mode: service:openclaw). Restart it
# so socat re-binds inside the CURRENT netns; otherwise :18790 forwards nowhere
# and the bridge's "trusted loopback" connect path is dead.
if docker ps -a --format '{{.Names}}' | grep -q '^oc-local-loopback$'; then
  docker restart oc-local-loopback >/dev/null 2>&1 || true
  echo "▶ waiting for loopback forwarder (:${OPENCLAW_LOOPBACK_PORT:-18790}) …"
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${OPENCLAW_LOOPBACK_PORT:-18790}/health 2>/dev/null)" == "200" ]]; do sleep 1; done
  echo "✅ loopback forwarder ready (trusted-transport path for the host bridge)"
fi

# 5) Auto-pair the bridge's device (token auth still needs device approval).
./pair.sh

cat <<EOF

✅ Local OpenClaw ready. To run the bridge against it:
   cd .. && OPENCLAW_GATEWAY_URL=ws://127.0.0.1:${OPENCLAW_LOOPBACK_PORT:-18790} \\
     OPENCLAW_TOKEN=$(cat .token) \\
     OPENCLAW_MEDIA_OUTBOUND_DIR=$(pwd)/media-outbound \\
     node dist/index.js
   (or pass the same overrides to npm start)

NOTE (#61): connect over :${OPENCLAW_LOOPBACK_PORT:-18790} (the oc-loopback sidecar), NOT :18789.
The gateway only admits the shared token from a TRUSTED transport; :18790 forwards
to the gateway's loopback so the host bridge is seen as loopback. Production
gateways use wss (also trusted) and do not need this.

Token: ./.token   |   Shared media: ./media-outbound   |   Stop: ./down.sh   |   Wipe: ./reset.sh
EOF
