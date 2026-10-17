// NO VISIBLE DUPLICATE (Olivier's R4 decision, refonte-finale-conception.md 2026-10-16).
//
// The Control UI sometimes shows the same message or the same file twice; Atrium does not.
// Storage stays faithful — every transcript row and every file copy is kept as it is, never
// merged or deleted at write time — and the duplicate is withheld at DISPLAY only, by this
// pure function, computed on every read and without any effect on what is stored. Within
// one display group (a delegation chain, lib/delegationChain.ts; a bubble alone otherwise),
// walking the group in display order:
//   - `same_sha256_in_group`: a file whose bytes (sha256 of its copy) an earlier visible
//     file of the group already shows is withheld — the first row's stays;
//   - `repeated_text_in_group`: a row whose text, whitespace-normalized, repeats a row the
//     group already shows, and that brings no file of its own still shown, has its text
//     withheld (the sub-agent's delivered sentence repeated by the resume, say).
// A MIXED group — a bubble the rows composed beside file parts the live path attached
// (the turn after a rollback to `shadow`, final design §5) — follows the same rule: such a
// part is a file of its bubble, walked after the bubble's rows, and withheld when its bytes
// are already shown in the group (`storageId` names it).
// Each decision is named, and reported by `diagnose_chat` (transcriptProjection.ts
// `projectionReportInternal`): nothing is withheld silently.

export type DedupRule = "same_sha256_in_group" | "repeated_text_in_group";

export type DedupRow = {
  entryId: string;
  /** The row's text as rendered (its span of the bubble's text). */
  text: string;
  /** The row's files in block order; `sha256` only once copied. */
  files: ReadonlyArray<{ blockIndex: number; sha256?: string }>;
};

export type DedupBubble = {
  messageId: string;
  groupId: string;
  rows: readonly DedupRow[];
  /** File parts of the bubble no row derived (the live path's), after its rows. */
  parts?: ReadonlyArray<{ storageId: string; sha256?: string }>;
};

export type DedupDecision =
  | { messageId: string; entryId: string; rule: "same_sha256_in_group"; blockIndex: number }
  | { messageId: string; rule: "same_sha256_in_group"; storageId: string }
  | { messageId: string; entryId: string; rule: "repeated_text_in_group" };

/** Whitespace-normalized text (the comparison of the repeated-text rule). */
export function normalizeRowText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The display decisions over bubbles given in DISPLAY order (thread order, then each
 *  bubble's rows in its layout order). Pure. */
export function displayDecisions(bubbles: readonly DedupBubble[]): DedupDecision[] {
  const out: DedupDecision[] = [];
  const shas = new Map<string, Set<string>>();
  const texts = new Map<string, Set<string>>();
  for (const b of bubbles) {
    const groupShas = shas.get(b.groupId) ?? new Set<string>();
    const groupTexts = texts.get(b.groupId) ?? new Set<string>();
    shas.set(b.groupId, groupShas);
    texts.set(b.groupId, groupTexts);
    for (const r of b.rows) {
      let newFile = false;
      for (const f of r.files) {
        if (f.sha256 === undefined) {
          // Not copied yet (or never): no bytes to compare — shown as it stands.
          newFile = true;
          continue;
        }
        if (groupShas.has(f.sha256)) {
          out.push({ messageId: b.messageId, entryId: r.entryId, rule: "same_sha256_in_group", blockIndex: f.blockIndex });
        } else {
          groupShas.add(f.sha256);
          newFile = true;
        }
      }
      const text = normalizeRowText(r.text);
      if (text === "") continue;
      if (groupTexts.has(text) && !newFile) {
        out.push({ messageId: b.messageId, entryId: r.entryId, rule: "repeated_text_in_group" });
      } else {
        groupTexts.add(text);
      }
    }
    for (const p of b.parts ?? []) {
      if (p.sha256 === undefined) continue;
      if (groupShas.has(p.sha256)) {
        out.push({ messageId: b.messageId, rule: "same_sha256_in_group", storageId: p.storageId });
      } else {
        groupShas.add(p.sha256);
      }
    }
  }
  return out;
}
