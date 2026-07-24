# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# Origin-agnostic static frontend image for atrium.
#
# The Convex URL is injected at RUNTIME via /config.json (written by the
# entrypoint from $CONVEX_URL) — NOT baked at build time. The SAME image
# therefore serves ANY deployment. See src/lib/runtimeConfig.ts.

# --- Build stage --------------------------------------------------------------
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
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
# The official Caddy Alpine runtime intentionally installs curl and its current
# binary was compiled with a Go release carrying known high-severity issues.
# Build the exact Caddy release with a fixed Go toolchain, then copy only the
# static binary and CA bundle into a pinned, package-manager-free runtime.
FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS caddy-builder
# Caddy v2.11.4 (its LATEST release — there is no newer tag to move to) pins two
# INDIRECT modules that now carry high-severity advisories, which the image scan
# gate rejects: golang.org/x/text v0.37.0 (GO-2026-5970, fixed in 0.39.0) and
# google.golang.org/grpc v1.81.0 (GHSA-hrxh-6v49-42gf, fixed in 1.82.1).
# `go install pkg@version` builds in module-free mode and CANNOT override a
# dependency, so build the same Caddy release from a throwaway module where both
# are force-upgraded — the xcaddy pattern, and the same reasoning as the Go
# toolchain pin above (build it ourselves rather than inherit a vulnerable
# binary). Both bumps are semver-compatible (same major), so Caddy's own code is
# unchanged. When a Caddy release ships these fixes, drop the two `go get` lines
# and return to `go install`.
# ORDER MATTERS: the entrypoint must exist BEFORE resolving the graph, or
# `go mod tidy` cannot see Caddy's standard-module imports and go.sum stays
# incomplete. Pin the Caddy release with `go mod edit -require` (so tidy resolves
# THAT version, not latest), tidy, THEN force-upgrade the two flagged modules —
# MVS selects the higher requirement, which is exactly the bump we want.
WORKDIR /caddybuild
RUN go mod init atrium/caddy-dist \
 && printf 'package main\n\nimport (\n\tcaddycmd "github.com/caddyserver/caddy/v2/cmd"\n\t_ "github.com/caddyserver/caddy/v2/modules/standard"\n)\n\nfunc main() { caddycmd.Main() }\n' > main.go \
 && go mod edit -require=github.com/caddyserver/caddy/v2@v2.11.4 \
 && go mod tidy \
 && go get golang.org/x/text@v0.39.0 google.golang.org/grpc@v1.82.1 \
 && CGO_ENABLED=0 go build -trimpath -o /out/caddy . \
 && go version -m /out/caddy | grep -E 'golang.org/x/text|google.golang.org/grpc'
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS serve
COPY --from=caddy-builder /out/caddy /usr/bin/caddy
COPY --from=caddy-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /app/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV XDG_CONFIG_HOME=/config
ENV XDG_DATA_HOME=/data
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
