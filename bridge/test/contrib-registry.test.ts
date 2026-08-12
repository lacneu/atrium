/// <reference types="vitest" />
//
// The upstream-contribution ledger stays well-formed and privacy-safe (2026-07-31).
//
// The ledger answers "which upstream issues/PRs came from our findings or caused our
// work, and where does each stand" in one read. It is only worth that if every entry
// is complete and points at the PUBLIC upstream — this repo is community-visible, so a
// private URL, a token, or client material in a title would be published, not filed.
// Malformation is refused here rather than discovered during a sync.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface ContribEntry {
  id: string;
  repo: string;
  kind: string;
  url: string;
  title: string;
  origin: string;
  state: string;
  frames?: string[];
  atriumLots?: string[];
  openedAt?: string;
  resolution?: string | null;
  lastSyncAt?: string;
}

// The PROVIDERS' upstreams, plus the context-engine plugin one of them runs in
// production. `Martian-Engineering/lossless-claw` was added 2026-08-08 on the
// maintainer's explicit decision: it owns the compaction behaviour our own
// context diagnostics depend on, so items there are facts we must adapt to, not
// third-party trivia. Widening this list stays a visible review event — that is
// the whole point of pinning it here.
const ALLOWED_REPOS = [
  "openclaw/openclaw",
  "NousResearch/hermes-agent",
  "Martian-Engineering/lossless-claw",
];
const KINDS = ["issue", "pr"];
const ORIGINS = ["atrium-finding", "upstream-change"];
const STATES = ["draft", "open", "closed", "merged"];
const RESOLUTIONS = [null, undefined, "accepted", "rejected", "fixed", "wontfix", "superseded"];

const registry = JSON.parse(
  readFileSync(new URL("../protocol/contrib/registry.json", import.meta.url), "utf-8"),
) as { version: number; entries: ContribEntry[] };

describe("contrib registry — shape and boundaries", () => {
  it("every entry is complete, unique, and points at an allowed public upstream", () => {
    const bad: string[] = [];
    const ids = new Set<string>();
    for (const e of registry.entries) {
      const where = e.id ?? "(no id)";
      if (!e.id || ids.has(e.id)) bad.push(`${where}: missing or duplicate id`);
      ids.add(e.id);
      if (!ALLOWED_REPOS.includes(e.repo)) {
        // The delegation covers the PROVIDERS' upstreams, nothing else. A new repo
        // here is a decision (edit this list in the same change), not a drift.
        bad.push(`${where}: repo ${e.repo} is outside the delegated upstreams`);
      }
      if (!KINDS.includes(e.kind)) bad.push(`${where}: kind ${e.kind}`);
      if (!ORIGINS.includes(e.origin)) bad.push(`${where}: origin ${e.origin}`);
      if (!STATES.includes(e.state)) bad.push(`${where}: state ${e.state}`);
      if (!RESOLUTIONS.includes(e.resolution as never)) {
        bad.push(`${where}: resolution ${String(e.resolution)}`);
      }
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+$/.test(e.url ?? "")) {
        bad.push(`${where}: url must be a public github issue/pull URL (${e.url})`);
      }
      if (e.url && !e.url.startsWith(`https://github.com/${e.repo}/`)) {
        bad.push(`${where}: url does not belong to its declared repo`);
      }
      if (!e.title) bad.push(`${where}: a title is required (what would a report show?)`);
    }
    expect(bad).toEqual([]);
  });

  it("no control characters in any entry string (terminal-injection guard)", () => {
    // Titles come from upstream issue/PR titles — attacker-influenceable text that
    // the sync prints to the maintainer's terminal. An ESC/OSC sequence in a title
    // must be refused at the ledger, not discovered by a terminal.
    const bad: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (typeof v === "string") {
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001F\u007F-\u009F]/.test(v)) bad.push(`${at}: control character`);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
      }
    };
    registry.entries.forEach((e, i) => walk(e, `entries[${i}]`));
    expect(bad).toEqual([]);
  });

  it("no secret-shaped or private material anywhere in the ledger", () => {
    // Coarse on purpose: the ledger holds public metadata only, so even a
    // false positive is a prompt to move detail elsewhere.
    const raw = readFileSync(new URL("../protocol/contrib/registry.json", import.meta.url), "utf-8");
    expect(raw).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(raw).not.toMatch(/\/Users\/[a-z]/i);
    expect(raw).not.toMatch(/lacneu|ataraxis/i);
  });
});
