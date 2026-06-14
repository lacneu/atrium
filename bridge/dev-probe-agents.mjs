// Spike #0 — capture the LIVE shape of OpenClaw `agents.list` (+ neighbors) so the
// `agents` Convex table + the bridge `/agents` payload are built on ground truth,
// not on the public doc (fixtures win). Run after `local-openclaw/up.sh` with the
// bridge env pointed at the local gateway (the up.sh footer prints the overrides).
import { loadConfig } from "./dist/config.js";
import { OpenClawConnection } from "./dist/providers/openclaw/openclaw-client.js";

const cfg = loadConfig();
const conn = await OpenClawConnection.connect(
  cfg.openclawGatewayUrl,
  cfg.openclawToken,
  cfg.deviceIdentity,
);

// Print FULL shapes (no truncation) — field names are the whole point of this spike.
function shape(v) {
  return JSON.stringify(v, null, 2);
}

async function probe(method, params) {
  try {
    const r = await conn.request(method, params);
    const body = r?.payload ?? r?.result ?? r;
    console.log(`\n##### ${method} OK #####`);
    console.log(shape(body));
  } catch (e) {
    console.log(`\n##### ${method} ERR: ${e?.message ?? e} #####`);
  }
}

await probe("agents.list", {});
await probe("models.list", {});
await probe("sessions.list", {});
await probe("config.get", { path: "agents" });

conn.close();
process.exit(0);
