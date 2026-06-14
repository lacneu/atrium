/**
 * Pure, testable HTTP client for the atrium /api/v1 surface.
 *
 * This module never imports anything from the Convex app — it only speaks HTTP.
 * It reads two env vars:
 *   - OPENCLAW_WEBCHAT_API_BASE : the deployment `.site` origin, WITHOUT the
 *     `/api/v1` suffix (e.g. http://127.0.0.1:3213). The `/api/v1` prefix is
 *     added here so tool/CLI call-sites stay clean (`apiFetch(cfg, "/traces")`).
 *   - OPENCLAW_WEBCHAT_API_KEY  : the `oc_live_...` Bearer key.
 *
 * The API key is only ever placed in the `Authorization` header — never in a
 * URL/query string and never logged.
 */

/** Default base origin for a local Convex deployment (.site origin). */
export const DEFAULT_API_BASE = "http://127.0.0.1:3213";

/** Path prefix for the observability API. Kept here so call-sites omit it. */
export const API_PREFIX = "/api/v1";

export interface Config {
  /** Base origin (no trailing slash, no /api/v1). */
  base: string;
  /** The oc_live_ Bearer key. */
  apiKey: string;
}

/** Minimal env shape so the resolver is injectable/testable. */
export type Env = Record<string, string | undefined>;

/**
 * Structured error for any non-2xx response (or a fetch/transport failure).
 * Carries the HTTP `status` and the parsed/raw `body` so callers can surface a
 * clear message without re-reading the response. Never contains the API key.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Resolve config from an env bag (defaults to `process.env`). Throws a clear
 * error naming the missing variable — without ever printing its value.
 */
export function resolveConfig(env: Env = process.env): Config {
  const base = (env.OPENCLAW_WEBCHAT_API_BASE ?? DEFAULT_API_BASE).replace(
    /\/+$/,
    "",
  );
  const apiKey = env.OPENCLAW_WEBCHAT_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENCLAW_WEBCHAT_API_KEY is required (set it in the environment).",
    );
  }
  return { base, apiKey };
}

/** Build the absolute URL for an API path (prepending `${base}/api/v1`). */
export function buildUrl(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${API_PREFIX}${normalizedPath}`;
}

/** Options for {@link apiFetch}. */
export interface ApiFetchOptions {
  /** Injected fetch implementation. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Call the API at `path` (relative to `${base}/api/v1`), attaching the Bearer
 * header, and parse the JSON response.
 *
 * - 2xx  -> returns the parsed JSON (or `null` for an empty body).
 * - non-2xx -> throws {@link ApiError} with `{status, body}` (body parsed as
 *   JSON when possible, otherwise the raw text).
 * - transport failure -> throws {@link ApiError} with status 0.
 *
 * `fetch` is injectable for unit testing; no network call happens in tests.
 */
export async function apiFetch<T = unknown>(
  config: Config,
  path: string,
  init: RequestInit = {},
  options: ApiFetchOptions = {},
): Promise<T> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new ApiError(
      0,
      null,
      "No fetch implementation available (Node >=18 or inject fetchImpl).",
    );
  }

  const url = buildUrl(config.base, path);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.apiKey}`);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await doFetch(url, { ...init, headers });
  } catch (err) {
    // Transport-level failure (DNS, connection refused, etc.). Surface it as a
    // structured error with status 0 so callers handle it uniformly. Never
    // include the request headers (which hold the key) in the message.
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, null, `Network error reaching API: ${message}`);
  }

  const raw = await res.text();
  const body = parseJsonSafe(raw);

  if (!res.ok) {
    throw new ApiError(
      res.status,
      body,
      `API ${res.status} ${res.statusText} for ${path}`,
    );
  }

  return body as T;
}

/** Parse a string as JSON; fall back to the raw string when it isn't JSON. */
function parseJsonSafe(raw: string): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
