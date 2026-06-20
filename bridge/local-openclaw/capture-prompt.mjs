// Generic prompt-capture harness (SHARED_FS_INOUT_WORK §6, test P1). Sends an
// arbitrary PROMPT, tries authoritative introspection RPCs, and dumps every frame
// (read the dump for the assistant text — the live capture races the lifecycle-end).
//   PROMPT="…" OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18890 OPENCLAW_TOKEN=$(cat .token-b) \
//     OPENCLAW_CAPTURE_FRAMES=/tmp/p1-68.jsonl node --env-file=../.env.b capture-prompt.mjs

import { randomUUID } from "node:crypto";
const { OpenClawConnection, idempotencyKey } = await import(
  "../dist/providers/openclaw/openclaw-client.js"
);
const { loadConfig } = await import("../dist/config.js");

const URL = process.env.OPENCLAW_GATEWAY_URL;
const TOKEN = process.env.OPENCLAW_TOKEN;
const AGENT = process.env.CAPTURE_AGENT || "alice";
const PROMPT = process.env.PROMPT;
if (!URL || !TOKEN || !PROMPT) { console.error("need OPENCLAW_GATEWAY_URL + OPENCLAW_TOKEN + PROMPT"); process.exit(2); }

const cfg = loadConfig();
const sessionKey = `agent:${AGENT}:atrium-p1-${Date.now()}`;
const conn = await OpenClawConnection.connect(URL, TOKEN, cfg.deviceIdentity);
console.log("✅ connected | gw=", conn.gatewayVersion);
try { await conn.request("sessions.patch", { key: sessionKey, verboseLevel: "full" }); } catch (e) { console.log("patch:", e.message); }

// Authoritative introspection — try the RPCs that might expose the agent's tools.
for (const [m, p] of [
  ["tools.list", { sessionKey }],
  ["tools.list", {}],
  ["sessions.describe", { key: sessionKey }],
  ["agents.describe", { agentId: AGENT }],
  ["agents.list", {}],
]) {
  try {
    const r = await conn.request(m, p);
    console.log(`RPC ${m} OK:`, JSON.stringify(r.result ?? r.payload ?? {}).slice(0, 900));
  } catch (e) {
    console.log(`RPC ${m}:`, e.message);
  }
}

let final = false;
(async () => {
  for await (const f of conn.frames()) {
    const d = f.data ?? f.payload ?? {};
    const st = d.status ?? d.state ?? d.phase;
    if (d.stream === "lifecycle" && (d.phase === "end" || d.phase === "error")) final = true;
    if (st === "final" || st === "error" || st === "aborted") final = true;
  }
})();

const idk = await idempotencyKey(sessionKey, "p1-" + randomUUID());
await conn.request("chat.send", { sessionKey, message: PROMPT, idempotencyKey: idk });
console.log("✅ chat.send (P1 introspection prompt) ok");

const deadline = Date.now() + 240_000;
while (!final && Date.now() < deadline && !conn.isClosed) await new Promise((r) => setTimeout(r, 1500));
await new Promise((r) => setTimeout(r, 1500)); // flush trailing frames to the dump
conn.close();
process.exit(0);
