/**
 * A capability key may be spelled in EXACTLY ONE place (W11/G8).
 *
 * The typed gate — `capabilityOf(record, key)` with the `CapabilityKey` union — is what
 * makes a bridge-side rename a compile error and a red partition test. It only holds if
 * nothing reads the record by raw key: `cap?.capabilities?.cronList === true` type-checks
 * forever, and a rename leaves it permanently false with the control quietly gone. That
 * was live in `convex/scheduled.ts` until this lot, and no test anywhere could see it.
 *
 * So this scans the sources for the pattern rather than for known strings — a list of
 * known offenders only ever catches the ones already fixed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { CAPABILITY_KEYS, NOT_CONSUMED_CAPABILITIES } from "./capabilities";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Where the contract itself lives: the one place a key is spelled on purpose. */
const CONTRACT = ["src/chat/capabilities.ts"];

/** Fixtures and tests state capability records verbatim — that is their job. */
const EXEMPT_SUFFIXES = [".test.ts", ".test.tsx", "bridgeCapabilitiesFixture.ts"];

const ROOTS = ["src", "convex"];
const SKIP_DIRS = new Set(["node_modules", "_generated", "paraglide", "dist", "build"]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      const rel = full.slice(REPO.length + 1);
      if (CONTRACT.includes(rel)) continue;
      if (EXEMPT_SUFFIXES.some((s) => rel.endsWith(s))) continue;
      out.push(rel);
    }
  };
  for (const root of ROOTS) walk(join(REPO, root));
  return out.sort();
}

/** A CAPABILITY KEY read off a record by name — `capabilities.cronList`,
 *  `capabilities?.cronList`, `capabilities["cronList"]`.
 *
 *  Narrowed to the keys the CONTRACT knows, which is what the guard is actually about: a
 *  capability spelled outside `capabilityOf`. Matching any property of any object named
 *  `capabilities` flagged `res.capabilities.canHistory` — a cron RPC's own `CronCaps`,
 *  nothing to do with the bridge record. A key the contract does NOT know is a different
 *  failure (a rename), and the partition test is what catches that one.
 *
 *  A new capability added to the contract becomes lint-protected automatically. */
const CONTRACT_KEYS = [...CAPABILITY_KEYS, ...NOT_CONSUMED_CAPABILITIES];
const RAW_ACCESS = new RegExp(
  String.raw`\bcapabilities\s*(?:\??\.\s*(?:${CONTRACT_KEYS.join("|")})\b` +
    String.raw`|\[\s*["'\`](?:${CONTRACT_KEYS.join("|")})["'\`]\s*\])`,
  "g",
);

describe("no capability is read by raw key", () => {
  const files = sourceFiles();

  test("the scan actually visited the sources", () => {
    // A lint whose glob matches nothing is green forever — the empty-directory shape this
    // program has already paid for. Two anchors: a non-trivial count, and the file that
    // carried the real offender.
    expect(files.length, "the scan found no sources at all").toBeGreaterThan(50);
    expect(files, "the file that carried the defect is not being scanned").toContain(
      "convex/scheduled.ts",
    );
  });

  test("every source goes through the typed gate", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(REPO, rel), "utf8");
      // Line by line, skipping COMMENT lines. A comment that quotes the bad pattern is
      // documentation doing its job — the first version of this lint flagged its own
      // explanatory comment, which would have taught people to write worse ones. A raw
      // access on a code line with a trailing comment is still caught.
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        RAW_ACCESS.lastIndex = 0;
        const m = RAW_ACCESS.exec(line);
        if (m !== null) offenders.push(`${rel}:${i + 1} — ${m[0].trim()}`);
      }
    }
    expect(
      offenders,
      "read the record through `capabilityOf(record, key)` instead: a raw key is a " +
        "contract spelled in a string, and it survives a rename by going silently false",
    ).toEqual([]);
  });
});
