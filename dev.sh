#!/usr/bin/env bash
# Launch the local dev stack: Convex (anonymous local backend) + Vite UI.
# Idempotent and SAFE for multi-project machines: it stops ONLY this project's
# instances (by our own ports 3212/5174) and NEVER does a global
# `pkill -f "convex dev"` (that would kill other projects, e.g. claude-monitor).
set -euo pipefail
cd "$(dirname "$0")"
export CONVEX_AGENT_MODE=anonymous

CONVEX_PORT=3212   # this project's local Convex backend (claude-monitor uses 3210)
WEB_PORT=5174      # this project's Vite (claude-monitor uses 5173)

echo "stopping this project's prior instances (ports ${CONVEX_PORT}/${WEB_PORT})…"
for p in "$CONVEX_PORT" "$WEB_PORT"; do
  PID=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
done
sleep 1

[ -d node_modules ] || npm install

echo "starting convex dev (local :${CONVEX_PORT})…"
nohup npx convex dev >/tmp/ocw-convex.log 2>&1 &
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:${CONVEX_PORT}/version" 2>/dev/null && break
  sleep 1
done

echo "starting vite (:${WEB_PORT})…"
nohup npx vite >/tmp/ocw-vite.log 2>&1 &
sleep 3
echo "→ http://localhost:${WEB_PORT}   (logs: /tmp/ocw-{convex,vite}.log)"
