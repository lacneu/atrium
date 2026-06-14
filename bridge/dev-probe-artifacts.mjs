// DEV PROBE: connect once and call artifacts.list / artifacts.download for a
// session, to capture the exact v2026.5.19 param/response shapes (the docs mark
// these NOT FOUND). Run with the bridge STOPPED (same device identity → avoid
// the T2 same-role contention):
//   node --env-file=.env dev-probe-artifacts.mjs <convexChatId>
import { loadConfig } from "./dist/config.js";
import { OpenClawConnection } from "./dist/providers/openclaw/openclaw-client.js";
import { buildSessionKey } from "./dist/providers/openclaw/session-keys.js";

const chatId = process.argv[2];
if (!chatId) {
  console.error("usage: node --env-file=.env dev-probe-artifacts.mjs <convexChatId>");
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
const conn = await OpenClawConnection.connect(
  cfg.openclawGatewayUrl,
  cfg.openclawToken,
  cfg.deviceIdentity,
);
const sessionKey = buildSessionKey(chatId, agentId, canonical);
console.log("sessionKey:", sessionKey);

function dump(label, res) {
  const body = res?.payload ?? res?.result ?? res;
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(body, null, 2).slice(0, 4000));
}

try {
  const list = await conn.request("artifacts.list", { sessionKey });
  dump("artifacts.list({sessionKey})", list);

  // Try to find the first artifact id/ref to download.
  const items =
    (list?.payload?.items ?? list?.payload?.artifacts ?? list?.result?.items ?? []) || [];
  console.log("\n# items count:", Array.isArray(items) ? items.length : "n/a");
  if (Array.isArray(items) && items.length > 0) {
    console.log("# first item keys:", Object.keys(items[0]));
    console.log("# first item:", JSON.stringify(items[0]).slice(0, 600));
    const first = items[0];
    const id = first.id ?? first.artifactId ?? first.path ?? first.name ?? first.key;
    try {
      const dl = await conn.request("artifacts.download", { sessionKey, id, artifactId: id, path: first.path });
      const body = dl?.payload ?? dl?.result ?? dl;
      // Don't print bytes; print the SHAPE.
      console.log("\n=== artifacts.download shape ===");
      console.log("keys:", body && typeof body === "object" ? Object.keys(body) : typeof body);
      console.log(JSON.stringify(body, (k, v) => (typeof v === "string" && v.length > 200 ? `<str ${v.length}>` : v), 2).slice(0, 2000));
    } catch (e) {
      console.log("artifacts.download error:", e?.message ?? e);
    }
  }
} catch (e) {
  console.log("artifacts.list error:", e?.message ?? e);
}
conn.close();
process.exit(0);
