/// <reference types="vite/client" />
//
// The Bridge config editor must persist ONLY the admin's explicit overrides — a
// bare "Save" must NOT materialize the displayed defaults as overrides (which would
// shadow an env-configured bridge's OWN mediaMode/cap/rehydration on every dispatch).

import { describe, expect, test } from "vitest";
import { buildConfigOverride, type ConfigForm } from "./bridgeConfigForm";
import { DEFAULT_INSTANCE_CONFIG } from "../../../convex/lib/instanceConfig";

const defaults: ConfigForm = { ...DEFAULT_INSTANCE_CONFIG };

describe("buildConfigOverride", () => {
  test("all-defaults form + nothing stored → {} (a bare Save shadows NOTHING)", () => {
    // The regression: returning the full form here would force gateway-http/1024/etc
    // as overrides, flipping an env-configured shared-fs/off bridge on the next send.
    expect(buildConfigOverride({ ...defaults }, {})).toEqual({});
  });

  test("only a field the admin CHANGED from the default is persisted", () => {
    expect(
      buildConfigOverride({ ...defaults, mediaMode: "shared-fs" }, {}),
    ).toEqual({ mediaMode: "shared-fs" });
  });

  test("a previously-stored override is PRESERVED even when left at the default value", () => {
    // outboundAgentMount equals the default here, but it was explicitly stored, so a
    // Save must keep it (not silently drop it back to inherit).
    const stored: Partial<ConfigForm> = {
      outboundAgentMount: DEFAULT_INSTANCE_CONFIG.outboundAgentMount,
    };
    expect(buildConfigOverride({ ...defaults }, stored)).toEqual({
      outboundAgentMount: DEFAULT_INSTANCE_CONFIG.outboundAgentMount,
    });
  });

  test("a non-default cap + a non-default mode are both persisted", () => {
    expect(
      buildConfigOverride(
        { ...defaults, mediaMode: "off", mediaMaxMb: 200 },
        {},
      ),
    ).toEqual({ mediaMode: "off", mediaMaxMb: 200 });
  });

  test("rehydration=false (≠ default true) is persisted; true is omitted", () => {
    expect(buildConfigOverride({ ...defaults, rehydration: false }, {})).toEqual({
      rehydration: false,
    });
    expect(buildConfigOverride({ ...defaults, rehydration: true }, {})).toEqual({});
  });
});
