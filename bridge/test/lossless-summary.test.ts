// summarizeLosslessReply — the metadata-only projection of a lossless-claw
// reply. MUST fail if raw reply text (conversation-derived lane/session
// excerpts) ever leaks into the summary, or if the watcher-facing flags stop
// reflecting the plugin's real report shapes (captured live 2026-07-20).
import { describe, expect, test } from "vitest";
import { summarizeLosslessReply } from "../src/core/lossless-summary.js";

describe("summarizeLosslessReply", () => {
  test("status report: counters + safe/needs-review lane split", () => {
    const s = summarizeLosslessReply(
      [
        "LCM status — 264 conversations tracked, 42 summaries stored.",
        "Rollover split memory detected: 4 safe lanes, 1 needs review.",
      ].join("\n"),
    );
    expect(s.counters.conversations).toBe(264);
    expect(s.counters.summaries).toBe(42);
    expect(s.safeLanes).toBe(4);
    expect(s.needsReviewLanes).toBe(1);
    expect(s.needsReview).toBe(true);
    expect(s.repairedLanes).toBeNull();
    expect(s.errorMentioned).toBe(false);
  });

  test("repair report: repaired count + backup + integrity verdict", () => {
    const s = summarizeLosslessReply(
      [
        "Doctor: repaired 4 lanes (950 messages recovered).",
        "Backup written before repair. Integrity check: ok.",
      ].join("\n"),
    );
    expect(s.repairedLanes).toBe(4);
    expect(s.counters.messages).toBe(950);
    expect(s.backupCreated).toBe(true);
    expect(s.integrityOk).toBe(true);
    expect(s.needsReview).toBe(false);
  });

  test("integrity mentioned WITHOUT an ok verdict reads as false, absent as null", () => {
    expect(
      summarizeLosslessReply("integrity check failed on lane 2").integrityOk,
    ).toBe(false);
    expect(summarizeLosslessReply("all quiet").integrityOk).toBeNull();
    expect(
      summarizeLosslessReply("integrity check failed").errorMentioned,
    ).toBe(true);
  });

  test("backupCreated needs AFFIRMATIVE evidence; negation wins", () => {
    for (const negated of [
      "no backup was created before the repair",
      "backup failed: disk full",
      "backup skipped (dry run)",
      "failed to write backup",
      "repair ran without backup",
    ]) {
      expect(summarizeLosslessReply(negated).backupCreated, negated).toBe(
        false,
      );
    }
    // A bare keyword mention is NOT evidence either.
    expect(summarizeLosslessReply("see backup docs").backupCreated).toBe(false);
    for (const affirmed of [
      "backup written to /data/lcm/backup-42.db",
      "took a backup, then repaired 2 lanes",
      "Backup created at 12:42.",
    ]) {
      expect(summarizeLosslessReply(affirmed).backupCreated, affirmed).toBe(
        true,
      );
    }
  });

  test("NEVER leaks reply text: conversation excerpts stay bridge-side", () => {
    const secret = "patient Dubois said the password is hunter2";
    const s = summarizeLosslessReply(
      `Lane 3 (needs review) head excerpt: "${secret}"\n2 lanes affected.`,
    );
    const serialized = JSON.stringify(s);
    for (const word of ["Dubois", "password", "hunter2", "excerpt"]) {
      expect(serialized).not.toContain(word);
    }
    // …while the metadata still lands.
    expect(s.needsReview).toBe(true);
    expect(s.counters.lanes).toBe(2);
    expect(s.replyChars).toBeGreaterThan(0);
  });
});
