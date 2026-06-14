#!/usr/bin/env bash
# LIVE-PROTOCOL runner: boots a PINNED, UNCONFIGURED OpenClaw gateway (no codex
# harness, no LLM, fully deterministic), a Convex-ingest stub and a fresh
# bridge, then runs test-live-protocol.mjs — expectations derived from the
# compat manifest for that version. The standard pre-release regression net;
# the future CI job runs exactly this, matrixed over the manifest's
# validatedVersions.
#   ./test-live-protocol.sh                # default 2026.5.19 (support floor)
#   ./test-live-protocol.sh 2026.6.5
# ⚠ Runs ./reset.sh: wipes the bench gateway state (incl. any codex-harness
#   login). Re-enable the harness afterwards with OPENCLAW_CODEX_HARNESS=1 ./up.sh.
set -uo pipefail
cd "$(dirname "$0")"

VERSION="${1:-2026.5.19}"
REPO="$(cd .. && pwd)"
BRIDGE_PORT=18901
STUB_PORT=18902
LOOPBACK="${OPENCLAW_LOOPBACK_PORT:-18790}"
INGEST_LOG=/tmp/proto-ingest.jsonl
SHARED_SECRET=proto-shared-secret
INGEST_SECRET=proto-ingest-secret

cleanup() {
  [[ -n "${BRIDGE_PID:-}" ]] && kill "$BRIDGE_PID" 2>/dev/null
  [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null
}
trap cleanup EXIT

# Free the suite's ports up-front: a stray bridge/stub from an earlier manual
# session would EADDRINUSE the fresh one and fail the whole run spuriously.
for port in "$BRIDGE_PORT" "$STUB_PORT"; do
  STALE="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$STALE" ]] && { echo "▶ freeing :$port (stale pid $STALE)"; kill $STALE 2>/dev/null; sleep 1; }
done

echo "════════ live-protocol — OpenClaw $VERSION ════════"

# 1) Pinned, deterministic gateway: reset (wipe) + up WITHOUT the codex harness.
./reset.sh >/dev/null 2>&1 || true
OPENCLAW_VERSION="$VERSION" OPENCLAW_CODEX_HARNESS=0 ./up.sh >/tmp/proto-up.log 2>&1 \
  || { echo "❌ up.sh failed (see /tmp/proto-up.log)"; exit 1; }

# 1b) Provenance contract fixture (C18): the probe plugin emits deterministic
# provenance/v1 reports every turn (docs/PROVENANCE_CONTRACT.md in the webchat
# repo). Version-aware: on an SDK without emitAgentEvent the probe logs a
# marker and stays silent — the suite reads gateway logs to pick the branch.
./install-provenance-probe.sh >/tmp/proto-probe.log 2>&1 \
  || { echo "❌ install-provenance-probe.sh failed (see /tmp/proto-probe.log)"; exit 1; }

# 2) Fresh bridge build (the suite tests the CURRENT source).
( cd "$REPO" && npm run build >/tmp/proto-build.log 2>&1 ) \
  || { echo "❌ bridge build failed (see /tmp/proto-build.log)"; exit 1; }

# 3) Convex-ingest stub (records ops; answers minimal writer shapes).
node ingest-stub.mjs --port "$STUB_PORT" --secret "$INGEST_SECRET" --log "$INGEST_LOG" \
  >/tmp/proto-stub.log 2>&1 &
STUB_PID=$!

# 4) The bridge under test. --env-file supplies ONLY the paired device identity;
#    explicit env (which Node gives precedence) redirects everything else at the
#    bench + stub — never at a real Convex deployment.
TOKEN="$(cat .token)"
( cd "$REPO" && \
  OPENCLAW_GATEWAY_URL="ws://127.0.0.1:$LOOPBACK" \
  OPENCLAW_TOKEN="$TOKEN" \
  OPENCLAW_INSTANCE_NAME=bench \
  CONVEX_HTTP_ACTIONS_URL="http://127.0.0.1:$STUB_PORT" \
  BRIDGE_INGEST_SECRET="$INGEST_SECRET" \
  BRIDGE_SHARED_SECRET="$SHARED_SECRET" \
  BRIDGE_PORT="$BRIDGE_PORT" \
  OPENCLAW_MEDIA_OUTBOUND_DIR="$(pwd)/media-outbound" \
  node --env-file=.env dist/index.js >/tmp/proto-bridge.log 2>&1 & )
sleep 1
BRIDGE_PID="$(lsof -t -iTCP:$BRIDGE_PORT -sTCP:LISTEN 2>/dev/null || true)"

echo "▶ waiting for bridge :$BRIDGE_PORT …"
for _ in $(seq 1 20); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$BRIDGE_PORT/health" 2>/dev/null)" == "200" ]] && break
  sleep 1
done

# 5) The suite (version-aware expectations from dist/compat.js).
BRIDGE_URL="http://127.0.0.1:$BRIDGE_PORT" SHARED_SECRET="$SHARED_SECRET" INGEST_LOG="$INGEST_LOG" \
  node test-live-protocol.mjs --version "$VERSION"
EXIT=$?

[[ $EXIT -ne 0 ]] && { echo "—— bridge log tail ——"; tail -25 /tmp/proto-bridge.log; }
exit $EXIT
