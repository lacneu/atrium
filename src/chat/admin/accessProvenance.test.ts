/// <reference types="vite/client" />
//
// Frontend provenance mapping (Settings > Acces, P5). The backend
// (convex/introspect.test.ts) already pins that the introspection DATA carries
// each `via` shape; this pins that the UI maps EVERY shape to the right label.
// Live verification only ever rendered the "common"/"user" branches, so the
// group + owner branches -- and crucially the PARAMETERIZED message
// `m.access_via_group({ group })` -- would otherwise ship unexercised.

import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import { agentViaLabel, chartViaLabel } from "./accessProvenance";

describe("agentViaLabel", () => {
  test("a direct grant maps to the 'Direct' label", () => {
    expect(agentViaLabel("user")).toBe(m.access_via_direct());
  });

  test("a group grant interpolates the group name (parameterized message footgun)", () => {
    const label = agentViaLabel({ group: "Clinique A" });
    expect(label).toBe(m.access_via_group({ group: "Clinique A" }));
    // The whole point of the parameterized message: the group name must appear.
    expect(label).toContain("Clinique A");
    // And it must NOT collapse to the direct label (branch inversion guard).
    expect(label).not.toBe(agentViaLabel("user"));
  });
});

describe("chartViaLabel", () => {
  test("a common chart maps to the 'Commune' label", () => {
    expect(chartViaLabel("common")).toBe(m.access_chart_common());
  });

  test("an owned chart maps to the 'Perso' label", () => {
    expect(chartViaLabel("owner")).toBe(m.access_chart_owner());
  });

  test("a group chart interpolates the group name", () => {
    const label = chartViaLabel({ group: "Equipe B" });
    expect(label).toBe(m.access_via_group({ group: "Equipe B" }));
    expect(label).toContain("Equipe B");
  });

  test("the three chart branches are mutually distinct (no two collapse)", () => {
    const common = chartViaLabel("common");
    const owner = chartViaLabel("owner");
    const group = chartViaLabel({ group: "G" });
    expect(new Set([common, owner, group]).size).toBe(3);
  });
});
