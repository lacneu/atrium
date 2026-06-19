// Per-instance bridge URL resolution (Model M: one bridge process per gateway).
//
// Each instance row may carry its OWN `bridgeUrl`; dispatch POSTs there. When the
// instance has none (or there is no instance row — a legacy/unrouted chat) we fall
// back to the deployment-wide `BRIDGE_URL` env, which is the byte-identical
// single-bridge path that predates multi-instance. `BRIDGE_SHARED_SECRET` stays
// shared across all bridges (same Convex→bridge trust domain), so only the URL is
// per-instance here.

/** The instance fields this resolver reads (a subset of the `instances` doc). */
export type BridgeRoutableInstance = { bridgeUrl?: string } | null | undefined;

/**
 * Resolve the bridge URL to POST a turn to: the instance's own `bridgeUrl`, else
 * the deployment `BRIDGE_URL` env. Returns `undefined` when neither is set (the
 * caller fails the dispatch with `not_configured`). A blank/whitespace value is
 * treated as unset so a misconfigured empty field never produces a `POST /send`.
 */
export function resolveBridgeUrl(instance: BridgeRoutableInstance): string | undefined {
  const perInstance = instance?.bridgeUrl?.trim();
  if (perInstance) return perInstance;
  const envUrl = process.env.BRIDGE_URL?.trim();
  return envUrl ? envUrl : undefined;
}

/**
 * Resolve the dispatch bridge URL with the SAME attribution safety as the pollers
 * (`resolvePollTargets`): an instance's OWN `bridgeUrl` always wins; otherwise the
 * env `BRIDGE_URL` is used ONLY when the routed instance is unambiguously the one
 * that env bridge serves — there is no instance row at all (legacy/unrouted), it is
 * the SOLE instance, or it is the explicitly-served instance (`BRIDGE_INSTANCE_NAME`).
 *
 * Without this scoping, a multi-instance deployment where one instance lacks a
 * `bridgeUrl` would silently POST that instance's chats to the env bridge's gateway
 * (a DIFFERENT instance/agent) — and the bridge's own `instanceName` guard only
 * catches it if that bridge declares `OPENCLAW_INSTANCE_NAME`. Returning `undefined`
 * here makes dispatch fail `not_configured` instead, so an unattributable route
 * never delivers to the wrong instance. The single-bridge path is unchanged (a sole
 * or unrouted instance still falls back to env, byte-identically).
 */
export function resolveBridgeUrlForDispatch(
  instance: BridgeRoutableInstance,
  scope: { instanceName: string | null; served: string | null; isSole: boolean },
): string | undefined {
  const own = instance?.bridgeUrl?.trim();
  if (own) return own;
  const envUrl = process.env.BRIDGE_URL?.trim();
  if (!envUrl) return undefined;
  // No instance row (legacy/unrouted), or the sole instance: env is unambiguous.
  if (instance == null || scope.isSole) return envUrl;
  // A multi-instance row WITHOUT its own bridgeUrl: only the explicitly-served
  // instance may use env; anything else is unattributable -> not_configured.
  if (scope.instanceName !== null && scope.instanceName === scope.served) {
    return envUrl;
  }
  return undefined;
}

/**
 * Resolve, for the cron pollers (Model M fan-out), the bridge URL to poll for
 * EACH instance. An instance's OWN bridgeUrl is always polled (it hits its own
 * gateway — no cross-instance cache corruption). An instance WITHOUT one falls
 * back to the env BRIDGE_URL, but ONLY when it is the served instance
 * (`BRIDGE_INSTANCE_NAME`) or the sole instance — so the env bridge's data is
 * never attributed to a different instance's name. Unattributable instances are
 * dropped. URLs are trimmed of any trailing slash. Pure (env passed in) for tests.
 */
export function resolvePollTargets(
  instances: Array<{ name: string; bridgeUrl: string | null }>,
  env: { envUrl: string | null; served: string | null },
): Array<{ name: string; url: string }> {
  const soleName = instances.length === 1 ? instances[0].name : null;
  const out: Array<{ name: string; url: string }> = [];
  for (const inst of instances) {
    const own = inst.bridgeUrl?.trim() || null;
    const url =
      own ??
      (env.envUrl !== null &&
      (inst.name === env.served || inst.name === soleName)
        ? env.envUrl
        : null);
    if (url !== null) out.push({ name: inst.name, url: url.replace(/\/$/, "") });
  }
  return out;
}

/**
 * Resolve the bridges to poll for HEALTH (Model M aggregation). Differs from
 * `resolvePollTargets`: health is attribution-AGNOSTIC, so it ALWAYS polls the env
 * BRIDGE_URL when set (the backward-compatible single-bridge path — even with NO
 * `instances` rows), attributed to the served name or `null`. Each instance's OWN
 * bridgeUrl is also polled. Deduped by URL (an instance whose own bridgeUrl equals
 * the env is polled once). A `null` name means "keep the bridge's self-reported
 * instanceName" (the caller forces a non-null name, trusts the body for null).
 */
export function resolveHealthPollTargets(
  instances: Array<{ name: string; bridgeUrl: string | null }>,
  env: { envUrl: string | null; served: string | null },
): Array<{ name: string | null; url: string }> {
  const out: Array<{ name: string | null; url: string }> = [];
  const seen = new Set<string>();
  const add = (name: string | null, raw: string): void => {
    const url = raw.trim().replace(/\/$/, "");
    if (url.length === 0 || seen.has(url)) return;
    seen.add(url);
    out.push({ name, url });
  };
  for (const inst of instances) {
    const own = inst.bridgeUrl?.trim();
    if (own) add(inst.name, own);
  }
  if (env.envUrl) add(env.served, env.envUrl);
  return out;
}
