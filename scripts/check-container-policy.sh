#!/bin/sh
# Enforce reproducible, minimal runtime images before publishing.
set -eu

dockerfile="${1:-docker/Dockerfile}"

if ! grep -Eq '^# syntax=docker/dockerfile:1@sha256:[0-9a-f]{64}$' "$dockerfile"; then
  echo "Dockerfile frontend syntax must be pinned by digest" >&2
  exit 1
fi

if grep -Eq '^FROM node:[^@[:space:]]+([[:space:]]|$)' "$dockerfile"; then
  echo "Node builder references must be pinned by digest" >&2
  exit 1
fi

if grep -Eq '^FROM golang:[^@[:space:]]+([[:space:]]|$)' "$dockerfile"; then
  echo "Go builder references must be pinned by digest" >&2
  exit 1
fi

if grep -Eq '^FROM alpine:[^@[:space:]]+([[:space:]]|$)' "$dockerfile"; then
  echo "Alpine runtime references must be pinned by digest" >&2
  exit 1
fi

if grep -Eq '^[[:space:]]*RUN[[:space:]].*(apk|apt-get|dnf|yum)[[:space:]].*(curl|wget)' "$dockerfile"; then
  echo "Runtime network clients must not be installed by the frontend image" >&2
  exit 1
fi

# Caddy must be built from an EXPLICITLY PINNED source release. The assertion is
# on the INTENT, not on one build form: `go install pkg@vX.Y.Z` and the
# throwaway-module form (`go mod edit -require=pkg@vX.Y.Z`, the only way to
# override a vulnerable INDIRECT dependency of the Caddy release) both qualify.
# A floating reference (`@latest`, a branch, no version) does not match.
if ! grep -Eq 'github\.com/caddyserver/caddy/v2(/cmd/caddy)?@v[0-9]+\.[0-9]+\.[0-9]+' "$dockerfile"; then
  echo "The Caddy source release must be pinned to an explicit version" >&2
  exit 1
fi

# …and it must be BUILT, never inherited as a prebuilt image (the whole point of
# the caddy-builder stage: we control the Go toolchain and the dependency set).
if grep -Eq '^FROM caddy:' "$dockerfile"; then
  echo "The frontend image must build Caddy from source, not pull a prebuilt image" >&2
  exit 1
fi

if ! grep -Fq 'COPY --from=caddy-builder /out/caddy /usr/bin/caddy' "$dockerfile"; then
  echo "The frontend runtime must copy only the rebuilt Caddy binary" >&2
  exit 1
fi
