// Convex ingest endpoint for the bridge worker (server -> Convex).
//
// WHY THIS EXISTS: the streaming writes live in `internal.stream.*`
// (internalMutation), which the browser CANNOT call and which the public
// ConvexHttpClient cannot call either (admin auth is a private CLI-only path).
// The supported pattern is an authenticated httpAction that holds a secret and
// runs the internal mutations via `ctx.runMutation`. The bridge POSTs one JSON
// `op` per normalized event to `POST /bridge/ingest`.
//
// SECURITY (load-bearing):
//   - `Authorization: Bearer <per-bridge secret>` — resolved by SHA-256 hash to
//     exactly ONE instance (bridgeAuth.by_hash): the writing bridge's identity
//     is PROVEN, never self-asserted, and every write below is authorized
//     against it (cross-gateway targets → 403). PER-BRIDGE ONLY: there is no
//     shared-secret fallback and no mode — isolation is not configurable.
//   - The boundary check is the fast 403; the AIRTIGHT enforcement is atomic
//     inside each write mutation (chatAllowsInstance re-checked in the same
//     transaction as the write — no authorize→write TOCTOU).
//   - The route is registered in http.ts. Served at the deployment's `.site`
//     origin (NOT the `.cloud` query origin).
//
// NOTE: this file (and the http.ts route) is NOT exercised by the bridge's
// offline tsc/vitest gate (bridge/tsconfig only includes bridge/src + test). It
// is validated by `npx convex dev` / a live deployment.

import { httpAction, ActionCtx, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { hashKey } from "./lib/apikeys";
import { chatAllowsInstance } from "./lib/ingestAuthz";
import {
  rehydrateTraceMeta,
  shouldReportRehydrateMissed,
} from "./lib/rehydrateTrace";

/**
 * Stored-object metadata for an outbound media blob — size + content-type, read
 * from the `_storage` system table (NEVER the deprecated ctx.storage.getMetadata).
 * Non-PII (no content, no path, no filename). Lets the `addMediaPart` ingest
 * trace record whether the bytes actually landed: `bytes > 0` means a download
 * failure is the storage URL ORIGIN (self-hosted serving config), not a missing
 * object; `null`/`bytes: 0` means the stream never reached storage.
 */
export const storageMeta = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const meta = await ctx.db.system.get("_storage", storageId);
    if (!meta) return null;
    return { bytes: meta.size, contentType: meta.contentType ?? null };
  },
});

/**
 * INGEST AUTHORIZATION (the cross-gateway write barrier). Given the instance a
 * per-bridge-authenticated ingest call PROVED it is (boundInstanceName) and the
 * op's target ids, resolve the target's OWNING instance and decide:
 *   - "allow"  : the target belongs to the calling instance (or has no instance
 *                yet — a null-instance/legacy chat can't be another gateway's data).
 *   - "deny"   : the target EXISTS and belongs to a DIFFERENT instance — the
 *                cross-gateway write this whole design forbids.
 *   - "absent" : the target row (or its chat) does not exist — allow; the op's
 *                mutation handles non-existence, and there is nothing to corrupt.
 * A messageId resolves through its chat; an interactionId through its chat. This
 * is the SINGLE place ingest authorization is decided (one gate to audit).
 */
export const authorizeIngestTarget = internalQuery({
  args: {
    boundInstanceName: v.string(),
    chatId: v.optional(v.string()),
    interactionId: v.optional(v.string()),
    // Sub-agent ops (upsertSubAgent / upsertSubAgentToolPart) resolve their row
    // GLOBALLY by this key — authorization must ALSO follow the EXISTING row's
    // chat, not just the self-asserted chatId. The mutation re-checks atomically
    // (TOCTOU), but the boundary rejects the obvious cross-instance case fast.
    childSessionKey: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { boundInstanceName, chatId, interactionId, childSessionKey },
  ): Promise<{ decision: "allow" | "deny" | "absent" }> => {
    // Resolve EVERY chat this op touches: the provided chatId, the
    // interaction's chat, AND (for a sub-agent key) the existing row's chat.
    // The op is authorized only if the bound instance may write to ALL of them
    // — so B cannot pass its own chat alongside A's key.
    const chatsToCheck: Id<"chats">[] = [];
    if (chatId !== undefined) {
      const cid = ctx.db.normalizeId("chats", chatId);
      if (cid === null) return { decision: "absent" };
      chatsToCheck.push(cid);
    }
    if (interactionId !== undefined) {
      const iid = ctx.db.normalizeId("subAgentInteractions", interactionId);
      if (iid === null) return { decision: "absent" };
      const interaction = await ctx.db.get(iid);
      if (interaction === null) return { decision: "absent" };
      chatsToCheck.push(interaction.chatId);
    }
    if (childSessionKey !== undefined) {
      const existing = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", childSessionKey))
        .first();
      if (existing !== null) chatsToCheck.push(existing.chatId);
    }
    if (chatsToCheck.length === 0) {
      // No target id (instance-level op like calibrate/getUploadUrl): authorized
      // by possession of a valid per-bridge secret alone.
      return { decision: "allow" };
    }
    for (const cid of chatsToCheck) {
      if (!(await chatAllowsInstance(ctx, cid, boundInstanceName))) {
        return { decision: "deny" };
      }
    }
    return { decision: "allow" };
  },
});

/**
 * Emit an inbound ingest trace via the `recordEvent` internalMutation (an
 * httpAction has no `ctx.db`, so it must go through `ctx.runMutation`). D2:
 * metadata only — NEVER message text, attachment contents, or media paths.
 * Wrapped so a trace failure can NEVER turn a successful ingest into a 500.
 *
 * correlationId: `chatId:runId` when both are available (startAssistant);
 * otherwise the `messageId` (the message-only ops carry no chat/run id without
 * a DB lookup, which we deliberately avoid per trace).
 */
async function traceIngest(
  ctx: ActionCtx,
  args: {
    kind: string;
    status?: number;
    correlationId?: string;
    chatId?: string;
    runId?: string;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: args.kind,
      direction: "inbound",
      principalType: "system",
      principalId: "bridge",
      status: args.status,
      chatId: args.chatId,
      runId: args.runId,
      correlationId: args.correlationId,
      meta: JSON.stringify(args.meta),
    });
  } catch {
    // Best-effort: never break the ingest flow on a trace error.
  }
}

// NOTE: this file exports the ingest httpAction plus the `storageMeta`
// internalQuery (above). httpActions run in the DEFAULT Convex runtime (fetch +
// ctx.storage are available; Node built-ins are NOT).

// Mirror of bridge/src/convex-writer.ts IngestOp (kept in sync by hand; the
// bridge owns the canonical shape).
type IngestOp =
  | {
      op: "startAssistant";
      chatId: string;
      runId: string | null;
      sessionKey?: string | null;
    }
  // Delivery recorder clock calibration: lightweight (no writes) so its round-trip is
  // free of server work and yields a clean bridge<->Convex skew. See deliveryTiming.ts.
  | { op: "calibrate" }
  | { op: "sweepStreams" }
  // `rec*` fields are present only while a turn is being recorded (bridge tags the
  // flush): recSessionId is the turn's recording session (Convex records only if it
  // still matches the active one), bridgeSentAt (t1) + bridgeSkew feed segment A,
  // sizeBytes is the flush size (UTF-8). See convex/deliveryTiming.ts.
  | {
      op: "appendDelta";
      messageId: string;
      text: string;
      runId?: string | null;
      recSessionId?: string;
      bridgeRecvAt?: number;
      bridgeSentAt?: number;
      bridgeSkew?: number;
      sizeBytes?: number;
    }
  | {
      op: "setSnapshot";
      messageId: string;
      text: string;
      runId?: string | null;
      recSessionId?: string;
      bridgeRecvAt?: number;
      bridgeSentAt?: number;
      bridgeSkew?: number;
      sizeBytes?: number;
    }
  | {
      op: "addPart";
      messageId: string;
      part: Record<string, unknown>;
      runId?: string | null;
    }
  | {
      op: "advancePlan";
      messageId: string;
      count: number;
      settleIfIdle: boolean;
      runId?: string | null;
    }
  | {
      op: "settleAnnouncedChild";
      chatId: string;
      childSessionKey: string;
    }
  // Outbound media (base64-free, no size ceiling): the bridge asks for an upload
  // URL, STREAMS the raw bytes straight to it (a direct binary POST, NOT through
  // this endpoint — the 20MB httpAction limit never applies), then persists the
  // returned storageId. The server-side fs path is NEVER sent to Convex.
  | { op: "getUploadUrl" }
  | {
      op: "addMediaPart";
      messageId: string;
      storageId: string;
      filename: string;
      mimeType: string;
      runId?: string | null;
    }
  // SOC2-safe outbound-media DIAGNOSTIC (recorded as an `openclaw.media` trace; no
  // message part, no DB write). Structural codes only — never filename/path/bytes.
  | {
      op: "mediaTrace";
      messageId: string;
      chatId?: string;
      phase: "received" | "stored" | "dropped";
      reason?: string;
      bytesBucket?: string;
      mimeBase?: string;
      fetchMs?: number;
      uploadMs?: number;
    }
  // Content-free re-hydration DECISION trace (no DB write, no message part): records
  // WHY a dispatch did/didn't re-inject history as an `openclaw.rehydrate` trace keyed
  // `chatId:outboxId`. Enums/scalars only — never prompt/history text.
  | {
      op: "rehydrateTrace";
      chatId: string;
      outboxId: string | null;
      decision: string;
      freshSession: boolean;
      routedSwitch: boolean;
      prependedTurns: number;
      routedAgentId: string;
      routedInstanceName: string | null;
      switchedFromAgentId: string | null;
      switchedFromInstanceName: string | null;
    }
  // Content-free per-turn GATEWAY CONTEXT-PRESSURE trace (chat.gateway_pressure):
  // the pre-turn token counters (from the bridge's per-turn sessions.describe —
  // zero extra gateway calls) + whether the gateway COMPACTED this turn (phase
  // "preflight"/"midturn", null = no compaction). Counters + enums only.
  | {
      op: "gatewayPressure";
      chatId: string;
      messageId: string;
      totalTokens: number | null;
      contextTokens: number | null;
      costUsd?: number | null;
      toolCalls?: number;
      compaction: string | null;
      errorKind?: string | null;
      stopReason?: string | null;
      finalizeCause?: string | null;
      postTotalTokens?: number | null;
      postInputTokens?: number | null;
      postOutputTokens?: number | null;
      postCostUsd?: number | null;
    }
  | {
      op: "setPhase";
      messageId: string;
      phase: string;
      runId?: string | null;
    }
  | {
      op: "finalize";
      messageId: string;
      status: "complete" | "error" | "aborted";
      text: string;
      error: string | null;
      errorKind?: string | null;
      runId?: string | null;
      /** TRUE = the streamed text is protocol NOISE (a NO_REPLY sentinel that
       *  reached the live row): the finalize must NOT fall back to it. Carried
       *  ON the finalize so the discard is atomic with it — a separate purge
       *  write could fail and resurrect the sentinel (codex P2). */
      discardStreamText?: boolean;
      /** TRUE = the gateway killed this REAL zero-content turn to run a
       *  delivery (announce×queue race, inverse direction — never a user
       *  Stop): stream.finalize re-parks the outbox row for one automatic
       *  re-dispatch (preemptRepark.ts). */
      gatewayPreempted?: boolean;
    }
  // Session meta mirrored from the gateway's `sessions.describe` (model,
  // reasoning level + enum, verbosity, context-usage counts) so the chat header
  // can render the model/reasoning chips + context meter. Non-secret knob labels
  // only. The bridge posts this when it learns a turn's session meta.
  | {
      op: "bindProviderChat";
      chatId: string;
      providerChatId: string;
      // The reset epoch the turn started under (see bindProviderChat).
      resetCount?: number;
    }
  | {
      op: "clearProviderChat";
      chatId: string;
    }
  | {
      op: "updateRunId";
      messageId: string;
      runId: string;
    }
  | {
      op: "heartbeat";
      messageId: string;
    }
  | {
      op: "setSessionMeta" | "setSessionActiveTokens";
      activeTokens?: number;
      observedAt?: number;
      chatId: string;
      meta: {
        model?: string;
        modelProvider?: string;
        agentRuntime?: string;
        thinkingLevel?: string;
        thinkingDefault?: string;
        thinkingLevels?: { id: string; label: string }[];
        availableModels?: { id: string; label: string }[];
        verboseLevel?: string;
        totalTokens?: number;
        contextTokens?: number;
        estimatedCostUsd?: number;
      };
    }
  // Session re-hydration READ (see docs/SESSION_CONTINUITY_DESIGN.md). The bridge
  // asks for a bounded block of this chat's prior turns when it detects a fresh/
  // rolled OpenClaw session, then prepends it to chat.send. `excludeMessageId` is
  // the current turn's user message (so it is not duplicated into the context).
  | {
      op: "getRehydrationContext";
      chatId: string;
      excludeMessageId?: string | null;
    }
  // Sub-agent observation upsert (inbound only): the bridge observed a child run
  // (spawn / lifecycle phase / final result) on the gateway and records its status
  // here, keyed by childSessionKey. NOT message-scoped (a child outlives the parent
  // turn) — recorded independent of any message stream. resultText is the child's
  // own answer with server-paths already stripped by the bridge.
  | {
      op: "upsertSubAgent";
      chatId: string;
      // The writer's own served instance (one writer per bundle): persisted on
      // the row so the task reconcile probes the registry the work runs on.
      instanceName?: string;
      parentMessageId?: string | null;
      anchorExact?: boolean;
      childSessionKey: string;
      kind?: "subagent" | "task";
      bornOfRun?: string;
      taskName?: string;
      status: "running" | "done" | "error" | "aborted";
      resultText?: string;
      phase?: string;
      errorMessage?: string;
      tools?: Array<{ name: string; status: "running" | "done"; toolCallId?: string }>;
      // STATIC session config (model / reasoning / speed / scope / spawn config) for
      // the panel bar + Advanced. All optional (rendered only when present).
      sessionMeta?: {
        model?: string;
        modelProvider?: string;
        thinkingLevel?: string;
        fastMode?: boolean;
        controlScope?: string;
        subagentRole?: string;
        spawnDepth?: number;
        context?: string;
        runtime?: string;
        mode?: string;
        cleanup?: string;
        sandbox?: string;
        gatewayKind?: string;
        label?: string;
        cwd?: string;
        agentId?: string;
        lightContext?: boolean;
        sessionId?: string;
        spawnedWorkspaceDir?: string;
      };
      // Last-known run telemetry (runtime/tokens/cost) — attached by the bridge only
      // to already-scheduled upserts (heartbeat/terminal). Content-free numbers.
      telemetry?: {
        runtimeMs?: number;
        totalTokens?: number;
        estimatedCostUsd?: number;
        startedAt?: number;
      };
    }
  // Per-tool DETAIL (args + result) for a sub-agent's call, keyed by
  // (childSessionKey, toolCallId). In its OWN table (NOT subAgents.tools[]) to avoid
  // re-pushing the whole array per write. In-app user data; server-paths stripped by
  // the bridge. The observability surfaces (MCP/KPI/traces) never read this.
  | {
      op: "upsertSubAgentToolPart";
      chatId: string;
      childSessionKey: string;
      toolCallId: string;
      name: string;
      status: "running" | "done" | "error";
      argsText?: string;
      resultText?: string;
    }
  // Phase 2c: a sub-agent's reply to a user interaction -> the interaction record.
  | {
      op: "recordSubAgentInteractionReply";
      interactionId: string;
      status: "done" | "error";
      replyText?: string;
      errorMessage?: string;
    };

/** The target id(s) an op writes against — what ingest authorization resolves to
 *  an owning instance. Pure (no ctx); mirrors the switch's per-op id fields. An op
 *  with no target (calibrate/getUploadUrl/heartbeat-less-ops) returns {} → allowed
 *  by valid auth alone. `mediaTrace`/`recordSubAgentInteractionReply` etc. are
 *  covered by their chatId/messageId/interactionId. */
function ingestTargetIds(op: IngestOp): {
  chatId?: string;
  interactionId?: string;
  childSessionKey?: string;
} {
  const b = op as Record<string, unknown>;
  // MESSAGE-scoped ops (appendDelta/setSnapshot/setPhase/heartbeat/finalize/
  // addPart/addMediaPart/advancePlan/updateRunId) are deliberately NOT checked
  // at the boundary: their write mutations enforce the barrier ATOMICALLY
  // against the streamingText row's boundInstance stamp (zero extra reads) or
  // the message's chat — a boundary re-check would re-run the per-turn grants
  // resolution ON EVERY DELTA FLUSH (codex P1: per-token getEffectiveGrants).
  // Their cross-instance 403 comes from the mutation throw (the catch below).
  // mediaTrace with only a messageId writes a content-free trace (no data) —
  // covered when it carries a chatId.
  const chatId = typeof b.chatId === "string" ? b.chatId : undefined;
  const interactionId =
    typeof b.interactionId === "string" ? b.interactionId : undefined;
  // Sub-agent ops resolve their row GLOBALLY by childSessionKey; carry it so
  // authorization follows the existing row's chat, not the self-asserted chatId
  // (the mutation re-checks atomically as well — this is the fast 403).
  const childSessionKey =
    (op.op === "upsertSubAgent" || op.op === "upsertSubAgentToolPart") &&
    typeof b.childSessionKey === "string"
      ? b.childSessionKey
      : undefined;
  const base =
    chatId !== undefined
      ? { chatId }
      : interactionId !== undefined
        ? { interactionId }
        : {};
  return childSessionKey !== undefined ? { ...base, childSessionKey } : base;
}

export const ingest = httpAction(async (ctx, request) => {
  // Earliest server timestamp (≈ request receipt), captured BEFORE auth/parse so the
  // delivery recorder's `calibrate` op can return a clean clock reference near the
  // round-trip midpoint — not biased by any later server work. See convex/deliveryTiming.ts.
  const receivedAt = Date.now();
  // AUTH (bridge -> Convex): PER-BRIDGE ONLY. The Bearer token must be a
  // per-bridge secret that resolves (by hash) to exactly ONE instance — the
  // proven identity every write below is authorized against. There is NO shared
  // fallback and NO mode: cross-gateway isolation is not configurable (the
  // legacy BRIDGE_INGEST_SECRET path was removed in the narrow phase; a bridge
  // still presenting it gets 401 and must be updated + given its per-bridge
  // secret, minted in Settings → Instances).
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  let boundInstanceName: string | null = null;
  if (token) {
    // hash -> the ONE instance this secret authenticates. No timing oracle
    // worth the surface (238-bit secret; the hash lookup is the compare).
    const resolved = await ctx.runQuery(
      internal.bridgeAuth.resolveBridgeInstanceBySecretHash,
      { hash: await hashKey(token) },
    );
    if (resolved !== null) {
      boundInstanceName = resolved.instanceName;
      // NOTE: NO per-op lastUsed write here. Ingest is high-frequency (dozens of
      // ops/turn, many concurrent streams per bridge) — patching one bridgeAuth
      // doc per op would add write amplification and an OCC-contended hot doc,
      // and (worse) a failed patch would abort the ingest before its real write
      // (codex P2). The `/bridge/credentials` fetch already heartbeats lastUsed
      // periodically; that is the bridge-liveness signal.
    }
  }

  if (boundInstanceName === null) {
    await traceIngest(ctx, {
      kind: "openclaw.ingest.denied",
      status: 401,
      meta: { reason: token ? "unknown_secret" : "no_token" },
    });
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: IngestOp;
  try {
    body = (await request.json()) as IngestOp;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // BOUNDARY AUTHORIZATION (fast 403, clear error). Every op's target must
  // belong to the proven instance. This runs in its OWN transaction, so it is
  // the FAST-PATH rejection only — the airtight enforcement is ATOMIC inside
  // each write mutation (they re-check chatAllowsInstance in the SAME
  // transaction as the write, closing the authorize→write TOCTOU when a
  // concurrent rebind moves the chat between the two).
  {
    const target = ingestTargetIds(body);
    const authz = await ctx.runQuery(
      internal.bridge_ingest.authorizeIngestTarget,
      { boundInstanceName, ...target },
    );
    if (authz.decision === "deny") {
      return await forbiddenResponse(ctx, body.op, boundInstanceName, false);
    }
  }

  try {
  switch (body.op) {
    case "sweepStreams": {
      // BOOT-TIME orphan sweep: the calling bridge just (re)started, so no run
      // of ITS instance is in flight — close every stale live row bound to it
      // (see stuckStreams.sweepInstanceStreams). Scoped to the PROVEN identity;
      // no self-asserted target, so no boundary check beyond auth.
      const res = await ctx.runMutation(
        internal.stuckStreams.sweepInstanceStreams,
        { instanceName: boundInstanceName },
      );
      return json({ ok: true, swept: res.swept });
    }
    case "calibrate":
      // Lightweight clock reference for the delivery recorder (NO writes): serverNow is
      // the entry timestamp, so the bridge's measured round-trip excludes server work
      // and yields a clean bridge<->Convex skew. See convex/deliveryTiming.ts.
      return json({ serverNow: receivedAt });
    case "startAssistant": {
      const correlationId = body.runId
        ? `${body.chatId}:${body.runId}`
        : `${body.chatId}`;
      const messageId = await ctx.runMutation(internal.stream.startAssistant, {
        chatId: body.chatId as Id<"chats">,
        runId: body.runId ?? undefined,
        turnSessionKey: body.sessionKey ?? undefined,
        boundInstanceName,
      });
      // Delivery recorder: a ONCE-per-turn probe (not per delta) telling the bridge
      // whether this turn is recorded + under which session. When OFF the bridge sends
      // no recSessionId, so the delta hot path skips activeRecording. (The clock skew
      // comes from the separate lightweight `calibrate` op, not from this heavy call.)
      const rec = await ctx.runQuery(
        internal.deliveryTiming.getActiveRecordingForBridge,
        {},
      );
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        chatId: body.chatId,
        runId: body.runId ?? undefined,
        correlationId,
        meta: { op: body.op, messageId, ok: true },
      });
      return json({ messageId, rec });
    }
    // The per-delta stream ops (appendDelta/setSnapshot) are the HIGH-FREQUENCY hot
    // path: a single turn emits dozens of them. We deliberately do NOT write a
    // traceEvents row per delta -- that write amplification bloats the traceEvents
    // table, contends (OCC) with the detectAnomalies/kpi scans of the same `by_at`
    // range, and adds a synchronous write to every delta's ack on a backend that may
    // be resource-constrained. The turn lifecycle stays observable via startAssistant
    // + finalize (which records status + final textLen) + dispatch/error traces;
    // per-delta progress is intentionally not traced.
    case "appendDelta": {
      await ctx.runMutation(internal.stream.appendDelta, {
        messageId: body.messageId as Id<"messages">,
        text: body.text,
        boundInstanceName,
        ...(body.runId !== undefined ? { expectedRunId: body.runId } : {}),
        recSessionId: body.recSessionId,
        bridgeRecvAt: body.bridgeRecvAt,
        bridgeSentAt: body.bridgeSentAt,
        bridgeSkew: body.bridgeSkew,
        sizeBytes: body.sizeBytes,
      });
      return json({ ok: true });
    }
    case "setSnapshot": {
      await ctx.runMutation(internal.stream.setSnapshot, {
        messageId: body.messageId as Id<"messages">,
        text: body.text,
        boundInstanceName,
        ...(body.runId !== undefined ? { expectedRunId: body.runId } : {}),
        recSessionId: body.recSessionId,
        bridgeRecvAt: body.bridgeRecvAt,
        bridgeSentAt: body.bridgeSentAt,
        bridgeSkew: body.bridgeSkew,
        sizeBytes: body.sizeBytes,
      });
      return json({ ok: true });
    }
    case "addPart": {
      await ctx.runMutation(internal.stream.addPart, {
        messageId: body.messageId as Id<"messages">,
        // The bridge only sends tool/reasoning parts through `addPart`; media
        // goes through `addMedia` (needs a storage round-trip).
        part: body.part as never,
        boundInstanceName,
        ...(body.runId !== undefined ? { expectedRunId: body.runId } : {}),
      });
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        correlationId: body.messageId,
        meta: {
          op: body.op,
          messageId: body.messageId,
          // `part.kind` is a structural label (tool/reasoning) — non-PHI.
          partKind:
            typeof body.part.kind === "string" ? body.part.kind : undefined,
          ok: true,
        },
      });
      return json({ ok: true });
    }
    case "settleAnnouncedChild": {
      // A silent (NO_REPLY) sub-agent announce still proves the child ended —
      // flip its stuck `running` row without waiting for the reaper.
      await ctx.runMutation(internal.subAgents.settleAnnouncedChild, {
        chatId: body.chatId as Id<"chats">,
        childSessionKey: body.childSessionKey,
        boundInstanceName,
      });
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        meta: { op: body.op, ok: true },
      });
      return json({ ok: true });
    }
    case "advancePlan": {
      // Item-derived update_plan on a DELIVERY run (announce / task delivery):
      // those runs carry no tool frames, so only "the plan moved N times"
      // reaches the wire — stream.advancePlanPart advances the message's last
      // known plan part accordingly (estimated), or settles it when the turn
      // left the pipeline idle.
      await ctx.runMutation(internal.stream.advancePlanPart, {
        messageId: body.messageId as Id<"messages">,
        count: Number(body.count ?? 0),
        settleIfIdle: body.settleIfIdle === true,
        boundInstanceName,
        ...(body.runId !== undefined ? { expectedRunId: body.runId } : {}),
      });
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        correlationId: body.messageId,
        meta: { op: body.op, messageId: body.messageId, ok: true },
      });
      return json({ ok: true });
    }
    case "getUploadUrl": {
      // A short-lived URL the bridge POSTs raw file bytes to (no size limit,
      // no base64). Returned to the bridge, never persisted.
      const uploadUrl = await ctx.storage.generateUploadUrl();
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        meta: { op: body.op, ok: true },
      });
      return json({ uploadUrl });
    }
    case "addMediaPart": {
      // The bytes are already in storage (streamed straight to the upload URL);
      // persist the storageId as a media part. mimeType is a content-type label
      // (non-PHI); filename/content are NOT logged.
      const mimeType = body.mimeType || "application/octet-stream";
      await ctx.runMutation(internal.stream.addPart, {
        messageId: body.messageId as Id<"messages">,
        part: {
          kind: "media",
          storageId: body.storageId as Id<"_storage">,
          filename: body.filename,
          mimeType,
        },
        boundInstanceName,
        ...(body.runId !== undefined ? { expectedRunId: body.runId } : {}),
      });
      // Read the stored object's size/type for the trace (best-effort, non-PII):
      // distinguishes "bytes landed -> a failed download is the storage URL
      // origin" from "nothing stored -> the stream never reached storage".
      let bytes: number | null = null;
      let storedType: string | null = null;
      try {
        const meta = await ctx.runQuery(internal.bridge_ingest.storageMeta, {
          storageId: body.storageId as Id<"_storage">,
        });
        bytes = meta?.bytes ?? null;
        storedType = meta?.contentType ?? null;
      } catch {
        // Never let a metadata read turn a successful ingest into a 500.
      }
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        correlationId: body.messageId,
        meta: {
          op: body.op,
          messageId: body.messageId,
          partKind: "media",
          mimeType,
          bytes,
          storedType,
          ok: true,
        },
      });
      return json({ ok: true });
    }
    case "mediaTrace": {
      // SOC2-safe outbound-media diagnostic: record as an `openclaw.media` trace,
      // create NO message part and touch NO table. Structural codes/buckets only
      // (phase/reason/bytesBucket/mimeBase) — the bridge already guarantees no
      // filename/path/content reaches here. `received` with no later `stored` for
      // a turn = the file was surfaced but never persisted (fetcher/mount); NO
      // `received` at all = the gateway never surfaced it (normalizer/frame gap).
      await traceIngest(ctx, {
        kind: "openclaw.media",
        // chatId makes the trace findable alongside the turn's other traces
        // (list_traces q=chatId); correlationId chatId:messageId matches the
        // assistant.stream / gateway_pressure of the same message.
        ...(body.chatId ? { chatId: body.chatId } : {}),
        correlationId: body.chatId
          ? `${body.chatId}:${body.messageId}`
          : body.messageId,
        meta: {
          op: body.op,
          messageId: body.messageId,
          phase: body.phase,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.bytesBucket !== undefined
            ? { bytesBucket: body.bytesBucket }
            : {}),
          ...(body.mimeBase !== undefined ? { mimeBase: body.mimeBase } : {}),
          // Delivery durations (phase "stored"): the media-latency breakdown.
          ...(typeof body.fetchMs === "number" ? { fetchMs: body.fetchMs } : {}),
          ...(typeof body.uploadMs === "number"
            ? { uploadMs: body.uploadMs }
            : {}),
        },
      });
      return json({ ok: true });
    }
    case "rehydrateTrace": {
      // Content-free reconstruction record of the bridge's re-hydration decision for
      // a dispatch. correlationId = `chatId:outboxId` (the master join key — matches
      // chat.send + openclaw.dispatch, NOT chatId:runId) so the obs MCP can show WHY a
      // (cross-agent) turn re-injected history or not, with NO local repro. Enums +
      // scalars + routed agent NAMES only — never prompt/history text.
      const rehydrateCorrelationId = body.outboxId
        ? `${body.chatId}:${body.outboxId}`
        : body.chatId;
      await traceIngest(ctx, {
        kind: "openclaw.rehydrate",
        chatId: body.chatId,
        correlationId: rehydrateCorrelationId,
        meta: rehydrateTraceMeta(body),
      });
      // EXCEPTION anomaly: a per-turn ROUTED switch whose session was FRESH but that
      // still did NOT re-inject history — i.e. the switched agent got no context (the
      // bug this whole fix closes). After the fix this should not fire on a normal
      // switch; it remains as a regression/gap detector (e.g. an attachment turn on a
      // switch, where history can't be prepended). Content-free evidence only.
      if (shouldReportRehydrateMissed(body)) {
        await ctx.runMutation(internal.anomalies.reportAnomalyInternal, {
          kind: "routing.rehydrate_missed",
          severity: "warn",
          message: `A routed agent switch did not re-inject conversation history (decision=${body.decision}); the new agent may lack context.`,
          correlationId: rehydrateCorrelationId,
          evidence: JSON.stringify({
            chatId: body.chatId,
            routedAgentId: body.routedAgentId,
            routedInstanceName: body.routedInstanceName,
            switchedFromAgentId: body.switchedFromAgentId,
            switchedFromInstanceName: body.switchedFromInstanceName,
            decision: body.decision,
            freshSession: body.freshSession,
          }),
        });
      }
      return json({ ok: true });
    }
    case "gatewayPressure": {
      // One content-free record per turn: how full the gateway session was
      // BEFORE the turn (counters from the per-turn describe) + whether the
      // gateway compacted during it. correlationId = `chatId:messageId` so the
      // obs MCP can line pressure up with the turn's other traces. The fill
      // percentage is derived here (single place) for direct MCP readability.
      const fillPct =
        typeof body.totalTokens === "number" &&
        typeof body.contextTokens === "number" &&
        body.contextTokens > 0
          ? Math.round((body.totalTokens / body.contextTokens) * 100)
          : null;
      await traceIngest(ctx, {
        kind: "chat.gateway_pressure",
        chatId: body.chatId,
        correlationId: `${body.chatId}:${body.messageId}`,
        meta: {
          totalTokens: body.totalTokens,
          contextTokens: body.contextTokens,
          fillPct,
          // Session-cumulative cost BEFORE the turn (per-turn cost = the delta
          // between consecutive gateway_pressure traces of the chat).
          ...(typeof body.costUsd === "number" ? { costUsd: body.costUsd } : {}),
          // Tool calls this turn: the mid-turn growth driver (a hard overflow at
          // a low pre-turn fill reads causally: many tool results accumulated).
          ...(typeof body.toolCalls === "number" ? { toolCalls: body.toolCalls } : {}),
          compaction: body.compaction,
          // Hard, UN-recovered overflow (gateway errorKind "context_length") —
          // the counterpart of `compaction` (= handled silently). Distinguishes
          // "the gateway coped" from "the turn FAILED on context".
          ...(body.errorKind ? { errorKind: body.errorKind } : {}),
          // Terminal stopReason (diagnosis only — protocol-matrix gap closed).
          ...(typeof body.stopReason === "string" && body.stopReason
            ? { stopReason: body.stopReason }
            : {}),
          // WHY the turn closed — the label that tells an auto-close on a silence
          // deadline (recv_timeout / lifecycle_end_timeout / empty_final_timeout)
          // apart from a real gateway terminal (gateway_final / gateway_terminal).
          ...(typeof body.finalizeCause === "string" && body.finalizeCause
            ? { finalizeCause: body.finalizeCause }
            : {}),
          // REAL post-turn usage when the gateway stamps session metadata on
          // agent events (vs the PRE-turn counters above): per-turn tokens/cost
          // read directly instead of by delta.
          ...(typeof body.postTotalTokens === "number"
            ? { postTotalTokens: body.postTotalTokens }
            : {}),
          ...(typeof body.postInputTokens === "number"
            ? { postInputTokens: body.postInputTokens }
            : {}),
          ...(typeof body.postOutputTokens === "number"
            ? { postOutputTokens: body.postOutputTokens }
            : {}),
          ...(typeof body.postCostUsd === "number"
            ? { postCostUsd: body.postCostUsd }
            : {}),
        },
      });
      return json({ ok: true });
    }
    case "setPhase": {
      await ctx.runMutation(internal.stream.setPhase, {
        messageId: body.messageId as Id<"messages">,
        phase: body.phase,
        boundInstanceName,
        ...(body.runId !== undefined ? { expectedRunId: body.runId } : {}),
      });
      return json({ ok: true });
    }
    case "finalize": {
      await ctx.runMutation(internal.stream.finalize, {
        messageId: body.messageId as Id<"messages">,
        status: body.status,
        text: body.text,
        error: body.error ?? undefined,
        errorKind: body.errorKind ?? undefined,
        boundInstanceName,
        ...(body.runId !== undefined ? { expectedRunId: body.runId } : {}),
        ...(body.discardStreamText === true ? { discardStreamText: true } : {}),
        ...(body.gatewayPreempted === true ? { gatewayPreempted: true } : {}),
      });
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        correlationId: body.messageId,
        meta: {
          op: body.op,
          messageId: body.messageId,
          // String lifecycle status lives in meta (the `status` column is numeric).
          finalizeStatus: body.status,
          ...(body.gatewayPreempted === true ? { gatewayPreempted: true } : {}),
          textLen: body.text.length,
          // Whether an error was surfaced (boolean only — never the error text).
          hasError: body.error != null,
          // Stable failure class (refusal|timeout|rate_limit|context_length) —
          // non-PHI by construction (schema enum), safe in the trace.
          ...(body.errorKind ? { errorKind: body.errorKind } : {}),
          ok: true,
        },
      });
      return json({ ok: true });
    }
    case "bindProviderChat": {
      await ctx.runMutation(internal.bridge.bindProviderChat, {
        chatId: body.chatId as Id<"chats">,
        providerChatId: body.providerChatId,
        boundInstanceName,
        ...(typeof body.resetCount === "number"
          ? { resetCount: body.resetCount }
          : {}),
      });
      return json({ ok: true });
    }
    case "clearProviderChat": {
      await ctx.runMutation(internal.bridge.clearProviderChat, {
        chatId: body.chatId as Id<"chats">,
        boundInstanceName,
      });
      return json({ ok: true });
    }
    case "updateRunId": {
      await ctx.runMutation(internal.bridge.updateMessageRunId, {
        messageId: body.messageId as Id<"messages">,
        runId: body.runId,
        boundInstanceName,
      });
      return json({ ok: true });
    }
    case "heartbeat": {
      await ctx.runMutation(internal.stream.heartbeatStream, {
        messageId: body.messageId as Id<"messages">,
        boundInstanceName,
      });
      return json({ ok: true });
    }
    case "setSessionActiveTokens": {
      await ctx.runMutation(internal.stream.setSessionActiveTokens, {
        chatId: body.chatId as Id<"chats">,
        activeTokens: body.activeTokens as number,
        boundInstanceName,
        observedAt:
          typeof body.observedAt === "number" ? body.observedAt : undefined,
      });
      return json({ ok: true });
    }
    case "setSessionMeta": {
      await ctx.runMutation(internal.stream.setSessionMeta, {
        chatId: body.chatId as Id<"chats">,
        meta: body.meta,
        boundInstanceName,
      });
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        chatId: body.chatId,
        correlationId: body.chatId,
        meta: {
          op: body.op,
          // Non-PHI knob labels + derived context % only — never raw counts/PHI.
          model: body.meta.model,
          thinkingLevel: body.meta.thinkingLevel,
          pctContext:
            body.meta.totalTokens != null && body.meta.contextTokens
              ? Math.round(
                  (body.meta.totalTokens / body.meta.contextTokens) * 100,
                )
              : undefined,
          ok: true,
        },
      });
      return json({ ok: true });
    }
    case "getRehydrationContext": {
      const result = await ctx.runQuery(internal.stream.rehydrationContext, {
        chatId: body.chatId as Id<"chats">,
        boundInstanceName,
        excludeMessageId: body.excludeMessageId
          ? (body.excludeMessageId as Id<"messages">)
          : undefined,
      });
      // Metadata only — NEVER the history text (PHI). Just whether we re-hydrated
      // and how many prior turns were included.
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        chatId: body.chatId,
        correlationId: body.chatId,
        meta: {
          op: body.op,
          rehydrated: result.history !== null,
          turnCount: result.turnCount,
          ok: true,
        },
      });
      return json(result);
    }
    case "upsertSubAgent": {
      await ctx.runMutation(internal.subAgents.upsertSubAgent, {
        chatId: body.chatId as Id<"chats">,
        // The PROVEN instance (per-bridge auth) WINS over the self-asserted body
        // field — a bridge can no longer stamp another gateway's name on a
        // sub-agent row. Falls back to the (legacy shared path's) self-asserted
        // value only when no instance was proven.
        // The PROVEN instance — the self-asserted body field is ignored.
        instanceName: boundInstanceName,
        // ATOMIC cross-gateway re-check inside the mutation (global-key TOCTOU +
        // parentMessageId).
        boundInstanceName,
        parentMessageId: body.parentMessageId
          ? (body.parentMessageId as Id<"messages">)
          : undefined,
        anchorExact: body.anchorExact === true ? true : undefined,
        childSessionKey: body.childSessionKey,
        kind: body.kind,
        bornOfRun: body.bornOfRun,
        taskName: body.taskName,
        status: body.status,
        resultText: body.resultText,
        phase: body.phase,
        errorMessage: body.errorMessage,
        tools: body.tools,
        sessionMeta: body.sessionMeta,
        telemetry: body.telemetry,
      });
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        chatId: body.chatId,
        correlationId: body.chatId,
        meta: {
          op: body.op,
          // Structural only — never the child's result text/task content.
          status: body.status,
          ...(body.phase !== undefined ? { phase: body.phase } : {}),
          hasResult: body.resultText != null,
          // Content-free: how MANY tools the child has used (never the names/args).
          ...(Array.isArray(body.tools) ? { toolCount: body.tools.length } : {}),
          ok: true,
        },
      });
      return json({ ok: true });
    }
    case "upsertSubAgentToolPart": {
      await ctx.runMutation(internal.subAgents.upsertSubAgentToolPart, {
        chatId: body.chatId as Id<"chats">,
        childSessionKey: body.childSessionKey,
        toolCallId: body.toolCallId,
        name: body.name,
        status: body.status,
        argsText: body.argsText,
        resultText: body.resultText,
        // ATOMIC cross-gateway re-check (global (childSessionKey, toolCallId) key).
        boundInstanceName,
      });
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        chatId: body.chatId,
        correlationId: body.chatId,
        meta: {
          op: body.op,
          // Structural only — the tool's args/result are the child's CONTENT (shown
          // in-app), never written to the observability trace; only presence flags.
          status: body.status,
          hasArgs: body.argsText != null,
          hasResult: body.resultText != null,
          ok: true,
        },
      });
      return json({ ok: true });
    }
    case "recordSubAgentInteractionReply": {
      await ctx.runMutation(
        internal.subAgentInteractions.recordInteractionReply,
        {
          interactionId: body.interactionId as Id<"subAgentInteractions">,
          status: body.status,
          replyText: body.replyText,
          errorMessage: body.errorMessage,
          boundInstanceName,
        },
      );
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        chatId: undefined,
        meta: {
          op: body.op,
          // Structural only — the reply text is the user's in-app content, never traced.
          status: body.status,
          hasReply: body.replyText != null,
        },
      });
      return json({ ok: true });
    }
    default:
      return json({ ok: false, error: "unknown op" }, 400);
  }
  } catch (e) {
    // ATOMIC barrier throw from ANY write mutation (the in-transaction
    // chatAllowsInstance re-check) → 403. Any other error re-throws — a real
    // failure must never read as a cross-instance denial.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("forbidden: cross-instance")) throw e;
    return await forbiddenResponse(ctx, body.op, boundInstanceName, true);
  }
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The cross-instance 403: traced (structural meta only — the calling instance
 *  NAME, never chat data) + a stable error body. `atomic` distinguishes the
 *  in-mutation barrier (the TOCTOU catch) from the boundary fast-path. */
async function forbiddenResponse(
  ctx: ActionCtx,
  op: string,
  boundInstance: string,
  atomic: boolean,
): Promise<Response> {
  await traceIngest(ctx, {
    kind: "openclaw.ingest.denied",
    status: 403,
    meta: { reason: "cross_instance", op, boundInstance, atomic },
  });
  return json({ ok: false, error: "forbidden: cross-instance target" }, 403);
}
