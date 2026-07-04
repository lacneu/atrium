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
//   - `Authorization: Bearer <BRIDGE_INGEST_SECRET>` — the secret is read from
//     DEPLOYMENT ENV (`npx convex env set BRIDGE_INGEST_SECRET ...`), NEVER from
//     a table or the browser. Constant-time compared.
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
// ctx.storage are available; Node built-ins are NOT). The secret compare is
// therefore a pure-JS constant-time comparison over UTF-8 bytes — deliberately
// NOT node:crypto.timingSafeEqual.
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Compare against a fixed-length accumulator so the loop count does not vary
  // with where the first mismatch is. A length difference is folded into diff.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

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
  // `rec*` fields are present only while a turn is being recorded (bridge tags the
  // flush): recSessionId is the turn's recording session (Convex records only if it
  // still matches the active one), bridgeSentAt (t1) + bridgeSkew feed segment A,
  // sizeBytes is the flush size (UTF-8). See convex/deliveryTiming.ts.
  | {
      op: "appendDelta";
      messageId: string;
      text: string;
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
      recSessionId?: string;
      bridgeRecvAt?: number;
      bridgeSentAt?: number;
      bridgeSkew?: number;
      sizeBytes?: number;
    }
  | { op: "addPart"; messageId: string; part: Record<string, unknown> }
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
    }
  // SOC2-safe outbound-media DIAGNOSTIC (recorded as an `openclaw.media` trace; no
  // message part, no DB write). Structural codes only — never filename/path/bytes.
  | {
      op: "mediaTrace";
      messageId: string;
      phase: "received" | "stored" | "dropped";
      reason?: string;
      bytesBucket?: string;
      mimeBase?: string;
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
      compaction: string | null;
      errorKind?: string | null;
    }
  | {
      op: "finalize";
      messageId: string;
      status: "complete" | "error" | "aborted";
      text: string;
      error: string | null;
      errorKind?: string | null;
    }
  // Session meta mirrored from the gateway's `sessions.describe` (model,
  // reasoning level + enum, verbosity, context-usage counts) so the chat header
  // can render the model/reasoning chips + context meter. Non-secret knob labels
  // only. The bridge posts this when it learns a turn's session meta.
  | {
      op: "setSessionMeta";
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
      parentMessageId?: string | null;
      childSessionKey: string;
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

export const ingest = httpAction(async (ctx, request) => {
  // Earliest server timestamp (≈ request receipt), captured BEFORE auth/parse so the
  // delivery recorder's `calibrate` op can return a clean clock reference near the
  // round-trip midpoint — not biased by any later server work. See convex/deliveryTiming.ts.
  const receivedAt = Date.now();
  const secret = process.env.BRIDGE_INGEST_SECRET ?? "";
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!secret || !constantTimeEqual(header, expected)) {
    // Trace the rejected ingest (no body parsed yet -> no op/ids). NEVER log the
    // presented secret/header.
    await traceIngest(ctx, {
      kind: "openclaw.ingest.denied",
      status: 401,
      meta: { reason: secret ? "bad_secret" : "secret_unset" },
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

  switch (body.op) {
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
        correlationId: body.messageId,
        meta: {
          op: body.op,
          messageId: body.messageId,
          phase: body.phase,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.bytesBucket !== undefined
            ? { bytesBucket: body.bytesBucket }
            : {}),
          ...(body.mimeBase !== undefined ? { mimeBase: body.mimeBase } : {}),
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
          compaction: body.compaction,
          // Hard, UN-recovered overflow (gateway errorKind "context_length") —
          // the counterpart of `compaction` (= handled silently). Distinguishes
          // "the gateway coped" from "the turn FAILED on context".
          ...(body.errorKind ? { errorKind: body.errorKind } : {}),
        },
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
      });
      await traceIngest(ctx, {
        kind: "openclaw.ingest",
        correlationId: body.messageId,
        meta: {
          op: body.op,
          messageId: body.messageId,
          // String lifecycle status lives in meta (the `status` column is numeric).
          finalizeStatus: body.status,
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
    case "setSessionMeta": {
      await ctx.runMutation(internal.stream.setSessionMeta, {
        chatId: body.chatId as Id<"chats">,
        meta: body.meta,
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
        parentMessageId: body.parentMessageId
          ? (body.parentMessageId as Id<"messages">)
          : undefined,
        childSessionKey: body.childSessionKey,
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
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
