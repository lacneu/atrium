/**
 * WHICH `sessions.patch` needs `operator.admin`.
 *
 * The rule is upstream's, mirrored here because the bridge has to pick a socket
 * before it sends: in trusted-proxy mode a person's socket carries no admin, and
 * getting this wrong is not a subtle degradation — the bench refused EVERY turn
 * with `FORBIDDEN: missing scope: operator.admin` when the once-per-connection
 * `verboseLevel` patch rode the person's socket.
 *
 * Reference: OpenClaw 2026.9.2, `src/shared/session-method-scopes-base.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS,
  SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS,
  sessionPatchNeedsAdmin,
} from "../src/providers/openclaw/session-patch-scope.js";
import { computeFreshSession } from "../src/server.js";

describe("the patches the bridge actually sends", () => {
  it("verboseLevel is ADMIN — the field every turn sets once per connection", () => {
    expect(sessionPatchNeedsAdmin({ key: "s", verboseLevel: "full" })).toBe(true);
  });

  it("thinkingLevel and fastMode are ADMIN", () => {
    expect(sessionPatchNeedsAdmin({ key: "s", thinkingLevel: "high" })).toBe(true);
    expect(sessionPatchNeedsAdmin({ key: "s", fastMode: false })).toBe(true);
  });

  it("model is WRITE — a person picking their own model keeps their own socket", () => {
    // If this flipped to admin, every model change would open an administrative
    // socket for a choice that belongs to the person making it.
    expect(sessionPatchNeedsAdmin({ key: "s", model: "openai/gpt-5.5" })).toBe(false);
  });

  it("a CLEAR is scoped like the SET of the same field", () => {
    expect(sessionPatchNeedsAdmin({ key: "s", thinkingLevel: null })).toBe(true);
    expect(sessionPatchNeedsAdmin({ key: "s", model: null })).toBe(false);
  });
});

describe("the rule itself", () => {
  it("envelope fields never raise the scope on their own", () => {
    expect(
      sessionPatchNeedsAdmin({
        key: "s",
        agentId: "a",
        expectedSessionId: "x",
        label: "hello",
      }),
    ).toBe(false);
  });

  it("permissionMode is a write field EXCEPT for the value 'full'", () => {
    // Upstream checks the value first; a set-membership test alone would let a
    // full-permission patch through on a write-scoped socket.
    expect(sessionPatchNeedsAdmin({ key: "s", permissionMode: "default" })).toBe(false);
    expect(sessionPatchNeedsAdmin({ key: "s", permissionMode: "full" })).toBe(true);
  });

  it("ONE unknown field is enough to require admin", () => {
    expect(sessionPatchNeedsAdmin({ key: "s", label: "ok", verboseLevel: "full" })).toBe(true);
  });

  it("an empty patch is write, not admin", () => {
    expect(sessionPatchNeedsAdmin({})).toBe(false);
  });

  it("every declared write field is genuinely write on its own", () => {
    for (const field of SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS) {
      const value = field === "permissionMode" ? "default" : "x";
      expect(sessionPatchNeedsAdmin({ key: "s", [field]: value }), field).toBe(false);
    }
    for (const field of SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS) {
      expect(sessionPatchNeedsAdmin({ [field]: "x" }), field).toBe(false);
    }
  });

  it("the write set is the exact list this bridge was built against", () => {
    // NOT a drift check against upstream: the rule lives in
    // `src/shared/session-method-scopes-base.ts`, which the protocol vendoring does
    // NOT copy (it vendors the request SCHEMA, not the scope policy), so nothing in
    // this repo can be compared to it automatically. What this pins is the list a
    // reader can diff BY HAND against that file when adopting a new gateway version
    // — and it fails loudly if someone edits the set here without saying so.
    expect([...SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS].sort()).toEqual([
      "archived",
      "boardFace",
      "category",
      "color",
      "icon",
      "label",
      "model",
      "permissionMode",
      "pinned",
      "unread",
    ]);
  });
});

describe("the ownership claim must not erase the evidence of a pruned session", () => {
  it("a session the claim CREATED is FRESH, so the thread is re-hydrated", () => {
    // The regression this pins: `sessions.create` persists a row. A claim sent
    // blindly re-creates a gateway session the daily/idle roll had pruned, and the
    // first clause below — "no session ⇒ re-hydrate" — then sees a brand-new empty
    // session and calls it warm. The user keeps their whole thread on screen while
    // the model answers with none of it.
    const asIfPruned = undefined;
    expect(computeFreshSession(asIfPruned, false, false)).toBe(true);
    // After the claim the describe returns a row that looks perfectly warm…
    const afterClaim = { systemSent: true };
    expect(computeFreshSession(afterClaim, false, false)).toBe(false);
    // …unless the claim itself says it created it.
    expect(computeFreshSession(afterClaim, false, false, true)).toBe(true);
  });

  it("adopting an existing session changes nothing", () => {
    // The claim probes first: on a warm session it reports `false` and the verdict
    // is exactly what it was before per-user identity existed.
    expect(computeFreshSession({ systemSent: true }, false, false, false)).toBe(false);
    expect(computeFreshSession({ systemSent: false }, false, false, false)).toBe(true);
    expect(computeFreshSession({ systemSent: true }, true, true, false)).toBe(true);
  });
});
