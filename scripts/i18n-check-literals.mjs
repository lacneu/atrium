#!/usr/bin/env node
// CI gate #2 — untranslated-literal RATCHET.
//
// The full migration of ~440 hardcoded French strings to `m.*()` is incremental,
// so a hard "zero accented literals" gate would block every PR until the very
// last string moves. Instead this is a RATCHET: it counts source lines that
// still contain an accented Latin literal (a strong proxy for an untranslated
// French UI string) and FAILS only when that count GOES UP versus the committed
// baseline. New hardcoded French is rejected; the existing backlog is tolerated
// and shrinks as files migrate.
//
//   - count > baseline → FAIL (a new untranslated string slipped in).
//   - count < baseline → PASS, and nudge to ratchet the baseline DOWN.
//   - count == baseline → PASS.
//   - no baseline yet  → write it and PASS (bootstrap).
//
// Run `node scripts/i18n-check-literals.mjs --update` to rebaseline after an
// intentional migration step.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcDir = resolve(root, "src");
const baselinePath = resolve(here, "i18n-literals-baseline.json");
const UPDATE = process.argv.includes("--update");

// Accented Latin letters + the French œ/Œ ligatures. A line carrying one of
// these in source is almost always a user-facing French string. Comments are
// English by convention (CLAUDE.md), so they contribute ~nothing.
const ACCENT = /[À-ÖØ-öø-ÿŒœ]/;

// Excluded from the scan: generated output and test files (tests legitimately
// assert on French output and are not shipped UI).
const isExcluded = (path) =>
  path.includes(`${join("src", "paraglide")}`) ||
  /\.test\.(ts|tsx)$/.test(path);

/** Recursively collect .ts/.tsx files under src. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !isExcluded(full)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(srcDir);
let count = 0;
/** @type {Record<string, number>} */
const perFile = {};
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  let n = 0;
  for (const line of lines) if (ACCENT.test(line)) n++;
  if (n) {
    perFile[relative(root, file)] = n;
    count += n;
  }
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8")).count;
  } catch {
    return null;
  }
}

if (UPDATE) {
  writeFileSync(baselinePath, JSON.stringify({ count }, null, 2) + "\n");
  console.log(`✔ i18n literal baseline updated → ${count}.`);
  process.exit(0);
}

const baseline = readBaseline();
if (baseline === null) {
  writeFileSync(baselinePath, JSON.stringify({ count }, null, 2) + "\n");
  console.log(`✔ i18n literal baseline bootstrapped → ${count} line(s).`);
  process.exit(0);
}

if (count > baseline) {
  const worst = Object.entries(perFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([f, n]) => `    ${n.toString().padStart(4)}  ${f}`)
    .join("\n");
  console.error(
    `✖ i18n literal RATCHET FAILED: ${count} accented line(s) > baseline ${baseline}.\n` +
      `  A new untranslated French string was likely introduced. Move it to a\n` +
      `  message key (m.*()) instead of hardcoding it.\n\n  Heaviest files:\n${worst}`,
  );
  process.exit(1);
}

if (count < baseline) {
  console.log(
    `✔ i18n literal ratchet OK — ${count} < baseline ${baseline}. ` +
      `Run \`node scripts/i18n-check-literals.mjs --update\` to lock in the progress.`,
  );
} else {
  console.log(`✔ i18n literal ratchet OK — ${count} (== baseline).`);
}
