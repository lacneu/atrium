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

if ! grep -Eq '^USER node$' "$dockerfile"; then
  echo "The bridge runtime must run as the non-root node user" >&2
  exit 1
fi
