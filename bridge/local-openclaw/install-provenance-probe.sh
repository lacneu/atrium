#!/usr/bin/env bash
# Install the provenance-probe fixture plugin into the RUNNING bench gateway.
# Bench/CI tooling only — the probe emits deterministic provenance/v1 frames
# every turn so the live-protocol suite (C18) can pin the contract against a
# real gateway. Idempotent: re-running re-copies the code and re-applies config.
#   ./install-provenance-probe.sh
set -euo pipefail
cd "$(dirname "$0")"

CID=oc-local-gateway
PORT="${OPENCLAW_LOOPBACK_PORT:-18790}"

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
docker exec "$CID" node /app/openclaw.mjs plugins install /tmp/provenance-probe --force >/dev/null
docker exec "$CID" node /app/openclaw.mjs config set plugins.entries.provenance-probe.enabled true --json >/dev/null

echo "▶ restarting gateway to load the plugin …"
docker restart "$CID" >/dev/null
until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:18789/health 2>/dev/null)" == "200" ]]; do sleep 2; done

# Re-attach the loopback sidecar (#61): the restart recreated the gateway's
# netns, orphaning oc-local-loopback — same fix as up.sh step 4c.
if docker ps -a --format '{{.Names}}' | grep -q '^oc-local-loopback$'; then
  docker restart oc-local-loopback >/dev/null 2>&1 || true
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null)" == "200" ]]; do sleep 1; done
fi

docker logs "$CID" --since 30s 2>&1 | grep -i "provenance-probe\|plugins" | tail -5 || true
echo "✅ provenance-probe installed (watch gateway logs for '[provenance-probe] emitted' per turn)"
