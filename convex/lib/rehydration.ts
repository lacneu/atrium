import { BASE_LOCALE, type Locale } from "./locales";
// Hybrid rehydration — the PURE composition half (see docs/HYBRID_REHYDRATION.md).
//
// A fresh gateway session is re-grounded from Atrium's message store by prepending a
// bounded history block to the outgoing turn. This module owns HOW that block is
// composed: a rolling SUMMARY of the older conversation (maintained asynchronously by
// convex/chatSummaries.ts) + a VERBATIM tail of the most recent turns, all within a
// hard character budget. Pure + fully unit-tested; `internal.stream.rehydrationContext`
// feeds it data and `chatSummaries` reuses its sizing constants.
//
// Fallback ladder (the composer NEVER blocks and never degrades below the legacy
// verbatim behavior): no summary -> verbatim + honest omission marker; summary
// lagging -> summary + gap marker + verbatim; summary present + tail fits -> both.

/** Hard ceiling on the composed history, whatever the model window says. Without it a
 *  200k-token window re-ingests ~300k chars of raw history on EVERY cold start (daily
 *  session resets + every multi-agent switch) — the exact token-waste this feature
 *  removes. ~20k tokens at the 3-chars/token heuristic used across this module. */
export const HARD_MAX_HISTORY_CHARS = 60_000;

/** At most this share of the budget goes to the summary block — the verbatim tail
 *  (the agent's working context) always keeps the majority. */
export const SUMMARY_BUDGET_SHARE = 0.35;

/** Stored rolling-summary length cap (chars). Also sent to the summarizer prompt as
 *  {max_chars} so the model aims for it; clamped on store regardless. */
export const SUMMARY_MAX_CHARS = 6_000;

/** Minimum UNSUMMARIZED chars (beyond the kept-verbatim tail) before a summarize job
 *  dispatches — short chats never pay a summarization call. */
export const CHUNK_MIN_CHARS = 8_000;

/** Per-job chunk bound: one summarize turn ingests at most this many chars of new
 *  messages. A long backlog converges over several jobs (bounded work per job). */
export const CHUNK_MAX_CHARS = 24_000;

/** Fresh-tail bounds: the newest turns are NEVER summarized (they ride verbatim at
 *  rehydration — recent context is worth raw fidelity). SIZE-based with count
 *  guards: a conversation of FEW HUGE messages must still become summarizable
 *  (a fixed message count kept everything in the tail and starved the engine),
 *  while MANY tiny messages must not inflate the tail unboundedly. */
export const KEEP_RECENT_MIN_MESSAGES = 2;
export const KEEP_RECENT_MAX_MESSAGES = 12;
export const KEEP_RECENT_TARGET_CHARS = 12_000;

/** How many of the NEWEST usable turns (newest-first input) form the fresh tail:
 *  at least MIN, at most MAX, and a turn that would push the tail PAST the char
 *  target stays OUT (once MIN is met). The exclusion-before-add matters: a huge
 *  digest sitting among the newest turns must be summarizable, not locked into
 *  the tail by the message that crosses the budget (the gauge-stuck-at-0 report
 *  round 2: short conversations whose bulk is one giant message). */
export function freshTailCount(turnsDesc: readonly { text: string }[]): number {
  let chars = 0;
  let n = 0;
  for (const t of turnsDesc) {
    const len = t.text.trim().length;
    if (n >= KEEP_RECENT_MAX_MESSAGES) break;
    if (n >= KEEP_RECENT_MIN_MESSAGES && chars + len > KEEP_RECENT_TARGET_CHARS)
      break;
    chars += len;
    n++;
  }
  return n;
}

/** Summarize-failure backoff: base × 2^failures, capped. */
export const SUMMARY_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const SUMMARY_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

export function summaryBackoffMs(failureCount: number): number {
  const exp = Math.min(Math.max(failureCount, 0), 20); // 2^20 already >> cap
  return Math.min(SUMMARY_BACKOFF_BASE_MS * 2 ** exp, SUMMARY_BACKOFF_CAP_MS);
}

/** Clamp a stored summary to its cap at a whitespace boundary (never mid-word when a
 *  boundary exists in the last 10%), with an explicit truncation mark. */
export function clampSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SUMMARY_MAX_CHARS) return trimmed;
  const hard = trimmed.slice(0, SUMMARY_MAX_CHARS);
  const lastSpace = hard.lastIndexOf(" ");
  const cut = lastSpace > SUMMARY_MAX_CHARS * 0.9 ? hard.slice(0, lastSpace) : hard;
  return `${cut}…`;
}

/**
 * Chars per token, PRUDENTLY.
 *
 * This module used 3 — an optimistic figure that makes a composed block look
 * cheaper than it is, so a 60 000-char history "worth 20k tokens" could really
 * cost 30k and push the very prompt it was meant to ground into overflow. The
 * gateway's own planner is more careful: 2 chars/token on tool results, plus a
 * 1.2 safety margin (`preemptive-compaction.ts`, `compaction-planning.ts`).
 * Matching it means the budget under-promises instead of over-promising — the
 * only safe direction for a value that decides whether a turn fits.
 */
export const CHARS_PER_TOKEN = 2;
export const TOKEN_ESTIMATE_MARGIN = 1.2;

/** Tokens a text is CONSERVATIVELY worth (over-estimates on purpose). */
export function estimateTokens(chars: number): number {
  return Math.ceil((chars / CHARS_PER_TOKEN) * TOKEN_ESTIMATE_MARGIN);
}

/** Above this share of the window, rehydration is REFUSED outright: the session
 *  is already near its limit and the gateway holds the history anyway, so
 *  injecting more is the one action guaranteed to make things worse (G-10). */
export const REHYDRATION_MAX_FILL = 0.7;

/** The character budget for one rehydration block: half the context window
 *  converted with the PRUDENT ratio above, bounded by the hard ceiling. */
export function rehydrationBudgetChars(windowTokens: number): number {
  const windowBudget = Math.floor(windowTokens * 0.5) * CHARS_PER_TOKEN;
  return Math.max(2_000, Math.min(windowBudget, HARD_MAX_HISTORY_CHARS));
}

/**
 * Does the COMPOSED prompt still fit? (G-10)
 *
 * The old budget bounded the history block in CHARACTERS and nothing bounded the
 * whole — history + separator + the user's own text — against the LIVE window. A
 * long message on top of a full-budget history therefore composed a prompt the
 * session could not take.
 *
 * `windowTokens` must be the SMALLEST live window in play: on an agent switch the
 * turn may run on a model with a narrower context than the one that composed the
 * history, and sizing against the larger of the two is how the block overflows
 * the model that actually receives it.
 */
export function composedPromptFits(params: {
  historyChars: number;
  userChars: number;
  separatorChars: number;
  windowTokens: number;
}): boolean {
  if (!Number.isFinite(params.windowTokens) || params.windowTokens <= 0) {
    return true; // unknown window: never REFUSE on an absent measure (P6)
  }
  const total =
    params.historyChars + params.userChars + params.separatorChars;
  return estimateTokens(total) <= Math.floor(params.windowTokens * 0.5);
}

export interface RehydrationTurn {
  role: "user" | "assistant";
  /** Already trimmed, non-empty. */
  text: string;
  /** WHO wrote this user turn, in a group conversation only (lib/turnAuthors:
   *  already bounded and single-line). Absent on a solo chat, whose history then
   *  renders exactly as it always did. */
  author?: string;
  /** WHICH AGENT wrote this assistant turn, in a conversation several agents take
   *  part in only (already bounded and single-line — see agentHistoryLabels). Absent
   *  on a single-agent chat, whose history then renders exactly as it always did. */
  agent?: string;
  /** This assistant turn is the READER's own (the agent the block is composed for):
   *  its label says so, so the agent can tell its words from another agent's. */
  self?: boolean;
}

export interface RehydrationSummary {
  text: string;
  /** How many messages the summary covers (rendered in its intro line). */
  coveredCount: number;
}

export interface ComposeRehydrationInput {
  /** Content locale for the framing strings (header/labels). Optional so pure
   *  callers/tests default to the base locale. */
  locale?: Locale;
  /** Chronological (oldest -> newest) verbatim candidates: complete user/assistant
   *  text turns strictly before the current turn and AFTER the summary watermark. */
  turns: RehydrationTurn[];
  summary: RehydrationSummary | null;
  /** True when the bounded tail read may have MISSED messages between the summary
   *  coverage (or the chat start) and the oldest turn in `turns` — the composer
   *  renders the omission marker even if the budget walk kept everything it saw. */
  readWindowClipped: boolean;
  budgetChars: number;
  /** The READER's own label, when the block is composed for one agent of a
   *  conversation several agents take part in: the header then says so in one
   *  sentence. Absent = the header as it always was. */
  reader?: string;
  /** The block holds only the turns since the reader's last reply (the reader's
   *  session is warm and has the rest): its header says so. */
  since?: boolean;
}

export interface ComposedRehydration {
  history: string | null;
  turnCount: number;
  summaryUsed: boolean;
  summaryChars: number;
  /** An omission marker was rendered (budget cut and/or clipped read window). */
  omitted: boolean;
}

// Framing strings PER CONTENT LOCALE (the instance's content language — a
// French framing nudges an agent to answer in French even for an EN user, so
// the framing follows the same locale as the prompt injections). Keys pinned
// to SUPPORTED_LOCALES by the rehydration tests.
export const REHYDRATION_STRINGS: Record<
  Locale,
  {
    header: string;
    footer: string;
    gapWithSummary: string;
    gapNoSummary: string;
    summaryIntro: (coveredCount: number) => string;
    userLabel: string;
    assistantLabel: string;
    /** Marks the reader's own replies inside an agent label. */
    selfMarker: string;
    /** One sentence: several agents take part, and which one the reader is. */
    multiAgentReader: (name: string) => string;
    /** The header of a block holding only the turns since the reader's last reply. */
    sinceHeader: string;
    /** Closes a message cut to fit the budget: a fragment is never shown as whole. */
    truncatedMark: string;
    /** A CHAINED reply's prompt (composeChainedPrompt): the replies the agents
     *  addressed before this one already gave to the same message, and the turn
     *  handed to the reader. */
    chainIntro: string;
    chainOutro: string;
  }
> = {
  fr: {
    header:
      "[Reprise d’une conversation antérieure de ce même fil. Pour continuité, " +
      "voici l’historique des messages précédents de cette conversation :]",
    footer:
      "[Fin de l’historique. Le nouveau message de l’utilisateur suit ci-dessous.]",
    gapWithSummary: "[…messages intermédiaires omis…]",
    gapNoSummary: "[…début de la conversation plus ancien, omis…]",
    summaryIntro: (n) =>
      `[Résumé de la partie antérieure de la conversation (${n} messages) :]`,
    userLabel: "Utilisateur",
    assistantLabel: "Assistant",
    selfMarker: "vous",
    multiAgentReader: (name) =>
      `[Plusieurs agents participent à cette conversation et chaque réponse est ` +
      `signée de son auteur : vous êtes ${name}.]`,
    sinceHeader:
      "[Reprise de cette conversation : voici les messages échangés depuis votre " +
      "dernière réponse :]",
    truncatedMark: "[suite du message omise]",
    chainIntro:
      "[Ce message s’adresse à plusieurs agents, qui répondent chacun à leur tour. " +
      "Réponses déjà données, dans l’ordre :]",
    chainOutro: "[À vous de répondre au message ci-dessus.]",
  },
  en: {
    header:
      "[Resuming an earlier conversation in this same thread. For continuity, " +
      "here is the history of this conversation's previous messages:]",
    footer: "[End of history. The user's new message follows below.]",
    gapWithSummary: "[…intermediate messages omitted…]",
    gapNoSummary: "[…older beginning of the conversation omitted…]",
    summaryIntro: (n) =>
      `[Summary of the earlier part of the conversation (${n} messages):]`,
    userLabel: "User",
    assistantLabel: "Assistant",
    selfMarker: "you",
    multiAgentReader: (name) =>
      `[Several agents take part in this conversation and each reply is signed ` +
      `by its author: you are ${name}.]`,
    sinceHeader:
      "[Resuming this conversation: here are the messages exchanged since your " +
      "last reply:]",
    truncatedMark: "[rest of the message omitted]",
    chainIntro:
      "[This message is addressed to several agents, who answer in turn. " +
      "Replies already given, in order:]",
    chainOutro: "[Your turn: answer the message above.]",
  },
};

/** The label a history line opens with — the SAME for the rehydrated tail and the
 *  summarizer's transcript, so both attribute a group's turns identically. */
export function historyTurnLabel(
  locale: Locale,
  role: "user" | "assistant",
  author?: string | null,
  agent?: { name: string; self: boolean } | null,
): string {
  const t9n = REHYDRATION_STRINGS[locale];
  if (role !== "user") {
    if (!agent) return t9n.assistantLabel;
    return agent.self
      ? `${t9n.assistantLabel} (${agent.name}, ${t9n.selfMarker})`
      : `${t9n.assistantLabel} (${agent.name})`;
  }
  return author ? `${t9n.userLabel} (${author})` : t9n.userLabel;
}

/** An agent as the history names it: the {instance, id} pair. */
export interface HistoryAgentRef {
  instanceName: string;
  agentId: string;
}

export const historyAgentKey = (a: HistoryAgentRef): string =>
  `${a.instanceName.length}:${a.instanceName}/${a.agentId}`;

/**
 * WHICH AGENT each message of a thread is attributed to — the thread's own rule
 * (src/chat/perTurnAgent.ts resolveMessageAgents), server-side: a user turn by its
 * routing stamp; an assistant message by its own stamp, else the user turn it
 * answers; nothing stamped = the chat's primary. `messagesAsc` in LOGICAL order.
 * An assistant opening the window answers a turn that lies before it: the caller
 * passes that turn's stamp (`leadingTurnAgent`), else it falls back to the primary.
 */
export function attributeHistoryAgents<
  M extends {
    _id: string;
    role: string;
    routedInstanceName?: string;
    routedAgentId?: string;
  },
>(
  messagesAsc: readonly M[],
  primary: HistoryAgentRef | null,
  // The stamp of the user turn the window's LEADING replies answer, when the caller
  // looked it up (it lies before the window); null = none, those fall to the primary.
  leadingTurnAgent: HistoryAgentRef | null = null,
): Map<string, HistoryAgentRef | null> {
  const out = new Map<string, HistoryAgentRef | null>();
  let turnAgent: HistoryAgentRef | null = leadingTurnAgent;
  for (const m of messagesAsc) {
    const own =
      m.routedInstanceName && m.routedAgentId
        ? { instanceName: m.routedInstanceName, agentId: m.routedAgentId }
        : null;
    if (m.role === "user") {
      turnAgent = own;
      out.set(m._id, own ?? primary);
    } else if (m.role === "assistant") {
      out.set(m._id, own ?? turnAgent ?? primary);
    }
  }
  return out;
}

/**
 * One label per agent, from its display name — joined by its instance ONLY where two
 * of the labelled agents share a name, so a single-instance room reads by name alone
 * and two gateways' "Nova" can still be told apart. Names must already be safe to
 * embed in a history line (single-line, no framing characters, bounded).
 */
export function agentHistoryLabels(
  agents: ReadonlyArray<HistoryAgentRef & { name: string; instance: string }>,
): Map<string, string> {
  const byName = new Map<string, number>();
  for (const a of agents) {
    const n = a.name.toLocaleLowerCase();
    byName.set(n, (byName.get(n) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const a of agents) {
    const shared = (byName.get(a.name.toLocaleLowerCase()) ?? 0) > 1;
    out.set(historyAgentKey(a), shared ? `${a.name} · ${a.instance}` : a.name);
  }
  return out;
}

/**
 * Compose the history block. Layout:
 *
 *   HEADER
 *   [Résumé … (N messages) :]        (when a summary exists)
 *   <summary text>
 *   […omission marker…]              (when older/verbatim-cut content is missing)
 *   Utilisateur : … / Assistant : …  (verbatim tail, chronological)
 *   FOOTER
 *
 * The verbatim tail is budget-walked NEWEST-first (the most recent turns are the
 * most valuable), then rendered chronologically — the legacy behavior, unchanged.
 * The newest turn is always kept even if alone it exceeds the budget (legacy rule:
 * the walk only breaks once at least one line is kept).
 */
export function composeRehydration(
  input: ComposeRehydrationInput,
): ComposedRehydration {
  const locale = input.locale ?? BASE_LOCALE;
  const t9n = REHYDRATION_STRINGS[locale];
  const summaryText = input.summary?.text.trim() ?? "";
  const empty: ComposedRehydration = {
    history: null,
    turnCount: 0,
    summaryUsed: false,
    summaryChars: 0,
    omitted: false,
  };
  // THE BUDGET IS THE WHOLE BLOCK. The bridge refuses a block longer than the room it
  // asked for (server.ts, the narrow-window re-ask), so a block over budget is no
  // history at all: the framing — header, reader line, summary intro, the omission
  // marker (reserved whether or not it is needed), footer, and the line breaks
  // between them — is paid out of the budget BEFORE any message is chosen.
  const head = [input.since === true ? t9n.sinceHeader : t9n.header];
  if (input.reader) head.push(t9n.multiAgentReader(input.reader));
  const framingChars = (parts: readonly string[]) =>
    parts.reduce((n, p) => n + p.length + 1, 0); // each part and the break after it
  const gapFor = (withSummary: boolean) =>
    withSummary || input.since === true ? t9n.gapWithSummary : t9n.gapNoSummary;

  // Summary block (bounded share of the budget) — dropped when the framing leaves no
  // room for it and a line of history.
  let summaryBlock = "";
  let summaryIntro = "";
  if (summaryText.length > 0) {
    const summaryCap = Math.floor(input.budgetChars * SUMMARY_BUDGET_SHARE);
    summaryBlock =
      summaryText.length > summaryCap
        ? `${summaryText.slice(0, Math.max(summaryCap - 1, 0))}…`
        : summaryText;
    summaryIntro = t9n.summaryIntro(input.summary!.coveredCount);
  }
  const verbatimRoom = (withSummary: boolean) =>
    input.budgetChars -
    framingChars([
      ...head,
      ...(withSummary ? [summaryIntro, summaryBlock] : []),
      gapFor(withSummary),
    ]) -
    t9n.footer.length;
  let hasSummary = summaryBlock.length > 0 && verbatimRoom(true) >= 0;
  if (!hasSummary) {
    summaryBlock = "";
    summaryIntro = "";
  }
  const verbatimBudget = verbatimRoom(hasSummary);
  if (verbatimBudget < 0) return empty;

  // Newest first; each kept line costs its length and the break after it.
  const keptDesc: string[] = [];
  let chars = 0;
  let truncated = false;
  for (let i = input.turns.length - 1; i >= 0; i--) {
    const t = input.turns[i]!;
    const label = historyTurnLabel(
      locale,
      t.role,
      t.author,
      t.agent ? { name: t.agent, self: t.self === true } : null,
    );
    let line = `${label} : ${t.text}`;
    if (chars + line.length + 1 > verbatimBudget) {
      truncated = true;
      if (keptDesc.length > 0) break;
      // The NEWEST turn alone is over the room: cut, and SAID to be cut — a fragment
      // is never presented as a complete message.
      const cutTo = verbatimBudget - 1 - (t9n.truncatedMark.length + 2);
      if (cutTo <= label.length + 3) break; // not even its label fits: omitted
      line = `${line.slice(0, cutTo)}… ${t9n.truncatedMark}`;
    }
    keptDesc.push(line);
    chars += line.length + 1;
  }
  const lines = keptDesc.reverse();

  if (lines.length === 0 && !hasSummary) return empty;

  const omitted = truncated || input.readWindowClipped;
  const parts: string[] = [...head];
  if (hasSummary) {
    parts.push(summaryIntro);
    parts.push(summaryBlock);
  }
  // A since-block starts at the reader's own last reply, not at the conversation's
  // beginning: what a budget cut drops there is "intermediate", never "older".
  if (omitted) parts.push(gapFor(hasSummary));
  if (lines.length > 0) parts.push(lines.join("\n"));
  parts.push(t9n.footer);
  const history = parts.join("\n");
  // The contract, checked where it is produced: never a block over budget. Built to
  // hold by the reservation above; should it ever not, no history beats a refused one.
  if (history.length > input.budgetChars) return empty;

  return {
    history,
    turnCount: lines.length,
    summaryUsed: hasSummary,
    summaryChars: summaryBlock.length,
    omitted,
  };
}

/** Ceiling on the earlier replies a chained prompt carries (half the history's). */
export const CHAIN_REPLIES_MAX_CHARS = Math.floor(HARD_MAX_HISTORY_CHARS / 2);

/**
 * The prompt of a CHAINED reply — the 2nd..Nth agent a message is addressed to.
 *
 * The question comes first, ONCE, then the replies the earlier agents already gave
 * to it, in order and signed. Carried here rather than by the rehydrated history:
 * the history holds what came strictly BEFORE the question (stream.rehydrationContext
 * excludes the question and everything after it), so the question is never handed
 * twice, and the earlier replies reach the agent whether or not its session is
 * re-hydrated at all (a warm session, a turn carrying a file). No earlier reply with
 * text (the first agent failed) = the bare question: the chain goes on regardless.
 */
export function composeChainedPrompt(
  question: string,
  earlier: ReadonlyArray<{ agent: string; text: string }>,
  locale: Locale = BASE_LOCALE,
): string {
  const replies = earlier.filter((r) => r.text.trim().length > 0);
  if (replies.length === 0) return question;
  const t9n = REHYDRATION_STRINGS[locale];
  // The ceiling bounds the WHOLE block after the question — intro, signed lines,
  // outro and the breaks between them — and every reply keeps an equal share of what
  // the framing leaves: a long first answer must not push the second out of the
  // prompt altogether. A reply cut to its share SAYS it was cut.
  const room =
    CHAIN_REPLIES_MAX_CHARS - t9n.chainIntro.length - t9n.chainOutro.length - (replies.length + 1);
  const share = Math.floor(room / replies.length);
  const lines = replies.map((r) => {
    const text = r.text.trim();
    const label = `${historyTurnLabel(locale, "assistant", null, { name: r.agent, self: false })} : `;
    if (label.length + text.length <= share) return `${label}${text}`;
    const keep = Math.max(share - label.length - t9n.truncatedMark.length - 2, 0);
    return `${label}${text.slice(0, keep)}… ${t9n.truncatedMark}`;
  });
  return [question, "", t9n.chainIntro, ...lines, t9n.chainOutro].join("\n");
}

// ---------------------------------------------------------------------------
// Gateway session-key nonce (job-identity correlation).
//
// The bridge builds session keys via safeSessionPart() (bridge/src/providers/
// openclaw/session-keys.ts) which SANITIZES each segment — `summarize:<id>:<ts>`
// becomes `summarize-<id>-<ts>` inside the echoed turnSessionKey. The correlate
// must therefore match the SANITIZED form. This is a pinned MIRROR of that
// function; its test carries shared vectors so any drift breaks loudly.

const GATEWAY_SAFE_PART_RE = /[^A-Za-z0-9_.-]+/g;

/** Mirror of the bridge's safeSessionPart (see header comment). */
export function gatewaySafeSessionPart(value: string): string {
  const collapsed = value.trim().replace(GATEWAY_SAFE_PART_RE, "-");
  const cleaned = collapsed.replace(/^[-._]+/, "").replace(/[-._]+$/, "");
  return cleaned || "unknown";
}

/** The summarize job's identity as it appears as the FINAL segment of the echoed
 *  turnSessionKey (the rotated openclawChatId, sanitized). */
/** Deterministic session nonce for an agent-file CURATION job — mirrors
 *  summarizeSessionNonce so the bridge's echoed turnSessionKey settles the
 *  right job (a late reply of a cancelled job can never match). */
export function curationSessionNonce(
  curationId: string,
  createdAt: number,
): string {
  return gatewaySafeSessionPart(`curate:${curationId}:${createdAt}`);
}

export function summarizeSessionNonce(
  targetChatId: string,
  createdAt: number,
): string {
  return gatewaySafeSessionPart(`summarize:${targetChatId}:${createdAt}`);
}
