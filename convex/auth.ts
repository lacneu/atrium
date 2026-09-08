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

import Google, { type GoogleProfile } from "@auth/core/providers/google";
import MicrosoftEntraID, {
  type MicrosoftEntraIDProfile,
} from "@auth/core/providers/microsoft-entra-id";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth } from "@convex-dev/auth/server";
import {
  allowedEmailDomains,
  anonAuthEnabled,
  emailDomainAllowed,
  emailVerifiedTruthy,
  extractEntraEmail,
  extractOidcEmail,
  normalizeEmail,
} from "./lib/authDomains";

// Sign-in is restricted to accounts whose email is in an allowed domain
// (lib/authDomains; default example.com placeholder, override via
// AUTH_ALLOWED_EMAIL_DOMAINS). Providers are ENV-DRIVEN so a deployment chooses
// Google (SaaS) and/or Microsoft (corporate) by which creds it sets — no code
// change. Each provider profile() is the first gate (rejects in the OAuth flow);
// the AUTHORITATIVE, convex-testable gate is lib/access.ensureProfile.

// --- Google (set AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET on the deployment) -------
// Same rule as the other two: a provider is "enabled" only when it can COMPLETE.
// Naming `AUTH_GOOGLE_SECRET` here also puts it in reach of the
// env-reaches-deployment guard, which only sees what this code reads.
const googleEnabled =
  !!process.env.AUTH_GOOGLE_ID && !!process.env.AUTH_GOOGLE_SECRET;
// And say which piece is missing, like the other two — a provider that vanishes
// without a word leaves an empty sign-in card to explain itself.
const googleMissing = [
  ...(process.env.AUTH_GOOGLE_ID ? [] : ["AUTH_GOOGLE_ID"]),
  ...(process.env.AUTH_GOOGLE_SECRET ? [] : ["AUTH_GOOGLE_SECRET"]),
];
if (googleMissing.length === 1) {
  console.error(`[auth] Google DISABLED: missing ${googleMissing[0]}.`);
}
const google = Google({
  profile(p: GoogleProfile) {
    // Google reliably sends email_verified; require it + an allowed domain.
    if (!emailVerifiedTruthy(p.email_verified)) {
      throw new Error("Email non vérifié par Google.");
    }
    // Normalized like every other email that becomes a KEY — Google states
    // lowercase in practice, but "in practice" is what the duplicate-account
    // guard used to rest on, and one un-normalized provider is enough to fork an
    // account the day a deployment adds a second one.
    const email = normalizeEmail(p.email);
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
// The SECRET counts too: without it the button renders, the person clicks, and the
// token exchange fails as the generic refusal. A provider is "enabled" only when it
// can complete — anything less is an affordance that cannot keep its promise.
const microsoftEnabled =
  !!process.env.AUTH_MICROSOFT_ENTRA_ID_ID &&
  !!process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET &&
  !!msIssuer;
// NAME WHAT IS MISSING, like Authelia below: a trio where any piece is absent
// disables the provider, and a silent disable is an empty sign-in card — or the
// "no method configured" notice on a deployment that configured one.
const microsoftMissing = [
  ...(process.env.AUTH_MICROSOFT_ENTRA_ID_ID ? [] : ["AUTH_MICROSOFT_ENTRA_ID_ID"]),
  ...(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET
    ? []
    : ["AUTH_MICROSOFT_ENTRA_ID_SECRET"]),
  ...(msIssuer ? [] : ["AUTH_MICROSOFT_ENTRA_ID_ISSUER"]),
];
if (microsoftMissing.length > 0 && microsoftMissing.length < 3) {
  console.error(
    `[auth] Microsoft DISABLED: missing ${microsoftMissing.join(", ")}. ` +
      "The issuer (tenant) is required — the 'common' multi-tenant default is refused.",
  );
}
const microsoft = MicrosoftEntraID({
  issuer: msIssuer,
  checks: ["state"],
  profile(p: MicrosoftEntraIDProfile) {
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

// --- Authelia / any self-hosted OIDC issuer -----------------------------------
// For a deployment that already runs its own single sign-on in front of its
// services — Authelia is the case this was written for, but the shape is the
// generic OIDC one, so Keycloak, Authentik or Zitadel work the same way.
//
// WHY IT IS ADDITIVE, and must stay so: a deployment that sets nothing here is
// byte-for-byte the deployment that shipped before this existed. Providers are a
// list, and several can be live at once — a NAS on Google keeps its Google
// sign-in while a VPS behind Authelia uses Authelia, from the SAME code.
//
// REFUSE without an issuer, for the reason the Entra provider refuses "common":
// the issuer IS the primary authorization here. Everything else — the email
// domain allowlist — is a secondary filter on top of it.
//
// ACCOUNT LINKING, and why the email gate matters. Convex Auth links a sign-in to
// an EXISTING user when the profile's email is verified and unique
// (`uniqueUserWithVerifiedEmail`), and it treats an OIDC email as verified unless
// the provider says otherwise. That is what lets somebody who signed in with
// Google keep their account, their canonical and their conversations when the
// deployment moves to SSO — and it is also why an issuer that explicitly denies
// `email_verified` is refused here rather than trusted into somebody else's
// account.
const autheliaIssuer = process.env.AUTH_AUTHELIA_ISSUER;
const autheliaId = process.env.AUTH_AUTHELIA_ID;
const autheliaSecret = process.env.AUTH_AUTHELIA_SECRET;
const autheliaEnabled = !!autheliaId && !!autheliaSecret && !!autheliaIssuer;
// NAME WHAT IS MISSING, not just the issuer. A trio where any one is absent or
// misspelled disables the provider, and a silent disable is a sign-in card that
// is simply empty — or worse, the "no method configured" notice on a deployment
// that configured one. The operator's next move depends on WHICH is missing, and
// this log is the only place that knows.
const autheliaMissing = [
  ...(autheliaId ? [] : ["AUTH_AUTHELIA_ID"]),
  ...(autheliaSecret ? [] : ["AUTH_AUTHELIA_SECRET"]),
  ...(autheliaIssuer ? [] : ["AUTH_AUTHELIA_ISSUER"]),
];
if (autheliaMissing.length > 0 && autheliaMissing.length < 3) {
  console.error(
    `[auth] Authelia DISABLED: missing ${autheliaMissing.join(", ")}. ` +
      "All three are required — the issuer is what authorizes, not the email.",
  );
}
const authelia = {
  id: "authelia",
  name: "Authelia",
  type: "oidc" as const,
  issuer: autheliaIssuer,
  clientId: autheliaId,
  clientSecret: autheliaSecret,
  // READ THE PROFILE FROM UserInfo, not from the ID token. convex-auth sets
  // `profile = idTokenClaims` for an oidc provider and only calls UserInfo when a
  // provider declares `idToken: false` (oauth/callback.js:125,136). Most issuers
  // keep the ID token minimal and serve `email` / `email_verified` from UserInfo
  // for the granted `email` scope — Authelia's default claims policy among them —
  // so taking the ID token would leave both claims absent, the verified-email gate
  // below would refuse EVERY sign-in, and the person would see the generic
  // "refused" message with nothing anywhere naming the cause.
  //
  // The ID token is still validated first; this only decides where the claims are
  // read from, at the cost of one request per sign-in.
  idToken: false,
  profile(p: Record<string, unknown>) {
    // REQUIRED, not merely "not denied". convex-auth treats an OIDC email as
    // verified and LINKS the sign-in into the existing account owning it, so this
    // claim is what stands between a self-hosted issuer and somebody else's
    // conversations. An earlier version here accepted an ABSENT claim, reasoning
    // that a pinned issuer vouches by being the issuer — true for a corporate
    // directory like Entra, where the email is administered, and false for an
    // issuer whose users edit their own profile. An issuer that emits no
    // `email_verified` is a configuration to fix there (Authelia's `email` scope
    // emits it), and failing closed says so instead of linking on faith.
    if (!emailVerifiedTruthy(p.email_verified)) {
      throw new Error(
        "Courriel non vérifié par le fournisseur d'identité (claim email_verified absente ou fausse).",
      );
    }
    const email = extractOidcEmail(p);
    if (!emailDomainAllowed(email)) {
      throw new Error("Domaine de courriel non autorisé.");
    }
    // undefined (NOT null) for absent fields — see the Google note above — and
    // typeof rather than a cast: `p` is Record<string, unknown>, so a claim mapper
    // emitting a number here would reach the users-table validator and fail the
    // whole sign-in with the opaque "Path .name ... v.string()" the Google note
    // exists to prevent. A cast silences the compiler, not the runtime.
    return {
      id: String(p.sub),
      name: typeof p.name === "string" ? p.name : undefined,
      email,
      image: typeof p.picture === "string" ? p.picture : undefined,
    };
  },
};

// Anonymous is DEV-ONLY (OPENCLAW_ENABLE_ANON_AUTH=1): mints a real users row +
// session with NO email. It bypasses the domain gate by design (dev) — see the
// no-email exemption in lib/access.ensureProfile, which is also flag-gated so a
// no-email OAuth identity is NOT exempt in production.
const enabled = [
  ...(googleEnabled ? ["google"] : []),
  ...(microsoftEnabled ? ["microsoft"] : []),
  ...(autheliaEnabled ? ["authelia"] : []),
  ...(anonAuthEnabled() ? ["anonymous(dev)"] : []),
];
console.log(
  `[auth] providers: ${enabled.join(", ") || "NONE"} | allowed domains: ${allowedEmailDomains().join(", ")}`,
);

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    ...(googleEnabled ? [google] : []),
    ...(microsoftEnabled ? [microsoft] : []),
    ...(autheliaEnabled ? [authelia] : []),
    ...(anonAuthEnabled() ? [Anonymous()] : []),
  ],
});
