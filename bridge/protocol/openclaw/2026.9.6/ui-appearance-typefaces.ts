// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.6 — packages/gateway-protocol/src/schema/ui-appearance-typefaces.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (No change vs upstream.)
// Wire-contract list of profile-storable typefaces. The Control UI derives
// its override normalization from this tuple so browser and profile values agree.
export const UI_APPEARANCE_TYPEFACE_VALUES = [
  "instrument-sans",
  "geist",
  "dm-sans",
  "ibm-plex-sans",
  "space-grotesk",
  "atkinson-hyperlegible",
  "fraunces",
  "lora",
  "jetbrains-mono",
  "system",
] as const;
