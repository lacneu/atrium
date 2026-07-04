// The version of the Convex FUNCTIONS in this tree. Unlike the bridge/frontend
// (whose version ships baked into a Docker image), the Convex functions are pushed
// by a SEPARATE manual step -- `npx convex deploy` from the repo root -- which
// rebuilding images and restarting containers does NOT do. That made the deployed
// functions the one layer with no visible version: a forgotten `convex deploy` was
// invisible until a feature silently failed.
//
// This constant is bundled at `convex deploy` time and served at /api/v1/version, so
// the deployed functions self-report their version. If you forget to redeploy, the
// route keeps returning the OLD value -- a mismatch with the bridge/frontend image
// versions makes the missed deploy obvious in one check.
//
// Kept in LOCKSTEP with the bridge/frontend/mcp versions by scripts/set-version.mjs.
// Do NOT hand-edit. Unlike those (whose version is stamped into a CI-built image), the
// Convex functions are pushed by a MANUAL `npx convex deploy` from the COMMITTED tree —
// so this constant is committed AT the release version (set-version is run during
// release prep, bumping every artifact together). That keeps a plain `npx convex deploy`
// from the release tree honest: /api/v1/version reports the real deployed version, and a
// forgotten deploy stands out as a mismatch with the image versions.
export const DEPLOYED_VERSION = "0.26.0";
