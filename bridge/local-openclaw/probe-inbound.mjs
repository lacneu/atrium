// INBOUND attachment probe (task #59): does the gateway accept the EXACT
// attachment shape the bridge sends on `chat.send`, and what does it do with a
// NON-IMAGE file vs an IMAGE? Reverse-engineered contract (from the 6.1 bundle
// `attachment-normalize`): each attachment is read as
//   { type, mimeType, fileName, content(base64) }   (type is only a label hint)
// non-image -> offloaded to media://inbound/<id> AND staged into the agent
// sandbox; image -> the user message gets a `[media attached: media://...]`
// line appended. This probe sends BOTH and prints the ack + any frames.
//
// Run from the bridge repo ROOT:
//   OPENCLAW_TOKEN=$(cat local-openclaw/.token) node --env-file=.env local-openclaw/probe-inbound.mjs
import { loadConfig } from "../dist/config.js";
import { OpenClawConnection } from "../dist/providers/openclaw/openclaw-client.js";
import { buildSessionKey } from "../dist/providers/openclaw/session-keys.js";

const cfg = loadConfig();
const url = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18790";
const token = process.env.OPENCLAW_TOKEN ?? cfg.openclawToken;
const agentId = process.env.OPENCLAW_AGENT_ID ?? "main";
const canonical = process.env.OPENCLAW_CANONICAL ?? "alice";

// A unique marker so we can find the saved file on disk afterwards.
const MARKER = `INBOUND-PROBE-${Date.now().toString(36)}`;
const fileText = `# ${MARKER}\n\nThis is a non-image inbound attachment probe.\nIf you can read this, reply with the marker above.\n`;
const fileB64 = Buffer.from(fileText, "utf8").toString("base64");
const onePngB64 =
  // 1x1 transparent PNG
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const out = (k, v) =>
  console.log(`\n━━━ ${k}\n` + (typeof v === "string" ? v : JSON.stringify(v, null, 2).slice(0, 2400)));

function unwrap(raw) {
  return raw && typeof raw === "object" && "payload" in raw ? raw.payload : raw;
}

const conn = await OpenClawConnection.connect(url, token, cfg.deviceIdentity);
console.log("connected to", url, "| gatewayVersion=", conn.gatewayVersion);
console.log("MARKER:", MARKER);

// Collect inbound (non-ack) frames in the background for a short window.
const frames = [];
(async () => {
  try {
    for await (const f of conn.frames()) {
      frames.push(f);
    }
  } catch {
    /* socket closed */
  }
})();

async function sendCase(label, chatSuffix, attachments, message) {
  const chatId = `probe-inbound-${chatSuffix}-${MARKER}`;
  const sessionKey = buildSessionKey(chatId, agentId, canonical);
  out(`CASE ${label}: sessionKey`, sessionKey);
  const params = {
    sessionKey,
    message,
    idempotencyKey: `${MARKER}-${chatSuffix}`,
    attachments,
  };
  try {
    const raw = await conn.request("chat.send", params, 25_000);
    out(`CASE ${label}: chat.send ACK`, unwrap(raw));
    return { ok: true, sessionKey, chatId };
  } catch (e) {
    out(`CASE ${label}: chat.send ERROR`, String(e?.message ?? e));
    return { ok: false, sessionKey, chatId, err: String(e?.message ?? e) };
  }
}

// CASE 1 — NON-IMAGE file (the prod case the user reports broken).
const r1 = await sendCase(
  "non-image (.md)",
  "doc",
  [{ type: "file", mimeType: "text/markdown", fileName: "probe-inbound.md", content: fileB64 }],
  `Please read the attached file and reply with the marker string it contains.`,
);

// CASE 2 — IMAGE (the path that DOES annotate the message).
const r2 = await sendCase(
  "image (.png)",
  "img",
  [{ type: "image", mimeType: "image/png", fileName: "probe.png", content: onePngB64 }],
  `Describe the attached image.`,
);

// Give the gateway a moment to offload/stage + (maybe) start a turn.
await new Promise((res) => setTimeout(res, 8_000));

out("FRAMES captured (count)", frames.length);
for (const f of frames.slice(0, 12)) {
  const kind = f?.type ?? f?.event ?? "?";
  const s = JSON.stringify(f);
  console.log(`  • ${kind}: ${s.slice(0, 300)}`);
}

out("RESULT", { case1: r1.ok ? "ACCEPTED" : `REJECTED: ${r1.err}`, case2: r2.ok ? "ACCEPTED" : `REJECTED: ${r2.err}` });
console.log("\nNow inspect the container:");
console.log(`  docker exec oc-local-gateway sh -c 'ls -la /home/node/.openclaw/media/inbound/ 2>/dev/null; grep -rl "${MARKER}" /home/node/.openclaw 2>/dev/null'`);

conn.close?.();
process.exit(0);
