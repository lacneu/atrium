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

# A FLOATING Caddy reference must be rejected whatever the build form: the
# pinning assertion is on an explicit vX.Y.Z, not on the `go install` spelling.
cat > "$fixture_dir/floating-caddy" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:24-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM golang:1.26-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS caddy-builder
FROM alpine:3.23@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/caddyserver/caddy/v2/cmd/caddy@latest
COPY --from=caddy-builder /out/caddy /usr/bin/caddy
EOF
expect_rejected "$fixture_dir/floating-caddy"

# A PREBUILT Caddy image defeats the point of building it ourselves (we would
# inherit its toolchain and its dependency set) — reject it even when a pinned
# source reference is also present.
cat > "$fixture_dir/prebuilt-caddy" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:24-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM golang:1.26-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS caddy-builder
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4
FROM caddy:2.11.4-alpine
COPY --from=caddy-builder /out/caddy /usr/bin/caddy
EOF
expect_rejected "$fixture_dir/prebuilt-caddy"

# The throwaway-module form (the ONLY way to override a vulnerable indirect
# dependency of the pinned Caddy release) must be ACCEPTED.
cat > "$fixture_dir/module-form" <<'EOF'
# syntax=docker/dockerfile:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM node:24-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FROM golang:1.26-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS caddy-builder
RUN go mod init atrium/caddy-dist \
 && go mod edit -require=github.com/caddyserver/caddy/v2@v2.11.4 \
 && go get golang.org/x/text@v0.39.0 \
 && CGO_ENABLED=0 go build -trimpath -o /out/caddy .
FROM alpine:3.23@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
COPY --from=caddy-builder /out/caddy /usr/bin/caddy
EOF
"$policy" "$fixture_dir/module-form"
