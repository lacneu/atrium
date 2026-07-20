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

if ! grep -Fq 'go install github.com/caddyserver/caddy/v2/cmd/caddy@v' "$dockerfile"; then
  echo "The Caddy source release must be pinned" >&2
  exit 1
fi

if ! grep -Fq 'COPY --from=caddy-builder /out/caddy /usr/bin/caddy' "$dockerfile"; then
  echo "The frontend runtime must copy only the rebuilt Caddy binary" >&2
  exit 1
fi
