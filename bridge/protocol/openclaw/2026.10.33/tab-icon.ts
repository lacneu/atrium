// VENDORED VERBATIM from openclaw/openclaw @ v2026.10.33 — packages/gateway-protocol/src/schema/tab-icon.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
export type AgentTabIconShape = "square" | "rounded" | "circle";
export type TabIconPreference =
  | "default"
  | "agent"
  | "agent:rounded"
  | "agent:circle"
  | `lobster:${string}`;

export function agentTabIconShape(value: TabIconPreference | undefined): AgentTabIconShape | null {
  if (value === "agent") {
    return "square";
  }
  if (value === "agent:rounded") {
    return "rounded";
  }
  if (value === "agent:circle") {
    return "circle";
  }
  return null;
}

export function normalizeTabIconPreference(value: unknown): TabIconPreference | undefined {
  if (
    value === "default" ||
    value === "agent" ||
    value === "agent:rounded" ||
    value === "agent:circle"
  ) {
    return value;
  }
  // The browser owns the catalog and local unlocks; the profile stores only a
  // bounded identifier, never SVG, image bytes, or an arbitrary URL.
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^lobster:[a-z][a-z0-9-]{0,47}$/.test(value)
  ) {
    return undefined;
  }
  return `lobster:${value.slice("lobster:".length)}`;
}
