/// <reference types="vitest" />
//
// The transport's TERMINAL vocabulary must stay equal to the reader's (lot 33).
//
// `ws-client.ts` needs to know which events end a turn: only for those does an unreadable
// payload get turned into an error for that session, instead of being reported and
// dropped. Its comment has said since lot 29 that the set is "taken from ws-turn.ts's own
// switch" — and a test did check it, against a THIRD hand-typed copy of the same three
// names. Two remembered copies of a derived fact are not a guard; they are two things to
// forget. Both went stale the moment `approval.request` stopped ending the turn, and a
// corrupt approval payload would have killed a turn the reader now continues.
//
// So DERIVE it, the same way lot 23 derived the known-field list from the vendored source
// rather than maintaining it by incident.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WS_TERMINAL_EVENTS } from "../src/providers/hermes/ws-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Every `case "<event>":` in ws-turn.ts whose body reaches `settle()` before the next
 *  case label. Deliberately literal: the point is to read what the reader DOES. */
function terminalCasesInReader(): string[] {
  const src = readFileSync(
    join(__dirname, "../src/providers/hermes/ws-turn.ts"),
    "utf8",
  );
  // Only the event switch — `settle()` is also called by the deadline, the abort and the
  // transport-lost paths, none of which are event cases.
  const caseRe = /case "([^"]+)":/g;
  const labels: { name: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(src)) !== null) {
    labels.push({ name: m[1] ?? "", at: m.index });
  }
  const terminal = new Set<string>();
  for (let i = 0; i < labels.length; i += 1) {
    const from = labels[i]?.at ?? 0;
    const to = labels[i + 1]?.at ?? src.length;
    // A fall-through case (`case "a": case "b": {`) has an empty body; its terminality is
    // decided by the block that follows, which the next label's slice covers.
    const name = labels[i]?.name;
    if (name && /\bsettle\(\)/.test(src.slice(from, to))) terminal.add(name);
  }
  return [...terminal].sort();
}

describe("the WS terminal vocabulary is DERIVED, not remembered", () => {
  it("equals exactly the reader's settling cases", () => {
    const derived = terminalCasesInReader();
    expect(derived.length, "the derivation found no case at all").toBeGreaterThan(0);
    expect([...WS_TERMINAL_EVENTS].sort()).toEqual(derived);
  });

  it("no longer contains approval.request — the reader keeps that turn alive", () => {
    // The anchor for THIS lot: an approval no longer ends the turn, so an unreadable
    // approval payload must not be promoted into a session error either.
    expect(WS_TERMINAL_EVENTS.has("approval.request")).toBe(false);
    expect(terminalCasesInReader()).not.toContain("approval.request");
  });
});
