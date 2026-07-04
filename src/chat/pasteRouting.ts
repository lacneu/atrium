// Large-paste routing for the composer (pure, testable).
//
// A user pasting a big log/document into the composer used to inline it into
// the prompt — a single paste could blow the agent's context window before
// compaction had any chance to run (observed live 2026-07-04: a pasted config
// log overflowed a 272k-token session). The industry answer (Claude Code's
// "[Pasted text #N +X lines]", VS Code's "paste as file") is to convert the
// paste into a FILE attachment the agent receives by reference — the prompt
// stays light, the full content still reaches the agent through the existing
// attachment pipeline (which already enforces the gateway-derived size caps).
//
// The threshold is deliberately conservative in CHARACTERS (≈ 4 chars/token):
// 8 000 chars ≈ 2 000 tokens — small enough that a routed paste never hurts,
// large enough that ordinary snippets (a stack trace, a paragraph, a command
// output) keep flowing inline with zero friction.

export const LARGE_PASTE_CHARS = 8_000;
export const LARGE_PASTE_LINES = 150;

export interface PasteRoute {
  kind: "inline" | "file";
  /** Set for kind:"file" — the suggested attachment filename. */
  filename?: string;
  lines: number;
  chars: number;
}

/** Decide how a pasted text should enter the composer. `seq` numbers the
 *  generated filename within the current message (colle-1, colle-2…). */
export function routePaste(text: string, seq: number): PasteRoute {
  const chars = text.length;
  // Count lines without splitting (a multi-MB paste must not allocate an array).
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  if (chars <= LARGE_PASTE_CHARS && lines <= LARGE_PASTE_LINES) {
    return { kind: "inline", lines, chars };
  }
  return {
    kind: "file",
    filename: `texte-colle-${seq}.txt`,
    lines,
    chars,
  };
}

// Marks the File objects this module generated from a large paste, so the
// attachment adapter can stamp their origin ("pasted") through the send
// pipeline into the files table — Settings › Files hides auto-generated
// files by default. A WeakSet (not a filename convention): a user's OWN file
// named texte-colle-1.txt must never be misclassified.
const pastedFiles = new WeakSet<File>();

export function markPastedFile(file: File): void {
  pastedFiles.add(file);
}

export function isPastedFile(file: File): boolean {
  return pastedFiles.has(file);
}
