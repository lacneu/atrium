#!/usr/bin/env bash
# Auto-approve the bridge's Ed25519 device on the local gateway.
# A LAN-bound containerized gateway requires token auth + device pairing; this
# registers a pending request (a throwaway connect using the bridge's identity)
# then approves every pending request via the `devices` CLI. Safe locally.
set -euo pipefail
cd "$(dirname "$0")"

TOKEN="$(cat .token)"
# Connect over the LOOPBACK-forward port (#61): the gateway admits the shared
# token only from a TRUSTED transport, and the oc-loopback sidecar makes :18790
# appear as loopback to the gateway (plain :18789 from the host is untrusted →
# AUTH_TOKEN_MISMATCH).
PORT="${OPENCLAW_LOOPBACK_PORT:-18790}"
CID=oc-local-gateway

# 1) Register a pending pairing by connecting once with the bridge's identity.
#    (Fails NOT_PAIRED on purpose — the point is to create the request.)
echo "▶ registering pairing request (bridge identity) …"
( cd .. && OPENCLAW_GATEWAY_URL="ws://127.0.0.1:${PORT}" OPENCLAW_TOKEN="$TOKEN" \
  node --env-file=.env -e '
    import("./dist/providers/openclaw/openclaw-client.js").then(async ({OpenClawConnection})=>{
      const {loadConfig}=await import("./dist/config.js"); const cfg=loadConfig();
      try{ const c=await OpenClawConnection.connect(process.env.OPENCLAW_GATEWAY_URL, process.env.OPENCLAW_TOKEN, cfg.deviceIdentity); c.close(); }
      catch(e){ /* NOT_PAIRED expected */ } process.exit(0);
    });' >/dev/null 2>&1 ) || true
sleep 1

# 2) Approve every pending request.
PENDING="$(docker exec "$CID" node /app/openclaw.mjs devices list --json --token "$TOKEN" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);(j.pending||[]).forEach(p=>console.log(p.requestId))}catch{}})')"
if [[ -z "${PENDING// }" ]]; then
  echo "ℹ no pending pairing (bridge device may already be approved)"; exit 0
fi
for req in $PENDING; do
  echo "▶ approving device request $req …"
  docker exec "$CID" node /app/openclaw.mjs devices approve "$req" --token "$TOKEN" >/dev/null 2>&1 \
    && echo "  ✅ approved $req" || echo "  ⚠ approve failed for $req"
done
echo "✅ bridge device paired"
