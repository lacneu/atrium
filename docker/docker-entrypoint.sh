#!/bin/sh
# Inject the runtime config the SPA reads at boot (src/lib/runtimeConfig.ts),
# then hand off to Caddy. This is what makes the prebuilt image origin-agnostic:
# CONVEX_URL is provided at run time, never baked into the bundle.
set -e

: "${CONVEX_URL:?CONVEX_URL is required (the public Convex cloud origin, e.g. https://api.example.com)}"

cat > /srv/config.json <<EOF
{ "convexUrl": "${CONVEX_URL}" }
EOF
echo "[entrypoint] wrote /srv/config.json -> { \"convexUrl\": \"${CONVEX_URL}\" }"

exec "$@"
