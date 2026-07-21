# syntax=docker/dockerfile:1@sha256:e82bbc85c3cb06cf2a5a27b058208b43984448acbcd6a832cd1491933d4376dd
# OpenClaw → Convex bridge (the NEW streaming architecture).
#
# The bridge connects to the OpenClaw gateway over WS, normalizes events, and
# POSTs them to the Convex ingest httpAction. For OUTBOUND media it reads the
# agent-produced file from a READ-ONLY mount of the gateway's `media/outbound`
# and STREAMS the raw bytes to a Convex upload URL (no base64 — see
# docs/MEDIA_TRANSFER_DESIGN.md). So this container must share that directory
# with the OpenClaw container(s); see docker-compose.yml + docs/DEPLOYMENT.md.

# ---- build stage: install dev deps + compile TS -> dist ----
FROM node:22-alpine@sha256:b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: prod deps + compiled dist only ----
FROM node:22-alpine@sha256:b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist

# TWO build-time truths frozen into the image env — independent of package.json
# (the runtime truth compat.ts reads). `/health` + `/capabilities` report BOTH and
# the Settings banner flags a divergence, so "the code I run" vs "the build I came
# from" can never silently disagree again (the 0.19.0-banner-on-newer-code incident).
# CI passes the stamped lockstep version + the exact git sha; local builds default.
ARG ATRIUM_VERSION=dev
ENV ATRIUM_VERSION=${ATRIUM_VERSION}
ARG ATRIUM_REVISION=unknown
ENV ATRIUM_REVISION=${ATRIUM_REVISION}

# Env is injected by docker-compose (NOT --env-file), so run dist directly.
# Drop to the built-in non-root `node` user; the media mount is read-only.
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
