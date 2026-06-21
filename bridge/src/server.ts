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

import type { BridgeConfig } from "./config.js";
import {
  idempotencyKey,
  OpenClawConnection,
} from "./providers/openclaw/openclaw-client.js";
import { classifyGatewayError, faultDomain } from "./core/dispatch-errors.js";
import { base64FitsFrame } from "./core/attachment-limits.js";
import { MediaFetcherProvider } from "./core/media-fetcher-provider.js";
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
import { buildDeliveryInstruction } from "./core/outbound-delivery.js";
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
import type { ConvexWriter, SessionMetaReport } from "./convex-writer.js";
import type {
  SessionRegistry,
  BridgeSession,
  SessionRouting,
  LiveTarget,
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
): SessionRouting {
  return {
    chatId: b.chatId,
    openclawChatId: b.openclawChatId,
    agentId: b.agentId,
    canonical: b.canonical,
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
  try {
    const desc = await conn.request(
      "sessions.describe",
      { key: sessionKey },
      8_000,
    );
    const sess = (
      desc.payload as { session?: Record<string, unknown> } | undefined
    )?.session;

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
    const freshSession = !sess || sess.systemSent === false;
    const decision = rehydrationDecision({
      freshSession,
      hasAttachments: hasInlineAttachments,
      enabled: rehydrationEnabled,
    });
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
        // Decision log (no PHI — counts + chatId only).
        console.error(
          `[rehydrate] chat=${body.chatId} fresh session -> prepended ${ctx.turnCount} prior turn(s)`,
        );
      }
    }
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
    const block = buildFilesReceivedBlock(staged);
    if (block.length > 0) message = message ? `${message}\n${block}` : block;
  }

  // Outbound delivery contract (gateway-visible only): tell the agent how to make
  // a generated file DOWNLOADABLE in this webchat (write to the outbound dir + emit
  // `MEDIA:<path>`). Without it the agent writes a markdown link to a local path
  // that the webchat can't host → "I couldn't attach it" (the reported bug). Mirror
  // of the proven OpenWebUI pipe. Skipped when outbound media is off.
  if (deliveryDir !== null) {
    const delivery = buildDeliveryInstruction(deliveryDir);
    message = message ? `${message}\n${delivery}` : delivery;
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
    const ackRunId = extractRunId(response);
    await session.runManager.beginTurn(now, ackRunId);
  } catch (err) {
    // ANY failure in the armed send→turn-start window: chat.send rejected (e.g. the
    // gateway refused the attachment), OR beginTurn threw AFTER the ack (e.g. its
    // startAssistant write hit the Convex write timeout). The buffer is still armed
    // either way — disarm it (idempotent) so no armed window lingers buffering stray
    // frames until the next send. Then re-throw for the /send handler to classify +
    // report — a failed turn must NEVER wedge the session (bridge robustness #1).
    session.runManager.disarmReplayBuffer();
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
): Promise<{ agents: NormalizedAgent[]; rawCount: number }> {
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
    return { agents, rawCount: list.length };
  } finally {
    conn.close();
  }
}

/** Static provider capabilities for a mono-tenant OpenClaw bridge. Mirrors the
 *  ground truth in docs/OPENCLAW_RESEARCH.md (abort synthesized, no chat.history).
 *  Phase 2 sources this per-instance from the provider abstraction. */
function openclawCapabilities() {
  return {
    kind: "openclaw" as const,
    agentDiscovery: true,
    abort: false,
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
  targets: (TargetHealth & { gatewayVersion: string | null })[];
}

export function enrichHealthSnapshot(
  snapshot: HealthSnapshot,
  live: LiveTarget[],
  fallbackMaxPayload: number | null = null,
  httpBodyCap: number | null = null,
): EnrichedHealthSnapshot {
  const versionByCanonical = new Map<string, string | null>();
  for (const t of live) versionByCanonical.set(t.canonical, t.gatewayVersion);
  // Mono-tenant: every live session shares the one gateway's maxPayload — take the
  // first non-null, else the last-seen fallback (so an idle poll still reports it).
  const gatewayMaxPayload =
    (live.find((t) => t.maxPayload !== null)?.maxPayload ?? null) ??
    fallbackMaxPayload;
  // The inbound frame must fit BOTH the gateway WS frame AND the bridge's OWN HTTP
  // body cap (the Convex->bridge /send POST carries the base64-inflated payload).
  // Publish the binding MINIMUM so consumers derive a cap that never trips a 413 at
  // readBody before the frame guard runs (a gateway maxPayload above our body cap
  // would otherwise advertise a deliverable size the POST can't even carry).
  const maxPayload =
    gatewayMaxPayload === null
      ? null
      : httpBodyCap === null
        ? gatewayMaxPayload
        : Math.min(gatewayMaxPayload, httpBodyCap);
  return {
    ...snapshot,
    bridgeVersion: BRIDGE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    maxPayload,
    targets: snapshot.targets.map((t) => ({
      ...t,
      gatewayVersion: versionByCanonical.get(t.canonical) ?? null,
    })),
  };
}

export interface BridgeServerDeps {
  config: BridgeConfig;
  registry: SessionRegistry;
  /** Tracks per-target connection health for the /health endpoint. */
  health: HealthRegistry;
  /**
   * Hot-swappable outbound media fetcher; `/send` applies the in-band config.
   * OPTIONAL: defaults to a provider built from `config` (the boot behaviour) so a
   * test or a minimal embedder need not wire it.
   */
  mediaProvider?: MediaFetcherProvider;
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
  const { config, registry, health } = deps;
  // Default to a boot-config provider when not wired (tests / minimal embedders).
  const mediaProvider = deps.mediaProvider ?? new MediaFetcherProvider(config);
  // Non-secret host:port computed once. The health target now reflects the
  // ROUTED identity (the agent/canonical from the body we actually dispatched to)
  // — honest liveness, no longer a static env claim. Keyed by canonical so the
  // entry count stays bounded on a mono-instance bridge.
  const gatewayHost = gatewayHostOf(config.openclawGatewayUrl);
  // Last gateway version seen on ANY connection (discovery / operator / live).
  // Process-lifetime, per-server closure (NOT module-level — test servers must
  // stay isolated). Feeds the served-instance fallback target in /capabilities
  // so a supported gateway is never gated as "unknown version" just because no
  // chat session happens to be live at the compat poll (BUG-1).
  let lastGatewayVersion: string | null = null;
  const noteGatewayVersion = (v: string | null): void => {
    if (typeof v === "string" && v.length > 0) lastGatewayVersion = v;
  };
  // Same idea for the gateway's maxPayload (the inbound-attachment ceiling): cache
  // the last-seen value so an idle /health poll still reports it (the lazy bridge
  // holds no socket at rest), letting Convex + the composer derive the cap.
  let lastMaxPayload: number | null = null;
  const noteMaxPayload = (n: number | null): void => {
    if (typeof n === "number" && n > 0) lastMaxPayload = n;
  };
  // Capture BOTH from any operator handshake (incl. a short /agents or /capabilities
  // discovery), so an idle/just-restarted bridge publishes the version AND the
  // inbound-attachment cap without waiting for a live chat session.
  const noteHandshake = (conn: OpenClawConnection): void => {
    noteGatewayVersion(conn.gatewayVersion);
    noteMaxPayload(conn.maxPayload);
  };
  // In-flight memo for the /capabilities one-shot version discovery: concurrent
  // unauthenticated GET /capabilities (the 5-min compat poll + any other caller)
  // must SHARE one discovery, not each open its own operator connection that can
  // hang to the WS connect timeout when the gateway is slow/down. Cleared when it
  // settles, so a later poll retries; concurrency never piles up connections.
  let versionDiscoveryInFlight: Promise<void> | null = null;
  const targetRef = (agentId: string, canonical: string): TargetRef => ({
    key: canonical,
    canonical,
    agentId,
    gatewayHost,
    instanceName: config.instanceName,
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
      for (const t of live) noteMaxPayload(t.maxPayload); // keep the idle fallback fresh
      sendJson(
        res,
        200,
        enrichHealthSnapshot(
          health.snapshot(),
          live,
          lastMaxPayload,
          config.maxBodyBytes,
        ),
      );
      return;
    }

    if (req.method === "GET" && req.url === "/capabilities") {
      // Non-secret provider capability descriptor (incl. agentDiscovery). The app
      // caches this to adapt its UI per provider. Unauthenticated like /health.

      // Refresh the version + maxPayload fallbacks from any currently-live session.
      for (const t of registry.listLive()) {
        noteGatewayVersion(t.gatewayVersion);
        noteMaxPayload(t.maxPayload);
      }
      // SELF-SUFFICIENT version capture (BUG-1 fragility fix): lastGatewayVersion
      // is in-memory (reset on restart) and otherwise only set by /agents
      // discovery or a send. If it is STILL null and no live session can supply
      // one, do a ONE-SHOT discovery here so the served-instance target carries a
      // real version. Without this, the 5-min compat poll landing right after a
      // bridge restart (before the 2-min /agents cron repopulates the closure)
      // returns an empty/version-less target -> the frontend gates AgentFiles /
      // ChatDefaults off ("version gateway inconnue"). Non-fatal: a failed
      // discovery just preserves the prior behavior (live targets / empty).
      if (lastGatewayVersion === null && registry.listLive().length === 0) {
        // Dedup concurrent callers onto ONE discovery (see versionDiscoveryInFlight).
        if (versionDiscoveryInFlight === null) {
          versionDiscoveryInFlight = discoverAgents(config, noteHandshake)
            .then(() => undefined)
            .catch((err) => {
              console.error(
                "[capabilities] one-shot version discovery failed (non-fatal):",
                (err as Error)?.message ?? err,
              );
            })
            .finally(() => {
              versionDiscoveryInFlight = null;
            });
        }
        await versionDiscoveryInFlight;
      }

      sendJson(res, 200, {
        // The instance this bridge serves (null when undeclared). The app caches
        // this to correlate capabilities + the M2 routing guard.
        instanceName: config.instanceName,
        // The best-known version of the SINGLE gateway this bridge serves,
        // reported UNCONDITIONALLY at the top level (independent of any live
        // session or OPENCLAW_INSTANCE_NAME). Convex OWNS instance identity (it
        // knows the served instance via BRIDGE_INSTANCE_NAME), so it attributes +
        // resolves the version-gated capabilities itself — the bridge no longer
        // needs to echo its own instance name for AgentFiles/ChatDefaults to
        // resolve. Same precedence as the targets: live/discovered > configured.
        gatewayVersion:
          lastGatewayVersion ?? config.gatewayVersionFallback ?? null,
        capabilities: openclawCapabilities(),
        // Compat manifest (additive): the single source of truth for bridge/
        // protocol versions + per-provider validated capability tables, plus
        // the version-resolved view of every LIVE session.
        bridgeVersion: BRIDGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        compat: COMPAT_MANIFEST,
        // Live targets win; the served-instance fallback fills the no-session
        // gap (see buildCapabilityTargets). Fallback PRECEDENCE: a version
        // captured from a live session/discovery (lastGatewayVersion) wins over
        // the operator-configured OPENCLAW_GATEWAY_VERSION — so the configured
        // value is just a deterministic floor for a fresh/idle bridge whose
        // discovery hasn't (or can't) capture the real version yet, and it
        // self-corrects the instant a real connection reports server.version.
        targets: buildCapabilityTargets(
          registry.listLive(),
          config.instanceName,
          lastGatewayVersion ?? config.gatewayVersionFallback ?? null,
        ),
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
        !constantTimeEqual(provided, config.bridgeSharedSecret)
      ) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      // mono-tenant: `?instance` is echoed for the poller's convenience but the
      // single configured gateway is always used.
      const instanceName = new URL(
        req.url ?? "/agents",
        "http://bridge",
      ).searchParams.get("instance");
      try {
        const { agents, rawCount } = await discoverAgents(
          config,
          noteHandshake,
        );
        // `count` (raw gateway agent count) lets the Convex poller distinguish a
        // genuinely empty gateway from normalizer shape-drift (agents cache P2).
        sendJson(res, 200, {
          ok: true,
          instanceName,
          agents,
          count: rawCount,
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

    const POST_ROUTES = [
      "/send",
      "/patch",
      "/reset",
      "/compact",
      "/agent-files",
      "/config-defaults",
      "/validate-media",
    ];
    if (req.method !== "POST" || !POST_ROUTES.includes(req.url ?? "")) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    // Auth: convex/bridge.ts sends the secret RAW in Authorization (no Bearer).
    const provided = req.headers["authorization"];
    if (
      typeof provided !== "string" ||
      !constantTimeEqual(provided, config.bridgeSharedSecret)
    ) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, config.maxBodyBytes);
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
      if (isInstanceMismatch(config.instanceName, patch.instanceName)) {
        sendJson(res, 409, { ok: false, error: { code: "instance_mismatch" } });
        return;
      }
      try {
        const session = await registry.acquire(toRouting(patch));
        await performPatch(session, patch, registry.getWriter());
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
      if (isInstanceMismatch(config.instanceName, reset.instanceName)) {
        sendJson(res, 409, { ok: false, error: { code: "instance_mismatch" } });
        return;
      }
      try {
        const session = await registry.acquire(toRouting(reset));
        await performReset(session);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error("bridge /reset failed:", (err as Error)?.message ?? err);
        sendJson(res, 502, { ok: false, error: "upstream reset failed" });
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
      if (isInstanceMismatch(config.instanceName, compact.instanceName)) {
        sendJson(res, 409, { ok: false, error: { code: "instance_mismatch" } });
        return;
      }
      try {
        const session = await registry.acquire(toRouting(compact));
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

    if (req.url === "/agent-files") {
      const body = parseAgentFilesBody(raw);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      if (isInstanceMismatch(config.instanceName, body.instanceName)) {
        // Same guard as /reset (P2-3): never answer for an instance this
        // bridge does not serve.
        sendJson(res, 409, { ok: false, error: { code: "instance_mismatch" } });
        return;
      }
      try {
        const result = await withOperatorConnection(
          config,
          (conn) => performAgentFilesOp(conn, body),
          noteHandshake,
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
      if (isInstanceMismatch(config.instanceName, body.instanceName)) {
        // Same guard as /reset (P2-3): the global config belongs to ONE
        // gateway — refuse a body that claims a different instance.
        sendJson(res, 409, { ok: false, error: { code: "instance_mismatch" } });
        return;
      }
      try {
        const result = await withOperatorConnection(
          config,
          (conn) => performConfigDefaultsOp(conn, body),
          noteHandshake,
        );
        sendJson(res, result.status, result.body);
      } catch (err) {
        const code = classifyGatewayError(err);
        if (code === "GATEWAY_DISCONNECTED" && body.op === "set") {
          // The patch may have APPLIED and only the response was lost to a
          // config-triggered gateway restart — reconnect and confirm before
          // reporting failure (see confirmDefaultsAfterRestart).
          const confirmed = await confirmDefaultsAfterRestart(config, body);
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
      let mvBody: { inboundMediaMode?: unknown; mediaMode?: unknown };
      try {
        mvBody = JSON.parse(raw) as typeof mvBody;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid body" });
        return;
      }
      const result = await validateSharedFs({
        inboundDir: config.inboundMediaDir,
        outboundDir: config.mediaOutboundDir,
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
    if (isInstanceMismatch(config.instanceName, body.instanceName)) {
      // A Convex routing misconfig (claims an instance this bridge does not
      // serve) — refuse loudly with a curated code, never answer from the wrong
      // gateway. Convex surfaces it as a failed dispatch (errorCode).
      sendJson(res, 409, { ok: false, error: { code: "instance_mismatch" } });
      return;
    }

    // Non-PHI routed-target record (agent/instance/canonical/chat are non-secret
    // names — never the text/token): the operational "which agent did this turn
    // route to" line, and the live-e2e discriminator for the body-routing fix.
    console.log(
      `bridge /send routed instance=${body.instanceName ?? config.instanceName ?? "-"} ` +
        `agent=${body.agentId} canonical=${body.canonical} chat=${body.chatId}`,
    );

    try {
      // Apply the per-instance config IN-BAND before the turn runs (D-B: process-
      // global, last-write-wins). Rebuilds the outbound media fetcher only if the
      // mode/cap changed; the rehydration knob is read inside performSend.
      mediaProvider.applyConfig(body.config);
      // Shared-fs inbound config: dirs are env (per-instance by Model M), the cap is
      // hot (body.config.mediaMaxMb → mediaMaxBytes, else the boot default).
      const inboundCfg: InboundMediaConfig = {
        // The bridge WRITES to its own mount; the agent READS at the agent-mount
        // (per-instance override, else env). These differ when bridge + gateway
        // mount the shared volume at different points.
        inboundDir: config.inboundMediaDir,
        agentMount: body.config?.inboundAgentMount ?? config.inboundAgentMount,
        maxBytes: body.config?.mediaMaxBytes ?? config.mediaMaxBytes,
      };
      // Inject the outbound delivery instruction unless outbound media is OFF (then
      // a generated file could not be hosted anyway). Effective mode = the in-band
      // per-instance config, else the bridge's boot default. The delivery path is
      // the AGENT-visible outbound mount (where the agent WRITES) — NOT the bridge's
      // read dir (which may be a host path the container can't write).
      const effectiveMediaMode = body.config?.mediaMode ?? config.mediaMode;
      const deliveryDir =
        effectiveMediaMode === "off"
          ? null
          : (body.config?.outboundAgentMount ?? config.mediaOutboundAgentMount);
      const session = await registry.acquire(toRouting(body));
      await performSend(
        session,
        body,
        registry.getWriter(),
        inboundCfg,
        deliveryDir,
      );
      // A real send proves connection + the ROUTED agent answered.
      health.recordOk(targetRef(body.agentId, body.canonical));
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
      const ref = targetRef(body.agentId, body.canonical);
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
