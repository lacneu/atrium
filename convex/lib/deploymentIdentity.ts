// The identity of ONE Atrium deployment.
//
// It exists for a single decision: when an archive is imported, did it come from
// THIS deployment or from another one? The answer changes what may be reattached
// — agents and instances are meaningful only where they were recorded.
//
// It is NOT a secret, and nothing may treat it as one. An archive states its
// origin; a matching value only means "attempt to reattach", never "this caller
// is entitled to". Every reattachment is still checked against what the importing
// user may actually use. Publishing the value therefore costs nothing, and a
// forged one buys nothing.
//
// What it DOES need is to be unique across deployments. Two deployments sharing a
// value would make a foreign archive look local, and reattachment would then run
// against identifiers that mean something else here — the one failure this whole
// mechanism exists to prevent. Uniqueness comes from a CSPRNG, not from anything
// derived: two fresh deployments run the same code over the same schema, so
// anything derived from what they contain would collide by construction.

/** `atr_` + 32 lowercase hex. Prefixed so it is recognisable in a manifest. */
export const DEPLOYMENT_ID_PATTERN = /^atr_[0-9a-f]{32}$/;

/** Bytes of entropy behind one identity. 16 bytes = the collision odds of a UUID. */
export const DEPLOYMENT_ID_BYTES = 16;

/**
 * Whether a value is a well-formed deployment identity. Used on the IMPORT side,
 * where the value arrives from a file: a malformed origin is treated as foreign
 * rather than rejected, because an archive is still readable history even when
 * its provenance cannot be established.
 */
export function isDeploymentId(value: unknown): value is string {
  return typeof value === "string" && DEPLOYMENT_ID_PATTERN.test(value);
}

/** Mint one identity. Caller supplies the entropy so this stays pure + testable. */
export function formatDeploymentId(bytes: Uint8Array): string {
  if (bytes.length !== DEPLOYMENT_ID_BYTES) {
    throw new Error(
      `deployment identity needs ${DEPLOYMENT_ID_BYTES} bytes of entropy`,
    );
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `atr_${hex}`;
}

/**
 * How the backend identifies itself, or null when it does not say.
 *
 * Used ONLY to notice that a database has been restored into a different
 * deployment — never as an identity in its own right, and never as an
 * authorisation. Read defensively: an origin that cannot be read means "cannot
 * tell", which keeps the existing identity rather than replacing it.
 *
 * WHAT IT CANNOT SEE. This is an address, not an identity: a self-hosted backend
 * reports its URL, so two deployments reachable at the SAME address — two
 * developers each running a local backend on the same port — cannot be told apart
 * this way, and a database moved between them keeps one identity. The case that
 * matters is covered: a database restored anywhere reachable differently notices
 * and mints its own. Narrowing the blind spot further needs a value the backend
 * itself guarantees unique, which it does not offer.
 */
export function readDeploymentOrigin(): string | null {
  const raw =
    process.env.CONVEX_CLOUD_URL ??
    process.env.CONVEX_SITE_URL ??
    process.env.CONVEX_DEPLOYMENT ??
    null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
