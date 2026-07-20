// Metadata-only projection of a lossless-claw plugin reply.
//
// The raw doctor/status reply can embed lane or session excerpts — text
// DERIVED FROM CONVERSATIONS. The surface this feeds (/api/v1/lossless →
// MCP lossless_doctor) is metadata-only by contract: an `agent` role key
// holds `selfheal` WITHOUT any chat-content read permission (codex P1).
// So the raw text never leaves the bridge — only counters and flags do.
// A human wanting the full report runs /lossless in the gateway console.

export interface LosslessReplySummary {
  /** `<noun>: n` for plain "N <noun>" mentions (conversations, summaries, …). */
  counters: Record<string, number>;
  /** Lanes the doctor calls safe to repair. */
  safeLanes: number | null;
  /** Lanes flagged "needs review" — NEVER auto-repaired, escalate. */
  needsReviewLanes: number | null;
  /** Lanes a repair run reports as repaired. */
  repairedLanes: number | null;
  /** "needs review" appears anywhere (even without a count). */
  needsReview: boolean;
  /** Integrity verdict: true/false when stated, null when absent. */
  integrityOk: boolean | null;
  /** True only on AFFIRMATIVE evidence; any negation wins over it. */
  backupCreated: boolean;
  errorMentioned: boolean;
  replyChars: number;
}

const COUNTER_RE =
  /(\d[\d,]*)\s+(conversations?|summar(?:y|ies)|messages?|lanes?|splits?|sessions?|entries)\b/gi;
const SAFE_LANES_RE = /(\d[\d,]*)\s+safe(?:\s+lanes?)?\b/i;
const NEEDS_REVIEW_LANES_RE = /(\d[\d,]*)\s+(?:lanes?\s+)?needs?[\s-]review/i;
const REPAIRED_RE =
  /repaired\D{0,12}(\d[\d,]*)|(\d[\d,]*)\s+(?:lanes?\s+)?repaired/i;
const INTEGRITY_RE = /integrity(?:\s+\w+)?\W{0,3}\b(ok|passed|good|verified)\b/i;
// AFFIRMATIVE backup evidence only, with negation taking precedence — a bare
// keyword match would read "no backup was created" as backed-up (codex P2).
const BACKUP_NEGATED_RE =
  /\b(?:no|without|skipp\w*|failed\s+to|couldn'?t|could\s+not|cannot|unable\s+to)\s+(?:take\s+|create\s+|write\s+)?backups?\b|backups?\s+(?:failed|skipped|not\b)/i;
const BACKUP_AFFIRMED_RE =
  /backups?\s+(?:written|created|taken|saved|completed?|stored|ok\b|at\s|path)|\b(?:wrote|created|took|saved)\s+(?:a\s+|the\s+)?backup/i;

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function summarizeLosslessReply(reply: string): LosslessReplySummary {
  const counters: Record<string, number> = {};
  for (const m of reply.matchAll(COUNTER_RE)) {
    const n = num(m[1]);
    const noun = m[2];
    if (n === null || noun === undefined) continue;
    const key = noun.toLowerCase();
    counters[key] = (counters[key] ?? 0) + n;
  }
  const repaired = REPAIRED_RE.exec(reply);
  return {
    counters,
    safeLanes: num(SAFE_LANES_RE.exec(reply)?.[1]),
    needsReviewLanes: num(NEEDS_REVIEW_LANES_RE.exec(reply)?.[1]),
    repairedLanes: repaired ? num(repaired[1] ?? repaired[2]) : null,
    needsReview: /needs?[\s-]review/i.test(reply),
    integrityOk: INTEGRITY_RE.test(reply)
      ? true
      : /integrity/i.test(reply)
        ? false
        : null,
    backupCreated:
      !BACKUP_NEGATED_RE.test(reply) && BACKUP_AFFIRMED_RE.test(reply),
    errorMentioned: /\b(error|failed|failure)\b/i.test(reply),
    replyChars: reply.length,
  };
}
