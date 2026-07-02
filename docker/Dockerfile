# syntax=docker/dockerfile:1
# Origin-agnostic static frontend image for atrium.
#
# The Convex URL is injected at RUNTIME via /config.json (written by the
# entrypoint from $CONVEX_URL) — NOT baked at build time. The SAME image
# therefore serves ANY deployment. See src/lib/runtimeConfig.ts.

# --- Build stage --------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# IMPORTANT: do NOT pass VITE_CONVEX_URL here. If it were set, Vite would inline
# it as a baked fallback and the image would stop being origin-agnostic. The
# committed convex/_generated lets `vite build` typecheck without a live backend.
RUN npm run build
# Emit the build version (from the stamped package.json) + the exact git sha as a
# served, curl-able file: `curl https://<frontend-host>/version.json` verifies the
# running bundle WITHOUT shell access, and the sha pins WHICH commit was built —
# two truths, divergence visible. Origin-agnostic (no URL).
ARG ATRIUM_REVISION=unknown
RUN node -p "JSON.stringify({ version: require('./package.json').version, revision: process.env.ATRIUM_REVISION })" > dist/version.json

# --- Serve stage (Caddy — tiny, SPA-aware, no nginx) --------------------------
FROM caddy:2-alpine AS serve
COPY --from=build /app/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# Also surface the version as an env var for a `docker exec <c> env | grep ATRIUM_VERSION`
# check. CI passes the lockstep version; defaults to "dev" for local builds.
ARG ATRIUM_VERSION=dev
ENV ATRIUM_VERSION=${ATRIUM_VERSION}
# The exact git sha this image was built from — the second, package-independent
# truth (see /version.json below + the bridge counterpart).
ARG ATRIUM_REVISION=unknown
ENV ATRIUM_REVISION=${ATRIUM_REVISION}
# CONVEX_URL is REQUIRED at run time (the public Convex cloud origin the browser
# reaches, e.g. https://api.example.com). The entrypoint fails fast if unset.
ENV CONVEX_URL=""
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
