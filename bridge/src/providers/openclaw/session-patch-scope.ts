// WHICH `sessions.patch` calls need `operator.admin`.
//
// Upstream resolves the required scope from the PARAMS, not from the method: a
// patch whose every key is in the write set needs `operator.write`, and anything
// else — `verboseLevel`, `thinkingLevel`, `fastMode` — needs `operator.admin`
// (2026.9.2, `src/shared/session-method-scopes-base.ts`, the sets and the
// `every(...) ? "operator.write" : "operator.admin"` rule).
//
// The bridge has to know this because a person's socket deliberately does NOT
// carry admin in trusted-proxy mode. Rather than sending every patch through an
// administrative socket — which would take the model picker away from the person
// choosing their model — it mirrors the rule and routes only what upstream
// actually gates. Discovered the hard way: the bench refused every turn with
// `FORBIDDEN: missing scope: operator.admin` on the once-per-connection
// `verboseLevel` patch.

/**
 * Patch fields upstream lets `operator.write` change. Kept as its own set (not
 * merged with the envelope below) so a drift check can compare them field by
 * field against the upstream file.
 */
export const SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS: ReadonlySet<string> = new Set([
  "label",
  "icon",
  "color",
  "category",
  "boardFace",
  "pinned",
  "archived",
  "unread",
  "model",
  "permissionMode",
]);

/** Addressing and optimistic-concurrency fields, which never raise the scope. */
export const SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS: ReadonlySet<string> =
  new Set([
    "key",
    "agentId",
    "expectedSessionId",
    "expectedLifecycleRevision",
    "expectedPermissionMode",
    "expectedMarkedUnreadAt",
  ]);

/**
 * True when this patch requires `operator.admin` upstream.
 *
 * `permissionMode: "full"` is admin even though `permissionMode` is otherwise a
 * write field — upstream checks that value FIRST, and so does this.
 */
export function sessionPatchNeedsAdmin(params: Record<string, unknown>): boolean {
  if (params.permissionMode === "full") return true;
  return !Object.keys(params).every(
    (key) =>
      SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS.has(key) ||
      SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS.has(key),
  );
}
