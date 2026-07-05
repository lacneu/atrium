import { describe, expect, test } from "vitest";
import {
  effectiveTemplate,
  fillTemplate,
  missingRequiredPlaceholders,
  PROMPT_INJECTIONS,
  resolveBridgeInjections,
  resolveInjection,
} from "./promptInjections";
import { parseInstanceConfig } from "./instanceConfig";
import { SUPPORTED_LOCALES } from "./locales";

describe("prompt injection registry + resolve", () => {
  test("resolveInjection: defaults ON with the registry default text", () => {
    const r = resolveInjection("media_delivery", undefined, "fr");
    expect(r.enabled).toBe(true);
    expect(r.template).toBe(PROMPT_INJECTIONS.media_delivery.defaultTemplate.fr);
  });

  test("resolveInjection: an admin can DISABLE (the load-bearing case)", () => {
    const r = resolveInjection("media_delivery", {
      media_delivery: { enabled: false },
    }, "fr");
    expect(r.enabled).toBe(false);
    // Even disabled, a template is still resolved (the UI shows it) — what matters is
    // that `enabled:false` reaches the consumer.
    expect(r.template.length).toBeGreaterThan(0);
  });

  test("resolveInjection: a custom non-empty template wins; empty falls back", () => {
    expect(
      resolveInjection("media_delivery", {
        media_delivery: { template: "MA CONSIGNE {outboundDir}" },
      }, "fr").template,
    ).toBe("MA CONSIGNE {outboundDir}");
    expect(
      resolveInjection("media_delivery", { media_delivery: { template: "" } }, "fr")
        .template,
    ).toBe(PROMPT_INJECTIONS.media_delivery.defaultTemplate.fr);
  });

  test("resolveBridgeInjections: only the BRIDGE-applied injections, resolved", () => {
    const out = resolveBridgeInjections(undefined, "fr");
    // media_delivery + inbound_files are bridge-applied; documentary_fetch is convex-applied.
    expect(Object.keys(out).sort()).toEqual(["inbound_files", "media_delivery"]);
    expect(out.documentary_fetch).toBeUndefined();
    expect(out.media_delivery.enabled).toBe(true);
  });

  test("resolveBridgeInjections: a stored DISABLE survives resolution to the wire shape", () => {
    // The #1 use case (turn an injection off) must reach the bridge as enabled:false.
    const out = resolveBridgeInjections({ media_delivery: { enabled: false } }, "fr");
    expect(out.media_delivery.enabled).toBe(false);
    expect(out.inbound_files.enabled).toBe(true); // others unaffected
  });

  test("effectiveTemplate: enabled → the template; disabled → the registry fallback", () => {
    // Enabled → exactly the (custom/default) text.
    expect(
      effectiveTemplate("media_delivery", { enabled: true, template: "X {outboundDir}" }, "fr"),
    ).toBe("X {outboundDir}");
    // Disabled ADD-ON → "" (nothing injected — what the agent actually gets).
    expect(
      effectiveTemplate("media_delivery", { enabled: false, template: "X" }, "fr"),
    ).toBe("");
    expect(
      effectiveTemplate("inbound_files", { enabled: false, template: "X" }, "fr"),
    ).toBe("");
    // Disabled documentary_fetch → the bare reference list (its disabledTemplate).
    expect(
      effectiveTemplate("documentary_fetch", { enabled: false, template: "X" }, "fr"),
    ).toBe("{references}");
  });

  test("fillTemplate: substitutes {name}, leaves unknown placeholders verbatim", () => {
    expect(fillTemplate("a {x} b {y}", { x: "1" })).toBe("a 1 b {y}");
  });

  test("missingRequiredPlaceholders: flags a custom template that dropped {outboundDir}", () => {
    expect(
      missingRequiredPlaceholders("media_delivery", "no placeholder here"),
    ).toEqual(["outboundDir"]);
    expect(
      missingRequiredPlaceholders("media_delivery", "ok {outboundDir}"),
    ).toEqual([]);
  });
});

describe("parseInstanceConfig — promptInjections", () => {
  test("accepts a disable-only override (the common case)", () => {
    const r = parseInstanceConfig({
      promptInjections: { media_delivery: { enabled: false } },
    });
    expect(r).not.toBe("invalid");
    expect((r as { promptInjections?: unknown }).promptInjections).toEqual({
      media_delivery: { enabled: false },
    });
  });

  test("accepts a custom template that keeps the required placeholder", () => {
    const r = parseInstanceConfig({
      promptInjections: {
        documentary_fetch: { template: "Donne {references}" },
      },
    });
    expect(r).not.toBe("invalid");
  });

  test("REJECTS an unknown injection key", () => {
    expect(
      parseInstanceConfig({ promptInjections: { not_a_real_key: { enabled: false } } }),
    ).toBe("invalid");
  });

  test("REJECTS a custom template that dropped a required placeholder", () => {
    expect(
      parseInstanceConfig({
        promptInjections: { media_delivery: { template: "no placeholder" } },
      }),
    ).toBe("invalid");
  });

  test("REJECTS an unknown field inside an override", () => {
    expect(
      parseInstanceConfig({
        promptInjections: { media_delivery: { enabled: true, bogus: 1 } },
      }),
    ).toBe("invalid");
  });

  test("drops an empty override (no enabled, no template) rather than persisting it", () => {
    const r = parseInstanceConfig({
      promptInjections: { media_delivery: {} },
    }) as { promptInjections?: unknown };
    expect(r).not.toBe("invalid");
    expect(r.promptInjections).toBeUndefined();
  });
});

describe("per-locale defaults (content language)", () => {
  test("every injection has a default (and any disabled fallback) for EVERY supported locale", () => {
    for (const key of Object.keys(PROMPT_INJECTIONS) as Array<
      keyof typeof PROMPT_INJECTIONS
    >) {
      const def = PROMPT_INJECTIONS[key];
      for (const locale of SUPPORTED_LOCALES) {
        expect(
          def.defaultTemplate[locale],
          `missing ${String(key)} default for "${locale}"`,
        ).toBeTruthy();
        // Every locale variant must keep the SAME required placeholders — a
        // translation that drops one silently breaks the feature in that language.
        expect(
          missingRequiredPlaceholders(key, def.defaultTemplate[locale]),
          `${String(key)} [${locale}] dropped a required placeholder`,
        ).toEqual([]);
        const dis = (def as { disabledTemplate?: Record<string, string> })
          .disabledTemplate;
        if (dis) {
          expect(
            dis[locale],
            `missing ${String(key)} disabledTemplate for "${locale}"`,
          ).toBeTruthy();
        }
      }
    }
  });

  test("resolveInjection picks the locale's default; the admin override wins regardless", () => {
    expect(resolveInjection("media_delivery", undefined, "en").template).toBe(
      PROMPT_INJECTIONS.media_delivery.defaultTemplate.en,
    );
    expect(
      resolveInjection("media_delivery", undefined, "en").template,
    ).toContain("[DELIVERY]");
    expect(
      resolveInjection(
        "media_delivery",
        { media_delivery: { template: "CUSTOM {outboundDir}" } },
        "en",
      ).template,
    ).toBe("CUSTOM {outboundDir}");
  });

  test("effectiveTemplate picks the locale's DISABLED fallback", () => {
    expect(
      effectiveTemplate(
        "history_summary",
        { enabled: false, template: "ignored" },
        "en",
      ),
    ).toContain("[EXISTING SUMMARY]");
  });
});
