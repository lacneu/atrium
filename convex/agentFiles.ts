// Agent workspace files + session/config actions over the bridge (CONF-4c/4d).
//
// Surface:
//   - listAgentFiles / getAgentFile — read agent workspace files via the bridge
//     `POST /agent-files` ({ op: "list" | "get" }). RBAC (amendment A3v2,
//     GRANT-ALIGNED): admins see every agent; a non-admin needs
//     `agents.files.read` AND may only target an agent in their EFFECTIVE
//     GRANTS (checkFilesReadAccess) — and then sees ALL of that agent's files
//     (MEMORY.md, USER.md, … included). Rationale: a user who can CHAT with an
//     agent can already ask it to print any of its own files (no Atrium
//     guardrail exists on that path), so a UI-only depth restriction was
//     security theater; the real boundary worth enforcing is "no reading files
//     of an agent you cannot talk to", which the grant check provides. Typical
//     use: a per-user dedicated agent whose owner verifies what the agent
//     memorized (report 2026-07-10).
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
// `instance_not_served`, the membership guard — red-team P2-3).
//
// These are PUBLIC actions invoked by the browser, so unlike the scheduled
// dispatch actions they THROW on failure (the caller renders the error); error
// messages carry a stable leading code (e.g. "conflict:", "bridge_error:").

import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
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

// A3v2 (grant-aligned read): there is NO per-file-name depth filter anymore.
// The former RULES_FILES allowlist (AGENTS/SOUL/IDENTITY/TOOLS .md, memory-class
// files admin-only) was dropped 2026-07-10: a user who can chat with an agent
// can already ask it to print MEMORY.md/USER.md — the depth restriction only
// frustrated the legitimate "did my agent memorize my instructions?" check
// without protecting anything. The ENFORCED boundary is checkFilesReadAccess:
// a non-admin reads files ONLY for agents in their effective grants (the same
// agents they can already talk to). Writes are untouched: admin-only.

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
export async function postBridge(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number = BRIDGE_TIMEOUT_MS,
  // The instance's OWN bridge URL when it has one (Model M); else the deployment
  // default. Lets per-instance admin ops reach the bridge that actually serves them.
  bridgeUrlOverride?: string | null,
): Promise<{ status: number; data: unknown }> {
  const bridgeUrl = bridgeUrlOverride?.trim() || process.env.BRIDGE_URL;
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

export function requireOkStatus(
  status: number,
  op: string,
  data?: unknown,
): void {
  if (status < 200 || status >= 300) {
    // Surface the bridge's OWN error code (e.g. GATEWAY_DISCONNECTED /
    // GATEWAY_TIMEOUT / instance_not_served) — a bare "Server Error" left the
    // admin guessing (live report 2026-07-06). ConvexError reaches the client.
    const err = (data as { error?: { code?: unknown } } | undefined)?.error;
    const code =
      typeof err === "object" && err !== null && typeof err.code === "string"
        ? err.code
        : typeof (data as { error?: unknown } | undefined)?.error === "string"
          ? String((data as { error: string }).error)
          : null;
    throw new ConvexError(
      `bridge_error: ${op} -> HTTP ${status}${code ? ` (${code})` : ""}`,
    );
  }
}

// ===========================================================================
// Internal gates (actions have no ctx.db — auth checks run in queries/mutations
// with the caller's identity propagated through ctx.runQuery/runMutation)
// ===========================================================================

/**
 * Read gate for the files surface — THE enforcement (A3v2): admin (REAL
 * identity, as everywhere) passes for any agent; otherwise `agents.files.read`
 * is required AND the (instanceName, agentId) target must be in the caller's
 * effective agent set (direct userAgents ∪ group shares, the SAME union the
 * picker/routing use), enforced here server-side (red-team P2-1: never trust
 * the UI's agent selector). Inside that scope the caller reads ALL files —
 * there is no per-name depth filter anymore (see the policy note above).
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

/** The per-instance bridge URL (instances.bridgeUrl) for an instance name, or null
 *  when unset/unknown — so the config-defaults actions POST to the SELECTED instance's
 *  OWN bridge (Model M: instances behind separate bridgeUrl) rather than the
 *  deployment-wide BRIDGE_URL (which would 409 instance_not_served). */
export const bridgeUrlForInstance = internalQuery({
  args: { instanceName: v.string() },
  handler: async (ctx, { instanceName }): Promise<string | null> => {
    // first() not unique(): `instances.name` is not schema-unique and other routing
    // paths stay resilient to a duplicate row by taking the first — a dup must not
    // throw here and break agent-files/chat-defaults for an otherwise-routable instance.
    const inst = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", instanceName))
      .first();
    return inst?.bridgeUrl?.trim() || null;
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
 * Derive a revision's after-state from the bridge's `/agent-files` set response.
 *
 * Shared because there are TWO writers of the same revision row — the editor save
 * here and the curation approval in agentFileCuration.ts — and the first version of
 * this contract was applied to one of them only, so an approved curation still filed a
 * revision claiming the proposed content had landed. A rule that must hold at every
 * call site does not belong at any of them.
 *
 * `verified` distinguishes three real situations that must not be conflated: the
 * bridge confirmed a re-read (use it), the bridge is older and sends no confirmation
 * at all, or the re-read carried no content — the upstream field is optional and a
 * still-missing file reads that way, which is exactly the case where the write may not
 * have landed. The last two store the requested content because nothing truer exists,
 * and the row SAYS the after-state is unverified.
 */
export function afterStateFromSetResponse(
  data: unknown,
  requested: string,
): {
  /** EXACTLY the revision-row fields, so a call site can spread this and nothing else
   *  — the landing evidence below is not a column, and spreading it into the mutation
   *  made the validator reject the write. */
  revision: { after: string; afterVerified: boolean; afterMissing: boolean };
} {
  const d = data as
    | { confirmed?: { content?: unknown }; file?: { missing?: unknown } }
    | null;
  const confirmed = d?.confirmed;
  // `typeof confirmed?.content === "string"` and nothing weaker. `confirmed !== undefined`
  // was true for an explicit `null`, and the very next expression dereferenced it — the
  // response body arrives as `unknown` from an HTTP call, so that TypeError landed AFTER
  // the curation had claimed the row and BEFORE it could release the claim, leaving the
  // proposal stuck in `applying`: neither retryable nor rejectable.
  const verified =
    typeof confirmed === "object" &&
    confirmed !== null &&
    typeof confirmed.content === "string";
  return {
    revision: {
      after: verified ? (confirmed!.content as string) : requested,
      afterVerified: verified,
      // The bridge's post-write re-read said the file IS STILL MISSING. That is not an
      // unverifiable read — it is a positive statement that the write did not land, and
      // the bridge knew it all along (`fileMeta(after).missing`) while this decision was
      // being made without it. It rides INTO the revision row, because an audit trail
      // that records the requested content and only "unverified" cannot distinguish
      // "we could not check" from "the gateway says it is not there".
      afterMissing: d?.file?.missing === true,
    },
  };
}

/**
 * Did the write LAND? Read against the after-state a set response yielded.
 *
 * A confirmed read-back that disagrees with what we asked for means the write did not
 * happen, whatever the acknowledgement said — and declaring success anyway costs the
 * proposal, because the curation's "applied" transition purges its content copies.
 *
 * Only a CONFIRMED disagreement counts. An unverifiable read-back is not evidence of
 * failure, and treating it as one would fail writes that did land against a gateway
 * that simply does not echo content.
 */
export function writeLanded(
  afterState: {
    revision: { after: string; afterVerified: boolean; afterMissing?: boolean };
  },
  requested: string,
): boolean {
  // A file the gateway still reports as MISSING after the write did not get written,
  // whatever else the response says — checked first, because this case also arrives
  // with no content to compare and would otherwise pass as "unverifiable".
  if (afterState.revision.afterMissing === true) return false;
  return !afterState.revision.afterVerified || afterState.revision.after === requested;
}

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
    afterVerified: v.optional(v.boolean()),
    afterMissing: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<null> => {
    const actor = await getActor(ctx);
    await ctx.db.insert("agentFileRevisions", {
      instanceName: args.instanceName,
      agentId: args.agentId,
      name: args.name,
      before: args.before,
      after: args.after,
      ...(args.afterVerified === undefined ? {} : { afterVerified: args.afterVerified }),
      ...(args.afterMissing === undefined ? {} : { afterMissing: args.afterMissing }),
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

/** List an agent's workspace files. Grant-aligned (A3v2): the access check is
 *  the sole gate — a non-admin only reaches agents in their effective grants,
 *  and then sees the FULL listing (MEMORY.md/USER.md included). */
export const listAgentFiles = action({
  args: { instanceName: v.string(), agentId: v.string() },
  handler: async (
    ctx,
    { instanceName, agentId },
  ): Promise<{ files: AgentFileInfo[] }> => {
    await ctx.runQuery(internal.agentFiles.checkFilesReadAccess, {
      instanceName,
      agentId,
    });
    const bridgeUrl = await ctx.runQuery(
      internal.agentFiles.bridgeUrlForInstance,
      { instanceName },
    );
    const { status, data } = await postBridge(
      "/agent-files",
      { op: "list", instanceName, agentId },
      undefined,
      bridgeUrl,
    );
    requireOkStatus(status, "agent-files list");
    return { files: parseFileList(data) };
  },
});

/** Read one workspace file — any file of a grant-accessible agent (A3v2). */
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
    await ctx.runQuery(internal.agentFiles.checkFilesReadAccess, {
      instanceName,
      agentId,
    });
    const bridgeUrl = await ctx.runQuery(
      internal.agentFiles.bridgeUrlForInstance,
      { instanceName },
    );
    const { status, data } = await postBridge(
      "/agent-files",
      { op: "get", instanceName, agentId, name },
      undefined,
      bridgeUrl,
    );
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
    const bridgeUrl = await ctx.runQuery(
      internal.agentFiles.bridgeUrlForInstance,
      { instanceName },
    );
    const { status, data } = await postBridge(
      "/agent-files",
      {
        op: "set",
        instanceName,
        agentId,
        name,
        content,
        baseUpdatedAtMs: baseUpdatedAtMs ?? null,
      },
      undefined,
      bridgeUrl,
    );
    if (status === 409) {
      // Stable, detectable CAS-conflict code (the editor re-gets + re-diffs).
      throw new Error("conflict: file changed since load");
    }
    requireOkStatus(status, "agent-files set");
    // The bridge echoes the pre-write content (`before.content`) so the revision
    // holds the FULL before/after pair (A4). Defensive: tolerate a missing echo.
    const before = (data as { before?: { content?: unknown } })?.before
      ?.content;
    // The after-state is the bridge's CONFIRMED re-read, not the body we sent.
    // Recording what we asked for made the revision a statement about our intent
    // dressed as a statement about the file: a gateway that acknowledged the write
    // without applying it left a revision asserting content that never existed.
    //
    // See afterStateFromSetResponse: the after-state is the gateway's re-read when it
    // confirmed one, and the row records WHICH of the two it holds.
    const afterState = afterStateFromSetResponse(data, content);
    await ctx.runMutation(internal.agentFiles.recordFileRevision, {
      instanceName,
      agentId,
      name,
      before: typeof before === "string" ? before : "",
      ...afterState.revision,
    });
    // The revision is recorded FIRST — it is the truth about the file either way — and
    // only then is the outcome reported. Both writers of that row hold the same
    // evidence, and for a while only the curation path acted on it: the editor filed a
    // faithful revision and still answered "saved", so the person saw a success toast
    // and then watched the old content reload.
    if (!writeLanded(afterState, content)) {
      throw new Error(
        "the gateway acknowledged the write but its read-back does not match — " +
          "the file was not saved",
      );
    }
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
    const { status, data } = await postBridge(
      "/compact",
      {
        chatId,
        openclawChatId: routing.openclawChatId,
        instanceName: routing.target.instanceName,
        agentId: routing.target.agentId,
        canonical: routing.target.canonical,
      },
      COMPACT_TIMEOUT_MS,
      // The dispatch routing already resolved this instance's bridge (Model M).
      routing.bridgeUrl,
    );
    requireOkStatus(status, "compact");
    await ctx.runMutation(internal.agentFiles.auditFromAction, {
      action: "chat.compact",
      resource: "chat",
      resourceId: chatId,
    });
    // The gateway REFUSES with a 200 (no transcript, one already running, an
    // unsupported harness). Reporting that as success told the user their session
    // had been compacted when nothing had changed — and the context-overflow card's
    // "Compact the session" button is exactly where that lie costs the most. The
    // bucketed class rides the message so the UI can name the cause.
    const body = data as
      | { compacted?: unknown; reasonClass?: unknown }
      | undefined;
    if (body?.compacted === false) {
      const cls =
        typeof body.reasonClass === "string" && body.reasonClass !== ""
          ? `:${body.reasonClass}`
          : "";
      throw new ConvexError(`compact_refused${cls}`);
    }
    // An older bridge answers `{ok:true}` with no `compacted` field. UNKNOWN is not
    // a refusal: inventing one would tell the user nothing happened when it may
    // well have.
    return null;
  },
});

/** Chat lookup for the KEY-AUTHED compaction-history path (no user identity —
 *  the /api/v1 route already gated on traces.read): the owner id feeds the same
 *  routing resolution the owner-scoped actions use. */
export const chatOwnerInternal = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const id = ctx.db.normalizeId("chats", chatId);
    if (id === null) return null;
    const chat = await ctx.db.get(id);
    if (chat === null) return null;
    return { chatId: id, userId: chat.userId };
  },
});

/**
 * LAZY compaction history for a chat's gateway session (Inc 3): resolve the
 * chat's routed target, POST the bridge `/compaction-history` (which shapes the
 * gateway's `sessions.compaction.list` CONTENT-FREE — reasons/timestamps/token
 * counts, never the checkpoint summaries), and return it. Called ON DEMAND by
 * the key-authed /api/v1 route (MCP debug) — never on the turn path.
 */
export const compactionHistoryInternal = internalAction({
  args: { chatId: v.string() },
  handler: async (
    ctx,
    { chatId },
  ): Promise<
    | { ok: true; count: number; checkpoints: unknown[] }
    // `code` disambiguates the HTTP mapping (codex P2: a gateway outage must
    // never read as "chat not found"): not_found -> 404, no_agent -> 409,
    // upstream (bridge/gateway failure) -> 502.
    | { ok: false; code: "not_found" | "no_agent" | "upstream"; error: string }
  > => {
    const chat = await ctx.runQuery(internal.agentFiles.chatOwnerInternal, {
      chatId,
    });
    if (chat === null) {
      return { ok: false, code: "not_found", error: "chat not found" };
    }
    const routing = await ctx.runQuery(internal.bridge.getChatRouting, {
      chatId: chat.chatId,
      userId: chat.userId,
    });
    if (!routing || routing.target === null) {
      return { ok: false, code: "no_agent", error: "no_agent" };
    }
    try {
      const { status, data } = await postBridge(
        "/compaction-history",
        {
          chatId: chat.chatId,
          openclawChatId: routing.openclawChatId,
          instanceName: routing.target.instanceName,
          agentId: routing.target.agentId,
          canonical: routing.target.canonical,
        },
        COMPACT_TIMEOUT_MS,
        routing.bridgeUrl,
      );
      if (status !== 200) {
        return {
          ok: false,
          code: "upstream",
          error: `bridge status ${status}`,
        };
      }
      const body = data as { count?: number; checkpoints?: unknown[] } | null;
      return {
        ok: true,
        count: typeof body?.count === "number" ? body.count : 0,
        checkpoints: Array.isArray(body?.checkpoints) ? body.checkpoints : [],
      };
    } catch (err) {
      // Unreachable bridge (fetch threw) = upstream too, never a 404.
      return {
        ok: false,
        code: "upstream",
        error: (err as Error)?.message ?? "bridge unreachable",
      };
    }
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
  // Sole instance (or none) -> use it (mono-instance: the bridge's only gateway).
  if (names.length <= 1) return names[0] ?? null;
  // MULTIPLE instances + no explicit choice: FAIL CLOSED. Silently targeting names[0]
  // could READ or (worse) WRITE the defaults of the WRONG gateway. The Defaults UI
  // passes an explicit instanceName when several instances are configured (its instance
  // picker), so this throw only guards a caller that forgot to.
  throw new Error(
    "multiple instances configured: specify instanceName for chat defaults",
  );
}

/** Admin-only read of the gateway's global chat defaults (CONF-4d, deflated A7). */
export const getChatDefaults = action({
  args: { instanceName: v.optional(v.string()) },
  handler: async (ctx, { instanceName }): Promise<unknown> => {
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    const claim = await resolveInstanceClaim(ctx, instanceName);
    const bridgeUrl = claim
      ? await ctx.runQuery(internal.agentFiles.bridgeUrlForInstance, {
          instanceName: claim,
        })
      : null;
    const { status, data } = await postBridge(
      "/config-defaults",
      { op: "get", ...(claim !== null ? { instanceName: claim } : {}) },
      undefined,
      bridgeUrl,
    );
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
    const bridgeUrl = claim
      ? await ctx.runQuery(internal.agentFiles.bridgeUrlForInstance, {
          instanceName: claim,
        })
      : null;
    const { status, data } = await postBridge(
      "/config-defaults",
      {
        op: "set",
        ...(thinkingDefault !== undefined ? { thinkingDefault } : {}),
        ...(fastModeDefault !== undefined ? { fastModeDefault } : {}),
        ...(claim !== null ? { instanceName: claim } : {}),
      },
      CONFIG_DEFAULTS_SET_TIMEOUT_MS,
      bridgeUrl,
    );
    requireOkStatus(status, "config-defaults set", data);
    await ctx.runMutation(internal.agentFiles.auditFromAction, {
      action: "admin.chat_defaults",
      resource: "config",
      resourceId: "chat_defaults",
    });
    return null;
  },
});

/** RESET the global chat defaults (thinkingDefault + fastModeDefault) — removes
 *  both keys from the gateway config (null-merge delete, bench-verified), so the
 *  gateway's own built-in behavior applies again. Admin-gated like the set. */
export const clearChatDefaults = action({
  args: { instanceName: v.optional(v.string()) },
  handler: async (ctx, { instanceName }): Promise<null> => {
    // Admin gate FIRST (same as setChatDefaults) — this mutates the gateway's
    // GLOBAL config (codex P1).
    await ctx.runQuery(internal.agentFiles.checkAdminAccess, {});
    const claim = await resolveInstanceClaim(ctx, instanceName);
    const bridgeUrl = claim
      ? await ctx.runQuery(internal.agentFiles.bridgeUrlForInstance, {
          instanceName: claim,
        })
      : null;
    const { status, data } = await postBridge(
      "/config-defaults",
      { op: "clear", ...(claim !== null ? { instanceName: claim } : {}) },
      CONFIG_DEFAULTS_SET_TIMEOUT_MS,
      bridgeUrl,
    );
    requireOkStatus(status, "config-defaults clear", data);
    await ctx.runMutation(internal.agentFiles.auditFromAction, {
      action: "admin.chat_defaults_reset",
      resource: "config",
      resourceId: "chat_defaults",
    });
    return null;
  },
});
