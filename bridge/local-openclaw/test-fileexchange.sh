#!/usr/bin/env bash
# Per-version OUTBOUND file-exchange smoke test (tasks #56/#57). Boots the harness
# on a given OpenClaw version (codex harness mode), runs the bridge, sends a
# MEDIA: prompt, and asserts the attachment renders correctly:
#   (1) exactly ONE media part   (2) byte-exact download   (3) NO dead ./media link
#   ./test-fileexchange.sh 2026.5.19
#   ./test-fileexchange.sh 2026.6.1
# "All implementations test both versions" = run this for each version on a bump.
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
VERSION="${1:?usage: ./test-fileexchange.sh <openclaw-version>}"
REPO="$(cd .. && pwd)"
# Convex CLI runs from the WEBCHAT repo (bridge extracted in C3, no convex dep).
WEBCHAT="${WEBCHAT_DIR:-$(cd ../../atrium && pwd)}"
cvx() { (cd "$WEBCHAT" && npx convex run "$@"); }
# Target chat in YOUR Convex dev deployment (no committed default): a chat id
# the bridge may write into, e.g. created via the webchat UI.
CHAT="${FX_CHAT:-}"
if [[ -z "$CHAT" ]]; then
  echo "❌ FX_CHAT is required: set it to a chat id from YOUR Convex dev deployment,"
  echo "   e.g.  FX_CHAT=<chatId> OPENCLAW_CODEX_HARNESS=1 $0 $*"
  exit 1
fi
MEDIA_DIR="$(pwd)/media-outbound"
PORT=18790
fail(){ echo "❌ FAIL [$VERSION]: $1"; exit 1; }
jq_field(){ python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('$1','') if d else '')"; }

echo "════════ file-exchange smoke test — OpenClaw $VERSION ════════"

# 1) pristine harness on this version (codex harness auto-configured by up.sh).
./reset.sh >/dev/null 2>&1 || true
OPENCLAW_VERSION="$VERSION" OPENCLAW_CODEX_HARNESS=1 ./up.sh >/tmp/fx-up.log 2>&1 || fail "up.sh failed (see /tmp/fx-up.log)"
grep -q "codex harness ready" /tmp/fx-up.log || echo "  ⚠ codex harness NOT enabled — agent turns will fail (need ~/.codex/auth.json)"

# 2) (re)start the local bridge on :8787 against the fresh gateway.
OLD=$(lsof -t -iTCP:8787 -sTCP:LISTEN 2>/dev/null); [ -n "$OLD" ] && kill "$OLD" 2>/dev/null; sleep 1
TOKEN="$(cat .token)"
( cd "$REPO" && OPENCLAW_GATEWAY_URL="ws://127.0.0.1:$PORT" OPENCLAW_TOKEN="$TOKEN" \
    OPENCLAW_MEDIA_OUTBOUND_DIR="$MEDIA_DIR" nohup node --env-file=.env dist/index.js \
    >/tmp/fx-bridge.log 2>&1 & )
sleep 2; lsof -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1 || fail "bridge did not start"
# Settle: the gateway just (re)started in up.sh's codex-setup; let it finish
# plugin/codex init so the first WS handshake completes within CONNECT_TIMEOUT_MS
# (emulated amd64-on-arm64 is slow). The bridge connects lazily on the send.
echo "  settling gateway warm-up…"; sleep 20

# 3) send a MEDIA: prompt (filename carries the version; agent writes it + emits MEDIA:).
FN="fx-${VERSION//./-}-$$.md"
P="/home/node/.openclaw/media/outbound/$FN"
PROMPT="Écris un fichier directement à $P contenant exactement 3 lignes de liste markdown: - alpha / - beta / - gamma. Puis termine ta réponse par une ligne contenant EXACTEMENT: MEDIA:$P"
cd "$REPO"
ARGS=$(python3 -c "import json,sys;print(json.dumps({'chatId':sys.argv[1],'text':sys.argv[2]}))" "$CHAT" "$PROMPT")
cvx dev:testSend "$ARGS" >/dev/null 2>&1 || fail "testSend failed"

# 4) poll for the media part (codex turn ~20-60s).
RES=""
for _ in $(seq 1 40); do
  RES=$(cvx dev:lastMediaPart "{\"chatId\":\"$CHAT\"}" 2>/dev/null)
  echo "$RES" | grep -q "$FN" && break
  sleep 5
done
echo "$RES" | grep -q "$FN" || fail "no media part for $FN (agent didn't attach? /tmp/fx-bridge.log)"

# 5) assertions.
[ "$(echo "$RES" | jq_field mediaCount)" = "1" ]       || fail "mediaCount != 1 (duplicate parts)"
[ "$(echo "$RES" | jq_field textHasDeadLink)" = "False" ] || fail "dead ./media link present (dedup regressed)"
URL=$(echo "$RES" | jq_field url); [ -n "$URL" ]       || fail "no resolved storage url"
DL=$(curl -s --max-time 15 "$URL" | wc -c | tr -d ' ')
SRC=$(wc -c < "$MEDIA_DIR/$FN" | tr -d ' ')
[ "$DL" = "$SRC" ]                                      || fail "byte mismatch (storage:$DL src:$SRC)"

echo "✅ PASS [$VERSION]: 1 media part, no dead link, byte-exact ${SRC}B, mime=$(echo "$RES" | jq_field mimeType)"
