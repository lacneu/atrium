// CONF-4 probes (design amendments A1/A2/A12 + capabilities checks) against
// the LOCAL bench gateway. Read-mostly; the only writes are session patches on
// the bench test chat and a throwaway agent file (created then restored).
// Run from the bridge repo root:
//   OPENCLAW_TOKEN=$(cat local-openclaw/.token) node --env-file=.env local-openclaw/probe-conf4.mjs
import { loadConfig } from "../dist/config.js";
import { OpenClawConnection } from "../dist/providers/openclaw/openclaw-client.js";

const cfg = loadConfig();
const url = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18790";
const token = process.env.OPENCLAW_TOKEN ?? cfg.openclawToken;
const out = (k, v) =>
  console.log(`\n━━━ ${k}\n` + JSON.stringify(v, null, 2).slice(0, 1800));
const tryRpc = async (conn, method, params) => {
  try {
    const raw = await conn.request(method, params);
    // gateway frames are {type,id,ok,payload} — unwrap to the payload
    const res = raw && typeof raw === "object" && "payload" in raw ? raw.payload : raw;
    return { ok: true, res };
  } catch (e) {
    return { ok: false, err: String(e?.message ?? e) };
  }
};

const conn = await OpenClawConnection.connect(url, token, cfg.deviceIdentity);
console.log("connected to", url);

// ── P1: models.list views ───────────────────────────────────────────────────
for (const view of ["configured", "all", "default"]) {
  const r = await tryRpc(conn, "models.list", { view });
  const arr = Array.isArray(r.res) ? r.res : (r.res?.models ?? []);
  out(`models.list view=${view}`, r.ok
    ? { shape: Object.keys(r.res ?? {}).slice(0, 8), count: arr.length, sample: arr.slice(0, 3) }
    : r);
}

// ── P2: config.schema (admin) ───────────────────────────────────────────────
{
  const r = await tryRpc(conn, "config.schema", {});
  if (r.ok) {
    const s = r.res?.schema ?? r.res;
    out("config.schema", {
      topLevelKeys: Object.keys(s?.properties ?? {}).slice(0, 20),
      hasUiHints: JSON.stringify(r.res).includes("hint"),
      agentsDefaults: Object.keys(
        s?.properties?.agents?.properties?.defaults?.properties ?? {},
      ).slice(0, 25),
    });
  } else out("config.schema", r);
}

// ── P3: agents.files.* ──────────────────────────────────────────────────────
{
  const list = await tryRpc(conn, "agents.files.list", { agentId: "alice" });
  out("agents.files.list(alice)", list);
  const get = await tryRpc(conn, "agents.files.get", {
    agentId: "alice",
    name: "AGENTS.md",
  });
  out("agents.files.get(AGENTS.md) RAW", get.ok
    ? { keys: Object.keys(get.res ?? {}), preview: JSON.stringify(get.res).slice(0, 300) }
    : get);
  // set is restricted to the KNOWN bootstrap file list (probe of a random
  // name returned INVALID_REQUEST "unsupported file"). Round-trip a real one
  // on the ephemeral bench: save HEARTBEAT.md, overwrite, verify, restore.
  const hb = await tryRpc(conn, "agents.files.get", { agentId: "alice", name: "HEARTBEAT.md" });
  const orig = hb.res?.file?.content ?? "";
  const set = await tryRpc(conn, "agents.files.set", {
    agentId: "alice", name: "HEARTBEAT.md", content: orig + "\n<!-- probe -->\n",
  });
  out("agents.files.set(HEARTBEAT.md)", set);
  const reread = await tryRpc(conn, "agents.files.get", { agentId: "alice", name: "HEARTBEAT.md" });
  out("set round-trip ok", { wroteProbe: String(reread.res?.file?.content ?? "").includes("<!-- probe -->") });
  await tryRpc(conn, "agents.files.set", { agentId: "alice", name: "HEARTBEAT.md", content: orig });
}

// ── P4: sessions — pick a real session, then patch/unset semantics ──────────
{
  const list = await tryRpc(conn, "sessions.list", {});
  const rows = list.res?.sessions ?? list.res ?? [];
  out("sessions.list", { count: rows.length, keys: rows.slice(0, 5).map((s) => s.key ?? s.sessionKey) });
  const key = rows.map((s) => s.key ?? s.sessionKey).find((k) => String(k).includes("webchat"))
    ?? rows[0]?.key ?? rows[0]?.sessionKey;
  if (!key) {
    console.log("no session available — patch probes skipped");
  } else {
    console.log("\nusing session:", key);
    // (a) set an override — REAL shape is FLAT fields (bridge server.ts:379),
    // not {patch:{...}} as the embedded doc suggested.
    out("patch thinkingLevel=low", await tryRpc(conn, "sessions.patch", { key, thinkingLevel: "low" }));
    for (const m of ["sessions.get", "sessions.describe", "sessions.resolve"]) {
      const r = await tryRpc(conn, m, { key });
      out(`${m} (after set) RAW`, r.ok
        ? { keys: Object.keys(r.res ?? {}), preview: JSON.stringify(r.res).slice(0, 600) }
        : r);
    }
    // (b) UNSET semantics — the A2 question. Try null, then "default", then "".
    out("patch thinkingLevel=null", await tryRpc(conn, "sessions.patch", { key, thinkingLevel: null }));
    out("patch thinkingLevel='default'", await tryRpc(conn, "sessions.patch", { key, thinkingLevel: "default" }));
    out("patch thinkingLevel=''", await tryRpc(conn, "sessions.patch", { key, thinkingLevel: "" }));
    {
      const r = await tryRpc(conn, "sessions.resolve", { key });
      out("sessions.resolve (after unset attempts)", r.ok
        ? { preview: JSON.stringify(r.res).slice(0, 600) } : r);
    }
    // (c) fastMode round-trip (A12 / Vitesse)
    out("patch fastMode=true", await tryRpc(conn, "sessions.patch", { key, fastMode: true }));
    out("patch fastMode=null", await tryRpc(conn, "sessions.patch", { key, fastMode: null }));
    // (d) usage (A12 — is /session-usage even needed?)
    out("sessions.usage", await tryRpc(conn, "sessions.usage", { key }));
  }
}

conn.close?.();
process.exit(0);
