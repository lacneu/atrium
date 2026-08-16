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
# ATRIUM_PROVISION_KEYS is DECLARATIVE, so an empty value is a REMOVAL, not a
# no-op. `set_env` skips blanks on purpose — for an optional credential, blank
# means "not configured, leave whatever is there". Here it would mean the exact
# opposite: an operator withdrawing the last declared host would leave the old
# declaration live in Convex, and the key they meant to revoke would keep
# authenticating for ever.
# Is the key PRESENT in .env at all? `dotenv_get` cannot tell an absent key from an
# empty one, and for a DECLARATIVE variable those mean opposite things: absent is
# "this deployment does not manage it here — leave Convex alone", empty is "revoke
# everything". Every .env derived from the current example lacks this key, so
# conflating them would have an ordinary bootstrap silently revoke every declared
# provisioner.
dotenv_has() {
  local key="$1"
  # The SAME pattern `dotenv_get` uses — no `export` prefix. Accepting a form the
  # reader does not parse made an `export KEY=...` line read as PRESENT but resolve
  # EMPTY, which this script then took for "revoke everything".
  grep -qE "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null
}

set_declared_provision_keys() {
  local value="$1" current get_status=0
  # `env get` fails BOTH when the variable is absent and when the CLI, the network
  # or the credentials are broken. Reading every failure as "absent" would report a
  # removal never performed, leaving the withdrawn declaration — and its access —
  # live. Only a genuine absence is tolerated.
  # `env get` SUCCEEDS when the variable is simply absent, so a non-zero exit means
  # something is actually wrong — the CLI, the network, the credentials. Treating
  # that as "absent" was the dangerous half: with an empty local declaration the
  # script would skip the removal and leave the old value authorising, while
  # reporting that nothing was declared.
  current="$(npx convex env get ATRIUM_PROVISION_KEYS 2>/dev/null)" || {
    echo "FATAL: cannot read ATRIUM_PROVISION_KEYS from the Convex environment" >&2
    exit 1
  }
  if [[ -z "$value" ]]; then
    if [[ -n "$current" ]]; then
      if ! npx convex env remove ATRIUM_PROVISION_KEYS >/dev/null 2>&1; then
        echo "FATAL: could not remove ATRIUM_PROVISION_KEYS — the withdrawn declaration is STILL live" >&2
        exit 1
      fi
      echo "  - ATRIUM_PROVISION_KEYS: removed (declaration emptied)"
    else
      echo "  . ATRIUM_PROVISION_KEYS: (none declared)"
    fi
    return
  fi
  if [[ "$current" == "$value" ]]; then
    echo "  = ATRIUM_PROVISION_KEYS: unchanged"
  else
    npx convex env set ATRIUM_PROVISION_KEYS -- "$value" >/dev/null
    echo "  + ATRIUM_PROVISION_KEYS: set"
  fi
}
# Capture resolve() FIRST: `set -e` does NOT abort on a command substitution
# used directly as an argument, so a missing ATRIUM_PROVISION_KEYS_FILE would
# arrive here as an empty string and DELETE the live declaration.
if dotenv_has ATRIUM_PROVISION_KEYS || dotenv_has ATRIUM_PROVISION_KEYS_FILE; then
  DECLARED_PROVISION_KEYS="$(resolve ATRIUM_PROVISION_KEYS)" || exit 1
  set_declared_provision_keys "$DECLARED_PROVISION_KEYS"
else
  echo "  . ATRIUM_PROVISION_KEYS: not declared in .env — leaving Convex untouched"
fi

for v in \
  AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET \
  AUTH_MICROSOFT_ENTRA_ID_ID AUTH_MICROSOFT_ENTRA_ID_SECRET AUTH_MICROSOFT_ENTRA_ID_ISSUER \
  JWT_PRIVATE_KEY JWKS SITE_URL \
  ATRIUM_SECRET_KEY ATRIUM_ENV_LABEL \
  SIGNED_ANNOUNCEMENTS_URL SIGNED_ANNOUNCEMENTS_TOKEN \
  SIGNED_ANNOUNCEMENTS_RECIPIENT_ID SIGNED_ANNOUNCEMENTS_RECIPIENT_FIELD \
  SIGNED_ANNOUNCEMENTS_PUBLIC_KEY \
  SIGNED_ANNOUNCEMENTS_DOMAIN SIGNED_ANNOUNCEMENTS_KEY_MAP \
  BRIDGE_URL BRIDGE_INSTANCE_NAME BRIDGE_SHARED_SECRET BRIDGE_INGEST_SECRET \
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_HOST \
  OPIK_API_KEY OPIK_WORKSPACE OPIK_BASE_URL OPIK_PROJECT_NAME OPIK_OPENCLAW_PROJECT ; do
  push "$v"
done
echo "✅ Convex deployment env reconciled. (\`npx convex deploy\` handles the code separately.)"
