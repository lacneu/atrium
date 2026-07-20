#!/bin/sh
# Exercise positive and negative container-policy paths without a registry.
set -eu

root_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
policy="$root_dir/scripts/check-container-policy.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT HUP INT TERM

expect_rejected() {
  fixture="$1"
  if "$policy" "$fixture" >/dev/null 2>&1; then
    echo "Expected policy rejection for $fixture" >&2
    exit 1
  fi
}

"$policy" "$root_dir/docker/Dockerfile"

cat > "$fixture_dir/unpinned-syntax" <<'EOF'
# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM golang:1.26-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS caddy-builder
FROM alpine:3.23@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4
COPY --from=caddy-builder /out/caddy /usr/bin/caddy
EOF
expect_rejected "$fixture_dir/unpinned-syntax"

cat > "$fixture_dir/unpinned-node" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:24-alpine
FROM golang:1.26-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS caddy-builder
FROM alpine:3.23@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4
COPY --from=caddy-builder /out/caddy /usr/bin/caddy
EOF
expect_rejected "$fixture_dir/unpinned-node"

cat > "$fixture_dir/unpinned-builder" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:24-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM golang:1.26-alpine AS caddy-builder
FROM alpine:3.23@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4
COPY --from=caddy-builder /out/caddy /usr/bin/caddy
EOF
expect_rejected "$fixture_dir/unpinned-builder"

cat > "$fixture_dir/unpinned-alpine" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:24-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM golang:1.26-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS caddy-builder
FROM alpine:3.23
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4
COPY --from=caddy-builder /out/caddy /usr/bin/caddy
EOF
expect_rejected "$fixture_dir/unpinned-alpine"

cat > "$fixture_dir/network-client" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:24-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM golang:1.26-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS caddy-builder
FROM alpine:3.23@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RUN apk add --no-cache curl
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4
COPY --from=caddy-builder /out/caddy /usr/bin/caddy
EOF
expect_rejected "$fixture_dir/network-client"

cat > "$fixture_dir/full-runtime-copy" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:24-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM golang:1.26-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS caddy-builder
FROM alpine:3.23@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4
COPY --from=caddy-builder / /
EOF
expect_rejected "$fixture_dir/full-runtime-copy"
