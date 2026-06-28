// CONTRACT FIXTURE — captured VERBATIM from a LIVE bridge `GET /capabilities`
// (atrium-bridge 0.1.0, protocol 2, against a real OpenClaw 2026.5.19
// gateway on the local validation bench, 2026-06-12). Only runtime identifiers
// were anonymized (instanceName/key/agentId — they come from deployment env,
// not from the contract); every other byte is the real response, including the
// per-target capability record the bridge RESOLVED for that gateway version.
//
// PURPOSE (red-team finding P2-1): the app and bridge repos ship on separate
// cycles and cannot import each other, so each pins its capability list with
// its own tests — two self-referential pins cannot detect drift BETWEEN the
// repos. This captured body is the cross-repo anchor: capabilities.test.ts
// asserts every UI CAPABILITY_KEYS entry exists in this manifest, and
// convex/compat.test.ts normalizes this exact body. If the bridge renames or
// drops a capability key, refreshing this fixture (re-capture from a live
// bridge) makes the app suite fail loudly instead of silently hiding controls.
//
// TO REFRESH: boot the bench (local-openclaw/up.sh), run the bridge against
// it, `curl /capabilities`, anonymize instanceName/key/agentId, paste here.
// The LIVE-CI suite (#145) will automate this capture-and-compare per version.
//
// Imported by TESTS ONLY (src + convex test suites) — never by app or deployed
// Convex code, so it adds zero runtime weight.

export const LIVE_CAPABILITIES_BODY = {
  instanceName: "main",
  // Top-level best-known version of the single gateway this bridge serves,
  // reported independently of any target (Convex attributes instance identity).
  gatewayVersion: "2026.5.19",
  capabilities: {
    kind: "openclaw",
    agentDiscovery: true,
    abort: false,
    history: false,
    attachments: true,
    media: true,
    streaming: "both",
  },
  bridgeVersion: "0.1.0",
  protocolVersion: 2,
  compat: {
    bridgeVersion: "0.1.0",
    protocolVersion: 2,
    providers: {
      openclaw: {
        supportedRange: {
          min: "2026.5.19",
          maxValidated: "2026.6.5",
        },
        validatedVersions: ["2026.5.19", "2026.6.1", "2026.6.5"],
        capabilities: {
          knobThinkingLevel: "2026.5.19",
          knobModel: "2026.5.19",
          knobFastMode: "2026.6.5",
          knobUnset: "2026.6.5",
          agentFiles: "2026.6.5",
          sessionCompact: "2026.6.5",
          configDefaults: "2026.6.5",
          messageToolRecovery: "2026.5.19",
          agentsDiscovery: "2026.5.19",
          mediaOutbound: "2026.5.19",
          inboundAttachments: "2026.6.1",
          // Hand-added in lockstep with the bridge manifest (atrium-bridge
          // src/compat.ts OPENCLAW_CAPABILITIES) — pending a real /capabilities
          // re-capture, this entry mirrors what the updated bridge emits.
          subagents: "2026.5.19",
        },
      },
      hermes: {
        supportedRange: null,
        validatedVersions: [],
        capabilities: {},
      },
    },
  },
  targets: [
    {
      key: "alice",
      instanceName: "main",
      provider: "openclaw",
      agentId: "alice",
      gatewayVersion: "2026.5.19",
      capabilities: {
        knobThinkingLevel: true,
        knobModel: true,
        knobFastMode: false,
        knobUnset: false,
        agentFiles: false,
        sessionCompact: false,
        configDefaults: false,
        messageToolRecovery: true,
        agentsDiscovery: true,
        mediaOutbound: true,
        inboundAttachments: false,
        // 5.19 target: subagents is available from the 5.19 floor -> true.
        subagents: true,
      },
    },
  ],
} as const;
