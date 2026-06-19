#!/usr/bin/env bash
# Bring up the SECOND local OpenClaw gateway (instance B), codex-harness, and pair
# bridge B's device. Mirror of up.sh for docker-compose.b.yml. Run AFTER ./up.sh.
#   OPENCLAW_IMAGE=neuolivier/openclaw-docker OPENCLAW_VERSION=2026.6.5 \
#     OPENCLAW_CODEX_HARNESS=1 ./up-b.sh
set -euo pipefail
cd "$(dirname "$0")"

PORT_B="${OPENCLAW_LOCAL_PORT_B:-18889}"
LOOP_B="${OPENCLAW_LOOPBACK_PORT_B:-18890}"

# 1) Token for gateway B (separate from A's ./.token).
if [[ ! -f .token-b ]]; then openssl rand -hex 32 > .token-b; fi
export OPENCLAW_GATEWAY_TOKEN_B="$(cat .token-b)"

[[ -f local.env ]] || cp local.env.example local.env
mkdir -p media-outbound-b media-inbound-b

echo "▶ starting oc-local-gateway-b (OpenClaw ${OPENCLAW_VERSION:-2026.5.19}) on :${PORT_B} …"
docker compose -f docker-compose.b.yml up -d

echo "▶ waiting for gateway B health …"
until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${PORT_B}/health 2>/dev/null)" == "200" ]]; do sleep 2; done
echo "✅ gateway B healthy on :${PORT_B}"

# 2) Codex harness (SAME ~/.codex as gateway A — user-approved for this bench).
CODEX_AUTH="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
SEED_FILE="seed/openclaw.json"
[[ -f seed/openclaw.local.json ]] && SEED_FILE="seed/openclaw.local.json"
if [[ "${OPENCLAW_CODEX_HARNESS:-0}" == "1" && -f "$CODEX_AUTH" && -f "$SEED_FILE" ]]; then
  echo "▶ enabling codex harness on gateway B (reusing $CODEX_AUTH) …"
  docker cp "$SEED_FILE" oc-local-gateway-b:/home/node/.openclaw/openclaw.json
  docker exec oc-local-gateway-b sh -c 'mkdir -p /home/node/.openclaw/.codex'
  docker cp "$CODEX_AUTH" oc-local-gateway-b:/home/node/.openclaw/.codex/auth.json
  docker exec -u root oc-local-gateway-b chown -R node:node \
    /home/node/.openclaw/openclaw.json /home/node/.openclaw/.codex 2>/dev/null || true
  docker restart oc-local-gateway-b >/dev/null
  echo "▶ waiting for reconfigured gateway B …"
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${PORT_B}/health 2>/dev/null)" == "200" ]]; do sleep 2; done
  echo "✅ codex harness ready on gateway B"
else
  echo "ℹ codex harness NOT enabled on B (no agent turns; routing/media still testable)."
fi

# 3) media node-owned (bind makes the parent root-owned otherwise).
docker exec -u root oc-local-gateway-b sh -c \
  'mkdir -p /home/node/.openclaw/media/inbound && chown -R node:node /home/node/.openclaw/media' >/dev/null 2>&1 || true

# 4) Re-attach loopback B (codex restart recreated the netns).
if docker ps -a --format '{{.Names}}' | grep -q '^oc-local-loopback-b$'; then
  docker restart oc-local-loopback-b >/dev/null 2>&1 || true
  echo "▶ waiting for loopback B forwarder (:${LOOP_B}) …"
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${LOOP_B}/health 2>/dev/null)" == "200" ]]; do sleep 1; done
  echo "✅ loopback B ready"
fi

# 5) Pair bridge B's device on gateway B (uses ../.env.b's identity over loopback B).
TOKEN_B="$(cat .token-b)"
echo "▶ registering pairing request on gateway B (bridge B identity) …"
( cd .. && OPENCLAW_GATEWAY_URL="ws://127.0.0.1:${LOOP_B}" OPENCLAW_TOKEN="$TOKEN_B" \
  node --env-file=.env.b -e '
    import("./dist/providers/openclaw/openclaw-client.js").then(async ({OpenClawConnection})=>{
      const {loadConfig}=await import("./dist/config.js"); const cfg=loadConfig();
      try{ const c=await OpenClawConnection.connect(process.env.OPENCLAW_GATEWAY_URL, process.env.OPENCLAW_TOKEN, cfg.deviceIdentity); c.close(); }
      catch(e){} process.exit(0);
    });' >/dev/null 2>&1 ) || true
sleep 1
PENDING="$(docker exec oc-local-gateway-b node /app/openclaw.mjs devices list --json --token "$TOKEN_B" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);(j.pending||[]).forEach(p=>console.log(p.requestId))}catch{}})')"
for req in $PENDING; do
  docker exec oc-local-gateway-b node /app/openclaw.mjs devices approve "$req" --token "$TOKEN_B" >/dev/null 2>&1 \
    && echo "  ✅ approved $req" || echo "  ⚠ approve failed $req"
done
echo "✅ gateway B ready (token ./.token-b). Bridge B: ws://127.0.0.1:${LOOP_B}, port 8791."
