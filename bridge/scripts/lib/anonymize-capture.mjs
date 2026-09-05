// Anonymizer for promoted gateway captures (W11/G4).
//
// A golden capture is a REAL gateway conversation. It lands in an open-source repo, so
// nothing that came off the wire as content may survive — while everything the normalizer
// BRANCHES on must survive exactly, or the corpus proves nothing.
//
// The rule is an ALLOWLIST, for the reason a charset filter failed review in the drift
// detector: a denylist is a promise about what the gateway sends, and the gateway is not
// ours. Every string is masked unless its key is explicitly classified. Three classes:
//
//   VOCABULARY   kept verbatim. Protocol discriminants the reader branches on
//                (`state`, `stream`, `phase`, `kind`, `stopReason`, …) and tool NAMES,
//                which are gateway registry entries, not user text — the same argument
//                that makes field names safe to report in the drift badge.
//   IDENTIFIERS  pseudonymised, STRUCTURE-PRESERVING. A session key, a run id and a tool
//                call id are parsed by the bridge (`session-keys.ts`, `run-families.ts`),
//                so their separators and their protocol tokens are kept and only the
//                opaque tokens are renamed — consistently, so `spawnedBy === sessionKey`,
//                the announce/task/inject families and parent↔child links all still hold.
//   TEXT         masked per character: letters → `x`, digits → `0`, everything else kept.
//                Per character is not a detail: it makes the mask a homomorphism, so
//                `mask(a + b) === mask(a) + mask(b)` and every prefix/concatenation
//                relationship the delta→snapshot→final path depends on survives intact.
//
// Scalars are classified too, and CONTEXT decides. In a protocol field a number or a
// boolean is a count, a timestamp or a flag; inside a FREE-FORM blob — a tool's args, its
// result, its output — it is whatever the payload put there. `result: {hasCancer: true,
// id: 12345}` was published intact, because `id` happens to be a protocol key SOMEWHERE
// (raised in review). Inside a free-form region only the handful of keys the reading
// stack actually consumes keeps its value; every other scalar keeps its TYPE and loses
// its value.

/** Keys whose STRING value is protocol vocabulary and is kept verbatim. */
const VOCABULARY_KEYS = new Set([
  "type",
  "event",
  "state",
  "stream",
  "phase",
  "kind",
  "status",
  "stopReason",
  "errorKind",
  "role",
  "operation",
  "provider",
  "channel",
  "chatType",
  "mime",
  "mimeType",
  "contentType",
  "model",
  "modelProvider",
  "origin",
  "sendPolicy",
  "reasoningLevel",
  "thinkingLevel",
  "verboseLevel",
  "traceLevel",
  "elevatedLevel",
  "subagentRole",
  "subagentControlScope",
]);

/** Keys whose STRING value is an identifier: pseudonymised, structure preserved. */
const IDENTIFIER_KEYS = new Set([
  "runId",
  "sessionKey",
  "spawnedBy",
  "parentSessionKey",
  "childSessionKey",
  "sessionId",
  "agentId",
  "instanceName",
  "canonical",
  "key",
  "id",
  "taskId",
  "toolCallId",
  "messageId",
  "chatId",
  "callId",
  "lastAccountId",
  "lastThreadId",
  "lastTo",
  "lastChannel",
  "groupChannel",
  "space",
  "path",
  "filePath",
  "url",
  "uri",
  "source",
  "cwd",
  "spawnedCwd",
  "spawnedWorkspaceDir",
  "workspaceDir",
  // Media DELIVERY: `collectMedia` reads these, so a corpus that masks them cannot
  // exercise the outbound pipeline at all — the media scenario replayed to a plain turn
  // with no `addMedia` (raised in review).
  "mediaUrls",
  "mediaPaths",
  // Listed so the KEY survives; its VALUE is handled earlier, by the same conditional
  // tool rename as `data.name` (a built-in stays readable, a custom one is aliased).
  "toolName",
]);

/** The gateway's MEDIA ROOTS. Fixed infrastructure, identical on every deployment, and
 *  the prefix a delivery path is recognised by. Matched as a WHOLE PREFIX, never as loose
 *  tokens: `home` and `node` as free tokens were kept anywhere they appeared, including
 *  inside a real identifier. Only the FILE NAME is identity, and it is pseudonymised. */
const MEDIA_ROOTS = [
  "/home/node/.openclaw/media/outbound/",
  "/home/node/.openclaw/media/inbound/",
];

/** Control VALUES the reading stack compares against, by key. Inside a free-form blob a
 *  protocol-named key is not enough — `result: {status: "Alice's diagnosis"}` was
 *  published verbatim because `status` is vocabulary somewhere (raised in review). Only
 *  these exact values survive; anything else under the same key is masked.
 *
 *  They are not decoration: `messageToolText` branches on `action` and on the channel to
 *  decide whether a message-tool call IS the visible reply, and a plan step's `status` is
 *  what the plan card renders. Masking them made the replay classify an in-chat send as
 *  an external one and never exercise the visible-message path. */
/** Identifiers that appear INSIDE a free-form blob and must stay correlatable. Masking
 *  `details.taskId` broke the join with the `<tool>:<taskId>:ok` delivery run, so the
 *  engagement opened and could never settle — the corpus covered half the async path
 *  while claiming the whole of it. Pseudonymised, like any identifier: no value survives,
 *  and the two ends still meet. */
const FREE_FORM_IDENTIFIER_KEYS = new Set([
  // A media list INSIDE a tool result: masked, it stopped matching the outbound prefix
  // `isOutboundMediaPath` requires, so that delivery form replayed with no media at all
  // (raised in review). Pseudonymised like any path — the root survives, the file name
  // does not.
  "mediaUrls",
  "mediaPaths",
  "taskId",
  "toolCallId",
  "runId",
  "sessionKey",
  "childSessionKey",
]);

/** The only BOOLEANS a free-form blob may keep: the two flags the reading stack tests.
 *  `details.async` is the whole background-task ack and `isError` decides whether a tool
 *  result is a failure; every other boolean in there is data. */
const FREE_FORM_BOOLEAN_KEYS = new Set(["async", "isError", "enabled"]);

const FREE_FORM_VALUE_ALLOW = new Map([
  // `send`/`thread-reply` are read by `messageToolText`; `add`/`update`/`remove` are the
  // cron mutations `cronPartFromTool` keys on (`core/cron-part.ts` MUTATING_ACTIONS).
  // Sources of truth are those two readers — and when an entry is missing here the golden
  // corpus says so by turning a snapshot red, which is exactly how `add` was found.
  [
    "action",
    new Set(["send", "thread-reply", "reply", "post", "add", "update", "remove"]),
  ],
  // MIRROR of the normalizer's `CURRENT_CHAT_CHANNELS`. A value it recognises as "this
  // chat" and the anonymiser masks turns a visible reply into an external send, and the
  // fidelity gate then refuses a perfectly good capture (raised in review).
  [
    "channel",
    new Set(["chat", "current", "atrium", "webchat", "owui", "openwebui", "direct"]),
  ],
  [
    "provider",
    new Set(["chat", "current", "atrium", "webchat", "owui", "openwebui", "direct"]),
  ],
  ["status", new Set(["pending", "in_progress", "completed", "started", "done", "error"])],
  ["phase", new Set(["start", "result", "update", "chunk", "completed", "delta"])],
  ["kind", new Set(["plan", "tool", "task", "command", "media", "file", "text"])],
  ["type", new Set(["text", "image", "file", "media", "event", "res", "req"])],
]);

/** The gateway's outbound-media ROOT, read verbatim by the normalizer
 *  (`^MEDIA:/home/node/.openclaw/media/outbound/…`). Masking the line killed the
 *  tool-result media path outright, so the prefix is preserved and only the FILE NAME is
 *  masked. Applied inside free-form regions ONLY: assistant deltas and snapshots must
 *  stay a pure character mask, or the prefix relation the replace path depends on breaks
 *  between a partially-streamed sentinel and its final form. */
const MEDIA_SENTINEL =
  /((?:MEDIA:)?\/home\/node\/\.openclaw\/media\/outbound\/)([^\s"]+)/g;

/** Containers whose CONTENTS are free-form as far as the protocol is concerned. The
 *  manifest's 226 schemas describe protocol fields; none of them licenses a key that
 *  merely appears inside a tool's payload. */
const FREE_FORM_KEYS = new Set([
  "args",
  "result",
  "output",
  "input",
  "meta",
  "details",
  // A tool-result envelope like any other. It was classified as a KEY the reader knows
  // but not as a free-form CONTAINER, so its arbitrary JSON was walked with the full
  // manifest vocabulary and sub-keys such as `status`, `model` or `provider` kept their
  // text verbatim (raised in review).
  "structuredContent",
]);

/** Structural keys: the containers the frame is built from. Not fields anyone could
 *  mistake for content, and the shape is meaningless without them. */
const STRUCTURAL_KEYS = new Set([
  "payload",
  "frame",
  "data",
  "message",
  "content",
  "args",
  "result",
  "output",
  "input",
  "meta",
  "text",
  "parts",
  "items",
  "steps",
  "plan",
  "step",
  "session",
  "usage",
  "receivedAt",
]);

/** Keys of a tool RESULT that the reading stack branches on. No schema declares them —
 *  a tool result is free-form as far as the protocol is concerned — but the code reads
 *  them, so a corpus that masks them cannot exercise the paths they open.
 *
 *  Found the hard way: `details.async` / `details.taskId` is the entire background-task
 *  ack (`core/async-task.ts`), and with `details` masked the promoted `async-task`
 *  scenario replayed to a plain tool call — the corpus looked healthy and covered nothing
 *  of what it was captured for. */
const TOOL_RESULT_KEYS = new Set([
  "details",
  "async",
  "structuredContent",
  "isError",
  "task",
]);

/** Tool-argument keys the normalizer itself branches on (`messageToolText`). They are
 *  read, so they are vocabulary — masking them would make the message-tool path
 *  unreachable in a replay. */
const NORMALIZER_ARG_KEYS = new Set([
  "action",
  "channel",
  "provider",
  "command",
  "reply",
  "thread",
  "threadId",
  // MIRROR of `EXTERNAL_TARGET_KEYS`: their PRESENCE is what excludes a send from being
  // the visible reply. Dropping one (`targets`, `chatId`) made the promoted capture look
  // like an in-chat answer whose body had been masked (raised in review).
  "target",
  "targets",
  "to",
  "accountId",
  "chatId",
  // MIRROR of `VISIBLE_TEXT_KEYS`: where the reply text is looked for.
  "message",
  "caption",
  "text",
  "body",
  "content",
  "markdown",
]);

/** Tokens inside an identifier that are PROTOCOL, not identity — kept verbatim so the
 *  families and the key grammar stay recognisable to the code under test. */
const IDENTIFIER_LITERALS = new Set([
  "agent",
  "atrium",
  "webchat",
  "chat",
  "subagent",
  "task",
  "announce",
  "inject",
  "tool",
  "talk",
  "turn",
  "ok",
  "error",
  "main",
]);

/** A UUID, as the bridge's own graders spell it. Pseudonymising one token-by-token turned
 *  `1c983f76-2eec-…` into `id32-id33-…`, which stops matching `taskDeliveryRunFromRunId`'s
 *  strict `8-4-4-4-12` grammar — so every background-task DELIVERY run was silently
 *  unrecognised and the corpus proved only that the engagement opened, never that it
 *  settled (raised in review). A UUID is replaced by a UUID. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A UUID-shaped pseudonym, minted SEQUENTIALLY within a capture.
 *
 *  Deriving it from the original was the first version, and it is a presence oracle: a
 *  third party holding a candidate id computes its pseudonym and searches the corpus for
 *  it (raised in review — the same reasoning that put a salt on the drift detector's
 *  unknown-state digest). A counter cannot be computed from anything, and the corpus only
 *  needs the pseudonym to be STABLE within itself.
 *
 *  The reserved leading groups also say plainly that the value is synthetic, and the
 *  `8-4-4-4-12` grammar the readers key on is untouched. */
function mintUuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Separators an identifier may be built from. Kept in place.
 *
 *  `_` is deliberately NOT one: it is part of names, not between them, and splitting on
 *  it tore `image_generate` into two opaque tokens — which broke the `<tool>:<taskId>:ok`
 *  delivery family the run-family reader depends on. */
const ID_SPLIT = /([:/\-.@|])/;

/** A JSON object/array encoded as a string, or null. Deliberately narrow: a bare number
 *  or a quoted word also parses as JSON, and treating those as structure would strip
 *  content out of the mask. */
function parseJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const value = JSON.parse(trimmed);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** Length- and class-preserving mask. A homomorphism over concatenation, which is what
 *  keeps the prefix-sensitive snapshot/replace path meaningful after promotion. */
export function maskText(s) {
  let out = "";
  // By UTF-16 CODE UNIT, not by code point. Iterating code points emitted one mask
  // character for an astral char that occupies two units, so the result was SHORTER than
  // the input — which breaks the length guarantee the media splice relies on and would
  // corrupt a preserved prefix that follows an emoji (raised in review).
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch >= "a" && ch <= "z") out += "x";
    else if (ch >= "A" && ch <= "Z") out += "X";
    else if (ch >= "0" && ch <= "9") out += "0";
    else if (/[\s]/.test(ch)) out += ch;
    else if (/[.,;:!?'"()[\]{}<>/\\@#&*+=%$_|~^`-]/.test(ch)) out += ch;
    // Anything else (emoji, accented letters, CJK…) is a letter as far as we care:
    // it must not survive, and it must still occupy one position.
    else out += "x";
  }
  return out;
}

/** Protocol-shaped tokens that appear INSIDE free text and that the reading stack scans
 *  for. They are not decoration: the sink finds spawned children by matching session keys
 *  in a tool result's JSON, and the normalizer finds deliveries by matching the outbound
 *  media root. Masking the text destroyed both — the announce `awaiting_subagents` phase
 *  and the media path — while the fixture looked perfectly healthy.
 *
 *  A media root is kept VERBATIM (it is infrastructure, identical everywhere); a session
 *  key is kept PSEUDONYMISED (it is identity, and the pseudonym is the same one the
 *  structured fields get, so the two still join). */
const EMBEDDED_MEDIA_ROOT = /(?:MEDIA:)?\/home\/node\/\.openclaw\/media\/outbound\/[^\s"]+/g;
const EMBEDDED_SESSION_KEY = /agent:[A-Za-z0-9_.-]+(?::subagent:[A-Za-z0-9-]+)+/g;

/** Mask free text, preserving the protocol-shaped tokens the reading stack scans for.
 *
 *  Everything OUTSIDE a match is masked; a match is substituted. Written this way — not
 *  as "replace the token and keep the rest" — because the first version returned the whole
 *  string whenever it contained a directive, so a long task description survived because
 *  it happened to mention a media path. */
export function maskFreeText(s, pseudo = null) {
  const spans = [];
  for (const re of [EMBEDDED_MEDIA_ROOT, EMBEDDED_SESSION_KEY]) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[0], re });
    }
    re.lastIndex = 0;
  }
  if (spans.length === 0) return maskText(s);
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue; // overlapping match: the first one wins
    out += maskText(s.slice(cursor, span.start));
    if (span.re === EMBEDDED_MEDIA_ROOT) {
      // Root verbatim, FILE NAME masked.
      const cut = span.text.lastIndexOf("/") + 1;
      out += span.text.slice(0, cut) + maskText(span.text.slice(cut));
    } else {
      out += pseudo === null ? maskText(span.text) : pseudo.identifier(span.text);
    }
    cursor = span.end;
  }
  return out + maskText(s.slice(cursor));
}

/** Back-compat name for the media-only case. */
export function maskKeepingMediaSentinel(s) {
  return maskFreeText(s, null);
}

/** A deterministic pseudonym mint. Same original -> same pseudonym, numbered in
 *  first-seen order, so promoting the same capture twice is byte-identical.
 *
 *  `literals` adds vocabulary this corpus knows about — in practice the TOOL NAMES the
 *  capture itself carries under `data.name`, which appear again inside delivery run ids
 *  and must stay readable there. */
export function createPseudonymiser(literals = [], renamed = new Map()) {
  const map = new Map();
  let uuidCount = 0;
  const extra = new Set([...literals].map((t) => t.toLowerCase()));
  // Tool names that are NOT gateway built-ins: renamed, consistently, wherever they
  // appear — including inside a `<tool>:<taskId>:ok` run id.
  //
  // CASE-SENSITIVE. A tool name is an identifier, and lower-casing the lookup collapsed
  // `Acme` and `acme` onto one alias: the cards stayed distinct while both run ids took
  // the second alias, so a delivery could be attributed to the wrong tool (raised in
  // review).
  const renames = new Map(renamed);
  const mint = (token) => {
    let p = map.get(token);
    if (p === undefined) {
      p = `id${map.size + 1}`;
      map.set(token, p);
    }
    return p;
  };
  return {
    /** Pseudonymise an identifier by its GRAMMAR, not by a token allowlist.
     *
     *  A token list is position-blind, and that leaks: `main` is a protocol-ish word AND
     *  a real agent id, so `agent:main:atrium:chat:…` published it verbatim (raised in
     *  review). It also broke renames for a tool named `acme-patient`, because the token
     *  split happened before the lookup. Each known shape is matched whole, and only the
     *  positions the readers key on are kept. Anything unrecognised falls through to
     *  pseudonymising EVERY token — fail closed. */
    identifier(value) {
      const uuid = (seg) => {
        let p = map.get(seg);
        if (p === undefined) {
          p = mintUuid(++uuidCount);
          map.set(seg, p);
        }
        return p;
      };
      const opaque = (seg) =>
        UUID_RE.test(seg)
          ? uuid(seg)
          : seg
              .split(ID_SPLIT)
              .map((t) => (t === "" || ID_SPLIT.test(t) ? t : mint(t)))
              .join("");
      const tool = (name) => {
        const renamed = renames.get(name);
        if (renamed !== undefined) return renamed;
        return extra.has(name.toLowerCase()) ? name : opaque(name);
      };

      // `agent:<agentId>:atrium:chat:<canonical>:<chatId>` — the parent session key.
      let m = /^agent:([^:]+):atrium:chat:([^:]+):(.+)$/.exec(value);
      if (m) return `agent:${opaque(m[1])}:atrium:chat:${opaque(m[2])}:${opaque(m[3])}`;

      // `agent:<agentId>:subagent:<uuid>[:subagent:<uuid>…]` — a child session key.
      m = /^agent:([^:]+):subagent:(.+)$/.exec(value);
      if (m) {
        const rest = m[2]
          .split(":subagent:")
          .map((seg) => opaque(seg))
          .join(":subagent:");
        return `agent:${opaque(m[1])}:subagent:${rest}`;
      }

      // `announce:…` — the FAMILY is the prefix alone (`isGatewayInitiatedRunId` tests
      // nothing else), so it is kept for every shape; requiring the full `v1` form made a
      // differently-shaped announce lose its family entirely. Inside, the known
      // `v<n>:<childSessionKey>:<childRunId>` layout is read further: the sink keys on
      // that version literal to settle the announced child.
      m = /^announce:(.+)$/.exec(value);
      if (m) {
        const inner = /^(v\d+):(.+):([^:]+)$/.exec(m[1]);
        return inner
          ? `announce:${inner[1]}:${this.identifier(inner[2])}:${opaque(inner[3])}`
          : `announce:${opaque(m[1])}`;
      }

      // `<tool>:<uuid>:<ok|error>[:agent-loop]` — a background-task delivery.
      // The trailing LANE is what 2026.8.1+ appends (upstream
      // subagent-announce-delivery.ts:219,230). Without it here the whole run id
      // fell through to `opaque()`, the delivery family was destroyed by the
      // promotion, and the fidelity gate refused the capture — the same lane
      // blindness the bridge and Convex readers carried (found by that gate,
      // 2026-09-04). Only the documented lane is kept; anything else stays opaque.
      m = /^([A-Za-z][A-Za-z0-9_.-]*):([0-9a-fA-F-]{36}):(ok|error)(:agent-loop)?$/.exec(
        value,
      );
      if (m && UUID_RE.test(m[2]))
        return `${tool(m[1])}:${uuid(m[2])}:${m[3]}${m[4] ?? ""}`;

      // `inject-<messageId>` / `webchat-<hex>` / `talk-<callId>-…`
      m = /^(inject|webchat|talk)-(.+)$/.exec(value);
      if (m) return `${m[1]}-${opaque(m[2])}`;

      // An absolute PATH: the known media root is infrastructure and is kept as a whole
      // PREFIX (never token by token, which is what let `home` and `node` through
      // anywhere); everything after it is identity.
      for (const root of MEDIA_ROOTS) {
        if (value.startsWith(root)) return root + opaque(value.slice(root.length));
      }

      // A bare tool name (a card, a `toolName` field).
      if (
        /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value) &&
        (renames.has(value) || extra.has(value.toLowerCase()))
      ) {
        return tool(value);
      }

      return opaque(value);
    },
    size: () => map.size,
  };
}

/** Every key this corpus is allowed to keep verbatim, before the caller adds the
 *  vendored manifest's own field names. */
export function baseKnownKeys() {
  return new Set([
    ...VOCABULARY_KEYS,
    ...IDENTIFIER_KEYS,
    ...STRUCTURAL_KEYS,
    ...TOOL_RESULT_KEYS,
    ...NORMALIZER_ARG_KEYS,
  ]);
}

/** The base set PLUS every field name the vendored coverage manifest classifies for this
 *  gateway version.
 *
 *  Deriving the vocabulary instead of listing it is the same rule the known-field sets
 *  already follow: a hand-kept list of key names would drift from the contract, and here
 *  the drift would be silent — a field would simply come out of promotion masked. It also
 *  keeps ONE chain: vendored schema -> coverage manifest -> runtime sets -> corpus. */
export function knownKeysFromCoverage(coverage, snapshotFields = []) {
  const keys = baseKnownKeys();
  // The session snapshot the gateway FLATTENS onto agent events. No schema declares it —
  // that is the whole reason it is derived from upstream source at vendoring time — so a
  // vocabulary built from the manifest alone masked twelve real protocol fields, and the
  // drift check over the corpus is what said so. Two artifacts, one chain.
  for (const field of snapshotFields) keys.add(field);
  const schemas = coverage?.schemas;
  if (schemas === undefined || schemas === null || typeof schemas !== "object") {
    throw new Error("coverage manifest has no `schemas` object");
  }
  let n = 0;
  for (const schema of Object.values(schemas)) {
    for (const field of Object.keys(schema?.fields ?? {})) {
      keys.add(field);
      n += 1;
    }
  }
  if (n === 0) throw new Error("coverage manifest classifies no field at all");
  return keys;
}

/** Walk a frame, applying the classes. `knownKeys` is the vocabulary of key NAMES.
 *
 *  An UNKNOWN key is masked like a value. Field names are protocol vocabulary — that is
 *  why the drift badge may show them — but a key nobody has classified is precisely the
 *  one that could be data rather than vocabulary (a map keyed by an address, a name, an
 *  id), and by definition no code branches on it, so masking it costs the replay nothing.
 *  When the corpus matches its vendored version this never fires; if it does fire, the
 *  drift check over the corpus says so in the same breath. */
/** Epoch-millisecond range a capture can plausibly carry (2001-09-09 → 2096). A number in
 *  it is a DATE, and a date says when a real conversation happened. */
const EPOCH_MS_MIN = 1_000_000_000_000;
const EPOCH_MS_MAX = 4_000_000_000_000;

export function anonymizeFrame(
  frame,
  pseudo,
  stats,
  knownKeys = baseKnownKeys(),
  toolNames = new Set(),
  epochBase = null,
  renamedTools = new Map(),
) {
  // Inside a free-form region the vocabulary shrinks to what the READER consumes — never
  // the manifest, which describes the protocol and not a tool's private payload.
  const readerKeys = new Set([
    ...VOCABULARY_KEYS,
    ...TOOL_RESULT_KEYS,
    ...NORMALIZER_ARG_KEYS,
    ...STRUCTURAL_KEYS,
    // The identifiers a free-form blob may carry. They were classified for their VALUES
    // and forgotten for their KEYS, so `childSessionKey` — which
    // `SubAgentObserver.extractChildSessionKey` requires verbatim inside a serialised
    // spawn result — came out as `xxxxxXxxxxxxXxx` and no spawned child could be
    // registered from a promoted capture (raised in review).
    ...FREE_FORM_IDENTIFIER_KEYS,
    "taskId",
    "toolCallId",
    "mediaUrls",
    "mediaPaths",
    // The cron card's own structure (`core/cron-part.ts`): without these the reader emits
    // a card with almost nothing in it, and counting cards — which is all the fidelity
    // gate did — cannot see the difference (raised in review).
    "job",
    "patch",
    "jobId",
    "schedule",
    "payload",
    "delivery",
    "enabled",
    "state",
    // …and the leaves the card is actually built from (`cronPartFromTool`): the job's own
    // id, name and agent, the delivery mode, the next-run stamp. The gate showed exactly
    // which ones were missing — `agentId+deliveryMode+jobId+name` — instead of leaving me
    // to guess from the reader's source.
    "id",
    "mode",
    "nextRunAtMs",
    "agentId",
    // The KEY only: a cron job's name is user text and the value is masked by the `name`
    // branch, but the card must still carry the field.
    "name",
    // The plan card's own leaves (`core/plan-part.ts`): the steps and the explanation.
    // Same rule — the field survives, its text does not.
    "explanation",
  ]);
  // The ONE node whose `name` is a tool name: the `data` of a `stream:"tool"` event.
  // Comparing the VALUE against the harvested set was the previous rule and it published
  // a real name the moment a user-facing `name` happened to equal a tool that ran in the
  // same capture (`childSessions[].name: "exec"` after an `exec` call, raised in review).
  // Position decides it; the harvested set only decides what may appear inside an id.
  // BOTH streams name a tool. `stream:"item"` is the tool's tracked item, and the
  // normalizer keys the plan advance on `data.name === "update_plan"` there — masking it
  // silently removed every item-derived reading (found by the fidelity replay).
  const toolData =
    (frame?.payload?.stream === "tool" || frame?.payload?.stream === "item") &&
    frame?.payload?.data !== null
      ? frame?.payload?.data
      : undefined;

  const walk = (node, key, inToolData = false, freeForm = false) => {
    if (Array.isArray(node)) return node.map((v) => walk(v, key, inToolData, freeForm));
    if (node !== null && typeof node === "object") {
      const out = {};
      const isToolData = toolData !== undefined && node === toolData;
      const vocabulary = freeForm ? readerKeys : knownKeys;
      // Key ORDER is preserved: a reordered object is a different fixture byte-wise, and
      // determinism is what makes a re-promotion a no-op instead of a diff.
      for (const [k, v] of Object.entries(node)) {
        const childFree = freeForm || FREE_FORM_KEYS.has(k);
        if (vocabulary.has(k)) {
          out[k] = walk(v, k, isToolData, childFree);
        } else {
          stats.maskedKeys += 1;
          // The value goes too: an unknown key's value has no classification either.
          out[maskText(k)] = walk(v, null, false, true);
        }
      }
      return out;
    }
    // Scalars, in a free-form region: type kept, value dropped, unless the reading stack
    // consumes this exact key.
    if (freeForm && typeof node !== "string") {
      // Only the exact typed values the reading stack consumes. Allowing anything under a
      // generic reader key published `{"status": 123456789}` and `{"taskId": 12345}`
      // verbatim (raised in review): the key being known says nothing about the value.
      if (typeof node === "boolean" && FREE_FORM_BOOLEAN_KEYS.has(key)) return node;
      stats.masked += 1;
      return typeof node === "boolean" ? false : typeof node === "number" ? 0 : node;
    }
    // TIMESTAMPS are rebased, never published absolute — AFTER the free-form redaction
    // above, or a date inside a tool payload survives as an exact offset from a capture
    // whose own date is in the header (raised in review).
    // `ts`, `startedAt`, `updatedAt`
    // and friends are classified fields, so they used to pass through untouched and dated
    // the conversation to the millisecond (raised in review). The replay only ever needs
    // the INTERVALS, and rebasing keeps every one of them exact. Detected by VALUE, not by
    // a key list: a list would miss the next timestamp field upstream adds.
    if (
      epochBase !== null &&
      typeof node === "number" &&
      Number.isFinite(node) &&
      Math.abs(node) >= EPOCH_MS_MIN &&
      Math.abs(node) <= EPOCH_MS_MAX
    ) {
      return node - epochBase;
    }
    // NUMBERS are only safe where a field is CLASSIFIED. `seq`, `ts` and counts are
    // protocol; a number under a key nobody classified is whatever the payload put there
    // — an age, an amount, a phone number — and it was passing through untouched into a
    // public corpus (raised in review). Structure is kept, the value is not.
    if (typeof node === "number") {
      if (key !== null && knownKeys.has(key)) return node;
      stats.masked += 1;
      return 0;
    }
    if (typeof node !== "string") return node;
    // `name` is vocabulary ONLY when it names a TOOL, i.e. only inside that tool event's
    // own `data`. A blanket `name` key kept `childSessions[].name` verbatim and the agent
    // names `Alice`, `Bob` and `Fichiers` rode straight into the corpus.
    // Inside a free-form blob, a string is kept only when it IS one of the control values
    // the reader compares against — never merely because its key is protocol elsewhere.
    if (freeForm) {
      // A free-form container can arrive SERIALISED: `messageToolText` explicitly accepts
      // `args` as a JSON string. Masking it character by character destroyed a shape the
      // reader supports, so the corpus could never cover it (raised in review). Parse,
      // anonymise the structure, re-serialise — the length is not preserved here, and it
      // does not need to be: this is not streamed text, so no prefix relation rides on it.
      // Serialised structure, WHEREVER it sits in a free-form region — not only directly
      // under a container key. `sessions_spawn` returns its JSON inside
      // `result.content[].text`, so keying on the container name missed it and the mask
      // turned `childSessionKey` into `xxxxx…`; `extractChildSessionKey` could then never
      // register the child (raised in review). Parsing is narrow — an object or an array,
      // never a bare scalar — and the values inside go through the same rules.
      const embedded = parseJsonObject(node);
      if (embedded !== null) {
        return JSON.stringify(walk(embedded, key, inToolData, true));
      }
      if (key !== null && FREE_FORM_IDENTIFIER_KEYS.has(key)) {
        stats.pseudonymised += 1;
        return pseudo.identifier(node);
      }
      const allowed = key === null ? undefined : FREE_FORM_VALUE_ALLOW.get(key);
      if (allowed !== undefined && allowed.has(node)) {
        stats.verbatim += 1;
        return node;
      }
      stats.masked += 1;
      return maskFreeText(node, pseudo);
    }
    // `toolName` names a tool too, and it is a PROTOCOL field, so it was kept verbatim —
    // publishing a custom plugin name the `data.name` path had carefully renamed (raised
    // in review). Same rule, same alias.
    if (key === "toolName") {
      if (toolNames.has(node)) {
        stats.verbatim += 1;
        return node;
      }
      const renamedTool = renamedTools.get(node);
      if (renamedTool !== undefined) {
        stats.pseudonymised += 1;
        return renamedTool;
      }
      stats.masked += 1;
      return maskText(node);
    }
    if (key === "name") {
      if (inToolData && toolNames.has(node)) {
        stats.verbatim += 1;
        return node;
      }
      // A custom tool keeps a STABLE, grammar-compatible pseudonym rather than a mask, so
      // its card and its delivery run still name the same thing.
      const renamedTool = inToolData ? renamedTools.get(node) : undefined;
      if (renamedTool !== undefined) {
        stats.pseudonymised += 1;
        return renamedTool;
      }
      stats.masked += 1;
      return maskText(node);
    }
    if (key !== null && VOCABULARY_KEYS.has(key)) {
      stats.verbatim += 1;
      return node;
    }
    if (key !== null && IDENTIFIER_KEYS.has(key)) {
      stats.pseudonymised += 1;
      return pseudo.identifier(node);
    }
    // STREAMED TEXT. Masked per character so `mask(a + b) === mask(a) + mask(b)` — the
    // prefix relation the snapshot/replace path rides on — but the media DIRECTIVE is
    // preserved inside it too: a media delivered only in the visible text is a supported
    // form, and `collectMedia` reads that exact prefix from the raw text. The two
    // properties can conflict for a sentinel split across deltas; the fidelity gate is
    // what decides, per capture, and it refuses rather than shipping a changed reading.
    stats.masked += 1;
    return maskFreeText(node, pseudo);
  };
  return walk(frame, null);
}
