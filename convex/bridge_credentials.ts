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

async function traceDeviceTokenPromotion(
  ctx: ActionCtx,
  args: {
    instance: string;
    status: number;
    outcome: "stored" | "unchanged" | "superseded" | "rejected";
  },
): Promise<void> {
  try {
    await ctx.runMutation(internal.observability.recordEvent, {
      kind: "openclaw.device_token.promote",
      direction: "inbound",
      principalType: "system",
      principalId: "bridge",
      status: args.status,
      meta: JSON.stringify({
        instance: args.instance,
        outcome: args.outcome,
      }),
    });
  } catch {
    // Never break promotion on a metadata-only audit failure.
  }
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

/** Persist the server-issued device token for this bridge's exact instance. */
export const promoteDeviceToken = httpAction(async (ctx, request) => {
  const header = request.headers.get("authorization") ?? "";
  const bridgeSecret = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : "";
  if (!bridgeSecret) return unauthorized();
  const hash = await hashKey(bridgeSecret);
  const resolved = await ctx.runQuery(
    internal.bridgeAuth.resolveBridgeInstanceBySecretHash,
    { hash },
  );
  if (resolved === null) return unauthorized();

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (new TextEncoder().encode(raw).byteLength > 16 * 1024) {
    return new Response(JSON.stringify({ ok: false, error: "invalid_request" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    decoded = null;
  }
  const body =
    typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  const keys = body === null ? [] : Object.keys(body).sort();
  if (
    body === null ||
    !["deviceId,publicKey,token", "deviceId,issuedAtMs,publicKey,token"].includes(
      keys.join(","),
    ) ||
    typeof body.deviceId !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.deviceId) ||
    typeof body.publicKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(body.publicKey) ||
    typeof body.token !== "string" ||
    body.token.trim().length === 0 ||
    body.token.length > 8192 ||
    (body.issuedAtMs !== undefined &&
      (typeof body.issuedAtMs !== "number" ||
        !Number.isInteger(body.issuedAtMs) ||
        body.issuedAtMs < 0))
  ) {
    return new Response(JSON.stringify({ ok: false, error: "invalid_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const result = await ctx.runAction(
      internal.instanceCredentialProvision.promoteOpenClawDeviceToken,
      {
        instanceId: resolved.instanceId,
        deviceId: body.deviceId,
        publicKey: body.publicKey,
        token: body.token,
        ...(typeof body.issuedAtMs === "number"
          ? { issuedAtMs: body.issuedAtMs }
          : {}),
      },
    );
    await ctx.runMutation(internal.bridgeAuth.touchBridgeLastUsed, {
      authId: resolved.authId,
    });
    await traceDeviceTokenPromotion(ctx, {
      instance: resolved.instanceName,
      status: 200,
      outcome: result.outcome,
    });
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    await traceDeviceTokenPromotion(ctx, {
      instance: resolved.instanceName,
      status: 409,
      outcome: "rejected",
    });
    return new Response(
      JSON.stringify({ ok: false, error: "device_token_promotion_failed" }),
      {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }
});
