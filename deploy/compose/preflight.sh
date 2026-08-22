#!/usr/bin/env bash
# Preflight for the Docker Compose install — READ-ONLY, run it as often as you like.
#
# WHY THIS EXISTS, and why it is a checker rather than an installer: every step of
# the install is already a script or a documented command. What was missing was the
# answer to "am I about to succeed?" BEFORE `docker compose up` half-succeeds. Most
# failures here are not crashes — they are a stack that starts, serves a UI, and
# then fails at the first send because one variable of the OTHER scope was never
# pushed, or because a media mount was declared in `.env` and consumed nowhere.
#
# Designed to be run by a person or by an agent: every finding is one line,
# prefixed FAIL/WARN/OK, and the exit code is 0 only when nothing is FAIL.
#
# Usage:  ./preflight.sh [--env-only] [path/to/.env]      (default: ./.env)
#   --env-only skips the tooling checks (docker/node/openssl) — for CI and for
#   agents running where docker is absent. The env checks are the durable part;
#   their four outcome paths are pinned by bridge/test/preflight.test.ts.
set -uo pipefail
cd "$(dirname "$0")"

ENV_ONLY=0
ENV_FILE=".env"
for arg in "$@"; do
  case "$arg" in
    --env-only) ENV_ONLY=1 ;;
    *) ENV_FILE="$arg" ;;
  esac
done
FAILURES=0
WARNINGS=0

ok()   { printf 'OK   %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

# Read a key from the env file WITHOUT sourcing it: sourcing an operator-authored
# file would execute whatever it contains, and this script must stay read-only.
get() {
  local key="$1"
  sed -n "s/^[[:space:]]*${key}=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 \
    | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}
has_key() { grep -qE "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null; }

# Absolute paths must print as given, not glued behind $(pwd).
case "$ENV_FILE" in /*) SHOWN="$ENV_FILE" ;; *) SHOWN="$(pwd)/$ENV_FILE" ;; esac
echo "== Preflight: $SHOWN"
echo

if [ "$ENV_ONLY" -eq 0 ]; then
echo "-- Tooling"
for bin in docker openssl node; do
  if command -v "$bin" >/dev/null 2>&1; then ok "$bin present"; else fail "$bin is not on PATH"; fi
done
if docker compose version >/dev/null 2>&1; then
  ok "docker compose (v2) available"
else
  fail "docker compose v2 unavailable — 'docker-compose' v1 is not supported"
fi
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 20 ]; then ok "node $(node -v)"; else warn "node $(node -v) — the images build on Node 24; local scripts expect >= 20"; fi
fi
echo
fi

if [ ! -f "$ENV_FILE" ]; then
  fail "$ENV_FILE does not exist — copy .env.example and fill it"
  echo; echo "== $FAILURES failure(s), $WARNINGS warning(s)"; exit 1
fi

echo "-- Required: bridge container scope"
for v in BRIDGE_SHARED_SECRET BRIDGE_INGEST_SECRET CONVEX_HTTP_ACTIONS_URL OPENCLAW_GATEWAY_URL; do
  if [ -n "$(get "$v")" ]; then ok "$v set"; else fail "$v is empty or absent — the bridge refuses to start without it"; fi
done

echo
echo "-- Required: Convex deployment scope (pushed by bootstrap-env.sh, NOT by Docker)"
for v in SITE_URL JWT_PRIVATE_KEY JWKS ATRIUM_SECRET_KEY BRIDGE_URL; do
  if [ -n "$(get "$v")" ]; then ok "$v set"; else fail "$v is empty or absent"; fi
done

echo
echo "-- Coherence traps"

# The one that lets everybody past review and nobody in.
DOMAINS="$(get AUTH_ALLOWED_EMAIL_DOMAINS)"
if [ -z "$DOMAINS" ]; then
  fail "AUTH_ALLOWED_EMAIL_DOMAINS is unset — the default is a placeholder; your first real user will be refused"
elif [ "$DOMAINS" = "example.com" ]; then
  fail "AUTH_ALLOWED_EMAIL_DOMAINS is still example.com — set the domain you actually sign in with"
else
  ok "AUTH_ALLOWED_EMAIL_DOMAINS customised"
fi

# HTTP-actions origin vs API origin: the classic 404-on-every-ingest.
HTTP_URL="$(get CONVEX_HTTP_ACTIONS_URL)"
SITE_PORT="$(get CONVEX_SITE_PORT)"
CLOUD_PORT="$(get CONVEX_CLOUD_PORT)"
if [ -n "$HTTP_URL" ] && [ -n "$CLOUD_PORT" ] && printf '%s' "$HTTP_URL" | grep -q ":${CLOUD_PORT}\b"; then
  fail "CONVEX_HTTP_ACTIONS_URL points at the API port ($CLOUD_PORT); it must point at the HTTP-actions origin (CONVEX_SITE_PORT=${SITE_PORT:-?})"
else
  ok "CONVEX_HTTP_ACTIONS_URL does not collide with the API port"
fi

# The two secrets must exist on both sides and must NOT be equal to each other.
S1="$(get BRIDGE_SHARED_SECRET)"; S2="$(get BRIDGE_INGEST_SECRET)"
if [ -n "$S1" ] && [ "$S1" = "$S2" ]; then
  fail "BRIDGE_SHARED_SECRET equals BRIDGE_INGEST_SECRET — they guard opposite directions and must be separately revocable"
else
  ok "the two bridge secrets are distinct"
fi

if [ -z "$(get BRIDGE_INSTANCE_SECRETS)" ]; then
  warn "BRIDGE_INSTANCE_SECRETS empty — the bridge will start with nothing to serve; mint a per-instance secret in Settings → Agents"
else
  ok "BRIDGE_INSTANCE_SECRETS set"
fi

# The media trap: host dirs declared, mounts still commented out.
if [ -n "$(get OPENCLAW_MEDIA_OUTBOUND_HOST_DIR)" ] || [ -n "$(get OPENCLAW_INBOUND_HOST_DIR)" ]; then
  if grep -qE '^[[:space:]]*-[[:space:]]*\$\{OPENCLAW_(MEDIA_OUTBOUND|INBOUND)_HOST_DIR' docker-compose.yml; then
    ok "media host dirs declared AND mounted"
  else
    fail "media host dirs are set in $ENV_FILE but the matching volumes in docker-compose.yml are still commented out — nothing mounts them and media delivery fails SILENTLY (see deploy/SHARED_FS_MEDIA.md)"
  fi
  if [ -z "$(get BRIDGE_RUN_AS_UID)" ]; then
    warn "shared-fs media without BRIDGE_RUN_AS_UID — inbound files the bridge writes may be unreadable by the agent"
  fi
fi

# Declarative, and an empty value REVOKES.
if has_key ATRIUM_PROVISION_KEYS && [ -z "$(get ATRIUM_PROVISION_KEYS)" ]; then
  warn "ATRIUM_PROVISION_KEYS is present but EMPTY — the push treats that as a revocation of every declared provisioner, not as a no-op"
fi

echo
echo "== $FAILURES failure(s), $WARNINGS warning(s)"
if [ "$FAILURES" -gt 0 ]; then
  echo "Fix every FAIL above, then run this again. Reference: docs/CONFIGURATION.md"
  exit 1
fi
echo "Preflight clean. Next: docker compose up -d, then ./bootstrap-env.sh"
