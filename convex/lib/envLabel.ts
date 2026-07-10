// The deployment's ENVIRONMENT LABEL (ATRIUM_ENV_LABEL, e.g. "dev" / "prod").
//
// One label, stamped into every artifact a deployment hands out, so a
// copy-pasted identifier is never ambiguous about WHERE it came from — the
// same idea as a Convex deploy key embedding its deployment name
// (`prod:deployment|secret`):
//   - feedback report references:  `<label>-<id>`   (feedback.displayReference)
//   - minted API keys:             `oc_<label>_<secret>` (lib/apikeys)
// Unset → null: callers fall back to their unlabeled legacy shape, fully
// backward-compatible. Lowercase alphanumerics only (defense against header
// injection through a copy-pasted reference/key).

export function envLabel(): string | null {
  const raw = process.env.ATRIUM_ENV_LABEL ?? "";
  const label = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.]{0,15}$/.test(label) ? label : null;
}
