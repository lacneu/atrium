// SubAgentObserver -- PERSISTENT, CHAT-LEVEL observation of the sub-agents a
// chat's agent spawns via the gateway `sessions_spawn` tool. This is increment 1
// of the sub-agent monitor: it is purely INBOUND-OBSERVATIONAL (it reads gateway
// frames and produces Convex upsert records) and NEVER influences what the bridge
// SENDS -- no dispatch / rehydration / session-keying coupling whatsoever.
//
// WHY A SEPARATE REGISTRY (parallel to the per-turn normalizer state): a child run
// runs on its OWN lane (`agent:<id>:subagent:<uuid>`) and OUTLIVES the parent turn
// -- the parent agent often ends ("I'll wait", then yields/ends) while the child
// finishes seconds-to-minutes later. The normalizer's `handleSubAgent` only sees
// child frames WHILE the parent turn is active; once the parent turn finalizes,
// the run-manager's sink goes inactive and drops every later frame -- so the
// child's progress and RESULT (which arrive after) are lost. This registry is
// keyed by `childSessionKey` and is decoupled from the parent turn lifecycle, so a
// child frame arriving AFTER the parent reaped still updates the store.
//
// CONTAMINATION-PROOF admission: every child frame carries `payload.spawnedBy` =
// the PARENT sessionKey, which embeds the chatId. An observer is constructed for
// ONE parent sessionKey, so it only ever admits children of ITS chat -- a child of
// any other chat (different spawnedBy) is rejected by construction, even on a
// shared agent id. The `sessions_spawn` tool RESULT (which carries the
// childSessionKey) is emitted on the parent's OWN lane, so registration is gated
// on `payload.sessionKey === parentSessionKey`.
//
// FD-LEAK GUARDRAILS (mandatory -- a persistent registry with no reap is the exact
// EMFILE class of bug from the idle-session incident): (1) final-reap removes an
// observation on the child's `chat:final`; (2) a TTL sweep reaps a stalled
// observation (no child frame for `ttlSeconds`); (3) a max-concurrent cap bounds
// the registry. A bounded `recentlyFinal` set prevents a stray post-final frame
// from resurrecting a reaped child.

import { sanitizeText } from "./sanitize.js";
import {
  childChatTerminalStatus,
  type SubAgentStatus,
} from "./sub-agent-frames.js";
import type {
  SubAgentInteractionReply,
  SubAgentRecord,
  SubAgentSessionMeta,
  SubAgentTelemetry,
  SubAgentToolPartRecord,
} from "../../convex-writer.js";

/** The Convex upsert the observer emits (see convex/subAgents.ts). Alias of the
 *  writer's record type -- single source of truth for the shape. */
export type SubAgentUpsert = SubAgentRecord;

/** The subset of the session meta carried by the sessions_spawn `start` args. */
type SpawnConfig = Pick<
  SubAgentSessionMeta,
  | "context"
  | "runtime"
  | "mode"
  | "cleanup"
  | "sandbox"
  | "label"
  | "cwd"
  | "agentId"
  | "lightContext"
>;

interface Observation {
  childSessionKey: string;
  taskName?: string;
  parentMessageId?: string | null;
  status: SubAgentStatus;
  /** Last time ANY frame for this child arrived (the TTL clock, in seconds). */
  lastFrameAt: number;
  /**
   * Last time we EMITTED an upsert for this child (seconds) — the heartbeat throttle
   * clock. Distinct from lastFrameAt: most child frames are keep-alives that do NOT
   * upsert, so without a heartbeat the Convex row's `updatedAt` would go stale while
   * the child is alive (and the stale-row reaper would FALSE-REAP it). See
   * heartbeatIfDue / HEARTBEAT_THROTTLE_SECONDS.
   */
  lastUpsertAt: number;
  /** The tools the child has called so far (name + status; SOC2 — no args/results). */
  tools?: ChildTool[];
  /** Last-known STATIC session config (model/reasoning/speed/scope), merged across
   *  frames. Write-once in practice; emitted only on a real change. */
  sessionMeta?: SubAgentSessionMeta;
  /** Last-known run telemetry (runtime/tokens/cost), refreshed in memory on every
   *  session-bearing frame but attached ONLY to already-scheduled upserts
   *  (heartbeat + terminal) — telemetry alone never triggers a write. */
  telemetry?: SubAgentTelemetry;
  /** Phase 2c: when set, the child was re-woken by a USER INTERACTION (chat.send from
   *  "Interagir"); its NEXT terminal frame is that interaction's reply (routed to the
   *  interaction record, not the subAgents.resultText). Cleared on that terminal. */
  interactionId?: string;
}

/** Bound the registry so a misbehaving stream can't grow it without limit. */
const DEFAULT_MAX_CONCURRENT = 64;
// No child frame for this long -> reap (status left as last-known). Generous: a
// sub-agent run can be long (a captured dependent run waited ~210s); aligned with
// the idle-session TTL so the whole session is reaped around the same horizon.
const DEFAULT_TTL_SECONDS = 15 * 60;
// Keep-alive HEARTBEAT throttle (seconds): a still-RUNNING child re-asserts `running`
// (bumping the Convex row's updatedAt) at most once this often on ANY child frame, so
// a long-running child that only streams deltas keeps a FRESH updatedAt and is never
// FALSE-REAPED by the Convex stale-row reaper (convex/subAgents.reapStaleSubAgents,
// SUBAGENT_STALE_TTL_MS = 20 min). 5 min << 20 min leaves ample margin while keeping
// the upsert churn bounded (NOT one write per frame). Coupling documented, not imported.
const HEARTBEAT_THROTTLE_SECONDS = 5 * 60;
// Defensive cap on stored result text (a Convex doc must stay < 1MB; a child's
// answer is normal chat content, so this only guards a pathological run).
const MAX_RESULT_CHARS = 128_000;
const MAX_TASK_CHARS = 256;
// Bounded memory of recently-finalized children, so a stray post-final frame does
// not re-register a child that was already reaped.
const RECENT_FINAL_CAP = 256;

/** One captured child tool: NAME + lifecycle status only (SOC2 — never args/results). */
type ChildTool = { name: string; status: "running" | "done"; toolCallId?: string };
// A tool name is an identifier (not content), but bound it like the task name so a
// malformed frame can't bloat the row; cap the COUNT so a runaway child can't grow the
// tools array without limit.
const MAX_TOOL_NAME_CHARS = 80;
const MAX_TOOLS_PER_CHILD = 100;
// Bound the toolCallId too: it is the dedupe key but reaches the Convex doc, so a
// malformed frame with a huge id must not blow the per-row size (codex review P2).
// 200 is generous for real ids ("call_…|fc_…" ~70 chars); a longer one is truncated
// (still a stable dedupe key) — never the whole blob.
const MAX_TOOL_CALL_ID_CHARS = 200;
// Per-tool DETAIL caps (args + result) -> their own subAgentToolParts row. The detail
// is the user's OWN in-app data, but bound each so one pathological tool (a megabyte
// fetched page) can't blow a row; a longer value is truncated, never dropped whole.
const MAX_TOOL_ARGS_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 4000;

function capToolName(name: string): string {
  return name.length > MAX_TOOL_NAME_CHARS ? name.slice(0, MAX_TOOL_NAME_CHARS) : name;
}

/** A child tool frame's phase -> our two-state status. The tool lifecycle is
 *  start -> (output) -> result/completed; only the END phases read as "done". */
function childToolStatus(phase: string): "running" | "done" {
  return phase === "result" || phase === "completed" || phase === "end"
    ? "done"
    : "running";
}

/** Insert/update a child tool by toolCallId (else name), "done" winning over
 *  "running". Returns the SAME array reference when nothing changed (duplicate or
 *  cap reached) so the caller can skip a redundant upsert; else a NEW array. */
function upsertChildTool(tools: ChildTool[], tool: ChildTool): ChildTool[] {
  const keyOf = (t: ChildTool): string => t.toolCallId ?? `name:${t.name}`;
  const k = keyOf(tool);
  const idx = tools.findIndex((t) => keyOf(t) === k);
  if (idx === -1) {
    if (tools.length >= MAX_TOOLS_PER_CHILD) return tools; // cap -> no change
    return [...tools, tool];
  }
  const cur = tools[idx];
  if (cur !== undefined && tool.status === "done" && cur.status !== "done") {
    const out = tools.slice();
    out[idx] = { ...cur, name: tool.name, status: "done" };
    return out;
  }
  return tools; // already present (and not a running->done transition) -> no change
}

interface SubAgentObserverOptions {
  maxConcurrent?: number;
  ttlSeconds?: number;
}

export class SubAgentObserver {
  private readonly parentSessionKey: string;
  private readonly chatId: string;
  private readonly maxConcurrent: number;
  private readonly ttlSeconds: number;
  private readonly observations = new Map<string, Observation>();
  // Insertion-ordered set of recently-reaped child keys (resurrection guard).
  // Key -> the FINAL status it reached. A Map (not a Set) so a straggler spawn-result
  // backfill can re-assert the TRUE terminal status instead of a fabricated one
  // (emitting `running` would leak Session.registeredChildren; emitting a guessed
  // terminal could flip error->done — the Convex guard only blocks running).
  private readonly recentlyFinal = new Map<string, SubAgentStatus>();
  // sessions_spawn config cached from the `start` frame args, keyed by toolCallId,
  // consumed by the matching `result` registration. Bounded (insertion-ordered).
  private readonly pendingSpawnConfig = new Map<string, SpawnConfig>();
  // Log the cap breach only once per observer so a sustained overflow can't spam.
  private warnedCap = false;

  constructor(
    parentSessionKey: string,
    chatId: string,
    opts: SubAgentObserverOptions = {},
  ) {
    this.parentSessionKey = parentSessionKey;
    this.chatId = chatId;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  /** Number of live observations (test/diagnostic seam for the reap guarantees). */
  get size(): number {
    return this.observations.size;
  }

  /**
   * Observe one raw gateway frame. Returns the Convex upserts it implies (0+):
   *   - the parent's `sessions_spawn` tool RESULT  -> register child (running)
   *   - a child lifecycle phase frame              -> running/done/error (+ phase)
   *   - the child's terminal `chat` frame          -> done+resultText | error+errorMessage |
   *                                                   aborted, then REAP
   * Any other child frame is a keep-alive (resets the TTL clock) with no upsert.
   * `parentMessageId` is the parent's current streaming message id when known
   * (increment 1 usually passes null -- a documented follow-up).
   */
  observe(
    frame: unknown,
    now: number,
    parentMessageId?: string | null,
  ): SubAgentUpsert[] {
    const payload = framePayload(frame);
    if (payload === null) return [];
    const eventType = readString(frame, "event");
    const sessionKey = readString(payload, "sessionKey");
    const spawnedBy = readString(payload, "spawnedBy");

    // --- Registration: the parent's own `sessions_spawn` tool result -----------
    // Emitted on the PARENT lane (sessionKey === parentSessionKey), so this is how
    // we learn a childSessionKey + (best-effort) the task name. The spawn CONFIG
    // (context/runtime/mode/cleanup/sandbox) rides on the earlier `start` frame's
    // args — cache it by toolCallId here so the `result` registration can attach it.
    if (eventType === "agent" && sessionKey === this.parentSessionKey) {
      this.maybeCacheSpawnConfig(payload);
      const reg = this.tryRegisterFromSpawn(payload, now, parentMessageId);
      if (reg !== null) return reg;
    }

    // --- Child frame admission (contamination-proof) ---------------------------
    // Admit a frame whose spawnedBy is THIS chat's parent, OR whose own sessionKey
    // is an already-registered child lane. A child of any other chat carries a
    // different spawnedBy and is not a registered key here -> never admitted.
    const isChildBySpawn = spawnedBy !== null && spawnedBy === this.parentSessionKey;
    const childKey = sessionKey;
    if (childKey === null) return [];
    // Defense-in-depth (mirrors normalizer.handleSubAgent): a child lane is NEVER
    // the parent's own lane. Guards against a malformed/future frame carrying
    // spawnedBy === sessionKey === parent from registering the parent as its own child.
    if (childKey === this.parentSessionKey) return [];
    const isKnownChild = this.observations.has(childKey);
    if (!isChildBySpawn && !isKnownChild) return [];
    // A frame for an already-reaped child (resurrection guard): ignore entirely.
    if (!isKnownChild && this.recentlyFinal.has(childKey)) return [];

    // Lazily register a child we learn about from its own frames (the spawn result
    // was missed or arrived later). Respects the cap; null = refused.
    let obs = this.observations.get(childKey);
    if (obs === undefined) {
      const created = this.register(childKey, now, { parentMessageId });
      if (created === null) return []; // cap reached -> not tracked
      obs = created;
      // Fall through so the SAME frame is interpreted (its phase/final still maps).
    }
    obs.lastFrameAt = now;

    // Capture the child's STATIC session config (model / reasoning / speed / scope)
    // from any frame carrying a `session` object, merged last-known-non-null. `meta`
    // is a one-element upsert ONLY when a static field changed (write-once in practice
    // — NEVER per-frame, so no live-telemetry write-per-tick); else []. Prepended to
    // whatever this frame otherwise emits so the bar fills promptly without its own
    // dedicated round-trip.
    const meta = this.captureSessionMeta(obs, payload);

    // --- Child TERMINAL via chat state (the PRIMARY discriminator) -------------
    // final=done (the answer, the one deterministic source — the parent lane does not
    // reliably re-deliver it), error=failed/timed-out (+ errorMessage), aborted=stopped.
    if (eventType === "chat") {
      const term = childChatTerminalStatus(readString(payload, "state"));
      if (term !== null) {
        const interactionId = obs.interactionId;
        this.reap(childKey, term); // final-reap guardrail (any terminal)
        // Phase 2c: this terminal is the reply to a USER INTERACTION -> route it to
        // the interaction record ONLY (the subAgents.resultText keeps the ORIGINAL
        // answer). `aborted` reads as an error for the interaction.
        if (interactionId !== undefined) {
          const reply: SubAgentInteractionReply = {
            interactionId,
            status: term === "done" ? "done" : "error",
          };
          if (term === "done") {
            const text = this.sanitizeResult(
              textFromMessage(readField(payload, "message")),
            );
            if (text) reply.replyText = text;
          } else {
            const reason =
              readString(payload, "errorMessage") ??
              textFromMessage(readField(payload, "message"));
            const errMsg = this.sanitizeResult(reason);
            if (errMsg) reply.errorMessage = errMsg;
          }
          return [
            ...meta,
            {
              chatId: this.chatId,
              childSessionKey: childKey,
              // Placeholder status (the flush routes an interactionReply record to the
              // interaction store, NOT upsertSubAgent, so this never patches the row).
              status: "running",
              interactionReply: reply,
            },
          ];
        }
        const rec: SubAgentUpsert = {
          chatId: this.chatId,
          parentMessageId: obs.parentMessageId,
          childSessionKey: childKey,
          status: term,
          // The FINAL telemetry (total runtime/tokens/cost) rides on the terminal
          // write — the one place a finished child's numbers become durable.
          ...(obs.telemetry !== undefined ? { telemetry: obs.telemetry } : {}),
        };
        if (term === "done") {
          const text = this.sanitizeResult(textFromMessage(readField(payload, "message")));
          if (text) rec.resultText = text;
        } else {
          // error/aborted: capture the failure reason (top-level errorMessage when present,
          // else the "Error: <msg>" message text). Never gate on the string (mode-dependent).
          const reason =
            readString(payload, "errorMessage") ??
            textFromMessage(readField(payload, "message"));
          const errMsg = this.sanitizeResult(reason);
          if (errMsg) rec.errorMessage = errMsg;
        }
        return [...meta, rec];
      }
      // Non-terminal chat (delta): keep-alive — emit a throttled heartbeat so a long
      // delta-only child keeps a fresh Convex updatedAt (anti false-reap).
      return [...meta, ...this.heartbeatIfDue(obs, now)];
    }

    // --- Child lifecycle phase (the redundant earlier signal) -----------------
    // Gate on the lifecycle STREAM -- tool/item child frames also carry a data.phase.
    const stream = readString(payload, "stream");
    const data = readField(payload, "data");
    const phase = data !== null ? readString(data, "phase") : null;
    if (eventType === "agent" && stream !== null && stream.endsWith("lifecycle") && phase !== null) {
      // A lifecycle phase is NEVER a drain-releasing terminal — it only updates the
      // visible phase and keeps the child `running`. The AUTHORITATIVE terminal is the
      // child's own chat:final / chat:error / chat:aborted frame (handled in the `chat`
      // branch above), the ONLY frame that releases the held send queue (via
      // maybeDrainOnTerminal). VERIFIED against the captured fixtures: `lifecycle:end`/
      // `lifecycle:error` arrive BEFORE the child's `chat:final`/`chat:error`, so
      // terminalizing here would DRAIN a held follow-up before the child is truly done —
      // dispatching it into the still-finishing child and reopening the exact gateway
      // routing race the hold exists to close (round-7 P1). A child that emits a
      // lifecycle terminal but never its chat:final is backstopped by the TTL watchdog
      // (+ the Convex reaper) — slower, but never premature.
      obs.status = "running";
      obs.lastUpsertAt = now; // a real status upsert resets the heartbeat throttle
      return [
        ...meta,
        {
          chatId: this.chatId,
          parentMessageId: obs.parentMessageId,
          childSessionKey: childKey,
          status: "running",
          phase,
        },
      ];
    }

    // --- Child TOOL frame: capture the tool NAME + status (SOC2: name+status only,
    // never the args/results). The child's tool emits stream:"tool" {data:{name,
    // phase, toolCallId}} — the SAME shape as a main-agent tool — so a sub-agent
    // surfaces its tools at the same detail. (sessions_spawn is parent-only.)
    if (eventType === "agent" && stream === "tool" && data !== null) {
      const toolUpserts = this.observeChildTool(obs, data, now);
      if (toolUpserts !== null) return [...meta, ...toolUpserts];
    }

    // Any other child frame (assistant delta, provenance, a no-change tool): keep-
    // alive — emit a throttled heartbeat so a long-running child stays fresh.
    return [...meta, ...this.heartbeatIfDue(obs, now)];
  }

  /**
   * Phase 2c: ARM the observer to capture a USER INTERACTION reply for a child. The
   * child is usually already terminal (its spawn finished + it was reaped), so
   * re-open the observation — clear the resurrection guard + (re)register it running —
   * and flag `interactionId`. The NEXT terminal frame for this child is that
   * interaction's reply, routed (in the chat-terminal branch) to the interaction
   * record, NOT the subAgents.resultText. A second arm just re-points the id.
   */
  armInteraction(childKey: string, interactionId: string, now: number): void {
    this.recentlyFinal.delete(childKey);
    let obs = this.observations.get(childKey);
    if (obs === undefined) {
      const created = this.register(childKey, now, {});
      if (created === null) return; // cap reached -> not tracked
      obs = created;
    }
    obs.status = "running";
    obs.lastFrameAt = now;
    obs.interactionId = interactionId;
  }

  /**
   * A child TOOL frame (stream:"tool"): record the tool NAME + status on the
   * observation and emit an upsert with the full (merged) tools list. SOC2: name +
   * status ONLY — never the tool args/results (the child's content). Returns null
   * when the frame is not a usable/new tool signal (fall through to keep-alive).
   */
  private observeChildTool(
    obs: Observation,
    data: Record<string, unknown>,
    now: number,
  ): SubAgentUpsert[] | null {
    const name = readString(data, "name");
    const phase = readString(data, "phase");
    if (name === null || name === "" || phase === null) return null;
    // A child cannot spawn (anti-recursion); ignore a stray sessions_spawn defensively.
    if (name === "sessions_spawn") return null;
    const rawId = readString(data, "toolCallId");
    const toolCallId =
      rawId === null || rawId === ""
        ? undefined
        : rawId.length > MAX_TOOL_CALL_ID_CHARS
          ? rawId.slice(0, MAX_TOOL_CALL_ID_CHARS)
          : rawId;
    const updated = upsertChildTool(obs.tools ?? [], {
      name: capToolName(name),
      status: childToolStatus(phase),
      toolCallId,
    });
    if (updated === obs.tools) return null; // no change (duplicate / cap) -> keep-alive
    obs.tools = updated;
    obs.lastUpsertAt = now; // a real tool upsert refreshes the heartbeat throttle
    return [
      {
        chatId: this.chatId,
        parentMessageId: obs.parentMessageId,
        childSessionKey: obs.childSessionKey,
        // The child is still running while it uses tools; the Convex reorder guard
        // keeps a terminal row terminal, so this never un-finishes a done child.
        status: obs.status,
        tools: updated,
        // Per-tool DETAIL piggybacked on this same emission: the args (start frame)
        // and result (result frame) for THIS call, routed by the session to its own
        // table. Rides only the emissions where the summary changed (start = new tool,
        // result = running->done), which is exactly where the args/result land.
        toolPart: this.buildToolPart(obs, data, name, phase, toolCallId),
      },
    ];
  }

  /**
   * Build the per-tool DETAIL record (args + result) for the current tool frame.
   * args come on the `start` frame, result on the `result`/`completed`/`end` frame
   * (an `isError` flag there -> status "error"); both are stringified, server-paths
   * stripped, and length-capped. The (childSessionKey, toolCallId) pair is the upsert
   * key — a missing id falls back to `name:<name>` (mirrors the summary's keyOf).
   */
  private buildToolPart(
    obs: Observation,
    data: Record<string, unknown>,
    name: string,
    phase: string,
    toolCallId: string | undefined,
  ): SubAgentToolPartRecord {
    const done = childToolStatus(phase) === "done";
    const isError = data.isError === true;
    const part: SubAgentToolPartRecord = {
      chatId: this.chatId,
      childSessionKey: obs.childSessionKey,
      toolCallId: toolCallId ?? `name:${capToolName(name)}`,
      name: capToolName(name),
      status: done ? (isError ? "error" : "done") : "running",
    };
    const argsRaw = stringifyToolArgs(data.args);
    if (argsRaw) {
      part.argsText = this.sanitizeDetail(argsRaw, MAX_TOOL_ARGS_CHARS);
    }
    // The result lands on the `result` frame; an `update` (partialResult) frame never
    // reaches here (it doesn't change the summary, so observeChildTool returns before
    // building a toolPart), so only data.result is read.
    const resultRaw = extractToolResultText(data.result);
    if (resultRaw) {
      part.resultText = this.sanitizeDetail(resultRaw, MAX_TOOL_RESULT_CHARS);
    }
    return part;
  }

  /** Strip server paths (sanitizeText) + cap — for a tool's args/result detail. */
  private sanitizeDetail(text: string, max: number): string {
    const clean = sanitizeText(text, { mediaSessionKey: this.parentSessionKey });
    return clean.length > max ? clean.slice(0, max) : clean;
  }

  /**
   * Capture the child's STATIC session config from a frame's `payload.session`,
   * merged last-known-non-null. Returns a one-element upsert ONLY when a static field
   * CHANGED (first-known counts), else []. Deliberately reads only the write-once
   * config fields (model / provider / reasoning / speed / control scope / role /
   * depth) — NOT the live telemetry (totalTokens / cost / runtime), which changes
   * every frame and would make this a write-per-tick. CONFIG only (SOC2-safe); the
   * parentSessionKey is NOT captured here (it embeds the canonical + chatId — the
   * parent AGENT is resolved to a display name in-app).
   */
  private captureSessionMeta(
    obs: Observation,
    payload: Record<string, unknown>,
  ): SubAgentUpsert[] {
    const merged: SubAgentSessionMeta = { ...obs.sessionMeta };
    let changed = false;
    // The gateway session id ALSO rides TOP-LEVEL on some child frame shapes (e.g.
    // lifecycle frames carry `payload.sessionId` with NO `session` object — codex
    // P3), so read it before the session-object gate; `session.sessionId` below
    // still applies when the object form is present (same value in practice).
    const topSessionId = readString(payload, "sessionId");
    if (topSessionId !== null && merged.sessionId !== topSessionId) {
      merged.sessionId = topSessionId;
      changed = true;
    }
    const session = readField(payload, "session");
    if (session === null) {
      if (!changed) return [];
      obs.sessionMeta = merged;
      return [
        {
          chatId: this.chatId,
          parentMessageId: obs.parentMessageId,
          childSessionKey: obs.childSessionKey,
          status: obs.status,
          sessionMeta: merged,
        },
      ];
    }
    const model = readString(session, "model");
    if (model !== null && merged.model !== model) {
      merged.model = model;
      changed = true;
    }
    const modelProvider = readString(session, "modelProvider");
    if (modelProvider !== null && merged.modelProvider !== modelProvider) {
      merged.modelProvider = modelProvider;
      changed = true;
    }
    const thinkingLevel = readString(session, "thinkingLevel");
    if (thinkingLevel !== null && merged.thinkingLevel !== thinkingLevel) {
      merged.thinkingLevel = thinkingLevel;
      changed = true;
    }
    const fastMode = session.effectiveFastMode;
    if (typeof fastMode === "boolean" && merged.fastMode !== fastMode) {
      merged.fastMode = fastMode;
      changed = true;
    }
    const controlScope = readString(session, "subagentControlScope");
    if (controlScope !== null && merged.controlScope !== controlScope) {
      merged.controlScope = controlScope;
      changed = true;
    }
    const subagentRole = readString(session, "subagentRole");
    if (subagentRole !== null && merged.subagentRole !== subagentRole) {
      merged.subagentRole = subagentRole;
      changed = true;
    }
    const spawnDepth = session.spawnDepth;
    if (typeof spawnDepth === "number" && merged.spawnDepth !== spawnDepth) {
      merged.spawnDepth = spawnDepth;
      changed = true;
    }
    // The SOURCE gateway kind (session.agentRuntime = {id, source}) — the provider
    // seam so the UI knows which mapping produced these fields (OpenClaw today).
    const agentRuntime = readField(session, "agentRuntime");
    const gatewayKind =
      agentRuntime !== null ? readString(agentRuntime, "id") : null;
    if (gatewayKind !== null && merged.gatewayKind !== gatewayKind) {
      merged.gatewayKind = gatewayKind;
      changed = true;
    }
    // Extended session statics: the spawn label (sanitized like the task name), the
    // gateway session id (the `/subagents log` join key), and the child's effective
    // working directory. Write-once in practice, same merge rule as the rest.
    const label = this.sanitizeTaskName(readString(session, "label") ?? undefined);
    if (label !== undefined && label !== "" && merged.label !== label) {
      merged.label = label;
      changed = true;
    }
    const sessionId = readString(session, "sessionId");
    if (sessionId !== null && merged.sessionId !== sessionId) {
      merged.sessionId = sessionId;
      changed = true;
    }
    // Workspace: store the LAST path segment only ("workspace-alice"), never the full
    // server path — the bridge invariant keeps host filesystem layout out of the
    // browser/MCP surfaces (codex P1). Compare the PROCESSED value so an unchanged
    // long path does not re-emit sessionMeta every frame (codex P2).
    const workDir = pathTail(readString(session, "spawnedWorkspaceDir"));
    if (workDir !== undefined && merged.spawnedWorkspaceDir !== workDir) {
      merged.spawnedWorkspaceDir = workDir;
      changed = true;
    }
    // TELEMETRY (runtime/tokens/cost/startedAt): changes on nearly EVERY frame, so it
    // NEVER sets `changed` (that would turn this into a write-per-tick). Stash the
    // last-known values on the observation; heartbeat + terminal upserts attach them.
    const telemetry: SubAgentTelemetry = { ...obs.telemetry };
    for (const key of [
      "runtimeMs",
      "totalTokens",
      "estimatedCostUsd",
      "startedAt",
    ] as const) {
      const val = session[key];
      if (typeof val === "number" && Number.isFinite(val)) telemetry[key] = val;
    }
    if (Object.keys(telemetry).length > 0) obs.telemetry = telemetry;
    if (!changed) return [];
    obs.sessionMeta = merged;
    return [
      {
        chatId: this.chatId,
        parentMessageId: obs.parentMessageId,
        childSessionKey: obs.childSessionKey,
        status: obs.status,
        sessionMeta: merged,
      },
    ];
  }

  /**
   * Reap observations that have seen no frame for `ttlSeconds` (TTL guardrail) AND
   * surface the silent hang (Bug C): a STILL-RUNNING child that goes quiet past the
   * TTL gets a VISIBLE terminal status (error + a timeout message), not a silent
   * reap -- this is the monitor's own watchdog, because the parent-lane announce is
   * unreliable (it may NO_REPLY or never fire). An already-terminal observation
   * (its chat:final/error landed but it lingered in the registry) is reaped silently
   * (its last-known status stands -- never downgraded). Returns the upserts to write.
   */
  sweep(now: number): SubAgentUpsert[] {
    const out: SubAgentUpsert[] = [];
    for (const [key, obs] of this.observations) {
      // `>=` (not `>`) so a wake-up EXACTLY at the deadline `nextTimeout` returned expires
      // the observation; with `>` a deadline-exact wake leaves nextTimeout returning 0 and
      // spins (repeated zero-delay timeouts) until the clock advances (codex P3).
      if (now - obs.lastFrameAt >= this.ttlSeconds) {
        const wasRunning = obs.status === "running";
        const parentMessageId = obs.parentMessageId;
        const interactionId = obs.interactionId;
        // A still-running child times out to `error`; an already-terminal one keeps
        // its last-known status (never downgraded).
        this.reap(key, wasRunning ? "error" : obs.status);
        if (wasRunning && interactionId !== undefined) {
          // 2c: a pending INTERACTION whose reply never arrived -> fail the interaction
          // (not the subAgents row), so the panel's "Interagir" doesn't hang forever.
          out.push({
            chatId: this.chatId,
            childSessionKey: key,
            status: "running", // placeholder (routed to the interaction store)
            interactionReply: { interactionId, status: "error" },
          });
        } else if (wasRunning) {
          out.push({
            chatId: this.chatId,
            parentMessageId,
            childSessionKey: key,
            status: "error",
            errorMessage: `Sub-agent timed out: no activity for ${this.ttlSeconds}s and the gateway never reported it finishing.`,
            // Last-known telemetry so even a timed-out child keeps its numbers.
            ...(obs.telemetry !== undefined ? { telemetry: obs.telemetry } : {}),
          });
        }
      }
    }
    return out;
  }

  /** Seconds until the earliest observation's TTL deadline (null = none live).
   *  Lets the consume loop wake to run `sweep` even when the parent turn is idle. */
  nextTimeout(now: number): number | null {
    let min: number | null = null;
    for (const obs of this.observations.values()) {
      const t = Math.max(0, obs.lastFrameAt + this.ttlSeconds - now);
      if (min === null || t < min) min = t;
    }
    return min;
  }

  /** Drop every observation (connection close / shutdown). Status last-known. */
  clear(): void {
    this.observations.clear();
  }

  // -- internals --------------------------------------------------------------

  private tryRegisterFromSpawn(
    payload: Record<string, unknown>,
    now: number,
    parentMessageId?: string | null,
  ): SubAgentUpsert[] | null {
    const stream = readString(payload, "stream");
    if (stream !== "tool") return null;
    const data = readField(payload, "data");
    if (data === null) return null;
    if (readString(data, "name") !== "sessions_spawn") return null;
    if (readString(data, "phase") !== "result") return null;
    const childKey = extractChildSessionKey(readField(data, "result"));
    if (childKey === null) return null;
    const taskName = this.sanitizeTaskName(extractTaskName(readString(data, "meta")));
    // The spawn CONFIG cached from this call's `start` frame (by toolCallId) — so
    // `context`/runtime/mode/cleanup/sandbox reach the row from the spawn result.
    // Absent when the spawn omitted them (rendered only when present).
    const toolCallId = readString(data, "toolCallId");
    const cfg =
      toolCallId !== null ? this.pendingSpawnConfig.get(toolCallId) : undefined;
    if (cfg !== undefined && toolCallId !== null) {
      this.pendingSpawnConfig.delete(toolCallId);
    }
    // The spawn result also announces the RESOLVED model/provider — a fill-gaps-only
    // seed (a child session frame's effective value, when already present, wins).
    const resolved = extractSpawnResolved(readField(data, "result"));
    // Already reaped (a FAST child finished off its own frames before this spawn
    // result was ingested): never re-REGISTER (resurrection guard), but still emit a
    // LATE BACKFILL upsert carrying the spawn config — without it the row would miss
    // `cleanup: "delete"` and the interaction archive-guard could be bypassed (codex
    // P2). It carries the child's TRUE final status (from the reap ledger) — never
    // `running` (that would leak Session.registeredChildren + could resurrect a
    // running Convex row) and never a guessed terminal (error must not flip to done).
    const finalStatus = this.recentlyFinal.get(childKey);
    if (finalStatus !== undefined) {
      const lateMeta: SubAgentSessionMeta = {
        ...(resolved ?? {}),
        ...(cfg ?? {}),
      };
      if (Object.keys(lateMeta).length === 0 && taskName === undefined) return [];
      return [
        {
          chatId: this.chatId,
          childSessionKey: childKey,
          status: finalStatus,
          ...(taskName !== undefined ? { taskName } : {}),
          ...(Object.keys(lateMeta).length > 0 ? { sessionMeta: lateMeta } : {}),
        },
      ];
    }

    // The child's OWN frames can arrive BEFORE this spawn result (a race), lazily
    // registering it first. When that happens, BACKFILL the taskName + spawn config
    // onto the existing observation here (the spawn result is their only source), so
    // they are never lost to frame ordering — instead of the old early-return that
    // dropped both.
    const existing = this.observations.get(childKey);
    if (existing !== undefined) {
      let changed = false;
      if (taskName !== undefined && existing.taskName === undefined) {
        existing.taskName = taskName;
        changed = true;
      }
      if (cfg !== undefined) {
        existing.sessionMeta = { ...existing.sessionMeta, ...cfg };
        changed = true;
      }
      if (
        resolved !== undefined &&
        (existing.sessionMeta?.model === undefined ||
          existing.sessionMeta?.modelProvider === undefined)
      ) {
        // Fill-gaps only: spread order keeps any effective value already captured.
        existing.sessionMeta = { ...resolved, ...existing.sessionMeta };
        changed = true;
      }
      if (!changed) return [];
      return [
        {
          chatId: this.chatId,
          parentMessageId: existing.parentMessageId,
          childSessionKey: childKey,
          status: existing.status, // reorder-guarded Convex-side; never downgrades
          ...(existing.taskName !== undefined
            ? { taskName: existing.taskName }
            : {}),
          ...(existing.sessionMeta ? { sessionMeta: existing.sessionMeta } : {}),
        },
      ];
    }

    const obs = this.register(childKey, now, { taskName, parentMessageId });
    if (obs === null) return []; // cap reached -> refused (logged)
    if (cfg !== undefined) {
      obs.sessionMeta = { ...obs.sessionMeta, ...cfg };
    }
    if (resolved !== undefined) {
      obs.sessionMeta = { ...resolved, ...obs.sessionMeta };
    }
    return [
      {
        chatId: this.chatId,
        parentMessageId: obs.parentMessageId,
        childSessionKey: childKey,
        taskName,
        status: "running",
        ...(obs.sessionMeta ? { sessionMeta: obs.sessionMeta } : {}),
      },
    ];
  }

  /**
   * Cache the sessions_spawn CONFIG from the parent's `start` frame args (by
   * toolCallId), so the `result` registration can attach it to the child. Reads only
   * the small enum config fields (context / runtime / mode / cleanup / sandbox) —
   * NEVER the `task` text (content). Bounded so a runaway parent can't grow the map.
   */
  private maybeCacheSpawnConfig(payload: Record<string, unknown>): void {
    if (readString(payload, "stream") !== "tool") return;
    const data = readField(payload, "data");
    if (data === null) return;
    if (readString(data, "name") !== "sessions_spawn") return;
    if (readString(data, "phase") !== "start") return;
    const toolCallId = readString(data, "toolCallId");
    if (toolCallId === null) return;
    const args = readField(data, "args");
    if (args === null) return;
    const cfg: SpawnConfig = {};
    for (const key of ["context", "runtime", "mode", "cleanup", "sandbox"] as const) {
      const val = readString(args, key);
      if (val !== null && val !== "") cfg[key] = val;
    }
    // Extended spawn args: the human label (sanitized like the task name), the
    // working-directory override (LAST segment only — never a full server path,
    // same invariant as spawnedWorkspaceDir), the explicit target agent (an id,
    // capped), and the lightContext flag.
    const label = this.sanitizeTaskName(readString(args, "label") ?? undefined);
    if (label !== undefined && label !== "") cfg.label = label;
    const cwd = pathTail(readString(args, "cwd"));
    if (cwd !== undefined) cfg.cwd = cwd;
    const agentId = readString(args, "agentId");
    if (agentId !== null && agentId !== "")
      cfg.agentId = agentId.slice(0, MAX_TASK_CHARS);
    if (typeof args.lightContext === "boolean") cfg.lightContext = args.lightContext;
    if (Object.keys(cfg).length === 0) return;
    if (this.pendingSpawnConfig.size >= 64) {
      const oldest = this.pendingSpawnConfig.keys().next().value;
      if (oldest !== undefined) this.pendingSpawnConfig.delete(oldest);
    }
    this.pendingSpawnConfig.set(toolCallId, cfg);
  }

  /** Insert an observation, honoring the max-concurrent cap. null = refused. */
  private register(
    childKey: string,
    now: number,
    extra: { taskName?: string; parentMessageId?: string | null },
  ): Observation | null {
    if (this.observations.size >= this.maxConcurrent) {
      if (!this.warnedCap) {
        this.warnedCap = true;
        console.warn(
          `[subagent] observation cap reached (${this.maxConcurrent}) for chat=${this.chatId} -- new sub-agents not tracked until others finish`,
        );
      }
      return null;
    }
    const obs: Observation = {
      childSessionKey: childKey,
      taskName: extra.taskName,
      parentMessageId: extra.parentMessageId ?? null,
      status: "running",
      lastFrameAt: now,
      // Seed the heartbeat clock at registration: the spawn-registration path emits a
      // `running` upsert immediately after, so the first throttle window runs from now
      // (no redundant heartbeat right after registration).
      lastUpsertAt: now,
    };
    this.observations.set(childKey, obs);
    return obs;
  }

  /**
   * Throttled keep-alive HEARTBEAT for a still-RUNNING child. The observer does NOT
   * upsert on plain keep-alive frames (chat deltas / tool frames), so a child that
   * runs long while only streaming would let its Convex `updatedAt` go stale though it
   * is alive — and the stale-row reaper (convex/subAgents.reapStaleSubAgents, 20-min
   * TTL) would FALSE-REAP it, releasing held sends into a LIVE child. To prevent that
   * we re-assert `running` (which bumps the row's updatedAt) at most once per
   * HEARTBEAT_THROTTLE_SECONDS. A genuinely DEAD child (no frames at all) emits no
   * heartbeat, so it still goes stale and is reaped. The heartbeat carries NO phase —
   * it only refreshes updatedAt and never changes status, so it never triggers the
   * Convex terminal-drain.
   */
  private heartbeatIfDue(obs: Observation, now: number): SubAgentUpsert[] {
    if (obs.status !== "running") return [];
    if (now - obs.lastUpsertAt < HEARTBEAT_THROTTLE_SECONDS) return [];
    obs.lastUpsertAt = now;
    return [
      {
        chatId: this.chatId,
        parentMessageId: obs.parentMessageId,
        childSessionKey: obs.childSessionKey,
        status: "running",
        // Piggyback the last-known telemetry on this already-scheduled write, so a
        // long-running child shows live-ish runtime/tokens/cost at heartbeat cadence.
        ...(obs.telemetry !== undefined ? { telemetry: obs.telemetry } : {}),
      },
    ];
  }

  /** Strip server paths (sanitizeText) and cap length — for both the success result
   *  text and the failure error message before they reach the store (SOC2 + bounding). */
  private sanitizeResult(text: string): string {
    const clean = sanitizeText(text, { mediaSessionKey: this.parentSessionKey });
    return clean.length > MAX_RESULT_CHARS ? clean.slice(0, MAX_RESULT_CHARS) : clean;
  }

  /** Strip server paths + cap the sub-agent's task NAME before it is stored and shown as the
   *  card label — a spawn task can mention a path (e.g. /home/node/.openclaw/...) just like the
   *  result/error, so it gets the same sanitation (codex P2). Undefined-safe. */
  private sanitizeTaskName(name: string | undefined): string | undefined {
    if (name === undefined) return undefined;
    const clean = sanitizeText(name, { mediaSessionKey: this.parentSessionKey });
    return clean.length > MAX_TASK_CHARS ? clean.slice(0, MAX_TASK_CHARS) : clean;
  }

  private reap(childKey: string, finalStatus: SubAgentStatus): void {
    this.observations.delete(childKey);
    this.recentlyFinal.set(childKey, finalStatus);
    if (this.recentlyFinal.size > RECENT_FINAL_CAP) {
      // Evict the oldest (Map preserves insertion order).
      const oldest = this.recentlyFinal.keys().next().value;
      if (oldest !== undefined) this.recentlyFinal.delete(oldest);
    }
  }
}

// --- pure frame helpers (defensive structural reads) --------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function framePayload(frame: unknown): Record<string, unknown> | null {
  if (!isObject(frame)) return null;
  const payload = frame.payload;
  return isObject(payload) ? payload : null;
}

function readField(obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = obj[key];
  return isObject(v) ? v : null;
}

function readString(obj: unknown, key: string): string | null {
  if (!isObject(obj)) return null;
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/** The LAST non-empty segment of a filesystem path ("workspace-alice" from
 *  "/home/node/.openclaw/workspace-alice"), capped. The panel shows WHICH workspace a
 *  child ran in without persisting the server's filesystem layout (codex P1); a
 *  segment-less input ("/", "") yields undefined so the field is simply absent. */
function pathTail(path: string | null): string | undefined {
  if (path === null) return undefined;
  const tail = path.split(/[\\/]/).filter((s) => s !== "").pop();
  if (tail === undefined || tail === "") return undefined;
  return tail.length > MAX_TASK_CHARS ? tail.slice(0, MAX_TASK_CHARS) : tail;
}

/** Extract visible text from a chat `message` (content array | string | text). */
function textFromMessage(message: Record<string, unknown> | null): string {
  if (message === null) return "";
  const fromContent = textFromContent(message.content);
  if (fromContent) return fromContent;
  return textFromContent(message.text);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (isObject(part) && typeof part.text === "string") parts.push(part.text);
    }
    return parts.filter((p) => p).join("\n");
  }
  return "";
}

/** A tool call's INPUT as display text: a string as-is, else pretty JSON. Empty
 *  when there is nothing to show (the detail row just omits the input block). */
function stringifyToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
}

/** A tool call's OUTPUT as display text: prefer the `{content:[{text}]}` envelope's
 *  text (what the gateway shows), else the whole value stringified. Mirrors the panel
 *  ToolCard's expectation of a plain text/JSON output. */
function extractToolResultText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (isObject(value)) {
    const fromContent = textFromContent(value.content);
    if (fromContent) return fromContent;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Pull `childSessionKey` out of a `sessions_spawn` tool result. The result is
 * `{ contentItems: [{ text: "<json string>" }] }`, where the JSON string carries
 * the childSessionKey (and a status flag we deliberately IGNORE -- the codex
 * runtime flags the spawn result isError/success:false even on a successful spawn,
 * so childSessionKey presence is the only reliable signal).
 */
function extractChildSessionKey(result: Record<string, unknown> | null): string | null {
  if (result === null) return null;
  // The array key CHANGED between gateway versions: `contentItems` (<=2026.6.5) ->
  // `content` (2026.6.10+). Read whichever is present so the spawn RESULT still
  // registers the child (else it falls back to lazy admission and LOSES taskName +
  // the spawn config — the bug this fixes). Verified live on 6.10: `result.content`.
  const items = Array.isArray(result.content)
    ? result.content
    : Array.isArray(result.contentItems)
      ? result.contentItems
      : null;
  if (items === null) return null;
  for (const item of items) {
    const text = readString(item, "text");
    if (text === null) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      const key = readString(parsed, "childSessionKey");
      if (key !== null && key !== "") return key;
    } catch {
      // Non-JSON content item -- skip.
    }
  }
  return null;
}

/**
 * The RESOLVED model/provider announced in the spawn result JSON (resolvedModel /
 * resolvedProvider) — seeds the panel's session bar BEFORE the first child frame
 * arrives; the child's own session frames later confirm (same values) or overwrite.
 */
function extractSpawnResolved(
  result: Record<string, unknown> | null,
): Pick<SubAgentSessionMeta, "model" | "modelProvider"> | undefined {
  if (result === null) return undefined;
  const items = Array.isArray(result.content)
    ? result.content
    : Array.isArray(result.contentItems)
      ? result.contentItems
      : null;
  if (items === null) return undefined;
  for (const item of items) {
    const text = readString(item, "text");
    if (text === null) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      const model = readString(parsed, "resolvedModel");
      const provider = readString(parsed, "resolvedProvider");
      const out: Pick<SubAgentSessionMeta, "model" | "modelProvider"> = {};
      if (model !== null && model !== "") out.model = model;
      if (provider !== null && provider !== "") out.modelProvider = provider;
      if (Object.keys(out).length > 0) return out;
    } catch {
      // Non-JSON content item -- skip.
    }
  }
  return undefined;
}

/**
 * Best-effort task name from the tool `meta` string. The gateway emits either
 * "task <text>, agent <id>" or — for a labeled spawn — "label <name>, task <text>,
 * agent <id>". Prefer the short human LABEL (a simple identifier) when present; else
 * the TASK text, greedy up to the LAST ", agent " so a task containing a comma
 * survives, and tolerating a leading "label …, " prefix (codex P3). Returns undefined
 * when neither is present.
 */
export function extractTaskName(meta: string | null): string | undefined {
  if (meta === null) return undefined;
  const label = /^label ([^,]+),/.exec(meta)?.[1]?.trim();
  // The TASK text, greedy, minus the gateway's trailing metadata token: ", agent X"
  // (<=2026.6.5) OR ", cleanup X" (2026.6.10 renamed it). Without tolerating the new
  // suffix, a label-LESS 6.10 spawn parsed to NO task name (card showed none).
  let task = /(?:^|, )task (.*)$/.exec(meta)?.[1]?.trim();
  if (task !== undefined) {
    task = task.replace(/,\s*(?:agent|cleanup)\s+[^,]*$/, "").trim();
  }
  const raw = label || task;
  if (!raw) return undefined;
  return raw.length > MAX_TASK_CHARS ? raw.slice(0, MAX_TASK_CHARS) : raw;
}
