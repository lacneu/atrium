/**
 * The vendored-directory ORDER must be a total order (review pass 3).
 *
 * `oldestVendored()` picks the floor the outbound ratchet compares against, so the
 * comparator is load-bearing: the wrong "oldest" means the wrong contract is treated as
 * the floor. The comparator mixed two incompatible rules — version order when both names
 * parse, lexical order when either does not — which is INTRANSITIVE:
 *
 *     2026.9.1 < 2026.10.1      (version)
 *     2026.10.1 < 2026.10.1x    (lexical)
 *     2026.10.1x < 2026.9.1     (lexical)
 *
 * With an intransitive comparator `Array.prototype.sort` gives an implementation- and
 * input-dependent result, so the answer depended on the order the filesystem happened to
 * return. That mattered only once unparseable names became reachable — which is exactly
 * what marker-based discovery did.
 */

import { describe, expect, it } from "vitest";

import { compareVendoredNames } from "./helpers/vendored.js";

/** Every permutation of `xs`. */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += 1) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i] as T, ...p]);
  }
  return out;
}

describe("the vendored-name comparator is a total order", () => {
  const NAMES = ["2026.9.1", "2026.10.1", "2026.10.1x", "not-a-version"];

  it("sorting is INDEPENDENT of the order the filesystem returned", () => {
    const sorted = [...NAMES].sort(compareVendoredNames);
    for (const p of permutations(NAMES)) {
      expect([...p].sort(compareVendoredNames), `from ${p.join(",")}`).toEqual(sorted);
    }
  });

  it("parsable names order by VERSION, not lexically", () => {
    // The whole reason a comparator exists here: lexically `2026.10.1` precedes
    // `2026.6.11`, so a plain `.sort()` would call an October release the oldest.
    expect(["2026.10.1", "2026.6.11", "2026.9.1"].sort(compareVendoredNames)).toEqual([
      "2026.6.11",
      "2026.9.1",
      "2026.10.1",
    ]);
  });

  it("unparsable names sort together, AFTER every parsable one", () => {
    // Deliberate: the floor of the ratchet must be a directory whose version is known.
    // A name nobody can order is not allowed to become "the oldest vendored contract"
    // by accident — the suites that read the directory report it instead.
    const sorted = ["zzz", "2026.10.1", "aaa", "2026.6.11"].sort(compareVendoredNames);
    expect(sorted).toEqual(["2026.6.11", "2026.10.1", "aaa", "zzz"]);
  });

  it("is transitive on the triple that broke it", () => {
    const [a, b, c] = ["2026.9.1", "2026.10.1", "2026.10.1x"];
    const ab = compareVendoredNames(a!, b!);
    const bc = compareVendoredNames(b!, c!);
    const ac = compareVendoredNames(a!, c!);
    expect(Math.sign(ab)).toBe(Math.sign(ac));
    expect(Math.sign(bc)).toBe(Math.sign(ac));
  });
});
