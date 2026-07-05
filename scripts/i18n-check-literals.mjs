#!/usr/bin/env node
// CI gate #2 — untranslated-literal RATCHET (per-file).
//
// Counts source lines that still contain an accented Latin literal (a strong
// proxy for an untranslated French UI string) and FAILS when any FILE exceeds
// ITS committed baseline count. The baseline is PER-FILE — not a global total —
// so a new untranslated string in file A can never be masked by a migration
// that removed one in file B, and a file absent from the baseline allows ZERO
// accented lines (new files must be born clean).
//
//   - a file's count > its baseline (or it has no baseline entry) → FAIL.
//   - a file's count < its baseline → PASS, and nudge to ratchet DOWN.
//   - all counts == baseline → PASS.
//   - no baseline yet → write it and PASS (bootstrap).
//
// Run `node scripts/i18n-check-literals.mjs --update` to rebaseline after an
// intentional migration step. The target baseline is `{"files": {}}` (zero
// accented literals); any legitimate remainder must stay visible per-file here
// with a justification comment.

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

// Excluded from the scan:
//   - generated Paraglide output;
//   - test files (tests legitimately assert on French output, not shipped UI);
//   - src/chat/ThemeShowroom.tsx: design-reference showroom, intentionally not
//     internationalized (#23 will relocate it).
const isExcluded = (path) =>
  path.includes(`${join("src", "paraglide")}`) ||
  /\.test\.(ts|tsx)$/.test(path) ||
  path.endsWith(join("src", "chat", "ThemeShowroom.tsx"));

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
/** @type {Record<string, number>} Current accented-line count per file (only files with >0). */
const perFile = {};
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  let n = 0;
  for (const line of lines) if (ACCENT.test(line)) n++;
  if (n) perFile[relative(root, file)] = n;
}

/** Stable output: sorted keys, so rebaselines produce minimal diffs. */
function serializeBaseline(filesMap) {
  const sorted = Object.fromEntries(
    Object.entries(filesMap).sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify({ files: sorted }, null, 2) + "\n";
}

function readBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
    // Per-file shape only. A legacy `{count}` (or anything else) triggers a
    // bootstrap rewrite below rather than a bogus comparison.
    if (parsed && typeof parsed.files === "object" && parsed.files !== null) {
      return parsed.files;
    }
    return null;
  } catch {
    return null;
  }
}

if (UPDATE) {
  writeFileSync(baselinePath, serializeBaseline(perFile));
  const total = Object.values(perFile).reduce((a, b) => a + b, 0);
  console.log(
    `✔ i18n literal baseline updated → ${Object.keys(perFile).length} file(s), ${total} line(s).`,
  );
  process.exit(0);
}

const baseline = readBaseline();
if (baseline === null) {
  writeFileSync(baselinePath, serializeBaseline(perFile));
  console.log(
    `✔ i18n literal baseline bootstrapped (per-file) → ${Object.keys(perFile).length} file(s).`,
  );
  process.exit(0);
}

// A file over ITS budget (absent from the baseline = budget 0) is a failure.
const regressions = Object.entries(perFile)
  .map(([f, n]) => ({ file: f, count: n, allowed: baseline[f] ?? 0 }))
  .filter((r) => r.count > r.allowed);

if (regressions.length > 0) {
  const detail = regressions
    .map(
      (r) =>
        `    ${r.count.toString().padStart(4)} > ${r.allowed
          .toString()
          .padStart(4)}  ${r.file}`,
    )
    .join("\n");
  console.error(
    `✖ i18n literal RATCHET FAILED: ${regressions.length} file(s) exceed their baseline.\n` +
      `  A new untranslated French string was likely introduced. Move it to a\n` +
      `  message key (m.*()) instead of hardcoding it.\n\n  found > allowed  file\n${detail}`,
  );
  process.exit(1);
}

// Improvement detection: any baseline entry whose current count dropped (files
// now at 0 disappear from perFile entirely).
const improved = Object.entries(baseline).some(
  ([f, allowed]) => (perFile[f] ?? 0) < allowed,
);
if (improved) {
  console.log(
    `✔ i18n literal ratchet OK — below baseline. ` +
      `Run \`node scripts/i18n-check-literals.mjs --update\` to lock in the progress.`,
  );
} else {
  const total = Object.values(perFile).reduce((a, b) => a + b, 0);
  console.log(
    `✔ i18n literal ratchet OK — ${Object.keys(perFile).length} file(s), ${total} line(s) (== baseline).`,
  );
}
