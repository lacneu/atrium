/// <reference types="vite/client" />
//
// DRIFT PIN between the bridge's compaction-reason buckets and the Convex ingest
// allowlist that re-validates them.
//
// WHY a test that reads source files: the two lists live in separate npm packages,
// so nothing links them. Their failure mode is SILENT — a reason the bridge starts
// bucketing but Convex does not know is simply DROPPED from the trace, and the
// diagnostic value disappears exactly on the turns that needed it. That is not a
// failure any behavioural test would notice, so the pin has to compare the sources.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { COMPACTION_REASON_CLASSES } from "./compactionReasons";

/** The string literals of a `new Set([...])` initializer, by variable name. */
function setLiterals(source: string, variable: string): string[] {
  const start = source.indexOf(variable);
  expect(start, `${variable} not found`).toBeGreaterThan(-1);
  const open = source.indexOf("new Set([", start);
  const close = source.indexOf("]);", open);
  expect(close).toBeGreaterThan(open);
  const body = source.slice(open, close);
  return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

describe("the bridge's compaction reasons and the ingest allowlist agree", () => {
  it("every reason the bridge buckets is one the ingest boundary accepts", () => {
    const bridgeSource = readFileSync(
      new URL("../../bridge/src/core/compaction-verdict.ts", import.meta.url),
      "utf8",
    );
    const bridgeReasons = setLiterals(bridgeSource, "COMPACTION_REASONS");
    // Sanity: the extraction actually found the list (an empty match would make
    // this test vacuously green — the exact way a drift pin stops pinning).
    expect(bridgeReasons.length).toBeGreaterThan(5);
    for (const r of bridgeReasons) {
      expect(
        COMPACTION_REASON_CLASSES.has(r),
        `the bridge buckets "${r}" but the ingest allowlist would DROP it`,
      ).toBe(true);
    }
    // Plus the bridge's own catch-all, which never appears in its list.
    expect(COMPACTION_REASON_CLASSES.has("other")).toBe(true);
  });

  it("the ingest allowlist adds nothing the bridge cannot produce", () => {
    // A one-way pin would let the Convex side accumulate dead entries that read as
    // supported classes in the schema doc and never occur.
    const bridgeSource = readFileSync(
      new URL("../../bridge/src/core/compaction-verdict.ts", import.meta.url),
      "utf8",
    );
    const bridgeReasons = new Set(setLiterals(bridgeSource, "COMPACTION_REASONS"));
    for (const r of COMPACTION_REASON_CLASSES) {
      if (r === "other") continue;
      expect(
        bridgeReasons.has(r),
        `the ingest allowlist accepts "${r}", which the bridge never mints`,
      ).toBe(true);
    }
  });
});
