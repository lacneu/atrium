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
import { classifyGatewayError, faultDomain } from "./core/dispatch-errors.js";
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
import { buildSessionKey } from "./providers/openclaw/session-keys.js";
import { validateSharedFs } from "./core/media-validate.js";
import {
  gatewayHostOf,
  type HealthRegistry,
  type HealthSnapshot,
  type TargetHealth,
  type TargetRef,
} from "./core/health.js";
import {
  BRIDGE_VERSION,
  COMPAT_MANIFEST,
  PROTOCOL_VERSION,
  resolveCapabilities,
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
  text: string;
  clientMessageId: string;
  /** The user message id for this turn (excluded from re-hydration history). */
  messageId: string | null;
  /** The OUTBOX id of this dispatch — echoed as the `openclaw.rehydrate` trace's
   *  correlationId (`chatId:outboxId`), the obs-MCP join key. Null on an old Convex. */
  outboxId: string | null;
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
    text: obj.text,
    clientMessageId: obj.clientMessageId,
    messageId: typeof obj.messageId === "string" ? obj.messageId : null,
    outboxId: typeof obj.outboxId === "string" ? obj.outboxId : null,
    switchedFromAgentId:
      typeof obj.switchedFromAgentId === "string" ? obj.switchedFromAgentId : null,
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
  | "skip_warm";
export function rehydrationDecision(opts: {
  freshSession: boolean;
  hasAttachments: boolean;
  enabled: boolean;
}): RehydrationDecision {
  if (!opts.enabled) return "skip_disabled";
  if (!opts.freshSession) return "skip_warm";
  if (opts.hasAttachments) return "skip_attachment"; // can't prepend history here
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
      const o = m as { id?: unknown; name?: unknown };
      const id = typeof o?.id === "string" ? o.id : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label =
        typeof o?.name === "string" && o.name.length > 0 ? o.name : id;
      out.push({ id, label });
    }
  }
  return out;
}

async function ensureAvailableModels(
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

async function performSend(
  session: BridgeSession,
  body: SendBody,
  writer: ConvexWriter,
  inbound: InboundMediaConfig | null,
  // Outbound media dir for the delivery instruction (how the agent makes a
  // generated file downloadable: write it here + emit `MEDIA:<path>`). Null when
  // outbound media is disabled (mode "off") — then no instruction is injected.
  deliveryDir: string | null,
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
  // Whether THIS send prepended rehydration history (function-scope: read by
  // the post-ack beginTurn in the LATER try block for the processing_history phase).
  let turnWasRehydrated = false;
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
      preSendSessionId =
        typeof sess.sessionId === "string" && sess.sessionId
          ? sess.sessionId
          : null;
      preTurnTotalTokens =
        typeof sess.totalTokens === "number" && Number.isFinite(sess.totalTokens)
          ? sess.totalTokens
          : null;
      preTurnContextTokens =
        typeof sess.contextTokens === "number" &&
        Number.isFinite(sess.contextTokens)
          ? sess.contextTokens
          : null;
      // Session-cumulative cost from the SAME describe (the gateway never
      // emits `usage` on chat events — live capture 2026-07-03 — so this is
      // the real per-turn cost source: consecutive traces' deltas).
      preTurnCostUsd =
        typeof sess.estimatedCostUsd === "number" &&
        Number.isFinite(sess.estimatedCostUsd)
          ? sess.estimatedCostUsd
          : null;
    }

    // (a) Mirror LIVE session meta onto the chat for the header strip (model +
    // reasoning chips + context meter). Fire-and-forget — never blocks/fails the
    // send. NOTE: this `describe` runs BEFORE the turn's reply, so the meter
    // reflects the session as of the LAST COMPLETED turn (a one-turn lag). A v2
    // could re-describe after finalize for during-turn accuracy.
    if (sess) {
      const models = await ensureAvailableModels(conn);
      void writer
        .reportSessionMeta(body.chatId, parseSessionMeta(sess, models))
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
    const decision = rehydrationDecision({
      freshSession,
      hasAttachments: hasInlineAttachments,
      enabled: rehydrationEnabled,
    });
    let prependedTurns = 0;
    let summaryUsed = false;
    let summaryChars = 0;
    if (decision === "skip_attachment") {
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
      if (ctx.history) {
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
    });
  } catch (err) {
    console.error(
      "[rehydrate] skipped (non-fatal):",
      (err as Error)?.message ?? err,
    );
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
    if (conn.maxPayload !== null && !base64FitsFrame(base64Bytes, conn.maxPayload)) {
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
      pressure: {
        totalTokens: preTurnTotalTokens,
        contextTokens: preTurnContextTokens,
        costUsd: preTurnCostUsd,
      },
      rehydrated: turnWasRehydrated,
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
    session.runManager.disarmReplayBuffer(session.clock(), () => session.wake());
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
async function performCompact(session: BridgeSession): Promise<void> {
  await session.connection.request(
    "sessions.compact",
    { key: session.sessionKey },
    60_000,
  );
}

/**
 * LAZY compaction history for one chat's gateway session (Inc 3 — never called
 * on the turn path): `sessions.compaction.list`, shaped CONTENT-FREE. Each
 * checkpoint's stored `summary` (real conversation content) is deliberately
 * DROPPED here — only structural facts cross this API: when, why, and how many
 * tokens the compaction condensed. Checkpoint shape pinned on live capture
 * 2026-07-03 (reason "auto-threshold", tokensBefore 19698 → tokensAfter 1050).
 */
async function fetchCompactionHistory(
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
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      checkpointId: str(c.checkpointId),
      createdAt: num(c.createdAt),
      reason: str(c.reason),
      tokensBefore: num(c.tokensBefore),
      tokensAfter: num(c.tokensAfter),
    }));
  return { count: checkpoints.length, checkpoints };
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
  body: Extract<ConfigDefaultsBody, { op: "set" }>,
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
async function discoverAgents(
  config: BridgeConfig,
  onHandshake?: (conn: OpenClawConnection) => void,
): Promise<{
  agents: NormalizedAgent[];
  rawCount: number;
  usage: ProviderUsage[] | null;
}> {
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
      if (typeof label !== "string" || typeof usedPercent !== "number") continue;
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
  provider: "openclaw";
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
export function buildCapabilityTargets(
  live: LiveTarget[],
  instanceName: string | null,
  fallbackVersion: string | null = null,
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
    const resolved = resolveCapabilities("openclaw", effectiveVersion);
    const target: CapabilityTarget = {
      key: t.canonical,
      instanceName,
      provider: "openclaw",
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
    fallbackVersion &&
    !targets.some((t) => t.instanceName === instanceName)
  ) {
    const resolved = resolveCapabilities("openclaw", fallbackVersion);
    const synthetic: CapabilityTarget = {
      key: instanceName,
      instanceName,
      provider: "openclaw",
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
    gw === null
      ? null
      : httpBodyCap === null
        ? gw
        : Math.min(gw, httpBodyCap);
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
  const noteGatewayVersion = (instanceName: string, v: string | null): void => {
    if (typeof v === "string" && v.length > 0) lastGatewayVersion.set(instanceName, v);
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
          if (lastGatewayVersion.has(name) || live.some((t) => t.instanceName === name))
            return;
          let inflight = versionDiscoveryInFlight.get(name);
          if (!inflight) {
            inflight = discoverAgents(bundle.config, noteHandshakeFor(name))
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
              const timer = setTimeout(resolve, CAPABILITIES_DISCOVERY_BUDGET_MS);
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
          lastGatewayVersion.get(name) ?? bundle.config.gatewayVersionFallback ?? null,
        ),
      );
      const names = [...served.keys()];
      const soleName = names.length === 1 ? names[0] : null;
      const soleVersion = soleName
        ? (lastGatewayVersion.get(soleName) ??
          served.get(soleName)!.config.gatewayVersionFallback ??
          null)
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
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
        return;
      }
      try {
        const { agents, rawCount, usage } = await discoverAgents(
          bundle.config,
          noteHandshakeFor(instanceName!),
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
        void discoverAgents(bundle.config, noteHandshakeFor(instanceName!)).catch(
          (err) => {
            console.log(
              `[refresh] discovery connect for ${instanceName} (non-fatal):`,
              (err as Error)?.message ?? err,
            );
          },
        );
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
      "/validate-media",
      // Phase 2c: dispatch a user's message to a SUB-AGENT session (chat.send to the
      // child key), arming the observer to capture the reply. Convex verifies IDOR.
      "/subagent-send",
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
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
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
      if (!resetInstance || !served.has(resetInstance)) {
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
        return;
      }
      try {
        const session = await registry.acquire(toRouting(reset, resetInstance));
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
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
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
        await withOperatorConnection(
          abortBundle.config,
          // With runId, the gateway cancels the NAMED run (immune to a newer
          // run having started on the session); without, the active one.
          (conn) =>
            conn.request("chat.abort", {
              sessionKey,
              ...(runId ? { runId } : {}),
            }),
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
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
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
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
        return;
      }
      try {
        const session = await registry.acquire(toRouting(compact, compactInstance));
        await performCompact(session);
        sendJson(res, 200, { ok: true });
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
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
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
        session.armSubAgentInteraction(body.childSessionKey, body.interactionId);
        const saParams: Record<string, unknown> = {
          sessionKey: body.childSessionKey,
          message: body.message,
          // Stable per interaction so a dispatch retry dedupes at the gateway.
          idempotencyKey: `interaction-${body.interactionId}`,
        };
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
          saParams.attachments = saAtts;
        }
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
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
        return;
      }
      try {
        const result = await withOperatorConnection(
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
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
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
        if (code === "GATEWAY_DISCONNECTED" && body.op === "set") {
          // The patch may have APPLIED and only the response was lost to a
          // config-triggered gateway restart — reconnect and confirm before
          // reporting failure (see confirmDefaultsAfterRestart).
          const confirmed = await confirmDefaultsAfterRestart(cdBundle.config, body);
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
        if (code === "INVALID_REQUEST" && body.op === "set") {
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
        sendJson(res, 409, { ok: false, error: { code: "instance_not_served" } });
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
      const session = await registry.acquire(toRouting(body, sendInstance));
      await performSend(session, body, bundle.writer, inboundCfg, deliveryDir);
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
