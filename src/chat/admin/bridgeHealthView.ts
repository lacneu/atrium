// Pure render decisions for the Settings "Bridge" tab — extracted from BridgeTab
// so the display logic is UNIT-TESTED (no React). The health module's only job is
// BRIDGE health: a target is "in error" (red) ONLY for a CURRENT bridge-domain
// failure — the bridge could not reach or authenticate to its gateway. A
// DOWNSTREAM rejection (the gateway received + refused the request) keeps the
// target connected and is shown as a neutral note, never red. Traces + Anomalies
// own the detail/alerting; this module only reflects whether the bridge works.
//
// The fault-domain taxonomy lives in the bridge (dispatch-errors.faultDomain),
// which decides the target `state` /health reports. Here we only READ that state
// + the curated codes, so this stays taxonomy-agnostic.

export interface BridgeTargetView {
  /** idle | connected | error — already decayed at read time by the bridge. */
  state: string;
  /** Last bridge-domain failure code (history; visible only while state==="error"). */
  lastErrorCode: string | null;
  /** Last downstream rejection code (cleared by a later ok/error). Optional: a
   *  pre-this-release bridge omits it. */
  lastDownstreamRejectCode?: string | null;
}

/** Targets with a CURRENT bridge-domain failure — drives the red banner + its
 *  count. A recovered/connected target (even one still carrying a stale
 *  lastErrorCode), or one whose stale `error` decayed to `idle`, is NOT counted:
 *  the bridge is reaching its gateway, so it is not "in error". */
export function bridgeErrorTargets<T extends BridgeTargetView>(targets: T[]): T[] {
  return targets.filter((t) => t.state === "error");
}

/** Is the bridge healthy overall? Reachable AND no target in a current error. */
export function isBridgeHealthy(health: {
  reachable: boolean;
  targets: BridgeTargetView[];
}): boolean {
  return health.reachable && bridgeErrorTargets(health.targets).length === 0;
}

/** The header verdict, THREE states: a bridge whose process is fine but whose
 *  GATEWAYS are unreachable (backup/maintenance — the discovery poll fails on
 *  transport) must not read "operational" while every affected chat shows the
 *  gateway-unreachable banner. `unreachableInstances` is optional so a
 *  pre-this-release health payload degrades to the two-state verdict. */
export type BridgeVerdict = "ok" | "gateways_unreachable" | "error";
export function bridgeVerdict(health: {
  reachable: boolean;
  targets: BridgeTargetView[];
  unreachableInstances?: string[];
}): BridgeVerdict {
  if (!isBridgeHealthy(health)) return "error";
  if ((health.unreachableInstances ?? []).length > 0) {
    return "gateways_unreachable";
  }
  return "ok";
}

/** Show the red bridge-error detail block for a target? Only a CURRENT
 *  bridge-domain failure — never a stale lastErrorCode left on a recovered
 *  target (the bridge is talking to its gateway again). */
export function showsBridgeErrorDetail(t: BridgeTargetView): boolean {
  return t.state === "error" && t.lastErrorCode !== null;
}

/** Show the neutral downstream-rejection note for a target? Whenever the last
 *  outcome was a downstream reject (the bridge records it only then, and clears
 *  it on the next ok/error). Independent of the bridge-error block. */
export function showsDownstreamReject(t: BridgeTargetView): boolean {
  return Boolean(t.lastDownstreamRejectCode);
}
