import { describe, expect, test } from "vitest";
import { dispatchErrorInfo } from "./dispatchErrorInfo";

describe("dispatchErrorInfo", () => {
  test("known code -> label + actionable hint (the fixable info)", () => {
    const info = dispatchErrorInfo("AGENT_NOT_FOUND");
    expect(info.label).toBe("Agent introuvable");
    expect(info.hint).toMatch(/OPENCLAW_AGENT_ID/); // names the exact knob to fix
  });

  test("UNROUTED maps to the Settings → Users fix", () => {
    expect(dispatchErrorInfo("UNROUTED").hint).toMatch(/Override instance|groupe/i);
  });

  test("unknown code degrades to the raw code as label (never blank)", () => {
    const info = dispatchErrorInfo("SOME_FUTURE_CODE");
    expect(info.label).toBe("SOME_FUTURE_CODE");
    expect(info.hint.length).toBeGreaterThan(0);
  });

  test("null/undefined -> the UNKNOWN entry, not a crash", () => {
    expect(dispatchErrorInfo(undefined).label).toBe("Cause inconnue");
    expect(dispatchErrorInfo(null).label).toBe("Cause inconnue");
  });
});
