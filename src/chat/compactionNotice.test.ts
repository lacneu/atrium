/// <reference types="vite/client" />
//
// The compaction NOTICE's cause sentence (W2 / G-09).
//
// The copy used to imply a PRE-EMPTIVE compaction in every case — including the
// one where the window had already overflowed, which is a materially different
// situation for the reader. The gateway does tell us which it was
// (`session.operation` carries `reason`), but the event is broadcast
// `dropIfSlow`: silence means UNKNOWN, and inventing "pre-emptive" on silence is
// exactly the misstatement this fixes.

import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import { causeSentence } from "./CompactionNotice";

describe("causeSentence", () => {
  test("an OVERFLOW reads as a recovery, not a precaution", () => {
    expect(causeSentence("overflow")).toBe(m.compaction_cause_overflow());
    expect(causeSentence("overflow")).not.toBe(m.compaction_cause_threshold());
  });

  test("the threshold FAMILY all read as pre-emptive (one distinction, not four)", () => {
    for (const r of [
      "heap_threshold",
      "rss_threshold",
      "pre_compaction",
      "non_manual_trigger",
    ]) {
      expect(causeSentence(r), r).toBe(m.compaction_cause_threshold());
    }
  });

  test("a manual compaction says so", () => {
    expect(causeSentence("manual")).toBe(m.compaction_cause_manual());
  });

  test("a REFUSAL says the conversation is unchanged", () => {
    for (const r of [
      "already_active",
      "already_in_flight",
      "deferred_compaction_not_scheduled",
      "unsupported_harness_compaction",
    ]) {
      expect(causeSentence(r), r).toBe(m.compaction_cause_refused());
    }
  });

  test("UNKNOWN adds nothing — never a guessed cause", () => {
    // `other` is the bucket an unrecognized upstream reason falls into: we know
    // something was said, but not what. Claiming a cause here would be inventing.
    for (const r of [undefined, null, "", "other", "compact", "no transcript"]) {
      expect(causeSentence(r), String(r)).toBe("");
    }
  });
});
