/**
 * The gateway's PER-ATTACHMENT ceilings (`hello-ok.policy.attachments`).
 *
 * Upstream facts these tests encode (v2026.8.1 → v2026.9.36; absent before):
 *  - `policy.attachments = {maxBytes, maxImageBytes}` are DECODED-size ceilings, per
 *    attachment, "so clients can validate a file before sending"
 *    (packages/gateway-protocol/src/schema/frames.ts HelloOkSchema).
 *  - `maxBytes = min(agents.defaults.mediaMaxMb or 20 MiB, the frame budget)` and
 *    `maxImageBytes = min(maxBytes, MAX_IMAGE_BYTES = 6 MiB)`
 *    (src/gateway/chat-attachment-policy.ts resolveChatAttachmentPolicy).
 *  - The gateway refuses with `size > limit` (strict), the size being the base64's
 *    decoded length — `floor(len * 3 / 4)` minus the padding
 *    (src/media/attachment-processor.ts prepareMediaAttachment), and an image over
 *    6 MiB whatever `maxBytes` says (src/gateway/chat-attachments.ts).
 *  - The Control UI picks the ceiling by `mimeType.startsWith("image/")`
 *    (ui/src/pages/chat/components/chat-attachment-admission.ts).
 *  - What the gateway ENFORCES per send is the configured limit, read from the CURRENT
 *    config (`resolveChatAttachmentMaxBytes(cfg)`, server-methods/
 *    chat-send-attachments.ts) — not the advertised one, which is that limit capped at
 *    the gateway's frame budget, `floor((maxPayload - 256 KiB) * 3 / 4)`
 *    (src/shared/chat-attachment-frame-budget.ts). `agents.defaults.mediaMaxMb` reloads
 *    hot, with no reconnect (src/gateway/config-reload-plan.ts), and the hello-ok is
 *    sent once.
 *
 * THE RULE: an early refusal by Atrium is never stricter than the gateway's decision
 * for that send; a ceiling that is not known refuses nothing.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachmentCeilingFor,
  decodedBase64Bytes,
  isKnownImageSignature,
  firstOversizedAttachment,
  maxRawInboundBytes,
  readAttachmentCeilings,
} from "../src/core/attachment-limits.js";
import { classifyGatewayError } from "../src/core/dispatch-errors.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { HealthRegistry } from "../src/core/health.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { createBridgeServer, enrichHealthSnapshot, performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import { fakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";
import { servedMap, sharedFromConfig } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";
import {
  CAPTURED_HELLO_POLICY,
  MAX_BUFFERED,
  MAX_PAYLOAD,
  deviceIdentity,
  startWsFakeGateway,
} from "./helpers/ws-fake-gateway.js";

/** The enforced part of the captured policy: the image ceiling. Its file ceiling,
 *  19 464 192, IS the gateway's frame budget for maxPayload 26 214 400 — the cap of the
 *  advertisement, not a limit the gateway applies. */
const CAPTURED = { maxBytes: null, maxImageBytes: 6291456 };
const policy = (attachments: unknown, maxPayload: unknown = MAX_PAYLOAD) => ({
  maxPayload,
  maxBufferedBytes: MAX_BUFFERED,
  attachments,
});
const MiB = 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readAttachmentCeilings", () => {
  it("keeps the image ceiling of the captured hello-ok and drops its file ceiling, which is only the frame budget", () => {
    expect(readAttachmentCeilings(CAPTURED_HELLO_POLICY)).toEqual(CAPTURED);
    // The dropped value is exactly the gateway's own budget for that frame…
    expect(CAPTURED_HELLO_POLICY.attachments.maxBytes).toBe(
      Math.floor(((CAPTURED_HELLO_POLICY.maxPayload - 256 * 1024) * 3) / 4),
    );
    // …and the gateway (20 MiB configured) accepts files above it that fit the frame:
    // Atrium's own frame cap is higher, and refusing at 19 464 192 would be stricter.
    expect(maxRawInboundBytes(MAX_PAYLOAD)).toBeGreaterThan(CAPTURED_HELLO_POLICY.attachments.maxBytes);
    expect(maxRawInboundBytes(MAX_PAYLOAD)).toBeLessThan(20 * MiB);
  });

  it("keeps a file ceiling the operator CONFIGURED below the frame budget (mediaMaxMb)", () => {
    expect(readAttachmentCeilings(policy({ maxBytes: 5 * MiB, maxImageBytes: 5 * MiB }))).toEqual({
      maxBytes: 5 * MiB,
      maxImageBytes: 5 * MiB,
    });
    expect(readAttachmentCeilings(policy({ maxBytes: 10 * MiB, maxImageBytes: 6 * MiB }))).toEqual({
      maxBytes: 10 * MiB,
      maxImageBytes: 6 * MiB,
    });
  });

  it("is null when the gateway advertises none (before 2026.8.1)", () => {
    expect(readAttachmentCeilings({ maxPayload: MAX_PAYLOAD, maxBufferedBytes: MAX_BUFFERED })).toBeNull();
    expect(readAttachmentCeilings(undefined)).toBeNull();
    expect(readAttachmentCeilings(null)).toBeNull();
  });

  it("keeps nothing it cannot tell from the frame budget: no maxPayload, no ceiling", () => {
    expect(readAttachmentCeilings({ attachments: { maxBytes: 5 * MiB, maxImageBytes: 5 * MiB } })).toBeNull();
    expect(readAttachmentCeilings(policy({ maxBytes: 5 * MiB, maxImageBytes: 5 * MiB }, "big"))).toBeNull();
  });

  it("drops a zero, negative or malformed value rather than refusing every file", () => {
    for (const attachments of [
      { maxBytes: 0, maxImageBytes: 0 },
      { maxBytes: -1, maxImageBytes: -1 },
      { maxBytes: "5242880", maxImageBytes: Number.NaN },
      {},
      "20MB",
      [],
      null,
    ]) {
      expect(readAttachmentCeilings(policy(attachments)), JSON.stringify(attachments)).toBeNull();
    }
    // One usable value is kept on its own.
    expect(readAttachmentCeilings(policy({ maxBytes: 0, maxImageBytes: 6 * MiB }))).toEqual({
      maxBytes: null,
      maxImageBytes: 6 * MiB,
    });
  });
});

/** The first bytes of real files, by format. */
const MAGIC: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1],
  gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0],
  webp: [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  // Not images to the gateway, whatever they are declared as:
  caf: [0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0, 0x64, 0x65, 0x73, 0x63], // "caff" — audio/x-caf
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3],
  wav: [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], // RIFF….WAVE
  zeros: [],
};
const bytesOf = (format: string) => Uint8Array.from(MAGIC[format] ?? []);

describe("which bytes are an image to the gateway (it sniffs; the declared type is not asked)", () => {
  it("recognises PNG, JPEG, GIF and WebP by their signature", () => {
    for (const format of ["png", "jpeg", "gif", "webp"]) {
      expect(isKnownImageSignature(bytesOf(format)), format).toBe(true);
    }
  });
  it("says NOT KNOWN for everything else: other formats, short or absent heads", () => {
    for (const format of ["caf", "pdf", "wav", "zeros"]) {
      expect(isKnownImageSignature(bytesOf(format)), format).toBe(false);
    }
    expect(isKnownImageSignature(bytesOf("png").subarray(0, 6))).toBe(false);
    // Too short to be a file at all: three bytes that happen to open like a JPEG.
    expect(isKnownImageSignature(bytesOf("jpeg").subarray(0, 3))).toBe(false);
    expect(isKnownImageSignature(null)).toBe(false);
    expect(isKnownImageSignature(undefined)).toBe(false);
  });
});

describe("the ceiling an attachment faces", () => {
  const BOTH = { maxBytes: 19_000_000, maxImageBytes: 6291456 };
  it("is the image ceiling for a known image, the file ceiling otherwise", () => {
    expect(attachmentCeilingFor(true, BOTH)).toBe(6291456);
    expect(attachmentCeilingFor(false, BOTH)).toBe(19_000_000);
  });

  it("is unknown (null) where the gateway enforces nothing beyond the frame", () => {
    expect(attachmentCeilingFor(false, CAPTURED)).toBeNull();
    expect(attachmentCeilingFor(true, CAPTURED)).toBe(6291456);
    // An image also faces a file ceiling smaller than the image one.
    expect(attachmentCeilingFor(true, { maxBytes: 1000, maxImageBytes: null })).toBe(1000);
    expect(attachmentCeilingFor(true, { maxBytes: null, maxImageBytes: null })).toBeNull();
  });

  it("measures the DECODED size, as the gateway does", () => {
    expect(decodedBase64Bytes("")).toBe(0);
    expect(decodedBase64Bytes("QQ==")).toBe(1);
    expect(decodedBase64Bytes("QUI=")).toBe(2);
    expect(decodedBase64Bytes("QUJD")).toBe(3);
    expect(decodedBase64Bytes(Buffer.alloc(1000).toString("base64"))).toBe(1000);
  });
});

/** An inline attachment of exactly `bytes` decoded bytes, DECLARED as `mimeType`. Its
 *  content starts like a real file of `format` — by default the format the declared type
 *  names, so a test that lies about the type says so. */
const inline = (bytes: number, mimeType: string, format = mimeType.split("/")[1] ?? "zeros") => {
  const body = Buffer.alloc(bytes);
  body.set(bytesOf(format).subarray(0, bytes));
  return { type: "file", mimeType, fileName: "f", content: body.toString("base64") };
};

describe("firstOversizedAttachment", () => {
  const SMALL = { maxBytes: 3000, maxImageBytes: 1000 };

  it("passes what the gateway accepts: a size EQUAL to the ceiling is not over it", () => {
    expect(firstOversizedAttachment([inline(1000, "image/png"), inline(3000, "application/pdf")], SMALL)).toBeNull();
  });

  it("names the image over the image ceiling though it is under the file ceiling", () => {
    expect(firstOversizedAttachment([inline(500, "image/png"), inline(1001, "image/jpeg")], SMALL)).toEqual({
      index: 1,
      decodedBytes: 1001,
      ceiling: 1000,
      image: true,
    });
  });

  it("names the file over the file ceiling", () => {
    expect(firstOversizedAttachment([inline(3001, "application/pdf")], SMALL)).toEqual({
      index: 0,
      decodedBytes: 3001,
      ceiling: 3000,
      image: false,
    });
  });

  it("a NON-image declared image/png faces the FILE ceiling, as it does at the gateway", () => {
    // A CAF voice memo declared image/png: the gateway sniffs audio/x-caf and applies
    // `maxBytes`. Refusing it at the image ceiling would refuse a file the gateway takes.
    expect(firstOversizedAttachment([inline(1001, "image/png", "caf")], SMALL)).toBeNull();
    expect(firstOversizedAttachment([inline(3000, "image/png", "caf")], SMALL)).toBeNull();
    expect(firstOversizedAttachment([inline(3001, "image/png", "caf")], SMALL)).toEqual({
      index: 0,
      decodedBytes: 3001,
      ceiling: 3000,
      image: false,
    });
  });

  it("a real image declared application/octet-stream faces the IMAGE ceiling: the bytes decide", () => {
    expect(firstOversizedAttachment([inline(1001, "application/octet-stream", "png")], SMALL)).toMatchObject({
      ceiling: 1000,
      image: true,
    });
  });

  it("an image format outside the four known signatures is not held to the image ceiling early", () => {
    // image/heic, image/svg+xml…: not known to be an image here — the gateway decides.
    expect(firstOversizedAttachment([inline(1001, "image/heic", "zeros")], SMALL)).toBeNull();
  });

  it("refuses nothing when the ceilings are unknown, or the list is not one", () => {
    expect(firstOversizedAttachment([inline(999_999, "image/png")], null)).toBeNull();
    // A file ceiling that is only the frame budget is not a ceiling: the 19.5 MB file
    // the gateway takes is not named here (the frame check owns that bound).
    expect(firstOversizedAttachment([{ mimeType: "application/pdf", content: "A".repeat(26_000_000) }], CAPTURED)).toBeNull();
    expect(firstOversizedAttachment(undefined, SMALL)).toBeNull();
    expect(firstOversizedAttachment([null, { mimeType: "image/png" }, "x"], SMALL)).toBeNull();
  });
});

describe("the ceilings are a handshake fact: kept, vouched for, and forgotten on a config change", () => {
  const configChanged = { type: "event", event: "config.changed", payload: { path: "/x/openclaw.json", hash: "hmac-sha256:v1:r2", ts: 1 } };

  it("the connection keeps what the hello-ok advertised, and vouches for it", async () => {
    const gateway = startWsFakeGateway({ version: "2026.9.36", policy: { ...CAPTURED_HELLO_POLICY } });
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    try {
      expect(conn.attachmentCeilings).toEqual(CAPTURED);
      expect(conn.attachmentCeilingsVouched).toBe(true);
      expect(conn.handshakeAt).toBeGreaterThan(0);
    } finally {
      conn.close();
      await gateway.stop();
    }
  });

  it("a gateway that advertises none leaves them unknown", async () => {
    const gateway = startWsFakeGateway({ version: "2026.7.1" });
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    try {
      expect(conn.attachmentCeilings).toBeNull();
    } finally {
      conn.close();
      await gateway.stop();
    }
  });

  it("a config.changed makes them UNKNOWN on this socket: the limit reloads hot and a raised one must not keep refusing", async () => {
    // mediaMaxMb 1 MiB at the handshake; the operator raises it to 5 MiB. The gateway
    // sends `config.changed`, keeps every socket open, and judges the next send on the
    // new value. The socket's 1 MiB is no longer a fact.
    const gateway = startWsFakeGateway({
      version: "2026.9.36",
      policy: policy({ maxBytes: 1 * MiB, maxImageBytes: 1 * MiB }),
    });
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    try {
      expect(conn.attachmentCeilings).toEqual({ maxBytes: 1 * MiB, maxImageBytes: 1 * MiB });
      const frames = conn.frames();
      gateway.push(configChanged);
      await frames.next();
      expect(conn.attachmentCeilings).toBeNull();
      expect(conn.attachmentCeilingsVouched).toBe(false);
      // The 2 MiB file the gateway now accepts is not refused by the send guard.
      expect(firstOversizedAttachment([inline(2 * MiB, "application/pdf")], conn.attachmentCeilings)).toBeNull();
    } finally {
      conn.close();
      await gateway.stop();
    }
  });

  it("a frame gap does the same: the lost frame may have been the config.changed (sent dropIfSlow)", async () => {
    const gateway = startWsFakeGateway({
      version: "2026.9.36",
      policy: policy({ maxBytes: 1 * MiB, maxImageBytes: 1 * MiB }),
    });
    await gateway.ready;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    try {
      const frames = conn.frames();
      gateway.push({ type: "event", event: "tick", payload: { ts: 1 }, seq: 1 });
      await frames.next();
      expect(conn.attachmentCeilingsVouched).toBe(true);
      gateway.push({ type: "event", event: "tick", payload: { ts: 2 }, seq: 5 });
      await frames.next();
      expect(conn.attachmentCeilings).toBeNull();
      expect(conn.attachmentCeilingsVouched).toBe(false);
    } finally {
      conn.close();
      await gateway.stop();
    }
  });

  it("a chat.metadata.changed is not a config revision: the ceilings stand", async () => {
    const gateway = startWsFakeGateway({ version: "2026.9.36", policy: { ...CAPTURED_HELLO_POLICY } });
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    try {
      const frames = conn.frames();
      gateway.push({ type: "event", event: "chat.metadata.changed", payload: { authChanged: false, modelCatalogChanged: true } });
      await frames.next();
      expect(conn.attachmentCeilings).toEqual(CAPTURED);
      expect(conn.attachmentCeilingsVouched).toBe(true);
    } finally {
      conn.close();
      await gateway.stop();
    }
  });
});

describe("/health publishes an instance's ceilings only while a live socket vouches for them", () => {
  const REF = { key: "u", instanceName: "primary", canonical: "u", agentId: "main", gatewayHost: "h" };
  const A = { maxBytes: 1 * MiB, maxImageBytes: 1 * MiB };
  const liveTarget = (
    instanceName: string,
    ceilings: { maxBytes: number | null; maxImageBytes: number | null } | null,
    over: Record<string, unknown> = {},
  ) => ({
    canonical: "someone-else",
    agentId: "main",
    instanceName,
    gatewayVersion: "2026.9.36",
    maxPayload: MAX_PAYLOAD,
    attachmentCeilings: ceilings,
    attachmentCeilingsVouched: true,
    handshakeAt: 100,
    ...over,
  });
  const health = (...instances: string[]) => {
    const h = new HealthRegistry(0, () => 1);
    for (const instanceName of instances) h.recordOk({ ...REF, key: `${instanceName}:u`, instanceName });
    return h.snapshot();
  };
  const byInstance = (e: ReturnType<typeof enrichHealthSnapshot>) =>
    new Map(e.targets.map((t) => [t.instanceName, { maxBytes: t.attachmentMaxBytes, maxImageBytes: t.attachmentMaxImageBytes }]));
  const UNKNOWN = { maxBytes: null, maxImageBytes: null };

  it("THE FIRST SEND of a second instance: A's 1 MiB is never handed to B, to Hermes, nor to a reader that names no instance", () => {
    // Instance A (1 MiB) is in use. B (5 MiB configured) and a Hermes instance have a
    // health row and no socket yet: their ceiling is UNKNOWN, so a 2 MiB PDF for B is
    // not refused before the send that would open B's socket.
    const enriched = enrichHealthSnapshot(health("a", "b", "hermes"), [liveTarget("a", A)]);
    const got = byInstance(enriched);
    expect(got.get("a")).toEqual(A);
    expect(got.get("b")).toEqual(UNKNOWN);
    expect(got.get("hermes")).toEqual(UNKNOWN);
    // No instance-less value exists at all: nothing to apply to the wrong instance.
    expect(enriched).not.toHaveProperty("attachmentMaxBytes");
    expect(enriched).not.toHaveProperty("attachmentMaxImageBytes");
  });

  it("the ceilings are the INSTANCE's: another user's socket on the same gateway vouches for every target of it", () => {
    const enriched = enrichHealthSnapshot(health("a"), [liveTarget("a", A)]);
    expect(byInstance(enriched).get("a")).toEqual(A);
  });

  it("a socket that heard a config change no longer vouches: unknown until a newer handshake", () => {
    // Even if the stale socket's object still carried its old numbers, it does not speak.
    const stale = liveTarget("a", A, { attachmentCeilingsVouched: false });
    expect(byInstance(enrichHealthSnapshot(health("a"), [stale])).get("a")).toEqual(UNKNOWN);
    // A socket opened AFTER the change read the current value: it speaks, whatever
    // the order the sessions are listed in.
    const fresh = liveTarget("a", { maxBytes: 5 * MiB, maxImageBytes: 5 * MiB }, { handshakeAt: 200 });
    for (const live of [[stale, fresh], [fresh, stale]]) {
      expect(byInstance(enrichHealthSnapshot(health("a"), live)).get("a")).toEqual({
        maxBytes: 5 * MiB,
        maxImageBytes: 5 * MiB,
      });
    }
  });

  it("the NEWEST vouching socket speaks, including when it says the gateway enforces none", () => {
    const older = liveTarget("a", A, { handshakeAt: 100 });
    const newer = liveTarget("a", null, { handshakeAt: 300 });
    for (const live of [[older, newer], [newer, older]]) {
      expect(byInstance(enrichHealthSnapshot(health("a"), live)).get("a")).toEqual(UNKNOWN);
    }
  });

  it("nothing is remembered once no socket is live", () => {
    expect(byInstance(enrichHealthSnapshot(health("a"), [])).get("a")).toEqual(UNKNOWN);
  });
});

describe("the send path refuses an attachment the gateway would refuse", () => {
  const config = {
    openclawGatewayUrl: "ws://127.0.0.1:1",
    openclawToken: "t",
    deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    instanceName: "primary",
  } as unknown as BridgeConfig;
  const ROUTING = {
    chatId: "c1",
    openclawChatId: "turn:x",
    agentId: "alice",
    canonical: "olivier",
    instanceName: "primary",
  };
  const bodyWith = (attachments: unknown[]) =>
    ({
      ...ROUTING,
      text: "regarde",
      clientMessageId: "cm-1",
      messageId: "um-1",
      providerResetCount: null,
      outboxId: "ob-1",
      dispatchAgeMs: 0,
      switchedFromAgentId: null,
      switchedFromInstanceName: null,
      sessionSettings: null,
      referenceAttachments: [],
      attachments,
      config: { rehydration: false },
    }) as unknown as Parameters<typeof performSend>[1];

  async function harness(ceilings: { maxBytes: number; maxImageBytes: number } | null) {
    const gw = fakeGateway({ describe: [{ sessionId: "s-1", systemSent: true }] });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addToolPart: async () => {},
      addMedia: async () => {},
      finalize: async () => {},
      reportSessionMeta: async () => {},
      recordGatewayPressure: async () => {},
      clearSessionState: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      emitRehydrateTrace: () => {},
    } as unknown as ConvexWriter;
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const conn = session.connection as unknown as FakeGateway & {
      gatewayVersion: string;
      attachmentCeilings: unknown;
    };
    conn.gatewayVersion = "2026.9.36";
    conn.maxPayload = MAX_PAYLOAD;
    conn.attachmentCeilings = ceilings;
    return { gw: conn, session, writer };
  }

  it("a recording declared image/png, over the image ceiling and under the file one, IS sent", async () => {
    const { gw, session, writer } = await harness({ maxBytes: 3000, maxImageBytes: 1000 });
    await performSend(session, bodyWith([inline(2000, "image/png", "caf")]), writer, null, "/media/outbound");
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("an image over the image ceiling is refused BEFORE chat.send, as an attachment too large", async () => {
    const { gw, session, writer } = await harness({ maxBytes: 3000, maxImageBytes: 1000 });
    const failure = await performSend(session, bodyWith([inline(1001, "image/png")]), writer, null, "/media/outbound").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(gw.countOf("chat.send")).toBe(0);
    expect(classifyGatewayError(failure, { hasAttachments: true })).toBe("ATTACHMENT_TOO_LARGE");
  });

  it("the same image is sent when it is within the ceiling, or when the gateway advertised none", async () => {
    const within = await harness({ maxBytes: 3000, maxImageBytes: 1000 });
    await performSend(within.session, bodyWith([inline(1000, "image/png")]), within.writer, null, "/media/outbound");
    expect(within.gw.countOf("chat.send")).toBe(1);
    vi.restoreAllMocks();
    const unknown = await harness(null);
    await performSend(unknown.session, bodyWith([inline(1001, "image/png")]), unknown.writer, null, "/media/outbound");
    expect(unknown.gw.countOf("chat.send")).toBe(1);
  });
});

describe("GET /health follows the live socket: ceilings while it vouches, unknown after a config change or once it is gone", () => {
  const config = {
    openclawGatewayUrl: "ws://127.0.0.1:1",
    openclawToken: "t",
    deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    instanceName: "primary",
    bridgeSharedSecret: "s",
    maxBodyBytes: 64 * 1024 * 1024,
  } as unknown as BridgeConfig;
  const ROUTING = { chatId: "c1", openclawChatId: "turn:x", agentId: "alice", canonical: "olivier", instanceName: "primary" };
  const LIMITS = { maxBytes: 1 * MiB, maxImageBytes: 1 * MiB };
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = null;
  });

  it("end to end through the registry and the route", async () => {
    const gw = fakeGateway({ describe: [{ sessionId: "s-1", systemSent: true }] });
    Object.assign(gw, {
      maxPayload: MAX_PAYLOAD,
      attachmentCeilings: LIMITS,
      attachmentCeilingsVouched: true,
      handshakeAt: 10,
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const served = servedMap(config, {} as ConvexWriter);
    const registry = new SessionRegistry(served, () => 1000);
    const health = new HealthRegistry(1000, () => 2000);
    health.recordOk({ key: "primary:olivier", instanceName: "primary", canonical: "olivier", agentId: "alice", gatewayHost: "h" });
    server = createBridgeServer({ shared: sharedFromConfig(config), served, registry, health });
    await new Promise<void>((res) => server!.listen(0, res));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    type Body = Record<string, unknown> & {
      targets: { attachmentMaxBytes: number | null; attachmentMaxImageBytes: number | null }[];
    };
    const read = async () => (await (await fetch(url)).json()) as Body;
    const UNKNOWN = { attachmentMaxBytes: null, attachmentMaxImageBytes: null };
    try {
      expect((await read()).targets[0]).toMatchObject(UNKNOWN);

      const session = await registry.acquire(ROUTING);
      await sleep(5);
      const live = await read();
      expect(live.targets[0]).toMatchObject({ attachmentMaxBytes: 1 * MiB, attachmentMaxImageBytes: 1 * MiB });
      expect(live).not.toHaveProperty("attachmentMaxBytes");

      // The operator raises the limit: the socket heard `config.changed`.
      Object.assign(gw, { attachmentCeilings: null, attachmentCeilingsVouched: false });
      expect((await read()).targets[0]).toMatchObject(UNKNOWN);

      // …and a value is not resurrected from memory once the socket is gone either.
      Object.assign(gw, { attachmentCeilings: LIMITS, attachmentCeilingsVouched: true });
      expect((await read()).targets[0]).toMatchObject({ attachmentMaxBytes: 1 * MiB });
      session.connection.close();
      expect((await read()).targets[0]).toMatchObject(UNKNOWN);
    } finally {
      registry.closeAll();
    }
  });
});
