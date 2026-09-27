// The send guard is only as good as the session it was read from: a mode read off
// ANOTHER session refuses a turn for nothing (the gateway compares it with the mode
// stored on the session the send lands on). Every condition under which this turn's
// session may not be the one described must omit it.
import { describe, expect, test } from "vitest";
import { expectedPermissionModeFor, withoutSessionAccess } from "./sessionAccess";

const base = {
  provider: "openclaw",
  chatKind: undefined,
  perTurnRouting: false,
  rebind: false,
  storedProviderSession: undefined,
  targetAgentId: "alice",
  sessionMeta: {
    permissionMode: "guarded",
    permissionModePending: false,
    availableModelsOwner: "alice",
  },
} as const;

describe("expectedPermissionModeFor", () => {
  test("the mode the reader was shown, on the session it was read from", () => {
    expect(expectedPermissionModeFor({ ...base })).toEqual({ mode: "guarded" });
  });

  test("`null` is a guard too: the session sets NO mode, and must still set none", () => {
    expect(
      expectedPermissionModeFor({
        ...base,
        sessionMeta: { ...base.sessionMeta, permissionMode: null },
      }),
    ).toEqual({ mode: null });
  });

  test("not reported, or outside the vocabulary: no guard", () => {
    expect(expectedPermissionModeFor({ ...base, sessionMeta: undefined })).toBeNull();
    expect(
      expectedPermissionModeFor({ ...base, sessionMeta: { availableModelsOwner: "alice" } }),
    ).toBeNull();
    expect(
      expectedPermissionModeFor({
        ...base,
        sessionMeta: { ...base.sessionMeta, permissionMode: "yolo" },
      }),
    ).toBeNull();
  });

  test("any doubt about WHICH session the meta describes omits the guard", () => {
    const cases: Array<[string, Parameters<typeof expectedPermissionModeFor>[0]]> = [
      ["hermes (no modes)", { ...base, provider: "hermes" }],
      ["a hidden job chat (rotates its session)", { ...base, chatKind: "documentary" }],
      ["per-turn routing (one session per agent)", { ...base, perTurnRouting: true }],
      ["a rebind (the new agent's session)", { ...base, rebind: true }],
      ["a stored provider id (can move under the meta)", { ...base, storedProviderSession: "legacy-uuid" }],
      ["described for another agent", { ...base, targetAgentId: "bob" }],
      ["a change being applied", { ...base, sessionMeta: { ...base.sessionMeta, permissionModePending: true } }],
    ];
    for (const [name, input] of cases) {
      expect(expectedPermissionModeFor(input), name).toBeNull();
    }
  });

  test("a roster owner the gateway does not scope (\"\") does not decide on its own", () => {
    expect(
      expectedPermissionModeFor({
        ...base,
        sessionMeta: { ...base.sessionMeta, availableModelsOwner: "" },
      }),
    ).toEqual({ mode: "guarded" });
  });
});

describe("withoutSessionAccess", () => {
  test("drops the five access facts, keeps everything else — the watermark included", () => {
    expect(
      withoutSessionAccess({
        model: "m",
        visibility: "draft",
        sharingRole: "owner",
        permissionMode: null,
        permissionModePending: false,
        sessionRoot: "/w",
        accessAt: 12,
      }),
    ).toEqual({ model: "m", accessAt: 12 });
  });
});
