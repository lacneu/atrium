import { describe, expect, test } from "vitest";
import {
  canGovernPrefs,
  govDefaultPatch,
  govDefaultValue,
  govGateKey,
} from "./prefsGovernance";
import {
  UI_PREF_KEYS,
  UI_PREF_SYSTEM_GATE,
} from "../../convex/lib/uiPrefs";

// Pure logic behind the merged Preferences tab's governance mode (the former
// admin "Préférences UI" tab folded into the user panel).

describe("canGovernPrefs (governance-mode visibility)", () => {
  test("only the admin role may see the governance controls", () => {
    expect(canGovernPrefs("admin")).toBe(true);
    expect(canGovernPrefs("user")).toBe(false);
    expect(canGovernPrefs("pending")).toBe(false);
    expect(canGovernPrefs(undefined)).toBe(false); // getMe not loaded yet
  });
});

describe("govDefaultValue / govDefaultPatch (admin-default tri-state)", () => {
  test("maps the stored default to the select value", () => {
    expect(govDefaultValue(true)).toBe("on");
    expect(govDefaultValue(false)).toBe("off");
    expect(govDefaultValue(undefined)).toBe("inherit");
  });

  test("maps the select value back to the setUiPrefDefault patch", () => {
    expect(govDefaultPatch("on")).toBe(true);
    expect(govDefaultPatch("off")).toBe(false);
    expect(govDefaultPatch("inherit")).toBe(null);
  });

  test("round-trips through both directions", () => {
    for (const def of [true, false, undefined] as const) {
      expect(govDefaultPatch(govDefaultValue(def))).toBe(def ?? null);
    }
  });
});

describe("govGateKey (system-gate lockstep with the server registry)", () => {
  test("mirrors UI_PREF_SYSTEM_GATE for every real pref key", () => {
    for (const key of UI_PREF_KEYS) {
      expect(govGateKey(key)).toBe(UI_PREF_SYSTEM_GATE[key]);
    }
  });

  test("voiceInput is gated; an ungated or unknown key is not", () => {
    expect(govGateKey("voiceInput")).toBe("voiceInput");
    expect(govGateKey("showSource")).toBeUndefined();
    expect(govGateKey("not-a-pref")).toBeUndefined();
  });
});
