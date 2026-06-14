// Convex Auth provider configuration.
//
// This file declares the JWT issuer(s) Convex trusts for `ctx.auth`. When
// using @convex-dev/auth (the library that issues its own JWTs), the canonical
// provider entry points at your own deployment with applicationID "convex".
//
// REQUIRES A LIVE DEPLOYMENT: `process.env.CONVEX_SITE_URL` is only defined on
// a running Convex deployment. The Google OAuth provider itself is configured
// in `convex/auth.ts` (see that file); the secrets it needs
// (AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET) are set with `npx convex env set ...`
// on the deployment and are NEVER committed or stored in tables.
//
// Placeholders below are intentional — fill in via the Convex dashboard /
// `convex env` on the live deployment, not in source.

export default {
  providers: [
    {
      // @convex-dev/auth issues tokens from your own deployment.
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
