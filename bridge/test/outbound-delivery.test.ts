// The outbound delivery instruction: tells the agent to emit MEDIA:<path> so a
// generated file becomes a downloadable attachment (the bridge hosts it). Without
// it, agents write a non-hostable markdown link to a local path.

import { describe, expect, it } from "vitest";
import {
  applyMediaDeliveryInjection,
  buildDeliveryInstruction,
} from "../src/core/outbound-delivery.js";

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
