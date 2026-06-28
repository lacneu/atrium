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
import type { SubAgentRecord } from "../../convex-writer.js";

/** The Convex upsert the observer emits (see convex/subAgents.ts). Alias of the
 *  writer's record type -- single source of truth for the shape. */
export type SubAgentUpsert = SubAgentRecord;

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
  private readonly recentlyFinal = new Set<string>();
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
    // we learn a childSessionKey + (best-effort) the task name.
    if (eventType === "agent" && sessionKey === this.parentSessionKey) {
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

    // --- Child TERMINAL via chat state (the PRIMARY discriminator) -------------
    // final=done (the answer, the one deterministic source — the parent lane does not
    // reliably re-deliver it), error=failed/timed-out (+ errorMessage), aborted=stopped.
    if (eventType === "chat") {
      const term = childChatTerminalStatus(readString(payload, "state"));
      if (term !== null) {
        this.reap(childKey); // final-reap guardrail (any terminal)
        const rec: SubAgentUpsert = {
          chatId: this.chatId,
          parentMessageId: obs.parentMessageId,
          childSessionKey: childKey,
          status: term,
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
        return [rec];
      }
      // Non-terminal chat (delta): keep-alive — emit a throttled heartbeat so a long
      // delta-only child keeps a fresh Convex updatedAt (anti false-reap).
      return this.heartbeatIfDue(obs, now);
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
        {
          chatId: this.chatId,
          parentMessageId: obs.parentMessageId,
          childSessionKey: childKey,
          status: "running",
          phase,
        },
      ];
    }

    // Any other child frame (assistant delta, provenance, tool): keep-alive — emit a
    // throttled heartbeat so a long-running child stays fresh (anti false-reap).
    return this.heartbeatIfDue(obs, now);
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
        this.reap(key);
        if (wasRunning) {
          out.push({
            chatId: this.chatId,
            parentMessageId,
            childSessionKey: key,
            status: "error",
            errorMessage: `Sub-agent timed out: no activity for ${this.ttlSeconds}s and the gateway never reported it finishing.`,
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
    // Already known (idempotent) or already reaped: nothing to register.
    if (this.observations.has(childKey) || this.recentlyFinal.has(childKey)) {
      return [];
    }
    const taskName = this.sanitizeTaskName(extractTaskName(readString(data, "meta")));
    const obs = this.register(childKey, now, { taskName, parentMessageId });
    if (obs === null) return []; // cap reached -> refused (logged)
    return [
      {
        chatId: this.chatId,
        parentMessageId: obs.parentMessageId,
        childSessionKey: childKey,
        taskName,
        status: "running",
      },
    ];
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

  private reap(childKey: string): void {
    this.observations.delete(childKey);
    this.recentlyFinal.add(childKey);
    if (this.recentlyFinal.size > RECENT_FINAL_CAP) {
      // Evict the oldest (Set preserves insertion order).
      const oldest = this.recentlyFinal.values().next().value;
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

/**
 * Pull `childSessionKey` out of a `sessions_spawn` tool result. The result is
 * `{ contentItems: [{ text: "<json string>" }] }`, where the JSON string carries
 * the childSessionKey (and a status flag we deliberately IGNORE -- the codex
 * runtime flags the spawn result isError/success:false even on a successful spawn,
 * so childSessionKey presence is the only reliable signal).
 */
function extractChildSessionKey(result: Record<string, unknown> | null): string | null {
  if (result === null) return null;
  const items = result.contentItems;
  if (!Array.isArray(items)) return null;
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
  const task = /(?:^|, )task (.*), agent [^,]*$/.exec(meta)?.[1]?.trim();
  const raw = label || task;
  if (!raw) return undefined;
  return raw.length > MAX_TASK_CHARS ? raw.slice(0, MAX_TASK_CHARS) : raw;
}
