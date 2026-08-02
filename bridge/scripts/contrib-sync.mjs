#!/usr/bin/env node
// Synchronize the upstream-contribution ledger with GitHub, and report.
//
// Reads bridge/protocol/contrib/registry.json, refreshes each entry's `state`
// (and `resolution` when derivable) via `gh … --json`, stamps `lastSyncAt`, and
// prints the report the maintainer asked for: which upstream items originated
// from our findings or caused our work, and where each one stands.
//
// READ-ONLY towards GitHub: this script never creates, edits, comments on, or
// closes anything upstream. Opening items is the gated job of the
// `.claude/skills/upstream-contrib/` process, never of a sync.
//
// Usage:
//   node scripts/contrib-sync.mjs            # sync states + print report
//   node scripts/contrib-sync.mjs --report   # print report only, no gh calls

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REGISTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "protocol",
  "contrib",
  "registry.json",
);

const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));

/** Strip control characters before anything reaches the terminal: titles are
 *  upstream-authored text, and an OSC/ESC sequence must render as nothing, not
 *  execute. The registry test refuses them at rest; this is the belt to that
 *  suspender for a ledger edited out-of-band. */
const clean = (v) => String(v ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

const reportOnly = process.argv.includes("--report");

/** GitHub's own state for one entry, via gh. Returns null on any failure —
 *  a sync that cannot reach GitHub must degrade to "stale", never to a guess. */
function fetchState(entry) {
  const cmd = entry.kind === "pr" ? "pr" : "issue";
  const number = entry.url.split("/").pop();
  try {
    const out = execFileSync(
      "gh",
      [
        cmd,
        "view",
        number,
        "-R",
        entry.repo,
        "--json",
        entry.kind === "pr" ? "state,mergedAt,closedAt" : "state,closedAt,stateReason",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

let changed = 0;
if (!reportOnly) {
  for (const entry of registry.entries) {
    const gh = fetchState(entry);
    if (gh === null) {
      console.error(`[contrib-sync] ${clean(entry.id)}: gh unreachable — state left as-is (stale)`);
      continue;
    }
    const newState =
      entry.kind === "pr" && gh.mergedAt ? "merged" : String(gh.state ?? "").toLowerCase();
    if (newState && newState !== entry.state) {
      entry.state = newState;
      changed += 1;
    }
    // GitHub's stateReason ("completed" | "not_planned") maps onto the ledger's
    // resolution when the human verdict has not been recorded by hand yet.
    if (entry.resolution == null && gh.stateReason === "not_planned") {
      entry.resolution = "rejected";
    }
    entry.lastSyncAt = new Date().toISOString();
  }
  fs.writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 1)}\n`);
}

const rows = registry.entries.map((e) => ({
  id: clean(e.id),
  repo: clean(e.repo),
  kind: clean(e.kind),
  state: clean(e.state) + (e.resolution ? `/${clean(e.resolution)}` : ""),
  origin: clean(e.origin),
  frames: (e.frames ?? []).map(clean).join(", "),
  title: clean(e.title).slice(0, 60),
}));
if (rows.length === 0) {
  console.log("[contrib-sync] ledger is empty — nothing opened upstream yet.");
} else {
  console.table(rows);
  const byState = {};
  // clean() here too: the summary keys come from the same out-of-band-editable
  // field as the rows, and the comment above promises EVERY terminal output.
  for (const e of registry.entries) byState[clean(e.state)] = (byState[clean(e.state)] ?? 0) + 1;
  console.log(`[contrib-sync] ${registry.entries.length} entries, states:`, byState, changed ? `(${changed} updated)` : "(no change)");
}
