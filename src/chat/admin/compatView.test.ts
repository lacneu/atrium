import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import {
  badgeStateFromVersion,
  hasProvider,
  targetBadgeLabel,
  targetBadgeState,
  unsupportedInstanceLabel,
  versionLabel,
} from "./compatView";

// Pure view helpers behind the Settings > Bridge compatibility section and the
// unsupported-tab banners — every branch (including the PARAMETERIZED banner
// message) pinned without a DOM harness (GC-P5 lesson).

/** A manifest shaped like the bridge's CompatManifest (stored verbatim). */
const MANIFEST = {
  providers: {
    openclaw: {
      supportedRange: { min: "2026.5.19", maxValidated: "2026.6.5" },
      validatedVersions: ["2026.5.19", "2026.6.1", "2026.6.5"],
      capabilities: { knobThinkingLevel: "2026.5.19" },
    },
    hermes: { supportedRange: null, validatedVersions: [], capabilities: {} },
  },
};

const MANIFEST_NO_HERMES = {
  providers: {
    openclaw: MANIFEST.providers.openclaw,
  },
};

const target = (
  gatewayVersion: string | null,
  versionBeyondValidated = false,
  provider = "openclaw",
) => ({ provider, gatewayVersion, versionBeyondValidated });

describe("targetBadgeState", () => {
  test("no detected gateway version -> unknown", () => {
    expect(targetBadgeState(target(null), MANIFEST)).toBe("unknown");
  });

  test("beyond the validated ceiling -> beyond (the nuance wins over the check)", () => {
    expect(targetBadgeState(target("2026.7.1", true), MANIFEST)).toBe("beyond");
  });

  test("within the support window -> supported", () => {
    expect(targetBadgeState(target("2026.6.5"), MANIFEST)).toBe("supported");
    expect(targetBadgeState(target("2026.5.19"), MANIFEST)).toBe("supported");
  });

  test("below the support window -> unknown (never an unbacked check)", () => {
    expect(targetBadgeState(target("2026.4.1"), MANIFEST)).toBe("unknown");
  });

  test("provider without a published range (hermes today) -> unknown", () => {
    expect(targetBadgeState(target("1.0.0", false, "hermes"), MANIFEST)).toBe(
      "unknown",
    );
  });

  test("legacy bridge (manifest null) -> unknown", () => {
    expect(targetBadgeState(target("2026.6.5"), null)).toBe("unknown");
  });
});

describe("badgeStateFromVersion (per-instance verdict from a RAW version)", () => {
  test("null version -> unknown", () => {
    expect(badgeStateFromVersion(null, "openclaw", MANIFEST)).toBe("unknown");
  });
  test("within [min, maxValidated] -> supported", () => {
    expect(badgeStateFromVersion("2026.6.5", "openclaw", MANIFEST)).toBe("supported");
    expect(badgeStateFromVersion("2026.5.19", "openclaw", MANIFEST)).toBe("supported");
  });
  test("above the validated ceiling -> beyond (computed from the range here)", () => {
    expect(badgeStateFromVersion("2026.7.1", "openclaw", MANIFEST)).toBe("beyond");
  });
  test("below the support window -> unknown", () => {
    expect(badgeStateFromVersion("2026.4.1", "openclaw", MANIFEST)).toBe("unknown");
  });
  test("legacy bridge (manifest null) -> unknown", () => {
    expect(badgeStateFromVersion("2026.6.5", "openclaw", null)).toBe("unknown");
  });
});

describe("targetBadgeLabel — every badge maps to a DISTINCT label", () => {
  test("all three branches", () => {
    expect(targetBadgeLabel("supported")).toBe(m.compat_badge_supported());
    expect(targetBadgeLabel("beyond")).toBe(m.compat_badge_beyond());
    expect(targetBadgeLabel("unknown")).toBe(m.compat_badge_unknown());
    expect(
      new Set([
        targetBadgeLabel("supported"),
        targetBadgeLabel("beyond"),
        targetBadgeLabel("unknown"),
      ]).size,
    ).toBe(3);
  });
});

describe("unsupportedInstanceLabel — BOTH banner branches", () => {
  test("known version interpolates it (parameterized message footgun)", () => {
    const label = unsupportedInstanceLabel("2026.5.19");
    expect(label).toBe(
      m.compat_unsupported_instance({ version: "2026.5.19" }),
    );
    // The whole point of the parameterized message: the version must appear.
    expect(label).toContain("2026.5.19");
    // Branch-inversion guard: it must not collapse to the unknown branch.
    expect(label).not.toBe(unsupportedInstanceLabel(null));
  });

  test("unknown version takes the dedicated branch", () => {
    expect(unsupportedInstanceLabel(null)).toBe(
      m.compat_unsupported_instance_unknown(),
    );
  });
});

describe("versionLabel", () => {
  test("a version renders verbatim; null degrades to the localized unknown", () => {
    expect(versionLabel("2026.6.5")).toBe("2026.6.5");
    expect(versionLabel(null)).toBe(m.compat_unknown());
  });
});

describe("hasProvider — drives the 'adapter coming' line, never dead UI", () => {
  test("present in the manifest (even with a null range) -> true", () => {
    expect(hasProvider(MANIFEST, "hermes")).toBe(true);
    expect(hasProvider(MANIFEST, "openclaw")).toBe(true);
  });

  test("absent from the manifest -> false", () => {
    expect(hasProvider(MANIFEST_NO_HERMES, "hermes")).toBe(false);
  });

  test("legacy bridge / malformed manifest -> false", () => {
    expect(hasProvider(null, "hermes")).toBe(false);
    expect(hasProvider(undefined, "hermes")).toBe(false);
    expect(hasProvider("nonsense", "hermes")).toBe(false);
    expect(hasProvider({ providers: 42 }, "hermes")).toBe(false);
    expect(hasProvider({}, "hermes")).toBe(false);
  });
});
