// The outbound delivery instruction: tells the agent to emit MEDIA:<path> so a
// generated file becomes a downloadable attachment (the bridge hosts it). Without
// it, agents write a non-hostable markdown link to a local path.

import { describe, expect, it } from "vitest";
import { buildDeliveryInstruction } from "../src/core/outbound-delivery.js";

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
