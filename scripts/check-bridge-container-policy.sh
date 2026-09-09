#!/bin/sh
# Enforce reproducible and minimal bridge runtime images before publishing.
set -eu

dockerfile="${1:-bridge/Dockerfile}"

if ! grep -Eq '^# syntax=docker/dockerfile:1@sha256:[0-9a-f]{64}$' "$dockerfile"; then
  echo "Dockerfile frontend syntax must be pinned by digest" >&2
  exit 1
fi

node_stages=$(grep -Ec '^FROM node:[^[:space:]]+@sha256:[0-9a-f]{64}([[:space:]]|$)' "$dockerfile")
if [ "$node_stages" -ne 2 ]; then
  echo "Both bridge Node stages must be pinned by digest" >&2
  exit 1
fi

if ! grep -Fq 'rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx' "$dockerfile"; then
  echo "The bridge runtime must remove the npm CLI and its dependency tree" >&2
  exit 1
fi

if ! grep -Fq 'apk upgrade --no-cache' "$dockerfile"; then
  echo "The bridge runtime must apply the published Alpine security updates" >&2
  exit 1
fi

# The OpenSSL requirement is READ as a floor, never matched as a literal. Matching the
# exact release would mean this check and the Dockerfile have to move in lockstep the
# day Alpine ships the next OpenSSL fix — so the build would break precisely when
# security improves. What is refused here is a MISSING constraint, or one BELOW the
# version we already know to be required.
openssl_floor='3.5.8-r0'

# Succeeds when $1 >= $2 for Alpine "X.Y.Z-rN" versions, comparing each field
# NUMERICALLY: a string compare puts 3.5.10-r0 BELOW 3.5.8-r0 and would silently
# accept a downgrade.
version_at_least() {
  awk -v have="$1" -v want="$2" '
    function key(v,   parts, n, i, out) {
      gsub(/-r/, ".", v)
      n = split(v, parts, ".")
      out = ""
      for (i = 1; i <= 4; i++) out = out sprintf("%010d", (i <= n ? parts[i] + 0 : 0))
      return out
    }
    BEGIN { exit !(key(have) >= key(want)) }
  '
}

for pkg in libcrypto3 libssl3; do
  floor=$(sed -n "s/.*'$pkg>=\([0-9][0-9.]*-r[0-9][0-9]*\)'.*/\1/p" "$dockerfile" | head -1)
  if [ -z "$floor" ]; then
    echo "The bridge runtime must floor $pkg with apk (\"apk add '$pkg>=X.Y.Z-rN'\")" >&2
    exit 1
  fi
  if ! version_at_least "$floor" "$openssl_floor"; then
    echo "The bridge runtime floors $pkg at $floor, below the qualified $openssl_floor" >&2
    exit 1
  fi
done

if ! grep -Eq '^USER node$' "$dockerfile"; then
  echo "The bridge runtime must run as the non-root node user" >&2
  exit 1
fi
