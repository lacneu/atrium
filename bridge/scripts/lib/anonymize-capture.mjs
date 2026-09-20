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
//   TEXT         masked per character: letters → `x`, digits → `0`, and a SHORT list of
//                separators kept as themselves — everything else, emoji and unlisted
//                Unicode punctuation included, also becomes `x`.
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
  // 2026.9.5: the queue that ran the turn (hook, cron, chat), copied onto the agent
  // event by the gateway without being declared on AgentEvent. A closed vocabulary,
  // and the drift detector reads the KEY — masking it made the corpus report
  // `agent.xxxx` as unknown drift.
  "lane",
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
  // …and where the media-generation tools WRITE. Absent from this list, an async image
  // delivery's `mediaUrls` was masked whole, so the corpus could not replay the one frame
  // that carries the artifact — the path the bridge had to learn to accept (codex).
  "/home/node/.openclaw/media/tool-image-generation/",
  "/home/node/.openclaw/media/tool-music-generation/",
  "/home/node/.openclaw/media/tool-video-generation/",
];

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

/** The only BOOLEANS a free-form blob may keep: the three flags the reading stack tests.
 *  `details.async` is the whole background-task ack, `isError` decides whether a tool
 *  result is a failure, and `enabled` is the cron job's own state (`core/cron-part.ts`);
 *  every other boolean in there is data. */
const FREE_FORM_BOOLEAN_KEYS = new Set(["async", "isError", "enabled"]);

/** Control VALUES the reading stack compares against, by key. Inside a free-form blob a
 *  protocol-named key is not enough — `result: {status: "Alice's diagnosis"}` was
 *  published verbatim because `status` is vocabulary somewhere (raised in review). Only
 *  these exact values survive; anything else under the same key is masked.
 *
 *  They are not decoration: `messageToolText` branches on `action` and on the channel to
 *  decide whether a message-tool call IS the visible reply, and a plan step's `status` is
 *  what the plan card renders. Masking them made the replay classify an in-chat send as
 *  an external one and never exercise the visible-message path. */

const FREE_FORM_VALUE_ALLOW = new Map([
  // `send`/`thread-reply` are read by `messageToolText` (normalizer.ts:2530);
  // `add`/`update`/`remove` are the cron mutations `cronPartFromTool` keys on
  // (`core/cron-part.ts` MUTATING_ACTIONS). Sources of truth are those two readers — and
  // when an entry is missing here the golden corpus says so by turning a snapshot red,
  // which is exactly how `add` was found.
  //
  // `reply` and `post` used to sit here and NO reader compares them (raised in review).
  // Removing them is fail-closed and changes no reading: the one comparison is
  // `action !== "send" && action !== "thread-reply"`, so a masked value takes the very
  // same branch the literal did. Both readers of this key behave the same way: neither
  // `messageToolText` nor `cronPartFromTool` accepts `reply`/`post`, masked or not.
  // Proven three ways — reader analysis, a green suite, and a 2026.9.4 golden corpus that
  // is byte-identical without them.
  ["action", new Set(["send", "thread-reply", "add", "update", "remove"])],
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

/** Keys whose OBJECT value is a shape the contract declares, and may therefore be
 *  walked with the full protocol vocabulary.
 *
 *  THE DEFAULT IS NOW THE OTHER WAY ROUND, and that is the point. The old rule was
 *  "a known key survives, and its subtree is walked with the full vocabulary" — which
 *  meant ANY known key holding an undeclared object published every
 *  `VOCABULARY_KEYS` string inside it verbatim. Measured 2026-09-12 over the real
 *  coverage-derived vocabulary: **586 of 594 keys** leaked a sub-object
 *  (`{"<anyKnownKey>":{"status":"<sentence>"}}` came out intact). `error` was the one
 *  an adversarial review demonstrated; it was never the only one.
 *
 *  So an object under a known key is FREE-FORM unless it is listed here. Derived from
 *  the shapes that actually occur in promoted captures, not guessed: adding a key here
 *  is a review event, because it re-opens the full vocabulary one level deeper.
 *
 *  A missing entry costs fidelity (a declared leaf gets masked and the golden replay
 *  says so, loudly). A wrong entry costs a leak, silently. That asymmetry is why the
 *  list is short and why the default is closed. */
const DECLARED_OBJECT_KEYS = new Set([
  // Envelope and transport.
  "frame",
  "payload",
  "data",
  // Declared protocol shapes.
  "message",
  "content",
  "session",
  "identity",
  "task",
  "plan",
  "steps",
  "schedule",
  "delivery",
  "job",
  "state",
  "stateVersion",
  "model",
  "models",
  "providers",
  "plugins",
  "agents",
  "agentRuntime",
  "thinkingLevels",
  "participants",
  "expandedParticipants",
  "contextBudgetStatus",
  "retry",
]);

/** Containers whose CONTENTS are free-form as far as the protocol is concerned. The
 *  manifest's 631 schemas describe protocol fields; none of them licenses a key that
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
  // FREE-TEXT leaves of two different readers: `explanation` belongs to the plan card
  // (`planPartFromPlanStream`, core/plan-part.ts:78) and `title` to a provenance item
  // (`core/provenance.ts:91`) — this comment used to attribute both to the plan card,
  // and that error survived two reviews before one of them acted on it.
  // `explanation` is reader vocabulary, so the plan node lets its KEY through — and that
  // is exactly why it must also be a free-form CONTAINER. `title` is NOT reader
  // vocabulary, and is listed here for the same fail-closed reason regardless of who
  // lets its key through: a declared container must never re-open the subtree. Without this, opening the key opened the
  // subtree: `{"explanation": {"status": "Alice has cancer"}}` walked on with the full
  // vocabulary, `status` is a protocol value key, and the sentence came out VERBATIM
  // with `masked: 0` (found by adversarial review, 2026-09-12, on the very change that
  // stopped the key being dropped). A malformed frame or an upstream shape change is
  // enough to publish the text; an anonymiser must fail CLOSED on shape.
  "explanation",
  "title",
  // A lifecycle `error` is read as an arbitrary object by the normalizer
  // (`extractLifecycleError`), and it is a manifest-declared key — so it survived the
  // vocabulary and its subtree was walked with it: `{"error":{"status":"<sentence>"}}`
  // came out VERBATIM (adversarial review, 2026-09-12). Demonstrated with the
  // coverage-derived vocabulary, which is the one the promoter actually passes; the
  // same probe against `baseKnownKeys()` returns a reassuring zero, so test this node
  // with the real vocabulary or not at all.
  "error",
]);

/** Structural keys: the skeleton the frame is built from, and the shape is meaningless
 *  without them. Mostly containers — but NOT only: `text`, `step` and `receivedAt` are in
 *  here as KEY NAMES. Keeping the name is what the replay needs; the VALUE under it is
 *  handled by its own value class like any other — masked for prose, rebased for a
 *  `receivedAt` when an epoch base is given, kept when there is none — so naming a key
 *  structural says nothing about what happens to its content. */
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

/** Every string in a capture with the SHAPE of a pseudonym — `id<n>`, a UUID, or a tool
 *  alias `tool_<n>` — so the minters can skip them.
 *
 *  THE GAP IT CLOSES (defect 15). The fixed-point guard compared a candidate with the ONE
 *  token being replaced: `["id1","id2"]` came out `["id2","id3"]`, and the RAW `id2` then
 *  sat in the corpus as `id1`'s pseudonym, indistinguishable from one. The same held for a
 *  raw UUID equal to an early minted one, and for a raw `tool_<n>` equal to a custom tool's
 *  alias. Pseudonyms only ever take these three forms, so reserving every occurrence of
 *  them in the capture before the first mint makes a collision impossible.
 *
 *  Collected the way the anonymiser READS: from the parsed frames — keys and values — and,
 *  recursively, from JSON serialised inside a string value (the anonymiser re-parses those,
 *  so an escaped `\u0069d2` there becomes `id2` only at that point, and a lexical scan of
 *  the outer string missed it — codex). A line that does not parse is scanned as raw text.
 *  UUIDs are reserved lower-cased, the case the minter writes.
 *
 *  NUMBERING: a pseudonym-shaped string anywhere in the raw capture — even in content later
 *  masked or dropped — advances the minters past that value. Deterministic, and never a
 *  leak; a capture with no such string promotes exactly as before. */
export function reservedPseudonymShapes(rawSlice) {
  const out = new Set();
  const scan = (text) => {
    for (const m of text.matchAll(/(?<![A-Za-z0-9_])(?:id|tool_)\d+(?![A-Za-z0-9_])/g)) out.add(m[0]);
    for (const m of text.matchAll(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g)) {
      out.add(m[0].toLowerCase());
    }
  };
  const walk = (value) => {
    if (typeof value === "string") {
      scan(value);
      // The anonymiser re-parses serialised structure (parseJsonObject): read it the same way.
      const embedded = parseJsonObject(value);
      if (embedded !== null) walk(embedded);
    }
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        scan(key);
        walk(item);
      }
    }
  };
  for (const line of rawSlice.split("\n")) {
    if (!line.trim()) continue;
    try {
      walk(JSON.parse(line));
    } catch {
      scan(line);
    }
  }
  return out;
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

/** Length-preserving mask, class-preserving only for letters, digits and the listed
 *  separators; anything else collapses to `x`. A homomorphism over concatenation, which is what
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
// The SAME directories `MEDIA_ROOTS` preserves in structured fields. Pinned to `outbound`
// alone, a captured `MEDIA:` line or a tool result naming a GENERATED file was masked whole
// — so the corpus could replay a structured `mediaUrls` but never the directive and embedded
// forms, which are exactly the readers a capture is meant to exercise (codex).
const EMBEDDED_MEDIA_ROOT =
  /(?:MEDIA:)?\/home\/node\/\.openclaw\/media\/(?:outbound|tool-image-generation|tool-music-generation|tool-video-generation)\/[^\s"]+/g;
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
      // The DELIVERABLE ROOT verbatim, EVERYTHING after it masked — intermediate directories
      // included. Keeping the path up to the last `/` published every directory name along
      // the way, and a delivery may legitimately be nested, so a folder called after a
      // person or a case would have reached the corpus intact (codex P1). The root is what
      // the reading stack scans for; nothing below it is structure worth keeping.
      const m = /^(MEDIA:)?(.*?\/media\/[^/]+\/)/.exec(span.text);
      const cut = m === null ? span.text.lastIndexOf("/") + 1 : m[0].length;
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
export function createPseudonymiser(literals = [], renamed = new Map(), reserved = new Set()) {
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
  // FAIL CLOSED on an identity alias. The tool-rename map arrives from the caller, and the
  // walker returns its value directly for `toolName`/`data.name` — so an alias equal to its
  // own key republishes the name while counting a pseudonymisation, the same fixed point
  // the id minter had. The producer (`classifyToolNames`) now skips these; this refuses to
  // promote at all if any other caller supplies one, because the alternative is a corpus
  // that looks anonymised and is not.
  for (const [name, alias] of renamed) {
    if (name === alias) {
      throw new Error(`tool alias for ${JSON.stringify(name)} is the name itself`);
    }
  }
  const renames = new Map(renamed);
  // FIXED POINTS. The counter used to be `map.size + 1`, so the pseudonym for the token
  // `id1` was the string `id1`: the value came out VERBATIM while the run counted it as
  // pseudonymised, which is the one outcome "no value survives" forbids. The same held
  // for a value that already looked like the first minted UUID. It is reachable on
  // purpose — an agent or a tool may be named `id1` — so the candidate is now compared
  // against the token and skipped when they are equal (raised in review).
  //
  // The numbering STILL comes from `map.size`, and that detail is load-bearing: the UUID
  // path writes into the same map, so a standalone counter renumbered every id that
  // followed a UUID and rewrote the whole golden corpus. The first attempt at this fix did
  // exactly that and the corpus A/B caught it. Only a COLLISION advances the candidate,
  // and `issued` keeps a skip from handing the next token the pseudonym just skipped.
  const issued = new Set();
  const mint = (token) => {
    let p = map.get(token);
    if (p === undefined) {
      let n = map.size + 1;
      p = `id${n}`;
      // `reserved`: every pseudonym-shaped string of the capture (reservedPseudonymShapes).
      while (p === token || issued.has(p) || reserved.has(p)) p = `id${++n}`;
      issued.add(p);
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
          do {
            p = mintUuid(++uuidCount);
          } while (p === seg || reserved.has(p));
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

/** Epoch-millisecond range a capture can plausibly carry (2001-09-09 → 2096). A number in
 *  it is a DATE, and a date says when a real conversation happened. */
const EPOCH_MS_MIN = 1_000_000_000_000;
const EPOCH_MS_MAX = 4_000_000_000_000;

/** A COPY of the declared list. Exporting the Set itself handed every consumer a
 *  `.delete("job")` that would silently re-open a masking decision inside the walker —
 *  raised in review. Nothing needs to mutate it; a test needs to read it. */
export function declaredObjectKeys() {
  return new Set(DECLARED_OBJECT_KEYS);
}

/** The vocabulary a free-form region keeps. Inside such a region the vocabulary shrinks
 *  to what the READERS consume — never the manifest, which describes the protocol and not
 *  a tool's private payload. Exported so anonymize-leak.test.ts can sweep the `plan`
 *  domain over it rather than assume it. */
export function readerVocabulary() {
  return new Set([
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
    // The cron card's own structure (`core/cron-part.ts`): without these the reader emits
    // a card with almost nothing in it, and counting cards — which is all the fidelity
    // gate did — cannot see the difference (raised in review).
    //
    // `payload` and `state` are also reachable through STRUCTURAL_KEYS today, and a review
    // called them inert. They are restated here on purpose: that set is maintained for the
    // frame skeleton, for reasons that have nothing to do with a cron card, and dropping
    // one from it must not silently empty this reader. Four identifier keys that used to
    // sit here WERE removed in the same review — those merely repeated the spread directly
    // above, which is exactly the set that owns them.
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
    // The cron card's SCHEDULE (`printableCronSchedule`, core/cron-part.ts): which branch it
    // prints — `cron <expr> (<tz>)`, `at …`, `every …` — is decided by these keys alone.
    // Masked as keys, a real `{kind:"cron", expr, tz}` printed as `"xxxx"` after promotion
    // and the fidelity gate, comparing only which card fields were set, could not see it
    // (defect 13, measured on the 2026-09-15 GO run). Their VALUES stay masked.
    "expr",
    "cron",
    "tz",
    "at",
    "atMs",
    "everyMs",
    "every",
    // A lifecycle error OBJECT (`extractLifecycleError`, normalizer.ts): the reader takes
    // the first non-blank of message/error/detail/reason/code. `message` is already above;
    // without the other four, an error carried only under `detail` read as the generic
    // fallback after promotion. Values stay masked.
    "error",
    "detail",
    "reason",
    "code",
  ]);
}

/** READER POSITIONS, BY NODE (defect 13).
 *
 *  Some values a reader consumes cannot be told from data by their key NAME: a `context`
 *  boolean, a `timeoutMs` number or a report's `v` mean something at one exact position and
 *  nothing anywhere else — least of all inside a document excerpt that happens to parse as
 *  JSON. A key-name rule published them wherever they sat (codex). So these are decided per
 *  NODE of the raw frame: `captureReaderRules` locates the exact objects a reader would read,
 *  under the reader's own acceptance conditions, and gives each its vocabulary and the few
 *  scalars kept there. Objects parsed out of a serialised string are never among them, except
 *  where the reader itself parses one (the cron job carried in a tool result's text).
 *
 *  THE READERS THEMSELVES DECIDE. A position is recognised by calling the bridge's own reader
 *  on the raw frame — `parseProvenanceReport`, `asyncTaskStartFromTool`, `isCronTool` — handed
 *  in by the caller (the promoter loads them from the same build its fidelity gate replays).
 *  Restating their acceptance conditions here recognised MORE than they accept (a report later
 *  refused for having no valid item or for its size, a 25th item) and LESS (the wire phase
 *  `result` the normalizer turns into `completed`) — codex, twice. Without readers, nothing is
 *  recognised and every such value is masked: fail closed.
 *
 *  THE PROVENANCE REPORT. A context-injecting plugin reports what it fed the model on
 *  `<pluginId>.provenance` (upstream `emitPluginAgentEvent`, src/plugins/agent-event-emission.ts
 *  at v2026.9.4: a non-bundled plugin may only emit on its own id or `<id>.<suffix>`, and the
 *  gateway stamps `pluginId`/`pluginName` into `data`). `parseProvenanceReport`
 *  (core/provenance.ts) refuses the whole report unless `v === 1`, and `v` is no protocol key:
 *  promotion turned it into `{"x": 0}`, masked every item leaf, and every promoted report was
 *  dropped without a sound. A report is recognised only when `parseProvenanceReport` accepts the
 *  raw one, and only its first MAX_PROVENANCE_ITEMS items — the ones it reads. */
const PROVENANCE_STREAM_SUFFIX = ".provenance";
const PROVENANCE_REPORT_KEYS = new Set([
  "v", "pluginId", "pluginName", "source", "kind", "items", "injected", "retrieval",
]);
const PROVENANCE_ITEM_KEYS = new Set([
  "id", "type", "date", "score", "text", "file_name", "title", "collection", "context",
]);
const PROVENANCE_INJECTED_KEYS = new Set(["chars", "position", "truncated"]);
const PROVENANCE_RETRIEVAL_KEYS = new Set(["route", "bank", "collections", "lightrag"]);
const PROVENANCE_LIGHTRAG_KEYS = new Set(["mode"]);

/** Every key a provenance position may carry, as a copy (the leak sweep derives from it). */
export function provenanceVocabulary() {
  return new Set([
    ...PROVENANCE_REPORT_KEYS,
    ...PROVENANCE_ITEM_KEYS,
    ...PROVENANCE_INJECTED_KEYS,
    ...PROVENANCE_RETRIEVAL_KEYS,
    ...PROVENANCE_LIGHTRAG_KEYS,
  ]);
}

const isPlainRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === "string" && v.length > 0;

/** WHAT THE READING STACK CONSUMED from a capture, as a multiset of the readings it wrote:
 *  provenance parts, cron parts, and task rows carrying a declared timeout. Built by
 *  `consumedReadings` (replay-fidelity.mjs), which replays the RAW capture through the same
 *  RunManager as the fidelity gate — so frame admission (event type, session, run), argument
 *  buffering and turn resets are the stack's own, never restated here (codex: every restatement
 *  of the normalizer's admission rules missed one).
 *
 *  Every reading is ATTRIBUTED (see captureReaderRules): cron cards and task engagements by the
 *  paths of the exact raw objects the reader was given; failure classes by the entry whose feed
 *  closed the turn; provenance parts — rebuilt by the reader, so no reference reaches the frame —
 *  by RUN and content. Counting parts by content alone let a report of another run, earlier in the
 *  capture, take the credit of the one the stack read (measured on a real capture: a sub-agent's
 *  identical probe report). A report no admitted frame delivered, a task no turn opened, a card no
 *  call wrote, keeps nothing. */
export function readingsLedger({
  sessionKey = null,
  provenanceReads = [],
  cronReads = [],
  taskReads = [],
  errorReads = [],
} = {}) {
  return { sessionKey, provenanceReads, cronReads, taskReads, errorReads };
}

/** The five CronScheduleSchema kinds of 2026.9.4 (protocol/openclaw/2026.9.4/cron.ts).
 *  `printableCronSchedule` prints `on-exit` and `stream` as the bare kind, so a masked kind is a
 *  different card. Kept only on a schedule the cron card reads — never by key name. */
const CRON_SCHEDULE_KINDS = new Set(["at", "every", "cron", "on-exit", "stream"]);
const cronScheduleRule = {
  keep: new Map([["kind", (v) => (CRON_SCHEDULE_KINDS.has(v) ? v : undefined)]]),
};
/** A STRING schedule, printed as it stands: its leading branch word survives, the rest is
 *  masked like any text. */
const cronScheduleStringRule = {
  keep: new Map([
    [
      "schedule",
      (v) => {
        const branch = typeof v === "string" ? /^(cron|at|every) /.exec(v)?.[1] : undefined;
        return branch === undefined ? undefined : `${branch} ${maskText(v.slice(branch.length + 1))}`;
      },
    ],
  ]),
};

/** The reader-consumed nodes of one raw frame -> `{vocabulary?, freeForm?, keep?, embedded?}`.
 *  `keep` maps a key to a function returning the value to publish, or `undefined` to let the
 *  ordinary rules apply; `freeForm` walks the node's own scalars under the free-form rules;
 *  `embedded` maps a key holding serialised JSON the reader parses to the rules of the parsed
 *  value. */
/** THE READINGS ONLY A WHOLE CAPTURE DETERMINES, attributed by the reading stack (defect 13).
 *
 *  A cron card is built at a tool call's completion from the input the normalizer BUFFERED off an
 *  admitted start frame and the result of an admitted result frame; a task's declared timeout
 *  from that result. Which frames were admitted, which start a result was coalesced with, whether
 *  the turn was still open: those are the normalizer's decisions, and every restatement of them
 *  here missed one (codex, four passes — errored results, the shared buffer, foreign runs). So
 *  `consumedReadings` takes them from the replay: the sink writes the completed tool part with
 *  `input`/`output` BY REFERENCE (turn-sink.ts, `input: event.input`, `output: event.output`), and
 *  those references are recorded as paths into the raw entries.
 *
 *  Here each recorded reading is resolved in `entries` (the same lines, parsed again) and read
 *  again with the bridge's own reader; nothing is kept unless it yields that reading again. What
 *  is kept: a task's `timeoutMs`, as the reader reads it; on the schedule the card prints — the
 *  result job's, else the input job's (`printableCronSchedule(job?.schedule) ??
 *  printableCronSchedule(inputJob.schedule)`, the result job selected like `jobFromOutput`), and
 *  only if that schedule prints exactly the card's — an object's `kind` (one of the five 2026.9.4
 *  literals) or a string schedule's branch word. */
export function captureReaderRules(entries, readers, consumed) {
  const rules = new Map();
  if (readers == null || consumed == null) return rules;
  const resolve = (path) => {
    if (!Array.isArray(path)) return undefined;
    let node = entries;
    for (const key of path) {
      if (node === null || typeof node !== "object") return undefined;
      node = node[key];
    }
    return node;
  };
  const isJob = (o) => isPlainRecord(o) && (o.id !== undefined || o.name !== undefined);
  /** The rules that keep what the card PRINTS of a read schedule, keyed on the node holding it:
   *  an object's `kind` only when the card is that bare kind (`printableCronSchedule` reaches
   *  `kind` last, after `expr`, `at` and `everyMs` — codex), a string's branch word. */
  const keepScheduleOf = (job, printed) =>
    isPlainRecord(job.schedule)
      ? job.schedule.kind === printed
        ? [[job.schedule, cronScheduleRule]]
        : []
      : typeof job.schedule === "string"
        ? [[job, cronScheduleStringRule]]
        : [];

  // PROVENANCE REPORTS. A read written while its own report frame was fed names that ENTRY; the
  // others name the RUN of the bubble they were written into (a stash flushed later) and claim,
  // first come first served, a report the reader itself would have stashed —
  // `readers.parseProvenanceFrame` (core/provenance.ts) — with that runId and the same parsed
  // content. Run and content alone let a `chat` event carrying the same report take the credit
  // (codex). Kept on a claimed report: its keys, walked free-form (a declared `data` node
  // published booleans and numbers under vocabulary keys — the leak sweep caught
  // `pluginName: true`), `v` 1 and the `kind` that picks the group; the first MAX_PROVENANCE_ITEMS
  // items' keys and `context: true`; `injected.truncated`; the retrieval keys.
  const keepReport = (data) => {
    rules.set(data, {
      vocabulary: PROVENANCE_REPORT_KEYS,
      freeForm: true,
      keep: new Map([
        ["v", (v) => (v === 1 ? 1 : undefined)],
        ["kind", (v) => (v === "memory" || v === "documents" ? v : undefined)],
      ]),
    });
    for (const item of data.items.slice(0, readers.MAX_PROVENANCE_ITEMS)) {
      if (!isPlainRecord(item)) continue;
      rules.set(item, {
        vocabulary: PROVENANCE_ITEM_KEYS,
        keep: new Map([["context", (v) => (v === true ? true : undefined)]]),
      });
    }
    if (isPlainRecord(data.injected)) {
      rules.set(data.injected, {
        vocabulary: PROVENANCE_INJECTED_KEYS,
        keep: new Map([["truncated", (v) => (typeof v === "boolean" ? v : undefined)]]),
      });
    }
    if (isPlainRecord(data.retrieval)) {
      rules.set(data.retrieval, { vocabulary: PROVENANCE_RETRIEVAL_KEYS });
      if (isPlainRecord(data.retrieval.lightrag)) {
        rules.set(data.retrieval.lightrag, { vocabulary: PROVENANCE_LIGHTRAG_KEYS });
      }
    }
  };
  const reportKey = (payload) =>
    readers.isProvenanceStream(payload?.stream) && isPlainRecord(payload?.data)
      ? JSON.stringify(readers.parseProvenanceReport(payload.data))
      : null;
  const claimed = new Set();
  const runReads = [];
  for (const read of consumed.provenanceReads ?? []) {
    if (!Number.isInteger(read.entry)) {
      runReads.push(read);
      continue;
    }
    const payload = entries[read.entry]?.frame?.payload;
    if (claimed.has(read.entry) || reportKey(payload) !== read.part || read.part === "null") continue;
    claimed.add(read.entry);
    keepReport(payload.data);
  }
  for (const [index, entry] of entries.entries()) {
    if (claimed.has(index) || consumed.sessionKey == null) continue;
    // The reader's OWN admission of a stashable report (`parseProvenanceFrame`): a restated
    // subset of it (event and session, not `type: "event"`) let a non-event frame claim (codex).
    const stashable = readers.parseProvenanceFrame(entry?.frame, consumed.sessionKey);
    if (stashable === null) continue;
    const key = JSON.stringify(stashable.part);
    const at = runReads.findIndex((read) => read.run === stashable.runId && read.part === key);
    if (at < 0) continue;
    runReads.splice(at, 1);
    claimed.add(index);
    keepReport(entry.frame.payload.data);
  }

  for (const read of consumed.taskReads ?? []) {
    const output = resolve(read.output);
    const start = readers.asyncTaskStartFromTool(read.name, "completed", output);
    if (
      start?.timeoutMs === undefined ||
      start.timeoutMs !== read.declaredTimeoutMs ||
      readers.taskChildKey(start.taskId) !== read.childSessionKey
    ) {
      continue;
    }
    rules.set(output.details, { keep: new Map([["timeoutMs", () => start.timeoutMs]]) });
  }

  // A LIFECYCLE ERROR's nested failure class. The normalizer reads `data.error.errorKind` before
  // `data.errorKind` and classifies the turn with it when it is a known class (normalizer.ts
  // `handleLifecycle`); `error` is a free-form container, so the value was masked and a
  // structurally classified overflow lost its class (codex). A count of classes let a refused
  // frame borrow the class another frame closed its turn with (codex), so each reading is the
  // ENTRY whose feed wrote the finalize: kept only on that lifecycle error, and only if its nested
  // value is the class written.
  for (const read of consumed.errorReads ?? []) {
    const data = entries[read.entry]?.frame?.payload?.data;
    if (
      entries[read.entry]?.frame?.payload?.stream !== "lifecycle" ||
      !isPlainRecord(data) ||
      data.phase !== "error" ||
      !isPlainRecord(data.error) ||
      data.error.errorKind !== read.errorKind
    ) {
      continue;
    }
    rules.set(data.error, { keep: new Map([["errorKind", () => read.errorKind]]) });
  }

  for (const read of consumed.cronReads ?? []) {
    const input = resolve(read.input);
    const result = resolve(read.output);
    const card = readers.cronPartFromTool(read.name, "completed", input, result);
    if (card === null || JSON.stringify(card) !== read.card || card.schedule === undefined) continue;
    const printed = card.schedule;

    // The result job, as `jobFromOutput` selects it: `details` with an id or a name, else the
    // first content text that parses to one.
    let resultJob = null;
    let embeddedBlock = null;
    if (isPlainRecord(result)) {
      if (isJob(result.details)) {
        resultJob = result.details;
      } else if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (!isPlainRecord(block) || typeof block.text !== "string") continue;
          let parsed;
          try {
            parsed = JSON.parse(block.text);
          } catch {
            continue;
          }
          if (isJob(parsed)) {
            resultJob = parsed;
            embeddedBlock = block;
            break;
          }
        }
      }
    }
    const inputJob = isPlainRecord(input)
      ? isPlainRecord(input.job)
        ? input.job
        : isPlainRecord(input.patch)
          ? input.patch
          : null
      : null;
    const fromResult = resultJob !== null ? readers.printableCronSchedule(resultJob.schedule) : undefined;
    if (fromResult !== undefined) {
      if (fromResult !== printed) continue; // the reader printed something else: keep nothing
      if (embeddedBlock !== null) {
        rules.set(embeddedBlock, { embedded: new Map([["text", (job) => (isJob(job) ? keepScheduleOf(job, printed) : [])]]) });
      } else {
        for (const [node, rule] of keepScheduleOf(resultJob, printed)) rules.set(node, rule);
      }
      continue;
    }
    if (inputJob !== null && readers.printableCronSchedule(inputJob.schedule) === printed) {
      for (const [node, rule] of keepScheduleOf(inputJob, printed)) rules.set(node, rule);
    }
  }
  return rules;
}

/** Is `n` a POSITIVE epoch in milliseconds — the only arrival time a capture records
 *  (`Date.now()`)? Signed on purpose: a negative origin turns every rebased value into a sum
 *  that reveals the real date (codex). */
export function isEpochMs(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= EPOCH_MS_MIN && n <= EPOCH_MS_MAX;
}

/** Walk a frame, applying the classes. `knownKeys` is the vocabulary of key NAMES.
 *
 *  An UNKNOWN key is masked like a value. Field names are protocol vocabulary — that is
 *  why the drift badge may show them — but a key nobody has classified is precisely the
 *  one that could be data rather than vocabulary (a map keyed by an address, a name, an
 *  id), and by definition no code branches on it, so masking it costs the replay nothing.
 *  When the corpus matches its vendored version this never fires; if it does fire, the
 *  drift check over the corpus says so in the same breath. */
export function anonymizeFrame(
  frame,
  pseudo,
  stats,
  knownKeys = baseKnownKeys(),
  toolNames = new Set(),
  epochBase = null,
  renamedTools = new Map(),
  readers = undefined,
  sharedRules = undefined,
  consumed = undefined,
) {
  const readerKeys = readerVocabulary();
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
  // The NATIVE plan stream's `data` is a reader node like a tool result, and it was not
  // treated as one: walked with the manifest vocabulary, its leaf `explanation` is not a
  // protocol field, so it came out MASKED AS A KEY and `planPartFromPlanStream`
  // (core/plan-part.ts) never found it. The plan card promoted from a capture then
  // silently lost its explanation.
  //
  // This comment used to name `title` alongside `explanation`, and a function
  // `planPartFromNative` that does not exist. Both were wrong and the pair was actively
  // dangerous: a review read them and concluded `title` was a reader leaf missing from
  // `readerVocabulary()` — a fidelity defect — and the fix would have been to widen the
  // vocabulary. The reader consumes `explanation` and the steps (`step`, `status`) and
  // NOTHING else; `title` is read by no PLAN reader. It is not in `readerVocabulary()`,
  // and that absence is deliberately NOT pinned by a test: the provenance reader does
  // read `items[].title` (core/provenance.ts:91) through a free-form node where only
  // `readerVocabulary()` applies, so pinning the absence would block that repair. That
  // repair is the provenance report rule (captureReaderRules, defect 13), which carries `title`
  // on a report item and nowhere else.
  //
  // It never showed because no promoted capture had carried one: the model writes an
  // explanation only sometimes, and the first capture that did (2026-09-12,
  // spawn-chain-merge) is what turned the fidelity gate red —
  // `addPlanPart:explanation+kind+stamp+steps` raw 3, promoted 0. Pre-existing, not a
  // 2026.9.4 regression.
  const planData =
    frame?.payload?.stream === "plan" && frame?.payload?.data !== null
      ? frame?.payload?.data
      : undefined;
  // The reader positions, by node identity — all of them decided over the whole capture
  // (captureReaderRules), none from this frame alone.
  const nodeRules = new Map();
  // …plus the rules only the whole capture can decide (captureReaderRules).
  if (sharedRules !== undefined) {
    for (const [node, rule] of sharedRules) if (!nodeRules.has(node)) nodeRules.set(node, rule);
  }

  const walk = (node, key, inToolData = false, freeForm = false) => {
    if (Array.isArray(node)) return node.map((v) => walk(v, key, inToolData, freeForm));
    if (node !== null && typeof node === "object") {
      const out = {};
      const isToolData = toolData !== undefined && node === toolData;
      const isPlanData = planData !== undefined && node === planData;
      const rule = nodeRules.get(node);
      // UNION, not substitution: `readerKeys` is the reader's extra vocabulary, not a
      // superset of the protocol one. Swapping it in wholesale cost the plan node its
      // `source` field, trading one masked key for another.
      const vocabulary =
        rule?.vocabulary ??
        (isPlanData ? new Set([...knownKeys, ...readerKeys]) : freeForm ? readerKeys : knownKeys);
      // Key ORDER is preserved: a reordered object is a different fixture byte-wise, and
      // determinism is what makes a re-promotion a no-op instead of a diff.
      for (const [k, v] of Object.entries(node)) {
        // A scalar this exact node's reader consumes, in the form it consumes it.
        const kept = rule?.keep?.get(k)?.(v);
        if (kept !== undefined) {
          stats.verbatim += 1;
          out[k] = kept;
          continue;
        }
        // Serialised JSON the reader parses at this position: parse it HERE, so the parsed
        // object's own reader nodes can be recognised before it is walked (the string branch
        // below re-parses into objects no rule could name).
        const embed = rule?.embedded?.get(k);
        if (embed !== undefined && typeof v === "string" && vocabulary.has(k)) {
          const parsed = parseJsonObject(v);
          if (parsed !== null) {
            for (const [n, r] of embed(parsed)) nodeRules.set(n, r);
            out[k] = JSON.stringify(walk(parsed, k, isToolData, true));
            continue;
          }
        }
        // An OBJECT under a known key is free-form unless its shape is declared —
        // see DECLARED_OBJECT_KEYS for why the default flipped.
        // ARRAYS COUNT TOO. The first version excluded them (`!Array.isArray(v)`), and a
        // sweep found the hole still open for 560 keys through `{"<key>":[{...}]}` — an
        // array of objects under an undeclared key carried exactly the content the
        // inversion exists to close. A value-shape guard hid this for one night; when
        // that guard was reverted for being both too permissive and too strict, the array
        // case came straight back. There is no reason an undeclared CONTAINER should be
        // trusted more because it is indexed.
        const undeclaredContainer =
          v !== null && typeof v === "object" && !DECLARED_OBJECT_KEYS.has(k);
        const childFree =
          freeForm || rule?.freeForm === true || FREE_FORM_KEYS.has(k) || undeclaredContainer;
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
    // TIMESTAMPS are rebased whenever the run gives an epoch base; with `epochBase` null
    // (the default) a classified timestamp is kept as it stands — AFTER the free-form redaction
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
    // VERBATIM BY KEY NAME — and this is a KNOWN HOLE, not a design.
    //
    // `VOCABULARY_KEYS` describes a POSITION in the contract; this walker only knows
    // names, so any value landing under one of these 28 names is published wherever it
    // sits. A value-SHAPE guard was tried on 2026-09-12 and REVERTED the same night: it
    // was simultaneously too permissive (`Alice`, `PATIENT-12345`, `sk-proj-AbCd1234`,
    // `6145551234` all pass a token pattern) and too strict — it silently masked
    // `image/svg+xml` and `ollama/llama3.1:8b`, which are legitimate values the bridge
    // reads (`convex-writer.ts` treats svg explicitly), and NOTHING detects that: the
    // replay-fidelity check does not describe `reportSessionMeta`/`addMedia` arguments.
    // Shipping it would have traded a known hole for a silent corpus regression.
    //
    // The sound fix is position-aware — validate against the vendored schema rather than
    // a name set — and that is a lot of its own, filed with the rest of the anonymiser
    // findings. What IS fixed here is the structural inversion below: an object under a
    // known key is free-form unless its shape is declared.
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
