// Inbound HTTP endpoint: Convex -> bridge.
//
// `convex/bridge.ts` dispatch POSTs a pending user turn to `POST /send`. The
// request shape and auth are DICTATED by convex/bridge.ts (source of truth):
//   headers: { Authorization: <BRIDGE_SHARED_SECRET> }   // raw, NO "Bearer "
//   body:    { chatId, openclawChatId, text, clientMessageId, attachments }
//
// On a valid request we:
//   1. resolve (or lazily create) the per-session OpenClaw connection + run
//      manager for `openclawChatId`,
//   2. patch verboseLevel=full once per connection (sticky server-side),
//   3. chat.send with an idempotencyKey derived from clientMessageId,
//   4. learn the ack runId and beginTurn() so the normalizer admits this run.
//
// SECURITY: the shared secret is compared in CONSTANT TIME; the body is size-
// limited before parsing. We never echo gateway/filesystem detail to the caller.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";

import type { BridgeConfig, SharedConfig } from "./config.js";
import {
  idempotencyKey,
  OpenClawConnection,
} from "./providers/openclaw/openclaw-client.js";
import { buildMediaFetcher } from "./core/media-fetcher-provider.js";
import {
  chatAbortParams,
  sessionsGetParams,
  talkClientCreateParams,
  talkToolCallParams,
  taskGetParams,
  taskListParams,
  ttsParams,
} from "./core/rpc-params.js";
import {
  REHYDRATION_MAX_FILL,
  composedPromptFits,
  sessionFill,
  sessionFillDetail,
  type SessionFillSource,
} from "./core/context-budget.js";
import {
  COMPACT_TIMEOUT_MS,
  ContextBlockedError,
  compactBudget,
  presendAction,
  requiresCompaction,
  sendAfterCompaction,
  type PresendAction,
} from "./core/presend-guard.js";
import {
  bucketCompactionReason,
  isPermanentCompactionRefusal,
  isTransientCompactionRefusal,
} from "./core/compaction-verdict.js";

/**
 * What the pre-send guard did, for the bridge log + the (content-free) rehydrate
 * trace. Enums and one integer percent — no gateway string ever reaches it.
 */
interface PresendReport {
  action: PresendAction;
  fillPct: number | null;
  fillSource: SessionFillSource | null;
  compactOutcome:
    | "not_needed"
    | "compacted"
    | "refused"
    | "error"
    | "unknown"
    | "skipped_busy"
    | "skipped_known_refusal"
    | "skipped_no_budget";
  /** Bucketed class of the gateway's refusal reason (never its text). */
  compactReasonClass?: string;
  /** The send was WITHHELD. The only value in this report that changes an outcome. */
  blocked: boolean;
}
import {
  PRE_SEND_DEADLINE_MS,
  assertBeforeSendDeadline,
} from "./core/dispatch-deadline.js";
import {
  classifyGatewayError,
  LOST_RESPONSE_CODES,
  faultDomain,
} from "./core/dispatch-errors.js";
import { claimTalkRun, observeFinalize } from "./core/talk-consult.js";
import { RunManager } from "./providers/openclaw/run-manager.js";
import { base64FitsFrame } from "./core/attachment-limits.js";
import {
  parseInboundConfig,
  type InboundInstanceConfig,
} from "./core/instance-config.js";
import {
  buildFilesReceivedBlock,
  stageInboundReferences,
  type InboundMediaConfig,
  type InboundReference,
} from "./core/inbound-media.js";
import { applyMediaDeliveryInjection } from "./core/outbound-delivery.js";
import {
  buildSessionKey,
  safeSessionPart,
} from "./providers/openclaw/session-keys.js";
import {
  transcriptEntryCount,
  extractLatestAssistantReply,
} from "./providers/openclaw/history-recovery.js";
import { summarizeLosslessReply } from "./core/lossless-summary.js";
import {
  HermesTurnRegistry,
  performHermesSend,
  performHermesAbort,
  applyDurableSessionDrop,
  hermesAbortResponseBody,
  performHermesReset,
  performHermesAgentFilesOp,
  performHermesCronList,
  performHermesCronManage,
  discoverHermesAgents,
} from "./providers/hermes/dispatch.js";
import { readHermesGatewayVersion } from "./providers/hermes/ws-turn.js";
import {
  buildGatewayCronPatch,
  normalizeCronJobDetail,
  normalizeCronRunEntries,
  parseCronManagePatch,
  RUNS_LIMIT_MAX,
  type CronJobDetail,
  type CronManagePatch,
  type CronRunEntry,
} from "./core/cron-manage.js";

import { validateSharedFs } from "./core/media-validate.js";
import {
  gatewayHostOf,
  type HealthRegistry,
  type HealthSnapshot,
  type TargetHealth,
  type TargetRef,
} from "./core/health.js";
import {
  hermesCapabilitiesFor,
  BRIDGE_VERSION,
  COMPAT_MANIFEST,
  PROTOCOL_VERSION,
  resolveCapabilities,
  resolveCapabilitiesFor,
  HERMES_RANGE,
} from "./compat.js";
import {
  COVERAGE_SUMMARY,
  DRIFT_VENDORED_VERSION,
  protocolDrift,
} from "./providers/openclaw/protocol-drift.js";
import type { ConvexWriter, SessionMetaReport } from "./convex-writer.js";
import type { ConfigIssue } from "./core/credential-resolver.js";
import type {
  SessionRegistry,
  BridgeSession,
  SessionRouting,
  LiveTarget,
  InstanceBundle,
} from "./session.js";
import {
  AGENT_FILE_NAMES,
  defaultsApplied,
  extractAgentDefaults,
  parseAgentFilesBody,
  parseConfigDefaultsBody,
  performAgentFilesOp,
  performConfigDefaultsOp,
  type ConfigDefaultsBody,
  type GatewayRequester,
} from "./conf.js";

/** Per-chat OpenClaw knob intent (reasoning/model/speed). Non-secret. */
interface SessionSettings {
  thinkingLevel?: string | null;
  model?: string | null;
  /**
   * Speed knob (`sessions.patch {fastMode}`; OpenAI serviceTier under the
   * hood). ⚠ `false` is a VALID value to apply — presence is checked with
   * `!== undefined`, NEVER a falsy check like the string knobs above.
   */
  fastMode?: boolean;
  /**
   * Overrides to UNSET on the gateway (`sessions.patch {<field>: null}` —
   * verified 6.5: null REMOVES the override from the session store). Persisted
   * INSIDE the intent by the app (P2-4) so an unset survives a bridge outage
   * exactly like a set: the per-turn re-apply repairs it. STRICT allowlist.
   */
  clears?: ClearableField[];
}

/**
 * Per-chat overrides `/patch` can UNSET (sessions.patch `{<field>: null}` —
 * verified 6.5: null REMOVES the override from the session store). STRICT
 * allowlist: a clears entry outside this list rejects the whole body.
 */
const CLEARABLE_FIELDS = ["thinkingLevel", "model", "fastMode"] as const;
type ClearableField = (typeof CLEARABLE_FIELDS)[number];

/**
 * Per-turn routing resolved by Convex and carried in EVERY body. `agentId` and
 * `canonical` are REQUIRED — there is deliberately NO env fallback (a fallback to
 * a static agent id is exactly the "Agent <env-id> no longer exists" prod bug).
 * `instanceName` (optional) is checked against the bridge's declared instance.
 */
interface BodyRouting {
  agentId: string;
  canonical: string;
  instanceName: string | null;
}

interface SendBody extends BodyRouting {
  chatId: string;
  openclawChatId: string | null;
  /** A session this chat LOST a reply on, for ONE read-only harvest (G-47). Parsed here or
   *  it never crosses the HTTP boundary — the whole feature ran only in tests until a review
   *  pass noticed this hop rebuilt the body without it. */
  recoverableSession: {
    session: string;
    messageId: string;
    instanceName?: string | null;
  } | null;
  text: string;
  clientMessageId: string;
  /** The user message id for this turn (excluded from re-hydration history). */
  messageId: string | null;
  /** Provider-session reset epoch (chats.providerResetCount at dispatch) —
   *  echoed by the Hermes post-ACK session bind so Convex refuses a bind that
   *  raced a /reset. Null on an old Convex (bind stays unguarded). */
  providerResetCount: number | null;
  /** The OUTBOX id of this dispatch — echoed as the `openclaw.rehydrate` trace's
   *  correlationId (`chatId:outboxId`), the obs-MCP join key. Null on an old Convex. */
  outboxId: string | null;
  /** How long this dispatch had ALREADY been pending when Convex sent the POST (a
   *  DURATION — no shared clock). Added to our own elapsed time by the pre-send
   *  deadline. 0 on an old Convex that does not report it. */
  dispatchAgeMs: number;
  /** The agent this turn SWITCHED AWAY FROM (null = not an agent switch) — non-secret
   *  names, echoed into the rehydrate trace + anomaly. From Convex's beginTurnRouting. */
  switchedFromAgentId: string | null;
  switchedFromInstanceName: string | null;
  /** The user's reasoning/model overrides, re-applied before chat.send. */
  sessionSettings: SessionSettings | null;
  /** INLINE (model-native / non-shared-fs) attachments: base64 in the WS frame. */
  attachments?: unknown;
  /**
   * REFERENCE (tool-read, shared-fs) attachments: a short-lived getUrl the bridge
   * STREAMS to the shared inbound dir, then path-references in `[FICHIERS REÇUS]`.
   */
  referenceAttachments: InboundReference[];
  /**
   * Per-instance NON-secret config (Convex resolves it from `instances.config`).
   * Hot-consumed: mediaMode/mediaMaxMb feed the MediaFetcherProvider, rehydration
   * gates re-hydration. `null` (old Convex / absent) → bridge env defaults.
   */
  config: InboundInstanceConfig | null;
}

/** Inbound body for the immediate knob write-back (`POST /patch`). */
interface PatchBody extends BodyRouting {
  chatId: string;
  openclawChatId: string | null;
  /**
   * The COMPLETE per-chat intent (sets + `clears`), nested exactly like the
   * `/send` body carries it — never flat partial fields, never a top-level
   * `clears` (one source of truth, P2-4).
   */
  sessionSettings: SessionSettings;
}

/** Inbound body for a session reset (`POST /reset`). */
interface ResetBody extends BodyRouting {
  chatId: string;
  openclawChatId: string | null;
  /** PANEL resets only (never a regenerate's chained reset): refuse with 409
   *  turn_active when a turn is LIVE on this chat at execution time — the
   *  bridge is the only place that knows atomically; the Convex-side busy
   *  checks are schedule-time and race the send path (codex P1, pass 8). */
  refuseIfActive: boolean;
}

/** Constant-time string compare that does not leak length via early return. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still run a comparison to avoid trivially leaking the length difference.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Thrown by `readBody` when the body exceeds the cap (mapped to a clean 413). */
export class BodyTooLargeError extends Error {
  constructor() {
    super("payload too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read the request body up to `maxBytes`, rejecting anything larger. On
 * overflow we STOP buffering and reject, but deliberately do NOT `destroy()` the
 * socket: tearing it down before the handler writes the 413 made the client
 * (Convex `fetch`) see an ECONNRESET — surfaced as a misleading
 * `BRIDGE_UNREACHABLE` instead of an honest "too large". We drain the rest with
 * `resume()` so the response flushes cleanly; the cap itself bounds memory.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      total += chunk.length;
      if (total > maxBytes) {
        over = true;
        chunks.length = 0; // release the buffered prefix
        req.resume(); // drain remaining bytes without buffering
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/**
 * Extract the per-turn routing. `agentId` + `canonical` are REQUIRED (returns
 * null if absent) — no env fallback, by design (see BodyRouting). `instanceName`
 * is optional. Exported for tests.
 */
export function parseBodyRouting(
  obj: Record<string, unknown>,
): BodyRouting | null {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const agentId = str(obj.agentId);
  const canonical = str(obj.canonical);
  if (!agentId || !canonical) return null;
  return { agentId, canonical, instanceName: str(obj.instanceName) };
}

/**
 * M2 guard: when the bridge DECLARES the instance it serves
 * (OPENCLAW_INSTANCE_NAME), refuse a body that claims a DIFFERENT one — a Convex
 * routing misconfig must fail LOUDLY rather than answer from the wrong gateway.
 * Skipped (returns false) when the bridge declares no instance, or the body omits
 * one (cannot compare). Exported for tests.
 */
export function isInstanceMismatch(
  servedInstance: string | null,
  bodyInstanceName: string | null,
): boolean {
  return (
    servedInstance !== null &&
    bodyInstanceName !== null &&
    bodyInstanceName !== servedInstance
  );
}

/** Project any inbound body onto the session registry's routing shape. */
function toRouting(
  b: BodyRouting & { chatId: string; openclawChatId: string | null },
  instanceName: string,
): SessionRouting {
  return {
    chatId: b.chatId,
    openclawChatId: b.openclawChatId,
    agentId: b.agentId,
    canonical: b.canonical,
    instanceName,
  };
}

export function parseSendBody(raw: string): SendBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.chatId !== "string" || typeof obj.text !== "string") {
    return null;
  }
  if (typeof obj.clientMessageId !== "string") {
    return null;
  }
  const routing = parseBodyRouting(obj);
  if (routing === null) return null;
  const sessionSettings = parseSessionSettings(obj.sessionSettings);
  // A malformed clears list poisons the whole body (never silently drop an
  // unset); a missing/empty intent is fine for a send.
  if (sessionSettings === "invalid") return null;
  return {
    ...routing,
    chatId: obj.chatId,
    openclawChatId:
      typeof obj.openclawChatId === "string" ? obj.openclawChatId : null,
    // Both ids REQUIRED and non-empty: a half-formed handle would send the bridge reading a
    // session it cannot attribute, or writing back to a message it cannot name. Malformed →
    // null, and the turn proceeds exactly as it would have.
    recoverableSession: (() => {
      const r = obj.recoverableSession;
      if (typeof r !== "object" || r === null) return null;
      const h = r as {
        session?: unknown;
        messageId?: unknown;
        instanceName?: unknown;
      };
      if (typeof h.session !== "string" || h.session === "") return null;
      if (typeof h.messageId !== "string" || h.messageId === "") return null;
      return {
        session: h.session,
        messageId: h.messageId,
        instanceName:
          typeof h.instanceName === "string" ? h.instanceName : null,
      };
    })(),
    text: obj.text,
    clientMessageId: obj.clientMessageId,
    messageId: typeof obj.messageId === "string" ? obj.messageId : null,
    providerResetCount:
      typeof obj.providerResetCount === "number"
        ? obj.providerResetCount
        : null,
    outboxId: typeof obj.outboxId === "string" ? obj.outboxId : null,
    dispatchAgeMs:
      typeof obj.dispatchAgeMs === "number" &&
      Number.isFinite(obj.dispatchAgeMs) &&
      obj.dispatchAgeMs >= 0
        ? obj.dispatchAgeMs
        : 0,
    switchedFromAgentId:
      typeof obj.switchedFromAgentId === "string"
        ? obj.switchedFromAgentId
        : null,
    switchedFromInstanceName:
      typeof obj.switchedFromInstanceName === "string"
        ? obj.switchedFromInstanceName
        : null,
    sessionSettings,
    attachments: obj.attachments,
    referenceAttachments: parseReferenceAttachments(obj.referenceAttachments),
    // Defensive parse: a bad/absent config yields null → env defaults; a malformed
    // field is dropped, never fails the send (parseInboundConfig never throws).
    config: parseInboundConfig(obj.config),
  };
}

/** Defensive parse of the optional `referenceAttachments` array (Phase 3). A
 *  malformed entry is dropped; a non-array yields []. Never throws. */
export function parseReferenceAttachments(raw: unknown): InboundReference[] {
  if (!Array.isArray(raw)) return [];
  const out: InboundReference[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.url !== "string" || o.url.length === 0) continue;
    out.push({
      url: o.url,
      mimeType:
        typeof o.mimeType === "string" && o.mimeType.length > 0
          ? o.mimeType
          : "application/octet-stream",
      fileName:
        typeof o.fileName === "string" && o.fileName.length > 0
          ? o.fileName
          : "file",
    });
  }
  return out;
}

/** The tasks-probe projection of ONE gateway task, as a pure (testable) function.
 *
 *  WHERE A RUNNING TASK IS. `terminalSummary` only exists once the task is over, so
 *  while the user waits — the one moment he is actually asking — Atrium had nothing
 *  to say and showed a bare spinner. A user watching a multi-hour job asked three
 *  times "où ça en est ?" and got silence (production report, 2026-07-30).
 *  `progressSummary` fills that window. Same 600-char cap as the terminal summary:
 *  this is model-authored prose reaching chat chrome, and one cap is easier to trust
 *  than two. Extracted from the probe's connection closure so the projection — the
 *  bridge hop of this field's chain — is testable without a gateway.
 */
export function projectTaskProbe(task: Record<string, unknown> | undefined): {
  status: string | null;
  summary: string | null;
  progressSummary: string | null;
  error: string | null;
} {
  return {
    status: typeof task?.status === "string" ? task.status.slice(0, 40) : null,
    summary:
      typeof task?.terminalSummary === "string"
        ? task.terminalSummary.slice(0, 600)
        : null,
    progressSummary:
      typeof task?.progressSummary === "string"
        ? task.progressSummary.slice(0, 600)
        : null,
    error: typeof task?.error === "string" ? task.error.slice(0, 400) : null,
  };
}

/**
 * Whether to re-hydrate prior turns onto a chat.send, as a pure (testable)
 * decision. Off entirely under `OPENCLAW_REHYDRATION=off`; otherwise needed only on
 * a fresh/rolled session, and only SAFE without an attachment:
 *   - `skip_disabled`   — operator kill-switch (no re-hydration, so no crash risk).
 *   - `skip_warm`       — warm session already holds the context.
 *   - `skip_attachment` — fresh session but the turn carries an attachment:
 *     prepended-history + attachment stack-overflows the gateway (live-confirmed),
 *     so we ship the bare message. KNOWN GAP: that turn (and that chat, until the
 *     session next rolls) lacks pre-attachment context — accepted, best-effort, and
 *     strictly better than crashing. No cross-turn debt state (it duplicates already
 *     -warmed turns and dies on a bridge restart for marginal value — see history).
 *   - `rehydrate`       — fresh, attachment-free, enabled.
 */
export type RehydrationDecision =
  | "rehydrate"
  | "skip_attachment"
  | "skip_disabled"
  | "skip_warm"
  /** The session is already too full to take an injection (G-10). */
  | "skip_full";
export function rehydrationDecision(opts: {
  freshSession: boolean;
  hasAttachments: boolean;
  enabled: boolean;
  /** LIVE fill of the session, 0..1+, or null when unknown. Beyond
   *  REHYDRATION_MAX_FILL the injection is REFUSED: the gateway already holds
   *  this history, so adding it is the one action guaranteed to make an
   *  almost-full session worse. `null` never refuses — a guard must not cost a
   *  turn on an absent measure (P6). */
  fill?: number | null;
}): RehydrationDecision {
  if (!opts.enabled) return "skip_disabled";
  if (!opts.freshSession) return "skip_warm";
  if (opts.hasAttachments) return "skip_attachment"; // can't prepend history here
  if (
    opts.fill != null &&
    Number.isFinite(opts.fill) &&
    opts.fill > REHYDRATION_MAX_FILL
  ) {
    return "skip_full";
  }
  return "rehydrate";
}

/**
 * Is this turn's gateway session "fresh" for re-hydration? TWO independent signals,
 * either suffices:
 *   (1) `sess` absent, OR `sess.systemSent === false` — a RESET/rolled gateway
 *       session (daily/idle reset, redeploy). The original single-agent trigger.
 *   (2) `firstSendPending && routedSwitch` — this bridge has NEVER run a turn on this
 *       sessionKey AND Convex marked the turn a per-turn ROUTED dispatch. An agent
 *       SWITCH re-keys the session (epoch segment + new agentId) → a NEW Session
 *       (firstSendPending), and the per-turn router sets `config.routedSwitch:true` —
 *       so together they catch "a freshly-routed agent."
 * (1) ALONE misses the multi-agent switch: empirically the gateway returns a session
 * row for the freshly-patched key whose `systemSent` is NOT false, so a freshly-routed
 * agent looks "warm" and skips re-hydration → the new agent answers with NO
 * conversation context (live-reproduced: confirmed `skip_warm` on a novel cross-agent
 * key). `routedSwitch` is a DISTINCT signal from the generic `rehydration` enable knob
 * (codex P2): an instance whose admin config sets `rehydration:true` does NOT thereby
 * make an ordinary single-agent send fresh-on-restart — only an actual per-turn routed
 * dispatch sets `routedSwitch`. So a plain BRIDGE RESTART of a single-agent chat keeps
 * its still-warm gateway session (no redundant re-prepend). A warm SAME-agent follow-up
 * keeps its key → the Session is REUSED → firstSendPending already false → no re-prepend.
 * Pure + exported for the locking test (the freshness rule is the bug surface, not
 * `rehydrationDecision`).
 */
export function computeFreshSession(
  sess: { systemSent?: unknown } | undefined,
  firstSendPending: boolean,
  routedSwitch: boolean,
): boolean {
  return (
    !sess || sess.systemSent === false || (firstSendPending && routedSwitch)
  );
}

/** Defensive parse of the session-reset body. Exported for tests. */
export function parseResetBody(raw: string): ResetBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.chatId !== "string") return null;
  const routing = parseBodyRouting(obj);
  if (routing === null) return null;
  return {
    ...routing,
    chatId: obj.chatId,
    openclawChatId:
      typeof obj.openclawChatId === "string" ? obj.openclawChatId : null,
    refuseIfActive: obj.refuseIfActive === true,
  };
}

/**
 * Defensive parse of the (optional) per-chat knob intent. Returns `null` for
 * "no intent" (absent/shapeless/empty), the literal string `"invalid"` when
 * `clears` is malformed or contains an entry outside CLEARABLE_FIELDS — the
 * caller must reject the WHOLE body (400) rather than silently dropping an
 * unset. Exported for tests.
 */
export function parseSessionSettings(
  raw: unknown,
): SessionSettings | null | "invalid" {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const clears = parseClears(o.clears);
  if (clears === null) return "invalid";
  const settings: SessionSettings = {
    thinkingLevel: str(o.thinkingLevel),
    model: str(o.model),
  };
  // fastMode: only a real boolean is an intent (false included) — anything
  // else means "no intent" and the key stays absent.
  if (typeof o.fastMode === "boolean") settings.fastMode = o.fastMode;
  // clears ride in the intent (P2-4); an empty list is the same as absent.
  if (clears.length > 0) settings.clears = clears;
  return settings.thinkingLevel ||
    settings.model ||
    settings.fastMode !== undefined ||
    settings.clears !== undefined
    ? settings
    : null;
}

/**
 * Validate an optional `clears` field against the STRICT allowlist. Returns
 * the (possibly empty) list, or null when the field is malformed or contains
 * ANY entry outside CLEARABLE_FIELDS (reject the whole body — 400).
 */
function parseClears(raw: unknown): ClearableField[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (
      typeof entry !== "string" ||
      !(CLEARABLE_FIELDS as readonly string[]).includes(entry)
    ) {
      return null;
    }
  }
  return raw as ClearableField[];
}

/**
 * Defensive parse of the immediate write-back body. The knob intent (sets +
 * clears) rides COMPLETE under `sessionSettings` — the same nested shape the
 * `/send` body carries (one source of truth, P2-4); flat knob fields and a
 * top-level `clears` are no longer part of the contract. Exported for tests.
 */
export function parsePatchBody(raw: string): PatchBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.chatId !== "string") return null;
  const sessionSettings = parseSessionSettings(obj.sessionSettings);
  // Malformed clears (allowlist violation) OR no intent at all (at least one
  // knob or one clear must be present) -> nothing to patch -> 400.
  if (sessionSettings === "invalid" || sessionSettings === null) return null;
  const routing = parseBodyRouting(obj);
  if (routing === null) return null;
  return {
    ...routing,
    chatId: obj.chatId,
    openclawChatId:
      typeof obj.openclawChatId === "string" ? obj.openclawChatId : null,
    sessionSettings,
  };
}

function extractRunId(response: {
  payload?: Record<string, unknown>;
  runId?: unknown;
}): string | null {
  const payload = response.payload;
  if (payload && typeof payload.runId === "string" && payload.runId) {
    return payload.runId;
  }
  if (typeof response.runId === "string" && response.runId) {
    return response.runId;
  }
  return null;
}

/**
 * Perform the send against OpenClaw and begin the assistant turn.
 *
 * Mirrors backend/app/main.py `_send_chat_message` + `_handle_send`:
 * verboseLevel=full once per connection, then chat.send, then note_run_started.
 */
/**
 * Extract the header-strip session meta from a `sessions.describe` session row.
 * Defensive about shapes (agentRuntime may be a string or `{id}`; thinkingLevels
 * may be strings or `{id,label}`; fresh sessions omit token counts). The
 * "reasoning level" shown is the per-session OVERRIDE if set, else the agent
 * default (so the chip's "inherited" badge is correct). Non-secret labels only.
 */
function parseSessionMeta(
  sess: Record<string, unknown>,
  availableModels?: { id: string; label: string }[],
): SessionMetaReport {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined;

  const runtime = sess.agentRuntime;
  const agentRuntime =
    typeof runtime === "string"
      ? runtime
      : str((runtime as { id?: unknown } | null)?.id);

  let thinkingLevels: { id: string; label: string }[] | undefined;
  if (Array.isArray(sess.thinkingLevels)) {
    thinkingLevels = sess.thinkingLevels
      .map((t): { id: string; label: string } => {
        if (typeof t === "string") return { id: t, label: t };
        const o = t as { id?: unknown; label?: unknown };
        const id = typeof o?.id === "string" ? o.id : "";
        const label = typeof o?.label === "string" ? o.label : id;
        return { id, label };
      })
      .filter((t) => t.id.length > 0);
  }

  const thinkingDefault = str(sess.thinkingDefault);
  return {
    model: str(sess.model),
    modelProvider: str(sess.modelProvider),
    agentRuntime,
    // Effective reasoning level: per-session override, else the agent default.
    thinkingLevel: str(sess.thinkingLevel) ?? thinkingDefault,
    thinkingDefault,
    thinkingLevels,
    availableModels:
      availableModels && availableModels.length > 0
        ? availableModels
        : undefined,
    verboseLevel: str(sess.verboseLevel),
    totalTokens: num(sess.totalTokens),
    contextTokens: num(sess.contextTokens),
    estimatedCostUsd: num(sess.estimatedCostUsd),
    // FRESHNESS of the counter above. The gateway sets it false when the number
    // is stale; it uses the flag itself to leave its own reading UNKNOWN instead
    // of showing a frozen figure. We were dropping it and displaying the stale
    // number as a live fill.
    totalTokensFresh:
      typeof sess.totalTokensFresh === "boolean"
        ? sess.totalTokensFresh
        : undefined,
    // The gateway's OWN pre-prompt budget assessment — the numbers it uses for
    // its own display, and the only ones that account for what the counters
    // miss (tool schemas, injected context). It rides `sessions.describe`, which
    // the bridge ALREADY calls before every send, so reading it costs nothing.
    // Content-free by construction: three token counts.
    // The SAME selection the guard makes. Projecting only the nested shape here
    // let the header say 0 % `budget_estimate` while the guard was compacting or
    // withholding the send on a flat 117 % — the two consumers of one describe,
    // disagreeing again, which is the whole defect of this lot.
    ...selectBudgetAssessment(sess, num(sess.contextTokens) ?? null),
  };
}

/**
 * Project the gateway's `contextBudgetStatus` down to the three counts the gauge
 * needs. Absent (or not an object) when its pre-prompt check did not run — under
 * a context engine that owns compaction it is never written, and it is cleared
 * after a compaction or a model change. That absence is INFORMATION: it is
 * exactly when the gauge must say "unknown" instead of showing a counter.
 */
function contextBudgetFields(raw: unknown): {
  estimatedPromptTokens?: number;
  promptBudgetBeforeReserve?: number;
  overflowTokens?: number;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const n = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const estimatedPromptTokens = n(o.estimatedPromptTokens);
  const promptBudgetBeforeReserve = n(o.promptBudgetBeforeReserve);
  const overflowTokens = n(o.overflowTokens);
  return {
    ...(estimatedPromptTokens !== undefined ? { estimatedPromptTokens } : {}),
    ...(promptBudgetBeforeReserve !== undefined
      ? { promptBudgetBeforeReserve }
      : {}),
    ...(overflowTokens !== undefined ? { overflowTokens } : {}),
  };
}

/**
 * THE budget assessment for one session row: both shapes read, the MOST ALARMING
 * one returned whole.
 *
 * `contextBudgetStatus` is contractual in no pinned version, so the repo learned
 * its shape twice from observation — nested here, flat on the row — and a partial
 * or transitional response can carry both. Two rules, and they are the same rule:
 *
 *  - a RATIO is never crossed: each shape is scored with its own denominator and
 *    the higher fill wins, so a zero in one shape cannot silence a 117 % in the
 *    other;
 *  - an OVERFLOW verdict is positive wherever it appears, so the largest wins.
 *
 * ONE selection, for all three consumers — the pre-send guard, the pressure trace
 * and the header gauge. They used to project the describe separately, which is how
 * the guard and the gauge came to read different shapes of the same figure without
 * anyone noticing (live prod 2026-08-05).
 */
function selectBudgetAssessment(
  row: unknown,
  contextTokens: number | null,
): {
  estimatedPromptTokens?: number;
  promptBudgetBeforeReserve?: number;
  overflowTokens?: number;
} {
  // Named `o`, like the projector's own parameter, so the declaration gate's sweep
  // sees this read too (describe-field-declaration.test.ts). A cast inline in the
  // argument list hid `contextBudgetStatus` from it the moment this helper was
  // extracted — the gate caught that, which is the point of it.
  const o: Record<string, unknown> =
    typeof row === "object" && row !== null
      ? (row as Record<string, unknown>)
      : {};
  const nested = contextBudgetFields(o.contextBudgetStatus);
  const flat = contextBudgetFields(o);
  // ONE validity predicate, used both to score a shape and to decide whether an
  // estimate was found at all. Split in two, they diverged: a NEGATIVE estimate
  // counted as "present" here, selected its shape, and was then rejected
  // downstream by sessionFillDetail — leaving the counter divided by that shape's
  // budget instead of the smallest one, and turning a 90 % session into 29 %.
  // A non-contractual field can carry a sentinel; only a usable figure counts.
  const usableEstimate = (b: { estimatedPromptTokens?: number }): boolean =>
    b.estimatedPromptTokens !== undefined && b.estimatedPromptTokens >= 0;
  const scored = [nested, flat]
    .filter(usableEstimate)
    .map((b) => ({
      b,
      fill:
        sessionFillDetail({
          estimatedPromptTokens: b.estimatedPromptTokens,
          promptBudgetBeforeReserve: b.promptBudgetBeforeReserve,
          contextTokens,
        }).fill ?? -1,
    }));
  const ratio =
    scored.length > 0
      ? scored.reduce((a, c) => (c.fill > a.fill ? c : a)).b
      : {};
  const overflows = [nested.overflowTokens, flat.overflowTokens].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  // With NO estimate anywhere the fill comes from the counter, and the budget is
  // only its denominator. Preferring one shape here made the guard OPTIMISTIC by
  // luck: a nested 308 000 beside a flat 100 000 turns a 90 % fill into 29 % and
  // sends. A smaller denominator is the more alarming reading, so take the
  // smallest positive budget — the same rule as the ratio above and the overflow
  // below: never end up more optimistic than a figure we were handed.
  const budgets = [
    nested.promptBudgetBeforeReserve,
    flat.promptBudgetBeforeReserve,
  ].filter((v): v is number => typeof v === "number" && v > 0);
  const budget =
    usableEstimate(ratio)
      ? ratio.promptBudgetBeforeReserve
      : budgets.length > 0
        ? Math.min(...budgets)
        : undefined;
  return {
    ...(usableEstimate(ratio)
      ? { estimatedPromptTokens: ratio.estimatedPromptTokens }
      : {}),
    ...(budget !== undefined ? { promptBudgetBeforeReserve: budget } : {}),
    ...(overflows.length > 0
      ? { overflowTokens: Math.max(...overflows) }
      : {}),
  };
}

/**
 * Fetch `models.list` ONCE per connection (cached on `conn.availableModels`) and
 * return the deduped {id,label} list for the header's model picker. The gateway
 * may list the same id under several providers (e.g. gpt-5.5 under openai AND
 * openai-codex) — we dedupe by id (first label wins). Non-fatal: any failure
 * caches `[]` so we do not retry every turn.
 */
/**
 * Dedupe a raw `models.list` payload into {id,label}. The gateway may list the
 * same id under several providers (e.g. gpt-5.5 under openai AND openai-codex);
 * we keep the first occurrence (its name wins). Empty/invalid ids are dropped.
 * Pure (no I/O) so it is unit-testable. Exported for tests.
 */
export function dedupeModels(list: unknown): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  if (Array.isArray(list)) {
    for (const m of list) {
      const o = m as { id?: unknown; name?: unknown; available?: unknown };
      const id = typeof o?.id === "string" ? o.id : "";
      if (!id || seen.has(id)) continue;
      // A model the gateway declares UNAVAILABLE is not offered.
      //
      // `available` was dropped here, so the knob row rendered every returned model
      // and picking an unavailable one patched the session to something that cannot
      // run — the person found out from a failed turn instead of an absent option.
      //
      // `=== false` and not `!== true` on purpose: the field is OPTIONAL upstream, so
      // a gateway that omits it (or an older one that never had it) must keep offering
      // its models. A guard must never cost a choice that would have worked.
      if (o?.available === false) continue;
      seen.add(id);
      const label =
        typeof o?.name === "string" && o.name.length > 0 ? o.name : id;
      out.push({ id, label });
    }
  }
  return out;
}

export async function ensureAvailableModels(
  conn: BridgeSession["connection"],
): Promise<{ id: string; label: string }[]> {
  if (conn.availableModels !== null) return conn.availableModels;
  try {
    const resp = await conn.request("models.list", {}, 8_000);
    const list = (resp.payload as { models?: unknown } | undefined)?.models;
    conn.availableModels = dedupeModels(list);
  } catch (err) {
    console.error(
      "[models.list] skipped (non-fatal):",
      (err as Error)?.message ?? err,
    );
    conn.availableModels = [];
  }
  return conn.availableModels;
}

/**
 * Apply the user's per-chat knob intent to the gateway via `sessions.patch`.
 * Idempotent (patching to the current value is a no-op server-side). Used by BOTH
 * the immediate write-back (`/patch`) and the per-turn re-apply in `performSend`
 * (so a reset/rolled session keeps the user's reasoning/model — AND its unsets:
 * `settings.clears` is applied here too, so an unset lost to a bridge outage is
 * repaired on the next turn, P2-4). Non-fatal: a patch failure is logged and the
 * turn proceeds with whatever the session already had. Exported for tests.
 */
export async function applySessionSettings(
  conn: GatewayRequester,
  sessionKey: string,
  settings: SessionSettings | null,
): Promise<void> {
  if (!settings) return;
  try {
    // UNSETS first: `{<field>: null}` removes the stored override (verified
    // 6.5); clearing an already-cleared field is an idempotent no-op.
    for (const field of settings.clears ?? []) {
      await conn.request(
        "sessions.patch",
        { key: sessionKey, [field]: null },
        10_000,
      );
    }
    if (settings.thinkingLevel) {
      await conn.request(
        "sessions.patch",
        { key: sessionKey, thinkingLevel: settings.thinkingLevel },
        10_000,
      );
    }
    if (settings.model) {
      await conn.request(
        "sessions.patch",
        { key: sessionKey, model: settings.model },
        10_000,
      );
    }
    // fastMode: `false` is a real value to apply — presence check MUST be
    // `!== undefined` (a falsy check would silently drop "Standard speed").
    if (settings.fastMode !== undefined) {
      await conn.request(
        "sessions.patch",
        { key: sessionKey, fastMode: settings.fastMode },
        10_000,
      );
    }
  } catch (err) {
    console.error(
      "[sessionSettings] patch skipped (non-fatal):",
      (err as Error)?.message ?? err,
    );
  }
}

/**
 * `/patch` worker: UNSET the cleared overrides FIRST (`sessions.patch
 * {<field>: null}` — verified 6.5: null removes the override from the session
 * store), then apply the remaining knob intent. A failed CLEAR throws (the
 * route maps it to 502) so the user sees the unset did not land NOW; the app
 * keeps the field in the persisted `sessionSettings.clears` regardless, so the
 * per-turn re-apply (applySessionSettings in performSend) repairs it on a later
 * turn anyway (P2-4). Exported for tests.
 */
export async function applyPatchIntent(
  conn: GatewayRequester,
  sessionKey: string,
  settings: SessionSettings,
): Promise<void> {
  for (const field of settings.clears ?? []) {
    await conn.request(
      "sessions.patch",
      { key: sessionKey, [field]: null },
      10_000,
    );
  }
  // Remaining sets stay non-fatal (UI-3 contract). `clears` is stripped: it was
  // just applied strictly above; applySessionSettings must not re-send it.
  await applySessionSettings(conn, sessionKey, {
    ...settings,
    clears: undefined,
  });
}

/**
 * The `chat.send` body for a SUB-AGENT interaction (`/subagent-send`).
 *
 * A pure builder, EXPORTED, for one reason: the outbound ratchet validates every body
 * the bridge sends against the vendored gateway schemas, and a body built inline in an
 * HTTP handler cannot be reached by a test. Review found that the inventory of call
 * sites pinned their COUNT and not their CONTENT — a field added here would have
 * sailed past while breaking every sub-agent send on an older gateway.
 */
export function subAgentSendParams(
  childSessionKey: string,
  message: string,
  interactionId: string,
  /** Inline base64 attachments, when the interaction carries any. Part of the BUILDER
   *  rather than assigned afterwards (raised in review): appended outside, the
   *  attachment-bearing shape of this body was never validated against the vendored
   *  schemas, even though `performSend`'s equivalent branch was. The caller still owns
   *  the frame guard — it can refuse the request before building anything. */
  attachments?: unknown,
): Record<string, unknown> {
  return {
    sessionKey: childSessionKey,
    message,
    // Stable per interaction so a dispatch retry dedupes at the gateway.
    idempotencyKey: `interaction-${interactionId}`,
    ...(Array.isArray(attachments) && attachments.length > 0
      ? { attachments }
      : {}),
  };
}

/**
 * The `chat.send` body for a lossless-claw command (`/lossless`). Pure and exported
 * for the same reason as `subAgentSendParams`. `now` is a parameter so the body is
 * deterministic under test.
 */
export function lcmSendParams(
  sessionKey: string,
  command: string,
  now: number,
): Record<string, unknown> {
  return { sessionKey, message: command, idempotencyKey: `lcm-${now}` };
}

/**
 * EXPORTED for the pre-send confinement tests (W2). Four lots in a row shipped a
 * hardening with no failing test because nothing in the suite could answer the
 * gateway's RPCs; the guard here DECIDES THE FATE OF A SEND from a
 * `sessions.describe` answer, and "a successful compaction lets the send through"
 * is only expressible against the real send path.
 */
export async function performSend(
  session: BridgeSession,
  body: SendBody,
  writer: ConvexWriter,
  inbound: InboundMediaConfig | null,
  // Outbound media dir for the delivery instruction (how the agent makes a
  // generated file downloadable: write it here + emit `MEDIA:<path>`). Null when
  // outbound media is disabled (mode "off") — then no instruction is injected.
  deliveryDir: string | null,
  /** When the /send HTTP handler received the request (its own entry, NOT this
   *  call): the pre-send deadline is measured from there so time lost acquiring
   *  the session counts too. */
  sendReceivedMs: number = Date.now(),
): Promise<void> {
  const conn = session.connection;
  const sessionKey = session.sessionKey;
  if (!conn.verboseFullApplied) {
    await conn.request(
      "sessions.patch",
      { key: sessionKey, verboseLevel: "full" },
      10_000,
    );
    conn.verboseFullApplied = true;
  }

  // RE-APPLY the user's per-chat knob intent (reasoning/model) BEFORE the describe
  // below, so a reset/rolled session keeps the user's choice AND the meta we mirror
  // reflects it within THIS turn (not the next). Idempotent + non-fatal.
  await applySessionSettings(conn, sessionKey, body.sessionSettings);

  // SESSION RE-HYDRATION (docs/SESSION_CONTINUITY_DESIGN.md). OpenClaw sessions are
  // ephemeral (daily/idle reset, pruning); our webchat displays the FULL thread.
  // If the gateway session is FRESH/rolled (no session row, or `systemSent` is
  // false — verified: it flips true after the first turn, false on reset) it no
  // longer holds the conversation the user still sees. Detect that and PREPEND our
  // stored prior turns so the model's context matches the display. The visible
  // message in Convex stays `body.text` (we only enrich what the gateway sees), so
  // re-hydration never leaks into the UI. NON-FATAL: any failure falls back to the
  // bare message — re-hydration must never break a send.
  // A turn carrying an attachment must NOT be re-hydrated: the OpenClaw gateway
  // stack-overflows (RangeError) assembling a prepended-history message TOGETHER
  // with an attachment — confirmed live in prod (re-hydration alone OK, attachment
  // alone OK, the COMBINATION crashes -> INVALID_REQUEST). The attachment turn is
  // self-contained anyway ("convert this file"). `OPENCLAW_REHYDRATION=off` is a
  // kill-switch to disable re-hydration entirely without a redeploy.
  // D-D two-axis: ONLY inline base64 attachments trip the frame guard + the
  // rehydration crash-guard. Reference (shared-fs) files carry no base64 and ride
  // as injected PATH text, so they must NOT count here.
  const hasInlineAttachments =
    Array.isArray(body.attachments) && body.attachments.length > 0;
  // Per-instance `rehydration` (in-band, hot) wins; absent (old Convex / no config)
  // → the OPENCLAW_REHYDRATION env kill-switch. Either source can disable it.
  const rehydrationEnabled =
    body.config?.rehydration ?? process.env.OPENCLAW_REHYDRATION !== "off";
  let message = body.text;
  // Pre-send session snapshot for the turn's context-pressure signal (Inc 2) and
  // the compaction-by-rotation detector (Inc 1): the describe below is ALREADY
  // made every turn — capturing these three fields adds zero gateway calls.
  let preSendSessionId: string | null = null;
  let preTurnTotalTokens: number | null = null;
  let preTurnContextTokens: number | null = null;
  let preTurnCostUsd: number | null = null;
  // The gateway's OWN pre-prompt assessment (W2): the only figures that account
  // for what the counters miss (tool schemas, injected context), and the ones the
  // pre-send guard measures against. Absent when its pre-prompt check did not run
  // (notably under a context engine that owns compaction) — then the fill is
  // UNKNOWN and every guard built on it falls open.
  let preTurnEstimatedPromptTokens: number | null = null;
  let preTurnPromptBudget: number | null = null;
  let preTurnOverflowTokens: number | null = null;
  let preTurnTotalTokensFresh: boolean | null = null;
  // WHICH MODEL the window belongs to. Three are in play on a single instance —
  // a primary, a fallback, and a distinct sub-agent model — and their windows
  // differ. A `contextTokens` recorded without its model cannot be interpreted at
  // all: reading 372000 on some turns and 272000 on others of the same chat looks
  // like a contradiction until you know they were different models (prod
  // 2026-08-08, diagnosing a mid-turn overflow). Declared upstream, so this is
  // not a new undeclared dependency.
  let preTurnModel: string | null = null;
  // Whether THIS send prepended rehydration history (function-scope: read by
  // the post-ack beginTurn in the LATER try block for the processing_history phase).
  let turnWasRehydrated = false;
  // The instant the session boundary is observed: captured BEFORE the describe,
  // so a FRESH-session clear can never be dated after the snapshot that describes
  // the NEW session (codex P2). Dated later, the clear would either wipe that
  // snapshot or make the fence reject it, and the fresh session would show no
  // gauge and no cost for a whole turn.
  // `- 1` so the boundary is strictly BEFORE the describe even when both land in
  // the same millisecond: the fence and the keep-rule both compare on equality,
  // and a tie would classify the new session's own snapshot as pre-reset.
  const sessionObservedAt = Date.now() - 1;
  // Stamped when THIS describe's answer is in hand, strictly after the boundary
  // above so the fresh session's own snapshot is never classified as pre-reset.
  let describeObservedAt = sessionObservedAt + 1;
  // Pre-send guard outcome (W2). Set inside the try below — whose catch makes EVERY
  // failure fall open — and acted upon after it. `blocked` is the only value that
  // stops a send, and nothing but an explicit, positive measurement can set it.
  let presend: PresendReport = {
    action: "send",
    fillPct: null,
    fillSource: null,
    compactOutcome: "not_needed",
    blocked: false,
  };
  try {
    const desc = await conn.request(
      "sessions.describe",
      { key: sessionKey },
      8_000,
    );
    describeObservedAt = Date.now();
    let sess = (
      desc.payload as { session?: Record<string, unknown> } | undefined
    )?.session;
    // Capture the pre-turn figures from a describe answer. A FUNCTION because the
    // pre-send guard can compact and RE-describe: the rehydration decision and the
    // mirrored meter must then read the POST-compaction session, not the one we
    // measured before shrinking it.
    const captureDescribe = (s: Record<string, unknown>): void => {
      preSendSessionId =
        typeof s.sessionId === "string" && s.sessionId ? s.sessionId : null;
      preTurnTotalTokens =
        typeof s.totalTokens === "number" && Number.isFinite(s.totalTokens)
          ? s.totalTokens
          : null;
      preTurnContextTokens =
        typeof s.contextTokens === "number" && Number.isFinite(s.contextTokens)
          ? s.contextTokens
          : null;
      // Session-cumulative cost from the SAME describe (the gateway never
      // emits `usage` on chat events — live capture 2026-07-03 — so this is
      // the real per-turn cost source: consecutive traces' deltas).
      preTurnCostUsd =
        typeof s.estimatedCostUsd === "number" &&
        Number.isFinite(s.estimatedCostUsd)
          ? s.estimatedCostUsd
          : null;
      const num = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      // ONE selection, shared with the gauge and the pressure trace (see
      // selectBudgetAssessment): both shapes read, the most alarming one kept.
      const budget = selectBudgetAssessment(s, preTurnContextTokens);
      preTurnEstimatedPromptTokens = budget.estimatedPromptTokens ?? null;
      preTurnPromptBudget = budget.promptBudgetBeforeReserve ?? null;
      preTurnOverflowTokens = budget.overflowTokens ?? null;
      preTurnTotalTokensFresh =
        typeof s.totalTokensFresh === "boolean" ? s.totalTokensFresh : null;
      preTurnModel = typeof s.model === "string" && s.model ? s.model : null;
    };
    if (sess) captureDescribe(sess);

    // ── PRE-SEND GUARD (W2 / G-04, G-06) ─────────────────────────────────────
    // Four times in three days in production, a turn was spent, the user waited,
    // and the answer was a hard `context_length`. The figures that would have said
    // so were already on this describe. Graduated: inform, then compact
    // pre-emptively, then — past 95 % — compact and, if the compaction did not
    // happen, withhold the send rather than buy a failure.
    {
      const fill0 = sessionFillDetail({
        estimatedPromptTokens: preTurnEstimatedPromptTokens,
        promptBudgetBeforeReserve: preTurnPromptBudget,
        totalTokens: preTurnTotalTokens,
        contextTokens: preTurnContextTokens,
        totalTokensFresh: preTurnTotalTokensFresh,
      });
      const action = presendAction({
        fill: fill0.fill,
        overflowTokens: preTurnOverflowTokens,
        alreadyCompacted: false,
      });
      presend = {
        action,
        fillPct: fill0.fill === null ? null : Math.round(fill0.fill * 100),
        fillSource: fill0.source,
        compactOutcome: "not_needed",
        blocked: false,
      };
      // A compaction INTERRUPTS an active run (the gateway's own handler calls
      // interruptSessionRunIfActive). A delivery/announce run can be live on this
      // session even though Convex considers the chat idle — compacting under it
      // would destroy a reply the user is owed. Busy ⇒ do nothing, send as before.
      const busy =
        session.runManager.turnActive || session.runManager.dispatchInFlight;
      // What is LEFT of this dispatch's pre-send deadline. Measured, not assumed:
      // Convex tells us how long the row was already pending, and everything above
      // (patch, describe, rehydration reads) has already spent some of it.
      const compactMs = compactBudget(
        PRE_SEND_DEADLINE_MS - (body.dispatchAgeMs + (Date.now() - sendReceivedMs)),
      );
      // A compaction ALREADY known not to work on THIS gateway session (a
      // structural refusal remembered from an earlier turn): skip the call. Waiting
      // 60 s per send for the same answer is the kind of thing that makes a product
      // feel broken; the user gets the named cause and the two wired actions now.
      const knownRefusal =
        preSendSessionId !== null &&
        session.presendCompactRefusedFor === preSendSessionId;
      if (requiresCompaction(action) && busy) {
        presend.compactOutcome = "skipped_busy";
        console.error(
          `[presend] chat=${body.chatId} ${action} SKIPPED — a run is active on this session`,
        );
      } else if (requiresCompaction(action) && knownRefusal) {
        // BEFORE the budget check: a refusal we have already observed is knowledge,
        // and acting on it immediately is both faster and more accurate than
        // discovering there is no time to re-ask.
        presend.compactOutcome = "skipped_known_refusal";
        // Same verdict as a fresh refusal, and ordered BEFORE the budget check on
        // purpose: this session's harness cannot compact at all, so the remedy is
        // not "unattempted for lack of time" — it is unavailable, whatever time
        // remains. Blocking here also gives the user a named card with two working
        // exits, where letting the send run out the deadline gives them a generic
        // "dispatch deadline exceeded".
        presend.blocked = !sendAfterCompaction({
          action,
          compacted: false,
          attemptFailed: false,
        });
      } else if (requiresCompaction(action) && compactMs === null) {
        // Not enough of the dispatch deadline left to run a summarization and still
        // send. The send goes out UNTOUCHED: a remedy we did not attempt is not
        // evidence the prompt does not fit, and losing a turn to our own guard is
        // the one failure this module exists to prevent.
        presend.compactOutcome = "skipped_no_budget";
        console.error(
          `[presend] chat=${body.chatId} ${action} SKIPPED — not enough dispatch budget left to compact`,
        );
      } else if (requiresCompaction(action) && compactMs !== null) {
        try {
          const r = await conn.request(
            "sessions.compact",
            { key: sessionKey },
            // CLAMPED to what the deadline still allows (never more than the
            // gateway-sized budget).
            compactMs,
          );
          const p = r.payload as
            | { compacted?: unknown; reason?: unknown }
            | undefined;
          // THREE outcomes, not two. `compacted:false` is an OBSERVED refusal and
          // may withhold the send; `compacted:true` is a shrink; anything else — a
          // truncated answer, an older gateway that does not report the field — is
          // UNKNOWN, and an unknown must never cost a turn (P6). Reading the
          // absence as a refusal is the same mistake the Convex side already
          // avoids in `compactSession`.
          presend.compactOutcome =
            p?.compacted === true
              ? "compacted"
              : p?.compacted === false
                ? "refused"
                : "unknown";
          // `reason` is FREE TEXT on the wire and this report rides a trace —
          // bucket it (SOC2: metadata only, never a gateway string).
          if (p?.compacted === false) {
            // `?? undefined`: an ABSENT reason must stay absent in the report, not
            // become a null that reads as "measured, and it was nothing".
            presend.compactReasonClass =
              bucketCompactionReason(
                typeof p?.reason === "string" ? p.reason : undefined,
              ) ?? undefined;
            // REMEMBER only a refusal that will hold next turn, and only against the
            // sessionId it was observed on: a reset or rollover mints a new session
            // that deserves its own attempt.
            if (
              preSendSessionId !== null &&
              isPermanentCompactionRefusal(presend.compactReasonClass ?? null)
            ) {
              session.presendCompactRefusedFor = preSendSessionId;
            }
          }
        } catch (e) {
          // The RPC threw (UNAVAILABLE "still active", a lifecycle change, a
          // timeout): we do NOT know the session did not shrink, so the send goes.
          presend.compactOutcome = "error";
          console.error(
            `[presend] chat=${body.chatId} compaction attempt failed (non-fatal):`,
            (e as Error)?.message ?? e,
          );
        }
        // Re-describe so everything downstream (rehydration, the header meter, the
        // pressure snapshot) reads the session as it is AFTER the compaction.
        if (presend.compactOutcome === "compacted") {
          // OUR compaction is about to rotate the session id, which is how the
          // normalizer detects a preflight compaction. Name its cause now, or the
          // marker would say a compaction happened and stay silent on why — and
          // `session.operation`, the only source that carries the gateway's own
          // reason, is unreachable from this connection (see session.ts).
          session.runManager.notePresendCompactionCause("pre_compaction");
          try {
            const d2 = await conn.request(
              "sessions.describe",
              { key: sessionKey },
              8_000,
            );
            const s2 = (
              d2.payload as { session?: Record<string, unknown> } | undefined
            )?.session;
            if (s2) {
              sess = s2;
              describeObservedAt = Date.now();
              captureDescribe(s2);
            }
          } catch (e) {
            console.error(
              `[presend] chat=${body.chatId} re-describe after compaction failed (non-fatal):`,
              (e as Error)?.message ?? e,
            );
          }
        }
        presend.blocked = !sendAfterCompaction({
          action,
          compacted: presend.compactOutcome === "compacted",
          // An UNKNOWN answer is treated exactly like a thrown RPC: we cannot say
          // the session did not shrink, so the send goes.
          attemptFailed:
            presend.compactOutcome === "error" ||
            presend.compactOutcome === "unknown",
          // "Already active" says a run or a compaction was live on this session —
          // the busy-check above can miss one that started during its own await.
          // Blocking on that would withhold a turn for a reason about to expire.
          transientRefusal: isTransientCompactionRefusal(
            presend.compactReasonClass ?? null,
          ),
        });
      }
      if (presend.action !== "send") {
        console.error(
          `[presend] chat=${body.chatId} action=${presend.action} fill=${presend.fillPct ?? "?"}% source=${presend.fillSource ?? "unknown"} overflow=${preTurnOverflowTokens ?? "none"} compaction=${presend.compactOutcome}${presend.compactReasonClass ? `/${presend.compactReasonClass}` : ""} blocked=${presend.blocked}`,
        );
      }
    }

    // (a) Mirror LIVE session meta onto the chat for the header strip (model +
    // reasoning chips + context meter). Fire-and-forget — never blocks/fails the
    // send. NOTE: this `describe` runs BEFORE the turn's reply, so the meter
    // reflects the session as of the LAST COMPLETED turn (a one-turn lag). A v2
    // could re-describe after finalize for during-turn accuracy.
    if (sess) {
      const models = await ensureAvailableModels(conn);
      void writer
        .reportSessionMeta(body.chatId, {
          ...parseSessionMeta(sess, models),
          // Stamped when the DESCRIBE was observed, not when its POST goes out
          // (codex P2): a describe of the OLD session already in flight when a
          // reset/rollover lands would otherwise look newer than the fence and
          // restore the estimate and budget that were just purged.
          observedAt: describeObservedAt,
        })
        .catch((e) =>
          console.error(
            "[sessionMeta] skipped (non-fatal):",
            (e as Error)?.message ?? e,
          ),
        );
    }

    // (b) Re-hydration on a fresh/rolled session (systemSent flips true after the
    // first turn, false on reset; absent session row -> also fresh). The decision is
    // a pure helper (tested).
    // FRESHNESS for re-hydration is TWO signals OR'd:
    //  (1) the gateway's `systemSent === false` — a RESET/rolled session (the
    //      original single-agent trigger: daily/idle reset re-grounds from our store);
    //  (2) `session.firstSendPending` — this bridge has NEVER run a turn on THIS
    //      sessionKey. An agent SWITCH re-keys the gateway session (epoch segment +
    //      new agentId) → acquire() builds a NEW Session → firstSendPending is true.
    // (1) ALONE is insufficient for a switch: the gateway creates a brand-new webchat
    // session with `systemSent` TRUTHY, so a freshly-routed agent's session is
    // misread as "warm" → rehydration is skipped and the new agent answers with ZERO
    // conversation context (the multi-agent context-carryover bug). A warm SAME-agent
    // follow-up keeps its key (segment unchanged) → acquire() REUSES the Session →
    // firstSendPending is already false → no wasteful re-prepend. Capture+clear here.
    // READ firstSendPending for the freshness decision but do NOT consume it yet
    // (codex P2.A): if THIS first send of a freshly-routed session FAILS before the
    // gateway accepts it (oversized attachment / chat.send reject-or-timeout / a
    // beginTurn relaunch), the SAME in-memory Session persists — the retry must still
    // see firstSendPending=true and re-hydrate. It is consumed only AFTER a successful
    // chat.send (below).
    const firstTurnOnSession = session.firstSendPending;
    // `routedSwitch` = Convex marked this a per-turn ROUTED dispatch (the multi-agent
    // path) — a DISTINCT signal from the generic `rehydration` enable knob (codex P2:
    // an admin `rehydration:true` instance must NOT make a NON-routed send's brand-new
    // session re-inject after a bridge restart). Gates the new-session freshness to the
    // multi-agent switch only (see computeFreshSession).
    const routedSwitch = body.config?.routedSwitch === true;
    const freshSession = computeFreshSession(
      sess,
      firstTurnOnSession,
      routedSwitch,
    );
    if (freshSession) {
      // A gateway session the bridge considers FRESH (a daily/idle rollover, a
      // redeploy, a per-turn agent switch) is a new session even though no user
      // reset it. The compaction VERDICT describes the OLD one and is preserved
      // across every meta refresh, so without this a failed compaction would go
      // on telling the user their brand-new session cannot answer (codex P2).
      // The WHOLE session-scoped context state, not just the verdict (codex P2):
      // when `sessions.describe` returned no session at all, nothing replaces the
      // old measures either, and an estimate that exceeded its budget would keep
      // warning about a session that no longer exists.
      void writer
        .clearSessionState?.(body.chatId, sessionObservedAt)
        .catch((e) =>
          console.error(
            "[rehydrate] session-state clear skipped (non-fatal):",
            (e as Error)?.message ?? e,
          ),
        );
    }
    // LIVE fill from the describe we just did (null when nothing trustworthy is
    // available — the guards below then fall open, P6).
    const liveFill = sess
      ? sessionFill({
          estimatedPromptTokens: preTurnEstimatedPromptTokens,
          promptBudgetBeforeReserve: preTurnPromptBudget,
          totalTokens: preTurnTotalTokens,
          contextTokens: preTurnContextTokens,
          totalTokensFresh: preTurnTotalTokensFresh,
        })
      : null;
    const decision = rehydrationDecision({
      freshSession,
      hasAttachments: hasInlineAttachments,
      enabled: rehydrationEnabled,
      fill: liveFill,
    });
    let prependedTurns = 0;
    let summaryUsed = false;
    let summaryChars = 0;
    if (decision === "skip_full") {
      // REFUSED, and said so: a chat that silently gets no context is
      // indistinguishable from a rehydration bug. Counts + chatId only (no PHI).
      console.error(
        `[rehydrate] chat=${body.chatId} SKIPPED — session already ${Math.round((liveFill ?? 0) * 100)}% full (>${Math.round(REHYDRATION_MAX_FILL * 100)}%); the gateway already holds this history`,
      );
    } else if (decision === "skip_attachment") {
      // Ship the bare message — prepending history to an attachment turn crashes the
      // gateway. KNOWN GAP (best-effort, strictly better than crashing): this chat
      // lacks pre-attachment context until the session next rolls. Counts/chatId
      // only (no PHI).
      console.error(
        `[rehydrate] chat=${body.chatId} SKIPPED — attachment present (gateway-crash guard)`,
      );
    } else if (decision === "rehydrate") {
      const ctx = await writer.getRehydrationContext(
        body.chatId,
        body.messageId,
      );
      // The COMPOSED prompt — history + separator + the user's own text — bounded
      // in TOKENS against the live window (G-10). The composer bounds the history
      // block alone, in characters, so a long message on top of a full-budget
      // history composed a prompt the session could not take. The SMALLEST window
      // decides: an agent switch can narrow the context under the history.
      const composedFits =
        !ctx.history ||
        composedPromptFits({
          historyChars: ctx.history.length,
          userChars: String(body.text ?? "").length,
          separatorChars: 2,
          windowTokens: preTurnContextTokens,
        });
      if (ctx.history && !composedFits) {
        console.error(
          `[rehydrate] chat=${body.chatId} SKIPPED — composed prompt exceeds the live window (history=${ctx.history.length}c + text=${String(body.text ?? "").length}c vs window=${preTurnContextTokens ?? "?"}tok)`,
        );
      }
      if (ctx.history && composedFits) {
        message = `${ctx.history}\n\n${body.text}`;
        prependedTurns = ctx.turnCount;
        // History was INJECTED (verbatim turns OR a summary-only rehydration
        // where turnCount is 0): the gateway will chew it silently either way,
        // so the processing_history phase applies to both (codex P3).
        turnWasRehydrated = true;
        summaryUsed = ctx.summaryUsed ?? false;
        summaryChars = ctx.summaryChars ?? 0;
        // Decision log (no PHI — counts + chatId only).
        console.error(
          `[rehydrate] chat=${body.chatId} fresh session -> prepended ${ctx.turnCount} prior turn(s)`,
        );
      }
    } else {
      // skip_warm / skip_disabled were SILENT — which is exactly why the multi-agent
      // "switched agent has no context" bug needed a live bench to diagnose. Log the
      // decision (content-free: chatId + decision + the freshness inputs) so a future
      // rehydration miss is visible in the bridge log without a repro. Loud ONLY when
      // rehydration was ENABLED (a routed/forced turn that still skipped is the signal);
      // a plain disabled-by-config turn stays quiet at debug level.
      const line = `[rehydrate] chat=${body.chatId} ${decision} (firstSend=${firstTurnOnSession} systemSent=${JSON.stringify((sess as { systemSent?: unknown } | undefined)?.systemSent)} enabled=${rehydrationEnabled})`;
      if (decision === "skip_warm" && rehydrationEnabled) console.error(line);
      else if (process.env.BRIDGE_DEBUG) console.error(line);
    }
    // Content-free reconstruction trace of the decision (keyed chatId:outboxId in
    // Convex) so the obs MCP can show WHY a (cross-agent) turn re-injected history or
    // not — no local repro needed next time. Fire-and-forget; routed agent NAMES only.
    writer.emitRehydrateTrace({
      chatId: body.chatId,
      outboxId: body.outboxId,
      decision,
      freshSession,
      routedSwitch,
      prependedTurns,
      routedAgentId: body.agentId,
      routedInstanceName: body.instanceName,
      switchedFromAgentId: body.switchedFromAgentId,
      switchedFromInstanceName: body.switchedFromInstanceName,
      ...(summaryUsed ? { summaryUsed, summaryChars } : {}),
      // Pre-send guard (W2): WHY this turn was informed / compacted / withheld.
      // Enums + one integer percent — the reason class is bucketed, never raw.
      presendAction: presend.action,
      presendFillPct: presend.fillPct,
      presendFillSource: presend.fillSource,
      presendCompaction: presend.compactOutcome,
      presendBlocked: presend.blocked,
      ...(presend.compactReasonClass !== undefined
        ? { presendCompactReasonClass: presend.compactReasonClass }
        : {}),
    });
  } catch (err) {
    console.error(
      "[rehydrate] skipped (non-fatal):",
      (err as Error)?.message ?? err,
    );
  }

  // The ONE outcome of the guard that stops a send. OUTSIDE the try above on
  // purpose: that catch makes every failure of the guard fall open, so a block can
  // only ever come from the explicit assignment above — never from a thrown
  // anything. The turn ends immediately as `context_length`, with no provider
  // spend, and its card carries the two wired actions (compact / branch).
  if (presend.blocked) {
    throw new ContextBlockedError(presend.fillPct);
  }

  // Shared-fs INBOUND (Phase 3): stream each tool-read reference to the shared
  // volume and APPEND a `[FICHIERS REÇUS]` block with the gateway-visible paths to
  // the message (the agent reads the files BY PATH). Best-effort: a per-file failure
  // drops only that file; staging NEVER blocks/fails the turn. Reference files do
  // NOT set hasInlineAttachments, so they bypass the frame guard + rehydration guard.
  if (body.referenceAttachments.length > 0 && inbound !== null) {
    const staged = await stageInboundReferences(
      body.referenceAttachments,
      body.clientMessageId,
      inbound,
      (name, reason) =>
        console.error(`[inbound-media] dropped ${name}: ${reason}`),
    );
    const block = buildFilesReceivedBlock(
      staged,
      body.config?.injections?.inbound_files,
    );
    if (block.length > 0) message = message ? `${message}\n${block}` : block;
  }

  // Outbound delivery contract (gateway-visible only): tell the agent how to make
  // a generated file DOWNLOADABLE in this webchat (write to the outbound dir + emit
  // `MEDIA:<path>`). Without it the agent writes a markdown link to a local path
  // that the webchat can't host → "I couldn't attach it" (the reported bug). Mirror
  // of the proven OpenWebUI pipe. Skipped when outbound media is off.
  if (deliveryDir !== null) {
    // `media_delivery` injection: the admin's resolved text, the bridge's own default
    // (pre-feature Convex), or NOTHING when the admin disabled it. See the function.
    message = applyMediaDeliveryInjection(
      message,
      deliveryDir,
      body.config?.injections?.media_delivery,
    );
  }

  const params: Record<string, unknown> = {
    sessionKey,
    message,
    idempotencyKey: await idempotencyKey(sessionKey, body.clientMessageId),
  };
  if (hasInlineAttachments) {
    // Frame guard: inbound attachments ride THIS chat.send as inline base64, so
    // the whole frame must fit the gateway's maxPayload — an oversized frame makes
    // the gateway CLOSE the connection (live-verified: a 20.9 MiB pptx → base64
    // ≈ 27.9 MiB > maxPayload 25 MiB → GATEWAY_DISCONNECTED). Reject with a
    // classified, non-fatal ATTACHMENT_TOO_LARGE BEFORE sending, so one oversized
    // file never drops the socket. We size by the SUM of attachment base64 only;
    // the message + JSON structure ride the fixed envelope reserved inside
    // base64FitsFrame — same accounting as the Convex dispatch + composer cap, so a
    // file at the advertised cap plus a normal prompt is never rejected here.
    // Derived from the gateway-announced maxPayload (no hardcoded size); only
    // skipped when maxPayload is not yet known (the composer + Convex are the
    // earlier gates).
    const atts = body.attachments as Array<{ content?: unknown }>;
    const base64Bytes = atts.reduce(
      (sum, a) => sum + (typeof a?.content === "string" ? a.content.length : 0),
      0,
    );
    if (
      conn.maxPayload !== null &&
      !base64FitsFrame(base64Bytes, conn.maxPayload)
    ) {
      throw new Error(
        `attachment too large for the gateway frame ` +
          `(base64 ${base64Bytes} > maxPayload ${conn.maxPayload})`,
      );
    }
    params.attachments = body.attachments;
  }
  const now = session.clock();
  // Response frames can race ahead of the chat.send `res` ack on the shared
  // socket. ARM the pre-ack buffer just before the request so the RunManager
  // captures any such frame while the sink is inactive and REPLAYS it in
  // beginTurn (after seeding ownRunIds from the ack runId) — the start of a
  // streaming response is never dropped. Arming is scoped to THIS send→ack
  // window, so a stray frame between turns is never buffered or replayed.
  // LAST CHECK before the gateway sees anything (codex P1): everything above may
  // have blocked for minutes, and past the deadline this dispatch is no longer ours
  // to send — Convex has settled the row and moved the conversation on.
  assertBeforeSendDeadline(sendReceivedMs, Date.now(), body.dispatchAgeMs);
  session.runManager.armReplayBuffer();
  try {
    const response = await conn.request("chat.send", params, 20_000);
    // The gateway ACCEPTED the message (with any prepended re-hydration history) — only
    // now consume firstSendPending (codex P2.A). A failed send above leaves it true so a
    // retry of this freshly-routed session re-hydrates again; a post-ack beginTurn throw
    // is fine to consume past (the gateway already has the re-grounded message).
    session.firstSendPending = false;
    const ackRunId = extractRunId(response);
    // Anchor the RAW user text for orphan-recovery boundary validation — NOT
    // params.message: the enriched message can END with static injections (the
    // [LIVRAISON] media-delivery block) identical on every turn, which would
    // make a stale previous-turn transcript pass the endsWith check (codex P1).
    // The transcript's user entry CONTAINS the raw text even when wrapped.
    await session.runManager.beginTurn(now, ackRunId, {
      expectedSessionId: preSendSessionId,
      pressure: (() => {
        // THE fill, derived ONCE, here, from the describe as it stands at send
        // time (post-compaction when the guard shrank the session) — and carried
        // WITH ITS SOURCE all the way into the trace.
        //
        // The pressure trace used to recompute its own `totalTokens/contextTokens`
        // in Convex, so the same session had THREE readings of "how full is it":
        // the guard's, the trace's, and the header meter's. They agreed only by
        // accident, and when a turn died of `context_length` at a displayed 51 %
        // nothing said which figure had decided — the counter branch (blind to
        // tool schemas and injected context) is indistinguishable from the
        // gateway's own estimate once the label is dropped (live prod 2026-08-05).
        const detail = sessionFillDetail({
          estimatedPromptTokens: preTurnEstimatedPromptTokens,
          promptBudgetBeforeReserve: preTurnPromptBudget,
          totalTokens: preTurnTotalTokens,
          contextTokens: preTurnContextTokens,
          totalTokensFresh: preTurnTotalTokensFresh,
        });
        return {
          totalTokens: preTurnTotalTokens,
          contextTokens: preTurnContextTokens,
          costUsd: preTurnCostUsd,
          fillPct:
            detail.fill === null ? null : Math.round(detail.fill * 100),
          fillSource: detail.source,
          // The window's OWNER (see preTurnModel): without it a fill percentage
          // cannot be checked against the model that actually had to hold it.
          model: preTurnModel,
        };
      })(),
      rehydrated: turnWasRehydrated,
      // Correlation for outboxReconcile: the assistant row this turn opens carries
      // the id of the send that caused it, so "this dispatch never ran" becomes a
      // fact instead of a guess.
      dispatchOutboxId: body.outboxId,
      // The guard shrank the session for THIS send: a `context_length` answer is
      // then transient, and Convex may re-dispatch it once.
      compactedBeforeSend: presend.compactOutcome === "compacted",
    });
    // AFTER beginTurn (which bumps turnEpoch): the anchor is stamped with the
    // NEW turn's epoch, so the recovery honors it for this turn (codex R11 P2 —
    // stamping before beginTurn bound it to the PREVIOUS epoch, disabling the
    // anchored fast-accept for every normal user send).
    session.noteTurnUserAnchor(String(body.text ?? ""));
  } catch (err) {
    // ANY failure in the armed send→turn-start window: chat.send rejected (e.g. the
    // gateway refused the attachment), OR beginTurn threw AFTER the ack (e.g. its
    // startAssistant write hit the Convex write timeout). The buffer is still armed
    // either way — disarm it (idempotent) so no armed window lingers buffering stray
    // frames until the next send. Then re-throw for the /send handler to classify +
    // report — a failed turn must NEVER wedge the session (bridge robustness #1).
    // The disarm may open a SPONTANEOUS announce turn (frames stashed during
    // the failed send window) — the wake fires AFTER that async open settles
    // (its recv deadline is armed by then), so the consume loop re-evaluates
    // with the fresh deadline instead of racing back to a null-timeout park.
    session.runManager.disarmReplayBuffer(session.clock(), () =>
      session.wake(),
    );
    throw err;
  }
  // beginTurn armed the recv/grace deadline from OUTSIDE the consume loop. If
  // that loop is already blocked on a null-timeout frame wait (idle session, or
  // the whole reply arrived in the pre-ack buffer), it would never re-evaluate
  // its deadline and the turn would hang in "streaming" forever — wake it so the
  // recv guard is installed and fires.
  session.wake();
}

/**
 * Immediate knob write-back (`POST /patch`). Applies the user's reasoning/model
 * choice via `sessions.patch`, then re-describes and reports the CONFIRMED live
 * `sessionMeta` back to Convex — so the header chip reflects the gateway's actual
 * state, not an optimistic guess. The describe reflects the patch immediately
 * (verified live, 6.1: a patch is visible in the very next describe). Does NOT
 * begin a turn (no chat.send): patching a knob must never look like a message.
 */
async function performPatch(
  session: BridgeSession,
  body: PatchBody,
  writer: ConvexWriter,
): Promise<void> {
  const conn = session.connection;
  const sessionKey = session.sessionKey;

  await applyPatchIntent(conn, sessionKey, body.sessionSettings);

  // Confirm + mirror the live state so the chip converges to the truth.
  try {
    const desc = await conn.request(
      "sessions.describe",
      { key: sessionKey },
      8_000,
    );
    const sess = (
      desc.payload as { session?: Record<string, unknown> } | undefined
    )?.session;
    if (sess) {
      const models = await ensureAvailableModels(conn);
      await writer.reportSessionMeta(
        body.chatId,
        parseSessionMeta(sess, models),
      );
    }
  } catch (err) {
    console.error(
      "[patch] describe/report skipped (non-fatal):",
      (err as Error)?.message ?? err,
    );
  }
}

/**
 * Reset the OpenClaw session (`sessions.reset`). Called after a message DELETE in
 * Convex so the gateway's session context stops diverging from the (now-truncated)
 * webchat: a reset flips `systemSent` to false, so the NEXT turn re-hydrates from
 * the truncated Convex state (docs/SESSION_CONTINUITY_DESIGN.md). Without this, a
 * warm session would keep deleted turns in the model's context — the user would
 * see a truncated thread while the model still reasons over what they removed.
 * We also clear `verboseFullApplied` so the next send re-applies verboseLevel.
 */
async function performReset(session: BridgeSession): Promise<void> {
  const conn = session.connection;
  await conn.request("sessions.reset", { key: session.sessionKey }, 10_000);
  conn.verboseFullApplied = false;
}

/**
 * Manual context compaction (`sessions.compact`). Unlike reset it PRESERVES the
 * session (summarized context), so verboseFullApplied stays as-is. Longer
 * timeout: the gateway summarizes with the model, which can take well beyond
 * the default RPC budget.
 */
async function performCompact(
  session: BridgeSession,
): Promise<{ compacted: boolean; reasonClass: string | null }> {
  const r = await session.connection.request(
    "sessions.compact",
    { key: session.sessionKey },
    COMPACT_TIMEOUT_MS,
  );
  // The gateway answers `{ok, compacted, reason?}` and REFUSES with a 200 (no
  // transcript, one already running, an unsupported harness). Returning void here
  // made every refusal look like a success: the user pressed "Compact the session",
  // was told nothing was wrong, and nothing had changed. Report the outcome so the
  // caller can say what actually happened.
  const p = r.payload as { compacted?: unknown; reason?: unknown } | undefined;
  return {
    compacted: p?.compacted === true,
    reasonClass:
      p?.compacted === true
        ? null
        : bucketCompactionReason(
            typeof p?.reason === "string" ? p.reason : undefined,
          ),
  };
}

/**
 * LAZY compaction history for one chat's gateway session (Inc 3 — never called
 * on the turn path): `sessions.compaction.list`, shaped CONTENT-FREE. Each
 * checkpoint's stored `summary` (real conversation content) is deliberately
 * DROPPED here — only structural facts cross this API: when, why, and how many
 * tokens the compaction condensed. Checkpoint shape pinned on live capture
 * 2026-07-03 (reason "auto-threshold", tokensBefore 19698 → tokensAfter 1050).
 */
export async function fetchCompactionHistory(
  conn: OpenClawConnection,
  sessionKey: string,
): Promise<{
  count: number;
  checkpoints: {
    checkpointId: string | null;
    createdAt: number | null;
    reason: string | null;
    tokensBefore: number | null;
    tokensAfter: number | null;
  }[];
}> {
  const res = await conn.request(
    "sessions.compaction.list",
    { key: sessionKey },
    15_000,
  );
  const payload = res.payload as Record<string, unknown> | undefined;
  const rawList = Array.isArray(payload?.checkpoints)
    ? (payload.checkpoints as unknown[])
    : Array.isArray(payload?.compactions)
      ? (payload.compactions as unknown[])
      : Array.isArray(payload)
        ? (payload as unknown[])
        : [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v ? v : null;
  const checkpoints = rawList
    .filter(
      (c): c is Record<string, unknown> => typeof c === "object" && c !== null,
    )
    .map((c) => ({
      checkpointId: str(c.checkpointId),
      createdAt: num(c.createdAt),
      // BUCKETED, not passed through (found 2026-07-27 while classifying the vendored
      // sessions schema — the manifest claimed this was already bucketed and it was
      // not). `reason` is FREE TEXT on the wire and this list is served by a
      // metadata-only surface (/api/v1/compaction-history and the obs MCP), so an
      // unrecognised value must collapse to "other" rather than travel verbatim —
      // exactly the treatment `timeoutPhase` and the pre-send guard's own reason
      // already get.
      reason: bucketCompactionReason(c.reason),
      tokensBefore: num(c.tokensBefore),
      tokensAfter: num(c.tokensAfter),
    }));
  return { count: checkpoints.length, checkpoints };
}

/** One normalized scheduled job (the /cron-list wire shape — provider-neutral). */
export interface CronJobSummary {
  id: string | null;
  name: string | null;
  enabled: boolean | null;
  schedule: string | null;
  nextRunAtMs: number | null;
  lastRunStatus: string | null;
  /** Did the LAST report reach anyone? A run can be `lastRunStatus: "ok"` and have
   *  been delivered NOWHERE — that pair is exactly how a weekly cycle failed in
   *  silence. `null` = the gateway said nothing, never "it failed". */
  lastDelivered: boolean | null;
  /** The gateway's own reason, when stated. */
  lastDeliveryError: string | null;
  /** The job's pinned agent id; null = the gateway's default agent (OpenClaw)
   *  or the instance's single agent (Hermes). Convex applies the policy. */
  agentId: string | null;
}

/** OpenClaw `cron.list` → normalized summaries. FULL (non-compact) response so
 *  each job's agentId is present — the compact projection drops it. Read-only,
 *  never on the turn path. */
export async function fetchCronJobs(
  conn: OpenClawConnection,
): Promise<CronJobSummary[]> {
  // includeDisabled: the tab renders a "Paused" state — the default listing
  // omits disabled jobs, which would make every paused job invisible.
  const res = await conn.request(
    "cron.list",
    { includeDisabled: true },
    15_000,
  );
  const payload = res.payload as Record<string, unknown> | undefined;
  const rawList = Array.isArray(payload?.jobs)
    ? (payload.jobs as unknown[])
    : Array.isArray(payload)
      ? (payload as unknown[])
      : [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v ? v : null;
  // Interval cadence in a human-scannable unit — "every 3600000" tells a user
  // nothing; "every 1h" does. Falls through to ms only for odd intervals.
  const everyLabel = (ms: number): string => {
    if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `every ${ms / 60_000}min`;
    if (ms % 1_000 === 0) return `every ${ms / 1_000}s`;
    return `every ${ms}ms`;
  };
  const jobs: CronJobSummary[] = [];
  for (const j of rawList) {
    if (typeof j !== "object" || j === null) continue;
    const job = j as Record<string, unknown>;
    // The schedule lives either as a cron expression, an --at timestamp, or a
    // structured {kind, expr|at|everyMs} — surface a printable string either
    // way (an "every" kind must keep its cadence, not just the word "every").
    const sched = job.schedule;
    let schedule = str(sched) ?? str(job.scheduleKind);
    if (schedule === null && typeof sched === "object" && sched !== null) {
      const s = sched as Record<string, unknown>;
      const every = num(s.everyMs) ?? num(s.every);
      schedule =
        str(s.expr) ??
        str(s.at) ??
        (every !== null ? everyLabel(every) : str(s.kind));
    }
    // Fail CLOSED on a malformed agent pin: agentId semantics downstream are
    // "null = the gateway default agent", so coercing a present-but-wrong-typed
    // value to null would silently re-attribute the job to the default agent's
    // users. Only true absence may mean "default"; anything else drops the job.
    const rawAgent = job.agentId ?? job.agent;
    let agentId: string | null;
    if (rawAgent === undefined || rawAgent === null) {
      agentId = null;
    } else if (typeof rawAgent === "string" && rawAgent !== "") {
      agentId = rawAgent;
    } else {
      continue; // protocol drift — never guess an owner
    }
    // Scheduler-maintained fields (nextRunAtMs, lastRunStatus) live in the
    // job's nested `state` object; older shapes carried them top-level.
    const state =
      typeof job.state === "object" && job.state !== null
        ? (job.state as Record<string, unknown>)
        : {};
    jobs.push({
      id: str(job.id) ?? str(job.jobId),
      name: str(job.name),
      enabled: typeof job.enabled === "boolean" ? job.enabled : null,
      schedule,
      nextRunAtMs:
        num(state.nextRunAtMs) ?? num(job.nextRunAtMs) ?? num(job.nextRunAt),
      lastRunStatus:
        str(state.lastRunStatus) ??
        str(state.lastStatus) ??
        str(job.lastRunStatus) ??
        str(job.lastStatus),
      // Did the LAST report reach anyone? The LIST is the supervision surface —
      // stopping the verdict at the detail panel left a job whose report was lost
      // reading "OK" in the one place an operator actually scans (codex).
      // STRICT boolean with the SAME state→job fallback the fields above use, since
      // older shapes carry these top-level too; silence stays null, never false.
      lastDelivered:
        typeof state.lastDelivered === "boolean"
          ? state.lastDelivered
          : typeof job.lastDelivered === "boolean"
            ? job.lastDelivered
            : null,
      lastDeliveryError:
        str(state.lastDeliveryError) ?? str(job.lastDeliveryError),
      agentId,
    });
  }
  return jobs;
}

/** OpenClaw cron management on a short-lived operator connection. `get` is
 *  also the OWNERSHIP probe Convex runs before every mutation (the job's
 *  agentId decides whose job it is), so its detail shape is normalized and
 *  fail-closed on a malformed agent pin (see normalizeCronJobDetail). */
export async function performOpenClawCronManage(
  conn: OpenClawConnection,
  body: {
    op: string;
    jobId: string;
    patch?: CronManagePatch;
    limit?: number;
  },
): Promise<
  | { ok: true; job?: CronJobDetail; entries?: CronRunEntry[]; run?: unknown }
  | { ok: false; code: string; message?: string }
> {
  const id = body.jobId;
  switch (body.op) {
    case "get": {
      try {
        const res = await conn.request("cron.get", { id }, 15_000);
        return { ok: true, job: normalizeCronJobDetail(res.payload) };
      } catch (err) {
        // The gateway answers a missing id with INVALID_REQUEST "...not found";
        // surface it as a distinct code so the UI can say "this cron is gone"
        // instead of a generic gateway error.
        if (/not found/i.test((err as Error)?.message ?? "")) {
          return { ok: false, code: "not_found" };
        }
        throw err;
      }
    }
    case "runs": {
      const limit = Math.max(
        1,
        Math.min(RUNS_LIMIT_MAX, Math.floor(body.limit ?? 20)),
      );
      const res = await conn.request("cron.runs", { id, limit }, 15_000);
      return { ok: true, entries: normalizeCronRunEntries(res.payload) };
    }
    case "update": {
      if (!body.patch) return { ok: false, code: "invalid_patch" };
      // The message maps onto the job's CURRENT payload kind — read it first.
      let payloadKind: string | null = null;
      if (body.patch.message !== undefined) {
        const cur = await conn.request("cron.get", { id }, 15_000);
        payloadKind = normalizeCronJobDetail(cur.payload).payloadKind;
      }
      const patch = buildGatewayCronPatch(body.patch, payloadKind);
      if (patch === null) return { ok: false, code: "unsupported_payload" };
      const res = await conn.request("cron.update", { id, patch }, 15_000);
      return { ok: true, job: normalizeCronJobDetail(res.payload) };
    }
    case "remove": {
      await conn.request("cron.remove", { id }, 15_000);
      return { ok: true };
    }
    case "run": {
      const res = await conn.request("cron.run", { id, mode: "force" }, 30_000);
      // Response shape: {ok?, ran?, runId?, reason?}. A payload-level
      // `ok:false` is a BUSINESS failure the RPC transport still acks —
      // surface it as ran:false so no client toasts a false "started".
      const p = res.payload as Record<string, unknown> | undefined;
      const payloadOk = typeof p?.ok === "boolean" ? p.ok : null;
      const ranRaw = typeof p?.ran === "boolean" ? p.ran : null;
      return {
        ok: true,
        run: {
          ran: payloadOk === false ? false : ranRaw,
          runId: typeof p?.runId === "string" ? p.runId.slice(0, 200) : null,
          reason: typeof p?.reason === "string" ? p.reason.slice(0, 200) : null,
        },
      };
    }
    default:
      return { ok: false, code: "unsupported" };
  }
}

/**
 * Open a SHORT-LIVED operator connection for a non-chat-scoped op (same
 * pattern as `discoverAgents`): dedicated — never a registry session, so no
 * normalizer consumer starts and the per-chat session map stays clean.
 * Mono-tenant: the single configured gateway IS the routed instance.
 */
async function withOperatorConnection<T>(
  config: BridgeConfig,
  fn: (conn: OpenClawConnection) => Promise<T>,
  // Called with the connection right after the hello-ok, so the caller can capture
  // BOTH the gateway version AND maxPayload from a SHORT discovery handshake (not
  // just a live chat session) — needed so an idle bridge still publishes the
  // inbound-attachment cap.
  onHandshake?: (conn: OpenClawConnection) => void,
): Promise<T> {
  const conn = await OpenClawConnection.connect(
    config.openclawGatewayUrl,
    // Boot-resolved (index.ts) — non-null by construction.
    config.openclawToken!,
    config.deviceIdentity!,
  );
  onHandshake?.(conn);
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

/**
 * GATEWAY-RESTART recovery for `/config-defaults` set (live-protocol finding,
 * 2026.6.5): `config.patch` can make the gateway restart in-process
 * (`restartReason=config.patch`), killing the operator socket before the
 * response is read EVEN THOUGH THE WRITE APPLIED — without this, the admin
 * sees an error for a save that succeeded. Reconnect on a bounded backoff and
 * CONFIRM by read-back; only a confirmed match is reported as success.
 */
async function confirmDefaultsAfterRestart(
  config: BridgeConfig,
  body: Extract<ConfigDefaultsBody, { op: "set" | "clear" }>,
): Promise<{
  thinkingDefault: string | null;
  fastModeDefault: boolean | null;
} | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      const defaults = await withOperatorConnection(config, async (conn) => {
        const res = await conn.request("config.get", {}, 8_000);
        return extractAgentDefaults(res.payload);
      });
      // The gateway is back: the read-back is authoritative either way.
      return defaultsApplied(body, defaults) ? defaults : null;
    } catch {
      // Still restarting — keep polling within the bound (~16s).
    }
  }
  return null;
}

// --- Agent discovery (provider-agnostic, normalized for the app) -------------

/** A normalized, provider-agnostic agent descriptor for the `/agents` API. The
 *  bridge absorbs OpenClaw/Hermes + version field-name drift HERE so the app (and
 *  the `agents` Convex cache) depend on ONE stable shape. */
export interface NormalizedAgent {
  agentId: string;
  displayName: string | null;
  emoji: string | null;
  model: string | null;
  isDefaultOnInstance: boolean;
  raw: unknown;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Flatten one OpenClaw `agents.list` entry. Tolerant of 5.19/6.1 + CLI/RPC drift
 *  (LIVE-captured 6.1 RPC shape: `id`, `name`, `identity.{name,emoji}`,
 *  `model.primary`, default via the LIST-level `defaultId` — NOT a per-agent flag).
 *  Handles: id|agentId, identityName|name|identity.name, identityEmoji|identity.emoji,
 *  model string|{primary}, per-agent isDefault|default OR list-level `defaultId`.
 *  Returns null on an idless/shapeless entry. */
export function normalizeOpenClawAgent(
  raw: unknown,
  defaultId?: string | null,
): NormalizedAgent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const agentId = asNonEmptyString(o.id) ?? asNonEmptyString(o.agentId);
  if (!agentId) return null;
  const identity =
    typeof o.identity === "object" && o.identity !== null
      ? (o.identity as Record<string, unknown>)
      : null;
  const displayName =
    asNonEmptyString(o.identityName) ??
    asNonEmptyString(o.name) ??
    (identity ? asNonEmptyString(identity.name) : null);
  const emoji =
    asNonEmptyString(o.identityEmoji) ??
    (identity ? asNonEmptyString(identity.emoji) : null);
  const model =
    asNonEmptyString(o.model) ??
    (typeof o.model === "object" && o.model !== null
      ? asNonEmptyString((o.model as Record<string, unknown>).primary)
      : null);
  const isDefaultOnInstance =
    o.isDefault === true ||
    o.default === true ||
    (defaultId != null && agentId === defaultId);
  return { agentId, displayName, emoji, model, isDefaultOnInstance, raw };
}

/** Open a SHORT-LIVED operator connection, call `agents.list`, normalize, close.
 *  Dedicated (not a registry session) so it never starts a normalizer consumer or
 *  pollutes the per-chat session map. Mono-tenant: uses the configured gateway. */
// The Hermes WS discovery needs the server's per-instance WS clients; set at
// createBridgeServer time (module-level so the free function can reach it).
let hermesTurnsRef: HermesTurnRegistry | undefined;

export async function discoverAgents(
  config: BridgeConfig,
  onHandshake?: (conn: OpenClawConnection) => void,
  onHermesVersion?: (version: string) => void,
): Promise<{
  agents: NormalizedAgent[];
  rawCount: number;
  usage: ProviderUsage[] | null;
}> {
  if (config.kind === "hermes") {
    // Hermes: REST discovery (GET /v1/models → one agent). No operator socket,
    // no usage RPC. The gateway version (from /health) is noted so the compat
    // poll's synthetic target exposes Hermes capabilities even when idle (codex
    // P2). Same return shape so every caller is provider-agnostic.
    const d = await discoverHermesAgents(config, hermesTurnsRef);
    // An ANSWER about the version — including "one arrived and we refuse it" — is recorded
    // on the Hermes observer, which is the single source `/capabilities` consults for this
    // provider. Forwarding only a truthy version left a stale entry standing when a gateway
    // came back at a version we cannot read, and the poll then declined to refresh it
    // because it already had one (raised in review).
    if (d.versionObserved && config.instanceName) {
      hermesTurnsRef?.noteGatewayVersion(config.instanceName, d.gatewayVersion);
    }
    if (d.gatewayVersion) onHermesVersion?.(d.gatewayVersion);
    return { agents: d.agents, rawCount: d.rawCount, usage: null };
  }
  const conn = await OpenClawConnection.connect(
    config.openclawGatewayUrl,
    // Boot-resolved (index.ts) — non-null by construction.
    config.openclawToken!,
    config.deviceIdentity!,
  );
  onHandshake?.(conn);
  try {
    const res = (await conn.request("agents.list", {}, 10_000)) as {
      payload?: unknown;
    };
    const payload = res?.payload ?? res;
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { agents?: unknown })?.agents)
        ? (payload as { agents: unknown[] }).agents
        : [];
    // 6.1 RPC marks the default via a LIST-level `defaultId`, not a per-agent flag.
    const defaultId = asNonEmptyString(
      (payload as { defaultId?: unknown })?.defaultId,
    );
    const agents = list
      .map((raw) => normalizeOpenClawAgent(raw, defaultId))
      .filter((a): a is NormalizedAgent => a !== null);
    // `rawCount` = how many entries the gateway returned BEFORE normalization. The
    // Convex poller uses it to tell a GENUINELY empty gateway (rawCount 0 → a real
    // "all agents deleted", apply it) from shape-drift (rawCount > 0 but all
    // dropped by the normalizer → fail-closed, keep last-good). See agents cache.
    // Subscription usage rides the SAME short-lived connection (one extra RPC,
    // zero extra sockets). Best-effort: a gateway without the method (or with an
    // empty snapshot) yields null — discovery itself is NEVER failed by usage.
    let usage: ProviderUsage[] | null = null;
    try {
      const ures = (await conn.request("usage.status", {}, 8_000)) as {
        payload?: unknown;
      };
      usage = normalizeUsagePayload(ures?.payload ?? ures);
    } catch {
      usage = null;
    }
    return { agents, rawCount: list.length, usage };
  } finally {
    conn.close();
  }
}

/** Subscription-usage snapshot from the gateway's `usage.status` RPC (the same
 *  data the Control UI's "Utilisation N%" and `openclaw models status` show):
 *  per provider, rate-limit WINDOWS {label, usedPercent, resetAt}. Normalized +
 *  bounded here; `null` when the gateway has no snapshot (observed on an idle
 *  bench) — callers treat that as "unknown", never an error. */
export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetAt: number | null;
}
export interface ProviderUsage {
  provider: string;
  windows: UsageWindow[];
}
function normalizeUsagePayload(payload: unknown): ProviderUsage[] | null {
  const providers = (payload as { providers?: unknown })?.providers;
  if (!Array.isArray(providers)) return null;
  const out: ProviderUsage[] = [];
  for (const p of providers.slice(0, 8)) {
    if (typeof p !== "object" || p === null) continue;
    const provider = (p as { provider?: unknown }).provider;
    const windows = (p as { windows?: unknown }).windows;
    if (typeof provider !== "string" || !Array.isArray(windows)) continue;
    const normWindows: UsageWindow[] = [];
    for (const w of windows.slice(0, 6)) {
      if (typeof w !== "object" || w === null) continue;
      const label = (w as { label?: unknown }).label;
      const usedPercent = (w as { usedPercent?: unknown }).usedPercent;
      const resetAt = (w as { resetAt?: unknown }).resetAt;
      if (typeof label !== "string" || typeof usedPercent !== "number")
        continue;
      normWindows.push({
        label: label.slice(0, 24),
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        resetAt: typeof resetAt === "number" ? resetAt : null,
      });
    }
    if (normWindows.length > 0) {
      out.push({ provider: provider.slice(0, 32), windows: normWindows });
    }
  }
  return out.length > 0 ? out : null;
}

/** Static provider capabilities for a mono-tenant OpenClaw bridge. Mirrors the
 *  ground truth in docs/OPENCLAW_RESEARCH.md (no chat.history). abort is REAL:
 *  POST /abort -> gateway chat.abort kills the session's active run.
 *  Phase 2 sources this per-instance from the provider abstraction. */
function openclawCapabilities() {
  return {
    kind: "openclaw" as const,
    agentDiscovery: true,
    abort: true,
    history: false,
    attachments: true,
    media: true,
    streaming: "both" as const,
  };
}

/**
 * One `/capabilities` target: a live session's resolved compat view. `key` is
 * the operator canonical (same bounded keying as /health targets — never a
 * chat id: the endpoint is unauthenticated).
 */
export interface CapabilityTarget {
  key: string;
  instanceName: string | null;
  provider: "openclaw" | "hermes";
  agentId: string;
  gatewayVersion: string | null;
  capabilities: Record<string, boolean>;
  versionBeyondValidated?: true;
}

/**
 * Project the registry's live sessions onto `/capabilities` targets. Deduped
 * by canonical (mono-gateway: every session shares the same gateway version
 * anyway; last live session wins). Pure — exported for tests.
 */
/** Transport-aware overlay for Hermes: the WS surface adds capabilities the REST API
 *  server does not have. Applied ONLY when the base resolution passed the version gate
 *  (or no version is known → range floor) — a gateway BELOW the validated range must keep
 *  its capabilities off (codex P2).
 *
 *  Shared by BOTH target paths. It used to live only in the no-session branch, so a live
 *  Hermes session silently got a different capability set from an idle one.
 *
 *  Each capability answers to its OWN `minVersion`, resolved against the manifest's own
 *  Hermes range. It used to grant the whole set with a flat `true`, which — combined with
 *  `abort` standing in as the version proxy, whose minimum IS the range floor — meant no
 *  capability minimum decided anything on this provider. Nothing was mis-gated, because
 *  every shipped Hermes minimum equals the floor; the mechanism was simply inert, and would
 *  have kept granting the moment a capability was given a higher minimum. `table` is
 *  injectable for the same reason `resolveCapabilitiesFor` is: only a table the shipped
 *  manifest cannot express can tell flat-grant and per-minimum apart. */
export function applyHermesTransportOverlay(
  resolved: { capabilities: Record<string, boolean> },
  version: string | null,
  transport: "ws" | "rest",
  table: Record<string, string> = hermesCapabilitiesFor(transport),
): void {
  const versionGatePassed = version === null || resolved.capabilities.abort === true;
  if (!versionGatePassed) return;
  const overlay = resolveCapabilitiesFor(HERMES_RANGE, table, version);
  for (const [key, granted] of Object.entries(overlay.capabilities)) {
    resolved.capabilities[key] = granted;
  }
  if (transport === "rest") delete resolved.capabilities.inboundAttachments;
}

/** The precedence between an instance's version sources, extracted so it has ONE
 *  definition and can be exercised: the live observation, then the discovery snapshot, then
 *  what the operator configured. See `versionForInstance` for why the order matters. */
export function resolveInstanceVersion(
  observed: { seen: boolean; version: string | null },
  snapshot: string | null,
  configured: string | null,
): string | null {
  // A turn that LOOKED is authoritative, including when it looked and could not read what
  // it found: falling through to the older sources there would undo the retirement the live
  // observation just decided (raised in review).
  if (observed.seen) return observed.version;
  return snapshot ?? configured ?? null;
}

export function buildCapabilityTargets(
  live: LiveTarget[],
  instanceName: string | null,
  fallbackVersion: string | null = null,
  provider: "openclaw" | "hermes" = "openclaw",
  transport: "ws" | "rest" = "ws",
): CapabilityTarget[] {
  const byKey = new Map<string, LiveTarget>();
  for (const t of live) byKey.set(t.canonical, t);
  const targets = [...byKey.values()].map((t) => {
    // A live session's REAL captured version wins; but when it is null — the
    // gateway never reported `server.version` at the handshake (observed in
    // prod: a live session connects yet carries no version) — fall back to the
    // configured version so the live target is NOT resolved to "unknown" and
    // gate AgentFiles/ChatDefaults off. (Precedence: real live > configured >
    // null.) This is what makes the fix hold even WITH a session live at the
    // poll, not just the no-session synthetic case below.
    const effectiveVersion = t.gatewayVersion ?? fallbackVersion;
    // The instance's OWN provider, not a hardcoded "openclaw". A Hermes instance WITH a
    // live session took this path and had its 0.18.x version resolved against the
    // OpenClaw support window — every capability off, the panels gated shut, and the
    // synthetic Hermes target below suppressed because a live target already covered the
    // instance. The `provider` argument existed and only the no-session branch used it.
    const resolved = resolveCapabilities(provider, effectiveVersion);
    if (provider === "hermes") applyHermesTransportOverlay(resolved, effectiveVersion, transport);
    const target: CapabilityTarget = {
      key: t.canonical,
      instanceName,
      provider,
      agentId: t.agentId,
      gatewayVersion: effectiveVersion,
      capabilities: resolved.capabilities,
    };
    if (resolved.versionBeyondValidated) target.versionBeyondValidated = true;
    return target;
  });
  // ALWAYS surface the SERVED instance, even with NO live chat session (BUG-1):
  // the per-session targets above are empty whenever no chat is open at the
  // compat poll (lazy bridge / process restart / idle), which made a perfectly
  // supported gateway resolve to "unknown version" → AgentFiles/ChatDefaults
  // gated off. The bridge contacts this same gateway on every discovery poll
  // and captures `server.version` at handshake, so `fallbackVersion` is a
  // reliable last-known version for the served instance. Only added when no
  // live target already covers it (a live session is always more specific).
  if (
    instanceName &&
    // Hermes: emit the target EVEN with a null version — its /health may return
    // plain "ok" (no version), but its capabilities pin at the range floor
    // regardless, and dropping the target would make the UI fall back to legacy
    // OpenClaw controls on a Hermes instance (codex P2). OpenClaw keeps the
    // honest "no version -> no target -> unknown" behavior.
    (fallbackVersion || provider === "hermes") &&
    !targets.some((t) => t.instanceName === instanceName)
  ) {
    const resolved = resolveCapabilities(provider, fallbackVersion);
    if (provider === "hermes") applyHermesTransportOverlay(resolved, fallbackVersion, transport);
    const synthetic: CapabilityTarget = {
      key: instanceName,
      instanceName,
      provider,
      agentId: "",
      gatewayVersion: fallbackVersion,
      capabilities: resolved.capabilities,
    };
    if (resolved.versionBeyondValidated)
      synthetic.versionBeyondValidated = true;
    targets.push(synthetic);
  }
  return targets;
}

/**
 * Enrich the `/health` snapshot with the compat versions — STRICTLY additive
 * (every pre-existing field is preserved verbatim; the Convex poller's parser
 * must keep working unchanged). Each target gains `gatewayVersion`, looked up
 * from the live session sharing its canonical (null when none is live — the
 * bridge is lazy, a drained target keeps its history but has no socket to ask).
 * Pure — exported for tests.
 */
export interface EnrichedHealthSnapshot extends Omit<
  HealthSnapshot,
  "targets"
> {
  bridgeVersion: string;
  protocolVersion: number;
  /** Gateway WS frame limit (policy.maxPayload) — the authoritative inbound-
   *  attachment ceiling, so Convex + the composer derive the same cap instead of
   *  hardcoding one. From a live session, else the last-seen fallback, else null. */
  maxPayload: number | null;
  targets: (TargetHealth & {
    gatewayVersion: string | null;
    /** This instance's OWN gateway frame limit (capped at the body cap) — so a bridge
     *  serving instances with DIFFERENT maxPayloads publishes each per target, and the
     *  Convex poller keeps them distinct instead of copying one URL-level value. */
    maxPayload: number | null;
  })[];
}

export function enrichHealthSnapshot(
  snapshot: HealthSnapshot,
  live: LiveTarget[],
  // PER-INSTANCE last-seen frame limits (instanceName -> maxPayload), so an IDLE
  // target (no live session) falls back to ITS OWN gateway's cap — NOT a global value
  // (which would publish another instance's limit on a multi-instance bridge).
  fallbackByInstance: Map<string, number> = new Map(),
  httpBodyCap: number | null = null,
): EnrichedHealthSnapshot {
  // Key live sessions by instanceName:canonical (two instances may share a canonical,
  // so canonical alone is ambiguous on a multi-instance bridge).
  const liveKey = (instanceName: string | null, canonical: string): string =>
    `${instanceName ?? ""}:${canonical}`;
  const versionByKey = new Map<string, string | null>();
  const payloadByKey = new Map<string, number | null>();
  for (const t of live) {
    versionByKey.set(liveKey(t.instanceName, t.canonical), t.gatewayVersion);
    payloadByKey.set(liveKey(t.instanceName, t.canonical), t.maxPayload);
  }
  // Cap a gateway frame at the bridge's OWN HTTP body cap (the Convex->bridge /send
  // POST carries the base64-inflated payload): publish the binding MINIMUM so consumers
  // never advertise a size the POST can't carry (413 at readBody before the frame guard).
  const capToBody = (gw: number | null): number | null =>
    gw === null ? null : httpBodyCap === null ? gw : Math.min(gw, httpBodyCap);
  // Top-level cap (consumers WITHOUT per-target context, e.g. the global composer
  // gate): the CONSERVATIVE MIN across every known per-instance frame (live sessions +
  // last-seen caches). Taking the first live frame would let a big-limit instance's
  // size sail past while a smaller-limit instance is idle, and the small gateway then
  // refuses the file at dispatch. Per-target precision lives on each target below.
  const allCaps = [
    ...live
      .map((t) => t.maxPayload)
      .filter((n): n is number => typeof n === "number"),
    ...fallbackByInstance.values(),
  ];
  const maxPayload = capToBody(allCaps.length ? Math.min(...allCaps) : null);
  return {
    ...snapshot,
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    maxPayload,
    targets: snapshot.targets.map((t) => {
      const k = liveKey(t.instanceName, t.canonical);
      // This instance's own live frame, else its OWN last-seen cap, else null (capped).
      const own =
        payloadByKey.get(k) ??
        (t.instanceName !== null
          ? (fallbackByInstance.get(t.instanceName) ?? null)
          : null);
      return {
        ...t,
        gatewayVersion: versionByKey.get(k) ?? null,
        maxPayload: capToBody(own),
      };
    }),
  };
}

/** Max time /capabilities waits on a per-instance one-shot version discovery before
 *  returning with the cached/fallback version — so a slow/down gateway can't delay the
 *  shared endpoint for the healthy instances (the discovery keeps running in the bg). */
const CAPABILITIES_DISCOVERY_BUDGET_MS = 4000;

export interface BridgeServerDeps {
  /** Gateway-agnostic shared config (auth secret, body cap). */
  shared: SharedConfig;
  /** The instances this bridge serves, keyed by instanceName (one bridge, N gateways).
   *  Each bundle carries its instance's config + writer + hot media provider. */
  served: Map<string, InstanceBundle>;
  registry: SessionRegistry;
  /** Tracks per-target connection health for the /health endpoint. */
  health: HealthRegistry;
  /** Live per-instance config problems (unresolved/misconfigured secrets) surfaced on
   *  /health so an operator sees WHY an instance is not served WITHOUT reading bridge
   *  logs. Additive + non-secret (reason + instance name, never the secret/token). */
  getConfigIssues?: () => ConfigIssue[];
  /** Run an immediate credential-resolution pass (the boot self-heal loop's tick). Used
   *  by `POST /refresh-credentials` so Convex can make the bridge pick up a just-saved
   *  credential NOW instead of waiting for the poll. No-op when no loop is running. */
  triggerRefresh?: () => Promise<void>;
}

/**
 * Create (but do not start) the inbound HTTP server. Call `.listen(port)`.
 *
 * Routes:
 *   GET  /health          -> liveness probe (no auth)
 *   POST /send            -> authenticated turn dispatch from Convex
 *   POST /patch           -> authenticated knob write-back (reasoning/model/
 *                            speed + per-field clears) from Convex
 *   POST /reset           -> authenticated session reset
 *   POST /compact         -> authenticated manual context compaction
 *   POST /agent-files     -> authenticated agent workspace file list/get/set
 *   POST /config-defaults -> authenticated gateway chat-defaults get/set
 */
export function createBridgeServer(deps: BridgeServerDeps): Server {
  const { shared, served, registry, health, getConfigIssues, triggerRefresh } =
    deps;
  // PER-INSTANCE caches (one bridge, N gateways): the last gateway version +
  // maxPayload seen for EACH served instance, so /health and /capabilities report
  // each gateway honestly even when no chat session is live (lazy bridge / restart).
  // Keyed by instanceName (NOT a single closure — instance B being down must not
  // strand instance A's version/cap). Per-server (test isolation).
  const lastGatewayVersion = new Map<string, string>();
  const lastMaxPayload = new Map<string, number>();
  // In-flight Hermes turns (per chat) for /abort — Hermes has no persistent
  // session registry, so this tracks the one live SSE turn per chat.
  const hermesTurns = new HermesTurnRegistry();
  hermesTurnsRef = hermesTurns;
  const noteGatewayVersion = (instanceName: string, v: string | null): void => {
    if (typeof v === "string" && v.length > 0)
      lastGatewayVersion.set(instanceName, v);
  };
  /**
   * The gateway version to resolve an instance's capabilities against — ONE answer, from
   * the freshest source that has one.
   *
   * A Hermes instance has TWO observers and they are not equally current: `session.info`
   * updates the turn registry the moment a turn runs, while `lastGatewayVersion` is only a
   * SNAPSHOT taken by the `/agents` discovery poll. Reading the snapshot alone meant that
   * after a gateway restart at a different version, `/capabilities` kept serving the old
   * one — and its banner and gates with it — until the next poll happened to come round
   * (raised in review). The live observation wins; the snapshot and the configured fallback
   * remain for the cold start, when no turn has run yet.
   *
   * NOT invalidated when the socket closes: the last version observed is still the best
   * information there is until a new turn reports otherwise, and dropping it would send
   * `/capabilities` back to "unknown" — and to the range floor — on every reconnect.
   */
  const versionForInstance = (
    instanceName: string,
    bundle: InstanceBundle,
  ): string | null => {
    const isHermes = bundle.config.kind === "hermes";
    const configured = bundle.config.gatewayVersionFallback ?? null;
    return resolveInstanceVersion(
      isHermes
        ? hermesTurns.observedVersionFor(instanceName)
        : { seen: false, version: null },
      lastGatewayVersion.get(instanceName) ?? null,
      // THE THIRD DOOR, and the one an operator is most likely to get wrong: the configured
      // fallback takes the generic three-number grammar, so `2026.7.20` — the git TAG of
      // 0.19.0, and the version anyone reads off the upstream repo — is accepted. On a cold
      // Hermes instance that value went straight to `/capabilities`, lit the beyond-validated
      // banner and resolved every gate against a scheme the manifest is not written in
      // (raised in review). Same rule as `session.info` and `/health`.
      isHermes && configured
        ? readHermesGatewayVersion(configured, "config.gatewayVersionFallback")
        : configured,
    );
  };

  const noteMaxPayload = (instanceName: string, n: number | null): void => {
    if (typeof n === "number" && n > 0) lastMaxPayload.set(instanceName, n);
  };
  // Capture BOTH from any operator handshake for a SPECIFIC instance (incl. a short
  // /agents or /capabilities discovery), so an idle/just-restarted bridge publishes
  // that instance's version + inbound cap without waiting for a live chat session.
  const noteHandshakeFor =
    (instanceName: string) =>
    (conn: OpenClawConnection): void => {
      noteGatewayVersion(instanceName, conn.gatewayVersion);
      noteMaxPayload(instanceName, conn.maxPayload);
    };
  const gatewayHostFor = (instanceName: string): string => {
    const bundle = served.get(instanceName);
    return bundle ? gatewayHostOf(bundle.config.openclawGatewayUrl) : "";
  };
  // In-flight memo for the /capabilities one-shot version discovery, PER INSTANCE:
  // concurrent unauthenticated polls share one discovery per gateway, never piling
  // up connections; a slow/down gateway B never blocks A's discovery.
  const versionDiscoveryInFlight = new Map<string, Promise<void>>();
  const targetRef = (
    agentId: string,
    canonical: string,
    instanceName: string,
  ): TargetRef => ({
    key: `${instanceName}:${canonical}`,
    canonical,
    agentId,
    gatewayHost: gatewayHostFor(instanceName),
    instanceName,
  });
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      // Never leave the dispatcher hanging; never leak gateway detail.
      console.error("bridge server error:", (err as Error)?.message ?? err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "internal error" });
      }
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method === "GET" && req.url === "/health") {
      // Health is UNAUTHENTICATED on purpose (liveness + a non-secret state
      // snapshot — codes + host only, never tokens). The Convex poller reads it.
      // Additive compat fields: bridgeVersion + protocolVersion + maxPayload at
      // the top, gatewayVersion per target (from the live session's handshake).
      const live = registry.listLive();
      for (const t of live) noteMaxPayload(t.instanceName, t.maxPayload); // keep the idle fallback fresh
      // Pass the PER-INSTANCE last-seen caps so an idle target falls back to its OWN
      // gateway's frame (not a global value). The top-level maxPayload is derived
      // inside (live frame, else the min across instances) for context-free consumers.
      sendJson(res, 200, {
        ...enrichHealthSnapshot(
          health.snapshot(),
          live,
          lastMaxPayload,
          shared.maxBodyBytes,
        ),
        // Additive, non-secret: instances configured but not (yet) served + WHY. Lets the
        // admin UI / a curl show "olivier: bad_device" instead of needing docker logs.
        configIssues: getConfigIssues?.() ?? [],
        // BUILD-time truths (image env, frozen by CI) beside the RUNTIME truth
        // (bridgeVersion = package.json): a divergence means the deployed
        // container is NOT the build you think — surfaced in the Settings banner.
        buildVersion: process.env.ATRIUM_VERSION ?? null,
        buildRevision: process.env.ATRIUM_REVISION ?? null,
      });
      return;
    }

    if (req.method === "GET" && req.url === "/capabilities") {
      // Non-secret provider capability descriptor (incl. agentDiscovery). The app
      // caches this to adapt its UI per provider. Unauthenticated like /health.

      // Refresh each instance's version + maxPayload from its currently-live sessions.
      const live = registry.listLive();
      for (const t of live) {
        noteGatewayVersion(t.instanceName, t.gatewayVersion);
        noteMaxPayload(t.instanceName, t.maxPayload);
      }
      // SELF-SUFFICIENT version capture (BUG-1), PER SERVED INSTANCE: if an instance's
      // version is still unknown AND it has no live session, one-shot discover it
      // (deduped per instance) so its target carries a real version instead of being
      // gated "unknown". A slow/down gateway B never blocks A — discoveries run
      // concurrently, each BOUNDED by a budget so a down gateway's connect timeout
      // cannot delay /capabilities for the healthy instances. A bounded-out discovery
      // keeps running in the background (it settles + populates the cache for the next
      // poll); a failure is non-fatal for that instance only.
      await Promise.all(
        [...served.entries()].map(async ([name, bundle]) => {
          if (
            lastGatewayVersion.has(name) ||
            live.some((t) => t.instanceName === name)
          )
            return;
          let inflight = versionDiscoveryInFlight.get(name);
          if (!inflight) {
            inflight = discoverAgents(
              bundle.config,
              noteHandshakeFor(name),
              (v) => noteGatewayVersion(name, v),
            )
              .then(() => undefined)
              .catch((err) => {
                console.error(
                  `[capabilities] one-shot version discovery failed for ${name} (non-fatal):`,
                  (err as Error)?.message ?? err,
                );
              })
              .finally(() => versionDiscoveryInFlight.delete(name));
            versionDiscoveryInFlight.set(name, inflight);
          }
          // Bound the await: return with the cached/fallback version rather than wait
          // out a down gateway's connect timeout (the inflight keeps running).
          await Promise.race([
            inflight,
            new Promise<void>((resolve) => {
              const timer = setTimeout(
                resolve,
                CAPABILITIES_DISCOVERY_BUDGET_MS,
              );
              if (typeof timer.unref === "function") timer.unref();
            }),
          ]);
        }),
      );

      // One target set per served instance (live wins; per-instance fallback fills the
      // no-session gap). Convex resolves version-gated capabilities per instance from
      // these targets (capabilitiesForInstance), so the top-level instanceName/version
      // are only meaningful for a single-instance bridge (null when serving many).
      const targets = [...served.entries()].flatMap(([name, bundle]) =>
        buildCapabilityTargets(
          live.filter((t) => t.instanceName === name),
          name,
          versionForInstance(name, bundle),
          bundle.config.kind ?? "openclaw",
          bundle.config.transport ?? "ws",
        ),
      );
      const names = [...served.keys()];
      const soleName = names.length === 1 ? names[0] : null;
      const soleVersion = soleName
        ? versionForInstance(soleName, served.get(soleName)!)
        : null;
      sendJson(res, 200, {
        instanceName: soleName,
        gatewayVersion: soleVersion,
        capabilities: openclawCapabilities(),
        bridgeVersion: BRIDGE_VERSION,
        // Build-time truths (image env) beside the runtime bridgeVersion — the
        // compat poller persists them so the banner can flag a divergence.
        buildVersion: process.env.ATRIUM_VERSION ?? null,
        buildRevision: process.env.ATRIUM_REVISION ?? null,
        // The env-level rehydration KILL-SWITCH state (OPENCLAW_REHYDRATION=off).
        // Convex aligns the summarize engine on it: when this bridge would never
        // consume a summary, no summarize job should burn model turns.
        rehydrationDefault: process.env.OPENCLAW_REHYDRATION !== "off",
        // This bridge echoes the turn's session key into startAssistant — the
        // DETERMINISTIC reply-to-send join the summarize correlate requires. The
        // engine refuses to dispatch against a bridge without it (a time-based
        // fallback can settle the wrong job during a rolling upgrade).
        turnSessionEcho: true,
        protocolVersion: PROTOCOL_VERSION,
        compat: COMPAT_MANIFEST,
        // Protocol-contract Inc 2 (additive; the Convex poller picks known
        // fields, so older consumers ignore it): the vendored schema version
        // this build understands + the runtime DRIFT observed against it
        // (unknown chat/agent payload fields — names only, never values).
        protocol: {
          vendoredVersion: DRIFT_VENDORED_VERSION,
          coverage: COVERAGE_SUMMARY,
          drift: protocolDrift.report(),
          // ADDITIVE field: how many drift observations fell past the tracked-shape cap.
          // Older consumers ignore it; without it the bound was invisible downstream.
          driftOverflow: protocolDrift.overflowCount(),
        },
        targets,
      });
      return;
    }

    if (
      req.method === "GET" &&
      (req.url === "/agents" || req.url?.startsWith("/agents?"))
    ) {
      // Bridge-driven agent discovery. Authenticated (it opens a gateway
      // connection) with the shared secret, like /send. Returns NORMALIZED,
      // non-secret agent descriptors; the app caches them as the bind whitelist.
      const provided = req.headers["authorization"];
      if (
        typeof provided !== "string" ||
        !constantTimeEqual(provided, shared.bridgeSharedSecret)
      ) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      // `?instance` SELECTS which served gateway to discover (one bridge, N gateways).
      const instanceName = new URL(
        req.url ?? "/agents",
        "http://bridge",
      ).searchParams.get("instance");
      const bundle = instanceName ? served.get(instanceName) : undefined;
      if (!bundle) {
        // The poller asked for an instance this bridge does not serve (or omitted it):
        // refuse rather than discover the wrong gateway.
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      try {
        const { agents, rawCount, usage } = await discoverAgents(
          bundle.config,
          noteHandshakeFor(instanceName!),
          (v) => noteGatewayVersion(instanceName!, v),
        );
        // `count` (raw gateway agent count) lets the Convex poller distinguish a
        // genuinely empty gateway from normalizer shape-drift (agents cache P2).
        sendJson(res, 200, {
          ok: true,
          instanceName,
          agents,
          count: rawCount,
          // Subscription-usage windows (null when the gateway has no snapshot):
          // per provider, {label, usedPercent, resetAt} — the chat gauge + the
          // Settings ▸ Bridge detail read the stored copy of this.
          usage,
          capturedAt: Date.now(),
        });
      } catch (err) {
        // Classify into a stable non-PHI code; raw detail stays in this log only.
        const code = classifyGatewayError(err);
        console.error(
          `bridge /agents failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (
      req.method === "POST" &&
      (req.url === "/refresh-credentials" ||
        req.url?.startsWith("/refresh-credentials?"))
    ) {
      // On-demand uptake: Convex pokes this right after an admin sets/generates a
      // credential, so the bridge resolves the (now-configured) instance and connects to
      // its gateway NOW — triggering the operator pairing request (or warming an
      // already-paired instance) instead of waiting for the self-heal poll. Authenticated
      // like /send (it can open a gateway connection).
      const provided = req.headers["authorization"];
      if (
        typeof provided !== "string" ||
        !constantTimeEqual(provided, shared.bridgeSharedSecret)
      ) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const instanceName = new URL(
        req.url ?? "/refresh-credentials",
        "http://bridge",
      ).searchParams.get("instance");
      // Resolve any not-yet-served secrets NOW (serialized with the loop), so a
      // just-configured instance becomes served + connectable immediately.
      await triggerRefresh?.();
      const bundle = instanceName ? served.get(instanceName) : undefined;
      // If the instance is now served AND has no live session, open a discovery
      // connection to trigger the operator handshake (pairing) immediately. FIRE-AND-
      // FORGET so the poke returns fast; a NOT_PAIRED here is EXPECTED (the operator must
      // approve on the gateway) and must never surface as an error.
      if (
        bundle &&
        !registry.listLive().some((t) => t.instanceName === instanceName)
      ) {
        void discoverAgents(
          bundle.config,
          noteHandshakeFor(instanceName!),
          (v) => noteGatewayVersion(instanceName!, v),
        ).catch((err) => {
          console.log(
            `[refresh] discovery connect for ${instanceName} (non-fatal):`,
            (err as Error)?.message ?? err,
          );
        });
      }
      sendJson(res, 200, { ok: true, served: bundle !== undefined });
      return;
    }

    const POST_ROUTES = [
      "/send",
      "/patch",
      "/reset",
      "/abort",
      "/compact",
      "/compaction-history",
      "/agent-files",
      "/config-defaults",
      "/tts",
      "/validate-media",
      // Phase 2c: dispatch a user's message to a SUB-AGENT session (chat.send to the
      // child key), arming the observer to capture the reply. Convex verifies IDOR.
      "/subagent-send",
      // Scheduled gateway jobs (crons) for the Settings › Scheduled tab. Convex
      // owns the user→agent policy; the bridge returns the instance's raw list.
      "/cron-list",
      // Scheduled-job management (get/runs/update/remove/run) — Convex owns
      // the ownership decision (op:"get" probe against the user's agents).
      "/cron-manage",
      // Background-task reconciliation (tasks.get by id) — the thread's
      // activity indicator verifies with the GATEWAY before expiring an
      // engagement instead of a blind timeout.
      "/tasks-probe",
      // Realtime voice: gateway-minted ephemeral browser session
      // (talk.client.create). Convex owns the user/chat authorization.
      "/talk-session",
      // Realtime voice: relay the voice model's agent-consult tool call to a
      // REAL agent run (talk.client.toolCall) and wait (bounded) for its final.
      "/talk-toolcall",
      // Sanctioned lossless-claw doctor dispatch (allowlisted commands only).
      "/lossless",
    ];
    if (req.method !== "POST" || !POST_ROUTES.includes(req.url ?? "")) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    // Auth: convex/bridge.ts sends the secret RAW in Authorization (no Bearer).
    const provided = req.headers["authorization"];
    if (
      typeof provided !== "string" ||
      !constantTimeEqual(provided, shared.bridgeSharedSecret)
    ) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    // REQUEST-ENTRY wall clock, taken BEFORE the body is read: a slow upload (or a
    // POST delayed while the Convex action was paused) is time the dispatch has been
    // in flight too, and the pre-send deadline must count it (codex P1).
    const requestReceivedMs = Date.now();
    let raw: string;
    try {
      raw = await readBody(req, shared.maxBodyBytes);
    } catch {
      // Structured `{error:{code}}` (like the 502 path) so Convex's readErrorCode
      // surfaces an honest cause instead of a generic failed dispatch. Normally
      // unreachable: the cap (32 MiB) clears Convex's 20 MiB-raw attachment ceiling.
      sendJson(res, 413, { ok: false, error: { code: "payload_too_large" } });
      return;
    }

    if (req.url === "/patch") {
      const patch = parsePatchBody(raw);
      if (patch === null) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const patchInstance = patch.instanceName;
      const patchBundle = patchInstance ? served.get(patchInstance) : undefined;
      if (!patchInstance || !patchBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      try {
        const session = await registry.acquire(toRouting(patch, patchInstance));
        await performPatch(session, patch, patchBundle.writer);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error("bridge /patch failed:", (err as Error)?.message ?? err);
        sendJson(res, 502, { ok: false, error: "upstream patch failed" });
      }
      return;
    }

    if (req.url === "/reset") {
      const reset = parseResetBody(raw);
      if (reset === null) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const resetInstance = reset.instanceName;
      const resetBundle = resetInstance ? served.get(resetInstance) : undefined;
      if (!resetInstance || !resetBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      // PANEL reset execution-time guard: the Convex busy checks (resetSession
      // + dispatchReset's probe) are schedule-time — a send racing them can
      // start a turn this /reset would kill. THIS is the atomic point: the
      // bridge holds the live per-chat turn state. Refuse; the panel's greyed
      // button + server refusal already cover the visible states, this closes
      // the last millisecond window. Regenerate resets never set the flag
      // (their turn is already terminal by construction). Hermes turns live in
      // hermesTurns (both transports), never in the SessionRegistry — check
      // all three surfaces (codex P1, pass 9).
      if (reset.refuseIfActive) {
        const live = registry.peekByChat(reset.chatId);
        if (
          (live !== undefined &&
            (live.runManager.turnActive || live.runManager.dispatchInFlight)) ||
          hermesTurns.peek(reset.chatId) !== undefined ||
          hermesTurns.peekWsTurn(reset.chatId) !== undefined
        ) {
          sendJson(res, 409, { ok: false, error: { code: "turn_active" } });
          return;
        }
      }
      if (resetBundle.config.kind === "hermes") {
        // Hermes: cancel any in-flight turn + forget the persisted session so
        // the next turn mints a fresh Hermes conversation. No operator socket.
        // A FAILED clear (Convex ingest down) must NOT report success — else
        // the regenerate would resume the old server context (codex P2).
        try {
          await performHermesReset(
            resetBundle.config,
            reset.chatId,
            hermesTurns,
            resetBundle.writer,
          );
          sendJson(res, 200, { ok: true });
        } catch (err) {
          console.error(
            "bridge /reset (hermes) failed:",
            (err as Error)?.message ?? err,
          );
          sendJson(res, 502, { ok: false, error: "upstream reset failed" });
        }
        return;
      }
      try {
        const session = await registry.acquire(toRouting(reset, resetInstance));
        // RE-CHECK after the acquire (codex P1, pass 12): a /send handled
        // concurrently can start a turn during the `await` above — the
        // pre-acquire peek missed it. From here to performReset there is no
        // further await before the abort flag, so this check is event-loop
        // atomic with the refusal decision.
        if (
          reset.refuseIfActive &&
          (session.runManager.turnActive || session.runManager.dispatchInFlight)
        ) {
          sendJson(res, 409, { ok: false, error: { code: "turn_active" } });
          return;
        }
        // A reset mid-delivery aborts the run too: flag it as USER-initiated
        // so the sink's delivery-run fold never repaints the interruption as
        // a completed merge (same contract as /abort — codex P2).
        session.runManager.noteUserAbort();
        await performReset(session);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error("bridge /reset failed:", (err as Error)?.message ?? err);
        sendJson(res, 502, { ok: false, error: "upstream reset failed" });
      }
      return;
    }

    if (req.url === "/abort") {
      // KILL the chat's active gateway run (the user's stop button). Same body
      // shape + session-key derivation as /reset. Like /compaction-history this
      // must NOT go through registry.acquire() (it re-keys/closes a live
      // session — the very turn being aborted); `chat.abort` is routed by
      // sessionKey server-side, so a SHORT dedicated operator connection kills
      // the run without touching the streaming session. Convex has already
      // finalized the message as aborted (optimistic stop); the gateway's
      // chat:aborted frame that follows finalizes idempotently.
      const abort = parseResetBody(raw);
      if (abort === null) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const abortInstance = abort.instanceName;
      const abortBundle = abortInstance ? served.get(abortInstance) : undefined;
      if (!abortInstance || !abortBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      if (abortBundle.config.kind === "hermes") {
        // Hermes: cancel the in-flight SSE turn + POST the server-side run stop.
        // Target THIS turn by the abort's runId (the assistant message carries
        // the Hermes run id) so a fast Stop→resend does not abort the new turn.
        let abortRunId: string | null = null;
        try {
          const o = JSON.parse(raw) as { runId?: unknown };
          if (typeof o.runId === "string" && o.runId) abortRunId = o.runId;
        } catch {
          /* best-effort: fall back to chat-only abort */
        }
        const stopped = await performHermesAbort(
          abortBundle.config,
          abort.chatId,
          hermesTurns,
          abortRunId,
        );
        // DURABLE FALLBACK, before the answer. The verdict's primary carrier is the
        // response — it rides Convex's guaranteed settle, which makes the drop atomic with
        // the aborted terminal (lot 31). But it is the ONLY carrier, and a response that
        // never arrives takes the drop with it: the bridge has already interrupted (or
        // failed to), the run may still be writing to the session, and Convex settles the
        // bubble without ever hearing about it (raised in review). So the bridge also
        // writes the clear itself.
        //
        // Applying twice is safe: the second clear finds an empty slot and only bumps the
        // epoch. Unconditional is safe HERE specifically because a turn was found live,
        // which means the message is still streaming and the chat still busy — the exact
        // premise `providerSessionClearPatch` states for its unconditional callers.
        await applyDurableSessionDrop(abortBundle.writer, abort.chatId, stopped);
        sendJson(res, 200, hermesAbortResponseBody(stopped));
        return;
      }
      try {
        // Prefer the EXACT session key of the streaming turn (Convex reads it
        // off the assistant row — per-turn routing/epoch included); derive from
        // the chat routing only for legacy rows without one.
        let explicitKey: string | null = null;
        let runId: string | null = null;
        try {
          const o = JSON.parse(raw) as Record<string, unknown>;
          if (typeof o.sessionKey === "string" && o.sessionKey) {
            explicitKey = o.sessionKey;
          }
          if (typeof o.runId === "string" && o.runId) {
            runId = o.runId;
          }
        } catch {
          /* parseResetBody already validated the body shape */
        }
        const sessionKey =
          explicitKey ??
          buildSessionKey(
            abort.openclawChatId ?? abort.chatId,
            abort.agentId,
            abort.canonical,
          );
        // Flag the live session BEFORE the kill: the gateway's chat:aborted
        // frame that follows is the USER'S stop — the sink's delivery-run
        // fold must not repaint it as complete (dispatchAbort is kill-THEN-
        // finalize, so Convex has not settled the message yet — codex P2).
        registry.peekByChat(abort.chatId)?.runManager.noteUserAbort();
        await withOperatorConnection(
          abortBundle.config,
          // With runId, the gateway cancels the NAMED run (immune to a newer
          // run having started on the session); without, the active one.
          (conn) => conn.request("chat.abort", chatAbortParams(sessionKey, runId)),
          noteHandshakeFor(abortInstance),
        );
        sendJson(res, 200, { ok: true });
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /abort failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/compaction-history") {
      // LAZY read (Inc 3): same body shape as /reset, hence the shared parser.
      // Never on the turn path — called on demand by the Convex /api/v1 route
      // (MCP debug). READ-ONLY, so it must NOT go through registry.acquire():
      // acquire re-keys (closes) an existing session whose key/instance differs
      // (the per-turn-routing epoch path) — a diagnostic read arriving MID-STREAM
      // would kill the in-flight turn (codex P2). Instead derive the session key
      // directly (the same derivation acquire uses) and read it over a SHORT
      // dedicated operator connection — zero interaction with live sessions.
      const hist = parseResetBody(raw);
      if (hist === null) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const histInstance = hist.instanceName;
      const histBundle = histInstance ? served.get(histInstance) : undefined;
      if (!histInstance || !histBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      try {
        const sessionKey = buildSessionKey(
          hist.openclawChatId ?? hist.chatId,
          hist.agentId,
          hist.canonical,
        );
        const history = await withOperatorConnection(
          histBundle.config,
          (conn) => fetchCompactionHistory(conn, sessionKey),
          noteHandshakeFor(histInstance),
        );
        sendJson(res, 200, { ok: true, ...history });
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /compaction-history failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/lossless") {
      // SANCTIONED lossless-claw doctor dispatch (the watcher agent's bounded
      // self-repair channel, 2026-07-20). The /lossless family is RUNTIME
      // slash-command only (no CLI — verified on 2026.7.1), and the gateway's
      // command layer DOES process commands arriving via chat.send (verified
      // live) — so this route sends ONE ALLOWLISTED command on a dedicated
      // maintenance session over a short operator connection, then polls the
      // session transcript for the command's reply. STRICT server-side
      // allowlist: the three read/safe-repair commands only (the doctor takes
      // its own backup before a repair and never touches needs-review lanes);
      // arbitrary command dispatch is deliberately impossible here.
      let lcmBody: {
        instanceName?: unknown;
        action?: unknown;
        agentId?: unknown;
      } = {};
      try {
        const parsed: unknown = JSON.parse(raw || "{}");
        // `null`/arrays are valid JSON but not a body (codex P2).
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          sendJson(res, 400, { ok: false, error: "invalid body" });
          return;
        }
        lcmBody = parsed as typeof lcmBody;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const LCM_COMMANDS: Record<string, string> = {
        status: "/lossless status",
        doctor: "/lossless doctor",
        repair_rollover_splits:
          "/lossless doctor apply rollover-splits confirm",
      };
      const lcmInstance =
        typeof lcmBody.instanceName === "string" ? lcmBody.instanceName : null;
      const lcmAction =
        typeof lcmBody.action === "string" ? lcmBody.action : null;
      // Own-property check: a bare index would resolve inherited names like
      // "constructor" to prototype members and slip past the allowlist (codex).
      const lcmCommand =
        lcmAction !== null &&
        Object.prototype.hasOwnProperty.call(LCM_COMMANDS, lcmAction)
          ? LCM_COMMANDS[lcmAction]
          : undefined;
      const lcmBundle = lcmInstance ? served.get(lcmInstance) : undefined;
      if (!lcmInstance || !lcmBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      if (lcmCommand === undefined) {
        sendJson(res, 400, {
          ok: false,
          error:
            "action must be one of: status | doctor | repair_rollover_splits",
        });
        return;
      }
      if (lcmBundle.config.kind === "hermes") {
        sendJson(res, 409, {
          ok: false,
          error: { code: "openclaw_only" },
        });
        return;
      }
      // Sanitized like every other session-key segment (safeSessionPart —
      // codex P2: a raw "team/foo" would target a malformed key).
      const lcmAgent = safeSessionPart(
        typeof lcmBody.agentId === "string" && lcmBody.agentId
          ? lcmBody.agentId
          : "meta",
      );
      // Dedicated maintenance session, UNIQUE PER INVOCATION (never an Atrium
      // chat's session): each command gets a fresh transcript holding exactly
      // one exchange, so concurrent calls can never read each other's reply
      // and no serialization is needed (codex P1). The gateway's idle-session
      // reaping collects these (a handful per day at the heartbeat cadence).
      const lcmSessionKey = `agent:${lcmAgent}:lossless:doctor-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      try {
        const result = await withOperatorConnection(
          lcmBundle.config,
          async (conn) => {
            // EXPLICIT budget so the whole route's worst case stays WELL
            // under the Convex caller's 150s timeout (codex P1): handshake
            // ≤30s + initial get ≤8s + send ≤15s + 6 polls ×(1.5s+8s) ≈110s.
            const countEntries = async (): Promise<number> => {
              try {
                const rawT = await conn.request(
                  "sessions.get",
                  sessionsGetParams(lcmSessionKey),
                  8_000,
                );
                const payload =
                  rawT && typeof rawT === "object" && "payload" in rawT
                    ? (rawT as { payload: unknown }).payload
                    : rawT;
                return transcriptEntryCount(payload);
              } catch {
                return 0; // fresh session — no transcript yet
              }
            };
            const before = await countEntries();
            await conn.request(
              "chat.send",
              lcmSendParams(lcmSessionKey, lcmCommand, Date.now()),
              15_000,
            );
            // The command layer answers synchronously gateway-side; poll the
            // transcript until the reply lands (bounded ~12s).
            for (let i = 0; i < 6; i++) {
              await new Promise((r) => setTimeout(r, 1_500));
              const rawT = await conn.request(
                "sessions.get",
                sessionsGetParams(lcmSessionKey),
                8_000,
              );
              const payload =
                rawT && typeof rawT === "object" && "payload" in rawT
                  ? (rawT as { payload: unknown }).payload
                  : rawT;
              if (transcriptEntryCount(payload) > before) {
                const reply = extractLatestAssistantReply(payload);
                if (reply) return reply;
              }
            }
            return null;
          },
          noteHandshakeFor(lcmInstance),
        );
        if (result === null) {
          sendJson(res, 504, { ok: false, error: { code: "reply_timeout" } });
          return;
        }
        // METADATA-ONLY out (codex P1): the raw reply can carry lane/session
        // excerpts (conversation-derived text) and the consuming API/MCP keys
        // hold selfheal without chat-content read — project to counters+flags.
        sendJson(res, 200, {
          ok: true,
          action: lcmAction,
          summary: summarizeLosslessReply(result),
        });
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /lossless failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/cron-list") {
      // LAZY read (Settings ▸ Personal ▸ Scheduled): the instance's cron jobs,
      // provider-neutral summaries. READ-ONLY — dedicated short operator
      // connection (OpenClaw) / the persistent ws client (Hermes); never the
      // per-chat session registry, never the turn path. Agent-level FILTERING
      // is Convex's job (it owns the instance-default knowledge).
      let cronBody: { instanceName?: unknown } = {};
      try {
        cronBody = JSON.parse(raw || "{}") as { instanceName?: unknown };
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const cronInstance =
        typeof cronBody.instanceName === "string"
          ? cronBody.instanceName
          : null;
      const cronBundle = cronInstance ? served.get(cronInstance) : undefined;
      if (!cronInstance || !cronBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      try {
        const jobs =
          cronBundle.config.kind === "hermes"
            ? await performHermesCronList(cronBundle.config, hermesTurns)
            : await withOperatorConnection(
                cronBundle.config,
                (conn) => fetchCronJobs(conn),
                noteHandshakeFor(cronInstance),
              );
        sendJson(res, 200, { ok: true, jobs });
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /cron-list failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/tasks-probe") {
      // Verify background-task engagements against the gateway's task
      // registry (`tasks.get`). READ-ONLY, short operator connection; a
      // gateway without the RPC (older version) fails soft — the caller
      // falls back to its local expiry.
      let probeBody: Record<string, unknown> = {};
      try {
        probeBody = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const pInstance =
        typeof probeBody.instanceName === "string"
          ? probeBody.instanceName
          : null;
      const pBundle = pInstance ? served.get(pInstance) : undefined;
      const pIds = Array.isArray(probeBody.taskIds)
        ? probeBody.taskIds
            .filter((t): t is string => typeof t === "string" && t !== "")
            // Matches the Convex sender's cap (pendingTaskEngagements take(20))
            // — a smaller cap here would starve tasks beyond it forever.
            .slice(0, 20)
        : [];
      if (!pInstance || !pBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      // DISCOVERY: list the registry's live tasks whose requesterSessionKey
      // is one of this chat's LIVE sessions — the only way to see a chain
      // link's next task (the gateway emits no tool frames on delivery runs,
      // so its ack never reaches the bridge). Registry truth, zero guessing:
      // no live session (e.g. bridge restarted) → honest empty answer.
      const discoverForChat =
        typeof probeBody.discoverForChat === "string" &&
        probeBody.discoverForChat !== ""
          ? probeBody.discoverForChat
          : null;
      const discoverKeys =
        discoverForChat !== null
          ? registry.sessionKeysForChat(discoverForChat)
          : [];
      if (
        pBundle.config.kind === "hermes" ||
        (pIds.length === 0 && discoverKeys.length === 0)
      ) {
        // No Hermes task registry — honest empty answer (caller keeps its cap).
        sendJson(res, 200, { ok: true, tasks: [], discovered: [] });
        return;
      }
      try {
        const { tasks, discovered, discoveryMeta } =
          await withOperatorConnection(
            pBundle.config,
            async (conn) => {
              // PARALLEL lookups on the multiplexed socket: a sequential batch
              // (10 ids x 10s worst case + a cold 30s connect) would blow past
              // the Convex client's 50s budget and lose EVERY already-fetched
              // status. Worst case here: connect + one 8s window.
              const settled = await Promise.all(
                pIds.map(async (taskId) => {
                  try {
                    const r = await conn.request(
                      "tasks.get",
                      taskGetParams(taskId),
                      8_000,
                    );
                    const task = (
                      r.payload as { task?: Record<string, unknown> }
                    )?.task;
                    return { taskId, ...projectTaskProbe(task) };
                  } catch (err) {
                    // DISTINGUISH the registry's explicit "task not found"
                    // (pinned: INVALID_REQUEST `task not found: <id>`) from a
                    // transient failure (timeout, drop, missing RPC on an old
                    // gateway): only the former may ever settle a row as lost —
                    // a transient error must leave the local state untouched,
                    // so the entry is OMITTED from the batch.
                    const msg = (err as Error)?.message ?? "";
                    if (/task not found/i.test(msg)) {
                      return {
                        taskId,
                        status: "not_found",
                        summary: null,
                        error: null,
                      };
                    }
                    return null;
                  }
                }),
              );
              const gets = settled.filter(
                (t): t is NonNullable<typeof t> => t !== null,
              );
              // Session-scoped discovery (best-effort: a gateway without the
              // RPC, or a transient failure, yields an empty list — the local
              // state stays untouched).
              let found: {
                taskId: string;
                status: string;
                toolName: string | null;
              }[] = [];
              // COUNTS-only diagnostics (no keys/content — SOC2): how many live
              // sessions matched the chat and how many records the registry
              // listed. A persistent {sessions:0} explains an empty discovery.
              let discoveryMeta: { sessions: number; listed: number } | null =
                null;
              if (discoverKeys.length > 0) {
                try {
                  // SERVER-side filters (TasksListParamsSchema, pinned from the
                  // gateway dist: sessionKey + status[] + limit): an unfiltered
                  // list is paginated (~100 oldest records) and NEVER contains
                  // the live link — the very task this discovery exists for.
                  // One request per live session key (normally exactly one).
                  let listedTotal = 0;
                  const records: Record<string, unknown>[] = [];
                  for (const key of discoverKeys.slice(0, 3)) {
                    const r = await conn.request(
                      "tasks.list",
                      taskListParams(key),
                      10_000,
                    );
                    const payload = r.payload as { tasks?: unknown[] } | null;
                    const list = Array.isArray(payload?.tasks)
                      ? payload.tasks
                      : [];
                    listedTotal += list.length;
                    for (const t of list) {
                      if (typeof t === "object" && t !== null) {
                        records.push(t as Record<string, unknown>);
                      }
                    }
                  }
                  discoveryMeta = {
                    sessions: discoverKeys.length,
                    listed: listedTotal,
                  };
                  // Known ids are excluded BEFORE the cap: with 10+ live tasks
                  // a stable-ordered list would otherwise return the same known
                  // entries forever and starve the new invisible link behind
                  // them (the gets batch already refreshes the known ones).
                  const known = new Set(pIds);
                  found = records
                    .filter((rec) => {
                      const id = rec.taskId ?? rec.id;
                      return (
                        (rec.status === "queued" || rec.status === "running") &&
                        typeof id === "string" &&
                        id !== "" &&
                        !known.has(id)
                      );
                    })
                    .slice(0, 10)
                    .map((rec) => ({
                      taskId: ((rec.taskId ?? rec.id) as string).slice(0, 80),
                      status: (rec.status as string).slice(0, 40),
                      // The chain key: the tool family. Pinned live shape:
                      // sourceId "image_generate:openai" (tool before ':'),
                      // summary `kind` ("image_generation") as the fallback.
                      toolName:
                        typeof rec.sourceId === "string" && rec.sourceId !== ""
                          ? rec.sourceId.split(":")[0]!.slice(0, 60)
                          : typeof rec.kind === "string" && rec.kind !== ""
                            ? rec.kind.slice(0, 60)
                            : null,
                    }));
                } catch (err) {
                  console.error(
                    "tasks-probe discovery failed (non-fatal):",
                    (err as Error)?.message ?? err,
                  );
                }
              }
              return { tasks: gets, discovered: found, discoveryMeta };
            },
            noteHandshakeFor(pInstance),
          );
        sendJson(res, 200, { ok: true, tasks, discovered, discoveryMeta });
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /tasks-probe failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/cron-manage") {
      // Scheduled-job MANAGEMENT (get/runs/update/remove/run). The caller is
      // Convex (shared-secret auth like every endpoint here); the OWNERSHIP
      // decision is Convex's (it probes op:"get" first and checks the job's
      // agent against the user's effective agents). The client patch is a
      // CLOSED field set (parseCronManagePatch) — never a raw gateway patch,
      // which could re-attribute the job via agentId/sessionKey.
      let manageBody: Record<string, unknown> = {};
      try {
        manageBody = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const mInstance =
        typeof manageBody.instanceName === "string"
          ? manageBody.instanceName
          : null;
      const mBundle = mInstance ? served.get(mInstance) : undefined;
      const mOp = typeof manageBody.op === "string" ? manageBody.op : null;
      const mJobId =
        typeof manageBody.jobId === "string" && manageBody.jobId !== ""
          ? manageBody.jobId
          : null;
      if (!mInstance || !mBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      if (!mOp || !mJobId) {
        sendJson(res, 400, { ok: false, error: { code: "invalid_request" } });
        return;
      }
      let mPatch: CronManagePatch | undefined;
      if (mOp === "update") {
        const parsed = parseCronManagePatch(manageBody.patch);
        if (parsed === null) {
          sendJson(res, 400, { ok: false, error: { code: "invalid_patch" } });
          return;
        }
        mPatch = parsed;
      }
      try {
        if (mBundle.config.kind === "hermes") {
          const r = await performHermesCronManage(mBundle.config, hermesTurns, {
            op: mOp,
            jobId: mJobId,
            ...(mPatch !== undefined ? { patch: mPatch } : {}),
          });
          if (r.ok) sendJson(res, 200, { ok: true });
          else if (r.code === "unsupported")
            sendJson(res, 501, { ok: false, error: { code: "unsupported" } });
          else sendJson(res, 502, { ok: false, error: { code: r.code } });
          return;
        }
        const result = await withOperatorConnection(
          mBundle.config,
          (conn) =>
            performOpenClawCronManage(conn, {
              op: mOp,
              jobId: mJobId,
              ...(mPatch !== undefined ? { patch: mPatch } : {}),
              ...(typeof manageBody.limit === "number"
                ? { limit: manageBody.limit }
                : {}),
            }),
          noteHandshakeFor(mInstance),
        );
        if (result.ok) sendJson(res, 200, result);
        else if (result.code === "not_found")
          sendJson(res, 404, { ok: false, error: { code: "not_found" } });
        else if (
          result.code === "unsupported" ||
          result.code === "invalid_patch"
        )
          sendJson(res, 400, { ok: false, error: { code: result.code } });
        else sendJson(res, 502, { ok: false, error: { code: result.code } });
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /cron-manage failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/compact") {
      // EXACT same body shape + session routing as /reset (chatId + per-turn
      // routing -> registry session key), hence the shared parser.
      const compact = parseResetBody(raw);
      if (compact === null) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const compactInstance = compact.instanceName;
      if (!compactInstance || !served.has(compactInstance)) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      try {
        const session = await registry.acquire(
          toRouting(compact, compactInstance),
        );
        const outcome = await performCompact(session);
        // A REFUSAL is not a server error (nothing broke) but it is not a success
        // either: 200 with the fact, and the caller decides what to tell the user.
        sendJson(res, 200, {
          ok: true,
          compacted: outcome.compacted,
          ...(outcome.reasonClass !== null
            ? { reasonClass: outcome.reasonClass }
            : {}),
        });
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /compact failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    // Phase 2c: the user's "Interagir" message -> a chat.send addressed to the CHILD
    // session key (verified live: the gateway routes it + the reply streams back on
    // the child lane). Convex's sendToSubAgent already re-derived + IDOR-checked the
    // target (child MUST belong to the owned chat); here we acquire the parent's
    // operator connection (which can address any sessionKey), ARM the observer to
    // capture the reply, then dispatch. The reply is recorded async by the observer.
    if (req.url === "/subagent-send") {
      let body: {
        instanceName?: string;
        agentId?: string;
        canonical?: string;
        chatId?: string;
        openclawChatId?: string | null;
        childSessionKey?: string;
        interactionId?: string;
        message?: string;
        // INLINE base64 attachments ({type,mimeType,fileName,content}) — same shape as
        // the main /send path. The child is WARM/resumed (context server-side), so the
        // frame is just {message + attachment}: NO rehydration, only the base64 guard.
        attachments?: unknown;
      };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }
      const saInstance = body.instanceName;
      if (!saInstance || !served.has(saInstance)) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      if (!body.childSessionKey || !body.interactionId || !body.message) {
        sendJson(res, 400, {
          ok: false,
          error: "childSessionKey + interactionId + message required",
        });
        return;
      }
      try {
        const session = await registry.acquire(
          toRouting(
            {
              chatId: body.chatId ?? "",
              openclawChatId: body.openclawChatId ?? null,
              agentId: body.agentId ?? "",
              canonical: body.canonical ?? "",
            } as never,
            saInstance,
          ),
        );
        // Arm BEFORE the send so a re-woken child's terminal is recognized as this
        // interaction's reply (the child is usually already reaped after its spawn).
        session.armSubAgentInteraction(
          body.childSessionKey,
          body.interactionId,
        );
        const saAtts = body.attachments;
        if (Array.isArray(saAtts) && saAtts.length > 0) {
          // Frame guard (mirror the main /send path): the attachment rides THIS
          // chat.send as inline base64 — reject an oversized frame BEFORE sending so
          // it never closes the gateway socket. Size by the SUM of base64 only.
          const base64Bytes = (saAtts as Array<{ content?: unknown }>).reduce(
            (sum, a) =>
              sum + (typeof a?.content === "string" ? a.content.length : 0),
            0,
          );
          const conn = session.connection;
          if (
            conn.maxPayload !== null &&
            !base64FitsFrame(base64Bytes, conn.maxPayload)
          ) {
            sendJson(res, 502, {
              ok: false,
              error: { code: "attachment_too_large" },
            });
            return;
          }
        }
        const saParams = subAgentSendParams(
          body.childSessionKey,
          body.message,
          body.interactionId,
          saAtts,
        );
        await session.connection.request("chat.send", saParams, 20_000);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /subagent-send failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/tts") {
      // Gateway TTS passthrough (OpenClaw tts.* RPC surface). Guarded like
      // /agent-files: only an instance THIS bridge serves, operator connection
      // per call. Body: {instanceName, method: "status"|"providers"|"convert",
      // text?} — convert returns whatever the gateway returns (shape probed
      // live; the Convex action normalizes).
      let parsedTts: {
        instanceName?: unknown;
        method?: unknown;
        text?: unknown;
      } = {};
      try {
        parsedTts = JSON.parse(raw) as typeof parsedTts;
      } catch {
        parsedTts = {};
      }
      const ttsInstance =
        typeof parsedTts.instanceName === "string"
          ? parsedTts.instanceName
          : "";
      const method =
        typeof parsedTts.method === "string" ? parsedTts.method : "";
      const ttsText = typeof parsedTts.text === "string" ? parsedTts.text : "";
      if (
        !ttsInstance ||
        !["status", "providers", "convert"].includes(method) ||
        (method === "convert" &&
          (ttsText.length === 0 || ttsText.length > 20_000))
      ) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const ttsBundle = served.get(ttsInstance);
      if (!ttsBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      if (ttsBundle.config.kind !== "openclaw") {
        // Hermes has no direct synthesize-and-return RPC (its voice.tts plays
        // on the gateway host) — state it instead of failing opaquely.
        sendJson(res, 400, {
          ok: false,
          error: { code: "provider_unsupported" },
        });
        return;
      }
      try {
        const result = await withOperatorConnection(
          ttsBundle.config,
          (conn) =>
            conn.request(
              `tts.${method}`,
              ttsParams(method, ttsText),
              method === "convert" ? 60_000 : 10_000,
            ),
          noteHandshakeFor(ttsInstance),
        );
        if (method !== "convert") {
          sendJson(res, 200, { ok: true, payload: result.payload ?? null });
          return;
        }
        // convert returns {audioPath} ON THE GATEWAY HOST (probed live) — pull
        // the bytes through the same gateway-http media channel the outbound
        // pipeline uses (probe → path-scoped ticket → stream), then answer
        // with base64 audio (TTS clips are small; no storage round-trip).
        const audioPath = (result.payload as { audioPath?: string } | undefined)
          ?.audioPath;
        if (!audioPath) {
          sendJson(res, 502, { ok: false, error: { code: "NO_AUDIO_PATH" } });
          return;
        }
        const fetcher = buildMediaFetcher(
          ttsBundle.config,
          "gateway-http",
          16 * 1024 * 1024,
        );
        const opened = fetcher ? await fetcher.open(audioPath) : null;
        if (!opened || !opened.ok) {
          sendJson(res, 502, {
            ok: false,
            error: { code: "AUDIO_FETCH_FAILED" },
          });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of opened.stream) {
          chunks.push(chunk as Buffer);
        }
        sendJson(res, 200, {
          ok: true,
          payload: {
            mime: opened.mimeType || "audio/mpeg",
            provider:
              (result.payload as { provider?: string }).provider ?? null,
            audioBase64: Buffer.concat(chunks).toString("base64"),
          },
        });
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /tts ${method} failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/talk-session") {
      // Realtime voice: mint an EPHEMERAL browser session on the gateway
      // (talk.client.create -> {clientSecret, offerUrl, model, voice,
      // expiresAt} — shape probed LIVE on 2026.7.1). The gateway holds the
      // provider key and mints the short-lived clientSecret; the bridge
      // relays the payload VERBATIM to Convex and NEVER logs it (it is a
      // provider credential, ephemeral but a credential). Convex owns the
      // user/chat authorization + the admin talk.enabled gate.
      let talkBody: {
        instanceName?: unknown;
        transport?: unknown;
        voice?: unknown;
        vadThreshold?: unknown;
      } = {};
      try {
        talkBody = JSON.parse(raw || "{}") as typeof talkBody;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const talkInstance =
        typeof talkBody.instanceName === "string"
          ? talkBody.instanceName
          : null;
      const talkBundle = talkInstance ? served.get(talkInstance) : undefined;
      if (!talkInstance || !talkBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      if (talkBundle.config.kind === "hermes") {
        // No talk surface on Hermes — honest code instead of an opaque RPC error.
        sendJson(res, 400, {
          ok: false,
          error: { code: "provider_unsupported" },
        });
        return;
      }
      // Only transports the gateway advertises; webrtc is the live-verified
      // default (the mint response shape was probed on it).
      const talkTransport =
        typeof talkBody.transport === "string" &&
        ["webrtc", "provider-websocket", "gateway-relay"].includes(
          talkBody.transport,
        )
          ? talkBody.transport
          : "webrtc";
      // Optional per-session VOICE (the composer's picker): forwarded verbatim
      // — the gateway normalizes against ITS voice allowlist (unknown values
      // fall back to the configured default, measured 2026.7.1).
      const talkVoice =
        typeof talkBody.voice === "string" && talkBody.voice !== ""
          ? talkBody.voice.slice(0, 60)
          : null;
      // Mic sensitivity (server_vad threshold, 0..1 exclusive) — the gateway
      // normalizes (asUnitInterval) and the provider defaults when absent.
      const talkVad =
        typeof talkBody.vadThreshold === "number" &&
        Number.isFinite(talkBody.vadThreshold) &&
        talkBody.vadThreshold > 0 &&
        talkBody.vadThreshold < 1
          ? talkBody.vadThreshold
          : null;
      try {
        const created = await withOperatorConnection(
          talkBundle.config,
          (conn) =>
            conn.request(
              "talk.client.create",
              talkClientCreateParams(talkTransport, talkVoice, talkVad),
              15_000,
            ),
          noteHandshakeFor(talkInstance),
        );
        const session = created.payload ?? null;
        if (session === null || typeof session !== "object") {
          sendJson(res, 502, { ok: false, error: { code: "talk_malformed" } });
          return;
        }
        sendJson(res, 200, { ok: true, session });
      } catch (err) {
        // A gateway without a CONFIGURED realtime provider errors here — the
        // classified code is the graceful "not ready" answer (the capability
        // gate is static/version-level by design). Message only: the error
        // never carries the secret, but keep the log minimal regardless.
        const code = classifyGatewayError(err);
        console.error(
          `bridge /talk-session failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/talk-toolcall") {
      // Realtime voice AGENT-CONSULT relay: the voice model asked (via the
      // browser's data channel) to delegate work to the chat's agent. The
      // gateway starts a REAL agent run on the chat's session
      // (talk.client.toolCall -> {runId}); this route then HOLDS its operator
      // connection open, feeding inbound frames through consultFrameOutcome
      // until the run's final/error or the deadline — the browser hands the
      // returned text back to the voice model (function_call_output) so it
      // SPEAKS the real result. Convex owns the user/chat authorization and
      // passes the resolved routing (never client-supplied).
      let tcBody: {
        instanceName?: unknown;
        chatId?: unknown;
        openclawChatId?: unknown;
        canonical?: unknown;
        agentId?: unknown;
        callId?: unknown;
        args?: unknown;
      } = {};
      try {
        tcBody = JSON.parse(raw || "{}") as typeof tcBody;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const tcStr = (v: unknown): string | null =>
        typeof v === "string" && v !== "" ? v : null;
      const tcInstance = tcStr(tcBody.instanceName);
      const tcChatId = tcStr(tcBody.chatId);
      const tcCanonical = tcStr(tcBody.canonical);
      const tcAgentId = tcStr(tcBody.agentId);
      const tcCallId = tcStr(tcBody.callId);
      const tcArgs =
        tcBody.args !== null && typeof tcBody.args === "object"
          ? (tcBody.args as Record<string, unknown>)
          : null;
      const tcBundle = tcInstance ? served.get(tcInstance) : undefined;
      if (!tcInstance || !tcBundle) {
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      if (tcBundle.config.kind === "hermes") {
        sendJson(res, 400, {
          ok: false,
          error: { code: "provider_unsupported" },
        });
        return;
      }
      if (!tcChatId || !tcCanonical || !tcAgentId || !tcCallId || !tcArgs) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const tcSessionKey = buildSessionKey(
        tcStr(tcBody.openclawChatId) ?? tcChatId,
        tcAgentId,
        tcCanonical,
      );
      // The consult is a real agent turn: it can run long. The VOICE hold is
      // bounded (on deadline the caller reports "still working" to the voice
      // model); the THREAD writer below is DETACHED from this response and
      // keeps streaming the turn to its true terminal.
      const CONSULT_HOLD_MS = 90_000;
      const CONSULT_THREAD_MS = 10 * 60_000;
      // started: the toolCall RPC settled (runId or error) — gates the HTTP
      // status. terminal: the run's true outcome — raced against the voice
      // hold; the detached writer keeps going after a "pending" response.
      let resolveStarted!: (
        v: { ok: true; runId: string } | { ok: false; code: string },
      ) => void;
      let resolveTerminal!: (v: {
        resultText?: string;
        errorText?: string;
      }) => void;
      const started = new Promise<
        { ok: true; runId: string } | { ok: false; code: string }
      >((r) => (resolveStarted = r));
      const terminal = new Promise<{ resultText?: string; errorText?: string }>(
        (r) => (resolveTerminal = r),
      );
      // DETACHED consult driver: relays the tool call, then owns the thread
      // bubble end-to-end — created IMMEDIATELY (the user sees an in-progress
      // turn while the voice says "checking" — user feedback 2026-07-16),
      // deltas streamed, finalized at the true terminal. Never throws.
      void (async () => {
        try {
          await withOperatorConnection(
            tcBundle.config,
            async (conn) => {
              const created = await conn.request(
                "talk.client.toolCall",
                talkToolCallParams(tcSessionKey, tcCallId, tcArgs),
                15_000,
              );
              const runId = (created.payload as { runId?: unknown } | undefined)
                ?.runId;
              if (typeof runId !== "string" || runId === "") {
                resolveStarted({ ok: false, code: "talk_malformed" });
                return;
              }
              // The relay owns this run's thread bubble (a voice-first chat
              // has no warm session consumer). Claimed for the run's LIFETIME
              // — a warm session never double-writes, and a gateway retransmit
              // after the final stays inert (the claim set is size-bounded).
              claimTalkRun(runId);
              resolveStarted({ ok: true, runId });
              // SAME IMPLEMENTATION as a typed turn (user requirement: a
              // change to tool/media/reasoning handling must apply to voice
              // consults automatically): a relay-local RunManager drives the
              // full normalizer/sink pipeline. beginTurn(runId) opens the
              // bubble IMMEDIATELY (in-progress indicator) and seeds
              // ownRunIds so the consult streams first-class. The finalize
              // observer captures the terminal for the VOICE reply.
              let settled = false;
              const facade = observeFinalize(
                tcBundle.writer,
                (status, text, error) => {
                  settled = true;
                  if (status === "complete") {
                    resolveTerminal({ resultText: text });
                  } else {
                    resolveTerminal({ errorText: error ?? status });
                  }
                },
              );
              const manager = new RunManager(tcChatId, tcSessionKey, facade);
              const nowSec = () => Date.now() / 1000;
              await manager.beginTurn(nowSec(), runId);
              const deadline = Date.now() + CONSULT_THREAD_MS;
              const it = conn.frames()[Symbol.asyncIterator]();
              while (!settled && Date.now() < deadline) {
                const remaining = deadline - Date.now();
                const raced = await Promise.race([
                  it.next(),
                  new Promise<"timeout">((r) =>
                    setTimeout(() => r("timeout"), remaining),
                  ),
                ]);
                if (raced === "timeout") break;
                if (raced.done) break; // connection closed under us
                await manager.feed(raced.value, nowSec());
              }
              if (!settled) {
                // Deadline / connection closed with no terminal: the message
                // (if opened) is reconciled by the stuck-stream watchdog; the
                // voice reports the work as still running.
                resolveTerminal({ errorText: "timeout" });
              }
            },
            noteHandshakeFor(tcInstance),
          );
        } catch (err) {
          const code = classifyGatewayError(err);
          console.error(
            `bridge /talk-toolcall failed [${code}]:`,
            (err as Error)?.message ?? err,
          );
          resolveStarted({ ok: false, code });
          resolveTerminal({ errorText: code });
        }
      })();
      const startRes = await started;
      if (!startRes.ok) {
        sendJson(res, 502, { ok: false, error: { code: startRes.code } });
        return;
      }
      const voiceRaced = await Promise.race([
        terminal,
        new Promise<"pending">((r) =>
          setTimeout(() => r("pending"), CONSULT_HOLD_MS),
        ),
      ]);
      if (voiceRaced === "pending") {
        // The voice tells the user the work continues; the DETACHED writer
        // keeps streaming the thread bubble to its real terminal.
        sendJson(res, 200, { ok: true, pending: true, runId: startRes.runId });
        return;
      }
      sendJson(res, 200, { ok: true, ...voiceRaced, runId: startRes.runId });
      return;
    }
    if (req.url === "/agent-files") {
      const body = parseAgentFilesBody(raw);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const afInstance = body.instanceName;
      const afBundle = afInstance ? served.get(afInstance) : undefined;
      if (!afInstance || !afBundle) {
        // Never answer for an instance this bridge does not serve.
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      try {
        // Hermes: the identity files live at the agent home root, served by the
        // gateway's managed-files API (no operator socket).
        const result =
          afBundle.config.kind === "hermes"
            ? await performHermesAgentFilesOp(
                afBundle.config,
                hermesTurns,
                body,
                AGENT_FILE_NAMES,
              )
            : await withOperatorConnection(
                afBundle.config,
                (conn) => performAgentFilesOp(conn, body),
                noteHandshakeFor(afInstance),
              );
        sendJson(res, result.status, result.body);
      } catch (err) {
        const code = classifyGatewayError(err);
        console.error(
          `bridge /agent-files ${body.op} failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/config-defaults") {
      const body = parseConfigDefaultsBody(raw);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const cdInstance = body.instanceName;
      const cdBundle = cdInstance ? served.get(cdInstance) : undefined;
      if (!cdInstance || !cdBundle) {
        // Refuse a body that claims an instance this bridge does not serve.
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      try {
        const result = await withOperatorConnection(
          cdBundle.config,
          (conn) => performConfigDefaultsOp(conn, body),
          noteHandshakeFor(cdInstance),
        );
        sendJson(res, result.status, result.body);
      } catch (err) {
        const code = classifyGatewayError(err);
        if (
          LOST_RESPONSE_CODES.has(code) &&
          (body.op === "set" || body.op === "clear")
        ) {
          // The patch may have APPLIED and only the response was lost to a
          // config-triggered gateway restart — reconnect and confirm before
          // reporting failure (see confirmDefaultsAfterRestart).
          const confirmed = await confirmDefaultsAfterRestart(
            cdBundle.config,
            body,
          );
          if (confirmed !== null) {
            console.error(
              "bridge /config-defaults: write confirmed after gateway restart",
            );
            sendJson(res, 200, {
              ok: true,
              defaults: confirmed,
              gatewayRestarted: true,
            });
            return;
          }
        }
        if (
          code === "INVALID_REQUEST" &&
          (body.op === "set" || body.op === "clear")
        ) {
          // The config.patch params shape ({raw, baseHash}) is bench-verified
          // on 2026.6.5 — an INVALID_REQUEST here most likely means the shape
          // drifted on a NEWER gateway version. Precise operator hint, non-PHI.
          console.error(
            "bridge /config-defaults: gateway rejected config.patch — " +
              "re-verify the {raw, baseHash} params shape against this gateway version",
          );
        }
        console.error(
          `bridge /config-defaults ${body.op} failed [${code}]:`,
          (err as Error)?.message ?? err,
        );
        sendJson(res, 502, { ok: false, error: { code } });
      }
      return;
    }

    if (req.url === "/validate-media") {
      // Bridge-side shared-fs access check (the "Valider" button). Confirms the
      // bridge can WRITE its inbound dir + READ its outbound dir for the legs in
      // shared-fs mode. There is no gateway fs API, so the AGENT-side container
      // mount is NOT checked here (the response notes this). NON-secret.
      let mvBody: {
        instanceName?: unknown;
        inboundMediaMode?: unknown;
        mediaMode?: unknown;
      };
      try {
        mvBody = JSON.parse(raw) as typeof mvBody;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const mvInstance =
        typeof mvBody.instanceName === "string" ? mvBody.instanceName : null;
      const mvBundle = mvInstance ? served.get(mvInstance) : undefined;
      if (!mvBundle) {
        // The dirs to check are per-instance — refuse without a served instance.
        sendJson(res, 409, {
          ok: false,
          error: { code: "instance_not_served" },
        });
        return;
      }
      const result = await validateSharedFs({
        inboundDir: mvBundle.config.inboundMediaDir,
        outboundDir: mvBundle.config.mediaOutboundDir,
        inboundSharedFs: mvBody.inboundMediaMode === "shared-fs",
        outboundSharedFs: mvBody.mediaMode === "shared-fs",
        now: Date.now(),
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // The pre-send deadline is measured from REQUEST ENTRY (above), which precedes
    // both the body read and any provider/session work — every one of those can be
    // where a paused or blocked bridge loses its minutes.
    const sendReceivedMs = requestReceivedMs;
    const body = parseSendBody(raw);
    if (body === null) {
      sendJson(res, 400, { ok: false, error: "invalid body" });
      return;
    }
    const sendInstance = body.instanceName;
    const bundle = sendInstance ? served.get(sendInstance) : undefined;
    if (!sendInstance || !bundle) {
      // A Convex routing misconfig (claims an instance this bridge does not
      // serve, or none) — refuse loudly with a curated code, never answer from the
      // wrong gateway. Convex surfaces it as a failed dispatch (errorCode).
      sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
      return;
    }
    const cfg = bundle.config;

    // Non-PHI routed-target record (agent/instance/canonical/chat are non-secret
    // names — never the text/token): the operational "which agent did this turn
    // route to" line, and the live-e2e discriminator for the body-routing fix.
    console.log(
      `bridge /send routed instance=${sendInstance} ` +
        `agent=${body.agentId} canonical=${body.canonical} chat=${body.chatId}`,
    );

    try {
      // Apply the per-instance config IN-BAND before the turn runs (D-B: per-instance
      // last-write-wins). Rebuilds THIS instance's outbound media fetcher only if the
      // mode/cap changed; the rehydration knob is read inside performSend.
      bundle.mediaProvider.applyConfig(body.config);
      // Shared-fs inbound config: dirs are derived per-instance, the cap is hot
      // (body.config.mediaMaxMb → mediaMaxBytes, else the per-instance default).
      const inboundCfg: InboundMediaConfig = {
        // The bridge WRITES to its own mount; the agent READS at the agent-mount
        // (per-instance override, else the instance default). These differ when
        // bridge + gateway mount the shared volume at different points.
        inboundDir: cfg.inboundMediaDir,
        agentMount: body.config?.inboundAgentMount ?? cfg.inboundAgentMount,
        maxBytes: body.config?.mediaMaxBytes ?? cfg.mediaMaxBytes,
      };
      // Inject the outbound delivery instruction unless outbound media is OFF (then
      // a generated file could not be hosted anyway). Effective mode = the in-band
      // per-instance config, else this instance's default. The delivery path is the
      // AGENT-visible outbound mount (where the agent WRITES) — NOT the bridge's read
      // dir (which may be a host path the container can't write).
      const effectiveMediaMode = body.config?.mediaMode ?? cfg.mediaMode;
      const deliveryDir =
        effectiveMediaMode === "off"
          ? null
          : (body.config?.outboundAgentMount ?? cfg.mediaOutboundAgentMount);
      if (cfg.kind === "hermes") {
        // Hermes: the WS transport STAGES inline attachments via the gateway's
        // file.attach / image.attach_bytes RPCs before the prompt; the REST
        // transport has no upload channel — refuse there with an actionable
        // code rather than silently dropping the file (codex P2). Shared-fs
        // reference attachments have no Hermes leg on either transport.
        const isWs = (cfg.transport ?? "ws") === "ws";
        const inline = Array.isArray(body.attachments)
          ? (body.attachments as Array<Record<string, unknown>>)
              .map((a) => ({
                mimeType: typeof a.mimeType === "string" ? a.mimeType : "",
                fileName:
                  typeof a.fileName === "string" && a.fileName
                    ? a.fileName
                    : "fichier",
                content: typeof a.content === "string" ? a.content : "",
              }))
              .filter((a) => a.content !== "")
          : [];
        if (
          (!isWs && inline.length > 0) ||
          body.referenceAttachments.length > 0
        ) {
          sendJson(res, 502, {
            ok: false,
            error: { code: "ATTACHMENT_REJECTED" },
          });
          return;
        }
        // A turn erroring AFTER acceptance (the background drain) counts as a
        // downstream failure on this target's stats. An error that lands BEFORE
        // this handler's recordOk below (a microtask race: accepted resolves,
        // the drain fails immediately) is DEFERRED past it — recordOk clears
        // lastDownstreamReject by design (a clean send makes a PRIOR note
        // stale), which would wipe this concurrent error's detail (codex P3).
        let ackRecorded = false;
        let earlyTurnError: string | null = null;
        const reportTurnError = (code: string) => {
          if (ackRecorded) {
            health.recordTurnError(
              targetRef(body.agentId, body.canonical, sendInstance),
              code,
            );
          } else {
            earlyTurnError = code;
          }
        };
        await performHermesSend(
          cfg,
          bundle.writer,
          { ...body, attachments: inline },
          hermesTurns,
          reportTurnError,
          sendReceivedMs,
        );
        // A real send proves connection + the ROUTED agent answered.
        health.recordOk(targetRef(body.agentId, body.canonical, sendInstance));
        ackRecorded = true;
        if (earlyTurnError !== null) reportTurnError(earlyTurnError);
        sendJson(res, 200, { ok: true });
        return;
      }
      const session = await registry.acquire(toRouting(body, sendInstance));
      await performSend(
        session,
        body,
        bundle.writer,
        inboundCfg,
        deliveryDir,
        sendReceivedMs,
      );
      // A real send proves connection + the ROUTED agent answered.
      health.recordOk(targetRef(body.agentId, body.canonical, sendInstance));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      // A per-send upstream failure is reported but does not crash the bridge.
      // Classify into a stable, non-PHI code: the RAW message stays in this log
      // only; only `error.code` crosses to Convex (the platform forbids shipping
      // raw message text). Convex maps the code to the user/admin surfaces.
      // Pass hasAttachments so an attachment-turn failure is classified as an
      // ATTACHMENT_* cause (the gateway's parse/stage overflow surfaces only as a
      // generic INVALID_REQUEST otherwise).
      const code = classifyGatewayError(err, {
        hasAttachments:
          Array.isArray(body.attachments) && body.attachments.length > 0,
      });
      // Route by fault domain (see dispatch-errors.faultDomain): a DOWNSTREAM
      // rejection (the gateway received + refused the request — e.g. an
      // attachment it could not parse) proves the bridge reached its gateway, so
      // it must NOT mark the bridge unhealthy. Only a BRIDGE-domain failure
      // (can't reach/auth the gateway) flips the target to `error`. Either way the
      // 502 + code below still drive the per-chat failDispatch bubble, the trace,
      // and the anomaly — the detail/alert path is unchanged.
      const ref = targetRef(body.agentId, body.canonical, sendInstance);
      if (faultDomain(code) === "downstream") {
        health.recordDownstreamReject(ref, code);
      } else {
        health.recordError(ref, code);
      }
      console.error(
        `bridge /send failed [${code}]:`,
        (err as Error)?.message ?? err,
      );
      sendJson(res, 502, { ok: false, error: { code } });
    }
  }
}
