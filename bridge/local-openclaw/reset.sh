#!/usr/bin/env bash
# Wipe ALL state → the next ./up.sh is fully PRISTINE (no cross-test leakage):
# removes the container + the ephemeral state volume + the shared media files +
# the token. local.env (your model keys) is kept.
set -euo pipefail
cd "$(dirname "$0")"
export OPENCLAW_GATEWAY_TOKEN="$(cat .token 2>/dev/null || echo placeholder)"
docker compose down -v --remove-orphans 2>/dev/null || true
rm -f .token
rm -rf media-outbound
echo "✅ wiped (state volume + media + token). Next ./up.sh starts pristine."
