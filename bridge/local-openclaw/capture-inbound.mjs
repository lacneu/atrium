// Empirical INBOUND capture (SHARED_FS_INOUT_WORK §6, test I1). Sends a NATIVE
// `chat.send.attachments` (inline base64) and asks the model to quote/describe it,
// to learn HOW OpenClaw presents an attachment to the LLM:
//   - inline (the model sees the content directly)  → deterministic, no LLM-read needed
//   - offload to media://inbound + injected text     → the LLM must read a path (same
//     non-determinism as our [FICHIERS REÇUS])
//   - rejected (non-image)                            → native path unusable for that type
// A unique MARKER in the text file lets us assert whether the model actually GOT the
// content (it quotes the marker) vs only saw a reference.
//
// Run (from bridge/local-openclaw):
//   CAPTURE_KIND=text|image  OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18890 \
//     OPENCLAW_TOKEN=$(cat .token-b) OPENCLAW_CAPTURE_FRAMES=/tmp/inb-68.jsonl \
//     node --env-file=../.env.b capture-inbound.mjs

import { randomUUID } from "node:crypto";

const { OpenClawConnection, idempotencyKey } = await import(
  "../dist/providers/openclaw/openclaw-client.js"
);
const { loadConfig } = await import("../dist/config.js");

const URL = process.env.OPENCLAW_GATEWAY_URL;
const TOKEN = process.env.OPENCLAW_TOKEN;
const AGENT = process.env.CAPTURE_AGENT || "alice";
const KIND = process.env.CAPTURE_KIND || "text"; // text | image
if (!URL || !TOKEN) { console.error("need OPENCLAW_GATEWAY_URL + OPENCLAW_TOKEN"); process.exit(2); }

const cfg = loadConfig();
const sessionKey = `agent:${AGENT}:atrium-inbound-${Date.now()}`;
const MARKER = `secret-marker-${Date.now()}`;

let attachment, prompt;
if (KIND === "image") {
  // 1x1 red PNG.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  attachment = { mimeType: "image/png", fileName: "test-inbound.png", content: png.toString("base64") };
  prompt = "Décris l'image en pièce jointe (couleur dominante). Si tu ne reçois AUCUNE image, réponds exactement: NONE.";
} else {
  const txt = Buffer.from(`The secret content of this attached file is: ${MARKER}`);
  attachment = { mimeType: "text/plain", fileName: "test-inbound.txt", content: txt.toString("base64") };
  prompt =
    "Un fichier texte est joint à ce message. Cite SON CONTENU EXACT mot pour mot. " +
    "Ne lis aucun autre fichier. Si tu ne reçois aucune pièce jointe, réponds exactement: NONE.";
}

const conn = await OpenClawConnection.connect(URL, TOKEN, cfg.deviceIdentity);
console.log("✅ connected | gw=", conn.gatewayVersion, "| maxPayload=", conn.maxPayload, "| kind=", KIND);
try { await conn.request("sessions.patch", { key: sessionKey, verboseLevel: "full" }); }
catch (e) { console.log("⚠ sessions.patch:", e.message); }

let final = false, finalErr = null, assistantText = "";
const tools = [];
(async () => {
  for await (const f of conn.frames()) {
    const d = f.data ?? f.payload ?? {};
    if (d.stream === "tool" && d.phase === "start") {
      tools.push({ name: d.name, args: JSON.stringify(d.args ?? {}).slice(0, 300) });
      console.log("TOOL:", d.name, JSON.stringify(d.args ?? {}).slice(0, 300));
    }
    if (d.stream === "assistant" && typeof d.text === "string") assistantText = d.text;
    const st = d.status ?? d.state ?? d.phase;
    if (st === "final" || st === "error" || st === "aborted") { if (st === "error") finalErr = JSON.stringify(d.error ?? d); final = true; }
    if (d.stream === "lifecycle" && (d.phase === "end" || d.phase === "error")) final = true;
  }
})();

const idk = await idempotencyKey(sessionKey, "inb-" + randomUUID());
try {
  await conn.request("chat.send", { sessionKey, message: prompt, idempotencyKey: idk, attachments: [attachment] });
  console.log("✅ chat.send WITH native attachment ok | marker=", MARKER);
} catch (e) {
  console.log("✗ chat.send with attachment REJECTED:", e.message);
  conn.close(); process.exit(0);
}

const deadline = Date.now() + 240_000;
while (!final && Date.now() < deadline && !conn.isClosed) await new Promise((r) => setTimeout(r, 1500));

console.log("\n==== SUMMARY (I1) ====");
console.log("gatewayVersion:", conn.gatewayVersion, "| kind:", KIND, finalErr ? "| ERR " + finalErr : "");
console.log("assistant text:", assistantText.slice(0, 600));
console.log("tool calls during turn:", tools.length, tools.map((t) => t.name));
if (KIND === "text") {
  const got = assistantText.includes(MARKER);
  const read = tools.some((t) => /media\/inbound|inbound/.test(t.args));
  console.log("→ model GOT the content inline?", got ? "YES (quoted marker)" : "NO");
  console.log("→ offload (a tool read media/inbound)?", read ? "YES (offloaded → LLM had to read)" : "no inbound-read tool seen");
} else {
  console.log("→ vision saw the image?", /NONE/i.test(assistantText) ? "NO (said NONE)" : "likely yes (described it)");
}
conn.close(); process.exit(0);
