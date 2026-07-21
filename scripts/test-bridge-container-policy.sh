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

"$policy" "$root_dir/bridge/Dockerfile"

cat > "$fixture_dir/unpinned-node" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:22-alpine AS build
FROM node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
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
USER root
EOF
expect_rejected "$fixture_dir/root-runtime"
