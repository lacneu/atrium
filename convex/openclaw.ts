// OpenClaw query bridge (increment 6).
//
// This is the path for the module to fetch COMPLEMENTARY info from OpenClaw (via
// the bridge worker) so it can compile/understand conversational messages. The
// key-authed `POST /api/v1/openclaw/query` route (http.ts) runs this action.
//
// ENV CONTRACT (load-bearing — mirrors bridge.ts's outbound dispatch):
//   - `BRIDGE_URL`           — base URL of the bridge worker (e.g. https://bridge.example).
//   - `BRIDGE_SHARED_SECRET` — server-to-server secret. Sent as the bare
//     `Authorization` header value (NOT `Bearer`-prefixed), EXACTLY as
//     bridge.dispatch does for `POST /send`.
//   These are read from DEPLOYMENT ENV (`npx convex env set ...`), NEVER from a
//   table or the browser. NEVER logged.
//
// BRIDGE WORKER RESPONSIBILITY (out of scope here): the bridge must expose a
//   `POST /query` handler that authenticates the shared secret and returns a
//   JSON answer for the forwarded `{ question/payload }`. This module only
//   forwards the request and relays the worker's JSON response.
//
// GRACEFUL DEGRADATION (load-bearing): if the env is unset/unreachable, this
// action returns `{ ok: false, reason: "bridge_unconfigured" | "bridge_error" }`
// and NEVER throws. A thrown action is retried by Convex; here the failure is a
// normal (non-retryable) result the caller relays as a 200-with-ok:false (the
// route records its trace as a successful, handled request so it does not feed
// the API-error-ratio detector — see http.ts).

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Bounded timeout so a hung bridge cannot stall the action indefinitely.
const QUERY_TIMEOUT_MS = 15_000;

type QueryResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; reason: string; status?: number };

/**
 * Forward a query to the bridge worker's `POST /query` endpoint. Accepts a
 * free-form `question` and/or `payload` (the bridge defines the contract). On
 * any misconfiguration or transport/HTTP error returns a graceful
 * `{ ok: false, reason }` — it NEVER throws (see file header).
 */
/** Sanctioned lossless-claw doctor dispatch (the watcher agent's bounded
 *  self-repair channel): forwards ONE allowlisted action to the instance's
 *  bridge /lossless route (which re-validates the allowlist — defense in
 *  depth). Degrades gracefully (never throws): { ok:false, reason } when the
 *  bridge is unset/unreachable. */
export const losslessDoctor = internalAction({
  args: {
    instanceName: v.string(),
    action: v.union(
      v.literal("status"),
      v.literal("doctor"),
      v.literal("repair_rollover_splits"),
    ),
    agentId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { instanceName, action, agentId },
  ): Promise<Record<string, unknown>> => {
    // Per-instance URL first; single-bridge deployments configure only the
    // BRIDGE_URL env (instances.bridgeUrl empty) — same fallback the other
    // bridge-calling actions use (codex P1).
    const perInstance = await ctx.runQuery(
      internal.agentFiles.bridgeUrlForInstance,
      { instanceName },
    );
    const bridgeUrl = perInstance ?? process.env.BRIDGE_URL ?? null;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!bridgeUrl || !sharedSecret) {
      return { ok: false, reason: "bridge_not_configured" };
    }
    try {
      // Bounded ABOVE the bridge's full worst-case budget (codex P1): the
      // bridge route's explicit ceilings sum to ~110s (handshake ≤30s +
      // initial get ≤8s + send ≤15s + 6 polls ×9.5s) — 150s guarantees a
      // timeout here can only mean the bridge truly hung, never a repair
      // still legitimately in flight. Belt: a RETRY of the repair is also
      // idempotent by plugin semantics (the doctor re-scans and repairs only
      // lanes that still exist, taking a fresh backup — an already-repaired
      // db is a clean no-op).
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/lossless`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: sharedSecret,
        },
        body: JSON.stringify({
          instanceName,
          action,
          ...(agentId ? { agentId } : {}),
        }),
        signal: AbortSignal.timeout(150_000),
      });
      const data: unknown = await response.json().catch(() => null);
      if (typeof data === "object" && data !== null) {
        return data as Record<string, unknown>;
      }
      return { ok: false, reason: `bridge_http_${response.status}` };
    } catch (e) {
      return { ok: false, reason: (e as Error)?.message ?? "bridge_unreachable" };
    }
  },
});

export const queryOpenClaw = internalAction({
  args: {
    question: v.optional(v.string()),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, { question, payload }): Promise<QueryResult> => {
    const bridgeUrl = process.env.BRIDGE_URL;
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (!bridgeUrl || !sharedSecret) {
      // Common dev case: no bridge configured. A graceful, queryable no-op.
      return { ok: false, reason: "bridge_unconfigured" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
    try {
      const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Shared secret authenticates Convex -> bridge (server-to-server).
          // Bare value (NOT `Bearer`-prefixed) to match bridge.dispatch.
          Authorization: sharedSecret,
        },
        body: JSON.stringify({
          ...(question !== undefined ? { question } : {}),
          ...(payload !== undefined ? { payload } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Do NOT log the body (may echo the request); only the numeric status.
        console.error(`openclaw.query: bridge POST /query -> HTTP ${response.status}`);
        return { ok: false, reason: "bridge_error", status: response.status };
      }

      // Relay the worker's JSON answer. Tolerate a non-JSON body gracefully.
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        return { ok: false, reason: "bad_response", status: response.status };
      }
      return { ok: true, status: response.status, data };
    } catch {
      // Network error / abort / DNS — never throw into the caller. NEVER log the
      // secret; the error object does not contain it but we keep the message terse.
      console.error("openclaw.query: bridge POST /query failed (network/abort)");
      return { ok: false, reason: "bridge_error" };
    } finally {
      clearTimeout(timer);
    }
  },
});
