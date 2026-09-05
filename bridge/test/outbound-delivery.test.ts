// The outbound delivery instruction: tells the agent to emit MEDIA:<path> so a
// generated file becomes a downloadable attachment (the bridge hosts it). Without
// it, agents write a non-hostable markdown link to a local path.

import { describe, expect, it } from "vitest";
import {
  applyMediaDeliveryInjection,
  buildDeliveryInstruction,
} from "../src/core/outbound-delivery.js";
import { COMPAT_MANIFEST, mediaDeliveryPoisonReason } from "../src/compat.js";

describe("buildDeliveryInstruction", () => {
  it("names the outbound dir and the exact MEDIA: convention", () => {
    const out = buildDeliveryInstruction("/home/node/.openclaw/media/outbound");
    expect(out).toContain("[LIVRAISON]");
    expect(out).toContain("/home/node/.openclaw/media/outbound/");
    expect(out).toContain("MEDIA:<chemin absolu du fichier>");
    // It steers the agent AWAY from the broken markdown-link-to-local-path habit.
    expect(out).toMatch(/lien markdown/i);
  });

  it("trims a trailing slash on the dir (no double slash)", () => {
    const out = buildDeliveryInstruction("/out/");
    expect(out).toContain("/out/");
    expect(out).not.toContain("/out//");
  });
});

describe("a gateway that a delivered file POISONS is never asked to deliver one", () => {
  // The instruction Atrium injects on every message is what talks the agent into
  // writing a file and emitting `MEDIA:`. On a stock 2026.8.1/8.2 that move poisons the
  // session for good (upstream #135747), so the ask is withheld — the one action the
  // known-broken list can take without guessing at capabilities (codex, three passes).
  it("names the reason for a version known to poison, and only for those", () => {
    expect(mediaDeliveryPoisonReason("openclaw", "2026.8.1")).toMatch(/poisons the session/);
    expect(mediaDeliveryPoisonReason("openclaw", "2026.8.2")).toMatch(/poisons the session/);
    expect(mediaDeliveryPoisonReason("openclaw", "2026.9.1")).toBeNull();
    expect(mediaDeliveryPoisonReason("openclaw", "2026.7.1")).toBeNull();
    expect(mediaDeliveryPoisonReason("openclaw", null)).toBeNull();
    expect(mediaDeliveryPoisonReason("hermes", "2026.8.1")).toBeNull();
    // A RANGE, because the defect rides the pre-releases too: upstream's bot found
    // v2026.9.1-beta.1 still unguarded, and an exact list let it through (codex).
    expect(mediaDeliveryPoisonReason("openclaw", "2026.9.1-beta.1")).toMatch(/poisons/);
    expect(mediaDeliveryPoisonReason("openclaw", "2026.8.3")).toMatch(/poisons/);
    expect(mediaDeliveryPoisonReason("openclaw", "2026.8.1-beta.4")).toMatch(/poisons/);
    // …and it ENDS at the release that carries the fix.
    expect(mediaDeliveryPoisonReason("openclaw", "2026.9.2")).toBeNull();
    expect(mediaDeliveryPoisonReason("openclaw", "2026.8.0")).toBeNull();
  });

  it("every NAMED broken release falls inside the window it is named for", () => {
    // Two statements of the same fact drift. This pins them together: the badge list
    // and the runtime guard cannot disagree about which releases are affected.
    const named = Object.keys(
      COMPAT_MANIFEST.providers.openclaw?.knownBrokenVersions ?? {},
    );
    expect(named.length).toBeGreaterThan(0);
    for (const v of named) {
      expect(mediaDeliveryPoisonReason("openclaw", v), `${v} is named but not guarded`)
        .not.toBeNull();
    }
  });
});

describe("applyMediaDeliveryInjection (the configurable injection)", () => {
  const DIR = "/home/node/.openclaw/media/outbound";

  // THE load-bearing case: an admin disables the injection because their gateway already
  // instructs the agent. The outgoing message must carry NO delivery text at all.
  it("DISABLED → appends nothing (no [LIVRAISON], message unchanged)", () => {
    const out = applyMediaDeliveryInjection("Bonjour", DIR, {
      enabled: false,
      template: "ignored",
    });
    expect(out).toBe("Bonjour");
    expect(out).not.toContain("[LIVRAISON]");
    expect(out).not.toContain("MEDIA:");
  });

  // Pre-feature Convex sends no injection → the bridge keeps its own default behavior.
  it("ABSENT (undefined) → falls back to the bridge's own default instruction", () => {
    const out = applyMediaDeliveryInjection("Bonjour", DIR, undefined);
    expect(out).toContain("[LIVRAISON]");
    expect(out).toContain(`${DIR}/`);
    expect(out.startsWith("Bonjour")).toBe(true);
  });

  // Enabled with the resolved template Convex sent (default or custom) → spliced, with
  // `{outboundDir}` filled and the trailing slash trimmed.
  it("ENABLED → splices the resolved template with {outboundDir} filled", () => {
    const out = applyMediaDeliveryInjection("Bonjour", "/out/", {
      enabled: true,
      template: "[LIVRAISON]\nÉcris sous {outboundDir}/ puis MEDIA:<path>.",
    });
    expect(out).toContain("Écris sous /out/ puis MEDIA:<path>.");
    expect(out).not.toContain("{outboundDir}");
    expect(out).not.toContain("/out//");
  });

  // Robustness (codex P2): a malformed entry — enabled but no usable template (e.g. from
  // a partially-upgraded or manual caller) — must FALL BACK to the bridge default, never
  // silently suppress delivery. Only an explicit `enabled:false` suppresses.
  it("ENABLED but empty template → falls back to the default (does NOT suppress)", () => {
    const out = applyMediaDeliveryInjection("Bonjour", DIR, {
      enabled: true,
      template: "",
    });
    expect(out).toContain("[LIVRAISON]");
    expect(out).toContain(`${DIR}/`);
  });
});
