/// <reference types="vite/client" />
//
// The strip is RECURSIVE on purpose. Removing only top-level keys let two things
// through that the manifest promises are absent.

import { describe, expect, test } from "vitest";
import { stripRowForExport } from "./lib/exportArchive";

describe("stripping a row for export", () => {
  test("removes an identifier nested at any depth", () => {
    // `subAgentReports.thread[].authorUserId` is the one that made this
    // recursive: an exchange with an administrator put their identifier in a
    // file while the manifest claimed no owner identities travel.
    const stripped = stripRowForExport({
      chatId: "c1",
      userId: "u-top",
      thread: [{ authorUserId: "u-admin", comment: "vu" }],
    });

    expect(JSON.stringify(stripped)).not.toContain("u-top");
    expect(JSON.stringify(stripped)).not.toContain("u-admin");
    expect(JSON.stringify(stripped)).toContain("vu");
  });

  test("removes a storage pointer at any depth, and reports it", () => {
    const seen: string[] = [];
    const stripped = stripRowForExport(
      { part: { nested: { storageId: "kg2-abc" } }, keep: 1 },
      { collect: (pointer) => seen.push(pointer) },
    );

    expect(JSON.stringify(stripped)).not.toContain("kg2-abc");
    expect(seen).toEqual(["kg2-abc"]);
    expect(stripped.keep).toBe(1);
  });

  test("drops named top-level fields only where they are named", () => {
    // A `drop` list is per-section; applying it at every depth would remove
    // fields that merely share a name with one.
    const stripped = stripRowForExport(
      { turnSessionKey: "sk", part: { turnSessionKey: "inner" } },
      { drop: ["turnSessionKey"] },
    );

    expect(stripped).not.toHaveProperty("turnSessionKey");
    expect((stripped.part as Record<string, unknown>).turnSessionKey).toBe(
      "inner",
    );
  });
});
