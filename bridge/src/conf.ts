// CONF-4 bridge operations (docs/CONF_DESIGN.md, amendment A9: one bridge
// release carries ALL the new endpoints + allowlists at once):
//   - agent workspace files: `agents.files.list/get/set` with a compare-and-set
//     guard (amendment A4 — re-`get` before `set`, abort on a concurrent edit)
//     and a "before" snapshot for the Convex-side audit/rollback trail;
//   - gateway chat defaults: `config.get` / `config.patch` restricted to
//     EXACTLY `agents.defaults.{thinkingDefault,fastModeDefault}` (A7).
//
// Every operation goes through a STRICT per-field allowlist — never a generic
// passthrough — the same discipline as the body-routing P2a fix. Pure over an
// injected `GatewayRequester` so every branch is unit-testable without a
// socket; server.ts owns auth, connection lifecycle and gateway-error
// classification.

/**
 * Minimal structural view of `OpenClawConnection.request` (gateway RPC frames
 * are `{type,id,ok,payload}`; the useful content is `.payload`). Tests inject a
 * mock; production passes the real connection.
 */
export interface GatewayRequester {
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ payload?: Record<string, unknown> }>;
}

/** An HTTP-shaped operation result the server maps straight to sendJson. */
export interface OpResult {
  status: number;
  body: Record<string, unknown>;
}

// --- Agent workspace files (`POST /agent-files`) -----------------------------

/**
 * Bridge-side allowlist of editable bootstrap file names. The gateway
 * RE-VALIDATES behind us (verified 6.5: a name outside its bootstrap list is
 * refused with INVALID_REQUEST "unsupported file") — this is defense in depth,
 * not the only gate.
 */
export const AGENT_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "USER.md",
  "HEARTBEAT.md",
  "MEMORY.md",
  "BOOT.md",
  "BOOTSTRAP.md",
] as const;

/**
 * Hard cap on a single file write. The gateway's own per-file budget is
 * `bootstrapMaxChars` (20k); 64k leaves headroom for oversized files an admin
 * is trimming DOWN while still rejecting absurd payloads early.
 */
export const MAX_AGENT_FILE_CONTENT_CHARS = 64_000;

export type AgentFilesBody =
  | { op: "list"; instanceName: string | null; agentId: string }
  | { op: "get"; instanceName: string | null; agentId: string; name: string }
  | {
      op: "set";
      instanceName: string | null;
      agentId: string;
      name: string;
      content: string;
      /** Compare-and-set base: abort with 409 when the gateway's
       *  `updatedAtMs` differs (a concurrent edit happened). Optional. */
      baseUpdatedAtMs: number | null;
    };

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isAllowedFileName(name: string): boolean {
  return (AGENT_FILE_NAMES as readonly string[]).includes(name);
}

/**
 * Defensive parse of the `/agent-files` body. Returns null (-> 400) on an
 * unknown op, missing agentId, a name outside the allowlist, an oversized or
 * missing content, or a baseUpdatedAtMs that is present but neither a number
 * (edit/CAS) nor null (create/skip-CAS). `instanceName` (optional)
 * is carried through so the route can apply the SAME instance guard as
 * /reset (red-team P2-3). Exported for tests.
 */
export function parseAgentFilesBody(raw: string): AgentFilesBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const agentId = nonEmptyString(obj.agentId);
  if (!agentId) return null;
  const instanceName = nonEmptyString(obj.instanceName);

  if (obj.op === "list") {
    return { op: "list", instanceName, agentId };
  }
  if (obj.op === "get" || obj.op === "set") {
    const name = nonEmptyString(obj.name);
    if (!name || !isAllowedFileName(name)) return null;
    if (obj.op === "get") {
      return { op: "get", instanceName, agentId, name };
    }
    if (typeof obj.content !== "string") return null;
    if (obj.content.length > MAX_AGENT_FILE_CONTENT_CHARS) return null;
    // `baseUpdatedAtMs` is the CAS token. Convex sends a NUMBER for an edit
    // (compare-and-set against the loaded revision) and explicit `null` for a
    // CREATE of a missing file (skip CAS — see convex/agentFiles.ts setAgentFile
    // `baseUpdatedAtMs ?? null` + performAgentFilesOp's `!== null` guard below).
    // Reject only a PRESENT value that is neither: undefined and null both pass.
    if (
      obj.baseUpdatedAtMs !== undefined &&
      obj.baseUpdatedAtMs !== null &&
      typeof obj.baseUpdatedAtMs !== "number"
    ) {
      return null;
    }
    return {
      op: "set",
      instanceName,
      agentId,
      name,
      content: obj.content,
      baseUpdatedAtMs:
        typeof obj.baseUpdatedAtMs === "number" ? obj.baseUpdatedAtMs : null,
    };
  }
  return null; // unknown op
}

/** Fetch one workspace file row (`payload.file`), defensively typed. */
async function fileGet(
  conn: GatewayRequester,
  agentId: string,
  name: string,
): Promise<Record<string, unknown>> {
  const res = await conn.request("agents.files.get", { agentId, name }, 10_000);
  const file = (res.payload as { file?: unknown } | undefined)?.file;
  return typeof file === "object" && file !== null
    ? (file as Record<string, unknown>)
    : {};
}

/** Project the non-secret file meta the app needs (never `path` — a server
 *  filesystem detail that has no business crossing to Convex). `missing` rides
 *  through: a missing file is EDITABLE (save = create, red-team P3-2). */
function fileMeta(file: Record<string, unknown>): Record<string, unknown> {
  return {
    name: typeof file.name === "string" ? file.name : null,
    missing: file.missing === true,
    size: typeof file.size === "number" ? file.size : null,
    updatedAtMs: typeof file.updatedAtMs === "number" ? file.updatedAtMs : null,
  };
}

/**
 * Execute one `/agent-files` op against the gateway. Gateway failures THROW
 * (the server classifies them to a stable code); only the compare-and-set
 * conflict is a structured non-200 result here.
 */
export async function performAgentFilesOp(
  conn: GatewayRequester,
  body: AgentFilesBody,
): Promise<OpResult> {
  if (body.op === "list") {
    const res = await conn.request("agents.files.list", { agentId: body.agentId }, 10_000);
    const files = (res.payload as { files?: unknown } | undefined)?.files;
    return {
      status: 200,
      body: {
        ok: true,
        // Project EVERY entry through fileMeta (red-team P2-2): the gateway's
        // `path` must never cross to Convex — same discipline as get/set.
        files: (Array.isArray(files) ? files : [])
          .filter(
            (f): f is Record<string, unknown> =>
              typeof f === "object" && f !== null,
          )
          .map(fileMeta),
      },
    };
  }

  if (body.op === "get") {
    const file = await fileGet(conn, body.agentId, body.name);
    // A missing (not-yet-created) file is reported with EMPTY content, not an
    // absence the app would treat as malformed: the editor opens it empty and
    // a save creates it (red-team P3-2).
    const missing = file.missing === true;
    return {
      status: 200,
      body: {
        ok: true,
        file: {
          ...fileMeta(file),
          content:
            typeof file.content === "string" ? file.content : missing ? "" : null,
        },
      },
    };
  }

  // set — COMPARE-AND-SET (A4): re-get first, then require the live file to match
  // the caller's pinned base EXACTLY, else 409 so a concurrent write is never
  // silently overwritten. The base has two shapes (both compared the SAME way):
  //   - a number  -> EDIT: expect updatedAtMs unchanged since load.
  //   - null      -> CREATE: expect the file STILL MISSING (currentUpdatedAtMs
  //     null). If another admin created it between the editor's get and this set,
  //     currentUpdatedAtMs is now a number != null -> 409 (NOT a silent clobber).
  // Convex only ever sends null for a create (setAgentFile `?? null` on a missing
  // file), so no legitimate edit sends null — fail-closed. The pre-set content is
  // returned as `before` for the Convex-side audit/rollback record.
  const before = await fileGet(conn, body.agentId, body.name);
  const currentUpdatedAtMs =
    typeof before.updatedAtMs === "number" ? before.updatedAtMs : null;
  if (currentUpdatedAtMs !== body.baseUpdatedAtMs) {
    return {
      status: 409,
      body: { ok: false, error: { code: "CONFLICT", currentUpdatedAtMs } },
    };
  }
  await conn.request(
    "agents.files.set",
    { agentId: body.agentId, name: body.name, content: body.content },
    15_000,
  );
  // Re-get so the reported meta is the gateway's CONFIRMED post-write state
  // (size/updatedAtMs), never an optimistic guess. Content is intentionally
  // omitted from `file` (the caller already has what it wrote).
  const after = await fileGet(conn, body.agentId, body.name);
  return {
    status: 200,
    body: {
      ok: true,
      file: fileMeta(after),
      before: { content: typeof before.content === "string" ? before.content : null },
    },
  };
}

// --- Gateway chat defaults (`POST /config-defaults`) -------------------------

/** Valid `thinkingDefault` values (verified 6.5: the gateway rejects anything
 *  else with "use off|minimal|low|medium|high|xhigh"). */
export const THINKING_DEFAULT_VALUES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ConfigDefaultsBody =
  | { op: "get"; instanceName: string | null }
  | { op: "clear"; instanceName: string | null }
  | {
      op: "set";
      instanceName: string | null;
      thinkingDefault: string | null;
      fastModeDefault: boolean | null;
    };

/**
 * Defensive parse of the `/config-defaults` body. For `set`, at least one of
 * the two allowlisted fields must be present and valid. `instanceName`
 * (optional) is carried through for the route's instance guard (P2-3).
 * Exported for tests.
 */
export function parseConfigDefaultsBody(raw: string): ConfigDefaultsBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const instanceName =
    typeof obj.instanceName === "string" && obj.instanceName.length > 0
      ? obj.instanceName
      : null;
  if (obj.op === "get") return { op: "get", instanceName };
  // clear = remove both defaults (config.patch null-merge DELETES a key —
  // bench-verified on 2026.6.11): the gateway's own baseline applies again.
  if (obj.op === "clear") return { op: "clear", instanceName };
  if (obj.op !== "set") return null;

  let thinkingDefault: string | null = null;
  if (obj.thinkingDefault !== undefined) {
    if (
      typeof obj.thinkingDefault !== "string" ||
      !(THINKING_DEFAULT_VALUES as readonly string[]).includes(obj.thinkingDefault)
    ) {
      return null;
    }
    thinkingDefault = obj.thinkingDefault;
  }
  let fastModeDefault: boolean | null = null;
  if (obj.fastModeDefault !== undefined) {
    if (typeof obj.fastModeDefault !== "boolean") return null;
    fastModeDefault = obj.fastModeDefault;
  }
  if (thinkingDefault === null && fastModeDefault === null) return null;
  return { op: "set", instanceName, thinkingDefault, fastModeDefault };
}

/** Walk `<root>.agents.defaults`, undefined on any missing/shapeless hop. */
function digAgentDefaults(root: unknown): Record<string, unknown> | undefined {
  if (typeof root !== "object" || root === null) return undefined;
  const agents = (root as Record<string, unknown>).agents;
  if (typeof agents !== "object" || agents === null) return undefined;
  const defaults = (agents as Record<string, unknown>).defaults;
  return typeof defaults === "object" && defaults !== null
    ? (defaults as Record<string, unknown>)
    : undefined;
}

/**
 * Extract `agents.defaults` from a `config.get` payload, i.e.
 * `payload.config?.agents?.defaults ?? payload.agents?.defaults`. The 6.5
 * handler responds with a redacted config SNAPSHOT whose effective object
 * lives under `payload.config` (read from the gateway source:
 * `redactConfigSnapshot`); the flat `payload.agents` path is a defensive
 * fallback against shape drift. Exported for tests.
 */
export function extractAgentDefaults(
  payload: Record<string, unknown> | undefined,
): { thinkingDefault: string | null; fastModeDefault: boolean | null } {
  const defaults = digAgentDefaults(payload?.config) ?? digAgentDefaults(payload);
  return {
    thinkingDefault:
      typeof defaults?.thinkingDefault === "string" ? defaults.thinkingDefault : null,
    fastModeDefault:
      typeof defaults?.fastModeDefault === "boolean" ? defaults.fastModeDefault : null,
  };
}

/**
 * Did a confirmed (re-read) defaults snapshot honor every field a `set` body
 * requested? Pure — the gateway-restart recovery path keys on this.
 *
 * Bench-verified (live-protocol, 2026.6.5): `config.patch` can make the
 * gateway RESTART (`restartReason=config.patch`, e.g. when the normalized
 * write touches restart-bound sections on a freshly configured gateway). The
 * operator socket then dies BEFORE the response is read even though the write
 * APPLIED — the route reconnects and reports success ONLY when this read-back
 * confirms the values landed.
 */
export function defaultsApplied(
  body: Extract<ConfigDefaultsBody, { op: "set" | "clear" }>,
  confirmed: { thinkingDefault: string | null; fastModeDefault: boolean | null },
): boolean {
  if (body.op === "clear") {
    // A clear applied ⇔ both keys are gone from the gateway config.
    return confirmed.thinkingDefault === null && confirmed.fastModeDefault === null;
  }
  if (
    body.thinkingDefault !== null &&
    confirmed.thinkingDefault !== body.thinkingDefault
  ) {
    return false;
  }
  if (
    body.fastModeDefault !== null &&
    confirmed.fastModeDefault !== body.fastModeDefault
  ) {
    return false;
  }
  return true;
}

/** Top-level `hash` from a `config.get` payload (bench-verified 6.5: the get
 *  payload is `{ config: {...}, hash: "..." }`). */
function configHash(payload: Record<string, unknown> | undefined): string | null {
  return typeof payload?.hash === "string" ? payload.hash : null;
}

/** True when a gateway error is the optimistic-concurrency "base hash"
 *  rejection (the config changed between our get and our patch). */
function isBaseHashError(err: unknown): boolean {
  return /base ?hash/i.test((err as Error)?.message ?? "");
}

/**
 * Execute one `/config-defaults` op.
 *
 * `config.patch` flow — BENCH-VERIFIED live on 2026.6.5 (red-team P3-1):
 * (1) `config.get` returns the effective config AND a top-level `hash`;
 * (2) `config.patch { raw: <JSON string of the PARTIAL config>, baseHash }`
 * merge-patches it (response `{ok:true, noop?, config}`). A "base hash" error
 * means the config moved between get and patch: retried ONCE with a fresh
 * hash, then surfaced as a clear error.
 *
 * The patch object is built MINIMAL: exactly `{agents:{defaults:{...}}}` with
 * only the provided fields — nothing else ever leaves the bridge.
 */
export async function performConfigDefaultsOp(
  conn: GatewayRequester,
  body: ConfigDefaultsBody,
): Promise<OpResult> {
  if (body.op === "set" || body.op === "clear") {
    const defaults: Record<string, unknown> = {};
    if (body.op === "clear") {
      // null-merge DELETES the keys (bench-verified 2026.6.11) — the gateway's
      // own built-in defaults apply again.
      defaults.thinkingDefault = null;
      defaults.fastModeDefault = null;
    } else {
      if (body.thinkingDefault !== null)
        defaults.thinkingDefault = body.thinkingDefault;
      if (body.fastModeDefault !== null)
        defaults.fastModeDefault = body.fastModeDefault;
    }
    const raw = JSON.stringify({ agents: { defaults } });
    const attempt = async (): Promise<void> => {
      const pre = await conn.request("config.get", {}, 10_000);
      const baseHash = configHash(pre.payload);
      await conn.request(
        "config.patch",
        { raw, ...(baseHash !== null ? { baseHash } : {}) },
        15_000,
      );
    };
    try {
      await attempt();
    } catch (err) {
      if (!isBaseHashError(err)) throw err;
      // The config changed between our get and our patch: ONE retry on a
      // fresh hash, then a clear error (the caller maps it to 502).
      try {
        await attempt();
      } catch (err2) {
        if (isBaseHashError(err2)) {
          throw new Error(
            "config.patch base-hash conflict persisted after one retry (config changing concurrently)",
          );
        }
        throw err2;
      }
    }
  }
  // Always finish on a fresh `config.get` so the response reflects the
  // gateway's CONFIRMED state (set echoes the truth, like /patch does).
  const res = await conn.request("config.get", {}, 10_000);
  return {
    status: 200,
    body: { ok: true, defaults: extractAgentDefaults(res.payload) },
  };
}
