# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# OpenClaw → Convex bridge (the NEW streaming architecture).
#
# The bridge connects to the OpenClaw gateway over WS, normalizes events, and
# POSTs them to the Convex ingest httpAction. For OUTBOUND media it reads the
# agent-produced file from a READ-ONLY mount of the gateway's `media/outbound`
# and STREAMS the raw bytes to a Convex upload URL (no base64 — see
# docs/MEDIA_TRANSFER_DESIGN.md). So this container must share that directory
# with the OpenClaw container(s); see docker-compose.yml + docs/DEPLOYMENT.md.

# ---- build stage: install dev deps + compile TS -> dist ----
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: prod deps + compiled dist only ----
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
# Apply every published Alpine fix, then refuse to publish an image whose OpenSSL is
# older than the qualified minimum. The minimum is a FLOOR, expressed as apk's own
# `>=` constraint: apk upgrades when the repository can satisfy it and exits non-zero
# when it cannot, so a newer Alpine patch satisfies this line untouched. Asserting the
# EXACT release instead would break every build — releases included — on the day
# Alpine ships the next OpenSSL fix, i.e. the day security improves. Raising the floor
# is a deliberate edit; scripts/check-bridge-container-policy.sh refuses to lower it.
RUN apk upgrade --no-cache \
    && apk add --no-cache 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0' \
    && npm ci --omit=dev \
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
