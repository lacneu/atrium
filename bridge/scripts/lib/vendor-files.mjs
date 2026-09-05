// Which vendor entries apply to a given upstream version (pure, testable).
//
// The vendored module list grows with upstream: v2026.8.1 split the session and
// worker schemas into many new files. Listing them as plain (mandatory) entries
// made re-vendoring any EARLIER tag fail on the first absent module, although
// those versions are still archived and were vendorable before. An entry may
// therefore carry `since`: below that version it is skipped (and said so);
// at or above it, it is required exactly like a plain entry — an absent module
// on a version that should have it still refuses.

/** Mark `paths` (each a string or a candidate list) as existing from `version` on. */
export function since(version, paths) {
  return paths.map((p) => ({ since: version, candidates: Array.isArray(p) ? p : [p] }));
}

/** Upstream tags: `YYYY.M.P[-beta.N]`. A pre-release sorts before its release. */
export function compareUpstreamVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(v);
    if (!m) throw new Error(`unparseable upstream version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 4; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Normalize the list for one version: `{candidates}` entries to vendor, in
 *  order, plus the entries skipped because the version predates them. */
export function resolveVendorEntries(files, version) {
  const entries = [];
  const skipped = [];
  for (const entry of files) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      if (compareUpstreamVersions(version, entry.since) < 0) {
        skipped.push({ candidates: entry.candidates, since: entry.since });
        continue;
      }
      entries.push({ candidates: entry.candidates });
      continue;
    }
    entries.push({ candidates: Array.isArray(entry) ? entry : [entry] });
  }
  return { entries, skipped };
}
