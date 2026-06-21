// Bridge configuration, loaded from the environment and validated fail-fast.
//
// SECURITY (load-bearing): every secret here lives ONLY in the bridge process
// environment. Gateway tokens, the Ed25519 device identity, the Convex ingest
// secret and the shared secret Convex uses to call us are NEVER stored in a
// Convex table or sent to the browser (see convex/schema.ts design invariants).
//
// We fail fast on a missing required variable: a half-configured bridge that
// silently drops sends or can't authenticate is worse than a process that
// refuses to start with a clear message.

/** Ed25519 device identity used to sign the OpenClaw connect challenge. */
export interface DeviceIdentity {
  id: string;
  publicKey: string;
  /** PEM-encoded PKCS#8 Ed25519 private key. */
  privateKey: string;
}

export interface BridgeConfig {
  // --- OpenClaw Gateway ------------------------------------------------------
  /** Gateway URL (ws:// wss:// http:// https://; normalized to ws/wss). */
  openclawGatewayUrl: string;
  /** Bearer token presented in the connect request's auth.token. ENV FALLBACK only
   *  since 3b: null when unset (the credential resolver may fetch it from Convex). */
  openclawToken: string | null;
  /** Ed25519 device identity (id + publicKey + PEM privateKey). ENV FALLBACK only
   *  since 3b: null when unset (the resolver may fetch it from Convex). */
  deviceIdentity: DeviceIdentity | null;
  /** Per-bridge secret (Bearer) the bridge presents to Convex's `/bridge/credentials`
   *  to fetch THIS instance's decrypted gateway creds (3b). null = not configured
   *  (the bridge then relies on the env fallback). Set via BRIDGE_INSTANCE_SECRET. */
  bridgeInstanceSecret: string | null;
  /**
   * The instance NAME this bridge serves. Must equal the Convex `instances.name`
   * row that maps to this bridge's BRIDGE_URL (and the poller's
   * BRIDGE_INSTANCE_NAME). OPTIONAL: when set, `/send|/patch|/reset` reject a
   * body whose `instanceName` differs (M2 guard — catch a Convex routing
   * misconfig loudly instead of answering from the wrong gateway). When null the
   * check is skipped (opt-in).
   *
   * NOTE: the agent id and operator canonical are NO LONGER configuration — they
   * are routed PER-TURN from the request body (Convex resolves the discovered
   * agent + the per-user canonical). Sourcing the agent id from a static env was
   * the root cause of the "Agent <env-id> no longer exists" production bug.
   */
  instanceName: string | null;
  /**
   * OPTIONAL configured gateway version (e.g. "2026.6.5"), from
   * OPENCLAW_GATEWAY_VERSION. A FALLBACK that /capabilities uses ONLY when no
   * live session and no prior discovery has supplied the real version yet — so a
   * freshly-restarted, idle bridge still resolves the served instance's
   * capabilities (AgentFiles / ChatDefaults) instead of "version unknown"
   * (BUG-1). The REAL discovered/live `server.version` ALWAYS wins (precedence:
   * live session > discovered > this fallback), so a stale/wrong value
   * self-corrects the moment a chat runs. Validated as a strict "YYYY.M.P"
   * triple; a malformed value is ignored (undefined). Set it to the gateway
   * version this instance runs.
   */
  gatewayVersionFallback?: string;
  /**
   * The dir the BRIDGE reads agent-produced outbound files from (its own mount of
   * the shared volume). OPENCLAW_MEDIA_OUTBOUND_DIR; defaults to the instance-keyed
   * `/home/node/.openclaw/media/<OPENCLAW_INSTANCE_NAME>/outbound` (flat
   * `…/media/outbound` when no instance name). DIFFERENT from
   * `mediaOutboundAgentMount` (the gateway-visible path the agent writes to).
   */
  mediaOutboundDir: string;
  /**
   * The GATEWAY/AGENT-visible path of the outbound media dir (where the AGENT
   * WRITES a generated file). The delivery instruction tells the agent to write
   * here + emit `MEDIA:<path>`. DIFFERENT from `mediaOutboundDir` when the bridge
   * and the gateway mount the shared volume at different points (e.g. a host bridge
   * reads `/Users/.../media-outbound` while the agent, in the container, writes
   * `/home/node/.openclaw/media/outbound`). Default = the gateway standard. Env
   * OPENCLAW_MEDIA_OUTBOUND_AGENT_MOUNT.
   */
  mediaOutboundAgentMount: string;
  /**
   * Safety cap on a single outbound attachment. Bytes are STREAMED to a Convex
   * upload URL (no base64, no full buffer, no 20MB httpAction ceiling), so this
   * is just a guard against absurd files — raise OPENCLAW_MEDIA_MAX_MB freely.
   * Files above it are skipped (logged) rather than shipped.
   */
  mediaMaxBytes: number;
  /**
   * How the bridge fetches OUTBOUND (agent-generated) file bytes to upload into
   * Convex storage (OPENCLAW_MEDIA_MODE). Three modes:
   *   - "gateway-http" (DEFAULT): fetch over HTTP from the gateway's
   *     `/__openclaw__/assistant-media` endpoint — an authenticated meta-probe
   *     returns a signed `mediaTicket`, then a ticketed download streams the
   *     bytes. Needs NO shared filesystem → the portable default for the vast
   *     majority of deployments (Atrium and the gateway on different hosts).
   *     REQUIRES a gateway that serves that route (OpenClaw 6.x+); against an
   *     older gateway (e.g. 2026.5.19, which has no HTTP media route) the probe
   *     404s and the fetcher reports `route_absent` (a clear log points the
   *     operator at shared-fs) — set OPENCLAW_MEDIA_MODE=shared-fs there.
   *   - "shared-fs": read from a read-only mount of the gateway's `media/outbound`
   *     (LocalDirMediaFetcher). OPT-IN — requires Atrium + the gateway to SHARE a
   *     filesystem (same host / NFS), which most deployments do NOT; never the
   *     default.
   *   - "off": never fetch outbound media (no attachment part is created).
   */
  mediaMode: "gateway-http" | "shared-fs" | "off";
  /**
   * Gateway HTTP origin for the assistant-media endpoint (the "gateway-http"
   * mode). Derived from OPENCLAW_GATEWAY_URL (ws→http, wss→https, SAME host:port
   * — the endpoint is served on the WS port) unless OPENCLAW_GATEWAY_HTTP_URL
   * overrides it (deployments where the gateway's HTTP server is on another host
   * /port). No trailing slash.
   */
  gatewayHttpBase: string;
  /**
   * Connection timeout (ms) for the "gateway-http" media path
   * (OPENCLAW_MEDIA_FETCH_TIMEOUT_MS, default 60s). Bounds the meta-probe + the
   * download RESPONSE HEADERS (an AbortSignal), so a gateway that accepts the
   * connection but never responds can NEVER hang the turn (TurnSink awaits
   * addMedia) — it degrades to a best-effort `fetch_error`. The BODY transfer is
   * NOT bounded by it: it streams at the Convex upload's pace, and a backpressure
   * pause must not be mistaken for a stall (that would false-drop valid media).
   */
  mediaFetchTimeoutMs: number;
  /**
   * Phase 3 (shared-fs INBOUND): the dir the bridge WRITES streamed tool-read
   * files to (OPENCLAW_INBOUND_DIR). Must be a volume bind-mounted into THIS
   * instance's gateway container (the bridge writes, the gateway reads). Defaults
   * to the instance-keyed `/home/node/.openclaw/media/<OPENCLAW_INSTANCE_NAME>/
   * inbound` (flat `…/media/inbound` when no instance name) — the bridge-side
   * mount, translated to `inboundAgentMount` in the injected `[FICHIERS REÇUS]`.
   */
  inboundMediaDir: string;
  /**
   * The GATEWAY-visible mount path the agent reads inbound files from
   * (OPENCLAW_INBOUND_AGENT_MOUNT). The bridge translates inboundMediaDir/<name> →
   * inboundAgentMount/<name> in the injected `[FICHIERS REÇUS]` block. Equal to
   * inboundMediaDir when the bridge + gateway share the path (co-located); differs
   * when the same volume is mounted at different paths in each container.
   */
  inboundAgentMount: string;
  /**
   * TTL (ms) after which a stale inbound file is reaped (OPENCLAW_INBOUND_TTL_MS).
   * MUST exceed the longest possible turn (the agent must finish reading first).
   * Default 6h.
   */
  inboundTtlMs: number;

  // --- Convex ----------------------------------------------------------------
  /**
   * Convex HTTP actions base URL (the `.site` origin, NOT the `.cloud` query
   * origin). The bridge POSTs normalized events to an authenticated ingest
   * httpAction there which runs the internal `stream.*` mutations.
   */
  convexHttpActionsUrl: string;
  /**
   * Shared secret the bridge presents to the Convex ingest httpAction
   * (`Authorization: Bearer <secret>`). Must equal the value set on the
   * deployment with `npx convex env set BRIDGE_INGEST_SECRET ...`.
   */
  convexIngestSecret: string;

  // --- Inbound (Convex -> bridge) -------------------------------------------
  /**
   * Secret Convex's `bridge.dispatch` presents to OUR `POST /send` endpoint
   * (it sends it raw in the `Authorization` header, no "Bearer " prefix — see
   * convex/bridge.ts). Constant-time compared in server.ts.
   */
  bridgeSharedSecret: string;
  /** Port the bridge HTTP server listens on. */
  port: number;
  /**
   * Max request body size (bytes) accepted by `POST /send`. MUST exceed the
   * base64-encoded attachment ceiling: Convex caps each inbound attachment at
   * 20 MiB RAW (`INBOUND_MAX_BYTES` in convex/bridge.ts), and base64 inflates by
   * ~4/3, so a single max attachment is ~26.7 MiB on the wire — plus the JSON
   * envelope (text, routing). The default (32 MiB) clears that with margin; an
   * undersized cap silently 413s every non-trivial file import (the body never
   * reaches `performSend`). Override via `BRIDGE_MAX_BODY_BYTES`.
   */
  maxBodyBytes: number;
}

class ConfigError extends Error {}

function requireEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = (process.env[name] ?? "").trim();
  return value || fallback;
}

/** Optional env that stays `null` when unset (no silent default). */
function optionalEnvOrNull(name: string): string | null {
  const value = (process.env[name] ?? "").trim();
  return value || null;
}

/** Optional STRICT "YYYY.M.P" version env; undefined when unset OR malformed
 *  (a bad value must never masquerade as a real gateway version → fail to
 *  undefined so the conservative no-version policy applies instead). */
function optionalVersionEnv(name: string): string | undefined {
  const value = (process.env[name] ?? "").trim();
  return /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`Invalid ${name}: expected a positive integer`);
  }
  return parsed;
}

/**
 * Map a ws/wss/http/https gateway URL to its HTTP origin (SAME host:port), no
 * trailing slash. The gateway serves `/__openclaw__/assistant-media` on the same
 * port as the operator WebSocket (verified on 2026.6.5), so the HTTP base is just
 * the WS URL with an http(s) scheme. A bare `host:port` defaults to http://.
 */
export function deriveHttpBase(gatewayUrl: string): string {
  let u = gatewayUrl.trim();
  if (u.startsWith("ws://")) u = "http://" + u.slice("ws://".length);
  else if (u.startsWith("wss://")) u = "https://" + u.slice("wss://".length);
  else if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  // ORIGIN ONLY (scheme + host + port). The gateway serves the media route at the
  // ROOT (`/__openclaw__/assistant-media`), so any path/query/fragment on the
  // operator-WS URL (e.g. wss://gw.example.com/openclaw) MUST be dropped — keeping
  // it would target `…/openclaw/__openclaw__/assistant-media` and 404. Fall back to
  // a trailing-slash trim only if the URL is somehow unparseable.
  try {
    return new URL(u).origin;
  } catch {
    return u.replace(/\/+$/, "");
  }
}

/** The gateway-standard media root: each gateway container mounts its instance's
 *  state dir at `/home/node/.openclaw`, so the agent ALWAYS sees its media under
 *  this flat path (that exact path is what `file-transfer.allowReadPaths`
 *  whitelists). The AGENT-visible mounts default here; the BRIDGE's own dirs key
 *  off the instance name below. */
const MEDIA_ROOT = "/home/node/.openclaw/media";

/**
 * Sanitize an instance name into a SAFE single path segment for the bridge's
 * per-instance media subdir. Returns null when the name is empty or unsafe, so
 * the caller falls back to the flat gateway-standard path. Defense in depth: the
 * instance name is operator-set, but a `/`, `\` or `..` in it must never widen
 * the mount path beyond one segment.
 */
export function mediaInstanceSegment(instanceName: string | null): string | null {
  if (!instanceName) return null;
  const seg = instanceName.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  if (seg === "" || seg === "." || seg === "..") return null;
  return seg;
}

/** Parse OPENCLAW_MEDIA_MODE; unset => the portable "gateway-http" default. */
function parseMediaMode(name: string): BridgeConfig["mediaMode"] {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "gateway-http") return "gateway-http";
  if (raw === "shared-fs") return "shared-fs";
  if (raw === "off") return "off";
  throw new ConfigError(
    `Invalid ${name}: "${raw}" (expected one of: gateway-http | shared-fs | off)`,
  );
}

/**
 * Parse + validate a device-identity JSON string into a DeviceIdentity. PURE +
 * exported so the SAME guard validates BOTH the env value AND a value fetched from
 * Convex (step 3b) — a malformed identity must fail clearly, never connect with
 * garbage. `source` only shapes the error message. Throws ConfigError on invalid.
 */
export function parseDeviceIdentity(
  inline: string,
  source = "OPENCLAW_DEVICE_IDENTITY",
): DeviceIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inline);
  } catch (err) {
    throw new ConfigError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).id !== "string" ||
    typeof (parsed as Record<string, unknown>).publicKey !== "string" ||
    typeof (parsed as Record<string, unknown>).privateKey !== "string"
  ) {
    throw new ConfigError(`${source} must be {id, publicKey, privateKey}`);
  }
  const obj = parsed as DeviceIdentity;
  return { id: obj.id, publicKey: obj.publicKey, privateKey: obj.privateKey };
}

/**
 * Device identity from env, or NULL when unset. OPTIONAL since step 3b: the bridge
 * may instead fetch it (decrypted) from Convex via the per-bridge secret; the env
 * value is the FALLBACK. A PRESENT-but-malformed env value still throws (catch a
 * typo loudly), but an ABSENT one is fine (Convex may provide it).
 */
function loadDeviceIdentityOptional(): DeviceIdentity | null {
  const inline = (process.env.OPENCLAW_DEVICE_IDENTITY ?? "").trim();
  if (!inline) return null;
  return parseDeviceIdentity(inline);
}

/**
 * Load and validate the bridge configuration. Throws a ConfigError listing the
 * first missing/invalid variable. Call once at startup so misconfiguration is
 * surfaced immediately rather than on the first send.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  // Bind process.env for the require helpers (they read the live env).
  const prev = process.env;
  process.env = env;
  try {
    // The bridge's OWN mount of the shared volume is keyed by instance name, so
    // multiple per-gateway bridges (Model M — one bridge per gateway) never
    // collide on a shared host and each container's mount is self-documenting:
    // for OPENCLAW_INSTANCE_NAME=<I> the bridge reads/writes
    // `…/media/<I>/{outbound,inbound}`. The AGENT-visible mounts stay FLAT
    // (`…/media/{outbound,inbound}`) — that exact path is what each gateway
    // exposes its media at AND what the instance's openclaw.json
    // `file-transfer.allowReadPaths` whitelists; keying it would break the
    // agent's own read/write. With no instance name the bridge dirs fall back to
    // the flat path too (the co-located dev/bench case). Explicit
    // OPENCLAW_MEDIA_OUTBOUND_DIR / OPENCLAW_INBOUND_DIR always override.
    const instanceName = optionalEnvOrNull("OPENCLAW_INSTANCE_NAME");
    const seg = mediaInstanceSegment(instanceName);
    const outboundDirDefault = seg
      ? `${MEDIA_ROOT}/${seg}/outbound`
      : `${MEDIA_ROOT}/outbound`;
    const inboundDirDefault = seg
      ? `${MEDIA_ROOT}/${seg}/inbound`
      : `${MEDIA_ROOT}/inbound`;
    return {
      openclawGatewayUrl: requireEnv("OPENCLAW_GATEWAY_URL"),
      // OPTIONAL since 3b: the credential resolver fetches these from Convex via the
      // per-bridge secret, falling back to these env values per field.
      openclawToken: optionalEnvOrNull("OPENCLAW_TOKEN"),
      deviceIdentity: loadDeviceIdentityOptional(),
      bridgeInstanceSecret: optionalEnvOrNull("BRIDGE_INSTANCE_SECRET"),
      instanceName,
      gatewayVersionFallback: optionalVersionEnv("OPENCLAW_GATEWAY_VERSION"),
      mediaOutboundDir: optionalEnv(
        "OPENCLAW_MEDIA_OUTBOUND_DIR",
        outboundDirDefault,
      ),
      mediaOutboundAgentMount: optionalEnv(
        "OPENCLAW_MEDIA_OUTBOUND_AGENT_MOUNT",
        `${MEDIA_ROOT}/outbound`,
      ),
      mediaMaxBytes: parseIntEnv("OPENCLAW_MEDIA_MAX_MB", 1024) * 1024 * 1024,
      mediaMode: parseMediaMode("OPENCLAW_MEDIA_MODE"),
      gatewayHttpBase: deriveHttpBase(
        optionalEnv("OPENCLAW_GATEWAY_HTTP_URL", "") ||
          requireEnv("OPENCLAW_GATEWAY_URL"),
      ),
      mediaFetchTimeoutMs: parseIntEnv("OPENCLAW_MEDIA_FETCH_TIMEOUT_MS", 60_000),
      inboundMediaDir: optionalEnv("OPENCLAW_INBOUND_DIR", inboundDirDefault),
      inboundAgentMount: optionalEnv(
        "OPENCLAW_INBOUND_AGENT_MOUNT",
        `${MEDIA_ROOT}/inbound`,
      ),
      inboundTtlMs: parseIntEnv("OPENCLAW_INBOUND_TTL_MS", 6 * 60 * 60 * 1000),
      convexHttpActionsUrl: requireEnv("CONVEX_HTTP_ACTIONS_URL"),
      convexIngestSecret: requireEnv("BRIDGE_INGEST_SECRET"),
      bridgeSharedSecret: requireEnv("BRIDGE_SHARED_SECRET"),
      port: parseIntEnv("BRIDGE_PORT", 8787),
      // 32 MiB: clears one base64-encoded 20 MiB attachment (~26.7 MiB) plus the
      // JSON envelope. The old 1 MiB default 413'd any file whose base64 topped
      // ~1 MiB (~750 KiB raw) — the inbound-import prod regression.
      maxBodyBytes: parseIntEnv("BRIDGE_MAX_BODY_BYTES", 33_554_432),
    };
  } finally {
    process.env = prev;
  }
}

export { ConfigError };
