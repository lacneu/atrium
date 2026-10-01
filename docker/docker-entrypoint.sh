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
#
# WIDGET_SANDBOX_ORIGIN (optional) is the dedicated origin that serves Atrium's copy
# of the inline-widget sandbox proxy (deploy/widget-sandbox/). Unset: widgets render in
# an opaque in-page frame. The SPA re-validates it and refuses its own origin.
#
# Every value is written into JSON by concatenation, so each is checked first: a quote,
# backslash, space or control character would corrupt /srv/config.json and blank the
# SPA. The required CONVEX_URL stops the container with a clear message; an optional
# value that fails is SKIPPED with a warning (the SPA then derives it, or renders
# widgets in its in-page frame) — an optional setting must never break the app.

# json_safe VALUE -> true when VALUE can sit between JSON quotes as is.
json_safe() {
  case "$1" in
    *'
'*) return 1 ;;
  esac
  printf '%s\n' "$1" | LC_ALL=C grep -q '["\\[:space:][:cntrl:]]' && return 1
  return 0
}

# is_origin VALUE -> true for a bare http(s) origin: scheme, host, optional port.
is_origin() {
  printf '%s\n' "$1" | LC_ALL=C grep -Eqx 'https?://[A-Za-z0-9.-]+(:[0-9]+)?'
}

if ! json_safe "${CONVEX_URL}"; then
  echo "[entrypoint] CONVEX_URL contains a quote, backslash, space or control character; refusing to start" >&2
  exit 1
fi
CONFIG="{ \"convexUrl\": \"${CONVEX_URL}\""
if [ -n "${CONVEX_SITE_ORIGIN:-}" ]; then
  if json_safe "${CONVEX_SITE_ORIGIN}"; then
    CONFIG="${CONFIG}, \"convexSiteUrl\": \"${CONVEX_SITE_ORIGIN}\""
  else
    echo "[entrypoint] WARNING: CONVEX_SITE_ORIGIN is not a usable value; ignored (the SPA derives the site origin)" >&2
  fi
fi
if [ -n "${WIDGET_SANDBOX_ORIGIN:-}" ]; then
  if is_origin "${WIDGET_SANDBOX_ORIGIN}"; then
    CONFIG="${CONFIG}, \"widgetSandboxOrigin\": \"${WIDGET_SANDBOX_ORIGIN}\""
  else
    echo "[entrypoint] WARNING: WIDGET_SANDBOX_ORIGIN must be a bare origin (https://host[:port]); ignored, widgets render in the in-page frame" >&2
  fi
fi
CONFIG="${CONFIG} }"
# The output path is overridable for the entrypoint's own tests only.
CONFIG_PATH="${ATRIUM_RUNTIME_CONFIG_PATH:-/srv/config.json}"
printf '%s\n' "${CONFIG}" > "${CONFIG_PATH}"
echo "[entrypoint] wrote ${CONFIG_PATH} -> ${CONFIG}"

exec "$@"
