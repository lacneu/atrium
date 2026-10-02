#!/usr/bin/env node
// Re-vendor Atrium's copy of the OpenClaw widget sandbox proxy (deploy/widget-sandbox/)
// from a LIVE gateway of the version being pinned.
//
// The proxy is the trusted outer document upstream serves on its sandbox listener
// (src/agents/sandbox-host.ts buildSandboxHostDocument). Its URL — path, CSP query and
// the `v` version hash — is what `canvas.document.view` returns as `sandboxUrl`. The
// version is upstream's sha256(JSON.stringify([headers, html])), so the copy is only
// accepted when the bytes and headers fetched hash to exactly that `v`.
//
// Usage:
//   node scripts/vendor-widget-sandbox.mjs \
//     --sandbox http://127.0.0.1:<sandboxPort> \
//     --sandbox-url '/mcp-app-sandbox?csp=…&v=…' \
//     --tag v2026.9.6 --src <openclaw checkout at that tag>
//
// Writes index.html, headers.json and PROVENANCE.json — upstream's bytes. The Caddyfile
// headers are kept in step by hand, with `media-src` HARDENED (no `https:`, see
// src/chat/widgets/widgetSandbox.ts HARDENED_MEDIA_SRC); widgetSandbox.test.ts refuses
// any other difference.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
for (const k of ["sandbox", "sandbox-url", "tag", "src"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}
const HEADER_NAMES = [
  "Content-Type",
  "Content-Security-Policy",
  "Permissions-Policy",
  "Cross-Origin-Resource-Policy",
  "Origin-Agent-Cluster",
  "Referrer-Policy",
  "X-Content-Type-Options",
];
const SOURCES = [
  "src/agents/sandbox-host.ts",
  "src/gateway/board-sandbox.ts",
  "src/plugin-sdk/widget-html.ts",
  "src/shared/widget-media.ts",
];
const url = new URL(args["sandbox-url"], args.sandbox);
const version = url.searchParams.get("v");
const res = await fetch(url);
if (!res.ok) throw new Error(`sandbox answered ${res.status}`);
const html = await res.text();
const headers = {};
for (const name of HEADER_NAMES) {
  const value = res.headers.get(name);
  if (value === null) throw new Error(`sandbox response lacks ${name}`);
  headers[name] = value;
}
const computed = createHash("sha256").update(JSON.stringify([headers, html])).digest("hex");
if (computed !== version) {
  throw new Error(`fetched proxy hashes to ${computed}, the gateway announced ${version} — refusing`);
}
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const upstreamSha = execFileSync("git", ["-C", args.src, "rev-parse", `${args.tag}^{commit}`]).toString().trim();
const sources = Object.fromEntries(
  SOURCES.map((p) => [p, sha(execFileSync("git", ["-C", args.src, "show", `${args.tag}:${p}`]))]),
);
const out = path.resolve(import.meta.dirname, "../deploy/widget-sandbox");
fs.writeFileSync(path.join(out, "index.html"), html);
fs.writeFileSync(path.join(out, "headers.json"), JSON.stringify(headers, null, 2) + "\n");
const prov = JSON.parse(fs.readFileSync(path.join(out, "PROVENANCE.json"), "utf8"));
Object.assign(prov, {
  upstreamTag: args.tag,
  upstreamSha,
  sandboxPath: `${url.pathname}${url.search}`,
  version,
  sources,
  files: { "index.html": sha(Buffer.from(html, "utf8")) },
});
fs.writeFileSync(path.join(out, "PROVENANCE.json"), JSON.stringify(prov, null, 2) + "\n");
console.log(`[widget-sandbox] vendored ${args.tag} (v=${version}) -> deploy/widget-sandbox/`);
