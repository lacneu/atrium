import { describe, expect, test } from "vitest";
import { roleDescription } from "./roleDescriptions";

describe("roleDescription", () => {
  test("built-in roles return a localized, non-empty description; observer ≠ agent", () => {
    const observer = roleDescription({
      key: "observer",
      builtin: true,
      description: null,
    });
    const agent = roleDescription({ key: "agent", builtin: true, description: null });
    expect(observer && observer.length > 0).toBeTruthy();
    expect(agent && agent.length > 0).toBeTruthy();
    // The whole point of the user's question: the two must read differently.
    expect(observer).not.toBe(agent);
    // The localized built-in copy WINS over any stale stored description.
    expect(
      roleDescription({ key: "observer", builtin: true, description: "stale" }),
    ).toBe(observer);
  });

  test("custom roles show their stored description verbatim (or null)", () => {
    expect(
      roleDescription({ key: "billing", builtin: false, description: "Facturation" }),
    ).toBe("Facturation");
    expect(
      roleDescription({ key: "empty", builtin: false, description: null }),
    ).toBeNull();
  });

  test("an unknown built-in key falls back to the stored description", () => {
    expect(
      roleDescription({ key: "future", builtin: true, description: "Stored fallback" }),
    ).toBe("Stored fallback");
    expect(
      roleDescription({ key: "future", builtin: true, description: null }),
    ).toBeNull();
  });
});
