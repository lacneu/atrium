// The MODEL ROSTER a chat can pick from: the gateway's `models.list`, cached per
// connection and per owner, invalidated by the connection's own signals
// (`config.changed`, a frame gap), and published to Convex as part of the session
// meta. Lives outside server.ts so the session can wire the invalidation hook to the
// refresh itself — one hop, like `onFrameGap` — without the import cycle
// session.ts → server.ts.
import { MODELS_LIST_OWNER_SINCE, gatewayAtLeast } from "../../compat.js";
import type { ConvexWriter, SessionMetaReport, SessionRosterReport } from "../../convex-writer.js";
import { sessionFillDetail } from "../../core/context-budget.js";
import type { ConfigChangedNotice } from "./config-changed.js";
import type { OpenClawConnection } from "./openclaw-client.js";

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
export function selectBudgetAssessment(
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
 * Extract the header-strip session meta from a `sessions.describe` session row.
 * Defensive about shapes (agentRuntime may be a string or `{id}`; thinkingLevels
 * may be strings or `{id,label}`; fresh sessions omit token counts). The
 * "reasoning level" shown is the per-session OVERRIDE if set, else the agent
 * default (so the chip's "inherited" badge is correct). Non-secret labels only.
 */
export function parseSessionMeta(
  sess: Record<string, unknown>,
  availableModels?: { id: string; label: string }[] | null,
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
    // `null`/absent = nothing in hand (the ask failed with no last good roster): the
    // field is omitted and Convex keeps the roster on record for the same owner.
    availableModels: availableModels ?? undefined,
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

/** The owner `models.list` must name on a multi-agent gateway. The live session
 *  is authoritative, but `sessions.describe` may omit its OPTIONAL `agentId`
 *  (SessionRow.agentId is optional in 2026.8.x); the turn's routed `agentId`
 *  is mandatory in every request body and already known — never send an
 *  ownerless request when the owner is in hand (2026.8.1 refuses it and
 *  ensureAvailableModels would keep serving the last good roster, or `[]` if none). */
export function resolveModelsOwner(
  sess: { agentId?: unknown } | null | undefined,
  routedAgentId: string | null | undefined,
): string | null {
  if (sess && typeof sess.agentId === "string" && sess.agentId !== "") return sess.agentId;
  return typeof routedAgentId === "string" && routedAgentId !== "" ? routedAgentId : null;
}

/** Whether `models.list` takes (and, on a multi-agent roster, REQUIRES) an
 *  `agentId` owner on this gateway. Two generations, two opposite contracts:
 *  `ModelsListParamsSchema` is a CLOSED object without `agentId` up to 2026.7.x
 *  (vendored 2026.6.11 and 2026.7.1: `additionalProperties: false`) — sending
 *  one is refused — and declares it from 2026.8.1, where an ownerless request is
 *  refused on a multi-agent roster. This is decided on the RAW gateway version,
 *  not the capability table: `resolveCapabilitiesFor` deliberately caps a
 *  version beyond `maxValidated` to the last validated one, which would answer
 *  "no owner" on 2026.8.2 exactly where the owner is mandatory. `null` (the
 *  handshake did not say) = unknown: the caller tries the owner form first and
 *  falls back once. */
export function modelsListTakesOwner(gatewayVersion: string | null): boolean | null {
  return gatewayAtLeast(gatewayVersion, MODELS_LIST_OWNER_SINCE);
}

/** How long a `models.list` failure stays cached. Long enough that a dead gateway
 *  does not cost an 8s timeout per turn, short enough that a first-ever failure (the only
 *  case with no last good roster to serve) does not leave an empty picker until the
 *  bridge restarts. */
const MODELS_FAILURE_TTL_MS = 60_000;
/** How long a SUCCESSFUL roster is served without being re-asked. The real
 *  invalidation is the connection's own signal (openclaw-client.ts): `config.changed`,
 *  or an envelope frame gap — a `dropIfSlow` broadcast that was lost consumed a `seq`,
 *  and the gap detector already sees that. This bound is belt-and-braces for whatever
 *  neither signal covers, and it never blocks a turn: past it the cached roster is
 *  served as is and refreshed in the background. */
const MODELS_SUCCESS_TTL_MS = 10 * 60_000;

/** A roster in hand: the gateway's answer, the owner it was asked for and the stamp
 *  Convex orders it by (convex-writer.ts, SessionRosterReport). */
export type RosterInHand = SessionRosterReport;
/** The cache entry per owner and connection. `roster` is the last GOOD answer (`null`
 *  when there never was one — nothing in hand), kept across a failure, and `rosterEpoch`
 *  the epoch it was asked in (-1 with none); `ok` says whether the LAST ask succeeded;
 *  `at` is the last ask's time (the two bounds read it); `epoch` is the connection's
 *  roster epoch when that ask was SENT. The roster's epoch is its own: a failed ask
 *  after a good one in the same epoch marks the entry failed without un-filing the
 *  roster, so the roster on record still answers "is it the post-change one". */
export interface RosterEntry {
  roster: RosterInHand | null;
  rosterEpoch: number;
  at: number;
  ok: boolean;
  epoch: number;
}
/** What a publisher needs of the writer: the meta, and the roster on its own. */
export type RosterWriter = Pick<ConvexWriter, "reportSessionMeta" | "reportSessionRoster">;
/** How an ask may wait: by default the roster in hand is served and a stale one is
 *  re-asked off the caller's path; `fresh` waits for a post-invalidation answer (a
 *  failure inside its bound is still honoured); `forced` is the policy's deliberate
 *  retry — fresh, and past the failure bound. */
export type AskMode = "fresh" | "forced";

/** The three members of a connection the roster logic reads. Typed narrowly so a test
 *  double that has them needs no cast, and one that lacks the new field fails to compile
 *  instead of silently behaving as never-invalidated. */
export interface ModelsConnection {
  gatewayVersion: OpenClawConnection["gatewayVersion"];
  modelsByOwner: OpenClawConnection["modelsByOwner"];
  rosterEpoch: number;
  readonly isClosed: boolean;
  request(method: string, params: unknown, timeoutMs?: number): Promise<{ payload?: unknown }>;
}

/** What the roster POLICY needs of a connection: the roster state plus the two raw
 *  signals it turns into invalidations, and the close hook it disposes itself on. */
export interface PolicyConnection extends ModelsConnection {
  onConfigChanged(listener: (notice: ConfigChangedNotice) => void): () => void;
  onClosed(listener: () => void): () => void;
}

/** One `models.list` in flight per owner and connection: a send and a patch crossing
 *  right after an invalidation must not each pay the round trip (the repo's
 *  `versionDiscoveryInFlight` idiom). Keyed weakly on the connection so a closed socket
 *  takes its entries with it. An ask is joined only if it was SENT in the current epoch
 *  — an answer computed on the old config is not the one being asked for. */
const modelsInFlight = new WeakMap<
  object,
  Map<string, { epoch: number; promise: Promise<RosterInHand | null> }>
>();

/** Which form to send, and under which key the answer is filed — one derivation of
 *  (gateway version, agent), used by every ask. */
function modelsQuery(conn: ModelsConnection, agentId: string | null | undefined) {
  const takesOwner = modelsListTakesOwner(conn.gatewayVersion ?? null);
  // KNOWN version: send the form that generation declares. UNKNOWN version: send the
  // form EVERY supported generation accepts — the ownerless one — and keep the owned
  // form for the retry. Guessing the owned form first put `agentId` on the wire for a
  // gateway whose schema forbids additional properties, which the outbound ratchet
  // refuses (it was invisible until a test fake gained the models cache and the call
  // actually ran). One extra round trip on an unversioned 2026.8.1+ handshake is the
  // price of never sending a body a supported version rejects.
  const withOwner = Boolean(agentId) && takesOwner === true;
  // The cache key is the POSSIBLE SCOPE of the answer, which is NOT the same question
  // as which form to send first. On an unknown version the ownerless form goes out
  // first, yet its retry may answer for one agent — keying on the form sent would have
  // filed Alice's catalogue under the connection-wide key and served it to Bob (codex,
  // a defect introduced by the previous fix). `""` is used only where the answer really
  // is connection-wide: a generation that declares it, or a call with no agent at all.
  const ownerKey = agentId && takesOwner !== false ? agentId : "";
  return { takesOwner, withOwner, ownerKey, agentId: agentId ?? null };
}

/** The cache entry for this owner, if any — one reader for every clause below. */
function entryOf(conn: ModelsConnection, agentId: string | null | undefined) {
  return conn.modelsByOwner.get(modelsQuery(conn, agentId).ownerKey);
}

export async function ensureAvailableModels(
  conn: ModelsConnection,
  agentId?: string | null,
  mode?: AskMode,
): Promise<RosterInHand | null> {
  const query = modelsQuery(conn, agentId);
  const cached = conn.modelsByOwner.get(query.ownerKey);
  // Nothing at all: wait — the only case where waiting buys the user anything.
  if (cached === undefined) return askModels(conn, query);
  const age = Date.now() - cached.at;
  const nothingInHand = !cached.ok && cached.roster === null;
  // A failure is retried no sooner than its bound, whatever else is true: a dead gateway
  // must not cost an 8 s timeout per turn. `forced` is the policy's deliberate retry —
  // the ask the bound was holding back.
  if (!cached.ok && age < MODELS_FAILURE_TTL_MS && mode !== "forced") return cached.roster;
  if (nothingInHand) return askModels(conn, query);
  const current = cached.epoch === conn.rosterEpoch;
  if (current && cached.ok && age < MODELS_SUCCESS_TTL_MS) return cached.roster;
  // A waiting mode waits for a post-invalidation answer (or a retry past the failure
  // bound); every other caller serves the roster in hand — Convex orders the published
  // rosters by their own observation time.
  if (mode !== undefined && (!current || !cached.ok)) return askModels(conn, query);
  void askModels(conn, query);
  return cached.roster;
}

/** The roster in hand for this owner RIGHT NOW, without asking: the last good answer,
 *  whatever the last ask did — what a publish that must not wait carries. */
export function rosterInHand(conn: ModelsConnection, agentId?: string | null): RosterInHand | null {
  return entryOf(conn, agentId)?.roster ?? null;
}

/** The epoch of the roster in hand for this owner (-1 with none): a config refresh is
 *  done when the roster it published is from an epoch no older than the one its notice
 *  bumped to — a later invalidation (a frame gap) does not reopen it, nor does a failed
 *  ask after it. */
export function rosterEpochOf(conn: ModelsConnection, agentId?: string | null): number {
  return entryOf(conn, agentId)?.rosterEpoch ?? -1;
}

/** The ask, SERIALIZED per owner and connection: at most one `models.list` in flight.
 *  A caller arriving while one is in flight waits for it and, if an invalidation landed
 *  meanwhile (the answer was computed on the old config), asks ONCE more after it —
 *  never a second parallel ask, never a wasted answer. On failure the entry keeps the
 *  LAST GOOD roster (`null` when there never was one), marked `ok:false` in the ask's
 *  epoch (so the failure bound applies). The entry only moves forward in epoch: a LATE
 *  answer from an older epoch never clobbers a newer one, while at an equal epoch the
 *  later data wins (a success replaces a failure). */
function askModels(
  conn: ModelsConnection,
  query: ReturnType<typeof modelsQuery>,
): Promise<RosterInHand | null> {
  let byOwner = modelsInFlight.get(conn);
  if (byOwner === undefined) {
    byOwner = new Map();
    modelsInFlight.set(conn, byOwner);
  }
  const inFlight = byOwner.get(query.ownerKey);
  if (inFlight !== undefined) {
    if (inFlight.epoch === conn.rosterEpoch) return inFlight.promise;
    // Started before an invalidation: wait for it, then ask once in the current epoch
    // (re-entering joins an ask that started meanwhile, or starts the one).
    return inFlight.promise.then(() => askModels(conn, query));
  }
  const { agentId, withOwner, takesOwner, ownerKey } = query;
  const paramsFor = (owned: boolean) => (owned && agentId ? { agentId } : {});
  const epoch = conn.rosterEpoch;
  /** Forward-only filing: written only when nothing NEWER is on record. A success files
   *  its roster in this epoch; a failure keeps the roster on record, at ITS epoch. */
  const file = (roster: RosterInHand | null, ok: boolean): void => {
    const current = conn.modelsByOwner.get(ownerKey);
    if (current === undefined || current.epoch <= epoch) {
      const rosterEpoch = ok ? epoch : (current?.rosterEpoch ?? -1);
      conn.modelsByOwner.set(ownerKey, { roster, rosterEpoch, at: Date.now(), ok, epoch });
    }
  };
  const record = { epoch } as { epoch: number; promise: Promise<RosterInHand | null> };
  record.promise = (async () => {
    try {
      let resp;
      try {
        resp = await conn.request("models.list", paramsFor(withOwner), 8_000);
      } catch (err) {
        // Version unknown and the ownerless form refused: the owner-scoped form gets
        // ONE try — a wrong guess must not cost the model picker.
        if (takesOwner !== null || !agentId) throw err;
        resp = await conn.request("models.list", paramsFor(!withOwner), 8_000);
      }
      const raw = (resp.payload as { models?: unknown } | undefined)?.models;
      // An answer is a roster only when it OFFERS a model. A payload without the array,
      // an empty list (a gateway mid-reload, its catalogue not rebuilt yet) and a list
      // whose every entry the gateway marks unavailable (a provider in cooldown —
      // upstream's own word for a transitory state) are all failures: the last good
      // roster is kept and the ask retried on the failure bound, instead of a success
      // that empties the picker for the success bound. A stale list a person can still
      // pick from beats no list — the empty picker was the symptom this cache exists to
      // remove.
      const list = Array.isArray(raw) ? raw : null;
      if (list === null) throw new Error("models.list answered without a models array");
      const models = dedupeModels(list);
      if (models.length === 0) throw new Error(list.length > 0 ? "every model is unavailable (transient)" : "empty model list (gateway mid-reload?)");
      file({ models, owner: ownerKey, observedAt: Date.now() }, true);
      return conn.modelsByOwner.get(ownerKey)?.roster ?? null;
    } catch (err) {
      console.error(
        `[models.list] skipped (non-fatal, owner=${ownerKey || "<connection>"}):`,
        (err as Error)?.message ?? err,
      );
      const previous = conn.modelsByOwner.get(ownerKey)?.roster ?? null;
      file(previous, false);
      return previous;
    } finally {
      // Identity, not a stamp: two asks in one millisecond are two records.
      if (byOwner.get(ownerKey) === record) byOwner.delete(ownerKey);
    }
  })();
  byOwner.set(ownerKey, record);
  return record.promise;
}

/** One describe: the session row and the fence stamp taken when the answer is IN HAND
 *  a describe of the OLD session in flight when a reset lands must look
 *  older than the fence, or it restores the estimate and budget that were just purged. */
export async function describeSession(
  conn: ModelsConnection,
  sessionKey: string,
): Promise<{ sess: Record<string, unknown>; observedAt: number } | null> {
  const desc = await conn.request("sessions.describe", { key: sessionKey }, 8_000);
  const observedAt = Date.now();
  const sess = (desc.payload as { session?: Record<string, unknown> } | undefined)?.session;
  return sess ? { sess, observedAt } : null;
}

/**
 * The ONE "publish the session meta with its roster" unit, shared by the send path, the
 * knob patch and the config-change refresh. Unconditional: the ordering rules live in
 * Convex's `setSessionMeta` (an omitted roster keeps the one on record for the current
 * owner; the knob fields are ordered by the describe's `observedAt`, the roster by ITS
 * OWN `rosterObservedAt`).
 *
 * With `roster` given (the config refresh, which waited for the post-change answer) it
 * is published with the meta. Without it, the roster in hand goes out with the meta AT
 * ONCE — never held behind a `models.list`: the describe's figures would land a whole
 * ask later than a turn that described after it — and a fresh ask runs off this path,
 * reporting a NEWER answer alone under its own stamp. That is what makes a frame gap
 * reach Convex: the next publish re-asks and reports. With NOTHING in hand the ask is
 * waited for — the only case where waiting buys the user anything (a first turn's
 * picker), the rule `ensureAvailableModels` applies itself.
 */
export async function publishSessionMeta(
  session: { chatId: string; connection: ModelsConnection; agentId: string | null },
  writer: RosterWriter,
  described: { sess: Record<string, unknown>; observedAt: number },
  roster?: RosterInHand | null,
): Promise<void> {
  const conn = session.connection;
  const owner = resolveModelsOwner(described.sess, session.agentId);
  let inHand: RosterInHand | null;
  let reask = false;
  if (roster !== undefined) inHand = roster;
  else {
    inHand = rosterInHand(conn, owner);
    if (inHand === null) inHand = await ensureAvailableModels(conn, owner, "fresh");
    else reask = true;
  }
  await writer.reportSessionMeta(session.chatId, {
    ...parseSessionMeta(described.sess, inHand?.models ?? null),
    availableModelsOwner: modelsQuery(conn, owner).ownerKey,
    ...(inHand !== null ? { rosterObservedAt: inHand.observedAt } : {}),
    observedAt: described.observedAt,
  });
  if (!reask) return;
  void ensureAvailableModels(conn, owner, "fresh")
    .then((fresh) => {
      // Identity, not equality: the ask that found the cache current hands back the very
      // roster already published; only a new answer is worth a second write — and none
      // on a connection the chat re-bound away from meanwhile.
      if (conn.isClosed || fresh === null || fresh === inHand) return undefined;
      return writer.reportSessionRoster(session.chatId, fresh);
    })
    .catch((err: unknown) => {
      console.error(`[roster] chat=${session.chatId} re-ask after publish skipped (non-fatal):`, (err as Error)?.message ?? err);
    });
}

/** A session as the publishers see it: the connection, the key to describe, the chat to
 *  publish to and the routed agent (the owner's fallback). */
export interface PublishedSession {
  connection: ModelsConnection;
  sessionKey: string;
  chatId: string;
  agentId: string;
}

/** Describe the session and publish its meta — the knob patch's mirror: the roster in
 *  hand at once, the re-ask off its path. False when the describe failed. */
export async function publishDescribedSession(session: PublishedSession, writer: RosterWriter): Promise<boolean> {
  try {
    const described = await describeSession(session.connection, session.sessionKey);
    if (described === null) return false;
    await publishSessionMeta(session, writer, described);
    return true;
  } catch (err) {
    console.error(`[roster] chat=${session.chatId} describe-and-publish skipped (non-fatal):`, (err as Error)?.message ?? err);
    return false;
  }
}

/**
 * The refresh after a `config.changed`: the roster a chat shows follows the gateway
 * WITHOUT a turn. Describe the session, ask the roster under the DESCRIBED agent —
 * waiting for the post-change answer, past the failure bound (a gateway reloading right
 * after the edit is the common case) — and publish through `publishSessionMeta`. Wired
 * by the roster policy (`attachRosterPolicy`). Off the critical path of any turn;
 * best-effort. Returns whether a meta was published and the epoch of the roster it
 * carried, so the policy can tell a post-change roster from the last good one served in
 * its place. A connection the chat re-bound away from meanwhile publishes nothing.
 */
export async function refreshAfterConfigChange(
  session: PublishedSession,
  writer: RosterWriter,
  notice: ConfigChangedNotice,
): Promise<{ published: boolean; rosterEpoch: number }> {
  const none = { published: false, rosterEpoch: -1 };
  try {
    const described = await describeSession(session.connection, session.sessionKey);
    if (described === null) return none;
    // The owner is the DESCRIBED agent (with the routed one as fallback) — the same key
    // the send path files the roster under, so one connection holds one entry per agent.
    const owner = resolveModelsOwner(described.sess, session.agentId);
    const roster = await ensureAvailableModels(session.connection, owner, "forced");
    if (session.connection.isClosed) return none;
    await publishSessionMeta(session, writer, described, roster);
    const rosterEpoch = rosterEpochOf(session.connection, owner);
    console.log(`[roster] chat=${session.chatId} refreshed after config.changed hash=${notice.hash ?? "?"}: ${roster?.models.length ?? "no"} model(s), roster epoch ${rosterEpoch}`);
    return { published: true, rosterEpoch };
  } catch (err) {
    console.error(`[roster] chat=${session.chatId} refresh after config.changed skipped (non-fatal):`, (err as Error)?.message ?? err);
    return none;
  }
}

/** Trailing coalescing window on `config.changed` (plus up to as much jitter): config
 *  edits arrive in bursts, and every session socket receives every one. */
export const ROSTER_NOTIFY_DEBOUNCE_MS = 1_000;
/** A refresh that could not publish the post-change roster (the gateway was still
 *  reloading) is retried ONCE after this delay: the gateway sends a revision once, and an
 *  idle chat would otherwise never learn of it. Past the failure bound on purpose — the
 *  retry is the ask the bound was holding back. */
export const ROSTER_REFRESH_RETRY_MS = MODELS_FAILURE_TTL_MS + 5_000;

/**
 * The roster-invalidation POLICY for one session's connection, fed by the transport's raw
 * notice. Every `config.changed` invalidates (a new epoch) — never deduplicated by hash: a
 * roster answered while the gateway was mid-reload is the OLD one under the new hash, and
 * only the re-sent revision fixes it — coalesced over a burst (a jittered window, so N
 * sessions do not wake the gateway in one tick), then a refresh that pushes the roster to
 * Convex, retried once past the failure bound when the roster published was not the
 * post-change one. A frame gap is the transport's own invalidation (a `dropIfSlow`
 * broadcast that was lost consumed a `seq`); the next ask re-asks. Disposes itself on the
 * connection's own close. Ordering is by EPOCH.
 */
export function attachRosterPolicy(
  session: PublishedSession & { connection: PolicyConnection },
  writer: RosterWriter,
  opts: { debounceMs?: number; retryMs?: number } = {},
): { dispose(): void } {
  const conn = session.connection;
  const debounceMs = opts.debounceMs ?? ROSTER_NOTIFY_DEBOUNCE_MS;
  const retryMs = opts.retryMs ?? ROSTER_REFRESH_RETRY_MS;
  /** The revision waiting for its refresh: its notice, the epoch its arrival bumped to
   *  (the roster must be from that epoch or later to count as refreshed), and the retry
   *  budget that belongs to IT. */
  let pending: { notice: ConfigChangedNotice; epoch: number; retriesLeft: number } | null = null;
  /** The epoch of the LATEST revision received: a job for an older one is superseded. */
  let latestEpoch = -1;
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  const clearTimers = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    debounceTimer = null;
    retryTimer = null;
  };
  const run = (): void => {
    const job = pending;
    pending = null;
    if (job === null || disposed || conn.isClosed) return;
    void refreshAfterConfigChange(session, writer, job.notice)
      .then(({ published, rosterEpoch }) => {
        if (disposed || job.epoch < latestEpoch) return; // over, or superseded by a newer revision
        if (published && rosterEpoch >= job.epoch) return; // the post-change roster is on record
        // Not the post-change roster (gateway reloading, ask failed): once more, later.
        if (job.retriesLeft > 0) {
          pending = { ...job, retriesLeft: job.retriesLeft - 1 };
          retryTimer = setTimeout(
            () => {
              retryTimer = null;
              run();
            },
            retryMs + Math.random() * debounceMs, // jittered like the window: N sessions retry apart
          );
          retryTimer.unref?.();
        }
      })
      .catch((err: unknown) => {
        console.error(`[roster] chat=${session.chatId} refresh failed:`, (err as Error)?.message ?? err);
      });
  };
  const offConfigChanged = conn.onConfigChanged((notice) => {
    if (disposed) return;
    // Every notice is a refresh — no acknowledgement by hash: a `models.list` answered
    // while the gateway was still applying the revision is the OLD roster with a fresh
    // epoch, and a hash acknowledged on it would silence the re-send that fixes it. A
    // re-sent revision costs one coalesced refresh, which is cheap. The transport moved
    // the epoch before reporting: the notice's epoch is the current one.
    latestEpoch = conn.rosterEpoch;
    // A new revision supersedes whatever was pending or waiting for its retry, and gets
    // its own budget — the debounce window, not the retry deadline.
    pending = { notice, epoch: conn.rosterEpoch, retriesLeft: 1 };
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(
      () => {
        debounceTimer = null;
        run();
      },
      debounceMs + Math.random() * debounceMs,
    );
    debounceTimer.unref?.();
  });
  // Declared BEFORE the subscription: a connection already closed calls its listener at
  // once (the transport's contract), so `dispose()` runs while this is still being
  // assigned — reading a `const` there would throw out of the Session's constructor.
  let offClosed: (() => void) | null = null;
  const policy = {
    dispose() {
      disposed = true;
      offConfigChanged(); // a frame buffered past close() must not re-arm
      offClosed?.();
      clearTimers();
      pending = null;
    },
  };
  offClosed = conn.onClosed(() => policy.dispose());
  return policy;
}
