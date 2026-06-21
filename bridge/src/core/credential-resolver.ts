// Step 3b — resolve the gateway credentials (operator token + Ed25519 device
// identity) the bridge connects with. Source order PER FIELD: Convex (decrypted,
// fetched with the per-bridge secret) wins; the env value is the FALLBACK. This is
// what lets the gateway-auth env vars be removed later WITHOUT a hard cutover now.
//
// Resilience (advisor): a Convex fetch failure is NON-fatal — distinguish
// "unreachable" (transient) / "unauthorized" (wrong secret) / "http"/"bad value"
// and fall back to env per field; only fail HARD if a required field is missing from
// BOTH sources. Cached after the first successful resolve; invalidate() on a connect
// auth failure so the next connect re-fetches (picks up a rotation). The plaintext is
// NEVER logged.

import { parseDeviceIdentity, type DeviceIdentity } from "../config.js";

export interface ResolvedGatewayCredentials {
  token: string;
  deviceIdentity: DeviceIdentity;
}

/** Why a Convex credential fetch did not yield a value (for a clear, non-secret log). */
export type CredentialFetchReason =
  | "unreachable"
  | "unauthorized"
  | "http"
  | "bad_value"
  // The per-bridge secret authenticated, but to a DIFFERENT instance than the one
  // this bridge serves (operator pasted the wrong secret) — refuse its credentials.
  | "instance_mismatch";

export class CredentialFetchError extends Error {
  constructor(
    readonly reason: CredentialFetchReason,
    message: string,
  ) {
    super(message);
    this.name = "CredentialFetchError";
  }
}

export interface CredentialResolverDeps {
  /** Convex `.site` HTTP-actions origin (same as ingest). */
  convexHttpActionsUrl: string;
  /** Per-bridge secret; null disables the Convex source (env-only). */
  bridgeInstanceSecret: string | null;
  /**
   * The instance THIS bridge serves (OPENCLAW_INSTANCE_NAME). The credentials
   * endpoint returns the PROVEN instance its secret maps to; if that differs from
   * this name, the fetched credentials belong to another gateway and are refused
   * (isolation: one bridge => one gateway). null = no name to check against (skip).
   */
  expectedInstanceName: string | null;
  /** Env fallback values (null when unset). */
  envToken: string | null;
  envDeviceIdentity: DeviceIdentity | null;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Non-secret warning sink (e.g. console.warn). NEVER receives a credential. */
  onWarn?: (message: string) => void;
}

export class CredentialResolver {
  #cache: ResolvedGatewayCredentials | null = null;
  readonly #deps: CredentialResolverDeps;

  constructor(deps: CredentialResolverDeps) {
    this.#deps = deps;
  }

  /** Drop the cache so the next resolve() re-fetches (call on a connect auth failure). */
  invalidate(): void {
    this.#cache = null;
  }

  /** Resolve { token, deviceIdentity }, Convex-first then env per field. Throws a
   *  clear error naming the field(s) missing from BOTH sources. */
  async resolve(): Promise<ResolvedGatewayCredentials> {
    if (this.#cache) return this.#cache;

    let convexToken: string | undefined;
    let convexDevice: DeviceIdentity | undefined;
    if (this.#deps.bridgeInstanceSecret) {
      try {
        const fetched = await this.#fetchFromConvex();
        convexToken = fetched.token;
        if (fetched.deviceIdentity !== undefined) {
          // Validate with the SAME guard as the env value — never connect with garbage.
          convexDevice = parseDeviceIdentity(
            fetched.deviceIdentity,
            "Convex deviceIdentity",
          );
        }
      } catch (err) {
        const reason =
          err instanceof CredentialFetchError ? err.reason : "bad_value";
        // Non-fatal: log the reason (NOT the value) and fall through to env.
        this.#deps.onWarn?.(
          `bridge credential fetch from Convex failed (${reason}); ` +
            `falling back to env per field`,
        );
      }
    }

    const token = convexToken ?? this.#deps.envToken ?? undefined;
    const deviceIdentity =
      convexDevice ?? this.#deps.envDeviceIdentity ?? undefined;

    const missing: string[] = [];
    if (!token) missing.push("operator token (OPENCLAW_TOKEN)");
    if (!deviceIdentity) missing.push("device identity (OPENCLAW_DEVICE_IDENTITY)");
    if (token === undefined || deviceIdentity === undefined) {
      throw new Error(
        `Cannot resolve gateway credentials — missing ${missing.join(" + ")}: ` +
          `neither Convex (per-bridge secret) nor the env fallback provided ${
            missing.length > 1 ? "them" : "it"
          }.`,
      );
    }

    this.#cache = { token, deviceIdentity };
    return this.#cache;
  }

  async #fetchFromConvex(): Promise<{
    token?: string;
    deviceIdentity?: string;
  }> {
    const f = this.#deps.fetchImpl ?? fetch;
    const base = this.#deps.convexHttpActionsUrl.replace(/\/+$/, "");
    let res: Response;
    try {
      res = await f(`${base}/bridge/credentials`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.#deps.bridgeInstanceSecret}` },
        // Bound the boot-time fetch so a slow/hung Convex never blocks startup —
        // a timeout is treated as "unreachable" and falls back to env.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new CredentialFetchError(
        "unreachable",
        `Convex unreachable: ${(err as Error).message}`,
      );
    }
    if (res.status === 401) {
      throw new CredentialFetchError("unauthorized", "Convex rejected the bridge secret (401)");
    }
    if (!res.ok) {
      throw new CredentialFetchError("http", `Convex returned HTTP ${res.status}`);
    }
    let body: { instanceName?: string; credentials?: Record<string, string> };
    try {
      body = (await res.json()) as {
        instanceName?: string;
        credentials?: Record<string, string>;
      };
    } catch (err) {
      throw new CredentialFetchError(
        "bad_value",
        `Convex response was not valid JSON: ${(err as Error).message}`,
      );
    }
    // Isolation guard: the per-bridge secret must belong to the instance THIS bridge
    // serves. The endpoint returns the PROVEN instance name precisely so the bridge
    // can confirm it. A mismatch means an operator configured another instance's
    // secret here — refuse the credentials (the caller falls back to env) instead of
    // connecting this gateway with foreign creds, which would break one-bridge-one-
    // gateway isolation. Instance names are non-secret (they cross this boundary by
    // design), so naming both in the error is safe.
    const expected = this.#deps.expectedInstanceName;
    if (
      expected !== null &&
      body.instanceName !== undefined &&
      body.instanceName !== expected
    ) {
      throw new CredentialFetchError(
        "instance_mismatch",
        `per-bridge secret resolves to instance "${body.instanceName}" but this ` +
          `bridge serves "${expected}"`,
      );
    }
    const creds = body.credentials ?? {};
    // Normalize empty/whitespace-only values to undefined: a corrupted or manually-
    // entered EMPTY secret row must fall back to env PER FIELD, not be cached as an
    // unusable empty credential (a bare `??` keeps `""` and the missing-field throw,
    // which tests `=== undefined`, would not fire).
    const nonEmpty = (v: string | undefined): string | undefined =>
      v && v.trim().length > 0 ? v : undefined;
    return {
      token: nonEmpty(creds.token),
      deviceIdentity: nonEmpty(creds.deviceIdentity),
    };
  }
}
