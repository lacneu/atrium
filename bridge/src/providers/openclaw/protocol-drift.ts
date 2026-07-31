import { randomBytes } from "node:crypto";

// Protocol DRIFT detector (Inc 2 of docs/design/protocol-contract.md).
//
// Observe-only: classifies inbound chat/agent event frames against the KNOWN
// per-version protocol surface and counts unknown payload fields — the
// early-warning for "the gateway was updated past what this bridge build
// understands" (the NAS updates OpenClaw before the bridge image). NEVER
// rejects or mutates a frame; unknown fields keep flowing exactly as before.
//
// SOC2: only protocol FIELD NAMES are counted/logged (schema vocabulary),
// never values, never conversation content.
//
// The known-field sets below are the vendored schema surface of the bridge's
// maxValidated gateway version. They are NOT hand-trusted: the protocol
// coverage ratchet test asserts a BIJECTION between these sets and the
// per-field entries of protocol/openclaw/coverage/<version>.json — which is itself
// ratcheted against the vendored TypeBox schemas. One chain, no drift:
//   vendored schema <-> coverage/<version>.json <-> these runtime sets.

// 2026.7.1 — the schema set now vendored under protocol/openclaw/ and ratcheted by
// coverage/2026.7.1.json.
//
// CORRECTED 2026-07-26 (W10/G-74): this said the 7.1 bench had observed "EXACTLY ONE
// addition" over 6.11, and therefore that 6.11 plus that field WAS the 7.1 surface.
// Vendoring the published 2026.7.1 schemas falsified it — the diff carries at least
// `ChatAbortedEvent.errorMessage`, `ChatSendParams.expectedSessionRoutingContract` and
// `ChatAbortParams.preserveSideRuns`. A BENCH observes the fields a scenario happens
// to exercise; it cannot enumerate a contract. That is what the vendored schema is
// for, and inferring "the surface" from a bench run is the exact mistake the ratchet
// exists to make impossible.
export const DRIFT_VENDORED_VERSION = "2026.7.1";

/** Chat payload fields PER STATE, not their union.
 *
 *  The union was the whole weakness: `ChatEventSchema` is a DISCRIMINATED union of four
 *  state shapes, and checking a frame against the union means a field that belongs to
 *  another state passes unnoticed. An `aborted` frame carrying `deltaText`, or a `final`
 *  carrying `errorKind`, is a contract deviation the detector reported as zero — and those
 *  are exactly the shapes that break a turn, because the reader branches on `state`.
 *
 *  Asserted against the vendored per-state schemas by `protocol-drift.test.ts`, so this
 *  cannot drift from the contract the way the hand-kept agent list did.
 */
export const KNOWN_CHAT_FIELDS_BY_STATE: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  delta: new Set([
    "agentId",
    "deltaText",
    "message",
    "replace",
    "runId",
    "seq",
    "sessionKey",
    "spawnedBy",
    "state",
    "usage",
  ]),
  final: new Set([
    "agentId",
    "message",
    "runId",
    "seq",
    "sessionKey",
    "spawnedBy",
    "state",
    "stopReason",
    "usage",
  ]),
  aborted: new Set([
    "agentId",
    "errorMessage",
    "message",
    "runId",
    "seq",
    "sessionKey",
    "spawnedBy",
    "state",
    "stopReason",
  ]),
  error: new Set([
    "agentId",
    "errorKind",
    "errorMessage",
    "message",
    "runId",
    "seq",
    "sessionKey",
    "spawnedBy",
    "state",
    "stopReason",
    "usage",
  ]),
};

/** The UNION, kept for one purpose: a frame whose `state` is not one of the four cannot be
 *  judged per state, and counting all its fields as unknown would be noise, not signal.
 *  Such a frame is reported once under `chat.«unknown-state».<digest>` instead — the
 *  digest distinguishes one new state from another without disclosing the wire value. */
export const KNOWN_CHAT_FIELDS: ReadonlySet<string> = new Set(
  Object.values(KNOWN_CHAT_FIELDS_BY_STATE).flatMap((s) => [...s]),
);

/** Every field name an `agent` event can carry, DERIVED from three enumerable sources.
 *
 *  This used to be a list of PRODUCTION OBSERVATIONS, and the comments said so: "prod
 *  badge 3 unknown fields, 2026-07-19", "2026-07-22 endedAt". The loop was: a field
 *  appears in the operator's unknown-field badge, someone reads the badge, someone patches
 *  this list. Fourteen fields upstream demonstrably emits were still missing when the
 *  derivation was written — including `lastTo`, which prod reported TWENTY-FOUR times on
 *  2026-07-19 and which nobody added. A known-set maintained by incident is a known-set
 *  that is always one incident behind.
 *
 *  The three sources, and why each is needed:
 *   1. `session-event-snapshot.json` — the return shape of the gateway's
 *      `buildSessionEventSnapshot`, derived at vendoring time from upstream source. The
 *      gateway FLATTENS this onto agent events, which is why so many session fields turn
 *      up on a frame that declares none of them.
 *   2. `AgentEventSchema`'s own top-level fields — the published contract.
 *   3. The ROUTING ENVELOPE the gateway stamps on every broadcast (`sessionKey`,
 *      `agentId`). Declared here because it is in neither of the above: the schema does
 *      not mention it and it is not part of the session row.
 *
 *  `protocol-drift.test.ts` asserts this set EQUALS that union, so the next field upstream
 *  adds turns the ratchet red at vendoring time instead of appearing in a customer's
 *  badge. The literal stays because this runs on the turn path and must not read a file.
 */
/** Event families Atrium has CLASSIFIED — read, or deliberately not read with a reason.
 *
 *  Kept as a literal here, like `KNOWN_AGENT_FIELDS` and for the same reason: the bridge
 *  runs from `dist/` in a container where `protocol/` is not on disk, so a runtime read of
 *  the coverage manifest would be a file that is present in tests and absent in production.
 *  `events-coverage.test.ts` asserts this set EQUALS the manifest for the vendored version,
 *  so it cannot drift from the classification it mirrors.
 *
 *  This is NOT "events we handle" — most of these are classified `ignored` or `gap`. It is
 *  "families someone has looked at". A gateway announcing something ABSENT from this set is
 *  announcing something the vendored contract never anticipated, which is the one thing
 *  worth waking a human for.
 */
export const CLASSIFIED_EVENTS: ReadonlySet<string> = new Set([
  "agent",
  "chat",
  "connect.challenge",
  "cron",
  "device.pair.requested",
  "device.pair.resolved",
  "exec.approval.requested",
  "exec.approval.resolved",
  "health",
  "heartbeat",
  "node.invoke.request",
  "node.pair.requested",
  "node.pair.resolved",
  "plugin.approval.requested",
  "plugin.approval.resolved",
  "presence",
  "session.message",
  "session.operation",
  "session.tool",
  "sessions.changed",
  "shutdown",
  "talk.event",
  "talk.mode",
  "task",
  "terminal.data",
  "terminal.exit",
  "tick",
  "update.available",
  "voicewake.changed",
  "voicewake.routing.changed",
]);

export const AGENT_ROUTING_ENVELOPE_FIELDS: readonly string[] = [
  // Stamped on every broadcast, in no schema and in no session row.
  "sessionKey",
  "agentId",
];

export const KNOWN_AGENT_FIELDS: ReadonlySet<string> = new Set([
  "abortedLastRun",
  "activeRunIds",
  "agentId",
  "channel",
  "chatType",
  "childSessions",
  "contextTokens",
  "data",
  "deliveryContext",
  "displayName",
  "effectiveResponseUsage",
  "elevatedLevel",
  "endedAt",
  "estimatedCostUsd",
  "fastMode",
  "forkedFromParent",
  "goal",
  "groupChannel",
  "hasActiveRun",
  "inputTokens",
  "isHeartbeat",
  "kind",
  "label",
  "lastAccountId",
  "lastChannel",
  "lastThreadId",
  "lastTo",
  "model",
  "modelProvider",
  "origin",
  "outputTokens",
  "parentSessionKey",
  "reasoningLevel",
  "responseUsage",
  "runId",
  "runtimeMs",
  "sendPolicy",
  "seq",
  "session",
  "sessionId",
  "sessionKey",
  "space",
  "spawnDepth",
  "spawnedBy",
  "spawnedCwd",
  "spawnedWorkspaceDir",
  "startedAt",
  "status",
  "stream",
  "subagentControlScope",
  "subagentRole",
  "subject",
  "systemSent",
  "thinkingLevel",
  "totalTokens",
  "totalTokensFresh",
  "traceLevel",
  "ts",
  "updatedAt",
  "verboseLevel",
]);

/**
 * Coverage summary of the vendored protocol surface — the operator-facing
 * matrix ("what does this bridge support against its validated gateway
 * version"). Like the known-field sets above, these numbers are NOT
 * hand-trusted: the drift test asserts they equal a recount of
 * `protocol/openclaw/coverage/<newest version>.json`, which the coverage ratchet
 * pins against the vendored TypeBox schemas.
 *
 * Vendoring `sessions.ts` + `plugins.ts`, then `cron.ts` + `tasks.ts`, then
 * `config.ts` + `agents-models-skills.ts`, then `channels.ts` (all 2026-07-27) took the
 * examined surface from 94 entries to 596. EVERY RPC family the bridge calls is now
 * under contract; what remains uncovered is uncovered BY CONSTRUCTION, because upstream
 * publishes no params schema for it (`sessions.get`, `usage.status`, three `tts.*`).
 * Each round of classification made gaps VISIBLE rather than merely absent — and each
 * one found a real defect, which is the whole argument for reading a schema field by
 * field instead of trusting a bench.
 *
 * Vendoring 2026.7.1 added three DECLARED gaps (W10): two outbound fields the bridge
 * does not send (`ChatSendParams`/`ChatAbortParams` are `additionalProperties:false`,
 * so the floor gateway would reject them), and `ChatAbortedEvent.errorMessage`, which
 * a first pass wrongly classified as handled — the aborted branch returns before the
 * read that serves `state === "error"`. All three are now visible in the operator
 * matrix instead of being invisible omissions.
 */
export const COVERAGE_SUMMARY = {
  handled: 158,
  ignored: 420,
  gaps: 18,
  /** The declared gaps, by schema path — the actionable part of the matrix. */
  gapList: [
    "ChatAbortedEvent.errorMessage",
    "ChatSendParams.expectedSessionRoutingContract",
    "ChatAbortParams.preserveSideRuns",
    // The whole `session.operation` event: the gateway's own account of a compaction,
    // unreachable from the turn socket by decision (subscribing there cost announce
    // frames — measured 2026-07-26). Its cause IS retrievable on demand through
    // `sessions.compaction.list`; what the event alone gives is the cause AT THE
    // MOMENT it happens, attachable to the turn. `handleSessionOperation` is the
    // ready, unfed reader.
    "SessionOperationEvent.operationId",
    "SessionOperationEvent.operation",
    "SessionOperationEvent.phase",
    "SessionOperationEvent.sessionKey",
    "SessionOperationEvent.agentId",
    "SessionOperationEvent.ts",
    "SessionOperationEvent.completed",
    "SessionOperationEvent.reason",
    // We reset sessions without telling the gateway why. Corrected after review: the
    // field admits only "new" | "reset", so it never identifies the CLIENT — it only
    // separates a reset from a fresh session in the gateway's own accounting.
    "SessionsResetParams.reason",
    // Three the cron/tasks classification surfaced (2026-07-27), all user-facing:
    // a recurring job's COST is on every run entry and the Scheduled tab shows
    // duration and status only; a job that has failed twenty times in a row looks
    // exactly like one that failed once; and a running task publishes a progress line
    // while the activity indicator shows a bare spinner.
    "CronJobState.consecutiveErrors",
    "CronRunLogEntry.usage",
    "TaskSummary.progressSummary",
    // The voice lane (2026-07-27): the result carries an identifier for the consult and
    // the bridge keeps only `runId`. Stated as the verifiable fact after two corrections —
    // there is no param to quote the key back on, and what it identifies inside the
    // gateway is not something this repo establishes.
    "TalkClientToolCallResult.idempotencyKey",
    // The voice credential states when it dies and nothing reads it: the UI discovers
    // expiry from an HTTP 401 on the SDP offer instead of declining to open a session
    // whose secret has already lapsed.
    "TalkClientCreateResult.expiresAt",
    // The session may require extra headers on the SDP offer; the projection drops them
    // and the browser sends Authorization + Content-Type only. A gateway that starts
    // requiring one fails voice at the handshake with a bare sdp_<status>.
    "TalkClientCreateResult.offerHeaders",
    // NOT listed here, deliberately: "no hole detection on the PAYLOAD seq". It is a real
    // shortcoming (the envelope `frame.seq` is checked by frame-seq.ts, the payload one is
    // not, and a payload hole means an agent event lost INSIDE a run) — but this list is a
    // mechanical recount of the manifest's `gap` fields, and `AgentEvent.seq` is `handled`:
    // it IS read, and it decides which dedup rule applies. Inventing a path to make the
    // list look complete would break the one chain this file rests on. The shortcoming is
    // stated in that field's own note, which is where the manifest puts nuance.
  ] as string[],
} as const;

export interface DriftEntry {
  /** `chat.<field>` or `agent.<field>` — schema vocabulary only. */
  shape: string;
  count: number;
}

// Bounds: a pathological gateway must not grow memory or spam logs.
const MAX_TRACKED_SHAPES = 100;
/** …and a RESERVED budget for the sensors' own shapes, so gateway noise cannot exhaust
 *  the room a reader exception needs. */
const MAX_TRACKED_SENSOR_SHAPES = 32;
/** Announcements get their OWN budget, not a share of the sensor one.
 *
 *  Review pass 5: a gateway announcing 32 unknown families at handshake — a newer build,
 *  or a hostile one — filled the sensor budget, and the next READER EXCEPTION was folded
 *  into `overflowCount` instead of being named. That inverts lot 28's whole point. The
 *  two signals now cannot compete for slots: a flood of announcements can exhaust this
 *  budget and nothing else. */
const MAX_TRACKED_ANNOUNCE_SHAPES = 32;

/** Namespace for the detector's OWN failures. Not protocol vocabulary: the guillemets
 *  cannot appear in a field name (they fail the discriminant charset), so a gateway can
 *  never forge a shape that impersonates one. */
const DETECTOR_FAILURE_PREFIX = "«detector-failure».";

/** Namespace for frames the READER could not process at all — the C4 sensor.
 *
 *  Distinct from `«detector-failure».`, which is this module giving up on a frame the
 *  reader handled fine. Same unforgeability: the guillemets fail the field-name charset,
 *  so a gateway cannot mint a field that impersonates either namespace, and the two
 *  prefixes cannot collide with each other. */
const EXCEPTION_PREFIX = "«exception».";
/** A family the LIVE gateway announces that the vendored contract never anticipated. */
const UNANTICIPATED_PREFIX = "«unanticipated-event».";
/** Same idea on a provider that announces CAPABILITIES rather than event names. */
const UNANTICIPATED_CAP_PREFIX = "«unanticipated-capability».";

/** Where the reader threw. A UNION OF LITERALS on purpose: the site is passed by the
 *  call site, never derived from `err.stack` — a stack frame can quote frame content,
 *  and the compiler is what keeps a new call site from inventing a free-form label. */
export type ExceptionSite =
  | "feed"
  | "pre-ack-replay"
  | "subagent-observe"
  | "subagent-anchor"
  /** The HERMES stream reader. Same sensor, second provider: a finding that exists for
   *  one provider only is a finding an operator will misread as "the other one is fine".
   *  Its frames get no protocol classification here — the known-field sets above are
   *  OpenClaw's — so the shape is the provider marker alone until W9's provider axis
   *  gives it a field of its own. */
  | "hermes-stream"
  /** The Hermes WEBSOCKET event handler — the DEFAULT transport, and therefore the one
   *  that matters most. Instrumented after a review found the sensor covering only the
   *  REST path while the file-reading test called that "both providers". */
  | "hermes-ws-event"
  /** The WS transport's own JSON parse. It sits BEFORE the handler above and used to
   *  drop an unparseable frame with a bare `return`, so the instrumented path never saw
   *  it. Earlier than any reader: there is no frame to shape, only the fact of the loss. */
  | "hermes-ws-parse"
  /** Routing the parsed WS frame — the last unguarded step of that reader, where a frame
   *  that parsed to `null` used to throw straight out of the socket callback. */
  | "hermes-ws-route"
  /** The OpenClaw operator socket's own decode — the SHARED connection every chat rides.
   *  A frame that parses to `null` reached `frame.type` and threw straight out of the
   *  socket callback: one unreadable frame could take the bridge down, unreported. */
  | "openclaw-ws-parse"
  /** …and the same decode during the handshake, before any session exists. */
  | "openclaw-handshake-parse"
  /** The Hermes REST/SSE body decode, inside the normalizer. It swallowed a bad body and
   *  continued with `{}` — on a TERMINAL frame that finalized the turn as an empty
   *  success, which is a lost answer wearing a success badge. */
  | "hermes-sse-parse"
  /** `prompt.submit` answered something other than the declared `{status:"streaming"}`.
   *  Not a read failure but the same family: a wire answer this build cannot interpret,
   *  and one the turn's recv deadline keys on. */
  | "hermes-ws-ack";

/** Per-PROCESS random salt for the unknown-state id.
 *
 *  Without it the id was a plain 32-bit FNV-1a of the value: one-way in form only, since
 *  anyone holding the reported shape could confirm a guess by hashing it — `AliceMartin`,
 *  an e-mail address, any candidate from a dictionary (raised in review). A salt nobody
 *  outside this process holds makes the id underivable, at the cost of one property that
 *  was not worth much: the same unknown state on two bridges now reads as two findings
 *  rather than one. Over-reporting a new state is the safe direction.
 *
 *  NEVER logged, never reported, never persisted. */
const UNKNOWN_STATE_SALT = randomBytes(16).toString("hex");

/** FNV-1a, 32 bits, hex, over the SALTED value — for wire values that must be
 *  DISTINGUISHED without being disclosed or guessed. */
function shortDigest(s: string): string {
  let h = 0x811c9dc5;
  const salted = `${UNKNOWN_STATE_SALT}\u0000${s}`;
  for (let i = 0; i < salted.length; i++) {
    h ^= salted.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The PROTOCOL-LEVEL shape of a frame: which known surface judges it, and under which
 *  label it is reported. `known === undefined` means the frame cannot be judged field by
 *  field — the label is then the whole finding.
 *
 *  Shared by the unknown-field detector and the exception sensor SO THEY CANNOT DISAGREE:
 *  two copies of "how do we name this frame" would eventually name the same frame two
 *  ways, and an operator comparing the two reports would be reading a difference that
 *  does not exist. */
function classifyProtocolShape(
  f: Record<string, unknown>,
  p: Record<string, unknown>,
): { known: ReadonlySet<string> | undefined; prefix: string } {
  if (f.event === "chat") {
    const state = typeof p.state === "string" ? p.state : "";
    // `Object.hasOwn`, not a bare index: `state: "toString"` returned a FUNCTION from
    // the prototype, `known.has` threw, and the observe-only catch swallowed it — so a
    // frame with a prototype-named state produced no drift at all. A detector that can
    // be silenced by the value it is inspecting is worse than none.
    const perState = Object.hasOwn(KNOWN_CHAT_FIELDS_BY_STATE, state)
      ? KNOWN_CHAT_FIELDS_BY_STATE[state]
      : undefined;
    if (perState === undefined) {
      // DISTINGUISHED, not named. An unrecognised state has to be distinguishable — a
      // single bucket hides whether one new state appeared or five — but it is an
      // UNVALIDATED wire value, and this shape is stored and displayed. A charset
      // filter was the first attempt and it proves nothing: `AliceMartin` passes it.
      // A one-way digest keeps every property an operator needs (stable across frames,
      // comparable across bridges, one id per distinct state) and carries no value, so
      // the non-leak is structural rather than a promise about what a gateway sends.
      // The name itself is recoverable where it belongs — the vendored schema diff of
      // the version that introduced it.
      return { known: undefined, prefix: `chat.«unknown-state».${shortDigest(state)}` };
    }
    return { known: perState, prefix: `chat.${state}` };
  }
  return { known: KNOWN_AGENT_FIELDS, prefix: "agent" };
}

/** Decode ONE inbound wire frame, or report why it could not be read (W9/C4).
 *
 *  The single decoder for every transport, and it exists because the same defect was
 *  found twice in one review: `JSON.parse("null")` SUCCEEDS, and a cast to
 *  `Record<string, unknown>` validates nothing at runtime — so the null flowed on to the
 *  first property access and threw a TypeError straight out of a socket `message`
 *  callback. Unreported, and on OpenClaw's SHARED operator connection one such frame
 *  could take the bridge and every conversation on it down.
 *
 *  Every caller must go through this rather than parse for itself: a per-transport copy is
 *  how the second provider was fixed while the first stayed broken.
 *
 *  Returns null for every unreadable shape, having reported it first. Only the error class
 *  and the site travel — the raw text never leaves this function. */
export function decodeInboundFrame(
  raw: unknown,
  site: ExceptionSite,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    protocolDrift.observeException(null, err, site);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // A frame that parses to a non-object is unreadable in exactly the same way as one
    // that does not parse at all — and far more dangerous, because it looks like success.
    protocolDrift.observeException(
      null,
      new TypeError("wire frame is not a JSON object"),
      site,
    );
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** The frame's shape as the EXCEPTION sensor names it.
 *
 *  Wider input than `observe()`: the reader throws on whatever arrived, so this must name
 *  an RPC response, a malformed envelope or a null just as safely as a chat event. Every
 *  branch emits either a fixed marker or the shared classifier's label — never a wire
 *  value, and never a key read off the frame.
 *
 *  An event type outside {chat, agent} is DIGESTED, not named: `event` is a wire string
 *  like `state` was, and lot 23 settled that question — a charset filter is procedural
 *  (`AliceMartin` passes it) while a salted digest keeps the one property an operator
 *  needs, telling one unknown event apart from another. Naming them properly is the C1
 *  sensor's job, once there is a known-event manifest to name them against. */
function exceptionFrameShape(frame: unknown, site: ExceptionSite): string {
  // The known surfaces this module holds are OpenClaw's; a Hermes frame judged against
  // them would report "unknown" about a contract it never claimed to follow.
  if (site.startsWith("hermes-")) return "«hermes»";
  if (typeof frame !== "object" || frame === null) return "«non-object»";
  const f = frame as Record<string, unknown>;
  if (f.type !== "event") return "«non-event»";
  if (f.event !== "chat" && f.event !== "agent") {
    const ev = typeof f.event === "string" ? f.event : "";
    return `«other-event».${shortDigest(ev)}`;
  }
  const payload = f.payload;
  if (typeof payload !== "object" || payload === null) {
    return `${f.event}.«no-payload»`;
  }
  return classifyProtocolShape(f, payload as Record<string, unknown>).prefix;
}

/** SENSOR shapes — this module's own findings (`«exception».`, `«detector-failure».`) as
 *  opposed to gateway vocabulary. They get their OWN budget below. */
function isSensorShape(shape: string): boolean {
  return (
    shape.startsWith(EXCEPTION_PREFIX) ||
    shape.startsWith(DETECTOR_FAILURE_PREFIX) ||
    // An unanticipated announcement is a count of ONE on the day it matters, exactly like
    // a reader exception: it belongs in the reserved budget, not in the field counters a
    // flood of unknown fields can push off the end of the bounded report.
    shape.startsWith(UNANTICIPATED_PREFIX) ||
    shape.startsWith(UNANTICIPATED_CAP_PREFIX)
  );
}

class ProtocolDriftRegistry {
  private counters = new Map<string, number>();
  /** SEPARATE budget for sensor shapes, and the reason is the failure mode itself: the
   *  two share nothing but a cap, and a burst of unknown FIELDS — the common case when a
   *  gateway jumps a version — would fill the registry first. The next unreadable frame
   *  then became an untyped overflow tick: no class, no site, no shape, nothing to tie to
   *  the conversation that broke (raised in review). A reader exception is the scarcer and
   *  more serious finding of the two; it cannot be starved by the noisier one.
   *
   *  The sensor budget is small on purpose: its vocabulary is error classes × sites ×
   *  frame shapes, so it is bounded in practice long before this cap. */
  private sensorCounters = new Map<string, number>();
  /** Announced-but-unclassified EVENT families (OpenClaw). Kept apart so they cannot
   *  starve the sensor budget above. */
  private announceCounters = new Map<string, number>();
  /** Announced-but-unclassified CAPABILITIES (Hermes). A separate budget again: the
   *  bridge serves several gateways, and one Hermes instance announcing 32 unknown
   *  capabilities used to push another instance's new OpenClaw event into the anonymous
   *  overflow. Prefixes stop key collisions, not competition for capacity (pass 8). */
  private announceCapCounters = new Map<string, number>();
  /** Errors already reported, by IDENTITY. A `WeakSet` so a long-lived registry never
   *  holds an error alive; primitives thrown (`throw "x"`) cannot be tracked and are the
   *  one case that could still double-count — vanishingly rare, and over-reporting a
   *  reader failure is the safe direction. */
  private observedErrors = new WeakSet<object>();
  private overflowed = false;
  private overflowCounter = 0;

  /** Observe one raw inbound frame (chat/agent events only; anything else is
   *  outside the vendored surface and deliberately not judged). Never throws. */
  observe(frame: unknown): void {
    try {
      if (typeof frame !== "object" || frame === null) return;
      const f = frame as Record<string, unknown>;
      if (f.type !== "event") return;
      if (f.event !== "chat" && f.event !== "agent") return;
      const payload = f.payload;
      if (typeof payload !== "object" || payload === null) return;
      const p = payload as Record<string, unknown>;
      // PER STATE for chat (the union hid cross-state fields, see above). An
      // unrecognised state cannot be judged field by field, so it is reported ONCE as
      // itself rather than as a wall of unknown fields.
      const cls = classifyProtocolShape(f, p);
      if (cls.known === undefined) {
        this.bump(cls.prefix);
        return;
      }
      const known = cls.known;
      const prefix = cls.prefix;
      for (const key of Object.keys(p)) {
        if (known.has(key)) continue;
        this.bump(`${prefix}.${key}`);
      }
    } catch (err) {
      // Observe-only: a malformed frame must never break the feed path — but a detector
      // that fails SILENTLY is the blindness it exists to remove, exactly like the
      // prototype-named state above. The failure is counted as a shape of its own, so it
      // travels the pipeline that is already bounded, reported and rendered; nothing new
      // has to be plumbed for an operator to see that the detector itself gave up.
      // The error CLASS only — never `err.message`, which can quote frame content (SOC2).
      try {
        const cls = err instanceof Error ? err.constructor.name : typeof err;
        const safe = /^[a-zA-Z][a-zA-Z0-9._-]{0,47}$/.test(cls) ? cls : "«unprintable»";
        this.bump(`${DETECTOR_FAILURE_PREFIX}${safe}`);
      } catch {
        // Truly nothing left to do: the detector must not be able to break the feed.
      }
    }
  }

  /** C4 — the READER threw on a frame (the priority sensor of W9).
   *
   *  A frame that makes `feed()` throw is a frame this build could not read AT ALL, which
   *  is strictly worse than an unknown field: with an unknown field the turn still runs.
   *  Until now it was a `console.error` in the container's stdout and nothing else — not
   *  in any report, not in the product, invisible to the operator whose conversation it
   *  broke. It rides the counters that lot 23 already bounded, carried and rendered, so
   *  the finding reaches the same place the field drift does.
   *
   *  WHAT IS REPORTED, and nothing else: the error CLASS (`constructor.name`, charset
   *  guarded), the call SITE (a compile-time literal — never `err.stack`, which quotes
   *  frame content), and the frame's PROTOCOL-LEVEL shape through the same classifier the
   *  field detector uses. Never `err.message`.
   *
   *  Scope of that promise, stated because the test asserts exactly it: the REPORTED
   *  surface — `report()`, and therefore Convex and the UI — carries no frame content.
   *  The pre-existing `console.error` at each call site still prints `err.message` to
   *  bridge stdout, unchanged by this lot and consistent with the rest of the bridge;
   *  that log is operator-local and is not what SOC2 governs here.
   *
   *  Never throws: a sensor that can break the feed path would be a worse bug than the
   *  one it reports. */
  observeException(frame: unknown, err: unknown, site: ExceptionSite): void {
    try {
      // ONE failure, ONE finding. `feedInner` re-enters the public `feed()` to replay a
      // stashed announce, so a throw on the inner frame is reported there and then
      // rethrown into the OUTER guard, which would report it a second time — against the
      // wrong frame (raised in review). Identity, not shape: the rethrown object is the
      // same one, whatever the nesting depth or the path it took.
      if (typeof err === "object" && err !== null) {
        if (this.observedErrors.has(err)) return;
        this.observedErrors.add(err);
      }
      const cls = err instanceof Error ? err.constructor.name : typeof err;
      // Same guard the detector-failure path uses: a class name is normally an
      // identifier, but `constructor.name` is attacker-influenceable in principle
      // (a thrown object from a dynamically named class), and this string is stored.
      const safeClass = /^[a-zA-Z][a-zA-Z0-9._-]{0,47}$/.test(cls) ? cls : "«unprintable»";
      this.bump(`${EXCEPTION_PREFIX}${safeClass}@${site}.${exceptionFrameShape(frame, site)}`);
    } catch {
      // The sensor itself failed. Count it as a detector failure rather than losing it,
      // and never rethrow into the caller's catch block.
      try {
        this.bump(`${DETECTOR_FAILURE_PREFIX}ExceptionSensor`);
      } catch {
        /* nothing left to do */
      }
    }
  }

  /** Read the catalogue the gateway announces about ITSELF (`hello-ok.features.events`).
   *
   *  G-70: upstream publishes the list of families it emits, and Atrium used to drop it,
   *  so an unhandled family was always discovered by a user hitting it first. Every
   *  announced name is compared against `CLASSIFIED_EVENTS`; only what is absent from the
   *  classification ENTIRELY is counted — "a live gateway announces something the vendored
   *  contract never anticipated". Announced-but-`ignored` and announced-but-`gap` are
   *  already accounted for in the coverage manifest and must NOT flood the ledger, or the
   *  exit indicator ("shapes in `status:new` ⇒ 0") would be red for 25 known entries and
   *  get weakened within the week.
   *
   *  Total-catch, like every other sensor here: this runs on the handshake path, and a
   *  diagnostic that can break `connect` is worse than the blindness it cures.
   */
  observeAnnouncedEvents(announced: unknown): void {
    try {
      if (!Array.isArray(announced)) return;
      for (const name of announced) {
        if (typeof name !== "string" || name === "") continue;
        if (CLASSIFIED_EVENTS.has(name)) continue;
        // Same containment as the exception sensor: this string is stored and travels to
        // Convex, and it came off the wire.
        const safe = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(name) ? name : "«unprintable»";
        this.bump(`${UNANTICIPATED_PREFIX}${safe}`);
      }
    } catch {
      try {
        this.bump(`${DETECTOR_FAILURE_PREFIX}AnnouncedEventSensor`);
      } catch {
        /* nothing left to do */
      }
    }
  }

  /** The capability half of the same rule, for a provider that publishes NAMES OF
   *  CAPABILITIES instead of event families (Hermes, `GET /v1/capabilities`).
   *
   *  The classified set is passed IN rather than imported: this module is OpenClaw's, and
   *  the Hermes vocabulary has no business in it. Same containment, same total-catch, same
   *  reserved budget.
   */
  observeAnnouncedCapabilities(
    declared: unknown,
    classified: ReadonlySet<string>,
  ): void {
    try {
      if (typeof declared !== "object" || declared === null) return;
      for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
        // `false` is "not offered": nothing to classify and nothing to report.
        if (value === false) continue;
        if (classified.has(name)) continue;
        const safe = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(name) ? name : "«unprintable»";
        this.bump(`${UNANTICIPATED_CAP_PREFIX}${safe}`);
      }
    } catch {
      try {
        this.bump(`${DETECTOR_FAILURE_PREFIX}AnnouncedCapabilitySensor`);
      } catch {
        /* nothing left to do */
      }
    }
  }

  /** Count one shape, or count the OVERFLOW when the cap is reached.
   *
   *  `overflowCount` exists because the cap used to be a `console.error` in the container's
   *  stdout and nothing else: the report said "here is the drift" while silently omitting
   *  everything past 512 shapes. A bound is legitimate; a bound nobody downstream can see
   *  is the same silence the bound was supposed to replace. */
  private bump(shape: string): void {
    const announceEvent = shape.startsWith(UNANTICIPATED_PREFIX);
    const announceCap = shape.startsWith(UNANTICIPATED_CAP_PREFIX);
    const sensor = !announceEvent && !announceCap && isSensorShape(shape);
    const map = announceEvent
      ? this.announceCounters
      : announceCap
        ? this.announceCapCounters
        : sensor
          ? this.sensorCounters
          : this.counters;
    const cap =
      announceEvent || announceCap
        ? MAX_TRACKED_ANNOUNCE_SHAPES
        : sensor
          ? MAX_TRACKED_SENSOR_SHAPES
          : MAX_TRACKED_SHAPES;
    const current = map.get(shape);
    if (current !== undefined) {
      map.set(shape, current + 1);
      return;
    }
    if (map.size >= cap) {
      this.overflowCounter += 1;
      if (!this.overflowed) {
        this.overflowed = true;
        console.error(
          "[protocol-drift] tracked-shape cap reached — further NEW shapes counted in overflowCount, not named",
        );
      }
      return;
    }
    // One log per NEW shape (field name only — never a value). A detector failure rides
    // the same counters but is NOT an unknown field: logging it under the drift wording
    // would send an operator looking for a gateway change that never happened.
    // FOUR findings ride these counters and they are not the same news. Logging an
    // exception — or a detector failure — under the drift wording sends an operator
    // looking for a gateway change that never happened; lot 23 fixed that for the
    // detector's own failures and the exception sensor inherited the wrong branch.
    // The announced-catalogue sensor (G-70) is the fourth, and it is the ONLY one that
    // says something about a frame nobody has received: the gateway declared a family
    // at handshake time. Calling that an "unknown protocol field" would send an operator
    // hunting through traffic for something that has not arrived yet.
    console.log(
      shape.startsWith(DETECTOR_FAILURE_PREFIX)
        ? `[protocol-drift] detector failed on a frame: ${shape} (error class only — the frame is unreadable to this build)`
        : shape.startsWith(EXCEPTION_PREFIX)
          ? `[protocol-drift] the READER threw on a frame: ${shape} (error class + site only — this build could not process the frame at all)`
          : shape.startsWith(UNANTICIPATED_PREFIX) ||
              shape.startsWith(UNANTICIPATED_CAP_PREFIX)
            ? `[protocol-drift] the gateway ANNOUNCES something this build never classified: ${shape} (declared by the gateway — no frame of it has been seen)`
            : `[protocol-drift] unknown protocol field: ${shape} (gateway newer than vendored ${DRIFT_VENDORED_VERSION}?)`,
    );
    map.set(shape, 1);
  }

  /** How many observations fell past the tracked-shape cap. Reported, not just logged. */
  overflowCount(): number {
    return this.overflowCounter;
  }

  /** Current drift, largest counts first (bounded by MAX_TRACKED_SHAPES). */
  report(): DriftEntry[] {
    // SENSOR SHAPES FIRST, and this is not cosmetic. The reserved budget above only holds
    // as far as this list travels: the Convex boundary keeps a bounded PREFIX of it, so a
    // registry saturated with unknown fields pushed the exception off the end and turned
    // it back into an anonymous `driftTruncated` tick — the reservation undone one hop
    // downstream (raised in review). Ordering by count alone was never enough: a reader
    // exception is a count of 1 on the day it matters most.
    const byCount = (a: DriftEntry, b: DriftEntry): number => b.count - a.count;
    return [
      ...[...this.sensorCounters.entries()].map(([shape, count]) => ({ shape, count })).sort(byCount),
      // Announcements sit BETWEEN the two: ahead of field drift (a count of one on the
      // day it matters), behind reader exceptions (which outrank everything here).
      ...[...this.announceCounters.entries()].map(([shape, count]) => ({ shape, count })).sort(byCount),
      ...[...this.announceCapCounters.entries()].map(([shape, count]) => ({ shape, count })).sort(byCount),
      ...[...this.counters.entries()].map(([shape, count]) => ({ shape, count })).sort(byCount),
    ];
  }

  /** Test seam. */
  resetForTests(): void {
    this.counters.clear();
    this.sensorCounters.clear();
    this.announceCounters.clear();
    this.announceCapCounters.clear();
    this.overflowed = false;
    this.overflowCounter = 0;
  }
}

/** Process-wide singleton: drift is a per-build observation, not per-session. */
export const protocolDrift = new ProtocolDriftRegistry();
