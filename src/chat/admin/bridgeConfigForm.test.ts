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
  promptInjections: injectionsFromConfig(undefined, "fr"),
};

describe("formFromConfig", () => {
  test("nothing stored → every field shows its default (no undefined leaks)", () => {
    expect(formFromConfig({}, "fr")).toEqual(defaults);
  });

  test("a stored override is reflected verbatim, the rest stay default", () => {
    const form = formFromConfig({ mediaMode: "shared-fs", mediaMaxMb: 200 }, "fr");
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
    expect(buildConfigOverride(formFromConfig({}, "fr"), {}, "fr")).toEqual({});
  });

  test("injections: defaults-only Save persists NO injection overrides (no bloat)", () => {
    // Opening + saving an unconfigured instance must not freeze the default injection
    // texts as overrides — the registry default stays the source of truth.
    expect(
      buildConfigOverride(formFromConfig({}, "fr"), {}, "fr").promptInjections,
    ).toBeUndefined();
  });

  test("injections: DISABLING a togglable injection persists only {enabled:false}", () => {
    const form = formFromConfig({}, "fr");
    form.promptInjections.media_delivery.enabled = false;
    expect(buildConfigOverride(form, {}, "fr").promptInjections).toEqual({
      media_delivery: { enabled: false },
    });
  });

  test("injections: a CUSTOM template persists only {template}; default text does not", () => {
    const form = formFromConfig({}, "fr");
    form.promptInjections.documentary_fetch.template = "Donne {references} stp";
    const ov = buildConfigOverride(form, {}, "fr").promptInjections;
    expect(ov).toEqual({ documentary_fetch: { template: "Donne {references} stp" } });
    // Re-typing the exact default is NOT an override.
    form.promptInjections.documentary_fetch.template =
      PROMPT_INJECTIONS.documentary_fetch.defaultTemplate.fr;
    expect(
      buildConfigOverride(form, {}, "fr").promptInjections,
    ).toBeUndefined();
  });

  test("pasting ANOTHER locale's built-in default IS an override (active-locale compare)", () => {
    const form = formFromConfig({}, "fr");
    form.promptInjections.media_delivery.template =
      PROMPT_INJECTIONS.media_delivery.defaultTemplate.en;
    expect(
      buildConfigOverride(form, {}, "fr").promptInjections,
    ).toEqual({
      media_delivery: {
        template: PROMPT_INJECTIONS.media_delivery.defaultTemplate.en,
      },
    });
  });

  test("round-trip: a stored override survives load → Save", () => {
    const stored: Partial<ConfigForm> = { mediaMode: "shared-fs" };
    expect(buildConfigOverride(formFromConfig(stored, "fr"), stored, "fr")).toEqual(stored);
  });
});

describe("buildConfigOverride", () => {
  test("all-defaults form + nothing stored → {} (a bare Save shadows NOTHING)", () => {
    // The regression: returning the full form here would force gateway-http/1024/etc
    // as overrides, flipping an env-configured shared-fs/off bridge on the next send.
    expect(buildConfigOverride({ ...defaults }, {}, "fr")).toEqual({});
  });

  test("only a field the admin CHANGED from the default is persisted", () => {
    expect(
      buildConfigOverride({ ...defaults, mediaMode: "shared-fs" }, {}, "fr"),
    ).toEqual({ mediaMode: "shared-fs" });
  });

  test("a previously-stored override is PRESERVED even when left at the default value", () => {
    // outboundAgentMount equals the default here, but it was explicitly stored, so a
    // Save must keep it (not silently drop it back to inherit).
    const stored: Partial<ConfigForm> = {
      outboundAgentMount: DEFAULT_INSTANCE_CONFIG.outboundAgentMount,
    };
    expect(buildConfigOverride({ ...defaults }, stored, "fr")).toEqual({
      outboundAgentMount: DEFAULT_INSTANCE_CONFIG.outboundAgentMount,
    });
  });

  test("a non-default cap + a non-default mode are both persisted", () => {
    expect(
      buildConfigOverride(
        { ...defaults, mediaMode: "off", mediaMaxMb: 200 },
        {},
        "fr",
      ),
    ).toEqual({ mediaMode: "off", mediaMaxMb: 200 });
  });

  test("rehydration=false (≠ default true) is persisted; true is omitted", () => {
    expect(buildConfigOverride({ ...defaults, rehydration: false }, {}, "fr")).toEqual({
      rehydration: false,
    });
    expect(buildConfigOverride({ ...defaults, rehydration: true }, {}, "fr")).toEqual({});
  });
});

describe("cross-tab passthrough (shared instance.config blob)", () => {
  test("a Bridge-form save PRESERVES the summarize threshold owned by Défauts de chat", () => {
    const stored = {
      mediaMode: "shared-fs",
      summarizeThresholdChars: 12_000,
    } as unknown as Partial<ConfigForm>;
    const form = formFromConfig(stored, "fr");
    const out = buildConfigOverride(form, stored, "fr");
    expect(out.summarizeThresholdChars).toBe(12_000);
  });

  test("no threshold stored -> none resurrected", () => {
    const stored = { mediaMode: "shared-fs" } as Partial<ConfigForm>;
    const out = buildConfigOverride(formFromConfig(stored, "fr"), stored, "fr");
    expect("summarizeThresholdChars" in out).toBe(false);
  });

  test("a Bridge-form save PRESERVES the curation opt-in (boolean) + budget (number)", () => {
    const stored = {
      mediaMode: "shared-fs",
      curationEnabled: true,
      curationBudgetChars: 18_000,
    } as unknown as Partial<ConfigForm>;
    const out = buildConfigOverride(formFromConfig(stored, "fr"), stored, "fr");
    // Both types survive the rebuild (a boolean was previously dropped — only
    // numbers were carried through).
    expect(out.curationEnabled).toBe(true);
    expect(out.curationBudgetChars).toBe(18_000);
  });

  test("a save PRESERVES the contentLocale owned by the Injections tab selector", () => {
    const stored = {
      mediaMode: "shared-fs",
      contentLocale: "en",
    } as unknown as Partial<ConfigForm>;
    const out = buildConfigOverride(formFromConfig(stored, "en"), stored, "fr");
    expect(out.contentLocale).toBe("en");
  });

  test("no curation config stored -> none resurrected", () => {
    const stored = { mediaMode: "shared-fs" } as Partial<ConfigForm>;
    const out = buildConfigOverride(formFromConfig(stored, "fr"), stored, "fr");
    expect("curationEnabled" in out).toBe(false);
    expect("curationBudgetChars" in out).toBe(false);
  });
});
