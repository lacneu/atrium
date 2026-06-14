// Convex Auth setup (Google sign-in).
//
// This wires @convex-dev/auth with the Google OAuth provider. The exported
// `auth`, `signIn`, `signOut`, `store`, and `isAuthenticated` are consumed by
// `convex/http.ts` (the auth HTTP routes) and by the public functions in this
// project via `getAuthUserId(ctx)`.
//
// SECURITY / DEPLOYMENT:
//   - Google client id/secret are read from deployment env, NOT from source or
//     tables. On a live deployment set them with:
//       npx convex env set AUTH_GOOGLE_ID <client-id>
//       npx convex env set AUTH_GOOGLE_SECRET <client-secret>
//     (@auth/core's Google provider defaults to AUTH_GOOGLE_ID /
//      AUTH_GOOGLE_SECRET.)
//   - REQUIRES A LIVE DEPLOYMENT to actually authenticate; offline this file is
//     just configuration and will not run.
//
// NOTE: @convex-dev/auth also requires an auth-specific schema (authTables) and
// `convex/http.ts` to expose the OAuth callback routes. authTables is spread in
// schema.ts; http.ts registers the routes.

import Google from "@auth/core/providers/google";
import MicrosoftEntraID from "@auth/core/providers/microsoft-entra-id";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth } from "@convex-dev/auth/server";
import {
  allowedEmailDomains,
  anonAuthEnabled,
  emailDomainAllowed,
  emailVerifiedTruthy,
  extractEntraEmail,
} from "./lib/authDomains";

// Sign-in is restricted to accounts whose email is in an allowed domain
// (lib/authDomains; default example.com placeholder, override via
// AUTH_ALLOWED_EMAIL_DOMAINS). Providers are ENV-DRIVEN so a deployment chooses
// Google (SaaS) and/or Microsoft (corporate) by which creds it sets — no code
// change. Each provider profile() is the first gate (rejects in the OAuth flow);
// the AUTHORITATIVE, convex-testable gate is lib/access.ensureProfile.

// --- Google (set AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET on the deployment) -------
const googleEnabled = !!process.env.AUTH_GOOGLE_ID;
const google = Google({
  profile(p: Record<string, unknown>) {
    // Google reliably sends email_verified; require it + an allowed domain.
    if (!emailVerifiedTruthy(p.email_verified)) {
      throw new Error("Email non vérifié par Google.");
    }
    const email = p.email as string | undefined;
    if (!emailDomainAllowed(email)) {
      throw new Error("Domaine de courriel non autorisé.");
    }
    // NOTE: return undefined (NOT null) for absent fields. The users table
    // (authTables) validates name/image as v.optional(v.string()), which accepts
    // "string or ABSENT" but REJECTS null — a Google account with no `picture`
    // would otherwise crash the OAuth user upsert ("Path .image ... v.string()").
    return {
      id: p.sub as string,
      name: (p.name as string | undefined) ?? undefined,
      email,
      image: (p.picture as string | undefined) ?? undefined,
    };
  },
});

// --- Microsoft Entra ID (corporate; set AUTH_MICROSOFT_ENTRA_ID_ID/_SECRET) ---
// REFUSE without a tenant issuer: an omitted issuer defaults to "common" =
// EVERY Microsoft tenant + personal accounts, gated only by a mutable email →
// fail-OPEN. The tenant (issuer) is the primary authorization; the email-domain
// allowlist is a secondary filter (set AUTH_ALLOWED_EMAIL_DOMAINS to the tenant
// domains). checks:["state"] — PKCE breaks with convex-auth + Entra (get-convex/
// convex-auth#235). No email_verified requirement: a token from the pinned
// tenant is vouched by the directory.
const msIssuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
const microsoftEnabled = !!process.env.AUTH_MICROSOFT_ENTRA_ID_ID && !!msIssuer;
if (process.env.AUTH_MICROSOFT_ENTRA_ID_ID && !msIssuer) {
  console.error(
    "[auth] Microsoft DISABLED: AUTH_MICROSOFT_ENTRA_ID_ISSUER (tenant) is required — refusing the 'common' multi-tenant default.",
  );
}
const microsoft = MicrosoftEntraID({
  issuer: msIssuer,
  checks: ["state"],
  profile(p: Record<string, unknown>) {
    const email = extractEntraEmail(p);
    if (!emailDomainAllowed(email)) {
      throw new Error("Domaine de courriel non autorisé.");
    }
    // undefined (NOT null) for absent fields — see the Google note above. Entra
    // has no picture → image omitted (undefined), never null.
    return {
      id: p.sub as string,
      name: (p.name as string | undefined) ?? undefined,
      email,
      image: undefined,
    };
  },
});

// Anonymous is DEV-ONLY (OPENCLAW_ENABLE_ANON_AUTH=1): mints a real users row +
// session with NO email. It bypasses the domain gate by design (dev) — see the
// no-email exemption in lib/access.ensureProfile, which is also flag-gated so a
// no-email OAuth identity is NOT exempt in production.
const enabled = [
  ...(googleEnabled ? ["google"] : []),
  ...(microsoftEnabled ? ["microsoft"] : []),
  ...(anonAuthEnabled() ? ["anonymous(dev)"] : []),
];
console.log(
  `[auth] providers: ${enabled.join(", ") || "NONE"} | allowed domains: ${allowedEmailDomains().join(", ")}`,
);

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    ...(googleEnabled ? [google] : []),
    ...(microsoftEnabled ? [microsoft] : []),
    ...(anonAuthEnabled() ? [Anonymous()] : []),
  ],
});
