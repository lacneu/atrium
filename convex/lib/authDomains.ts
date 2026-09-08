// Email-domain allowlist for OAuth sign-in (Google). The authoritative gate runs
// in lib/access.ensureProfile (the single role-writer — convex-testable); the
// provider's profile() in auth.ts is the first line that rejects at the OAuth
// flow. Pure helpers (no ctx) so both can share them.
//
// FAIL-CLOSED: when AUTH_ALLOWED_EMAIL_DOMAINS is unset, the built-in placeholder
// domain applies — a missing/empty env never opens sign-in to everyone. Every
// deployment MUST set its own allowlist:
//   npx convex env set AUTH_ALLOWED_EMAIL_DOMAINS "a.com,b.com"

const DEFAULT_ALLOWED = "example.com";

/** Resolved, normalized allowlist (lowercased, trimmed, non-empty). */
export function allowedEmailDomains(): string[] {
  return (process.env.AUTH_ALLOWED_EMAIL_DOMAINS ?? DEFAULT_ALLOWED)
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

/**
 * Is this email in an allowed domain? EXACT match on the segment after the LAST
 * `@` (so `evil-example.com` and `example.com.evil.com` are rejected — never use
 * endsWith). Empty/missing email → false.
 */
export function emailDomainAllowed(email: string | undefined | null): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (domain.length === 0) return false;
  return allowedEmailDomains().includes(domain);
}

/** Google stringifies `email_verified` inconsistently; accept bool or "true". */
export function emailVerifiedTruthy(v: unknown): boolean {
  return v === true || v === "true";
}

/**
 * The one normalization every email crosses before it becomes a KEY.
 *
 * Two exact-equality lookups decide whether a person keeps their account:
 * convex-auth's `uniqueUserWithVerifiedEmail` and `ensureProfile`'s `by_email`
 * index. Normalizing in one extractor and not the other is the same bug as not
 * normalizing at all — it just needs two providers to show itself: an Entra
 * deployment that stored `Alice@Example.com` and later adopts SSO would fork a
 * second profile instead of linking. Shared so the next extractor cannot drift.
 */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length > 0 ? email : undefined;
}

/**
 * The email a self-hosted OIDC issuer states, or undefined when it states none.
 *
 * `email` AND NOTHING ELSE, deliberately. Convex Auth links a sign-in into an
 * EXISTING account whose email matches, and treats an OIDC email as verified
 * unless the provider says otherwise — so whatever this returns is a key into
 * other people's accounts. `extractEntraEmail` also reads `upn` and
 * `preferred_username`, and can: a pinned Entra tenant is a corporate directory
 * where those claims are administered. A self-hosted issuer is a different world
 * — Keycloak and Authentik both offer self-service profile editing — and there
 * `preferred_username` is whatever the account holder last typed. Accepting it
 * would let somebody set theirs to a colleague's address and be linked into that
 * colleague's Atrium account, conversations included.
 *
 * An issuer that emits no `email` claim is a configuration to fix on the issuer
 * (Authelia's `email` scope), not a claim to substitute for here.
 */
export function extractOidcEmail(profile: unknown): string | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const p = profile as Readonly<{ email?: unknown }>;

  // NORMALIZED, and that is the whole point of the migration story. This value is
  // an EXACT-equality key twice over: convex-auth links a sign-in to an existing
  // account through `uniqueUserWithVerifiedEmail`, and `ensureProfile` refuses a
  // duplicate through the `by_email` index. A self-hosted issuer states whatever
  // its backend holds — an LDAP or file backend happily says `Alice@Example.com`
  // for the account Google stored as `alice@example.com`. Unnormalized, that
  // passes the domain gate, misses BOTH lookups, and silently creates a second
  // profile: the person keeps neither their canonical nor their conversations,
  // which is the opposite of what moving to SSO is supposed to preserve.
  return normalizeEmail(p.email);
}

/** The dev Anonymous provider (no email) is enabled ONLY with this flag. Shared
 *  so auth.ts (provider list) and access.ts (the no-email exemption) agree. */
export function anonAuthEnabled(): boolean {
  return process.env.OPENCLAW_ENABLE_ANON_AUTH === "1";
}

/**
 * Extract a usable email from a Microsoft Entra profile. Prefer the canonical
 * `upn` over the MUTABLE `preferred_username`; `email` first when present. This
 * feeds only the SECONDARY domain filter — the tenant (issuer) is the primary
 * authorization. Returns undefined if no claim carries an email (→ fail-closed).
 */
export function extractEntraEmail(
  profile: unknown,
): string | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const p = profile as Readonly<{
    email?: unknown;
    upn?: unknown;
    preferred_username?: unknown;
  }>;
  // Normalized like every other email that becomes a key — see normalizeEmail.
  return normalizeEmail(p.email ?? p.upn ?? p.preferred_username);
}
