// DECLARED provisioning keys — one per provisioned host.
//
// Atrium does not GENERATE these. A key it generated would have to be returned,
// captured, transported and stored by whoever installed the deployment: three
// chances to lose or log it, and an orchestration to run at the exact moment
// nothing is in place yet. The platform generates each secret instead, keeps it in
// its own vault, and DECLARES it here; Atrium only ever holds the hash and never
// has anything to hand back.
//
// Same shape as the bridge's `BRIDGE_INSTANCE_SECRETS`: one environment value,
// several entries, comma- or whitespace-separated. Each entry is
// `<label>:<secret>` — the label names the host the key belongs to, so a runaway
// automation is revoked and traced on its own rather than through a single
// platform-wide credential.

/** The environment value the platform writes. */
export const PROVISION_KEYS_ENV = "ATRIUM_PROVISION_KEYS";

/**
 * Labels become service-account names and appear in traces, so they are
 * constrained rather than free text: a label carrying a separator or whitespace
 * could not survive the round trip, and one carrying arbitrary characters would
 * make the account list unreadable.
 */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Minimum length for a declared secret. Not a strength check — a floor that
 *  catches a placeholder, an empty variable, or a truncated paste. */
const MIN_SECRET_LENGTH = 24;

export type DeclaredKey = { label: string; secret: string };

/**
 * Parse the declaration. Malformed entries are DROPPED, never guessed at: a
 * half-read entry that silently became a working credential would be worse than
 * one that never worked. `rejected` carries the labels (or a position) so the
 * reconciliation can say what it ignored — without ever naming a secret.
 */
export function parseDeclaredKeys(raw: string | undefined): {
  keys: DeclaredKey[];
  rejected: string[];
  /**
   * WELL-FORMED secrets that were dropped as ambiguous (a repeated label, or a
   * secret claimed by two labels). Kept apart because dropping them from `keys`
   * alone was a BYPASS: nothing downstream looked at them, so a secret colliding
   * with an existing manual key escaped the collision check entirely and went on
   * authenticating with that account's wider role. They authorise nothing — they
   * exist so authentication can REFUSE them.
   */
  quarantined: string[];
} {
  const parsed: DeclaredKey[] = [];
  const rejected: string[] = [];
  const occurrences = new Map<string, number>();
  const entries = (raw ?? "").split(/[,\s]+/).filter((part) => part.length > 0);
  for (const [index, entry] of entries.entries()) {
    const separator = entry.indexOf(":");
    // The secret may itself contain ':' (Atrium's own keys are `oc_<label>_…`),
    // so split on the FIRST separator only.
    const label = separator === -1 ? "" : entry.slice(0, separator);
    const secret = separator === -1 ? "" : entry.slice(separator + 1);
    const wellFormed =
      LABEL_PATTERN.test(label) && secret.length >= MIN_SECRET_LENGTH;
    // COUNT THE LABEL EVEN WHEN THE ENTRY IS MALFORMED. Counting only the
    // well-formed ones let a label appear twice — once valid, once with a
    // truncated secret — and still be applied, because the broken half had been
    // filtered out before the tally. The declaration is just as ambiguous either
    // way: the platform wrote that label twice and cannot expect one to win.
    if (LABEL_PATTERN.test(label)) {
      occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
    }
    if (!wellFormed) {
      rejected.push(LABEL_PATTERN.test(label) ? label : `#${index + 1}`);
      continue;
    }
    parsed.push({ label, secret });
  }
  const keys: DeclaredKey[] = [];
  // A repeated label is AMBIGUOUS: which secret is current? Refuse EVERY entry
  // carrying it — keeping the first would let ordering inside an environment
  // variable decide which host may provision.
  //
  // A repeated SECRET is worse: two labels would produce two `apiKeys` rows with
  // the same hash, and authentication resolves that hash with `.unique()` — which
  // THROWS rather than authenticating or refusing. Attribution would be ambiguous
  // too, which is the whole point of one key per host.
  const secretOwners = new Map<string, number>();
  for (const { secret } of parsed) {
    secretOwners.set(secret, (secretOwners.get(secret) ?? 0) + 1);
  }
  const quarantined: string[] = [];
  for (const entry of parsed) {
    if (
      (occurrences.get(entry.label) ?? 0) > 1 ||
      (secretOwners.get(entry.secret) ?? 0) > 1
    ) {
      rejected.push(entry.label);
      quarantined.push(entry.secret);
      continue;
    }
    keys.push(entry);
  }
  return {
    keys,
    rejected: [...new Set(rejected)],
    quarantined: [...new Set(quarantined)],
  };
}

/** The service-account name a label maps to. Prefixed so these accounts are
 *  distinguishable at a glance from ones an admin created by hand. */
export function provisionAccountName(label: string): string {
  return `provision:${label}`;
}

/**
 * Which declared label owns this key hash, if any. PURE — no database, no nested
 * action: the authentication path already runs where `process.env` and
 * `crypto.subtle` are available, so making this an action put a nested Convex call
 * on the critical path of EVERY authenticated request, plus one SHA-256 per
 * declared host before revocation or expiry had even been checked.
 *
 * Returns null immediately when nothing is declared, so a deployment that does not
 * use the feature pays nothing at all.
 */
export async function declarationVerdict(
  hash: string,
  hashOne: (secret: string) => Promise<string>,
  raw: string | undefined,
): Promise<{ kind: "declared"; label: string } | { kind: "quarantined" } | null> {
  if (raw === undefined || raw.trim().length === 0) return null;
  const { keys, quarantined } = parseDeclaredKeys(raw);
  for (const { label, secret } of keys) {
    if ((await hashOne(secret)) === hash) return { kind: "declared", label };
  }
  // An ambiguous entry authorises nothing, but it must still be REFUSED: dropping
  // it silently let a secret that collides with a manual key keep that account's
  // role, which is the opposite of failing closed.
  for (const secret of quarantined) {
    if ((await hashOne(secret)) === hash) return { kind: "quarantined" };
  }
  return null;
}
