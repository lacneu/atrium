/// <reference types="vite/client" />
//
// The Bridge config editor must persist ONLY the admin's explicit overrides — a
// bare "Save" must NOT materialize the displayed defaults as overrides (which would
// shadow an env-configured bridge's OWN mediaMode/cap/rehydration on every dispatch).

import { describe, expect, test } from "vitest";
import {
  buildConfigOverride,
  formFromConfig,
  injectionsFromConfig,
  type ConfigForm,
} from "./bridgeConfigForm";
import { DEFAULT_INSTANCE_CONFIG } from "../../../convex/lib/instanceConfig";
import { PROMPT_INJECTIONS } from "../../../convex/lib/promptInjections";

const defaults: ConfigForm = {
  ...DEFAULT_INSTANCE_CONFIG,
  promptInjections: injectionsFromConfig(undefined),
};

describe("formFromConfig", () => {
  test("nothing stored → every field shows its default (no undefined leaks)", () => {
    expect(formFromConfig({})).toEqual(defaults);
  });

  test("a stored override is reflected verbatim, the rest stay default", () => {
    const form = formFromConfig({ mediaMode: "shared-fs", mediaMaxMb: 200 });
    expect(form.mediaMode).toBe("shared-fs");
    expect(form.mediaMaxMb).toBe(200);
    // Untouched fields keep their defaults — not the other instance's values.
    expect(form.inboundMediaMode).toBe(DEFAULT_INSTANCE_CONFIG.inboundMediaMode);
    expect(form.rehydration).toBe(DEFAULT_INSTANCE_CONFIG.rehydration);
  });

  test("round-trip: load defaults then Save persists NOTHING (no shadowing)", () => {
    // The load-bearing invariant: opening the editor on an unconfigured instance and
    // hitting Save unchanged must not materialize the displayed defaults as overrides.
    // (If formFromConfig leaked `undefined` for unset fields, buildConfigOverride would
    // persist them — this round-trip is what catches that regression.)
    expect(buildConfigOverride(formFromConfig({}), {})).toEqual({});
  });

  test("injections: defaults-only Save persists NO injection overrides (no bloat)", () => {
    // Opening + saving an unconfigured instance must not freeze the default injection
    // texts as overrides — the registry default stays the source of truth.
    expect(
      buildConfigOverride(formFromConfig({}), {}).promptInjections,
    ).toBeUndefined();
  });

  test("injections: DISABLING a togglable injection persists only {enabled:false}", () => {
    const form = formFromConfig({});
    form.promptInjections.media_delivery.enabled = false;
    expect(buildConfigOverride(form, {}).promptInjections).toEqual({
      media_delivery: { enabled: false },
    });
  });

  test("injections: a CUSTOM template persists only {template}; default text does not", () => {
    const form = formFromConfig({});
    form.promptInjections.documentary_fetch.template = "Donne {references} stp";
    const ov = buildConfigOverride(form, {}).promptInjections;
    expect(ov).toEqual({ documentary_fetch: { template: "Donne {references} stp" } });
    // Re-typing the exact default is NOT an override.
    form.promptInjections.documentary_fetch.template =
      PROMPT_INJECTIONS.documentary_fetch.defaultTemplate;
    expect(
      buildConfigOverride(form, {}).promptInjections,
    ).toBeUndefined();
  });

  test("round-trip: a stored override survives load → Save", () => {
    const stored: Partial<ConfigForm> = { mediaMode: "shared-fs" };
    expect(buildConfigOverride(formFromConfig(stored), stored)).toEqual(stored);
  });
});

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
