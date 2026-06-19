// Group the Bridge tab's data BY PROVIDER (OpenClaw, Hermes, …) so each provider
// renders as one self-contained card (its connections + compatibility + config).
// The bridge process itself is global (one reachability/version); only the
// downstream connections/compat/instances are provider-scoped.
//
// Provider of a connection is derived FRONTEND-side: a health target carries its
// `instanceName`, and an instance carries its `kind` — so connection → instance →
// kind = provider. A legacy instance with no kind, or a target whose instance is
// unknown, defaults to "openclaw" (the only pre-Hermes provider; admin.ts also
// defaults instances.kind to "openclaw").

export const DEFAULT_PROVIDER = "openclaw";

type WithInstanceName = { instanceName: string | null };
type WithProvider = { provider: string; instanceName?: string | null };
type WithKind = { name: string; kind?: string | null };

function kindOf(i: WithKind): string {
  return i.kind ?? DEFAULT_PROVIDER;
}

export type ProviderBucket<T, C, I> = {
  key: string;
  connections: T[];
  compatTargets: C[];
  instances: I[];
};

// Order providers with OpenClaw first (the primary/default), then alphabetically,
// so the layout is stable as providers come and go.
function orderProviders(present: Set<string>): string[] {
  return [...present].sort((a, b) =>
    a === DEFAULT_PROVIDER
      ? -1
      : b === DEFAULT_PROVIDER
        ? 1
        : a.localeCompare(b),
  );
}

export function groupBridgeByProvider<
  T extends WithInstanceName,
  C extends WithProvider,
  I extends WithKind,
>(
  targets: readonly T[],
  compatTargets: readonly C[],
  instances: readonly I[],
): ProviderBucket<T, C, I>[] {
  // instanceName → provider, from compat targets first then instances (instances
  // are the source of truth for kind, so they win). Merging both means connection
  // grouping still works for a non-admin who can read compat but not listInstances.
  const providerByInstance = new Map<string, string>();
  for (const c of compatTargets) {
    if (c.instanceName) providerByInstance.set(c.instanceName, c.provider);
  }
  for (const i of instances) providerByInstance.set(i.name, kindOf(i));

  const providerOfConn = (t: T): string =>
    (t.instanceName ? providerByInstance.get(t.instanceName) : undefined) ??
    DEFAULT_PROVIDER;

  // A provider is "present" (gets a card) when it has at least one instance,
  // connection, or compat target — never an empty card (no dead Hermes UI).
  const present = new Set<string>();
  for (const i of instances) present.add(kindOf(i));
  for (const c of compatTargets) present.add(c.provider);
  for (const t of targets) present.add(providerOfConn(t));

  return orderProviders(present).map((key) => ({
    key,
    connections: targets.filter((t) => providerOfConn(t) === key),
    compatTargets: compatTargets.filter((c) => c.provider === key),
    instances: instances.filter((i) => kindOf(i) === key),
  }));
}

// Title-cased provider label for a card header (proper noun, not translated).
export function providerLabel(key: string): string {
  if (key === "openclaw") return "OpenClaw";
  if (key === "hermes") return "Hermes";
  return key.charAt(0).toUpperCase() + key.slice(1);
}
