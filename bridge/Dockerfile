# OpenClaw → Convex bridge (the NEW streaming architecture).
#
# The bridge connects to the OpenClaw gateway over WS, normalizes events, and
# POSTs them to the Convex ingest httpAction. For OUTBOUND media it reads the
# agent-produced file from a READ-ONLY mount of the gateway's `media/outbound`
# and STREAMS the raw bytes to a Convex upload URL (no base64 — see
# docs/MEDIA_TRANSFER_DESIGN.md). So this container must share that directory
# with the OpenClaw container(s); see docker-compose.yml + docs/DEPLOYMENT.md.

# ---- build stage: install dev deps + compile TS -> dist ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: prod deps + compiled dist only ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Surface the build version as an env var so `docker exec <c> env | grep ATRIUM_VERSION`
# verifies the running image at a glance (the bridge also self-reports it via /compat
# from package.json). CI passes the lockstep version; defaults to "dev" for local builds.
ARG ATRIUM_VERSION=dev
ENV ATRIUM_VERSION=${ATRIUM_VERSION}

# Env is injected by docker-compose (NOT --env-file), so run dist directly.
# Drop to the built-in non-root `node` user; the media mount is read-only.
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
