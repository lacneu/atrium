#!/usr/bin/env node
// Vendor the OpenClaw Control UI's display redaction (`ui/src/lib/browser-redact.ts`: the
// masking the Control UI applies, AT RENDER, to a tool card's collapsed argument preview and
// to the task feed's tool line — ui/src/lib/chat/tool-cards.ts:328,
// ui/src/pages/chat/components/chat-transcript-feed.ts:176/:181) with its import closure, into
// BOTH runtimes:
//   - src/vendor/upstream-redact/         (the SPA's tool card, src/chat/toolActivityView.ts)
//   - bridge/src/vendor/upstream-redact/  (the bridge's debug log, `clip`)
// The two trees hold the same bytes; src/vendor/upstreamRedactParity.test.ts refuses any drift
// between them or from PROVENANCE.json.
//
// Upstream bytes are kept verbatim except the rewrites recorded per file in PROVENANCE.json:
// `@openclaw/<package>[/<entry>]` imports resolved to the vendored relative path, and a
// `./x.ts` specifier written as `.js`. The set is EXACTLY the import closure of the root:
// computed from upstream, refused if anything is missing or left over.
//
// Usage: node scripts/vendor-upstream-redact.mjs --tag v2026.9.33 --src <openclaw checkout>

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
for (const k of ["tag", "src"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}
const ROOT = path.resolve(import.meta.dirname, "..");
// NOT under convex/: a Convex module path may not hold a hyphen (`redact-patterns.js`
// "is not a valid path to a Convex module"), and no Convex function needs this code.
const DESTS = ["bridge/src/vendor/upstream-redact", "src/vendor/upstream-redact"];
const ROOTS = ["ui/src/lib/browser-redact.ts"];

const sha = (s) => createHash("sha256").update(s).digest("hex");
const show = (p) => execFileSync("git", ["-C", args.src, "show", `${args.tag}:${p}`]).toString();
const upstreamSha = execFileSync("git", ["-C", args.src, "rev-parse", `${args.tag}^{commit}`]).toString().trim();

function rel(from, to) {
  const r = path.posix.relative(path.posix.dirname(from), to);
  return r.startsWith(".") ? r : `./${r}`;
}

/** Rewrite package specifiers to vendored relative paths; return the bytes and the log. */
function rewrite(file, text) {
  const rewrites = [];
  const lines = text.split("\n").map((line, i) => {
    let next = line.replace(/from "@openclaw\/([a-z-]+)(?:\/([A-Za-z0-9_/-]+))?"/g, (_m, pkg, entry) => {
      if (entry === undefined) throw new Error(`${file}:${i + 1}: barrel import of @openclaw/${pkg}`);
      return `from "${rel(file, `packages/${pkg}/src/${entry}.js`)}"`;
    });
    next = next.replace(/from "(\.{1,2}\/[A-Za-z0-9_./-]+)\.ts"/g, 'from "$1.js"');
    if (next !== line) rewrites.push({ line: i + 1, upstream: line });
    return next;
  });
  return { text: lines.join("\n"), rewrites };
}

const out = {};
const provFiles = {};
const stack = [...ROOTS];
while (stack.length > 0) {
  const file = stack.pop();
  if (out[file] !== undefined) continue;
  const upstream = show(file);
  const { text, rewrites } = rewrite(file, upstream);
  out[file] = text;
  provFiles[file] = { upstreamPath: file, upstream: sha(upstream), vendored: sha(text), rewrites };
  for (const [, spec] of text.matchAll(/from "(\.[^"]+)"/g)) {
    stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\.js$/, ".ts"));
  }
}

const provenance = { upstreamRepo: "openclaw/openclaw", upstreamTag: args.tag, upstreamSha, roots: ROOTS, files: provFiles };
for (const dest of DESTS) {
  const dir = path.join(ROOT, dest);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [file, text] of Object.entries(out)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  fs.writeFileSync(path.join(dir, "PROVENANCE.json"), `${JSON.stringify(provenance, null, 2)}\n`);
}
console.log(`vendored ${Object.keys(out).length} files from ${args.tag} (${upstreamSha}) into ${DESTS.join(", ")}`);
