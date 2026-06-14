#!/usr/bin/env bash
# Per-version STABILITY test (feeds docs/OPENCLAW_VERSION_STABILITY.md). Runs N
# codex file-creation turns on a given OpenClaw version and tallies the terminal
# outcome per turn: complete | error (attachment produced but turn errored) |
# no-attach (timeout / no attachment). Surfaces instability like the
# "codex app-server client closed before turn completed" we saw on 5.19.
#   ./test-stability.sh 2026.5.19 8
#   ./test-stability.sh 2026.6.1 8
# Env: emulated amd64-on-arm64 (Docker Desktop Mac), codex harness (ChatGPT Pro).
set -uo pipefail
cd "$(dirname "$0")"

# ⚠ This test NEEDS the codex harness (real LLM turns). Standing guard against
# the oauth-rotation footgun: two gateways on the SAME OpenAI account rotate
# each other's oauth tokens out (401 "token invalidated"). The local codex
# account MUST be a DIFFERENT OpenAI account than any production gateway.
# Opt in explicitly after checking identities.
if [[ "${OPENCLAW_CODEX_HARNESS:-0}" != "1" ]]; then
  echo "❌ refusing: codex harness required. After verifying ~/.codex/auth.json is"
  echo "   a DIFFERENT OpenAI account than any production gateway:  OPENCLAW_CODEX_HARNESS=1 $0 $*"
  exit 1
fi
VERSION="${1:?usage: ./test-stability.sh <version> [N]}"
N="${2:-6}"
REPO="$(cd .. && pwd)"
# The convex CLI must run from the WEBCHAT repo (the bridge was extracted to its
# own repo in C3 and no longer carries the convex dependency / deployment config).
WEBCHAT="${WEBCHAT_DIR:-$(cd ../../atrium && pwd)}"
cvx() { (cd "$WEBCHAT" && npx convex run "$@"); }
# Target chat in YOUR Convex dev deployment (no committed default): a chat id
# the bridge may write into, e.g. created via the webchat UI.
CHAT="${STAB_CHAT:-${FX_CHAT:-}}"
if [[ -z "$CHAT" ]]; then
  echo "❌ STAB_CHAT (or FX_CHAT) is required: set it to a chat id from YOUR Convex"
  echo "   dev deployment, e.g.  STAB_CHAT=<chatId> OPENCLAW_CODEX_HARNESS=1 $0 $*"
  exit 1
fi
PORT=18790

echo "════════ stability — OpenClaw $VERSION — $N turns ════════"
./reset.sh >/dev/null 2>&1 || true
OPENCLAW_VERSION="$VERSION" OPENCLAW_CODEX_HARNESS=1 ./up.sh >/tmp/stab-up.log 2>&1 || { echo "❌ up.sh failed"; exit 1; }
grep -q "codex harness ready" /tmp/stab-up.log || { echo "❌ codex harness not enabled"; exit 1; }
OLD=$(lsof -t -iTCP:8787 -sTCP:LISTEN 2>/dev/null); [ -n "$OLD" ] && kill "$OLD" 2>/dev/null; sleep 1
TOKEN="$(cat .token)"
( cd "$REPO" && OPENCLAW_GATEWAY_URL="ws://127.0.0.1:$PORT" OPENCLAW_TOKEN="$TOKEN" \
    OPENCLAW_MEDIA_OUTBOUND_DIR="$(pwd)/media-outbound" nohup node --env-file=.env dist/index.js \
    >/tmp/stab-bridge.log 2>&1 & )
sleep 20  # settle (cold-start handshake)

cd "$REPO"
# Measure TURN STATUS (complete/error) — the direct signal of app-server stability
# (the "codex app-server client closed" irritation), independent of whether the
# agent emitted a MEDIA: directive (that's agent compliance, a different axis).
terminal_of='import json,sys
before=float(sys.argv[1]); d=json.load(sys.stdin) or {}
lc=d.get("lastCreated",0); lr=d.get("lastRole"); ls=d.get("lastStatus")
if lc>before and lr=="assistant" and ls in ("complete","error"):
    print(ls+("|"+(d.get("lastError") or "") if ls=="error" else ""))
else: print("")'
complete=0; error=0; timeout=0; ERRS=""
for i in $(seq 1 "$N"); do
  before=$(cvx dev:chatStats "{\"chatId\":\"$CHAT\"}" 2>/dev/null | python3 -c "import json,sys;print((json.load(sys.stdin) or {}).get('lastCreated',0))")
  PROMPT="Écris un court fichier markdown nommé stab-$i.md (3 lignes de liste) dans ton workspace, puis confirme en une phrase."
  ARGS=$(python3 -c "import json,sys;print(json.dumps({'chatId':sys.argv[1],'text':sys.argv[2]}))" "$CHAT" "$PROMPT")
  cvx dev:testSend "$ARGS" >/dev/null 2>&1 || true
  st=""
  for _ in $(seq 1 45); do
    OUT=$(cvx dev:chatStats "{\"chatId\":\"$CHAT\"}" 2>/dev/null | python3 -c "$terminal_of" "${before:-0}")
    [ -n "$OUT" ] && { st="$OUT"; break; }
    sleep 4
  done
  case "${st%%|*}" in
    complete) complete=$((complete+1)); echo "  turn $i: ✅ complete";;
    error)    error=$((error+1)); ERRS="$ERRS\n    - ${st#*|}"; echo "  turn $i: ⚠ ERROR: ${st#*|}";;
    *)        timeout=$((timeout+1)); echo "  turn $i: ✗ no terminal status (timeout)";;
  esac
done
echo "──────── $VERSION: $N turns → complete=$complete  error=$error  timeout=$timeout"
if [ -n "$ERRS" ]; then printf "  error types:%b\n" "$ERRS"; fi
exit 0
