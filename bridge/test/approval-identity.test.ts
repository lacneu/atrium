// AN APPROVAL'S IDENTITY IS ITS ID AND ITS GENERATION (lot « trames 1 », pass 6).
//
// The gateway may give an explicit approval id again once it has forgotten the old request
// (src/gateway/server-methods/exec-approval.ts:172, 292-299 at v2026.9.36); each request
// carries its creation time. One rule for every memory of a decided approval: a mark names
// an identity and blocks only that identity; what names no generation (a resolution, a run
// frame) is about the one announced and still waiting, else the only one known.
import { describe, expect, it } from "vitest";

import {
  ApprovalGenerations,
  ApprovalIdentitySet,
  approvalIdentity,
  readApprovalGeneration,
} from "../src/providers/openclaw/approval-identity.js";

describe("an approval's identity", () => {
  it("is the id AND the generation; an unknown generation is its own value, never a wildcard", () => {
    expect(approvalIdentity("ap", 100)).not.toBe(approvalIdentity("ap", 200));
    expect(approvalIdentity("ap", null)).not.toBe(approvalIdentity("ap", 100));
    expect(approvalIdentity("ap", undefined)).toBe(approvalIdentity("ap", null));
    const marks = new ApprovalIdentitySet(8);
    marks.add("ap", 100);
    expect(marks.has("ap", 100)).toBe(true);
    expect(marks.has("ap", 200), "a new generation is never blocked by the old one").toBe(false);
    expect(marks.has("ap", null)).toBe(false);
  });

  it("reads a generation only from a finite, non-negative number", () => {
    expect(readApprovalGeneration(1_793_658_291_732)).toBe(1_793_658_291_732);
    for (const bad of [undefined, null, "100", Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(readApprovalGeneration(bad)).toBeNull();
    }
  });

  it("forgets the oldest identity past its bound", () => {
    const marks = new ApprovalIdentitySet(2);
    marks.add("a", 1);
    marks.add("b", 1);
    marks.add("a", 1); // refreshed
    marks.add("c", 1);
    expect([marks.has("a", 1), marks.has("b", 1), marks.has("c", 1)]).toEqual([true, false, true]);
  });
});

describe("what names no generation is attached to the one announced", () => {
  it("the one still waiting, when exactly one is", () => {
    const g = new ApprovalGenerations(8);
    g.announce("ap", 100);
    expect(g.attach("ap")).toBe(100);
    g.resolve("ap", 100);
    g.announce("ap", 200);
    expect(g.attach("ap"), "A decided, B waiting under the same id: B").toBe(200);
  });

  it("else the only one known — a late repeat of its decision", () => {
    const g = new ApprovalGenerations(8);
    g.announce("ap", 100);
    g.resolve("ap", 100);
    expect(g.attach("ap")).toBe(100);
  });

  it("else none: nothing announced, or two waiting, or several known and none waiting", () => {
    const g = new ApprovalGenerations(8);
    expect(g.attach("ap")).toBeNull();
    g.announce("ap", 100);
    g.announce("ap", 200);
    expect(g.attach("ap")).toBeNull();
    g.resolve("ap", 100);
    g.resolve("ap", 200);
    expect(g.attach("ap")).toBeNull();
    // An unknown generation is never announced.
    g.announce("other", null);
    expect(g.attach("other")).toBeNull();
  });

  it("a generation seen resolved stays resolved when it is announced again (a stale list)", () => {
    const g = new ApprovalGenerations(8);
    g.announce("ap", 100);
    g.resolve("ap", 100);
    g.announce("ap", 100);
    g.announce("ap", 200);
    expect(g.attach("ap")).toBe(200);
  });
});
