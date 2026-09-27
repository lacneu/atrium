/**
 * WHO MAY ACT ON A GATEWAY SESSION, AND WITH WHAT PERMISSIONS (OpenClaw 2026.9.6).
 *
 * The bridge reads these facts off the `sessions.describe` row it asks for on every
 * send (bridge/src/providers/openclaw/session-access.ts) and publishes them in the
 * chat's `sessionMeta`. Atrium SHOWS them and hands the mode the reader saw back as a
 * send guard; it never enforces anything on them — the gateway does.
 *
 * Pure (no Convex runtime import): the dispatch and the header share the vocabulary.
 */

/** `SessionPermissionModeSchema` (packages/gateway-protocol sessions-row.ts). */
export const SESSION_PERMISSION_MODES = [
  "read-only",
  "guarded",
  "workspace",
  "full",
] as const;
export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

/** `SessionVisibilitySchema` (sessions-sharing-values.ts). */
export const SESSION_VISIBILITIES = [
  "shared",
  "read-only",
  "suggest",
  "draft",
] as const;
export type SessionVisibility = (typeof SESSION_VISIBILITIES)[number];

/** `SessionSharingRoleSchema` (sessions-sharing-values.ts). */
export const SESSION_SHARING_ROLES = ["admin", "owner", "member", "viewer"] as const;
export type SessionSharingRole = (typeof SESSION_SHARING_ROLES)[number];

export function isSessionPermissionMode(v: unknown): v is SessionPermissionMode {
  return (
    typeof v === "string" &&
    (SESSION_PERMISSION_MODES as readonly string[]).includes(v)
  );
}

export function isSessionSharingRole(v: unknown): v is SessionSharingRole {
  return (
    typeof v === "string" && (SESSION_SHARING_ROLES as readonly string[]).includes(v)
  );
}

/** The session-meta fields this module is about — one ordered group in
 *  `stream.setSessionMeta`, all from the same describe. */
export const SESSION_ACCESS_FIELDS = [
  "visibility",
  "sharingRole",
  "permissionMode",
  "permissionModePending",
  "sessionRoot",
] as const;

/** A session meta without the access facts, for a chat that stops talking to the
 *  session they describe. Every other field — the access watermark included — kept. */
export function withoutSessionAccess<T extends object>(meta: T): T {
  const out = { ...meta } as Record<string, unknown>;
  for (const k of SESSION_ACCESS_FIELDS) delete out[k];
  return out as T;
}

/**
 * The `expectedPermissionMode` a send may carry, or `null` for NO guard.
 *
 * The gateway compares the guard with the mode STORED on the session the send lands on
 * (`entry.permissionMode ?? null`, chat-send-session-settings.ts) and refuses the turn
 * before anything runs when they differ. A guard taken from ANOTHER session therefore
 * refuses a turn the reader never saw a reason for. `sessionMeta` describes whichever
 * session this chat's bridge described last (published per CHAT, not per session key),
 * so the guard is sent only when this turn's session key —
 * `agent:<agentId>:atrium:chat:<canonical>:<openclawChatId ?? chatId>` — is provably the
 * one described:
 *
 *  - an OpenClaw instance (Hermes has no modes);
 *  - a real conversation: the hidden kinds (summarizer, documentary, curator,
 *    converter) rotate `openclawChatId` to a fresh session per job;
 *  - never per-turn routed: each agent, and each switch, is its own session, and the
 *    meta names whichever spoke last (the same reason chatFork drops it);
 *  - no rebind on this dispatch: the turn opens the new agent's session;
 *  - no stored provider id in the slot: the key is then built from the chat id and the
 *    binding alone, which nothing moves without also clearing the access facts
 *    (bindChatTarget); a stored id can be dropped or replaced under a meta described
 *    before (providerSessionClearPatch);
 *  - the meta was described for THIS agent, when it says which (`availableModelsOwner`
 *    — "" when the gateway does not scope the roster, then the rule above stands alone);
 *  - no change being applied (`permissionModePending`): upstream raises it BEFORE
 *    persisting (sessions-patch-permissions.runtime.ts), so the mode read beside it may
 *    be the one about to be replaced.
 *
 * Anything else sends no guard — exactly the behaviour before the field existed.
 *
 * The SESSION under that key can still disappear on the gateway (pruned, deleted) while
 * the key stays; the bridge's pre-send describe then finds nothing to publish. A send
 * refused on such a stale mode replaces it by `null` — what the session the send
 * creates will hold — unless a newer describe landed (bridge.forgetRefusedPermissionGuard),
 * so the retry the refusal asks for lands.
 */
export function expectedPermissionModeFor(input: {
  provider: string;
  chatKind: string | undefined;
  perTurnRouting: boolean;
  rebind: boolean;
  storedProviderSession: string | undefined;
  targetAgentId: string;
  sessionMeta:
    | {
        permissionMode?: string | null;
        permissionModePending?: boolean;
        availableModelsOwner?: string;
      }
    | undefined;
}): { mode: SessionPermissionMode | null } | null {
  const meta = input.sessionMeta;
  if (input.provider !== "openclaw") return null;
  if (input.chatKind !== undefined) return null;
  if (input.perTurnRouting || input.rebind) return null;
  if (input.storedProviderSession !== undefined) return null;
  if (meta === undefined || meta.permissionModePending === true) return null;
  const owner = meta.availableModelsOwner;
  if (typeof owner === "string" && owner !== "" && owner !== input.targetAgentId) {
    return null;
  }
  if (meta.permissionMode === null) return { mode: null };
  return isSessionPermissionMode(meta.permissionMode)
    ? { mode: meta.permissionMode }
    : null;
}
