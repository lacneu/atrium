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

# --- Serve stage (Caddy — tiny, SPA-aware, no nginx) --------------------------
FROM caddy:2-alpine AS serve
COPY --from=build /app/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# CONVEX_URL is REQUIRED at run time (the public Convex cloud origin the browser
# reaches, e.g. https://api.example.com). The entrypoint fails fast if unset.
ENV CONVEX_URL=""
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
