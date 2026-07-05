// Pure helpers for agent-file CURATION (auto-management of over-budget agent
// files). No Convex, no bridge — every branch is unit-testable.
//
// The #1 risk is SILENT SEMANTIC data loss (an LLM rewrite that drops
// load-bearing facts while staying small). The real mitigation is
// propose-and-approve + the full before/after revision an admin diffs — NOT
// these guards. What these guards DO catch is GROSS failure: an empty rewrite,
// one that GREW the file, or a reply that is commentary/wrapper rather than the
// file content. Those must never reach even a proposal.

/** Per-file curation budget in CHARACTERS, mirroring OpenClaw's bootstrap
 *  per-file cap (bootstrapMaxChars default 20000). The admin can raise it per
 *  instance, but it is bounded (see instanceConfig) — quality over quantity. */
/** Agent files eligible for curation (RULES + memory/user files that grow).
 *  Pure list so both the server action and the admin UI gate on the SAME set. */
export const CURATABLE_FILES = [
  "MEMORY.md",
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "USER.md",
] as const;

export const CURATION_DEFAULT_BUDGET_CHARS = 20_000;
export const CURATION_BUDGET_MIN = 4_000;
export const CURATION_BUDGET_MAX = 60_000;
// The bridge's hard write cap (MAX_AGENT_FILE_CHARS in agentFiles.ts). A proposal
// ABOVE this can never be applied (the bridge set refuses it), so it is rejected
// at validation rather than surfaced as a reviewable-but-unappliable proposal.
export const CURATION_MAX_WRITE_CHARS = 64_000;

/** A file is a curation CANDIDATE when it uses >= this fraction of its budget. */
export const CURATION_TRIGGER_PCT = 90;

/** A file too large for a single-pass rewrite to safely fit in one turn: the
 *  reply itself would risk overflowing. Above this we FLAG rather than attempt a
 *  one-shot rewrite that silently truncates (advisor: detect, don't truncate).
 *  ~4x the max budget leaves ample headroom for the rewrite turn. */
export const CURATION_ONE_SHOT_MAX_SOURCE_CHARS = CURATION_BUDGET_MAX * 4;

/** True when `size` bytes is at/over the trigger threshold for `budget`. */
export function isCurationCandidate(size: number, budget: number): boolean {
  if (budget <= 0 || size <= 0) return false;
  return (size / budget) * 100 >= CURATION_TRIGGER_PCT;
}

/**
 * Extract the curated FILE CONTENT from a specialist's free-form reply.
 *
 * The reply is untrusted: it may wrap the content in a ```` ```markdown ```` /
 * ```` ``` ```` fence, prepend "Voici le fichier :", append commentary, or (LLM
 * muscle memory) emit a `MEDIA:` delivery line. Writing any of that verbatim
 * would corrupt the file. Returns the cleaned content, or `null` when the reply
 * does not look like file content at all (caller fails the job — never writes).
 */
export function extractCuratedContent(reply: string): string | null {
  if (typeof reply !== "string") return null;
  let text = reply.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) return null;

  // A MEDIA: delivery line anywhere is a hard reject — the specialist tried to
  // deliver a file instead of returning content (would corrupt on write).
  if (/^\s*MEDIA:\s*\S/im.test(text)) return null;

  // Strip an OUTER WRAPPER fence only: the LLM habit of returning the whole file
  // inside ```markdown … ```. Detected structurally — line 1 is a bare/lang fence
  // and the LAST line is a closing fence. INTERNAL fences (a rules file like
  // AGENTS.md with code examples — explicitly in the allowlist) are LEFT INTACT
  // (codex P2: never reject valid markdown for containing a code block). The
  // preamble + MEDIA: checks + the admin review remain the write-back defense.
  const lines = text.split("\n");
  if (
    lines.length >= 2 &&
    /^```[a-zA-Z0-9_-]*$/.test(lines[0].trim()) &&
    lines[lines.length - 1].trim() === "```"
  ) {
    text = lines.slice(1, -1).join("\n").trim();
    if (text.length === 0) return null;
  }

  // Reject an obvious conversational preamble as the FIRST line ("Voici …",
  // "Here is …", "Sure, …") — content files do not open that way, and a wrapper
  // sentence bolted onto the real body would be written verbatim.
  const firstLine = text.split("\n", 1)[0] ?? "";
  if (
    /^(?:voici|here (?:is|are)|here'?s|sure|bien s[ûu]r|d'?accord|certainly|okay|ok)(?:[\s,!.:]|$)/i.test(
      firstLine.trim(),
    )
  ) {
    return null;
  }
  return text;
}

export interface CurationValidation {
  ok: boolean;
  reason?: string;
}

/**
 * GROSS-failure gate on a proposed rewrite (the fine-grained "did it keep the
 * relevant facts" judgment is the ADMIN's, via the before/after diff). Rejects:
 * empty, grew vs the source, or shrank so hard (< 5% of the source) that it is
 * almost certainly a truncation/refusal rather than a rationalization.
 */
export function validateCuration(
  before: string,
  proposed: string,
  budgetChars: number,
): CurationValidation {
  const after = proposed.trim();
  if (after.length === 0) return { ok: false, reason: "empty" };
  if (after.length >= before.length) return { ok: false, reason: "not_smaller" };
  // A rationalization that keeps quality is rarely < 5% of the source — that is
  // a refusal/truncation, not curation. (Necessary, not sufficient — the admin
  // review is the real check.)
  if (after.length < Math.max(1, before.length * 0.05)) {
    return { ok: false, reason: "suspiciously_short" };
  }
  // Above the bridge write cap -> unappliable; reject now (never a dead proposal).
  if (after.length > CURATION_MAX_WRITE_CHARS) {
    return { ok: false, reason: "exceeds_write_cap" };
  }
  // The whole point is to land UNDER budget. Allow a small margin for the
  // char/byte gap; if it is still over, the admin sees it (a partial win) but we
  // flag it so the UI can nudge a re-run.
  if (after.length > budgetChars) return { ok: true, reason: "over_budget" };
  return { ok: true };
}

/** Clamp a user-set budget into the sane band (instanceConfig also enforces). */
export function clampCurationBudget(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return CURATION_DEFAULT_BUDGET_CHARS;
  }
  return Math.min(CURATION_BUDGET_MAX, Math.max(CURATION_BUDGET_MIN, Math.round(n)));
}
