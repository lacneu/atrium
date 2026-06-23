// Shared helpers for the Atrium load harness (Phase 1).
//
// One tool by design: ConvexClient (convex/browser) for the SUBSCRIBE side (the
// reactive WS path where the cost lives) + plain HTTP POST to /bridge/ingest for the
// SYNTHETIC stream (no gateway, no model tokens). Hits the ingest CONTRACT, so it is
// OpenClaw/Hermes-agnostic by construction.
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

export const api = anyApi;

// Minimal --key value / --flag arg parser.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export const nowMs = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Authenticate a fresh ConvexClient as an anonymous dev user, provision its profile,
// approve it if it landed pending, and learn its userId. Returns { client, userId }.
export async function authedClient(url) {
  const client = new ConvexClient(url);
  const res = await client.action(api.auth.signIn, { provider: "anonymous" });
  const token = res?.tokens?.token;
  if (!token) {
    await client.close();
    throw new Error("anonymous signIn returned no token");
  }
  client.setAuth(async () => token);
  const boot = await client.mutation(api.me.bootstrap, {});
  if (boot?.role !== "user" && boot?.role !== "admin") {
    await client.mutation(api.dev.setMyRole, { role: "user" });
  }
  const me = await client.query(api.me.getMe, { host: "localhost" });
  if (!me?.userId) {
    await client.close();
    throw new Error("getMe returned no userId");
  }
  return { client, userId: me.userId };
}

// POST one ingest op to the Convex HTTP-actions (.site) origin.
export async function ingest(siteUrl, secret, body) {
  const r = await fetch(`${siteUrl}/bridge/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`ingest ${body.op} -> ${r.status}: ${text.slice(0, 120)}`);
  }
  return await r.json();
}

// p-th percentile of a numeric array (linear interpolation), rounded to 1 decimal.
export function pct(arr, p) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const v = lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
  return Math.round(v * 10) / 10;
}

export function summarize(arr) {
  if (arr.length === 0) return { n: 0 };
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    n: arr.length,
    mean: Math.round((sum / arr.length) * 10) / 10,
    p50: pct(arr, 50),
    p95: pct(arr, 95),
    p99: pct(arr, 99),
    max: Math.round(Math.max(...arr) * 10) / 10,
  };
}
