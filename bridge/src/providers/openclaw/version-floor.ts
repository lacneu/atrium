// The supported-floor refusal (0.92.0): a gateway whose LIVE version is below
// `OPENCLAW_MIN_SUPPORTED` (2026.8.2) is not driven at all.
//
// Why a refusal and not a degraded path: below the floor the transcript carries no
// `__openclaw.runId` on replies and no `steerTargetRunId` on steered inputs (upstream
// `src/sessions/transcript-events.ts`, `src/sessions/user-turn-transcript.metadata.ts`,
// both first shipped in v2026.8.1), so a reply can only be placed by the timing and
// prose heuristics the transcript redesign retires. Keeping a frozen copy of those
// heuristics for older gateways was declined (operator decision, 2026-10-01).

import { OPENCLAW_MIN_SUPPORTED, openClawBelowFloor } from "../../compat.js";

/** Thrown BEFORE any session RPC of a turn when the gateway is known to be below the
 *  supported floor. Classified by TYPE (`gateway_version_unsupported`), never by text. */
export class GatewayVersionUnsupportedError extends Error {
  readonly gatewayVersion: string;
  constructor(gatewayVersion: string) {
    super(
      `gateway version ${gatewayVersion} is below the supported minimum ${OPENCLAW_MIN_SUPPORTED}`,
    );
    this.name = "GatewayVersionUnsupportedError";
    this.gatewayVersion = gatewayVersion;
  }
}

/** Refuse a turn on a gateway KNOWN to be below the floor. An absent or unreadable
 *  version passes: a degraded handshake is not evidence of an old gateway. */
export function assertSupportedGateway(gatewayVersion: string | null | undefined): void {
  if (openClawBelowFloor(gatewayVersion)) {
    throw new GatewayVersionUnsupportedError(gatewayVersion as string);
  }
}
