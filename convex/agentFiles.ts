// Agent workspace files + session/config actions over the bridge (CONF-4c/4d).
//
// Surface:
//   - listAgentFiles / getAgentFile — read agent workspace files via the bridge
//     `POST /agent-files` ({ op: "list" | "get" }). RBAC (amendment A3): admins
//     see everything; a non-admin needs `agents.files.read` AND is restricted
//     SERVER-SIDE to the RULES_FILES allowlist (AGENTS/SOUL/IDENTITY/TOOLS .md).
//     Memory/user/boot files stay admin-only even in read — agents are shared
//     between users and their memory contains other people's data.
//   - setAgentFile — ADMIN-ONLY write with compare-and-set (amendment A4): the
//     bridge op "set" carries `baseUpdatedAtMs`; a 409 means the file changed
//     since it was loaded (the caller must re-get + re-diff). Every successful
//     write records a FULL before/after revision (agentFileRevisions) + audit.
//   - compactSession — owner-scoped `POST /compact` (same routed body shape as
//     dispatchReset) asking the gateway to compact the session context.
//   - getChatDefaults / setChatDefaults — admin-only global chat defaults via
//     `POST /config-defaults` (gateway config.get/patch behind the bridge).
//
// BRIDGE CONTRACT (mirrors bridge.ts): single `BRIDGE_URL` + bare
// `BRIDGE_SHARED_SECRET` Authorization header from deployment env. There is no
// per-instance bridge registry yet (Phase 2b deferred) — `instanceName` rides in
// the body and the bridge REFUSES a name it does not serve (409
// `instance_mismatch`, the same guard as /reset — red-team P2-3).
//
// These are PUBLIC actions invoked by the browser, so unlike the scheduled
// dispatch actions they THROW on failure (the caller renders the error); error
// messages carry a stable leading code (e.g. "conflict:", "bridge_error:").

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  getActor,
  getProfile,
  requireActive,
  requireOwnedChat,
  requirePermission,
  requireRealUserId,
  roleOf,
} from "./lib/access";
import { getEffectiveGrants } from "./agents";
import { auditImpersonated } from "./lib/audit";
import { PERMISSIONS } from "./lib/rbac";

// ===========================================================================
// Pure policy (exported for unit tests)
// ===========================================================================

/**
 * The RULE files a non-admin holding `agents.files.read` may read (amendment
 * A3). Everything else the bridge lists (USER.md, MEMORY.md, HEARTBEAT.md,
 * BOOT.md, BOOTSTRAP.md, ...) is ADMIN-ONLY even in read: agents are shared
 * between users, so memory-class files contain other people's data. This
 * filtering is SERVER-side policy — UI hiding is never the enforcement.
 */
export const RULES_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
] as const;

/** True when `name` is a rules file readable under `agents.files.read`. */
export function isRulesFile(name: string): boolean {
  return (RULES_FILES as readonly string[]).includes(name);
}

/**
 * Role-based file-list filter: admins see the full bridge listing; everyone
 * else only the RULES_FILES entries. Pure so the policy is unit-testable
 * without mocking the bridge.
 */
export function filterFilesForRole<T extends { name: string }>(
  files: T[],
  isAdmin: boolean,
): T[] {
  if (isAdmin) return files;
  return files.filter((f) => isRulesFile(f.name));
}

/** Thinking levels the gateway accepts (bench-verified enum, CONF probes). */
export const THINKING_DEFAULTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** Write cap for setAgentFile content (gateway bootstrap files are ~tens of kB). */
export const MAX_AGENT_FILE_CHARS = 64_000;

// ===========================================================================
// Bridge transport (action-side; default runtime fetch)
// ===========================================================================

// Bounded timeout so a hung bridge cannot stall a user-facing action.
// Default caller-side abort: fits the FAST bridge ops (agent-files get/set/list,
// config-defaults GET) whose gateway RPCs are sub-second.
const BRIDGE_TIMEOUT_MS = 15_000;
// LONG-running bridge ops need a caller timeout ABOVE the bridge's own budget,
// else this POST aborts mid-op and the user sees a FALSE "bridge unreachable"
// for work that actually succeeds gateway-side (Convex actions allow up to
// 10 min = 600s, so these are well within the platform ceiling). The budget MUST
// include the gateway CONNECT (the bridge opens a fresh/cold operator socket —
// CONNECT_TIMEOUT_MS = 30s — BEFORE the RPC), which the previous values omitted.
//   /compact  — HARD bound (no loop): registry.acquire (connect ≤30s) +
//   sessions.compact (bridge cap 60s) = 90s max. 120s is PROVABLY above it.
const COMPACT_TIMEOUT_MS = 120_000; // = connect 30 + compact 60 + 30 margin
//   /config-defaults SET — NOT a capped RPC, it is a LOOP, so there is no exact
//   number: withOperatorConnection (connect ≤30s) + config.get(10)+config.patch(15)
//   (+1 base-hash retry) + read-back(10), THEN confirmDefaultsAfterRestart =
//   8 × (sleep 2s + connect + config.get 8s). Realistic worst ≈ connect 30 + ops
//   ~35 + recovery ~25 = ~90s (a restarting gateway refuses connects fast); the
//   THEORETICAL worst (every recovery connect at the full 30s) ≈ 320s is NOT
//   chased — 150s covers the realistic path with margin (still 1/4 of the 600s
//   ceiling). The pathological recovery stall can still false-abort; the write
//   likely applied and the baseHash CAS guards a double-apply on re-save.
const CONFIG_DEFAULTS_SET_TIMEOUT_MS = 150_000; // connect 30 + ops ~35 + recovery ~25 + margin

/**
 * POST a JSON body to the bridge with the shared-secret Authorization header
 * (same env contract as bridge.dispatch). Returns the HTTP status + parsed JSON
 * (null when the body is empty/non-JSON). Throws only on missing config or a
 * transport failure — HTTP status handling is the caller's policy (409 = CAS
 * conflict on set, etc.). `timeoutMs` is the caller-side abort; pass a value
 * above the bridge's own budget for long ops (see the constants above).
 */
async function postBridge(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number = BRIDGE_TIMEOUT_MS,
): Promise<{ status: number; data: unknown }> {
  const bridgeUrl = process.env.BRIDGE_URL;
  const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
  if (!bridgeUrl || !sharedSecret) {
    throw new Error(
      "bridge_unconfigured: BRIDGE_URL / BRIDGE_SHARED_SECRET not set",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Shared secret authenticates Convex -> bridge (server-to-server). Bare
        // value (NOT `Bearer`-prefixed) to match bridge.dispatch.
        Authorization: sharedSecret,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null; // tolerate an empty/non-JSON body
    }
    return { status: response.status, data };
  } catch (err) {
    // Network error / abort / DNS. NEVER include the secret in the message.
    console.error(`agentFiles: bridge POST ${path} failed (network/abort)`);
    throw new Error("bridge_error: bridge unreachable");
  } finally {
    clearTimeout(timer);
  }
}

function requireOkStatus(status: number, op: string): void {
  if (status < 200 || status >= 300) {
    throw new Error(`bridge_error: ${op} -> HTTP ${status}`);
  }
}

// ===========================================================================
// Internal gates (actions have no ctx.db — auth checks run in queries/mutations
// with the caller's identity propagated through ctx.runQuery/runMutation)
// ===========================================================================

/**
 * Read gate for the files surface: admin (REAL identity, as everywhere) passes
 * with full visibility; otherwise `agents.files.read` is required and the
 * caller is flagged non-admin so the actions apply the RULES_FILES filter.
 * The permission only opens the SURFACE — the (instanceName, agentId) target
 * must additionally be in the caller's effective agent set (direct userAgents
 * ∪ group shares, the SAME union the picker/routing use), enforced here
 * server-side (red-team P2-1: never trust the UI's agent selector).
 */
export const checkFilesReadAccess = internalQuery({
  args: { instanceName: v.string(), agentId: v.string() },
  handler: async (
    ctx,
    { instanceName, agentId },
  ): Promise<{ isAdmin: boolean }> => {
    const userId = await requireRealUserId(ctx);
    const isAdmin = roleOf(await getProfile(ctx, userId)) === "admin";
    if (!isAdmin) {
      await requirePermission(ctx, PERMISSIONS.AGENT_FILES_READ);
      const grants = await getEffectiveGrants(ctx, userId);
      const accessible = grants.some(
        (g) => g.instanceName === instanceName && g.agentId === agentId,
      );
      if (!accessible) {
        throw new Error("forbidden: agent not accessible");
      }
    }
    return { isAdmin };
  },
});

/** Admin-only gate (REAL identity — impersonation never grants/removes it). */
export const checkAdminAccess = internalQuery({
  args: {},
  handler: async (ctx): Promise<null> => {
    await requirePermission(ctx, PERMISSIONS.ADMIN_MANAGE);
    return null;
  },
});

/** Owner gate for compactSession: ACTIVE caller + chat ownership. */
export const checkChatOwnership = internalQuery({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<{ userId: Id<"users"> }> => {
    const { userId } = await requireActive(ctx);
    await requireOwnedChat(ctx, userId, chatId);
    return { userId };
  },
});

/**
 * Record a successful agent-file write: FULL before/after revision row
 * (amendment A4 — rollback source) + the impersonation-aware audit entry, in
 * one transaction. `byUserId` is the REAL operator.
 */
export const recordFileRevision = internalMutation({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    name: v.string(),
    before: v.string(),
    after: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const actor = await getActor(ctx);
    await ctx.db.insert("agentFileRevisions", {
      instanceName: args.instanceName,
      agentId: args.agentId,
      name: args.name,
      before: args.before,
      after: args.after,
      byUserId: actor.realUserId,
      at: Date.now(),
    });
    await auditImpersonated(ctx, actor, "agent_file.write", {
      resource: "agentFile",
      resourceId: `${args.instanceName}/${args.agentId}/${args.name}`,
    });
    return null;
  },
});

/** Impersonation-aware audit entry written from an action (no ctx.db there). */
export const auditFromAction = internalMutation({
  args: {
    action: v.string(),
    resource: v.optional(v.string()),
    resourceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const actor = await getActor(ctx);
    await auditImpersonated(ctx, actor, args.action, {
      resource: args.resource,
      resourceId: args.resourceId,
    });
    return null;
  },
});

// ===========================================================================
// Response parsing (defensive: the bridge defines the shapes — see CONF probes
// `list` -> { name, path, missing, size, updatedAtMs }, `get` -> { file: ... })
// ===========================================================================

// NOTE: no `path` here (red-team P2-2) — the gateway's filesystem path is a
// server detail that must never cross to the browser; the bridge strips it and
// this parser would drop it anyway.
type AgentFileInfo = {
  name: string;
  missing?: boolean;
  size?: number;
  updatedAtMs?: number;
};

function parseFileList(data: unknown): AgentFileInfo[] {
  const raw = (data as { files?: unknown })?.files;
  const list = Array.isArray(raw) ? raw : Array.isArray(data) ? data : [];
  const out: AgentFileInfo[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name.length === 0) continue;
    out.push({
      name: e.name,
      ...(typeof e.missing === "boolean" ? { missing: e.missing } : {}),
      ...(typeof e.size === "number" ? { size: e.size } : {}),
      ...(typeof e.updatedAtMs === "number"
        ? { updatedAtMs: e.updatedAtMs }
        : {}),
    });
  }
  return out;
}

// ===========================================================================
// Public actions
// ===========================================================================

/** List an agent's workspace files (role-filtered server-side, A3). */
export const listAgentFiles = action({
  args: { instanceName: v.string(), agentId: v.string() },
  handler: async (
    ctx,
    { instanceName, agentId },
  ): Promise<{ files: AgentFileInfo[] }> => {
    const access: { isAdmin: boolean } = await ctx.runQuery(
      internal.agentFiles.checkFilesReadAccess,
      { instanceName, agentId },
    );
    const { status, data } = await postBridge("/agent-files", {
      op: "list",
      instanceName,
      agentId,
    });
    requireOkStatus(status, "agent-files list");
    return { files: filterFilesForRole(parseFileList(data), access.isAdmin) };
  },
});

/** Read one workspace file. Non-admin: the name MUST be a rules file (A3). */
export const getAgentFile = action({
  args: { instanceName: v.string(), agentId: v.string(), name: v.string() },
  handler: async (
    ctx,
    { instanceName, agentId, name },
  ): Promise<{
    name: string;
    content: string;
    updatedAtMs: number | null;
    missing: boolean;
  }> => {
    const access: { isAdmin: boolean } = await ctx.runQuery(
      internal.agentFiles.checkFilesReadAccess,
      { instanceName, agentId },
    );
    // SERVER-side allowlist gate, before any bridge call: a non-admin may only
    // read the rules files — never memory/user/boot files (A3).
    if (!access.isAdmin && !isRulesFile(name)) {
      throw new Error(`Forbidden: file not readable: ${name}`);
    }
    const { status, data } = await postBridge("/agent-files", {
      op: "get",
      instanceName,
      agentId,
      name,
    });
    requireOkStatus(status, "agent-files get");
    const file = (data as { file?: unknown })?.file as
      | Record<string, unknown>
      | undefined;
    if (!file) {
      throw new Error("bridge_error: agent-files get -> malformed response");
    }
    // A `missing` (not-yet-created) file is EDITABLE, not an error (red-team
    // P3-2): empty content and NO CAS base — the editor saves it via
    // setAgentFile WITHOUT baseUpdatedAtMs (creation, bridge skips the CAS).
    if (file.missing === true || typeof file.content !== "string") {
      return { name, content: "", updatedAtMs: null, missing: true };
    }
    return {
      name,
      content: file.content,
      updatedAtMs:
        typeof file.updatedAtMs === "number" ? file.updatedAtMs : null,
      missing: false,
    };
  },
});

/**
 * Write one workspace file (ADMIN-ONLY). Compare-and-set via `baseUpdatedAtMs`
 * (the updatedAtMs the editor loaded): the bridge re-gets before set and
 * answers 409 when the file changed since — surfaced as a stable
 * "conflict: ..." error the UI can detect. On success, records the full
 * before/after revision + audit. The gateway additionally restricts writes to
 * its bootstrap-file allowlist (bench-verified native defense).
 */
export const setAgentFile = action({
  args: {
    instanceName: v.string(),
    agentId: v.string(),
    name: v.string(),
    content: v.string(),
    // Absent only for a `missing` (not-yet-created) file; the bridge skips CAS then.
    baseUpdatedAtMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { instanceName, agentId, name, content, baseUpdatedAtMs },
  ): Promise<null> => {
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    if (content.length > MAX_AGENT_FILE_CHARS) {
      throw new Error(
        `Invalid content: exceeds ${MAX_AGENT_FILE_CHARS} characters`,
      );
    }
    const { status, data } = await postBridge("/agent-files", {
      op: "set",
      instanceName,
      agentId,
      name,
      content,
      baseUpdatedAtMs: baseUpdatedAtMs ?? null,
    });
    if (status === 409) {
      // Stable, detectable CAS-conflict code (the editor re-gets + re-diffs).
      throw new Error("conflict: file changed since load");
    }
    requireOkStatus(status, "agent-files set");
    // The bridge echoes the pre-write content (`before.content`) so the revision
    // holds the FULL before/after pair (A4). Defensive: tolerate a missing echo.
    const before = (data as { before?: { content?: unknown } })?.before
      ?.content;
    await ctx.runMutation(internal.agentFiles.recordFileRevision, {
      instanceName,
      agentId,
      name,
      before: typeof before === "string" ? before : "",
      after: content,
    });
    return null;
  },
});

/**
 * Compact the gateway session context for a chat the caller OWNS. POSTs the
 * bridge `/compact` with the SAME routed body shape as dispatchReset (chatId +
 * openclawChatId + resolved instance/agent/canonical).
 */
export const compactSession = action({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<null> => {
    const { userId }: { userId: Id<"users"> } = await ctx.runQuery(
      internal.agentFiles.checkChatOwnership,
      { chatId },
    );
    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId,
      userId,
    });
    if (!routing || routing.target === null) {
      throw new Error("no_agent: chat has no routed agent");
    }
    const { status } = await postBridge(
      "/compact",
      {
        chatId,
        openclawChatId: routing.openclawChatId,
        instanceName: routing.target.instanceName,
        agentId: routing.target.agentId,
        canonical: routing.target.canonical,
      },
      COMPACT_TIMEOUT_MS,
    );
    requireOkStatus(status, "compact");
    await ctx.runMutation(internal.agentFiles.auditFromAction, {
      action: "chat.compact",
      resource: "chat",
      resourceId: chatId,
    });
    return null;
  },
});

/**
 * Resolve the instance to claim in `/config-defaults` bodies (red-team P2-3):
 * the explicit arg when given, else the single configured instance (the
 * mono-instance case, mirroring how chat-bound calls resolve their target via
 * routing). With several instances and no arg the claim is omitted — the
 * bridge instance guard only compares DECLARED names (same as /reset).
 */
async function resolveInstanceClaim(
  ctx: ActionCtx,
  given: string | undefined,
): Promise<string | null> {
  if (given !== undefined) return given;
  const names: string[] = await ctx.runQuery(
    internal.agents.listInstanceNames,
    {},
  );
  return names.length === 1 ? names[0] : null;
}

/** Admin-only read of the gateway's global chat defaults (CONF-4d, deflated A7). */
export const getChatDefaults = action({
  args: { instanceName: v.optional(v.string()) },
  handler: async (ctx, { instanceName }): Promise<unknown> => {
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    const claim = await resolveInstanceClaim(ctx, instanceName);
    const { status, data } = await postBridge("/config-defaults", {
      op: "get",
      ...(claim !== null ? { instanceName: claim } : {}),
    });
    requireOkStatus(status, "config-defaults get");
    return data;
  },
});

/**
 * Admin-only write of the gateway's global chat defaults. Hard-coded form (A7):
 * only `thinkingDefault` (validated against the bench-verified enum) and
 * `fastModeDefault` are exposed; the bridge/gateway re-validate against
 * `config.schema` at apply time.
 */
export const setChatDefaults = action({
  args: {
    thinkingDefault: v.optional(v.string()),
    fastModeDefault: v.optional(v.boolean()),
    instanceName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { thinkingDefault, fastModeDefault, instanceName },
  ): Promise<null> => {
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    if (
      thinkingDefault !== undefined &&
      !(THINKING_DEFAULTS as readonly string[]).includes(thinkingDefault)
    ) {
      throw new Error("Invalid thinkingDefault");
    }
    if (thinkingDefault === undefined && fastModeDefault === undefined) {
      throw new Error("Invalid: nothing to set");
    }
    const claim = await resolveInstanceClaim(ctx, instanceName);
    const { status } = await postBridge(
      "/config-defaults",
      {
        op: "set",
        ...(thinkingDefault !== undefined ? { thinkingDefault } : {}),
        ...(fastModeDefault !== undefined ? { fastModeDefault } : {}),
        ...(claim !== null ? { instanceName: claim } : {}),
      },
      CONFIG_DEFAULTS_SET_TIMEOUT_MS,
    );
    requireOkStatus(status, "config-defaults set");
    await ctx.runMutation(internal.agentFiles.auditFromAction, {
      action: "admin.chat_defaults",
      resource: "config",
      resourceId: "chat_defaults",
    });
    return null;
  },
});
