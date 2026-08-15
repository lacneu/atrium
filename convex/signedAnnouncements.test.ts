/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { SIGNED_ANNOUNCEMENT_ENV } from "./lib/signedAnnouncements";

const modules = import.meta.glob("./**/*.ts");

const ENV_NAMES = Object.values(SIGNED_ANNOUNCEMENT_ENV);
const savedEnv = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of ENV_NAMES) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function signingFixture() {
  const pair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  const keyId = `sha256:${bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", spki)),
  )}`;
  const now = Date.now();
  const utc = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const unsigned = {
    domain: "announcements.example.test",
    contract_version: 1 as const,
    delivery_id: "dlv_11111111111111111111111111111111",
    message_id: "opaque-message-1",
    recipient: "deployment-01",
    message_key: "maintenance.scheduled",
    params: {
      service: "atrium",
      starts_at: utc(60 * 60 * 1_000),
      ends_at: utc(2 * 60 * 60 * 1_000),
    },
    issued_at: utc(-60 * 1_000),
    expires_at: utc(3 * 60 * 60 * 1_000),
  };
  const sign = async (payload: typeof unsigned) =>
    bytesToBase64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          pair.privateKey,
          new TextEncoder().encode(canonicalJson(payload)),
        ),
      ),
    );
  return {
    pair,
    publicKey: bytesToBase64(spki),
    keyId,
    unsigned,
    envelope: { ...unsigned, key_id: keyId, signature: await sign(unsigned) },
    sign,
  };
}

function configure(publicKey: string) {
  process.env[SIGNED_ANNOUNCEMENT_ENV.url] =
    "https://announcements.example.test/mailbox";
  process.env[SIGNED_ANNOUNCEMENT_ENV.token] = "test-token-not-a-real-secret";
  process.env[SIGNED_ANNOUNCEMENT_ENV.recipientId] = "deployment-01";
  process.env[SIGNED_ANNOUNCEMENT_ENV.recipientField] = "recipient";
  process.env[SIGNED_ANNOUNCEMENT_ENV.publicKey] = publicKey;
  process.env[SIGNED_ANNOUNCEMENT_ENV.domain] = "announcements.example.test";
  process.env[SIGNED_ANNOUNCEMENT_ENV.keyMap] = JSON.stringify({
    "maintenance.scheduled": "maintenance_scheduled",
    "maintenance.completed": "maintenance_completed",
    "incident.update": "incident_update",
    "subscription.notice": "subscription_notice",
  });
}

async function seedUsers(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const first = await ctx.db.insert("users", {});
    const second = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: first,
      role: "admin",
      canonical: "first",
    });
    await ctx.db.insert("profiles", {
      userId: second,
      role: "user",
      canonical: "second",
    });
    return [first, second];
  });
}

describe("signed operator announcements", () => {
  test("no configuration is inactive and performs no outbound request", async () => {
    for (const name of ENV_NAMES) delete process.env[name];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);

    await expect(
      t.action(internal.notifications.pollSignedAnnouncements, {}),
    ).resolves.toEqual({ status: "inactive", reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("persists and deduplicates before acknowledging on the next poll", async () => {
    const fixture = await signingFixture();
    configure(fixture.publicKey);
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ contract_version: 1, deliveries: [fixture.envelope] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const t = convexTest(schema, modules);
    await seedUsers(t);

    await expect(
      t.action(internal.notifications.pollSignedAnnouncements, {}),
    ).resolves.toMatchObject({ status: "ok", inserted: 1, duplicate: 0 });
    expect(requests[0]).toEqual({ contract_version: 1, acknowledgements: [] });
    const receiptId = await t.run(async (ctx) =>
      (await ctx.db.query("signedAnnouncementReceipts").first())!._id,
    );
    await t.mutation(internal.notifications.fanOutSignedAnnouncement, {
      receiptId,
    });

    await expect(
      t.action(internal.notifications.pollSignedAnnouncements, {}),
    ).resolves.toMatchObject({ status: "ok", inserted: 0, duplicate: 1 });
    expect(requests[1]).toEqual({
      contract_version: 1,
      acknowledgements: [fixture.envelope.delivery_id],
    });

    const state = await t.run(async (ctx) => ({
      receipts: await ctx.db.query("signedAnnouncementReceipts").collect(),
      notifications: await ctx.db.query("notifications").collect(),
    }));
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]?.acknowledgedAt).toEqual(expect.any(Number));
    expect(state.notifications).toHaveLength(2);
    expect(
      state.notifications.every((row) => row.kind === "operator_announcement"),
    ).toBe(true);
    expect(new Set(state.notifications.map((row) => row.dedupeKey)).size).toBe(1);
  });

  test("rejects an invalid signature without persisting or displaying it", async () => {
    const fixture = await signingFixture();
    configure(fixture.publicKey);
    const first = fixture.envelope.signature[0] === "A" ? "B" : "A";
    const altered = {
      ...fixture.envelope,
      signature: `${first}${fixture.envelope.signature.slice(1)}`,
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ contract_version: 1, deliveries: [altered] }),
          { status: 200 },
        ),
      ),
    );
    const t = convexTest(schema, modules);
    await seedUsers(t);

    await expect(
      t.action(internal.notifications.pollSignedAnnouncements, {}),
    ).resolves.toMatchObject({ status: "ok", inserted: 0, rejected: 1 });
    const counts = await t.run(async (ctx) => ({
      receipts: (await ctx.db.query("signedAnnouncementReceipts").collect()).length,
      notifications: (await ctx.db.query("notifications").collect()).length,
    }));
    expect(counts).toEqual({ receipts: 0, notifications: 0 });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid_signature"),
    );
  });

  test("rejects a message signed by a key other than the pinned key", async () => {
    const fixture = await signingFixture();
    const other = await signingFixture();
    configure(other.publicKey);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ contract_version: 1, deliveries: [fixture.envelope] }),
          { status: 200 },
        ),
      ),
    );
    const t = convexTest(schema, modules);

    await expect(
      t.action(internal.notifications.pollSignedAnnouncements, {}),
    ).resolves.toMatchObject({ status: "ok", inserted: 0, rejected: 1 });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("wrong_key"),
    );
  });

  test("rejects a correctly signed delivery carrying another domain", async () => {
    // The domain is a protocol separator, not decoration: it is what stops a
    // signature the same key produced for a different purpose from being
    // replayed here as an announcement. Removing the check left every other
    // test green, so it gets one of its own.
    const fixture = await signingFixture();
    configure(fixture.publicKey);
    const unsigned = { ...fixture.unsigned, domain: "other.example.test" };
    const envelope = {
      ...unsigned,
      key_id: fixture.keyId,
      signature: await fixture.sign(unsigned),
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ contract_version: 1, deliveries: [envelope] }),
          { status: 200 },
        ),
      ),
    );
    const t = convexTest(schema, modules);

    await expect(
      t.action(internal.notifications.pollSignedAnnouncements, {}),
    ).resolves.toMatchObject({ status: "ok", inserted: 0, rejected: 1 });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("wrong_domain"),
    );
  });

  test("rejects extra content fields even when the envelope is signed", async () => {
    const fixture = await signingFixture();
    configure(fixture.publicKey);
    const unsigned = {
      ...fixture.unsigned,
      params: { ...fixture.unsigned.params, text: "network supplied text" },
    };
    const envelope = {
      ...unsigned,
      key_id: fixture.keyId,
      signature: await fixture.sign(unsigned),
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ contract_version: 1, deliveries: [envelope] }),
          { status: 200 },
        ),
      ),
    );
    const t = convexTest(schema, modules);

    await expect(
      t.action(internal.notifications.pollSignedAnnouncements, {}),
    ).resolves.toMatchObject({ status: "ok", inserted: 0, rejected: 1 });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid_params"),
    );
  });

  test("an expired announcement is neither rendered nor retained", async () => {
    const t = convexTest(schema, modules);
    const [userId] = await seedUsers(t);
    const notificationId = await t.run((ctx) =>
      ctx.db.insert("notifications", {
        userId: userId!,
        kind: "operator_announcement",
        title: "Operator announcement",
        body: "A verified announcement is available.",
        messageKey: "notif_operator_incident_update",
        params: {
          service: "platform",
          status: "monitoring",
          reference: "INC-123",
        },
        dedupeKey: "signed-announcement:expired",
        createdAt: Date.now() - 2,
        expiresAt: Date.now() - 1,
      }),
    );
    const asUser = t.withIdentity({ subject: `${userId}|session` });

    expect(await asUser.query(api.notifications.myNotifications, {})).toEqual(
      [],
    );
    expect(await asUser.query(api.notifications.myUnreadCount, {})).toBe(0);
    await t.mutation(internal.notifications.expireSignedNotification, {
      notificationId,
      dedupeKey: "signed-announcement:expired",
    });
    expect(await t.run((ctx) => ctx.db.get(notificationId))).toBeNull();
  });
});
