// VENDORED VERBATIM from openclaw/openclaw @ v2026.8.1 — packages/gateway-protocol/src/schema/plugin-declared-surface-groups.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
export const PLUGIN_DECLARED_SURFACE_GROUPS = [
  "channels",
  "providers",
  "tools",
  "contracts",
  "hooks",
  "mcpServers",
  "cliCommands",
  "cliBackends",
  "skills",
  "dangerousConfigFlags",
] as const;

export type PluginDeclaredSurfaceGroup = (typeof PLUGIN_DECLARED_SURFACE_GROUPS)[number];
