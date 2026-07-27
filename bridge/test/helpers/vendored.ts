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

/** Vendored version directories, OLDEST FIRST by version order. */
export function vendoredVersions(): string[] {
  const names = readdirSync(PROTOCOL, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "coverage")
    .map((e) => e.name);
  return names.sort((a, b) => {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    // An unparseable directory name is a mistake, not an ordering question: keep it
    // deterministic and let the suites that read the directory report it.
    if (pa === null || pb === null) return a.localeCompare(b);
    return compareVersions(pa, pb);
  });
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
