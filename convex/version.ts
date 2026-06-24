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
// Kept in lockstep with the other artifacts by scripts/set-version.mjs (which stamps
// it from the release tag). Bump alongside the CHANGELOG when preparing a release.
export const DEPLOYED_VERSION = "0.10.5";
