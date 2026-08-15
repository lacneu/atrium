import { z } from "zod";

export const SIGNED_ANNOUNCEMENT_ENV = {
  url: "SIGNED_ANNOUNCEMENTS_URL",
  token: "SIGNED_ANNOUNCEMENTS_TOKEN",
  recipientId: "SIGNED_ANNOUNCEMENTS_RECIPIENT_ID",
  recipientField: "SIGNED_ANNOUNCEMENTS_RECIPIENT_FIELD",
  publicKey: "SIGNED_ANNOUNCEMENTS_PUBLIC_KEY",
  domain: "SIGNED_ANNOUNCEMENTS_DOMAIN",
  keyMap: "SIGNED_ANNOUNCEMENTS_KEY_MAP",
} as const;

export const ANNOUNCEMENT_KINDS = [
  "maintenance_scheduled",
  "maintenance_completed",
  "incident_update",
  "subscription_notice",
] as const;

export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

export type SignedAnnouncementConfig = {
  url: string;
  token: string;
  recipientId: string;
  recipientField: string;
  publicKey: string;
  domain: string;
  keyMap: Record<string, AnnouncementKind>;
};

export type SignedAnnouncementConfigState =
  | { status: "active"; config: SignedAnnouncementConfig }
  | {
      status: "inactive";
      reason:
        | "not_configured"
        | "incomplete_configuration"
        | "invalid_configuration";
    };

export type VerifiedAnnouncement = {
  deliveryId: string;
  messageId: string;
  notificationKey:
    | "notif_operator_maintenance_scheduled"
    | "notif_operator_maintenance_completed"
    | "notif_operator_incident_update"
    | "notif_operator_subscription_notice";
  params: Record<string, string>;
  issuedAt: number;
  expiresAt: number;
};

export type RejectedAnnouncement = {
  deliveryId: string | null;
  reason:
    | "unknown_message_key"
    | "invalid_params"
    | "wrong_domain"
    | "unexpected_field"
    | "wrong_recipient"
    | "invalid_lifetime"
    | "wrong_key"
    | "invalid_signature";
};

const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)));
const identifierSchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const serviceSchema = z.enum(["atrium", "assistants", "platform"]);
const announcementKindSchema = z.enum(ANNOUNCEMENT_KINDS);

const paramsSchemas = {
  maintenance_scheduled: z
    .object({
      service: serviceSchema,
      starts_at: timestampSchema,
      ends_at: timestampSchema,
    })
    .strict(),
  maintenance_completed: z
    .object({ service: serviceSchema, completed_at: timestampSchema })
    .strict(),
  incident_update: z
    .object({
      service: serviceSchema,
      status: z.enum(["investigating", "monitoring", "resolved"]),
      reference: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/),
    })
    .strict(),
  subscription_notice: z
    .object({ plan: identifierSchema, effective_at: timestampSchema })
    .strict(),
} satisfies Record<AnnouncementKind, z.ZodType<Record<string, string>>>;

const rawDeliverySchema = z
  .object({
    domain: z.string().min(3).max(128),
    contract_version: z.literal(1),
    delivery_id: z.string().regex(/^dlv_[0-9a-f]{32}$/),
    message_id: z.string().min(1).max(160),
    message_key: z.string().min(3).max(128),
    params: z.record(z.string(), z.unknown()),
    issued_at: timestampSchema,
    expires_at: timestampSchema,
    key_id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .passthrough();

const mailboxResponseSchema = z
  .object({
    contract_version: z.literal(1),
    deliveries: z.array(rawDeliverySchema).max(100),
  })
  .strict();

const notificationKeys: Record<
  AnnouncementKind,
  VerifiedAnnouncement["notificationKey"]
> = {
  maintenance_scheduled: "notif_operator_maintenance_scheduled",
  maintenance_completed: "notif_operator_maintenance_completed",
  incident_update: "notif_operator_incident_update",
  subscription_notice: "notif_operator_subscription_notice",
};

const FIXED_ENVELOPE_FIELDS = new Set([
  "domain",
  "contract_version",
  "delivery_id",
  "message_id",
  "message_key",
  "params",
  "issued_at",
  "expires_at",
  "key_id",
  "signature",
]);

function parseKeyMap(raw: string): Record<string, AnnouncementKind> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = z.record(z.string(), announcementKindSchema).safeParse(parsed);
  if (!result.success) return null;
  const entries = Object.entries(result.data);
  if (entries.length !== ANNOUNCEMENT_KINDS.length) return null;
  if (new Set(entries.map(([, kind]) => kind)).size !== ANNOUNCEMENT_KINDS.length) {
    return null;
  }
  if (entries.some(([key]) => !/^[a-z][a-z0-9_.-]{2,127}$/.test(key))) {
    return null;
  }
  return result.data;
}

export function loadSignedAnnouncementConfig(
  env: Record<string, string | undefined> = process.env,
): SignedAnnouncementConfigState {
  const values = Object.values(SIGNED_ANNOUNCEMENT_ENV).map(
    (name) => env[name]?.trim() ?? "",
  );
  if (values.every((value) => value === "")) {
    return { status: "inactive", reason: "not_configured" };
  }
  if (values.some((value) => value === "")) {
    return { status: "inactive", reason: "incomplete_configuration" };
  }

  const [
    url,
    token,
    recipientId,
    recipientField,
    publicKey,
    domain,
    rawKeyMap,
  ] = values;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url!);
  } catch {
    return { status: "inactive", reason: "invalid_configuration" };
  }
  const keyMap = parseKeyMap(rawKeyMap!);
  if (
    parsedUrl.protocol !== "https:" ||
    token!.length > 512 ||
    !identifierSchema.safeParse(recipientId).success ||
    !/^[a-z][a-z0-9_]{2,63}$/.test(recipientField!) ||
    FIXED_ENVELOPE_FIELDS.has(recipientField!) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey!) ||
    !/^[a-z0-9][a-z0-9.-]{2,127}$/.test(domain!) ||
    keyMap === null
  ) {
    return { status: "inactive", reason: "invalid_configuration" };
  }
  return {
    status: "active",
    config: {
      url: parsedUrl.toString(),
      token: token!,
      recipientId: recipientId!,
      recipientField: recipientField!,
      publicKey: publicKey!,
      domain: domain!,
      keyMap,
    },
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

function base64ToBytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function base64UrlToBytes(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`);
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

export async function createPinnedAnnouncementVerifier(publicKey: string) {
  const spki = base64ToBytes(publicKey);
  const spkiBuffer = exactArrayBuffer(spki);
  const key = await crypto.subtle.importKey(
    "spki",
    spkiBuffer,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const digest = await crypto.subtle.digest("SHA-256", spkiBuffer);
  const keyId = `sha256:${bytesToHex(digest)}`;
  return {
    keyId,
    verify: (payload: unknown, signature: string) =>
      crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        exactArrayBuffer(base64UrlToBytes(signature)),
        exactArrayBuffer(new TextEncoder().encode(canonicalize(payload))),
      ),
  };
}

export async function verifyMailboxResponse(
  input: unknown,
  config: SignedAnnouncementConfig,
  now = Date.now(),
): Promise<{
  verified: VerifiedAnnouncement[];
  rejected: RejectedAnnouncement[];
}> {
  const parsed = mailboxResponseSchema.parse(input);
  const verifier = await createPinnedAnnouncementVerifier(config.publicKey);
  const verified: VerifiedAnnouncement[] = [];
  const rejected: RejectedAnnouncement[] = [];

  for (const delivery of parsed.deliveries) {
    const reject = (reason: RejectedAnnouncement["reason"]) => {
      rejected.push({ deliveryId: delivery.delivery_id, reason });
    };
    const allowedFields = new Set([
      ...FIXED_ENVELOPE_FIELDS,
      config.recipientField,
    ]);
    if (Object.keys(delivery).some((field) => !allowedFields.has(field))) {
      reject("unexpected_field");
      continue;
    }
    const kind = config.keyMap[delivery.message_key];
    if (kind === undefined) {
      reject("unknown_message_key");
      continue;
    }
    const params = paramsSchemas[kind].safeParse(delivery.params);
    if (!params.success) {
      reject("invalid_params");
      continue;
    }
    if (delivery.domain !== config.domain) {
      reject("wrong_domain");
      continue;
    }
    if (delivery[config.recipientField] !== config.recipientId) {
      reject("wrong_recipient");
      continue;
    }
    const issuedAt = Date.parse(delivery.issued_at);
    const expiresAt = Date.parse(delivery.expires_at);
    if (expiresAt <= now || issuedAt > expiresAt) {
      reject("invalid_lifetime");
      continue;
    }
    if (delivery.key_id !== verifier.keyId) {
      reject("wrong_key");
      continue;
    }
    const {
      key_id: _keyId,
      signature,
      delivery_id: deliveryId,
      message_id: messageId,
      issued_at: _issuedAt,
      expires_at: _expiresAt,
      ...unsignedRest
    } = delivery;
    const unsigned = {
      ...unsignedRest,
      delivery_id: deliveryId,
      message_id: messageId,
      issued_at: delivery.issued_at,
      expires_at: delivery.expires_at,
    };
    if (!(await verifier.verify(unsigned, signature))) {
      reject("invalid_signature");
      continue;
    }
    verified.push({
      deliveryId,
      messageId,
      notificationKey: notificationKeys[kind],
      params: params.data,
      issuedAt,
      expiresAt,
    });
  }
  return { verified, rejected };
}
