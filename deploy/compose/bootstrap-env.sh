#!/usr/bin/env bash
# Make a fresh self-hosted Convex backend usable. The convex-backend image is a
# GENERIC, EMPTY backend — it ships NO application code. This script does the two
# things that make the stack actually work, in order:
#   1. push the CONVEX DEPLOYMENT-scoped vars (section [B] of .env) via
#      `convex env set` — read by Convex FUNCTIONS (process.env), NOT injected by
#      docker-compose; AND
#   2. DEPLOY this repo's Convex functions / HTTP routes (queries, mutations,
#      /bridge/ingest, auth callbacks, crons) via `convex deploy` — without this
#      the frontend and bridge have no backend to talk to.
# Env FIRST, deploy SECOND: `convex deploy` loads modules to register them, and a
# module reading a required var at import time would fail on an env-less backend.
# Safe to re-run: env set is idempotent (writes only on diff); deploy re-pushes
# the current functions (do this on every release — the functions change).
#
# Prereqs: the stack is up (`docker compose up -d`), `convex-backend` is healthy,
# `npx` (Node) is available, AND this is run from a FULL repo checkout (step 2
# bundles the functions from `../../convex`; deps are installed on first run).
# Run AFTER editing .env:  ./bootstrap-env.sh
set -euo pipefail
cd "$(dirname "$0")"

[[ -f .env ]] || { echo "FATAL: .env not found (cp .env.example .env first)"; exit 1; }

# Read .env with a DOTENV parser, never `source` it: the file holds values the
# shell would choke on or mangle — a PEM JWT_PRIVATE_KEY, secrets with
# `$`/spaces/quotes. dotenv_get extracts a key's
# LITERAL single-line value (last wins; one layer of surrounding quotes stripped;
# no shell evaluation). Multiline secrets (PEM/JWKS) are supplied out-of-band via
# a `<KEY>_FILE` path — see `resolve` below.
dotenv_get() {
  local key="$1" line val
  line="$(grep -E "^[[:space:]]*${key}=" .env | tail -n1 || true)"
  [[ -z "$line" ]] && return 0
  val="${line#*=}"
  if [[ "$val" == \"*\" ]]; then val="${val#\"}"; val="${val%\"}"
  elif [[ "$val" == \'*\' ]]; then val="${val#\'}"; val="${val%\'}"; fi
  printf '%s' "$val"
}

# Resolve a Convex-scoped value: a `<KEY>_FILE` path wins (its file content is
# read VERBATIM, preserving PEM/JSON newlines) — the robust way to provide
# JWT_PRIVATE_KEY / JWKS without cramming multiline data into a dotenv line.
resolve() {
  local key="$1" file
  file="$(dotenv_get "${key}_FILE")"
  if [[ -n "$file" ]]; then
    [[ -f "$file" ]] || { echo "FATAL: ${key}_FILE points to a missing file: $file" >&2; exit 1; }
    cat "$file"
  else
    dotenv_get "$key"
  fi
}

INSTANCE_SECRET="$(dotenv_get CONVEX_INSTANCE_SECRET)"
[[ -n "$INSTANCE_SECRET" ]] || { echo "FATAL: CONVEX_INSTANCE_SECRET must be set in .env (mints the admin key)"; exit 1; }
PROJECT="$(dotenv_get COMPOSE_PROJECT_NAME)"; PROJECT="${PROJECT:-atrium}"
CLOUD_PORT="$(dotenv_get CONVEX_CLOUD_PORT)"; CLOUD_PORT="${CLOUD_PORT:-3210}"
BACKEND="${PROJECT}-convex-backend"
# The convex CLI must run from the repo ROOT (package.json + convex/), NOT from
# deploy/compose — every `npx convex …` below runs inside ( cd "$REPO_ROOT" && … ).
REPO_ROOT="$(cd ../.. && pwd)"

# 1) Wait for the backend to be healthy (the env API is unavailable otherwise).
echo "▶ waiting for ${BACKEND} to be healthy …"
for _ in $(seq 1 30); do
  if docker exec "$BACKEND" curl -fsS http://localhost:3210/version >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 2
done
[[ "${ok:-}" == "1" ]] || { echo "FATAL: ${BACKEND} not healthy after 60s"; exit 1; }

# 2) Mint the admin key from INSTANCE_SECRET (self-hosted image ships the script).
echo "▶ minting admin key …"
ADMIN_KEY="$(docker exec "$BACKEND" ./generate_admin_key.sh 2>/dev/null | tr -d '\r' | tail -n1)"
[[ -n "$ADMIN_KEY" ]] || { echo "FATAL: could not mint admin key (generate_admin_key.sh)"; exit 1; }
export CONVEX_SELF_HOSTED_URL="http://127.0.0.1:${CLOUD_PORT}"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY"

# 3) Idempotent setter: write only when the stored value differs.
set_env() {
  local name="$1" value="$2"
  [[ -z "$value" ]] && { echo "  · ${name}: (blank, skipped)"; return; }
  local current
  current="$( (cd "$REPO_ROOT" && npx convex env get "$name") 2>/dev/null || true)"
  if [[ "$current" == "$value" ]]; then
    echo "  = ${name}: unchanged"
  else
    ( cd "$REPO_ROOT" && npx convex env set "$name" -- "$value" ) >/dev/null
    echo "  + ${name}: set"
  fi
}

# 4) AUTH_ALLOWED_EMAIL_DOMAINS FIRST — it is the authoritative sign-in gate and
#    MUST be in place before anyone can reach the sign-in screen (else sign-in
#    breaks, or a wrong domain could seed the admin).
echo "▶ setting Convex deployment env (auth gate first) …"
# Capture resolve() into a var FIRST so a failed resolve (missing <KEY>_FILE)
# ABORTS — `set -e` does NOT catch a command-substitution failure used directly as
# an argument, which once stored the literal "FATAL …" message as JWT_PRIVATE_KEY.
push() { local name="$1" val; val="$(resolve "$name")" || exit 1; set_env "$name" "$val"; }
push AUTH_ALLOWED_EMAIL_DOMAINS

# 5) The rest. JWT_PRIVATE_KEY / JWKS support the `<KEY>_FILE` form (recommended
#    for the PEM key + JWKS JSON) via `resolve`.
for v in \
  AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET \
  AUTH_MICROSOFT_ENTRA_ID_ID AUTH_MICROSOFT_ENTRA_ID_SECRET AUTH_MICROSOFT_ENTRA_ID_ISSUER \
  JWT_PRIVATE_KEY JWKS SITE_URL \
  ATRIUM_SECRET_KEY ATRIUM_ENV_LABEL \
  BRIDGE_URL BRIDGE_INSTANCE_NAME BRIDGE_SHARED_SECRET BRIDGE_INGEST_SECRET \
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_HOST \
  OPIK_API_KEY OPIK_WORKSPACE OPIK_BASE_URL ; do
  push "$v"
done


echo "▶ Convex deployment env reconciled."

# 6) Deploy this repo's Convex functions / HTTP routes to the (now env-configured)
#    backend. `convex deploy` bundles from convex/ at the repo root and pushes via
#    the self-hosted URL + admin key already exported above (kept out of argv).
[[ -f "$REPO_ROOT/convex/schema.ts" ]] || {
  echo "FATAL: convex/ source not found at ${REPO_ROOT}. Run bootstrap-env.sh from"
  echo "       a FULL repo checkout — it deploys the backend's functions, not just env."
  exit 1
}
if [[ ! -d "$REPO_ROOT/node_modules/convex" ]]; then
  echo "▶ installing repo deps (one-time, needed to bundle functions) …"
  # `npm ci` fails when the committed lockfile was generated for a different
  # platform (e.g. alpine/musl) than this host — fall back to `npm install`.
  ( cd "$REPO_ROOT" && { npm ci || npm install; } )
fi
echo "▶ deploying Convex functions from ${REPO_ROOT} …"
( cd "$REPO_ROOT" && npx convex deploy )

echo "✅ Convex env + functions deployed. Open the app; the first sign-in from"
echo "   an allowed domain becomes admin."
