// Empirical media-frame capture harness (SHARED_FS_INOUT_WORK §6, tests O1/O2/O3).
// Connects a raw operator WS to a bench gateway, sets verboseLevel=full, asks the
// agent to PRODUCE a file WITHOUT instructing a `MEDIA:` line, then:
//   O1 — does `data.mediaUrls` fire automatically? (capture every frame)
//   O2 — does `artifacts.list({sessionKey})` return the file deterministically?
//   O3 — the exact media-event shape (filename/path vs signed url).
// Every raw frame is also dumped to OPENCLAW_CAPTURE_FRAMES (authoritative ground
// truth — my in-script parsing below is best-effort).
//
// Run (from bridge/local-openclaw):
//   6.8: OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18890 OPENCLAW_TOKEN=$(cat .token-b) \
//        OPENCLAW_CAPTURE_FRAMES=/tmp/frames-68.jsonl \
//        node --env-file=../.env.b capture-media.mjs
//   6.5: OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18790 OPENCLAW_TOKEN=$(cat .token) \
//        OPENCLAW_CAPTURE_FRAMES=/tmp/frames-65.jsonl \
//        node --env-file=../.env capture-media.mjs

import { randomUUID } from "node:crypto";

const { OpenClawConnection, idempotencyKey } = await import(
  "../dist/providers/openclaw/openclaw-client.js"
);
const { loadConfig } = await import("../dist/config.js");

const URL = process.env.OPENCLAW_GATEWAY_URL;
const TOKEN = process.env.OPENCLAW_TOKEN;
const AGENT = process.env.CAPTURE_AGENT || "alice";
if (!URL || !TOKEN) {
  console.error("need OPENCLAW_GATEWAY_URL + OPENCLAW_TOKEN");
  process.exit(2);
}

const cfg = loadConfig();
const sessionKey = `agent:${AGENT}:atrium-capture-${Date.now()}`;
const FNAME = `cap-${Date.now()}.md`;

// PROMPT: produce a file, NO mention of MEDIA: (so O1 tests auto-emission).
const prompt =
  `Crée un fichier nommé ${FNAME} dans le dossier /home/node/.openclaw/media/outbound/ ` +
  `avec exactement le contenu: hello-capture-${Date.now()}. ` +
  `Utilise bash (echo > chemin) ou le skill write-md-file. Quand c'est fait, réponds juste: fait.`;

const log = (...a) => console.log(...a);
const compact = (o, n = 600) => {
  try {
    const s = JSON.stringify(o);
    return s.length > n ? s.slice(0, n) + "…" : s;
  } catch {
    return String(o);
  }
};

const conn = await OpenClawConnection.connect(URL, TOKEN, cfg.deviceIdentity);
log("✅ connected | gatewayVersion=", conn.gatewayVersion, "| maxPayload=", conn.maxPayload);

// verboseLevel=full — REQUIRED or mediaUrls is stripped (OPENCLAW_RESEARCH L131).
try {
  await conn.request("sessions.patch", { key: sessionKey, verboseLevel: "full" });
  log("✅ sessions.patch verboseLevel=full");
} catch (e) {
  log("⚠ sessions.patch failed:", e.message);
}

// Drain frames in the background, flagging anything media-shaped.
const mediaHits = [];
let final = false;
let finalErr = null;
(async () => {
  for await (const f of conn.frames()) {
    const data = f.data ?? f.payload ?? {};
    // O1 — any media reference?
    for (const k of ["mediaUrls", "media_urls", "media", "artifacts", "attachments"]) {
      if (data && data[k] != null) {
        mediaHits.push({ key: k, val: data[k] });
        log(`★ MEDIA-SHAPED [${k}] (event=${f.event ?? f.stream ?? f.type}):`, compact(data[k]));
      }
    }
    // turn-end detection (best-effort across shapes)
    const st = data.status ?? data.state ?? data.phase;
    const stream = data.stream ?? f.stream;
    if (st === "final" || st === "error" || st === "aborted") {
      if (st === "error") finalErr = compact(data.error ?? data);
      final = true;
    }
    if (stream === "lifecycle" && (data.phase === "end" || data.phase === "error")) final = true;
  }
})();

// Send the turn.
const idk = await idempotencyKey(sessionKey, "cap-" + randomUUID());
const res = await conn.request("chat.send", {
  sessionKey,
  message: prompt,
  idempotencyKey: idk,
});
const runId = res.payload?.runId ?? res.runId ?? res.result?.runId ?? null;
log("✅ chat.send ok | runId=", runId, "| file the agent should write:", FNAME);

// Wait for the run to settle (codex on emulated arm = slow).
const deadline = Date.now() + 240_000;
while (!final && Date.now() < deadline && !conn.isClosed) {
  await new Promise((r) => setTimeout(r, 1500));
}
log("— run settled —", final ? "(final)" : "(timeout/closed)", finalErr ? "ERR " + finalErr : "");

// O2 — the deterministic PULL. Try a few likely method names/param shapes.
for (const [method, params] of [
  ["artifacts.list", { sessionKey }],
  ["artifacts.list", { key: sessionKey }],
  ["sessions.artifacts.list", { sessionKey }],
]) {
  try {
    const a = await conn.request(method, params);
    log(`✅ ${method} ok:`, compact(a.result ?? a.payload ?? a, 1200));
    break;
  } catch (e) {
    log(`✗ ${method}:`, e.message);
  }
}

log("\n==== SUMMARY ====");
log("gatewayVersion:", conn.gatewayVersion);
log("media-shaped frames captured:", mediaHits.length);
for (const h of mediaHits) log("   -", h.key, "=", compact(h.val, 400));
log("raw frame dump:", process.env.OPENCLAW_CAPTURE_FRAMES ?? "(none — set OPENCLAW_CAPTURE_FRAMES)");

conn.close();
process.exit(0);
