// Pure domain helpers for the "charte par domaine" feature. Used by BOTH the admin
// WRITE path (normalizeDomain, when an admin maps a domain to a chart) and the
// server RESOLVER (hostCandidates, when a request's host is matched to a chart),
// so the stored key and the lookup keys can NEVER drift. Imports nothing from
// Convex -> unit-testable in isolation (convex/lib/domains.test.ts).
//
// Matching: exact host ("chat.acme.com") OR wildcard ("*.acme.com", any depth of
// subdomain). A wildcard's BASE must keep >= 2 labels, so "*.com" / single-label
// wildcards are impossible (a tenant can never claim a whole TLD). The apex
// ("acme.com") is NOT covered by "*.acme.com" -- map it explicitly if wanted.

/** Strip scheme / path / query / fragment / port / trailing dot, and lowercase. */
function bareHost(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme://
  s = s.split("/")[0].split("?")[0].split("#")[0]; // path/query/fragment
  s = s.split(":")[0]; // port
  s = s.replace(/\.+$/, ""); // trailing dot(s)
  return s;
}

/** A single DNS label: alphanumeric, hyphens allowed inside (not at the ends),
 *  max 63 chars (DNS bound). */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Upper bound on labels. Real hosts have a handful; this CAPS the wildcard
 *  expansion in hostCandidates (one indexed read per candidate, on the PUBLIC
 *  pre-auth brandForHost path) so a client-supplied host with absurdly many
 *  labels can never drive an unbounded CPU/DB walk. Symmetric write=read: an
 *  over-long domain is also un-mappable by normalizeDomain. */
const MAX_LABELS = 10;

/** A registrable host needs 2..MAX_LABELS valid labels (reject bare TLDs / junk
 *  / absurdly deep hosts). */
function validLabels(labels: string[]): boolean {
  return (
    labels.length >= 2 &&
    labels.length <= MAX_LABELS &&
    labels.every((l) => LABEL_RE.test(l))
  );
}

/**
 * Normalize an admin-entered domain pattern to its canonical stored form, or null
 * if invalid. Accepts an exact host ("chat.acme.com") or a wildcard ("*.acme.com").
 * Rejects bare TLDs and single-label wildcards: the base must have >= 2 labels.
 */
export function normalizeDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  const isWildcard = raw.startsWith("*.");
  const base = bareHost(isWildcard ? raw.slice(2) : raw);
  if (base === "") return null;
  const labels = base.split(".");
  if (!validLabels(labels)) return null;
  return isWildcard ? `*.${base}` : base;
}

/**
 * Lookup keys for a real request host, MOST-SPECIFIC FIRST: the exact host, then
 * wildcard patterns dropping the leftmost label while the remaining base keeps
 * >= 2 labels (so we never emit "*.<tld>"). Returns [] for an invalid host
 * (e.g. "localhost" -> dev no-op, falls back to current behavior).
 */
export function hostCandidates(host: string): string[] {
  const base = bareHost(host);
  if (base === "" || base.startsWith("*")) return [];
  const labels = base.split(".");
  if (!validLabels(labels)) return [];
  const out: string[] = [base]; // exact match
  for (let i = 1; i <= labels.length - 2; i++) {
    out.push(`*.${labels.slice(i).join(".")}`);
  }
  return out;
}
