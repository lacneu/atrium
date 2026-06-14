// Shared types + helpers for the outbound trace-shipping adapters (increment 5).
//
// The adapters (langfuse.ts / opik.ts) are PURE w.r.t. Convex: their mappers and
// `send()` operate on a plain structural event shape, not a Convex `Doc`, so
// they can be unit-tested with no convex-test harness and no DB. `ShippableEvent`
// mirrors the SHIPPABLE subset of a `traceEvents` row (metadata only — D2: never
// raw message content).

// The redacted-metadata subset of a `traceEvents` row that is safe to ship.
// Structural (not `Doc<"traceEvents">`) so adapters stay framework-free and
// trivially testable. PHI invariant: this carries NO raw message text — only
// lengths/ids/status/latency/role + the non-PHI `meta` JSON blob.
export type ShippableEvent = {
  _id: string;
  at: number; // ms epoch (also the cursor watermark)
  kind: string; // span name
  direction?: "inbound" | "outbound" | "internal";
  principalType: "user" | "service" | "system";
  principalId?: string;
  roleKey?: string;
  route?: string;
  method?: string;
  status?: number; // numeric (HTTP/code) only
  latencyMs?: number;
  chatId?: string;
  runId?: string;
  correlationId?: string;
  meta?: string; // JSON-encoded non-PHI extras
};

/** Outcome of a single vendor `send()` batch. Never throws; this is the signal. */
export type SendResult = {
  ok: boolean;
  count: number; // events accepted into the request
  status?: number; // HTTP status when a response was received
  skipped?: boolean; // true when the vendor was unconfigured (no-op)
  reason?: string; // "unconfigured" | "network_error" | ...
};

/** Options for `send()` — `fetchImpl` is injectable so tests run with no network. */
export type SendOptions = {
  fetchImpl?: typeof fetch;
};

/**
 * When a trace event has no `correlationId` (it is optional in the schema), fall
 * back to a stable per-event seed so the vendor trace id is still deterministic
 * and never `undefined`. We use the event's own `_id` — a single uncorrelated
 * event simply forms its own one-span trace.
 */
export function fallbackCorrelationId(event: ShippableEvent): string {
  return event.correlationId ?? `event:${event._id}`;
}

/**
 * SHA-256 hex of a UTF-8 string via Web Crypto (available in the Convex/edge
 * runtimes). Used only to DERIVE deterministic vendor ids from non-secret seeds
 * (correlationId / event id) — never to hash secrets.
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a deterministic RFC-4122-shaped UUID (v4-style layout) from a hex seed.
 * Used by the Opik adapter, which keys traces/spans by UUID. Same seed → same
 * UUID, so the Convex↔Opik link is stable. Not cryptographically a real v4
 * (it is derived, not random) — that is intentional for stable linking.
 */
export function uuidFromHex(hex: string): string {
  const h = hex.padEnd(32, "0").slice(0, 32);
  // Force the version (4) and variant (8..b) nibbles for a well-formed UUID.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${variantNibble(h.slice(16, 17))}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

/**
 * Build a deterministic UUID **version 7** from a hash hex + a timestamp (ms).
 * Opik REQUIRES trace ids to be v7 ("Trace id must be a version 7 UUID" — caught
 * by the live shipping probe). v7 layout: 48-bit unix-ms prefix, version nibble
 * 7, variant 10xx, the rest from the hash. Using the event's own `at` as the
 * timestamp keeps the id meaningful AND deterministic (same hash+at → same id,
 * so retries are idempotent).
 */
export function uuidV7FromHex(hex: string, ms: number): string {
  const h = hex.padEnd(32, "0").slice(0, 32);
  const ts = Math.max(0, Math.trunc(ms)).toString(16).padStart(12, "0").slice(-12);
  return [
    ts.slice(0, 8), // time_high (32 bits of the 48-bit ms)
    ts.slice(8, 12), // time_low (16 bits)
    `7${h.slice(0, 3)}`, // version 7 + 12 bits from hash
    `${variantNibble(h.slice(3, 4))}${h.slice(4, 7)}`, // variant + 12 bits
    h.slice(7, 19), // 48 bits from hash
  ].join("-");
}

/** Map an arbitrary hex nibble onto the RFC-4122 variant range [8,9,a,b]. */
function variantNibble(n: string): string {
  const map: Record<string, string> = {
    "0": "8",
    "1": "9",
    "2": "a",
    "3": "b",
    "4": "8",
    "5": "9",
    "6": "a",
    "7": "b",
    "8": "8",
    "9": "9",
    a: "a",
    b: "b",
    c: "8",
    d: "9",
    e: "a",
    f: "b",
  };
  return map[n] ?? "8";
}

/** ms epoch → ISO 8601 string (Opik trace/span timestamps are ISO). */
export function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
