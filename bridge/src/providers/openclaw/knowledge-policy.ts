// WHICH KNOWLEDGE SOURCES AN AGENT SEARCHES — the agent's default, and the conversation's.
//
// The `openclaw-knowledge` plugin (>= 4.0.0, normative contract: its
// docs/atrium-integration.md) injects RAG context from NAMED sources. Its effective policy
// for a turn is: session override > agent default (`plugins.entries.openclaw-knowledge.
// config.agents.<agentId>`) > global default (§1). Atrium drives two of those levels:
//
//  - the AGENT DEFAULT, edited by an Atrium administrator. The contract has no client write
//    surface for it, so it goes through the gateway's own validated config write:
//    `config.patch {raw, baseHash, replacePaths}` (operator.admin, core-descriptors.ts:60;
//    merge-patch of the authored config, server-methods/config.ts:1016-1227; an array that
//    loses entries needs its exact path in `replacePaths`, config.ts:365-391). Only
//    `agents.<id>.{injection,sources}` ever leave the bridge — never `allowedSources`, a URL,
//    a key or a collection;
//  - the CONVERSATION'S CHOICE, made by its owner: `plugins.sessionAction` → `policy.set`
//    / `policy.reset` on the conversation's session (operator.write, Gateway-authorized
//    on the session target: plugin-host-hooks.ts:110-300, session-method-policy.ts:18).
//    Every OpenClaw session Atrium opens for the conversation gets it before its first
//    turn (performSend), exactly like the permission mode.
//
// Measured on the bench (2026.9.6 + plugin 4.0.3): `policy.set` into a key with no session
// answers `{ok:false, code:"write_failed"}` and creates nothing; after `sessions.create` the
// same write lands, and `sessions.describe` then carries it under `pluginExtensions`
// (session-utils-row.ts:195-196,595) — which is what a turn compares with, so an unchanged
// choice costs no RPC.

import { GatewayAnsweredError } from "./openclaw-client.js";
import {
  configHash,
  isBaseHashError,
  type GatewayRequester,
  type OpResult,
} from "../../conf.js";

export const KNOWLEDGE_PLUGIN_ID = "openclaw-knowledge";
/** The session-extension namespace the plugin stores its override under (§3.3). */
export const KNOWLEDGE_POLICY_NAMESPACE = "policy";

/** `injection` values (§1). */
export const KNOWLEDGE_INJECTIONS = ["auto", "hybrid", "tool", "off"] as const;
export type KnowledgeInjection = (typeof KNOWLEDGE_INJECTIONS)[number];
export function isKnowledgeInjection(v: unknown): v is KnowledgeInjection {
  return typeof v === "string" && (KNOWLEDGE_INJECTIONS as readonly string[]).includes(v);
}

/** The plugin's own bounds on a selection (`POLICY_SET_SCHEMA`: 1..16 ids of 1..64 chars). */
export const MAX_KNOWLEDGE_SOURCES = 16;
const MAX_SOURCE_ID_CHARS = 64;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1_000;
/** How many agents one discovery probes (a bound, not an expectation). */
const MAX_PROBED_AGENTS = 100;

function isSourceId(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.trim().length > 0 &&
    v.length <= MAX_SOURCE_ID_CHARS &&
    v === v.trim()
  );
}

/** An agent id as a config KEY: the plugin lowercases it (control-plane.ts strParam
 *  → toLowerCase), and it becomes a merge-patch path segment — so nothing that could
 *  address another path. */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function normalizeKnowledgeAgentId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim().toLowerCase();
  return AGENT_ID_RE.test(id) ? id : null;
}

// --- Reads -------------------------------------------------------------------

export interface KnowledgeSource {
  id: string;
  type: string;
  label: string;
  description: string;
  /** Part of the agent's default selection. */
  default: boolean;
}

/** `knowledge.sources` (§3.1) — what an agent may select and its default. */
export interface KnowledgeAgentInfo {
  configured: boolean;
  injection: KnowledgeInjection;
  defaultSources: string[];
  overridesAllowed: boolean;
  /** Exactly the agent's allowlist: nothing else is ever offered. */
  sources: KnowledgeSource[];
  /** The plugin listed MORE than this parse holds (past KNOWLEDGE_ALLOWLIST_CAP, or an
   *  entry it could not read), in `sources` or `defaultSources`: the admin write, which
   *  checks against both, is refused rather than compared with a cut list. Absent =
   *  complete. */
  incomplete?: true;
  /** The plugin's contract level (`knowledge.sources.contract`): 2 from
   *  openclaw-knowledge 4.1.0 on, where an agent's allowlist is its OWN `allowedSources`
   *  or else the inherited/global one — no longer its `sources`. Absent = 1 (4.0.x),
   *  where writing `sources` on an agent without its own `allowedSources` ALSO narrows
   *  its allowlist (4.0.x src/config.ts:702). */
  contract?: number;
}

/** The plugin contract from which an agent default can be written without touching the
 *  agent's allowlist (openclaw-knowledge 4.1.0). */
export const KNOWLEDGE_CONTRACT_SEPARATE_ALLOWLIST = 2;

/** The bridge's hard cap on an agent's allowlist and default list (codex passes 16, 18).
 *  Everything up to it is kept WHOLE — the admin write validates and compares against
 *  it, and a cut list hides a change past the cut. Past it the answer is flagged
 *  `incomplete` and the admin write is refused. Where data goes to Convex/UI it is
 *  bounded there (convex/lib/knowledge.ts normalizeKnowledgeFacts). */
export const KNOWLEDGE_ALLOWLIST_CAP = 1_024;

/** Defensive parse of a `knowledge.sources` answer; null when it is not one. */
export function parseKnowledgeSources(payload: unknown): KnowledgeAgentInfo | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (!isKnowledgeInjection(p.injection)) return null;
  if (!Array.isArray(p.sources) || !Array.isArray(p.defaultSources)) return null;
  const sources: KnowledgeSource[] = [];
  let incomplete = p.sources.length > KNOWLEDGE_ALLOWLIST_CAP;
  const seen = new Set<string>();
  for (const raw of p.sources.slice(0, KNOWLEDGE_ALLOWLIST_CAP)) {
    if (typeof raw !== "object" || raw === null) {
      incomplete = true;
      continue;
    }
    const s = raw as Record<string, unknown>;
    if (!isSourceId(s.id)) {
      incomplete = true;
      continue;
    }
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    sources.push({
      id: s.id,
      type: typeof s.type === "string" ? s.type.slice(0, 32) : "unknown",
      label:
        typeof s.label === "string" && s.label.trim() !== ""
          ? s.label.slice(0, MAX_LABEL_CHARS)
          : s.id,
      description:
        typeof s.description === "string" ? s.description.slice(0, MAX_DESCRIPTION_CHARS) : "",
      default: s.default === true,
    });
  }
  // The default list WHOLE too (codex pass 18): the stale check compares it, and a cut
  // one hides a change past the cut.
  if (p.defaultSources.length > KNOWLEDGE_ALLOWLIST_CAP) incomplete = true;
  const defaultSources = p.defaultSources.slice(0, KNOWLEDGE_ALLOWLIST_CAP);
  if (!defaultSources.every(isSourceId)) incomplete = true;
  // Integer >= 2 only; anything else (absent, 1, malformed) is the 4.0.x contract.
  const contract =
    typeof p.contract === "number" && Number.isInteger(p.contract) && p.contract >= 2 && p.contract <= 1_000
      ? p.contract
      : undefined;
  return {
    configured: p.configured === true,
    injection: p.injection,
    defaultSources: defaultSources.filter(isSourceId),
    overridesAllowed: p.overridesAllowed === true,
    sources,
    ...(incomplete ? { incomplete: true as const } : {}),
    ...(contract === undefined ? {} : { contract }),
  };
}

/**
 * May an admin write THIS agent's default from Atrium (codex pass 18)? Always on a
 * contract-2 plugin (its allowlist no longer follows `sources`). On a 4.0.x plugin only
 * when the agent has its OWN raw `allowedSources`: then writing `sources` leaves the
 * allowlist as it is; without one, the allowlist IS `sources ?? global` and the write
 * would narrow it — refused (`plugin_too_old`), never worked around by pinning an
 * allowlist Atrium does not own.
 */
export function defaultWritable(info: KnowledgeAgentInfo, entry: Record<string, unknown> | null): boolean {
  if ((info.contract ?? 1) >= KNOWLEDGE_CONTRACT_SEPARATE_ALLOWLIST) return true;
  return Array.isArray(entry?.allowedSources);
}

export type KnowledgeUnavailableReason =
  /** `unknown method: knowledge.sources` — the plugin is absent or older than 4.0 (§5). */
  | "plugin_absent"
  /** The socket may not read it. */
  | "scope_refused"
  /** No usable answer (timeout, malformed). Says nothing about the plugin. */
  | "unreadable";

/**
 * The agent's default AS WRITTEN in the gateway config (`agents.<id>.injection|sources`),
 * unfiltered — ids the plugin does not offer now included; `null` = the key is absent.
 * The admin's write is checked against THIS (codex pass 3): the plugin's effective view
 * filters out disabled ids, so an edit adding one would read as "unchanged" there.
 */
export interface RawAgentDefault {
  injection: string | null;
  sources: string[] | null;
}

export function rawAgentDefault(entry: Record<string, unknown> | null): RawAgentDefault {
  // The FULL value (codex pass 14): a truncated baseline would miss an operator's change
  // past the cut, and `config.patch` replaces the whole array. Whether it can be carried
  // at all is `rawDefaultStorable`'s question.
  return {
    injection: typeof entry?.injection === "string" ? entry.injection : null,
    sources: Array.isArray(entry?.sources)
      ? entry.sources.filter((x): x is string => typeof x === "string")
      : null,
  };
}

/** Convex's bounds on a stored raw view (convex/lib/knowledge.ts normalizeKnowledgeFacts):
 *  at most this many ids, each at most this long; an injection at most 32 chars. */
export const KNOWLEDGE_RAW_SOURCES_MAX = 64;
export const KNOWLEDGE_RAW_ID_MAX = 64;

/**
 * Can this entry's raw default travel as a baseline WITHOUT LOSS (codex pass 14)? A
 * value past Convex's bounds, or one `rawAgentDefault` cannot represent (a non-string
 * id, a non-array `sources`, a non-string `injection`), would be compared or stored
 * cut — an operator's change in the lost part then goes unseen. Such a default is never
 * published as a baseline, and an admin write over it is refused (`default_too_large`).
 */
export function rawDefaultStorable(entry: Record<string, unknown> | null): boolean {
  if (entry === null) return true;
  const inj = entry.injection;
  if (inj !== undefined && inj !== null && (typeof inj !== "string" || inj.length > 32)) return false;
  const src = entry.sources;
  if (src === undefined || src === null) return true;
  return (
    Array.isArray(src) &&
    src.length <= KNOWLEDGE_RAW_SOURCES_MAX &&
    src.every((x) => typeof x === "string" && x.length <= KNOWLEDGE_RAW_ID_MAX)
  );
}

/**
 * `observedAt`: when the read was SENT, on THIS bridge's clock. A result is only as fresh
 * as its request: an answer that crossed a write may describe either side of it, so the
 * send time is the conservative stamp. Convex compares it with the stamp of the value it
 * holds (both bridge times) and never lets an older reading replace a newer one (codex
 * pass 4: a discovery started before an admin's save, finishing after it).
 */
export type KnowledgeProbe =
  | {
      available: true;
      info: KnowledgeAgentInfo;
      config?: RawAgentDefault;
      /** The agent has its OWN `allowedSources` in that config (rides with `config`,
       *  same snapshot): what decides, on a 4.0.x plugin, whether the admin card may
       *  edit its default (codex pass 18). */
      ownAllowlist?: boolean;
      observedAt?: number;
    }
  | { available: false; reason: KnowledgeUnavailableReason; observedAt?: number };

/** Feature detection + the agent's default, in one read (`knowledge.sources`). */
export async function probeKnowledgeSources(
  conn: GatewayRequester,
  agentId: string,
  timeoutMs = 8_000,
): Promise<KnowledgeProbe> {
  const observedAt = Date.now();
  try {
    const res = await conn.request("knowledge.sources", { agentId }, Math.min(8_000, timeoutMs));
    const info = parseKnowledgeSources(res.payload);
    return info === null
      ? { available: false, reason: "unreadable" }
      : { available: true, info, observedAt };
  } catch (err) {
    const text = (err as Error)?.message ?? "";
    if (err instanceof GatewayAnsweredError && /unknown method/i.test(text)) {
      return { available: false, reason: "plugin_absent", observedAt };
    }
    if (/missing scope/i.test(text)) return { available: false, reason: "scope_refused" };
    return { available: false, reason: "unreadable" };
  }
}

/** The WHOLE discovery probe's budget, and how many agents are asked at once. Discovery
 *  is the agent sync: the knowledge ride-along must never hold it back (codex P2 — a
 *  hanging method, 8 s per agent, 100 agents in a row, was 13 minutes). */
export const KNOWLEDGE_PROBE_BUDGET_MS = 10_000;
export const KNOWLEDGE_PROBE_CONCURRENCY = 4;

/**
 * Probe every discovered agent on the discovery socket, a few at a time, within ONE
 * global budget. The plugin is gateway-wide: the first `plugin_absent` answer settles it
 * for every agent not asked yet. An agent the budget did not reach is `unreadable` —
 * "not known this time", never "absent": Convex then keeps the last state it had for it
 * (stale), exactly as for a lost answer.
 *
 * A roster past MAX_PROBED_AGENTS is covered over SUCCESSIVE syncs (codex pass 21): each
 * sync probes a window of at most that many agents starting at a per-instance cursor
 * (`cursorKey`), which advances by the agents the window answered. An agent outside the
 * window gets NO entry at all — Convex writes only the entries it receives (no pruning
 * by batch), so its row stands untouched. The cursor lives in the bridge's memory: a
 * restart begins again at 0, which is acceptable because it still advances every sync
 * (every agent is reached within ceil(roster / MAX_PROBED_AGENTS) syncs) and the rows
 * already stored stand meanwhile.
 */
export async function probeKnowledgeForAgents(
  conn: GatewayRequester,
  agentIds: readonly string[],
  opts: { budgetMs?: number; concurrency?: number; cursorKey?: string } = {},
): Promise<Record<string, KnowledgeProbe>> {
  const budgetMs = opts.budgetMs ?? KNOWLEDGE_PROBE_BUDGET_MS;
  const concurrency = Math.max(1, opts.concurrency ?? KNOWLEDGE_PROBE_CONCURRENCY);
  const deadline = Date.now() + budgetMs;
  const out: Record<string, KnowledgeProbe> = {};
  const roster = agentIds
    .map((raw) => ({ raw, id: normalizeKnowledgeAgentId(raw) }))
    .filter((x): x is { raw: string; id: string } => x.id !== null);
  const start =
    opts.cursorKey !== undefined && roster.length > MAX_PROBED_AGENTS
      ? (discoveryCursors.get(opts.cursorKey) ?? 0) % roster.length
      : 0;
  const window = [...roster.slice(start), ...roster.slice(0, start)].slice(0, MAX_PROBED_AGENTS);
  const queue = [...window];
  let absent = false;
  // The send time of the read that ESTABLISHED the absence (codex pass 20): every agent
  // it is propagated to carries it, so Convex orders it against newer readings — an
  // unstamped copy could erase a state written after the plugin came back.
  let absentAt: number | undefined;
  const absentProbe = (): KnowledgeProbe => ({
    available: false,
    reason: "plugin_absent",
    ...(absentAt === undefined ? {} : { observedAt: absentAt }),
  });
  let expired = false;
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (absent) {
        out[next.raw] = absentProbe();
        continue;
      }
      if (expired) return;
      const probe = await probeKnowledgeSources(conn, next.id, Math.max(1, deadline - Date.now()));
      if (expired) return;
      out[next.raw] = probe;
      if (!probe.available && probe.reason === "plugin_absent" && !absent) {
        absent = true;
        absentAt = probe.observedAt;
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve();
    }, budgetMs);
  });
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker)),
    budget,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  // The next sync starts where this one's answers stopped.
  if (opts.cursorKey !== undefined && roster.length > MAX_PROBED_AGENTS) {
    const answered = window.filter((x) => out[x.raw] !== undefined).length;
    discoveryCursors.set(opts.cursorKey, (start + answered) % roster.length);
  }
  // Whatever the budget did not reach IN THIS WINDOW (or reached without an answer in
  // time): unknown. Agents outside the window get no entry at all.
  for (const x of window) {
    if (out[x.raw] === undefined) {
      out[x.raw] = absent ? absentProbe() : { available: false, reason: "unreadable" };
    }
  }
  return out;
}

/** Per-instance discovery cursors (probeKnowledgeForAgents). In-process only. */
const discoveryCursors = new Map<string, number>();

/** Test support: forget every discovery cursor. */
export function clearKnowledgeDiscoveryCursors(): void {
  discoveryCursors.clear();
}

// --- The conversation's choice -------------------------------------------------

/**
 * The OWNER's choice for this conversation and this agent (Convex
 * `chatKnowledgeChoices`):
 *  - `default`: no override — the agent's default applies (an override found on the
 *    session is removed);
 *  - `off`: no knowledge at all (`injection: "off"`: `sources` needs at least one id, §4.1);
 *  - `sources`: exactly these sources; `injection` only when the owner's selection must
 *    turn retrieval on over an agent whose default is `off`.
 */
export type KnowledgeChoice =
  | { kind: "default" }
  | { kind: "off" }
  | { kind: "sources"; sources: string[]; injection?: Exclude<KnowledgeInjection, "off"> };

/** A strict parse: `undefined` = none carried, `"invalid"` = carried but malformed (the
 *  caller refuses the body — a choice is never silently dropped). */
export function parseKnowledgeChoice(v: unknown): KnowledgeChoice | undefined | "invalid" {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") return "invalid";
  const o = v as Record<string, unknown>;
  if (o.kind === "default") return { kind: "default" };
  if (o.kind === "off") return { kind: "off" };
  if (o.kind !== "sources") return "invalid";
  if (!Array.isArray(o.sources) || o.sources.length === 0) return "invalid";
  if (o.sources.length > MAX_KNOWLEDGE_SOURCES) return "invalid";
  if (!o.sources.every(isSourceId)) return "invalid";
  const sources = [...new Set(o.sources as string[])];
  if (o.injection === undefined) return { kind: "sources", sources };
  if (!isKnowledgeInjection(o.injection) || o.injection === "off") return "invalid";
  return { kind: "sources", sources, injection: o.injection };
}

/** The session-stored override, as the plugin projects it (§3.3). */
export interface KnowledgeOverride {
  injection?: KnowledgeInjection;
  sources?: string[];
  lightragQueryMode?: string;
  /** A per-prompt one-shot is PENDING on the session (read side only — Atrium never
   *  sets one). It takes priority over the session override for the next human turn
   *  (contract §1; openclaw-knowledge policy.ts:439-468), so a session carrying one
   *  never holds the owner's choice (codex pass 11). */
  oneShot?: true;
}

/**
 * The override a described session holds: `null` = none (no entry for the plugin on a
 * row that projects extensions — absent when empty, session-utils-row.ts:595), an
 * override otherwise, `undefined` when the row says nothing readable. A pending one-shot
 * is NOT part of the override (Atrium never writes one).
 *
 * DECLARED LIMIT: `pluginExtensions` is projected by the gateway (session-utils-row.ts)
 * but declared by no gateway-protocol schema, so its absence cannot be told from a
 * gateway that stopped projecting it. Read as "no override": a non-default choice is then
 * written anyway (unequal), and only a `default` choice could leave an override set
 * elsewhere (the Control UI, `/knowledge`) in place until the owner chooses again.
 */
export function readKnowledgeOverride(
  sess: Record<string, unknown> | null | undefined,
): KnowledgeOverride | null | undefined {
  if (sess === null || sess === undefined) return undefined;
  const ext = sess.pluginExtensions;
  if (ext === undefined) return null;
  if (!Array.isArray(ext)) return undefined;
  const entry = ext.find(
    (e): e is { value?: unknown } =>
      typeof e === "object" &&
      e !== null &&
      (e as { pluginId?: unknown }).pluginId === KNOWLEDGE_PLUGIN_ID &&
      (e as { namespace?: unknown }).namespace === KNOWLEDGE_POLICY_NAMESPACE,
  );
  if (entry === undefined) return null;
  return parseOverrideValue(entry.value);
}

/** The plugin's session projection (`projectSessionState`, openclaw-knowledge
 *  policy.ts:166-175) as an override: `null` when it holds none, `undefined` when it is
 *  not an object. */
function parseOverrideValue(value: unknown): KnowledgeOverride | null | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const out: KnowledgeOverride = {};
  if (isKnowledgeInjection(v.injection)) out.injection = v.injection;
  if (Array.isArray(v.sources)) out.sources = v.sources.filter(isSourceId);
  if (typeof v.lightragQueryMode === "string") out.lightragQueryMode = v.lightragQueryMode;
  // Projected as is by the plugin (policy.ts:171 projectSessionState), on the session
  // row's extension and in policy.get's `session` alike (contract §3.2, "a pending
  // one-shot is visible in session.oneShot").
  if (typeof v.oneShot === "object" && v.oneShot !== null) out.oneShot = true;
  return out.injection === undefined &&
    out.sources === undefined &&
    out.lightragQueryMode === undefined &&
    out.oneShot === undefined
    ? null
    : out;
}

/**
 * The override a choice needs NOW (codex pass 13): ticking sources means "search these".
 * A `sources` choice without its own mode follows the agent default's mode — unless that
 * mode is `off`, where the sources would be searched by nothing: it then carries `auto`
 * (`policy.set {reset:true, injection, sources}` is accepted and makes the session's
 * injection the effective one: openclaw-knowledge policy.ts:283-294 and :425-428;
 * contract §7.2 shows `{injection:"hybrid", sources:["docs"]}` → `injection:"hybrid",
 * origin.injection:"session"`). `agentMode` = the agent default's mode as
 * `knowledge.sources` states it now (null = not known: the choice as is, and the
 * write's confirmation still refuses an inactive result).
 */
export function concreteOverride(
  choice: KnowledgeChoice,
  agentMode: KnowledgeInjection | null,
): KnowledgeOverride | null {
  const d = desiredOverride(choice);
  if (d !== null && d.sources !== undefined && d.injection === undefined && agentMode === "off") {
    return { ...d, injection: "auto" };
  }
  return d;
}

/** Does the override this choice needs depend on the agent default's mode? */
export function followsAgentMode(choice: KnowledgeChoice): boolean {
  return choice.kind === "sources" && choice.injection === undefined;
}

/** The override the session must hold for a choice (`null` = none). */
export function desiredOverride(choice: KnowledgeChoice): KnowledgeOverride | null {
  if (choice.kind === "default") return null;
  if (choice.kind === "off") return { injection: "off" };
  return {
    sources: [...choice.sources],
    ...(choice.injection !== undefined ? { injection: choice.injection } : {}),
  };
}

function sameSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** The same ids in the same order. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Does the stored override already say exactly what the choice asks? */
export function overrideMatches(
  stored: KnowledgeOverride | null,
  desired: KnowledgeOverride | null,
): boolean {
  // A pending one-shot (set by another client: the Control UI, `/knowledge once`) would
  // run the next turn under ITS sources, whatever the choice: never "already held".
  // Rewriting clears it — `policy.set {reset:true,…}` and `policy.reset` both start
  // from an empty state (policy.ts:283 `p.reset === true ? {} : …`).
  if (stored?.oneShot === true) return false;
  if (stored === null || desired === null) return stored === desired;
  return (
    stored.injection === desired.injection &&
    sameSet(stored.sources, desired.sources) &&
    stored.lightragQueryMode === desired.lightragQueryMode
  );
}

/** Why a choice could not be put on the session — one closed vocabulary, shared with
 *  Convex and the composer. The plugin's own codes (§5) pass through by name. */
export const KNOWLEDGE_POLICY_FAILURES = [
  "plugin_absent",
  "overrides_disabled",
  "source_not_allowed",
  "unknown_source",
  "invalid_payload",
  "write_failed",
  "scope_refused",
  "session_not_established",
  "unsupported_gateway",
  // A NEWER choice is already on (or on its way to) this session: an older apply is
  // refused instead of landing after it.
  "superseded",
  // The plugin answered success without a snapshot that shows the choice in force.
  "unconfirmed",
  // The session lost the choice between its write and the send (a reset or a deletion
  // from another client): the send is prepared again once, then withheld.
  "session_replaced",
  "rejected",
] as const;
export type KnowledgePolicyFailure = (typeof KNOWLEDGE_POLICY_FAILURES)[number];

// --- Ordering between the on-the-spot apply and the send ------------------------------

/**
 * ONE writer at a time per session, and never an older choice after a newer one.
 *
 * Two paths write a session's knowledge override: the on-the-spot apply (`/knowledge`)
 * and the send (performSend, right before `chat.send`). Convex checks a choice's revision
 * before POSTing an apply, but nothing stopped that POST from LANDING later — after a
 * newer choice's apply, or between a send's describe and its `chat.send` — and the turn
 * then searched a source the owner had turned off (codex P1). So the bridge keeps, per
 * session: the highest revision it has been told about (a send notes its revision as
 * it starts; an older apply is then refused, `superseded`), a lock both writers take,
 * and a write counter — a send whose describe predates a write re-reads the session
 * under the lock before comparing.
 *
 * In-process state: a bridge restart forgets it, and the first send after a restart
 * enforces its own revision against the described session as before.
 */
export interface SessionKnowledgeGuard {
  /** The highest revision this session was told about (noted by a send as it starts, by
   *  an apply as soon as it arrives — before it waits for the lock). */
  revision: number;
  /** The highest revision CONFIRMED on the session (a write or an equal read). A send
   *  whose revision is behind `revision` may only go out while this one has caught up:
   *  otherwise the owner's newest choice is not on the session (codex pass 3, P1). */
  appliedRevision: number;
  /** What that confirmed revision put on the session (`null` = no override;
   *  `undefined` = unknown). A send running under a NEWER confirmed choice checks that
   *  THIS is still on the session right before the request — being confirmed once does
   *  not prove it is still there (codex pass 8). */
  appliedOverride?: KnowledgeOverride | null;
  /** The ORIGINAL selection of that confirmed choice (a `sources` choice's ids; `null` =
   *  not a sources choice; `undefined` = unknown): what a turn running under it may
   *  search, whatever the override written was clamped to (codex pass 21). */
  appliedSelection?: string[] | null;
  writes: number;
  tail: Promise<void>;
  /** Writers holding or waiting for the lock. A guard with any is never evicted. */
  pending: number;
  /** Last time a request for this session touched the guard. */
  lastUsed: number;
}

/**
 * EVICTION NEVER DROPS A GUARD IN USE (codex P2). Past the soft cap, only a guard that is
 * IDLE is dropped: no writer holding or waiting for its lock, and untouched for
 * KNOWLEDGE_GUARD_IDLE_MS. The idle bound is what keeps the highest revision as long as
 * the session can still be written by an OLDER request: an apply reaches its guard within
 * its own HTTP handling (Convex aborts the POST at 30 s; the claim and describe before the
 * guard are bounded by their RPC timeouts — well under two minutes), and a send touches its
 * guard when it starts and again at the lock. When nothing is evictable the map grows past
 * the soft cap rather than drop a guard someone may still rely on.
 */
export const KNOWLEDGE_GUARD_SOFT_CAP = 10_000;
export const KNOWLEDGE_GUARD_IDLE_MS = 10 * 60_000;
const guards = new Map<string, SessionKnowledgeGuard>();

function evictOneIdleGuard(now: number): void {
  for (const [key, g] of guards) {
    if (g.pending === 0 && now - g.lastUsed >= KNOWLEDGE_GUARD_IDLE_MS) {
      guards.delete(key);
      return;
    }
  }
}

export function knowledgeGuard(
  scope: string,
  sessionKey: string,
  now: number = Date.now(),
): SessionKnowledgeGuard {
  const key = `${scope}\u0000${sessionKey}`;
  let g = guards.get(key);
  if (g === undefined) {
    if (guards.size >= KNOWLEDGE_GUARD_SOFT_CAP) evictOneIdleGuard(now);
    g = {
      revision: 0,
      appliedRevision: 0,
      appliedOverride: undefined,
      appliedSelection: undefined,
      writes: 0,
      tail: Promise.resolve(),
      pending: 0,
      lastUsed: now,
    };
    guards.set(key, g);
  } else {
    g.lastUsed = now;
    // Most recently used last: the eviction scan meets the stalest first.
    guards.delete(key);
    guards.set(key, g);
  }
  return g;
}

/** How many guards are held (tests). */
export function knowledgeGuardCount(): number {
  return guards.size;
}

/** Forget every session's guard (tests: each case starts from a bridge that knows none). */
export function clearKnowledgeGuards(): void {
  guards.clear();
}

/** Run `fn` alone among this session's knowledge writers. */
export function withKnowledgeLock<T>(g: SessionKnowledgeGuard, fn: () => Promise<T>): Promise<T> {
  g.pending += 1;
  g.lastUsed = Date.now();
  const run = g.tail.then(fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  g.tail = settled;
  void settled.then(() => {
    g.pending -= 1;
    g.lastUsed = Date.now();
  });
  return run;
}

/** Note a revision now CONFIRMED on the session. Never goes back. */
export function noteAppliedKnowledgeRevision(
  g: SessionKnowledgeGuard,
  revision: number | undefined | null,
  override: KnowledgeOverride | null,
  selection?: string[] | null,
): void {
  if (typeof revision !== "number" || revision < g.appliedRevision) return;
  g.appliedRevision = revision;
  g.appliedOverride = override;
  g.appliedSelection = selection;
}

/** The ORIGINAL selection of a choice, for the last gate (`null` = not a sources choice). */
export function choiceSelection(choice: KnowledgeChoice): string[] | null {
  return choice.kind === "sources" ? [...choice.sources] : null;
}

/**
 * The last check before `chat.send`: may a turn prepared under `revision` still go out?
 * No when a NEWER choice was announced for this session (an apply arrived while the turn
 * was being prepared) and is not confirmed on it — the apply failed, or has not run yet:
 * the turn would search what the owner no longer chose. A newer choice already confirmed
 * on the session is fine: the turn runs under it.
 */
export function sendStillCurrent(g: SessionKnowledgeGuard, revision: number | undefined): boolean {
  if (revision === undefined) return true;
  return g.revision <= revision || g.appliedRevision >= g.revision;
}

/**
 * The send path's gate (providers/openclaw/chat-send.ts), whichever socket carries the
 * turn. Two things must still hold at the request:
 *  - no NEWER choice was announced that is not confirmed on the session
 *    (`sendStillCurrent` → `superseded`);
 *  - the session still HOLDS this send's choice (codex pass 7). A reset from another
 *    client rebuilds the session entry WITHOUT plugin extensions (upstream
 *    session-reset-service.ts nextEntry, written whole by
 *    session-accessor.sqlite-lifecycle.ts), and a deletion clears them — while the
 *    session id can stay the same, so only the override itself tells. `read` is the
 *    fresh describe taken as the LAST await before the request; a mismatch withholds
 *    the send as `session_replaced`, which the send path re-prepares once.
 * An unreadable describe leaves the second check to the enforcement that just ran.
 */
export function knowledgeChatSendGate(
  g: SessionKnowledgeGuard,
  revision: number | undefined,
  onWithheld: (reason: KnowledgePolicyFailure) => void = () => {},
  verify?: {
    desired: KnowledgeOverride | null;
    read: () => Promise<SessionPolicyRead>;
    /** The turn GOES, searching fewer of the chosen sources: the operator took these
     *  out of the agent's allowlist since (ids only). Reported, never withheld. */
    onClamped?: (dropped: string[]) => void;
    /** The send's ORIGINAL selection (`choiceSelection`): the bound on what the turn may
     *  search, kept even where the override written was clamped or nothing was written
     *  (codex pass 21). `undefined` = the override's own sources stand in. */
    selection?: string[] | null;
  },
): { refresh?: () => Promise<void>; check: () => void } {
  let seen: SessionPolicyRead = { kind: "unknown" };
  return {
    ...(verify === undefined
      ? {}
      : {
          refresh: async () => {
            seen = await verify.read().catch((): SessionPolicyRead => ({ kind: "unknown" }));
          },
        }),
    check: () => {
      if (!sendStillCurrent(g, revision)) {
        onWithheld("superseded");
        throw new KnowledgePolicyNotAppliedError("superseded");
      }
      // A newer choice confirmed on the session: the turn runs under IT — so it is that
      // choice's override the session must still hold, not this send's (codex pass 8).
      const expected =
        revision !== undefined && g.appliedRevision > revision
          ? g.appliedOverride
          : verify?.desired;
      if (verify === undefined) return;
      // The plugin must still be there to PROCESS a non-default choice (codex pass 10):
      // an override left on the session is inert once the plugin is gone, or once the
      // operator disabled overrides (the plugin then resolves without session state,
      // openclaw-knowledge policy.ts resolveEffectivePolicy). A `default` choice needs
      // nothing of it — the operator's default is what runs either way.
      // Decided by the choice the turn RUNS under: a newer confirmed `default` (`expected`
      // null) is a default even when this send was prepared for another choice — `??`
      // would have fallen back to it (codex pass 12). Only an UNKNOWN confirmed override
      // (undefined) defers to the send's own choice.
      const runsUnder = expected !== undefined ? expected : verify.desired;
      const nonDefault = runsUnder !== null;
      // What the turn may search: the ORIGINAL selection of the choice it runs under — not
      // the override written, which a clamp may have narrowed or (every chosen id revoked)
      // left out entirely (codex pass 21).
      const newer = revision !== undefined && g.appliedRevision > revision;
      const declared = newer ? g.appliedSelection : verify.selection;
      const selection = declared !== undefined ? declared : (runsUnder?.sources ?? null);
      // The operator's CLAMP (codex pass 15): the plugin keeps the stored selection but
      // searches only the ids still allowed (openclaw-knowledge policy.ts:376-391
      // `filterAllowed`, on every read). Fewer of the chosen sources leaks nothing: the
      // turn goes and the dropped ids are reported. But a selection clamped to NOTHING
      // is not "nothing searched": the plugin then falls through to the level below —
      // the agent's default sources (policy.ts:388-390, "ignored rather than meaning no
      // sources"), which the operator may also change between the apply and this send.
      // A source outside the owner's selection is never searched: withheld.
      const checkSelection = (effective: string[] | undefined) => {
        if (selection === null || effective === undefined) return;
        if (effective.some((id) => !selection.includes(id))) {
          onWithheld("source_not_allowed");
          throw new KnowledgePolicyNotAppliedError("source_not_allowed");
        }
        const dropped = selection.filter((id) => !effective.includes(id));
        if (dropped.length > 0) verify.onClamped?.(dropped);
      };
      if (seen.kind === "plugin_gone" && nonDefault) {
        onWithheld("plugin_absent");
        throw new KnowledgePolicyNotAppliedError("plugin_absent");
      }
      if (seen.kind !== "held") return;
      // Overrides disabled: whatever the session still holds is inert — its override
      // (policy.ts:422) and a pending one-shot alike (policy.ts:439) — so a `default`
      // choice is what runs.
      if (!nonDefault && seen.overridesAllowed === false) {
        checkSelection(seen.effectiveSources);
        return;
      }
      // Chosen sources under an effective `off` (the agent default turned off since the
      // choice was put on the session, codex pass 13) search nothing: not the choice.
      if (runsUnder?.sources !== undefined && seen.injection === "off") {
        onWithheld("unconfirmed");
        throw new KnowledgePolicyNotAppliedError("unconfirmed");
      }
      if (nonDefault && seen.overridesAllowed === false) {
        onWithheld("overrides_disabled");
        throw new KnowledgePolicyNotAppliedError("overrides_disabled");
      }
      if (expected !== undefined && !overrideMatches(seen.override, expected)) {
        onWithheld("session_replaced");
        throw new KnowledgePolicyNotAppliedError("session_replaced");
      }
      checkSelection(seen.effectiveSources);
    },
  };
}

/**
 * The session's knowledge state as the PLUGIN reads it now: `plugins.sessionAction`
 * `policy.get` (operator.read, openclaw-knowledge control-plane.ts:372-381), whose
 * snapshot carries the stored session state (`session`, the same projection as the
 * session row's plugin extension) and `overridesAllowed`. It answers only while the
 * plugin is loaded (upstream plugin-host-hooks.ts:152-170: a missing registration or a
 * plugin not `loaded` is `UNAVAILABLE: unknown plugin session action`), so an answer
 * is also the proof the plugin still processes the policy — which the session row
 * cannot give.
 */
export type SessionPolicyRead =
  | {
      kind: "held";
      override: KnowledgeOverride | null;
      overridesAllowed: boolean | undefined;
      /** The EFFECTIVE mode a normal turn runs under now (snapshot `injection`). */
      injection?: KnowledgeInjection;
      /** The sources a normal turn searches now, after the plugin's allowlist clamp
       *  (snapshot `effectiveSources`, control-plane.ts readPolicySnapshot). */
      effectiveSources?: string[];
    }
  /** The gateway said the plugin cannot take the action: absent, unloaded, failing. */
  | { kind: "plugin_gone" }
  /** No usable answer (timeout, malformed): says nothing. */
  | { kind: "unknown" };

export async function readSessionPolicy(
  conn: GatewayRequester,
  sessionKey: string,
  agentId: string,
  timeoutMs = 8_000,
): Promise<SessionPolicyRead> {
  let payload: Record<string, unknown> | undefined;
  try {
    payload = (
      await conn.request(
        "plugins.sessionAction",
        { pluginId: KNOWLEDGE_PLUGIN_ID, actionId: "policy.get", sessionKey, agentId },
        timeoutMs,
      )
    ).payload;
  } catch (err) {
    const text = (err as Error)?.message ?? "";
    if (
      err instanceof GatewayAnsweredError &&
      (/^UNAVAILABLE\b/.test(text) || /unknown plugin session action|unknown method/i.test(text))
    ) {
      return { kind: "plugin_gone" };
    }
    return { kind: "unknown" };
  }
  const result = payload?.ok === true ? payload.result : undefined;
  if (typeof result !== "object" || result === null) return { kind: "unknown" };
  const r = result as Record<string, unknown>;
  const override = parseOverrideValue(r.session);
  if (override === undefined) return { kind: "unknown" };
  return {
    kind: "held",
    override,
    overridesAllowed: typeof r.overridesAllowed === "boolean" ? r.overridesAllowed : undefined,
    ...(isKnowledgeInjection(r.injection) ? { injection: r.injection } : {}),
    ...(Array.isArray(r.effectiveSources)
      ? { effectiveSources: r.effectiveSources.filter(isSourceId).slice(0, 64) }
      : {}),
  };
}

/** Note a revision this session is to hold (a send's, an apply's). Never goes back. */
export function noteKnowledgeRevision(g: SessionKnowledgeGuard, revision: number | undefined | null): void {
  if (typeof revision === "number" && revision > g.revision) g.revision = revision;
}

export class KnowledgePolicyNotAppliedError extends Error {
  constructor(
    readonly reason: KnowledgePolicyFailure,
    detail?: string,
  ) {
    super(`knowledge policy not applied (${reason})${detail ? `: ${detail}` : ""}`);
    this.name = "KnowledgePolicyNotAppliedError";
  }
}

/** A transport refusal of `plugins.sessionAction`, by its upstream wording (§5;
 *  plugin-host-hooks.ts:160-170 and :180-184; error-codes.ts missingScopeErrorShape). */
export function classifyKnowledgeActionError(err: unknown): KnowledgePolicyFailure {
  const text = (err as Error)?.message ?? "";
  if (/unknown plugin session action|unknown method/i.test(text)) return "plugin_absent";
  if (/missing scope/i.test(text)) return "scope_refused";
  if (/does not match schema/i.test(text)) return "invalid_payload";
  return "rejected";
}

/** What a turn / an apply may tell the owner about the session afterwards. */
export interface PolicySnapshotView {
  injection: KnowledgeInjection;
  effectiveSources: string[];
  origin: { injection: string; sources: string };
}

export function parsePolicySnapshot(v: unknown): PolicySnapshotView | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isKnowledgeInjection(o.injection) || !Array.isArray(o.effectiveSources)) return null;
  const origin = (typeof o.origin === "object" && o.origin !== null ? o.origin : {}) as Record<
    string,
    unknown
  >;
  const originOf = (x: unknown) =>
    x === "session" || x === "agent" || x === "default" || x === "oneShot" ? x : "unknown";
  return {
    injection: o.injection,
    effectiveSources: o.effectiveSources.filter(isSourceId).slice(0, 64),
    origin: { injection: originOf(origin.injection), sources: originOf(origin.sources) },
  };
}

const PLUGIN_CODES = new Set<KnowledgePolicyFailure>([
  "overrides_disabled",
  "source_not_allowed",
  "unknown_source",
  "invalid_payload",
  "write_failed",
]);

/**
 * One `policy.set` / `policy.reset` on a session. An answered refusal — transport or the
 * plugin's own `{ok:false, code}` — throws `KnowledgePolicyNotAppliedError`; a request
 * that got NO answer is rethrown as is (it may have landed).
 */
export async function writeKnowledgePolicy(
  conn: GatewayRequester,
  sessionKey: string,
  agentId: string,
  desired: KnowledgeOverride | null,
): Promise<PolicySnapshotView | null> {
  const params: Record<string, unknown> = {
    pluginId: KNOWLEDGE_PLUGIN_ID,
    actionId: desired === null ? "policy.reset" : "policy.set",
    sessionKey,
    agentId,
    // `reset: true` drops the whole override first (§4.1): the session then holds
    // EXACTLY the choice, nothing left from an earlier one.
    ...(desired === null ? {} : { payload: { reset: true, ...desired } }),
  };
  let payload: Record<string, unknown> | undefined;
  try {
    payload = (await conn.request("plugins.sessionAction", params, 10_000)).payload;
  } catch (err) {
    if (err instanceof GatewayAnsweredError) {
      throw new KnowledgePolicyNotAppliedError(classifyKnowledgeActionError(err), err.message);
    }
    throw err;
  }
  if (payload?.ok === false) {
    const code = payload.code;
    const reason =
      typeof code === "string" && PLUGIN_CODES.has(code as KnowledgePolicyFailure)
        ? (code as KnowledgePolicyFailure)
        : "rejected";
    throw new KnowledgePolicyNotAppliedError(reason);
  }
  // PROOF, not the absence of a refusal (codex pass 3): only `ok: true` with a snapshot
  // (contract §3.2) whose effective state is the choice counts as applied. An empty or
  // malformed success withholds the turn like a refusal.
  const snapshot = payload?.ok === true ? parsePolicySnapshot(payload.result) : null;
  // …and a session left with a pending one-shot is not ours either (codex pass 11).
  const session =
    payload?.ok === true && typeof payload.result === "object" && payload.result !== null
      ? parseOverrideValue((payload.result as Record<string, unknown>).session)
      : undefined;
  if (snapshot === null || !snapshotConfirms(snapshot, desired) || session?.oneShot === true) {
    throw new KnowledgePolicyNotAppliedError("unconfirmed");
  }
  return snapshot;
}

/** Does the plugin's snapshot after a write show the choice in force? */
export function snapshotConfirms(
  snapshot: PolicySnapshotView,
  desired: KnowledgeOverride | null,
): boolean {
  if (desired === null) {
    // Reset: nothing of the session's own remains.
    return snapshot.origin.injection !== "session" && snapshot.origin.sources !== "session";
  }
  if (desired.injection !== undefined) {
    if (snapshot.injection !== desired.injection || snapshot.origin.injection !== "session") {
      return false;
    }
  }
  if (desired.sources !== undefined) {
    if (snapshot.origin.sources !== "session" || !sameSet(snapshot.effectiveSources, desired.sources)) {
      return false;
    }
    // Chosen sources under an inactive mode are searched by nothing (codex pass 13).
    if (snapshot.injection === "off") return false;
  }
  return true;
}

export interface KnowledgeEnforcement {
  /** The override the session was brought to (`concreteOverride`): what the last check
   *  before `chat.send` compares with. */
  desired: KnowledgeOverride | null;
  /** A write was sent to get there. */
  changed: boolean;
  /** `default` over an override the plugin would not reset (overrides disabled): the turn
   *  may go — the plugin ignores session state then — but the override is STILL STORED,
   *  so nothing may be recorded as "no override left" (codex pass 16). */
  inert?: true;
  /** Chosen ids the agent's CURRENT allowlist no longer holds (codex pass 19): left out
   *  of the write, the stored choice unchanged — reported `clamped`, exactly like a
   *  session that already held the choice and whose read the plugin clamps. */
  dropped?: string[];
  /** What the plugin answered after the write (null when nothing was written). */
  snapshot: PolicySnapshotView | null;
}

/**
 * Bring ONE session to the conversation's choice.
 *
 * `stored` is the override the session holds as last described (`null` = none,
 * `undefined` = unknown); an equal value costs nothing. `sessionAbsent` = the gateway
 * STATED there is no session under the key: the session the send is about to create
 * holds none, so `default` is already true there — and anything else needs the session
 * to exist first, because the plugin cannot write into a key with no session
 * (`write_failed`, measured). `createSession` makes it on the conversation's own socket
 * (`sessions.create`, operator.write — method-scopes.ts:194-196), after which the write
 * is retried ONCE.
 */
export async function enforceKnowledgePolicy(args: {
  choice: KnowledgeChoice;
  sessionKey: string;
  agentId: string;
  stored: KnowledgeOverride | null | undefined;
  sessionAbsent: boolean;
  conn: GatewayRequester;
  createSession?: () => Promise<unknown>;
}): Promise<KnowledgeEnforcement> {
  // A `sources` choice reads the agent's CURRENT view first (one `knowledge.sources`,
  // operator.read): its mode — a choice over an `off` default carries `auto` (codex pass
  // 13) — and its allowlist. Chosen ids the operator revoked since are LEFT OUT of the
  // write (codex pass 19): `policy.set` would refuse them (validateSourceSelection) and
  // block a turn that an existing session carrying the same choice sends, clamped. Both
  // paths now say the same: the allowed ids searched, the dropped ones reported.
  let agentMode: KnowledgeInjection | null = null;
  let allowed: string[] | null = null;
  let defaultSearchesNothing = false;
  if (args.choice.kind === "sources") {
    const probe = await probeKnowledgeSources(args.conn, args.agentId);
    if (probe.available) {
      agentMode = probe.info.injection;
      // A list this parse could not read whole is no basis to drop anything.
      if (probe.info.incomplete !== true) allowed = probe.info.sources.map((x) => x.id);
      defaultSearchesNothing = probe.info.defaultSources.length === 0;
    }
  }
  let desired = concreteOverride(args.choice, agentMode);
  const dropped =
    desired?.sources !== undefined && allowed !== null
      ? desired.sources.filter((id) => !allowed.includes(id))
      : [];
  if (desired?.sources !== undefined && dropped.length > 0) {
    const kept = desired.sources.filter((id) => !dropped.includes(id));
    if (kept.length > 0) {
      desired = { ...desired, sources: kept };
    } else if (defaultSearchesNothing) {
      // EVERY chosen id revoked: the existing-session rule applies
      // (knowledgeChatSendGate). There the plugin falls through to the agent default's
      // sources (policy.ts:388-390); the turn goes when nothing outside the choice is
      // searched — here the default searches nothing, so nothing is written and the
      // turn goes, every id reported dropped.
      desired = null;
    } else {
      // …and is withheld when that fallback would search sources OUTSIDE the choice.
      throw new KnowledgePolicyNotAppliedError("source_not_allowed");
    }
  }
  const clamp = dropped.length > 0 ? { dropped } : {};
  if (args.stored !== undefined && overrideMatches(args.stored, desired)) {
    return { desired, changed: false, snapshot: null, ...clamp };
  }
  if (args.sessionAbsent && desired === null) return { desired, changed: false, snapshot: null, ...clamp };
  try {
    const snapshot = await writeKnowledgePolicy(args.conn, args.sessionKey, args.agentId, desired);
    return { desired, changed: true, snapshot, ...clamp };
  } catch (err) {
    // Back to the default on an agent whose overrides the operator disabled: the
    // plugin refuses the reset (policy.ts applyPolicyPatch checks it first) but also
    // IGNORES every session state then (openclaw-knowledge policy.ts:422,
    // `overridesAllowed ? sanitizeSessionState(...) : {}`) — the operator's default is
    // what runs. The owner's way out, so it counts as satisfied.
    if (desired === null && err instanceof KnowledgePolicyNotAppliedError && err.reason === "overrides_disabled") {
      return { desired, changed: false, snapshot: null, inert: true, ...clamp };
    }
    if (
      !(err instanceof KnowledgePolicyNotAppliedError) ||
      err.reason !== "write_failed" ||
      !args.sessionAbsent ||
      args.createSession === undefined
    ) {
      throw err;
    }
  }
  try {
    await args.createSession();
  } catch (err) {
    if (err instanceof GatewayAnsweredError) {
      throw new KnowledgePolicyNotAppliedError("session_not_established", err.message);
    }
    throw err;
  }
  const snapshot = await writeKnowledgePolicy(args.conn, args.sessionKey, args.agentId, desired);
  return { desired, changed: true, snapshot, ...clamp };
}

// --- The agent's default (`POST /knowledge` op "default-set") -----------------------

export type KnowledgeRouteBody =
  | { op: "default-get"; instanceName: string | null; agentId: string }
  | {
      op: "default-set";
      instanceName: string | null;
      agentId: string;
      injection: KnowledgeInjection;
      sources: string[];
      /** What the administrator was shown: a default changed since (another operator,
       *  the CLI) refuses the write instead of overwriting it unseen. */
      expected: {
        injection: KnowledgeInjection;
        defaultSources: string[];
        /** The raw config values the admin's view was built on (absent: an older
         *  Convex, or discovery could not read the config). */
        config?: RawAgentDefault;
      } | null;
      /** The caller's budget for the whole write (under its own request timeout). */
      budgetMs?: number;
    };

/** Defensive parse of the admin half of the `/knowledge` body. */
export function parseKnowledgeDefaultBody(obj: Record<string, unknown>): KnowledgeRouteBody | null {
  const instanceName =
    typeof obj.instanceName === "string" && obj.instanceName.length > 0 ? obj.instanceName : null;
  const agentId = normalizeKnowledgeAgentId(obj.agentId);
  if (agentId === null) return null;
  if (obj.op === "default-get") return { op: "default-get", instanceName, agentId };
  if (obj.op !== "default-set") return null;
  if (!isKnowledgeInjection(obj.injection)) return null;
  if (!Array.isArray(obj.sources) || obj.sources.length === 0) return null;
  if (obj.sources.length > MAX_KNOWLEDGE_SOURCES || !obj.sources.every(isSourceId)) return null;
  let expected: Extract<KnowledgeRouteBody, { op: "default-set" }>["expected"] = null;
  if (obj.expected !== undefined && obj.expected !== null) {
    const e = obj.expected as Record<string, unknown>;
    if (!isKnowledgeInjection(e.injection) || !Array.isArray(e.defaultSources)) return null;
    if (!e.defaultSources.every(isSourceId)) return null;
    let config: RawAgentDefault | undefined;
    if (e.config !== undefined && e.config !== null) {
      const c = e.config as Record<string, unknown>;
      const inj = c.injection === null || typeof c.injection === "string" ? c.injection : undefined;
      const src =
        c.sources === null
          ? null
          : Array.isArray(c.sources) && c.sources.every((x) => typeof x === "string")
            ? (c.sources as string[])
            : undefined;
      if (inj === undefined || src === undefined) return null;
      config = { injection: inj, sources: src };
    }
    expected = {
      injection: e.injection,
      defaultSources: e.defaultSources as string[],
      ...(config === undefined ? {} : { config }),
    };
  }
  const budgetMs =
    typeof obj.budgetMs === "number" && obj.budgetMs >= 1_000 && obj.budgetMs <= 120_000
      ? obj.budgetMs
      : undefined;
  return {
    op: "default-set",
    ...(budgetMs === undefined ? {} : { budgetMs }),
    instanceName,
    agentId,
    injection: obj.injection,
    sources: [...new Set(obj.sources as string[])],
    expected,
  };
}

/** `plugins.entries.openclaw-knowledge.config.agents.<id>` from a `config.get` payload
 *  (its effective object lives under `payload.config`; conf.ts extractAgentDefaults). */
export function readAgentPolicyEntry(
  payload: Record<string, unknown> | undefined,
  agentId: string,
): Record<string, unknown> | null {
  const dig = (root: unknown, path: string[]): unknown => {
    let cur = root;
    for (const k of path) {
      if (typeof cur !== "object" || cur === null) return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  };
  const entry = dig(payload?.config, [
    "plugins",
    "entries",
    KNOWLEDGE_PLUGIN_ID,
    "config",
    "agents",
    agentId,
  ]);
  return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
}

/** The allowlist the RAW config imposes on an agent (codex pass 19): its own
 *  `allowedSources` if an array, else the plugin's `defaults.allowedSources` if an array,
 *  else null (no config-level bound — the plugin's view stands). */
export function rawAllowlistBound(
  payload: Record<string, unknown> | undefined,
  entry: Record<string, unknown> | null,
): string[] | null {
  if (Array.isArray(entry?.allowedSources)) return entry.allowedSources.filter(isSourceId);
  const defaults = knowledgePluginDefaults(payload);
  return Array.isArray(defaults?.allowedSources) ? defaults.allowedSources.filter(isSourceId) : null;
}

/**
 * Does the plugin's view (`knowledge.sources`) lag this config snapshot (codex pass 20)?
 *
 * What the plugin shows is resolved by openclaw-knowledge `resolvePolicy`
 * (src/config.ts:689-740, 4.1.0; the same rules in 4.0.x for the values below), agent
 * level over `defaults` over built-ins (config.ts:287-300). Compared, from the RAW
 * snapshot, only what it can be predicted EXACTLY from:
 *  - the ALLOWLIST: when the config bounds it (`rawAllowlistBound`: the agent's own
 *    `allowedSources`, else `defaults.allowedSources`), every id the plugin lists must be
 *    inside the bound. The converse is not comparable — an id of the bound may be a
 *    disabled or unknown source, which the plugin drops (config.ts:698-709).
 *  - the INJECTION: `agents.<id>.injection` if valid, else `defaults.injection` if valid,
 *    else the built-in `"auto"` (config.ts:290, :721) — always comparable.
 *  - the DEFAULT SELECTION: the agent's own `sources` (dedup'd) if a list, else the
 *    inherited one — `defaults.sources` (dedup'd) if a list, else every enabled source —
 *    clamped by `defaults.allowedSources` when that is a list (the defaults level is
 *    resolved first, config.ts:719); then clamped by the agent's allowlist (:719 again).
 *    The enabled/allowed ids are the plugin's own listed ids (already checked against the
 *    bound above), in its registry order — so the prediction is exact, in order.
 * `lightragQueryMode`, `topK` and `allowSessionOverrides` are not compared: an admin
 * write does not rest on them.
 */
export function pluginViewLags(
  payload: Record<string, unknown> | undefined,
  entry: Record<string, unknown> | null,
  info: KnowledgeAgentInfo,
): boolean {
  const offered = info.sources.map((x) => x.id);
  const bound = rawAllowlistBound(payload, entry);
  if (bound !== null && offered.some((id) => !bound.includes(id))) return true;
  const defaults = knowledgePluginDefaults(payload);
  const injection = isKnowledgeInjection(entry?.injection)
    ? entry.injection
    : isKnowledgeInjection(defaults?.injection)
      ? defaults.injection
      : "auto";
  if (injection !== info.injection) return true;
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))] : undefined;
  const own = list(entry?.sources);
  let predicted: string[];
  if (own !== undefined) {
    predicted = own.filter((id) => offered.includes(id));
  } else {
    const inherited = list(defaults?.sources);
    const defaultsAllowed = list(defaults?.allowedSources);
    predicted = (inherited ?? offered).filter(
      (id) => (defaultsAllowed === undefined || defaultsAllowed.includes(id)) && offered.includes(id),
    );
  }
  return !sameOrder(predicted, info.defaultSources);
}

/** `plugins.entries.openclaw-knowledge.config.defaults` of a `config.get` payload. */
function knowledgePluginDefaults(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const plugins = (payload?.config as Record<string, unknown> | undefined)?.plugins as
    | Record<string, unknown>
    | undefined;
  const plugin = (plugins?.entries as Record<string, unknown> | undefined)?.[KNOWLEDGE_PLUGIN_ID] as
    | Record<string, unknown>
    | undefined;
  const defaults = (plugin?.config as Record<string, unknown> | undefined)?.defaults;
  return typeof defaults === "object" && defaults !== null ? (defaults as Record<string, unknown>) : undefined;
}

/** The config path a `replacePaths` entry names for the agent's default sources. */
export function agentSourcesPath(agentId: string): string {
  return `plugins.entries.${KNOWLEDGE_PLUGIN_ID}.config.agents.${agentId}.sources`;
}

/**
 * The minimal merge-patch for an agent default: `injection` and `sources`, nothing else.
 * `allowedSources` is NEVER written (codex pass 18): the allowlist is the operator's —
 * pinning an inherited one froze the agent off later global revocations. Where writing
 * `sources` would move the allowlist (a 4.0.x plugin, an agent without its own), the
 * write is refused upstream of this (`defaultWritable`).
 */
export function buildAgentDefaultPatch(args: {
  agentId: string;
  injection: KnowledgeInjection;
  sources: string[];
}): { raw: string; replacePaths: string[] } {
  const agentPatch: Record<string, unknown> = {
    injection: args.injection,
    sources: args.sources,
  };
  return {
    raw: JSON.stringify({
      plugins: {
        entries: { [KNOWLEDGE_PLUGIN_ID]: { config: { agents: { [args.agentId]: agentPatch } } } },
      },
    }),
    // A default that drops a source removes array entries: the gateway refuses that
    // without the exact path (config.ts:365-391). Naming it is harmless otherwise.
    replacePaths: [agentSourcesPath(args.agentId)],
  };
}

/** Our own refusal to write without the compare-and-set guard. */
export class UnguardedConfigError extends Error {
  constructor() {
    super("config.get carried no revision guard: refusing to patch unguarded");
    this.name = "UnguardedConfigError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Why an admin write was refused — shared with Convex and the admin card. */
export type KnowledgeDefaultRefusal =
  | "knowledge_unavailable"
  | "stale_default"
  | "source_not_allowed"
  | "scope_refused"
  | "config_rejected"
  | "base_hash_conflict"
  | "config_unguarded"
  | "not_confirmed"
  | "not_applied"
  | "write_unknown"
  | "deadline_before_write"
  /** The agent's default in the config cannot be carried without loss (too many ids,
   *  too long, or not representable): refused rather than checked against a cut view. */
  | "default_too_large"
  /** The plugin's allowlist or default list for the agent could not be read WHOLE (past
   *  KNOWLEDGE_ALLOWLIST_CAP, or an unreadable entry). */
  | "allowlist_too_large"
  /** openclaw-knowledge 4.0.x and an agent without its own `allowedSources`: writing its
   *  default would narrow its allowlist (codex pass 18). Update the plugin to 4.1. */
  | "plugin_too_old"
  /** The plugin still shows another config than the one the write is guarded by (a hot
   *  reload in progress): nothing is compared with a lagging view (codex pass 20). */
  | "plugin_config_lag";

/**
 * Execute one admin op on the agent default. Pure over the requester (tests inject it);
 * the route owns the socket (the bridge's system operator connection).
 */
// --- One deadline for the whole admin write (codex pass 6) -----------------------------

/** What the bridge gives an admin write when the caller names no budget: below the
 *  Convex action's own POST timeout (convex/knowledge.ts), so the admin always hears the
 *  bridge's verdict rather than "bridge unreachable". */
export const KNOWLEDGE_DEFAULT_BUDGET_MS = 38_000;

/** The deadline passed before a request could be issued. */
export class KnowledgeDeadlineError extends Error {
  /** `true`: refused before the request left (nothing sent). `false`: the request was
   *  sent and the deadline ran out waiting for its answer (it may have landed). */
  constructor(readonly beforeIssue: boolean = true) {
    super("knowledge default write: deadline reached");
    this.name = "KnowledgeDeadlineError";
  }
}

/**
 * What remains until `deadline` (bridge clock), for the calls of one admin write. Every
 * request's timeout goes through `timeout()` — refused (nothing sent) once nothing
 * remains — and its answer through `race()`, so a transport that ignored its timeout
 * still cannot hold the procedure past the deadline. Each call keeps its literal method
 * name (the RPC-scope and outbound ratchets read them).
 */
export function deadlineClock(deadline: number): {
  left: () => number;
  timeout: (base: number) => number;
  race: <T>(p: Promise<T>) => Promise<T>;
} {
  const left = () => deadline - Date.now();
  return {
    left,
    timeout(base) {
      const l = left();
      if (l <= 0) throw new KnowledgeDeadlineError(true);
      return Math.max(1, Math.min(base, l));
    },
    race<T>(p: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new KnowledgeDeadlineError(false)), Math.max(1, left()) + 50);
      });
      return Promise.race([p, expiry]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    },
  };
}

/** Our own marker: `config.patch` was SENT and got no answer (the socket closed — a
 *  config change can restart the gateway — or the request timed out). It may have
 *  applied; only a fresh read can say. */
class LostConfigWriteError extends Error {
  constructor(readonly baseHash: string) {
    super("config.patch got no answer");
    this.name = "LostConfigWriteError";
  }
}

/** How the route lets the op read the gateway again on a FRESH operator connection. */
export interface KnowledgeDefaultDeps {
  readFresh?: <X>(fn: (conn: GatewayRequester) => Promise<X>) => Promise<X>;
  wait?: (ms: number) => Promise<void>;
  attempts?: number;
  /** Absolute deadline (bridge clock) for the whole procedure; default: now + the
   *  body's `budgetMs`, else KNOWLEDGE_DEFAULT_BUDGET_MS. */
  deadline?: number;
}

/**
 * The write's fate when its answer was lost, or the same socket could not confirm it:
 * reconnect (the gateway may be restarting) and read back BEFORE concluding — and keep
 * reading, since a patch still in flight or a plugin reloading later can still land the
 * value (codex pass 5). The config file is the authority on whether the patch applied;
 * the plugin's own view says whether it is in force. Outcomes, never a silent failure:
 *  - applied: the config carries it AND the plugin shows it (the read-back is stored);
 *  - not_applied: POSITIVE evidence it never will — the config moved to a revision other
 *    than the one our patch was guarded by (`baseHash`) and does not carry our write: a
 *    patch guarded by the old hash can no longer commit;
 *  - stale_default: the patch WAS answered (committed) and the config no longer carries
 *    it — another write replaced it;
 *  - not_confirmed: when the budget ran out, the config carried it but the plugin had
 *    not shown it yet;
 *  - write_unknown: when the budget ran out, nothing settled it.
 */
async function afterLostWrite(
  body: Extract<KnowledgeRouteBody, { op: "default-set" }>,
  deps: KnowledgeDefaultDeps,
  sent: { answered: true } | { answered: false; baseHash: string },
  deadline: number,
  alreadySawWritten = false,
): Promise<OpResult> {
  const notConfirmed: OpResult = { status: 502, body: { ok: false, error: { code: "not_confirmed" } } };
  const unknown: OpResult = { status: 502, body: { ok: false, error: { code: "write_unknown" } } };
  if (deps.readFresh === undefined) return alreadySawWritten ? notConfirmed : unknown;
  const readFresh = deps.readFresh;
  const wait = deps.wait ?? sleep;
  let sawWritten = alreadySawWritten;
  for (let i = 0; i < (deps.attempts ?? 8) && Date.now() < deadline; i += 1) {
    await wait(Math.max(0, Math.min(2_000, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    try {
      // The fresh connection itself (its open) is bounded by what remains too.
      let expire: ReturnType<typeof setTimeout> | undefined;
      const verdict = await Promise.race([
        // One STABLE read per fresh connection, a few plugin re-reads within it
        // (codex pass 10: the same settlement as the direct path).
        readFresh((fresh) => settleDefaultWrite(fresh, body, sent, deadline, 6)),
        new Promise<never>((_, reject) => {
          expire = setTimeout(
            () => reject(new KnowledgeDeadlineError()),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]).finally(() => {
        if (expire !== undefined) clearTimeout(expire);
      });
      const settled = writeVerdictResult(verdict, true);
      if (settled !== null) return settled;
      if (verdict.kind === "unreflected") sawWritten = true;
      // `pending` / `unreflected` / `unreadable`: not settled yet — read again.
    } catch {
      // Not reachable yet (restarting): try again within the bound.
    }
  }
  return sawWritten ? notConfirmed : unknown;
}

export async function performKnowledgeDefaultOp(
  conn: GatewayRequester,
  body: KnowledgeRouteBody,
  deps: KnowledgeDefaultDeps = {},
): Promise<OpResult> {
  // ONE deadline for everything below, under the caller's own (codex pass 6): every
  // request is capped by what remains, and the admin hears the bridge's verdict —
  // `deadline_before_write` when nothing was sent, `write_unknown` after — never the
  // caller's own timeout.
  const deadline =
    deps.deadline ??
    Date.now() +
      (body.op === "default-set" && body.budgetMs !== undefined
        ? body.budgetMs
        : KNOWLEDGE_DEFAULT_BUDGET_MS);
  const clock = deadlineClock(deadline);
  if (body.op === "default-get") {
    // The effective view and the raw entry as ONE coherent pair (codex pass 9).
    const read = await readKnowledgeBaseline(
      conn,
      async () => ({
        [body.agentId]: await clock.race(
          probeKnowledgeSources(conn, body.agentId, clock.timeout(8_000)),
        ),
      }),
      { deadline },
    );
    const probe = read[body.agentId] ?? { available: false, reason: "unreadable" };
    if (!probe.available) {
      return {
        status: 409,
        body: { ok: false, error: { code: "knowledge_unavailable", reason: probe.reason } },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        knowledge: probe.info,
        ...(probe.config === undefined ? {} : { config: probe.config, ownAllowlist: probe.ownAllowlist }),
        ...(probe.observedAt === undefined ? {} : { observedAt: probe.observedAt }),
      },
    };
  }
  /**
   * ONE attempt: read the config (its hash), then the plugin's CURRENT view, verify
   * `expected` and the allowlist against BOTH, and only then write under that hash. Every
   * attempt re-reads — a retry after a hash conflict must not write over a default another
   * operator just changed, nor a source they just removed from the allowlist (codex P2).
   * The config snapshot is checked too because the plugin reloads AFTER the file changes:
   * an entry of that very hash stating another default, or an allowlist without a
   * requested source, refuses the write even while the runtime still answers the old
   * values. Returns the refusal, or null once written.
   */
  const attempt = async (): Promise<OpResult | null> => {
    const readAt = Date.now();
    const pre = await clock.race(conn.request("config.get", {}, clock.timeout(10_000)));
    const baseHash = configHash(pre.payload);
    if (baseHash === null) {
      // Same rule as the chat defaults (conf.ts): no hash, no write. A class of its own,
      // never a wording: conf.ts learnt that a refusal matching `/base ?hash/` gets
      // retried as if it were a concurrency conflict.
      throw new UnguardedConfigError();
    }
    const entry = readAgentPolicyEntry(pre.payload, body.agentId);
    if (!rawDefaultStorable(entry)) {
      return { status: 409, body: { ok: false, error: { code: "default_too_large" } } };
    }
    const probe = await clock.race(
      probeKnowledgeSources(conn, body.agentId, clock.timeout(8_000)),
    );
    if (!probe.available) {
      return {
        status: 409,
        body: { ok: false, error: { code: "knowledge_unavailable", reason: probe.reason } },
      };
    }
    const info = probe.info;
    // Validated and compared against these lists: never cut ones (codex passes 16, 18).
    if (info.incomplete === true) {
      return { status: 409, body: { ok: false, error: { code: "allowlist_too_large" } } };
    }
    // A default list longer than what the admin's view can carry (Convex keeps 64): the
    // stale check could never match it — refused by name, never a perpetual conflict.
    if (info.defaultSources.length > KNOWLEDGE_RAW_SOURCES_MAX) {
      return { status: 409, body: { ok: false, error: { code: "default_too_large" } } };
    }
    // THE CONTRACT, read in this very attempt with the config snapshot the write is
    // guarded by (codex pass 18): a plugin reload between two attempts is seen here.
    if (!defaultWritable(info, entry)) {
      return { status: 409, body: { ok: false, error: { code: "plugin_too_old" } } };
    }
    // THE PLUGIN'S VIEW MUST BE THE CONFIG'S (codex pass 20, closing the class of passes
    // 18-20): everything below compares against that view, and it lags the file on a
    // hot reload. What the raw config says the plugin should show NOW is resolved from
    // this very snapshot; any comparable value that differs refuses the write.
    if (pluginViewLags(pre.payload, entry, info)) {
      return { status: 409, body: { ok: false, error: { code: "plugin_config_lag" } } };
    }
    // The allowlist the RAW config imposes on this very snapshot (codex pass 19): the
    // agent's own `allowedSources`, else the inherited `defaults.allowedSources`, else no
    // config-level bound. The plugin's view can lag the file (hot reload): a source the
    // operator just revoked there must not be written into the agent's `sources`, where
    // it would come back unseen the day it is re-authorized. Never widened.
    let allowlist = info.sources.map((s) => s.id);
    const rawBound = rawAllowlistBound(pre.payload, entry);
    if (rawBound !== null) allowlist = allowlist.filter((id) => rawBound.includes(id));
    if (body.expected !== null) {
      const expected = body.expected;
      // The config as written, UNFILTERED (codex pass 3): the allowlist only validates
      // the requested sources below, never what counts as "changed".
      const raw = rawAgentDefault(entry);
      // EXACT, in order (codex pass 4): the raw config is compared as written — a
      // reorder by another operator is a change. Set semantics stay only on the
      // plugin's EFFECTIVE view below: its order is the config's, already compared here
      // in order, and the runtime can lag the file, so only its content is checked.
      const rawSame = (a: string[] | null, b: string[] | null) =>
        a === null || b === null ? a === b : sameOrder(a, b);
      const configChanged =
        expected.config !== undefined
          ? // The raw view the admin's screen was built on, compared exactly.
            raw.injection !== expected.config.injection ||
            !rawSame(raw.sources, expected.config.sources)
          : // No raw view (older Convex): a written value must equal what was shown —
            // the FULL array, so an id the plugin filters out reads as a change.
            (raw.injection !== null && raw.injection !== expected.injection) ||
            (raw.sources !== null && !sameOrder(raw.sources, expected.defaultSources));
      if (
        expected.injection !== info.injection ||
        !sameSet(expected.defaultSources, info.defaultSources) ||
        configChanged
      ) {
        return {
          status: 409,
          body: {
            ok: false,
            error: { code: "stale_default" },
            knowledge: info,
            // The raw view only as a pair the plugin reflects (codex passes 9-10): a
            // lagging pair would become the admin's next baseline.
            ...(rawReflected(raw, info) ? { config: raw } : {}),
            observedAt: readAt,
          },
        };
      }
    }
    if (!body.sources.every((id) => allowlist.includes(id))) {
      // Atrium only ever offers what the plugin lists; a body naming anything else — or
      // a source removed since — is refused here, before any write.
      return { status: 409, body: { ok: false, error: { code: "source_not_allowed" } } };
    }
    const patch = buildAgentDefaultPatch({
      agentId: body.agentId,
      injection: body.injection,
      sources: body.sources,
    });
    try {
      await clock.race(
        conn.request(
          "config.patch",
          { raw: patch.raw, baseHash, replacePaths: patch.replacePaths },
          clock.timeout(15_000),
        ),
      );
    } catch (err) {
      // An ANSWERED refusal (a hash conflict, a scope, a validation error) is final and
      // handled below; NO answer may hide an applied write. A deadline reached BEFORE
      // the request left sent nothing.
      if (err instanceof GatewayAnsweredError) throw err;
      if (err instanceof KnowledgeDeadlineError && err.beforeIssue) throw err;
      throw new LostConfigWriteError(baseHash);
    }
    return null;
  };
  try {
    let refused: OpResult | null;
    try {
      refused = await attempt();
    } catch (err) {
      if (err instanceof UnguardedConfigError || !isBaseHashError(err)) throw err;
      // The config moved between our read and our write: ONE retry, which re-reads and
      // re-verifies everything on the fresh state.
      try {
        refused = await attempt();
      } catch (err2) {
        if (!(err2 instanceof UnguardedConfigError) && isBaseHashError(err2)) {
          return { status: 409, body: { ok: false, error: { code: "base_hash_conflict" } } };
        }
        throw err2;
      }
    }
    if (refused !== null) return refused;
  } catch (err) {
    if (err instanceof UnguardedConfigError) {
      return { status: 502, body: { ok: false, error: { code: "config_unguarded" } } };
    }
    if (err instanceof LostConfigWriteError) {
      return await afterLostWrite(body, deps, { answered: false, baseHash: err.baseHash }, deadline);
    }
    if (err instanceof KnowledgeDeadlineError) {
      // Out of time before the patch was issued (a read timed out at the deadline, or
      // nothing remained to send it): nothing was written.
      return { status: 504, body: { ok: false, error: { code: "deadline_before_write" } } };
    }
    if (!(err instanceof GatewayAnsweredError)) throw err;
    const text = err.message;
    const code: KnowledgeDefaultRefusal = /missing scope/i.test(text)
      ? "scope_refused"
      : "config_rejected";
    return { status: code === "scope_refused" ? 403 : 502, body: { ok: false, error: { code } } };
  }
  // SETTLED on a stable read (codex pass 10): `applied` only when the config carries
  // the requested value AND the plugin reflects that config; another value in the
  // config is `stale_default`, whatever the plugin still shows.
  const verdict = await settleDefaultWrite(conn, body, { answered: true }, deadline, 6);
  const settled = writeVerdictResult(verdict, false);
  if (settled !== null) return settled;
  // Not settled on THIS socket: it may simply have died with a restart the write
  // caused, or the plugin not have reloaded yet — keep reading on a fresh one before
  // calling it anything. Never stored as confirmed meanwhile.
  return await afterLostWrite(
    body,
    deps,
    { answered: true },
    deadline,
    verdict.kind === "unreflected",
  );
}

/** How many config.get → knowledge.sources → config.get sandwiches one baseline read may
 *  take before it gives up pairing (then: no raw view). */
export const KNOWLEDGE_BASELINE_ATTEMPTS = 2;

/** Discovery's whole knowledge ride-along: the probe budget plus the one config read it
 *  always had (8 s). The baseline sandwich runs inside it, never beyond. */
export const KNOWLEDGE_DISCOVERY_BUDGET_MS = KNOWLEDGE_PROBE_BUDGET_MS + 8_000;

/**
 * Does the plugin's EFFECTIVE view reflect this raw entry? Mirrors the plugin's own
 * resolution (openclaw-knowledge src/config.ts:679-707 resolvePolicy): a valid raw
 * `injection` is taken as is; raw `sources` are de-duplicated, then kept only when the
 * agent may use them (enabled and allowed — exactly the ids `knowledge.sources` lists,
 * policy.ts:207-213), IN THEIR ORDER (config.ts:703). An absent key falls back to the
 * plugin's defaults, which this entry cannot predict: not checked.
 */
export function rawReflected(raw: RawAgentDefault, info: KnowledgeAgentInfo): boolean {
  if (isKnowledgeInjection(raw.injection) && raw.injection !== info.injection) return false;
  if (raw.sources !== null) {
    const offered = new Set(info.sources.map((s) => s.id));
    const predicted = [...new Set(raw.sources)].filter((id) => offered.has(id));
    if (!sameOrder(predicted, info.defaultSources)) return false;
  }
  return true;
}

/**
 * ONE coherent baseline: the plugin's effective view and the raw config entry an admin's
 * next write is checked against, published as a PAIR only when they describe the same
 * config (codex pass 9). A raw view read after the effective one could be a NEWER config
 * than the card shows — and if that edit left the effective view unchanged (a disabled
 * source added), the next save would pass both comparisons and overwrite it unseen.
 *
 * The read is a sandwich: `config.get` (H1) → `probe()` → `config.get` (H2). The raw
 * entry (from H1) is attached only when H1 === H2 AND the plugin's view reflects it
 * (`rawReflected`; a mismatch under the same hash is the plugin not having reloaded
 * yet). Otherwise the sandwich is read again, bounded by `attempts` and the deadline;
 * past that the probes go out WITHOUT a raw view: Convex drops its baseline and the next
 * save falls back to the strict full-array comparison (a reload is then required).
 *
 * A paired probe is stamped with the OLDER of its two sends (H1's): the pair is only
 * as fresh as its first read. Unpaired probes keep their own stamp.
 */
export async function readKnowledgeBaseline(
  conn: GatewayRequester,
  probe: () => Promise<Record<string, KnowledgeProbe>>,
  opts: { deadline: number; attempts?: number },
): Promise<Record<string, KnowledgeProbe>> {
  const clock = deadlineClock(opts.deadline);
  const attempts = Math.max(1, opts.attempts ?? KNOWLEDGE_BASELINE_ATTEMPTS);
  let probes: Record<string, KnowledgeProbe> = {};
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0 && clock.left() <= 0) break;
    let read: ConfigSandwich<Record<string, KnowledgeProbe>>;
    try {
      // Nothing available: nothing to pair, the second config read is not asked.
      read = await configSandwich(conn, probe, clock, (p) =>
        Object.values(p).some((x) => x.available),
      );
    } catch (err) {
      // The first read's failure is the caller's; a RE-read's leaves the last answer
      // standing, unpaired.
      if (i === 0) throw err;
      break;
    }
    probes = read.probes;
    if (read.kind === "no_config") return probes;
    if (read.kind === "moved") continue;
    const paired: Record<string, KnowledgeProbe> = { ...probes };
    let lagging = false;
    for (const [agentId, p] of Object.entries(probes)) {
      const id = normalizeKnowledgeAgentId(agentId);
      if (!p.available || id === null) continue;
      const entry = readAgentPolicyEntry(read.payload, id);
      // Past the bounds: never a (cut) baseline — and nothing a re-read would change.
      if (!rawDefaultStorable(entry)) continue;
      const raw = rawAgentDefault(entry);
      if (!rawReflected(raw, p.info)) {
        lagging = true;
        continue;
      }
      paired[agentId] = {
        ...p,
        config: raw,
        ownAllowlist: Array.isArray(entry?.allowedSources),
        observedAt: Math.min(read.readAt, p.observedAt ?? read.readAt),
      };
    }
    if (!lagging || i === attempts - 1 || clock.left() <= 0) return paired;
  }
  return probes;
}

/** One `config.get` → probe → `config.get` read (readKnowledgeBaseline, settleDefaultWrite). */
type ConfigSandwich<P> =
  /** Both config reads carry the same hash: `payload` is the config the probe ran under. */
  | { kind: "stable"; payload: Record<string, unknown> | undefined; hash: string; readAt: number; probes: P }
  /** The config changed between the two reads. */
  | { kind: "moved"; probes: P }
  /** A config read failed (or `needConfig` said the probe needs none). */
  | { kind: "no_config"; probes: P };

async function configSandwich<P>(
  conn: GatewayRequester,
  probe: () => Promise<P>,
  clock: ReturnType<typeof deadlineClock>,
  needConfig: (probes: P) => boolean = () => true,
): Promise<ConfigSandwich<P>> {
  const readConfig = async (): Promise<{
    payload: Record<string, unknown> | undefined;
    hash: string;
  } | null> => {
    try {
      const res = await clock.race(conn.request("config.get", {}, clock.timeout(8_000)));
      const hash = configHash(res.payload);
      return hash === null ? null : { payload: res.payload, hash };
    } catch {
      return null;
    }
  };
  const readAt = Date.now();
  const before = clock.left() > 0 ? await readConfig() : null;
  const probes = await probe();
  if (before === null || !needConfig(probes)) return { kind: "no_config", probes };
  const after = clock.left() > 0 ? await readConfig() : null;
  if (after === null) return { kind: "no_config", probes };
  if (after.hash !== before.hash) return { kind: "moved", probes };
  return { kind: "stable", payload: before.payload, hash: before.hash, readAt, probes };
}

/** What a stable read says about an admin write (settleDefaultWrite). */
type WriteVerdict =
  /** The config carries the write AND the plugin reflects it: stored as the default. */
  | {
      kind: "applied";
      info: KnowledgeAgentInfo;
      config: RawAgentDefault;
      ownAllowlist: boolean;
      observedAt: number;
    }
  /** The config carries ANOTHER value: `stale_default`, with what it is now. The
   *  effective view rides along only when it reflects that config (never a lagging pair). */
  | {
      kind: "replaced";
      info?: KnowledgeAgentInfo;
      config?: RawAgentDefault;
      ownAllowlist?: boolean;
      observedAt: number;
    }
  /** Unanswered write, config moved past its base hash without it: it will never land. */
  | { kind: "not_applied" }
  /** Unanswered write, config still at its base hash: it may still land. */
  | { kind: "pending" }
  /** The config carries the write, the plugin has not reflected it yet. */
  | { kind: "unreflected" }
  /** No stable read could be taken. */
  | { kind: "unreadable" };

/**
 * Settle an admin write against a STABLE read (codex pass 10): the config as it is
 * (the same hash on both sides of the plugin read) decides whether the write is there,
 * and only a plugin view reflecting THAT config confirms it. A plugin still showing the
 * requested value while the config already carries another operator's is never taken
 * for a confirmation. Retries (bounded by `attempts` and the deadline) only while the
 * config moves, cannot be read, or carries the write the plugin has not reloaded yet.
 */
async function settleDefaultWrite(
  conn: GatewayRequester,
  body: Extract<KnowledgeRouteBody, { op: "default-set" }>,
  sent: { answered: true } | { answered: false; baseHash: string },
  deadline: number,
  attempts: number,
): Promise<WriteVerdict> {
  const clock = deadlineClock(deadline);
  let sawOurs = false;
  for (let i = 0; i < attempts && clock.left() > 0; i += 1) {
    if (i > 0) await sleep(Math.max(0, Math.min(500, clock.left())));
    if (clock.left() <= 0) break;
    const read = await configSandwich(conn, async () => {
      try {
        return await clock.race(probeKnowledgeSources(conn, body.agentId, clock.timeout(8_000)));
      } catch {
        return { available: false, reason: "unreadable" } as KnowledgeProbe;
      }
    }, clock);
    if (read.kind !== "stable") continue;
    const entry = readAgentPolicyEntry(read.payload, body.agentId);
    const raw = rawAgentDefault(entry);
    const storable = rawDefaultStorable(entry);
    const p = read.probes;
    const ours =
      raw.injection === body.injection && raw.sources !== null && sameOrder(raw.sources, body.sources);
    if (!ours) {
      if (!sent.answered) return read.hash !== sent.baseHash ? { kind: "not_applied" } : { kind: "pending" };
      return {
        kind: "replaced",
        ...(storable && p.available && rawReflected(raw, p.info) ? { info: p.info } : {}),
        ...(storable ? { config: raw, ownAllowlist: Array.isArray(entry?.allowedSources) } : {}),
        observedAt: read.readAt,
      };
    }
    sawOurs = true;
    if (p.available && rawReflected(raw, p.info)) {
      return {
        kind: "applied",
        info: p.info,
        config: raw,
        ownAllowlist: Array.isArray(entry?.allowedSources),
        observedAt: Math.min(read.readAt, p.observedAt ?? read.readAt),
      };
    }
  }
  return sawOurs ? { kind: "unreflected" } : { kind: "unreadable" };
}

/** The route's answer for a settled verdict (null: not settled, read again). */
function writeVerdictResult(v: WriteVerdict, fresh: boolean): OpResult | null {
  if (v.kind === "applied") {
    return {
      status: 200,
      body: {
        ok: true,
        knowledge: v.info,
        config: v.config,
        ownAllowlist: v.ownAllowlist,
        observedAt: v.observedAt,
        ...(fresh ? { confirmedAfterReconnect: true } : {}),
      },
    };
  }
  if (v.kind === "replaced") {
    return {
      status: 409,
      body: {
        ok: false,
        error: { code: "stale_default" },
        ...(v.info === undefined ? {} : { knowledge: v.info }),
        ...(v.config === undefined ? {} : { config: v.config, ownAllowlist: v.ownAllowlist }),
        observedAt: v.observedAt,
      },
    };
  }
  if (v.kind === "not_applied") {
    return { status: 502, body: { ok: false, error: { code: "not_applied" } } };
  }
  return null;
}
