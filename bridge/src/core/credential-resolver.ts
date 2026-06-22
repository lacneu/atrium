// Multi-instance bootstrap — resolve EVERY served instance's gateway config from
// Convex (one bridge, N gateways). Source of truth is Convex ONLY (D1 hard break):
// for each configured per-bridge secret, GET /bridge/credentials, which RESOLVES the
// secret to exactly one instance (proven identity, never self-asserted) and returns
// that instance's NON-secret gateway config (url/version/httpUrl/kind) + its decrypted
// SECRET creds (token + Ed25519 device identity). No env fallback for gateway data.
//
// Resilience (advisor D4): a secret that fails to resolve/decrypt is SKIPPED with a
// clear, non-secret log — it must NOT abort boot for the healthy instances. The
// plaintext is NEVER logged. Isolation is preserved at the secret level: each secret
// unlocks exactly its own instance (bridgeAuth.by_hash 1:1), so there is no
// cross-instance "expected name" to check — the resolution IS the authorization.

import {
  buildInstanceConfig,
  parseDeviceIdentity,
  type BridgeConfig,
  type InstanceData,
  type SharedConfig,
} from "../config.js";

/** Why a Convex credential fetch did not yield a usable instance (non-secret log). */
export type CredentialFetchReason =
  | "unreachable"
  | "unauthorized"
  | "http"
  | "bad_value"
  | "no_gateway_url"
  | "no_token"
  | "bad_device";

export class CredentialFetchError extends Error {
  constructor(
    readonly reason: CredentialFetchReason,
    message: string,
    // The resolved instance name, when the failure happened AFTER identity was proven
    // (no_gateway_url / no_token / bad_device). Absent for pre-identity failures
    // (unreachable / http / unauthorized / bad JSON) — there is no instance to name yet.
    readonly instanceName?: string,
  ) {
    super(message);
    this.name = "CredentialFetchError";
  }
}

/** A non-secret config problem surfaced on /health so operators see WHY an instance is
 *  not served WITHOUT reading bridge logs. `media_dir_collision` is derived at register
 *  time; `no_secrets` means BRIDGE_INSTANCE_SECRETS is empty. */
export type ConfigIssueReason =
  | CredentialFetchReason
  | "media_dir_collision"
  | "no_secrets";

export interface ConfigIssue {
  /** Resolved instance name when known (no_token / bad_device / collision); omitted for
   *  pre-identity failures (unreachable / http / unauthorized). NEVER the secret. */
  instanceName?: string;
  reason: ConfigIssueReason;
}

/** Outcome of resolving ONE per-bridge secret (used by resolveAll + the self-heal loop). */
export type ResolveOneResult =
  | { ok: true; data: InstanceData }
  | { ok: false; reason: CredentialFetchReason; instanceName?: string };

export interface CredentialResolverDeps {
  /** Convex `.site` HTTP-actions origin (same as ingest). */
  convexHttpActionsUrl: string;
  /** Per-bridge secrets, one per served instance. */
  bridgeInstanceSecrets: string[];
  /** Gateway-agnostic shared config, combined with each fetched instance. */
  shared: SharedConfig;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Non-secret warning sink (e.g. console.warn). NEVER receives a credential. */
  onWarn?: (message: string) => void;
}

/** A served instance that failed to resolve (for the boot summary; non-secret). */
export interface ResolveFailure {
  reason: CredentialFetchReason;
  /** Resolved instance name when the failure is post-identity (no_token / bad_device). */
  instanceName?: string;
}

export interface ResolveResult {
  /** instanceName -> full per-instance BridgeConfig (the gateways this bridge serves). */
  served: Map<string, BridgeConfig>;
  /** Secrets that could not be resolved (skipped, not fatal). */
  failures: ResolveFailure[];
}

export class CredentialResolver {
  readonly #deps: CredentialResolverDeps;

  constructor(deps: CredentialResolverDeps) {
    this.#deps = deps;
  }

  /**
   * Resolve every configured per-bridge secret into a served-instance map. A secret
   * that fails is logged (reason only) and skipped — boot proceeds with whatever
   * resolved (D4). Returns the map + the list of failures.
   */
  async resolveAll(): Promise<ResolveResult> {
    const served = new Map<string, BridgeConfig>();
    const failures: ResolveFailure[] = [];
    for (const secret of this.#deps.bridgeInstanceSecrets) {
      const r = await this.resolveOne(secret);
      if (r.ok) {
        if (served.has(r.data.instanceName)) {
          this.#deps.onWarn?.(
            `bridge: two configured secrets resolve to instance "${r.data.instanceName}"; keeping the first`,
          );
          continue;
        }
        served.set(
          r.data.instanceName,
          buildInstanceConfig(this.#deps.shared, r.data),
        );
      } else {
        // Non-fatal (D4): skip THIS secret, never block the healthy instances. The
        // secret value is never logged.
        this.#deps.onWarn?.(
          `bridge: skipping a configured per-bridge secret — credential fetch failed (${r.reason})`,
        );
        failures.push({ reason: r.reason, instanceName: r.instanceName });
      }
    }
    return { served, failures };
  }

  /**
   * Resolve ONE per-bridge secret to its instance data (or a non-secret failure reason).
   * Never throws — wraps the fetch so the self-heal loop can retry a pending secret
   * without try/catch at every call site. The secret value is never returned or logged.
   */
  async resolveOne(secret: string): Promise<ResolveOneResult> {
    try {
      const data = await this.#fetchInstance(secret);
      return { ok: true, data };
    } catch (err) {
      if (err instanceof CredentialFetchError) {
        return { ok: false, reason: err.reason, instanceName: err.instanceName };
      }
      return { ok: false, reason: "bad_value" };
    }
  }

  /** Fetch + validate ONE instance's gateway config + creds from Convex. */
  async #fetchInstance(secret: string): Promise<InstanceData> {
    const f = this.#deps.fetchImpl ?? fetch;
    const base = this.#deps.convexHttpActionsUrl.replace(/\/+$/, "");
    let res: Response;
    try {
      res = await f(`${base}/bridge/credentials`, {
        method: "GET",
        headers: { Authorization: `Bearer ${secret}` },
        // Bound the boot-time fetch so a slow/hung Convex never blocks startup.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new CredentialFetchError(
        "unreachable",
        `Convex unreachable: ${(err as Error).message}`,
      );
    }
    if (res.status === 401) {
      throw new CredentialFetchError(
        "unauthorized",
        "Convex rejected the bridge secret (401)",
      );
    }
    if (!res.ok) {
      throw new CredentialFetchError("http", `Convex returned HTTP ${res.status}`);
    }
    let body: {
      instanceName?: string;
      gateway?: {
        url?: string;
        version?: string | null;
        httpUrl?: string | null;
        kind?: string;
      };
      credentials?: Record<string, string>;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw new CredentialFetchError(
        "bad_value",
        `Convex response was not valid JSON: ${(err as Error).message}`,
      );
    }
    const instanceName = body.instanceName?.trim();
    if (!instanceName) {
      throw new CredentialFetchError("bad_value", "Convex response had no instanceName");
    }
    const url = body.gateway?.url?.trim();
    if (!url) {
      throw new CredentialFetchError(
        "no_gateway_url",
        `instance "${instanceName}" has no gatewayUrl configured in Convex`,
        instanceName,
      );
    }
    // Empty/whitespace-only secret rows must be treated as MISSING (a corrupted or
    // half-entered credential is unusable, not an empty token to connect with).
    const nonEmpty = (v: string | undefined): string | undefined =>
      v && v.trim().length > 0 ? v : undefined;
    const creds = body.credentials ?? {};
    const token = nonEmpty(creds.token);
    if (!token) {
      throw new CredentialFetchError(
        "no_token",
        `instance "${instanceName}" has no operator token stored in Convex`,
        instanceName,
      );
    }
    const deviceRaw = nonEmpty(creds.deviceIdentity);
    if (!deviceRaw) {
      throw new CredentialFetchError(
        "bad_device",
        `instance "${instanceName}" has no device identity stored in Convex`,
        instanceName,
      );
    }
    let deviceIdentity;
    try {
      // Validate with the SAME guard as the env value — never connect with garbage.
      deviceIdentity = parseDeviceIdentity(deviceRaw, "Convex deviceIdentity");
    } catch (err) {
      throw new CredentialFetchError(
        "bad_device",
        `instance "${instanceName}" device identity is invalid: ${(err as Error).message}`,
        instanceName,
      );
    }
    const kind = body.gateway?.kind === "hermes" ? "hermes" : "openclaw";
    return {
      instanceName,
      gatewayUrl: url,
      token,
      deviceIdentity,
      gatewayVersion: nonEmpty(body.gateway?.version ?? undefined) ?? null,
      gatewayHttpUrl: nonEmpty(body.gateway?.httpUrl ?? undefined) ?? null,
      kind,
    };
  }
}
