#!/usr/bin/env bash
# Push the CONVEX DEPLOYMENT-scoped env (section [B] of .env) to a self-hosted
# Convex backend from ANY machine with Node — no docker, no host bootstrap. This
# is the CI-shaped half of bootstrap-env.sh: run it AFTER `npx convex deploy`.
#
# Requires (export them, or rely on the convex CLI's own config):
#   CONVEX_SELF_HOSTED_URL        e.g. https://convex.lacneu.com
#   CONVEX_SELF_HOSTED_ADMIN_KEY  the admin key minted on the backend
# Reads `.env` next to THIS script (multiline JWT/JWKS via <KEY>_FILE paths,
# relative to this dir). The `convex` CLI is invoked from the REPO ROOT (where
# package.json lives) — it refuses to run elsewhere.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
[[ -f "$ENV_FILE" ]] || { echo "FATAL: .env not found next to this script ($ENV_FILE)"; exit 1; }
[[ -f "$REPO_ROOT/package.json" ]] || { echo "FATAL: package.json not at repo root ($REPO_ROOT) — run from a full checkout"; exit 1; }
: "${CONVEX_SELF_HOSTED_URL:?export CONVEX_SELF_HOSTED_URL (e.g. https://convex.lacneu.com)}"
: "${CONVEX_SELF_HOSTED_ADMIN_KEY:?export CONVEX_SELF_HOSTED_ADMIN_KEY}"
export CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY
cd "$REPO_ROOT"   # the convex CLI needs package.json in CWD

dotenv_get() {
  local key="$1" line val
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n1 || true)"
  [[ -z "$line" ]] && return 0
  val="${line#*=}"
  if   [[ "$val" == \"*\" ]]; then val="${val#\"}"; val="${val%\"}"
  elif [[ "$val" == \'*\' ]]; then val="${val#\'}"; val="${val%\'}"; fi
  printf '%s' "$val"
}
resolve() {
  local key="$1" file; file="$(dotenv_get "${key}_FILE")"
  if [[ -n "$file" ]]; then
    [[ "$file" = /* ]] || file="$SCRIPT_DIR/$file"   # relative -> next to .env
    [[ -f "$file" ]] || { echo "FATAL: ${key}_FILE points to a missing file: $file" >&2; exit 1; }
    cat "$file"
  else dotenv_get "$key"; fi
}
set_env() {
  local name="$1" value="$2" current
  [[ -z "$value" ]] && { echo "  · ${name}: (blank, skipped)"; return; }
  current="$(npx convex env get "$name" 2>/dev/null || true)"
  if [[ "$current" == "$value" ]]; then echo "  = ${name}: unchanged"
  else npx convex env set "$name" -- "$value" >/dev/null && echo "  + ${name}: set"; fi
}

# Capture resolve() into a var FIRST so a failed resolve (missing <KEY>_FILE)
# ABORTS — `set -e` does NOT catch a command-substitution failure used directly
# as an argument, which is how the FATAL message once got SET as JWT_PRIVATE_KEY.
push() { local name="$1" val; val="$(resolve "$name")" || exit 1; set_env "$name" "$val"; }

echo "▶ pushing Convex deployment env to ${CONVEX_SELF_HOSTED_URL} (auth gate first) …"
push AUTH_ALLOWED_EMAIL_DOMAINS
for v in \
  AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET \
  AUTH_MICROSOFT_ENTRA_ID_ID AUTH_MICROSOFT_ENTRA_ID_SECRET AUTH_MICROSOFT_ENTRA_ID_ISSUER \
  JWT_PRIVATE_KEY JWKS SITE_URL \
  BRIDGE_URL BRIDGE_INSTANCE_NAME BRIDGE_SHARED_SECRET BRIDGE_INGEST_SECRET \
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_HOST \
  OPIK_API_KEY OPIK_WORKSPACE OPIK_BASE_URL ; do
  push "$v"
done
echo "✅ Convex deployment env reconciled. (\`npx convex deploy\` handles the code separately.)"
