// The vendored protocol directories, ordered by VERSION — not by string.
//
// Every gate written on 2026-07-26/27 listed them with a plain `.sort()`, and every one
// of those was quietly wrong: lexically, `2026.10.1` precedes `2026.6.11`. Nothing
// failed today because only two versions exist and they happen to sort correctly, which
// is exactly the kind of latent wrong that surfaces on the day of an October release —
// "the oldest vendored contract" would silently become the newest, the floor assertion
// would compare the wrong thing, and the outbound ratchet would report the wrong
// version in its message.
//
// One helper, one comparator (the bridge's own `compareVersions`, the same one the
// capability policy uses), so the ordering cannot drift between suites.

import { readdirSync } from "node:fs";

import { COMPAT_MANIFEST, compareVersions, parseVersion } from "../../src/compat.js";

const PROTOCOL = new URL("../../protocol/openclaw", import.meta.url);
// A base WITH a trailing segment boundary: `new URL("x/", ".../openclaw")` resolves to
// `.../x/` — it replaces the last segment instead of descending into it.
const PROTOCOL_PARENT = new URL("../../protocol/", import.meta.url);

/** Order two vendored directory names: parsable ones by VERSION and first, unparsable
 *  ones lexically and last.
 *
 *  The previous rule mixed the two — version order when both parsed, lexical when either
 *  did not — which is INTRANSITIVE (`9.1 < 10.1` by version, `10.1 < 10.1x` and
 *  `10.1x < 9.1` lexically). `sort` on an intransitive comparator returns whatever the
 *  input order makes it return, so `oldestVendored()` — the floor the outbound ratchet
 *  compares against — depended on what the filesystem happened to list first. Harmless
 *  while every name parsed; reachable the moment discovery stopped filtering on the name
 *  (review pass 3). Unparsable names are put LAST on purpose: the floor must be a
 *  directory whose version is known, and the suites that read these directories report
 *  the unparsable one rather than letting it silently become the oldest. */
export function compareVendoredNames(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa !== null && pb !== null) return compareVersions(pa, pb);
  if (pa !== null) return -1;
  if (pb !== null) return 1;
  return a.localeCompare(b);
}

/** Vendored version directories, OLDEST FIRST by version order. */
export function vendoredVersions(): string[] {
  // A VENDORED directory is one that HOLDS a vendored contract — not "everything except
  // the names we remembered to exclude", and not "everything whose name parses".
  //
  // Two defects, both found the same night. The exclusion list said `!== "coverage"`, so
  // the day a second sibling landed (`events/`, lot G-70) it was read as a version and
  // every suite here looked for schemas inside it. Filtering on `parseVersion` fixed that
  // and introduced the mirror image: a directory whose name that parser does not accept
  // would be skipped in SILENCE, so a genuinely vendored contract could sit unchecked
  // while the corpus looked healthy. Both are the hand-kept-list defect wearing different
  // clothes. The marker is a PROPERTY of the directory: it contains vendored modules.
  const names = readdirSync(PROTOCOL, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        readdirSync(new URL(`openclaw/${e.name}/`, PROTOCOL_PARENT)).some(
          (f) => f.endsWith(".ts") || f === "PROVENANCE.json",
        ),
    )
    .map((e) => e.name);
  return names.sort(compareVendoredNames);
}

/** The OLDEST vendored contract — the strictest one the bridge must still satisfy. */
export function oldestVendored(): string {
  const all = vendoredVersions();
  if (all.length === 0) throw new Error("no vendored protocol directory");
  return all[0]!;
}

/** The version the bridge PROMISES (`maxValidated`), which is what its capability
 *  matrix and its coverage claims are judged against — never "the newest directory",
 *  which may be a version vendored ahead of a bump. */
export function promisedVersion(): string {
  const v = COMPAT_MANIFEST.providers.openclaw?.supportedRange?.maxValidated;
  if (!v) throw new Error("the openclaw provider declares no supported range");
  return v;
}
