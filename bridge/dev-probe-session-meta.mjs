// Usage: node --env-file=.env dev-probe-session-meta.mjs <chatId>
import { loadConfig } from "./dist/config.js";
import { OpenClawConnection } from "./dist/providers/openclaw/openclaw-client.js";
import { buildSessionKey } from "./dist/providers/openclaw/session-keys.js";
const chatId = process.argv[2];
if (!chatId) {
  console.error("usage: node --env-file=.env dev-probe-session-meta.mjs <chatId>");
  process.exit(1);
}
// agentId/canonical are NO LONGER in BridgeConfig (body-routing refactor) — pass
// them via env (the routed agent + the per-user canonical), no silent default.
const agentId = process.env.PROBE_AGENT_ID;
const canonical = process.env.PROBE_CANONICAL;
if (!agentId || !canonical) {
  console.error("set PROBE_AGENT_ID and PROBE_CANONICAL env vars (agent + per-user canonical)");
  process.exit(1);
}
const cfg = loadConfig();
const conn = await OpenClawConnection.connect(cfg.openclawGatewayUrl, cfg.openclawToken, cfg.deviceIdentity);
const sk = buildSessionKey(chatId, agentId, canonical);
function shape(v){return JSON.stringify(v,(k,val)=>typeof val==="string"&&val.length>140?`<str ${val.length}>`:val,1);}
async function probe(m,p){try{const r=await conn.request(m,p);const b=r?.payload??r?.result??r;console.log(`\n##### ${m} OK #####`);console.log(shape(b).slice(0,3000));}catch(e){console.log(`\n##### ${m} ERR: ${e?.message??e} #####`);}}
await probe("sessions.describe", { key: sk });
await probe("config.schema.lookup", { path: "agents" });
await probe("models.list", {});
conn.close();process.exit(0);
