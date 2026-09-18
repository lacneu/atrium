/// <reference types="vite/client" />
//
// The credential id never leaves in a FILE.
//
// An export copies what is STORED, so one taken while the migration is still walking
// the tables writes the raw id permanently into an archive already handed to the
// reader — and masking on IMPORT cannot repair a file that is already out (codex).
// Asserted on the shared stripper every table's export goes through, so a new table
// inherits the rule instead of needing its own.

import { describe, expect, test } from "vitest";
import { stripRowForExport } from "./lib/exportArchive";

const RAW =
  'Auth profile "openai:olivier@lacneu.com" is temporarily unavailable for openai/x.';

describe("stripRowForExport — the three fields that carry a gateway sentence", () => {
  test("masks `error`, `errorMessage` and a snapshot's `messageError`", () => {
    const out = stripRowForExport({
      error: RAW,
      errorMessage: RAW,
      snapshot: { messageError: RAW },
      text: "une réponse",
    });
    expect(out.error).toBe('Auth profile "…');
    expect(out.errorMessage).toBe('Auth profile "…');
    expect((out.snapshot as { messageError?: string }).messageError).toBe(
      'Auth profile "…',
    );
    // …and nothing else is touched.
    expect(out.text).toBe("une réponse");
  });

  test("a sentence it does not recognize is exported verbatim", () => {
    const out = stripRowForExport({ error: "fetch failed" });
    expect(out.error).toBe("fetch failed");
  });
});
