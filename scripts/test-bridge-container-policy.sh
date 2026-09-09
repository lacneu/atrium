#!/bin/sh
# Exercise positive and negative bridge container-policy paths without a registry.
set -eu

root_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
policy="$root_dir/scripts/check-bridge-container-policy.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT HUP INT TERM

expect_rejected() {
  fixture="$1"
  if "$policy" "$fixture" >/dev/null 2>&1; then
    echo "Expected policy rejection for $fixture" >&2
    exit 1
  fi
}

expect_accepted() {
  fixture="$1"
  if ! "$policy" "$fixture" >/dev/null 2>&1; then
    echo "Expected policy acceptance for $fixture" >&2
    exit 1
  fi
}

"$policy" "$root_dir/bridge/Dockerfile"

cat > "$fixture_dir/unpinned-node" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN apk upgrade --no-cache && apk add --no-cache 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0'
USER node
EOF
expect_rejected "$fixture_dir/unpinned-node"

cat > "$fixture_dir/npm-retained" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
USER node
EOF
expect_rejected "$fixture_dir/npm-retained"

cat > "$fixture_dir/root-runtime" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN apk upgrade --no-cache && apk add --no-cache 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0'
USER root
EOF
expect_rejected "$fixture_dir/root-runtime"

cat > "$fixture_dir/unpatched-runtime" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node
EOF
expect_rejected "$fixture_dir/unpatched-runtime"

# --- the OpenSSL floor -------------------------------------------------------------
# A floor BELOW the qualified minimum is refused: that is the whole point of the check.

cat > "$fixture_dir/openssl-floor-too-low" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN apk upgrade --no-cache && apk add --no-cache 'libcrypto3>=3.5.7-r0' 'libssl3>=3.5.7-r0'
USER node
EOF
expect_rejected "$fixture_dir/openssl-floor-too-low"
# A floor ABOVE it is accepted. This is the regression that matters: the previous
# revision asserted the EXACT release, so the next Alpine OpenSSL patch would have
# failed every bridge build, releases included.

cat > "$fixture_dir/openssl-floor-raised" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN apk upgrade --no-cache && apk add --no-cache 'libcrypto3>=3.5.9-r0' 'libssl3>=3.5.9-r0'
USER node
EOF
expect_accepted "$fixture_dir/openssl-floor-raised"
# ... and the comparison is NUMERIC per field. A string compare sorts 3.5.10-r0 below
# 3.5.8-r0 and would reject a genuinely newer runtime.

cat > "$fixture_dir/openssl-floor-double-digit" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN apk upgrade --no-cache && apk add --no-cache 'libcrypto3>=3.5.10-r0' 'libssl3>=3.5.10-r0'
USER node
EOF
expect_accepted "$fixture_dir/openssl-floor-double-digit"
# Flooring only one of the two libraries is not flooring OpenSSL.

cat > "$fixture_dir/openssl-floor-partial" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN apk upgrade --no-cache && apk add --no-cache 'libssl3>=3.5.8-r0'
USER node
EOF
expect_rejected "$fixture_dir/openssl-floor-partial"
# The floor does not replace taking the published fixes.

cat > "$fixture_dir/upgrade-skipped" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN apk add --no-cache 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0'
USER node
EOF
expect_rejected "$fixture_dir/upgrade-skipped"
