import { m } from "@/paraglide/messages.js";

// Provenance label mapping for the introspection screen (Settings > Acces, P5).
//
// Extracted from AccessTab as PURE functions so every `via` branch -- including
// the parameterized `m.access_via_group({ group })` message -- is unit-tested
// without a DOM/React render harness (the vitest env is edge-runtime, no jsdom).
// The backend (introspect.test.ts) already pins that the data carries each `via`
// shape; these helpers pin that the UI maps each shape to the right label.

/** How a user reaches an agent: a direct grant, inherited from a group, or
 *  "all" -- the user belongs to no group and so sees every discovered agent. */
export type AgentVia = "user" | "all" | { group: string };

/** How a user reaches a chart: an org-wide common chart, their own imported
 *  ("owner") chart, or one shared to a group they belong to. */
export type ChartVia = "common" | "owner" | { group: string };

export function agentViaLabel(via: AgentVia): string {
  if (via === "user") return m.access_via_direct();
  if (via === "all") return m.access_via_all();
  return m.access_via_group({ group: via.group });
}

export function chartViaLabel(via: ChartVia): string {
  return via === "common"
    ? m.access_chart_common()
    : via === "owner"
      ? m.access_chart_owner()
      : m.access_via_group({ group: via.group });
}
