// Re-vendoring an OLDER tag must not fail on modules that upstream added
// later (codex P2, second pass): entries dated `since` are skipped below that
// version and required at or above it.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
import { compareUpstreamVersions, resolveVendorEntries, since } from "../scripts/lib/vendor-files.mjs";

const FILES = [
  "schema/agent.ts",
  ["session-agent-status.ts", "session-icon.ts"],
  ...since("2026.8.1", ["failover-reasons.ts", "../../normalization-core/src/record-coerce.ts"]),
];

describe("resolveVendorEntries", () => {
  it("skips dated entries for a version that predates them, and says which", () => {
    const { entries, skipped } = resolveVendorEntries(FILES, "2026.7.2-beta.5");
    expect(entries.map((e: { candidates: string[] }) => e.candidates)).toEqual([
      ["schema/agent.ts"],
      ["session-agent-status.ts", "session-icon.ts"],
    ]);
    expect(skipped.map((s: { candidates: string[] }) => s.candidates[0])).toEqual([
      "failover-reasons.ts",
      "../../normalization-core/src/record-coerce.ts",
    ]);
  });
  it("requires them at and after their version — an absent module still refuses", () => {
    for (const v of ["2026.8.1", "2026.8.2", "2026.9.1-beta.1"]) {
      const { entries, skipped } = resolveVendorEntries(FILES, v);
      expect(skipped).toEqual([]);
      expect(entries).toHaveLength(4);
    }
  });
  it("orders upstream tags with pre-releases before their release", () => {
    expect(compareUpstreamVersions("2026.8.1-beta.3", "2026.8.1")).toBeLessThan(0);
    expect(compareUpstreamVersions("2026.7.2-beta.5", "2026.8.1")).toBeLessThan(0);
    expect(compareUpstreamVersions("2026.9.1-beta.1", "2026.8.2")).toBeGreaterThan(0);
    expect(() => compareUpstreamVersions("v2026.8.1", "2026.8.1")).toThrow(/unparseable/);
  });
});
