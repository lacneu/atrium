// Non-interactive encrypted gateway credential enrollment. The provisioner may
// write only the exact credential shape required by the instance provider. Every
// plaintext is encrypted in the action runtime and bound to <instanceId>:<field>
// with AES-256-GCM AAD before a single optimistic mutation updates the database.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { GenericActionCtx } from "convex/server";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { mintDeviceIdentity } from "./deviceIdentity";
import { loadLocalCrypto } from "./lib/crypto/keyProvider";
import {
  encryptedSecretValidator,
  secretFieldValidator,
  secretSourceValidator,
} from "./lib/crypto/convexValidator";

type GatewayKind = "openclaw" | "hermes";
type SecretField = "token" | "deviceIdentity" | "apiKey";
type SecretSource = "admin" | "provisioner" | "device";
type SecretEnvelope = Doc<"instanceSecrets">["secret"];
/**
 * The optimistic-concurrency token for one secret row.
 *
 * `updatedAt` ALONE is not a revision: it has millisecond granularity, so a
 * concurrent writer landing in the same millisecond leaves it unchanged and the
 * compare-and-set silently passes — the action then overwrites a value it never
 * observed, which is the opposite of the fail-closed contract this module
 * advertises. The stored ciphertext is carried alongside it: it changes on EVERY
 * write (a fresh AES-GCM nonce per encryption guarantees it, even when the
 * plaintext is identical), so a same-millisecond change cannot hide. `source` is
 * included too, since provenance can change without the ciphertext moving.
 */
type Revision = {
  field: SecretField;
  updatedAt: number;
  ciphertext: string;
  source?: SecretSource;
};

const credentialValidator = v.object({
  token: v.optional(v.string()),
  apiKey: v.optional(v.string()),
});

function expectedFields(kind: GatewayKind): SecretField[] {
  return kind === "openclaw" ? ["deviceIdentity", "token"] : ["apiKey"];
}

function revisionOf(
  rows: Array<{
    field: SecretField;
    updatedAt: number;
    secret: SecretEnvelope;
    source?: SecretSource;
  }>,
): Revision[] {
  return rows
    .map(({ field, updatedAt, secret, source }) => ({
      field,
      updatedAt,
      ciphertext: secret.ciphertext,
      source,
    }))
    .sort((left, right) => left.field.localeCompare(right.field));
}

function sameRevision(left: Revision[], right: Revision[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.field === right[index]?.field &&
        entry.updatedAt === right[index]?.updatedAt &&
        entry.ciphertext === right[index]?.ciphertext &&
        entry.source === right[index]?.source,
    )
  );
}

function assertUniqueFields(rows: Array<{ field: SecretField }>): void {
  const fields = rows.map(({ field }) => field);
  if (new Set(fields).size !== fields.length) {
    throw new Error("credential_state_ambiguous");
  }
}

function parseDeviceIdentity(plaintext: string): {
  id: string;
  publicKey: string;
  privateKey: string;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext);
  } catch {
    throw new Error("credential_state_invalid");
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded) ||
    typeof (decoded as Record<string, unknown>).id !== "string" ||
    typeof (decoded as Record<string, unknown>).publicKey !== "string" ||
    typeof (decoded as Record<string, unknown>).privateKey !== "string"
  ) {
    throw new Error("credential_state_invalid");
  }
  const identity = decoded as { id: string; publicKey: string; privateKey: string };
  // SHAPE, not just type. An identity can also arrive through the admin secret
  // form, which accepts any string: empty or arbitrary values used to pass here,
  // the enrollment answered success, and the failure only surfaced later inside
  // the bridge's `createPrivateKey` — a configuration reported as valid and in
  // fact unusable. These are the same formats the device-token promotion endpoint
  // already enforces on the wire (64 hex chars for the id, 43 base64url chars for
  // an Ed25519 public key), applied here so the two can never disagree.
  if (
    !/^[0-9a-f]{64}$/.test(identity.id) ||
    !/^[A-Za-z0-9_-]{43}$/.test(identity.publicKey) ||
    !/^-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(identity.privateKey.trim())
  ) {
    throw new Error("credential_state_invalid");
  }
  return identity;
}

/** base64url (unpadded) -> bytes. Mirrors deviceIdentity.toBase64Url's inverse. */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** PKCS#8 PEM -> DER bytes. */
function fromPkcs8Pem(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Prove the three fields belong together, CRYPTOGRAPHICALLY.
 *
 * The shape checks above only say the strings look right. They accept a valid-
 * looking PEM holding an RSA key, or an Ed25519 key that simply is not the one
 * `publicKey` names — and an identity can reach the database through the admin
 * secret form, which validates nothing. Enrollment would answer success and the
 * bridge would then sign the gateway's challenge with the wrong key: an
 * authentication failure at the far end of the install, reported as a valid
 * configuration here.
 *
 * So: the id must be the SHA-256 of the raw public key (the gateway's own
 * convention, mirrored from mintDeviceIdentity), and the private key must produce
 * a signature the public key verifies. Nothing short of signing proves the pair.
 */
async function assertIdentityConsistent(identity: {
  id: string;
  publicKey: string;
  privateKey: string;
}): Promise<void> {
  try {
    const rawPublic = fromBase64Url(identity.publicKey);
    const digest = await crypto.subtle.digest("SHA-256", rawPublic);
    const expectedId = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (expectedId !== identity.id) throw new Error("id_mismatch");

    const publicKey = await crypto.subtle.importKey(
      "raw",
      rawPublic,
      "Ed25519",
      false,
      ["verify"],
    );
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      fromPkcs8Pem(identity.privateKey),
      "Ed25519",
      false,
      ["sign"],
    );
    const probe = new TextEncoder().encode("atrium-device-identity-consistency");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, probe);
    const ok = await crypto.subtle.verify("Ed25519", publicKey, signature, probe);
    if (!ok) throw new Error("keypair_mismatch");
  } catch {
    throw new Error("credential_state_invalid");
  }
}

/** Resolve one immutable routing name and return ciphertext plus a revision. */
export const readCredentialEnrollmentState = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const instances = await ctx.db
      .query("instances")
      .withIndex("by_name", (query) => query.eq("name", name.trim()))
      .take(2);
    if (instances.length > 1) throw new Error("instance_name_ambiguous");
    const instance = instances[0];
    if (instance === undefined) return null;
    const secrets = await ctx.db
      .query("instanceSecrets")
      .withIndex("by_instance", (query) => query.eq("instanceId", instance._id))
      .take(4);
    assertUniqueFields(secrets);
    return {
      instanceId: instance._id,
      kind: instance.kind ?? "openclaw",
      revision: revisionOf(secrets),
      secrets: secrets.map(({ field, secret, source, issuedAtMs }) => ({
        field,
        secret,
        source,
        issuedAtMs,
      })),
    };
  },
});

/** Atomically apply encrypted changes if no concurrent writer changed the rows. */
export const storeProvisionedCredentials = internalMutation({
  args: {
    instanceId: v.id("instances"),
    kind: v.union(v.literal("openclaw"), v.literal("hermes")),
    observed: v.array(
      v.object({
        field: secretFieldValidator,
        updatedAt: v.number(),
        ciphertext: v.string(),
        source: v.optional(secretSourceValidator),
      }),
    ),
    changes: v.array(
      v.object({
        field: secretFieldValidator,
        secret: encryptedSecretValidator,
        source: secretSourceValidator,
        issuedAtMs: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { instanceId, kind, observed, changes }) => {
    const instance = await ctx.db.get(instanceId);
    if (instance === null) throw new Error("instance_not_found");
    if ((instance.kind ?? "openclaw") !== kind) {
      throw new Error("instance_kind_changed");
    }
    const current = await ctx.db
      .query("instanceSecrets")
      .withIndex("by_instance", (query) => query.eq("instanceId", instanceId))
      .take(4);
    assertUniqueFields(current);
    if (!sameRevision(revisionOf(current), observed)) {
      throw new Error("credential_state_changed");
    }

    const expected = new Set(expectedFields(kind));
    assertUniqueFields(changes);
    if (changes.some(({ field }) => !expected.has(field))) {
      throw new Error("credential_fields_invalid");
    }
    const changedByField = new Map(
      changes.map(
        ({ field, secret, source, issuedAtMs }) =>
          [field, { secret, source, issuedAtMs }] as const,
      ),
    );
    for (const row of current) {
      if (!expected.has(row.field)) {
        await ctx.db.delete(row._id);
        continue;
      }
      const change = changedByField.get(row.field);
      if (change !== undefined) {
        await ctx.db.patch(row._id, {
          secret: change.secret,
          source: change.source,
          issuedAtMs: change.issuedAtMs,
          updatedAt: Date.now(),
        });
        changedByField.delete(row.field);
      }
    }
    for (const [field, change] of changedByField) {
      await ctx.db.insert("instanceSecrets", {
        instanceId,
        field,
        secret: change.secret,
        source: change.source,
        issuedAtMs: change.issuedAtMs,
        updatedAt: Date.now(),
      });
    }
  },
});

/** Encrypt and enroll the complete provider credential set without replay writes. */
export const enrollInstanceCredentials = internalAction({
  args: {
    name: v.string(),
    kind: v.union(v.literal("openclaw"), v.literal("hermes")),
    credentials: credentialValidator,
  },
  handler: async (
    ctx,
    { name, kind, credentials },
  ): Promise<{
    name: string;
    outcome: "stored" | "unchanged";
    fields: SecretField[];
    deviceIdentity?: { id: string; publicKey: string };
  }> => {
    const state = await ctx.runQuery(
      internal.instanceCredentialProvision.readCredentialEnrollmentState,
      { name },
    );
    if (state === null) throw new Error("instance_not_found");
    if (state.kind !== kind) throw new Error("instance_kind_mismatch");

    const fields = expectedFields(kind);
    const supplied = Object.entries(credentials).filter(
      (entry): entry is [SecretField, string] => entry[1] !== undefined,
    );
    const suppliedFields = kind === "openclaw" ? ["token"] : ["apiKey"];
    if (
      supplied.length !== suppliedFields.length ||
      supplied.some(
        ([field, plaintext]) =>
          !suppliedFields.includes(field) || plaintext.trim().length === 0,
      )
    ) {
      throw new Error("credential_fields_invalid");
    }

    const { encryptCipher, registry } = loadLocalCrypto();
    const existing = new Map(
      state.secrets.map(({ field, secret, source }) => [
        field,
        { secret, source },
      ]),
    );
    const changes: Array<{
      field: SecretField;
      secret: SecretEnvelope;
      source: SecretSource;
    }> = [];
    let deviceIdentity: { id: string; publicKey: string } | undefined;
    /** True when THIS call created the identity, so any promoted token is stale. */
    let mintedIdentity = false;
    if (kind === "openclaw") {
      const currentIdentity = existing.get("deviceIdentity");
      const envelope = currentIdentity?.secret;
      const identity =
        envelope === undefined
          ? await mintDeviceIdentity()
          : await (async () => {
              const parsed = parseDeviceIdentity(
                await registry.decrypt(
                  envelope,
                  `${state.instanceId}:deviceIdentity`,
                ),
              );
              await assertIdentityConsistent(parsed);
              return parsed;
            })();
      if (envelope === undefined) {
        mintedIdentity = true;
        changes.push({
          field: "deviceIdentity",
          secret: await encryptCipher.encrypt(
            JSON.stringify(identity),
            `${state.instanceId}:deviceIdentity`,
          ),
          source: "provisioner",
        });
      }
      deviceIdentity = { id: identity.id, publicKey: identity.publicKey };
    }
    for (const [field, plaintext] of supplied) {
      const current = existing.get(field);
      const envelope = current?.secret;
      // IDENTICAL VALUE FIRST, whatever established it: a replay of the same
      // bootstrap token must stay `unchanged` even on a row whose provenance the
      // guards below would otherwise refuse to touch.
      //
      // EXCEPT when this call minted a new device identity. A promoted token that
      // happens to equal the supplied bootstrap string is still BOUND to the
      // identity it was issued against, and that identity no longer exists — so
      // short-circuiting on equality here would keep the binding the block below
      // exists to break, and store an unusable bundle while answering success. The
      // value being equal says nothing about what it is bound to.
      const boundToAReplacedIdentity =
        kind === "openclaw" &&
        field === "token" &&
        current?.source === "device" &&
        mintedIdentity;
      if (
        !boundToAReplacedIdentity &&
        envelope !== undefined &&
        (await registry.decrypt(envelope, `${state.instanceId}:${field}`)) ===
          plaintext
      ) {
        continue;
      }
      // A token the BRIDGE promoted after pairing outranks the bootstrap one the
      // control plane holds. Never downgrade it — UNLESS this call is minting a new
      // device identity, which happens when the stored one was cleared. A promoted
      // token is bound to the identity it was issued against, so keeping it beside a
      // FRESH identity produces a bundle that is individually valid and jointly
      // unusable: the bridge would present the new key with a token minted for the
      // old one and be refused. Reachable through `clearInstanceSecret` on
      // deviceIdentity alone.
      if (
        kind === "openclaw" &&
        field === "token" &&
        current?.source === "device" &&
        !mintedIdentity
      ) {
        continue;
      }
      // UNKNOWN PROVENANCE — a row written before `source` existed, so it MIGHT
      // already be a promoted device token. `source` is optional and nothing
      // backfills it, so "not device" does not mean "not promoted": treating the
      // absence as permission would silently cut a gateway that works. Refuse, and
      // let a human clear the credential deliberately if a replacement is intended.
      // Only OpenClaw tokens carry the promotion semantics; a Hermes apiKey has no
      // second writer, so an ordinary update stays possible there.
      if (
        kind === "openclaw" &&
        field === "token" &&
        current !== undefined &&
        current.source === undefined
      ) {
        throw new Error("credential_provenance_unknown");
      }
      changes.push({
        field,
        secret: await encryptCipher.encrypt(
          plaintext,
          `${state.instanceId}:${field}`,
        ),
        source: "provisioner",
      });
    }
    const stale = state.secrets.some(({ field }) => !fields.includes(field));
    const unchanged = changes.length === 0 && !stale;
    // ALWAYS through the mutation, even with nothing to write. Returning early on
    // "nothing changed" skipped the compare-and-set entirely, so an admin who
    // replaced a secret between the read above and this point would be reported as
    // if the CALLER's value were installed — the API answering for a state it never
    // verified. With no changes the mutation writes nothing; what it still does is
    // confirm that what we observed is what is there.
    await ctx.runMutation(
      internal.instanceCredentialProvision.storeProvisionedCredentials,
      {
        instanceId: state.instanceId,
        kind,
        observed: state.revision,
        changes,
      },
    );
    if (unchanged) {
      return {
        name: name.trim(),
        outcome: "unchanged",
        fields,
        ...(deviceIdentity === undefined ? {} : { deviceIdentity }),
      };
    }
    await ctx.scheduler.runAfter(0, internal.instanceSync.pokeInstanceBridge, {
      instanceId: state.instanceId,
    });
    return {
      name: name.trim(),
      outcome: "stored",
      fields,
      ...(deviceIdentity === undefined ? {} : { deviceIdentity }),
    };
  },
});

/** Read the exact encrypted bundle authorized for device-token promotion. */
export const readDeviceTokenPromotionState = internalQuery({
  args: { instanceId: v.id("instances") },
  handler: async (ctx, { instanceId }) => {
    const instance = await ctx.db.get(instanceId);
    if (instance === null) throw new Error("instance_not_found");
    if ((instance.kind ?? "openclaw") !== "openclaw") {
      throw new Error("instance_kind_mismatch");
    }
    const secrets = await ctx.db
      .query("instanceSecrets")
      .withIndex("by_instance", (query) => query.eq("instanceId", instanceId))
      .take(4);
    assertUniqueFields(secrets);
    return {
      instanceId,
      revision: revisionOf(secrets),
      secrets: secrets.map(({ field, secret, source, issuedAtMs }) => ({
        field,
        secret,
        source,
        issuedAtMs,
      })),
    };
  },
});

/** Replace a bootstrap secret with the paired device token over the bridge channel. */
export const promoteOpenClawDeviceToken = internalAction({
  args: {
    instanceId: v.id("instances"),
    deviceId: v.string(),
    publicKey: v.string(),
    token: v.string(),
    /** The gateway's own issuance time for THIS token (`auth.issuedAtMs`). */
    issuedAtMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { instanceId, deviceId, publicKey, token, issuedAtMs },
  ): Promise<{ outcome: "stored" | "unchanged" | "superseded" }> => {
    // A LOST RACE IS NOT A REFUSAL. Two overlapping handshakes read the same
    // revision; the first write wins and the second gets `credential_state_changed`
    // — even when the second carries the NEWER token. Surfaced as a 409 the bridge
    // treats as final, that would leave Convex holding the older token while the
    // gateway may already have revoked it. Re-read and decide again, so the
    // issuance comparison runs against whoever actually won.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await promoteOnce(ctx, {
          instanceId,
          deviceId,
          publicKey,
          token,
          issuedAtMs,
        });
      } catch (error) {
        const lostRace =
          error instanceof Error && error.message === "credential_state_changed";
        // Bounded: a race resolves in one or two rounds. Past that, something is
        // rewriting continuously and refusing is the honest answer.
        if (!lostRace || attempt >= 3) throw error;
      }
    }
  },
});

/** One attempt at the promotion, against the state as it stands right now. */
async function promoteOnce(
  ctx: GenericActionCtx<DataModel>,
  {
    instanceId,
    deviceId,
    publicKey,
    token,
    issuedAtMs,
  }: {
    instanceId: Id<"instances">;
    deviceId: string;
    publicKey: string;
    token: string;
    issuedAtMs?: number;
  },
): Promise<{ outcome: "stored" | "unchanged" | "superseded" }> {
    const state = await ctx.runQuery(
      internal.instanceCredentialProvision.readDeviceTokenPromotionState,
      { instanceId },
    );
    const { encryptCipher, registry } = loadLocalCrypto();
    const existing = new Map(
      state.secrets.map(({ field, secret, source, issuedAtMs }) => [
        field,
        { secret, source, issuedAtMs },
      ]),
    );
    const identityEnvelope = existing.get("deviceIdentity")?.secret;
    if (identityEnvelope === undefined) throw new Error("credential_state_invalid");
    const identity = parseDeviceIdentity(
      await registry.decrypt(identityEnvelope, `${instanceId}:deviceIdentity`),
    );
    if (identity.id !== deviceId || identity.publicKey !== publicKey) {
      throw new Error("device_identity_mismatch");
    }
    const current = existing.get("token");
    let currentPlaintext: string | undefined;
    if (current !== undefined) {
      currentPlaintext = await registry.decrypt(
        current.secret,
        `${instanceId}:token`,
      );
      // ORDER BY ISSUANCE, not by arrival — and FAIL CLOSED when issuance cannot
      // order them. Two handshakes to the same gateway can overlap and be handed
      // different tokens; the compare-and-set only protects the revision each one
      // READ, so both writes succeed in sequence and whichever lands last wins,
      // which may be the older. The gateway states when it issued each token, but
      // `auth.issuedAtMs` is OPTIONAL in the contract and two issuances can share a
      // millisecond — so "not provably newer" must lose, not win by arriving late.
      // Only a token that supersedes a PROMOTED one needs this: a bootstrap or
      // admin-written value is not an issuance and has nothing to be ordered
      // against.
      if (current.source === "device" && currentPlaintext !== token) {
        const provablyNewer =
          issuedAtMs !== undefined &&
          current.issuedAtMs !== undefined &&
          issuedAtMs > current.issuedAtMs;
        if (!provablyNewer) return { outcome: "superseded" };
      }
      if (currentPlaintext === token && current.source === "device") {
        // The VALUE is unchanged, but the gateway may now be supplying an issuance
        // time it did not before (`auth.issuedAtMs` is optional, and an upgraded
        // gateway starts sending it). Record it: without it, `provablyNewer` can
        // never become true and every FUTURE rotation would be refused as
        // `superseded` for ever — a deadlock built out of a missing timestamp.
        const adoptsTimestamp =
          issuedAtMs !== undefined && current.issuedAtMs === undefined;
        await ctx.runMutation(
          internal.instanceCredentialProvision.storeProvisionedCredentials,
          {
            instanceId,
            kind: "openclaw",
            observed: state.revision,
            // Same ciphertext, so nothing is re-encrypted; only the ordering fact
            // it was missing is added.
            changes: adoptsTimestamp
              ? [
                  {
                    field: "token",
                    secret: current.secret,
                    source: "device",
                    issuedAtMs,
                  },
                ]
              : [],
          },
        );
        return { outcome: adoptsTimestamp ? "stored" : "unchanged" };
      }
    }
    const secret =
      current !== undefined && currentPlaintext === token
        ? current.secret
        : await encryptCipher.encrypt(token, `${instanceId}:token`);
    await ctx.runMutation(
      internal.instanceCredentialProvision.storeProvisionedCredentials,
      {
        instanceId,
        kind: "openclaw",
        observed: state.revision,
        changes: [{ field: "token", secret, source: "device", issuedAtMs }],
      },
    );
    return { outcome: "stored" };
}
