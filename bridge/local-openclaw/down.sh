#!/usr/bin/env bash
# Stop the local gateway (keeps the ephemeral state volume + token + media for a
# quick restart). Use reset.sh to wipe everything for a pristine next run.
set -euo pipefail
cd "$(dirname "$0")"
export OPENCLAW_GATEWAY_TOKEN="$(cat .token 2>/dev/null || echo placeholder)"
docker compose down
echo "✅ gateway stopped (state kept — ./reset.sh to wipe)"
