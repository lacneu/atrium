// The coverage RULES every classification ledger is held to — the announced events,
// the broadcast-only events (events-coverage.test.ts) and the Hermes features
// (hermes-features-coverage.test.ts). One definition: a hardening of the anchor rule
// (two path bypasses so far) or a new status with its owed prose reaches every ledger.
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { stripComments } from "../../scripts/lib/derive-event-catalogue.mjs";

export interface CoverageEntry {
  status: "handled" | "ignored" | "gap";
  /** Only on `handled`: the code that performs the consumption being claimed. */
  anchor?: { file: string; token: string };
  by?: string;
  why?: string;
  note?: string;
}

export const VALID_STATUSES = new Set(["handled", "ignored", "gap"]);

/** The prose each status owes the reader. A status with no justification is a shrug. */
export const REQUIRED_PROSE: Record<string, keyof CoverageEntry> = {
  handled: "by",
  ignored: "why",
  gap: "note",
};

/** Every family in `names` must be classified in `entries` with the prose its status
 *  owes — the ONE rule both vocabularies (announced, broadcast-only) are held to. */
export function classificationViolations(
  names: readonly string[],
  entries: Record<string, CoverageEntry>,
): { unclassified: string[]; unjustified: string[] } {
  const unclassified: string[] = [];
  const unjustified: string[] = [];
  for (const name of names) {
    const entry = entries[name];
    if (entry === undefined) {
      unclassified.push(name);
      continue;
    }
    if (!VALID_STATUSES.has(entry.status)) {
      unjustified.push(`${name}: unknown status ${JSON.stringify(entry.status)}`);
      continue;
    }
    const owed = REQUIRED_PROSE[entry.status];
    const prose = owed === undefined ? undefined : entry[owed];
    if (typeof prose !== "string" || prose.trim() === "") {
      unjustified.push(`${name}: status "${entry.status}" requires \`${owed}\``);
    }
  }
  return { unclassified, unjustified };
}

/** A `handled` verdict must point at code that EXISTS.
 *
 *  Review passes 4 and 5 found six classifications claiming a consumption the code does
 *  not perform — `run_status` "polled" by nothing, `chat_completions` "dispatched" to an
 *  endpoint never built, headers "carried" that are never sent. Five of the six named no
 *  verifiable anchor at all: they were prose, and prose cannot be falsified by a test.
 *
 *  So every `handled` carries `anchor: {file, token}`, and this asserts the token is
 *  present in that file AFTER COMMENTS ARE STRIPPED. The stripping is not pedantry: most
 *  of these names appear in explanatory comments too, and an anchor satisfied by a
 *  comment would certify exactly the vague claim this rule exists to kill. The same
 *  stripper the catalogue deriver uses, so the two cannot disagree.
 *
 *  WHAT THIS DOES NOT PROVE: that the code reached by the anchor is FED, or that it does
 *  what the prose says. `session.operation` had a real reader at a real line and was
 *  still wrong — nothing delivers the event. That class stays a human read; this rule
 *  removes the other five.
 */
/** Comment-stripped source by file, read once per process: every ledger and every
 *  vendored version anchors into the same handful of large files. */
const STRIPPED = new Map<string, string | null>();
function strippedSource(at: URL): string | null {
  const key = at.pathname;
  const hit = STRIPPED.get(key);
  if (hit !== undefined) return hit;
  let value: string | null;
  try {
    value = (stripComments as (s: string) => string)(readFileSync(at, "utf-8"));
  } catch {
    value = null;
  }
  STRIPPED.set(key, value);
  return value;
}

export function anchorViolations(
  entries: Record<string, { status: string; anchor?: { file: string; token: string } }>,
  label: string,
): string[] {
  const bad: string[] = [];
  for (const [name, e] of Object.entries(entries)) {
    if (e.status !== "handled") {
      if (e.anchor !== undefined) {
        bad.push(`${label} ${name}: only \`handled\` carries an anchor`);
      }
      continue;
    }
    const anchor = e.anchor;
    if (anchor === undefined || !anchor.file || !anchor.token) {
      bad.push(`${label} ${name}: \`handled\` requires anchor {file, token}`);
      continue;
    }
    // Production code only, and canonically so. Two bypasses were found in a row:
    // `src/../test/foo.test.ts` (pass 7, literal segments) and `src/%2e%2e/test/foo.test.ts`
    // (pass 8 — WHATWG URL decodes the escape, so a segment check on the raw string sees
    // nothing wrong). Rather than enumerate spellings, the rule is now a whitelist of
    // harmless characters plus a check on the RESOLVED path: a test certifies that a claim
    // is TESTED, never that the build DOES it.
    if (!/^src\/[A-Za-z0-9_./-]+\.ts$/.test(anchor.file) || anchor.file.includes("%")) {
      bad.push(`${label} ${name}: anchor must point into src/, not ${anchor.file}`);
      continue;
    }
    const at = new URL(`../../${anchor.file}`, import.meta.url);
    if (!at.pathname.includes("/bridge/src/") || at.pathname.includes("/..")) {
      bad.push(`${label} ${name}: anchor resolves outside src/ (${anchor.file})`);
      continue;
    }
    const code = strippedSource(at);
    if (code === null) {
      bad.push(`${label} ${name}: anchor file ${anchor.file} does not exist`);
      continue;
    }
    if (!code.includes(anchor.token)) {
      bad.push(
        `${label} ${name}: token ${JSON.stringify(anchor.token)} is absent from ` +
          `${anchor.file} outside comments — the claim cites code that is not there`,
      );
    }
  }
  return bad;
}

/** The tallies a ledger publishes, DERIVED from its entries — three separate
 *  corrections rotted while the tallies were prose, and this is what the "COUNTS are
 *  derived, not remembered" gate of every ledger compares against. */
export function derivedCounts(
  entries: Record<string, { status: string }>,
): { total: number; handled: number; gap: number; ignored: number } {
  const by = (s: string): number => Object.values(entries).filter((e) => e.status === s).length;
  return { total: Object.keys(entries).length, handled: by("handled"), gap: by("gap"), ignored: by("ignored") };
}

