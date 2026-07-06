// Step 3b — the bridge fetches its DECRYPTED gateway credentials from Convex.
//
// ISOLATION (the whole point of the per-bridge secret): auth is a PER-BRIDGE secret
// (NOT the shared BRIDGE_INGEST_SECRET). The presented secret is hashed and resolved
// to EXACTLY ONE instance (bridgeAuth.by_hash); the endpoint then returns ONLY that
// instance's secrets. The instance is NEVER self-asserted — a caller cannot ask for
// another instance's credentials.
//
// SECURITY:
//   - `Authorization: Bearer <per-bridge secret>`; resolved by hash (238-bit secret,
//     so the hash lookup is the comparison — no timing oracle worth the surface).
//   - Decryption uses the master key (loadLocalCrypto, ATRIUM_SECRET_KEY) bound to
//     AAD `<instanceId>:<field>` — a relocated ciphertext fails.
//   - Served at the deployment `.site` origin (registered in http.ts), like ingest.
//   - The plaintext is returned over the authenticated TLS channel and is NEVER
//     logged/traced (only a metadata trace: which fields, ok/denied — never values).
//
// NOTE: like ingest, this httpAction is NOT in the bridge offline gate; it is
// validated by `npx convex dev` + the live bench (the only thing that proves 3b).

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { hashKey } from "./lib/apikeys";
import { loadLocalCrypto } from "./lib/crypto/keyProvider";
import type { ActionCtx } from "./_generated/server";

/** Metadata-only audit trace (NEVER the secret values). Best-effort. */
async function traceCred(
  ctx: ActionCtx,
  args: { status: number; meta: Record<string, unknown> },
): Promise<void> {
  try {
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "openclaw.credentials.fetch",
      direction: "inbound",
      principalType: "system",
      principalId: "bridge",
      status: args.status,
      meta: JSON.stringify(args.meta),
    });
  } catch {
    // never break the credential fetch on a trace error
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export const instanceCredentials = httpAction(async (ctx, request) => {
  // 1. Extract the per-bridge secret from the Bearer header.
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    await traceCred(ctx, { status: 401, meta: { reason: "no_token" } });
    return unauthorized();
  }

  // 2. Resolve the secret -> the ONE instance it authenticates (proven identity).
  const hash = await hashKey(token);
  const resolved = await ctx.runQuery(
    internal.bridgeAuth.resolveBridgeInstanceBySecretHash,
    { hash },
  );
  if (resolved === null) {
    await traceCred(ctx, { status: 401, meta: { reason: "unknown_secret" } });
    return unauthorized();
  }

  // 3. Read + DECRYPT the encrypted envelopes for THAT instance only (AAD-bound).
  const envelopes = await ctx.runQuery(
    internal.instanceSecrets.getInstanceSecretEnvelopes,
    { instanceId: resolved.instanceId },
  );
  let registry;
  try {
    ({ registry } = loadLocalCrypto());
  } catch {
    // ATRIUM_SECRET_KEY missing/invalid on the deployment — a clear server-side
    // failure, never leak why to the caller beyond a 500.
    await traceCred(ctx, {
      status: 500,
      meta: { instance: resolved.instanceName, reason: "no_master_key" },
    });
    return new Response(
      JSON.stringify({ ok: false, error: "server_misconfigured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const credentials: Record<string, string> = {};
  for (const { field, secret } of envelopes) {
    credentials[field] = await registry.decrypt(
      secret,
      `${resolved.instanceId}:${field}`,
    );
  }

  // 4. Best-effort heartbeat + a metadata-only audit trace (fields present, never
  //    their values).
  await ctx.runMutation(internal.bridgeAuth.touchBridgeLastUsed, {
    authId: resolved.authId,
  });
  await traceCred(ctx, {
    status: 200,
    meta: {
      instance: resolved.instanceName,
      fields: Object.keys(credentials).sort(),
      // Non-secret gateway config rides along; the audit stays VALUES-FREE (a
      // gatewayUrl host can be mildly sensitive) — record only presence.
      hasGatewayUrl: resolved.gatewayUrl.length > 0,
    },
  });

  return new Response(
    JSON.stringify({
      instanceName: resolved.instanceName,
      // Non-secret gateway config so the bridge self-configures its connection
      // from Convex (no OPENCLAW_GATEWAY_URL env). The SECRET fields stay in
      // `credentials` (decrypted from instanceSecrets above).
      gateway: {
        url: resolved.gatewayUrl,
        version: resolved.gatewayVersion,
        httpUrl: resolved.gatewayHttpUrl,
        kind: resolved.kind,
        transport: resolved.transport ?? null,
      },
      credentials,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Secret-bearing response: never cache (defense-in-depth even over auth+TLS).
        "Cache-Control": "no-store",
      },
    },
  );
});
