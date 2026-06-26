#!/bin/sh
# Inject the runtime config the SPA reads at boot (src/lib/runtimeConfig.ts),
# then hand off to Caddy. This is what makes the prebuilt image origin-agnostic:
# CONVEX_URL is provided at run time, never baked into the bundle.
set -e

: "${CONVEX_URL:?CONVEX_URL is required (the public Convex cloud origin, e.g. https://api.example.com)}"

# CONVEX_SITE_ORIGIN (the public `.site` / HTTP-actions origin) is written into the
# runtime config so the SSE stream endpoint reaches the right host even when the cloud +
# site origins are UNRELATED self-hosted hosts (the frontend can't derive it then). It's
# OPTIONAL: managed Convex (.cloud/.site) and local (+1 port) are derived by the SPA.
if [ -n "${CONVEX_SITE_ORIGIN:-}" ]; then
  cat > /srv/config.json <<EOF
{ "convexUrl": "${CONVEX_URL}", "convexSiteUrl": "${CONVEX_SITE_ORIGIN}" }
EOF
  echo "[entrypoint] wrote /srv/config.json -> { \"convexUrl\": \"${CONVEX_URL}\", \"convexSiteUrl\": \"${CONVEX_SITE_ORIGIN}\" }"
else
  cat > /srv/config.json <<EOF
{ "convexUrl": "${CONVEX_URL}" }
EOF
  echo "[entrypoint] wrote /srv/config.json -> { \"convexUrl\": \"${CONVEX_URL}\" }"
fi

exec "$@"
