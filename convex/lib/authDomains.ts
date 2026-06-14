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
  p: Record<string, unknown>,
): string | undefined {
  const cand = (p.email ?? p.upn ?? p.preferred_username) as
    | string
    | undefined;
  return typeof cand === "string" && cand.length > 0 ? cand : undefined;
}
