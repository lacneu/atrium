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
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachmentCeilingFor,
  decodedBase64Bytes,
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

const CAPTURED = { maxBytes: 19464192, maxImageBytes: 6291456 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readAttachmentCeilings", () => {
  it("reads the two ceilings the gateway advertises (captured hello-ok)", () => {
    expect(readAttachmentCeilings(CAPTURED_HELLO_POLICY)).toEqual(CAPTURED);
  });

  it("is null when the gateway advertises none (before 2026.8.1)", () => {
    expect(readAttachmentCeilings({ maxPayload: MAX_PAYLOAD, maxBufferedBytes: MAX_BUFFERED })).toBeNull();
    expect(readAttachmentCeilings(undefined)).toBeNull();
    expect(readAttachmentCeilings(null)).toBeNull();
  });

  it("is null on a zero, negative or malformed ceiling rather than refusing every file", () => {
    for (const attachments of [
      { maxBytes: 0, maxImageBytes: 6291456 },
      { maxBytes: 19464192, maxImageBytes: 0 },
      { maxBytes: -1, maxImageBytes: -1 },
      { maxBytes: "19464192", maxImageBytes: 6291456 },
      { maxBytes: Number.NaN, maxImageBytes: 6291456 },
      { maxBytes: 19464192 },
      "20MB",
      [],
      null,
    ]) {
      expect(readAttachmentCeilings({ attachments }), JSON.stringify(attachments)).toBeNull();
    }
  });

  it("never lets the image ceiling exceed the file ceiling", () => {
    expect(readAttachmentCeilings({ attachments: { maxBytes: 1000, maxImageBytes: 5000 } })).toEqual({
      maxBytes: 1000,
      maxImageBytes: 1000,
    });
  });

  it("covers a real gap: the captured file ceiling is BELOW what the frame alone admits", () => {
    // Without it, a file between the two was uploaded, then refused by the gateway.
    expect(CAPTURED.maxBytes).toBeLessThan(maxRawInboundBytes(MAX_PAYLOAD));
  });
});

describe("the ceiling an attachment faces", () => {
  it("is the image ceiling for any image/* type, the file ceiling otherwise", () => {
    for (const mime of ["image/png", "image/jpeg", "IMAGE/PNG", "image/svg+xml", "image/heic", " image/webp"]) {
      expect(attachmentCeilingFor(mime, CAPTURED), mime).toBe(6291456);
    }
    for (const mime of ["application/pdf", "video/mp4", "text/plain", "", undefined, null, 7]) {
      expect(attachmentCeilingFor(mime, CAPTURED), String(mime)).toBe(19464192);
    }
  });

  it("measures the DECODED size, as the gateway does", () => {
    expect(decodedBase64Bytes("")).toBe(0);
    expect(decodedBase64Bytes("QQ==")).toBe(1);
    expect(decodedBase64Bytes("QUI=")).toBe(2);
    expect(decodedBase64Bytes("QUJD")).toBe(3);
    expect(decodedBase64Bytes(Buffer.alloc(1000).toString("base64"))).toBe(1000);
  });
});

/** An inline attachment of exactly `bytes` decoded bytes. */
const inline = (bytes: number, mimeType: string) => ({
  type: "file",
  mimeType,
  fileName: "f",
  content: Buffer.alloc(bytes).toString("base64"),
});

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

  it("refuses nothing when the ceilings are unknown, or the list is not one", () => {
    expect(firstOversizedAttachment([inline(999_999, "image/png")], null)).toBeNull();
    expect(firstOversizedAttachment(undefined, SMALL)).toBeNull();
    expect(firstOversizedAttachment([null, { mimeType: "image/png" }, "x"], SMALL)).toBeNull();
  });
});

describe("the ceilings travel: handshake → connection → /health", () => {
  it("the connection keeps what the hello-ok advertised", async () => {
    const gateway = startWsFakeGateway({ version: "2026.9.36", policy: { ...CAPTURED_HELLO_POLICY } });
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    try {
      expect(conn.attachmentCeilings).toEqual(CAPTURED);
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

  const REF = { key: "u", instanceName: "primary", canonical: "u", agentId: "main", gatewayHost: "h" };
  const liveTarget = (instanceName: string, ceilings: typeof CAPTURED | null) => ({
    canonical: "u",
    agentId: "main",
    instanceName,
    gatewayVersion: "2026.9.36",
    maxPayload: MAX_PAYLOAD,
    attachmentCeilings: ceilings,
  });

  it("/health publishes them per target, and the smallest of each at the top", () => {
    const h = new HealthRegistry(0, () => 1);
    h.recordOk({ ...REF, key: "a:u", instanceName: "a" });
    h.recordOk({ ...REF, key: "b:u", instanceName: "b" });
    h.recordOk({ ...REF, key: "old:u", instanceName: "old" });
    const enriched = enrichHealthSnapshot(h.snapshot(), [
      liveTarget("a", CAPTURED),
      liveTarget("b", { maxBytes: 5_000_000, maxImageBytes: 5_000_000 }),
      liveTarget("old", null),
    ]);
    const byInstance = new Map(enriched.targets.map((t) => [t.instanceName, t]));
    expect(byInstance.get("a")).toMatchObject({ attachmentMaxBytes: 19464192, attachmentMaxImageBytes: 6291456 });
    expect(byInstance.get("b")).toMatchObject({ attachmentMaxBytes: 5_000_000, attachmentMaxImageBytes: 5_000_000 });
    // A gateway that advertises none: unknown, never another instance's.
    expect(byInstance.get("old")).toMatchObject({ attachmentMaxBytes: null, attachmentMaxImageBytes: null });
    expect(enriched.attachmentMaxBytes).toBe(5_000_000);
    expect(enriched.attachmentMaxImageBytes).toBe(5_000_000);
  });

  it("/health falls back to an idle instance's last-seen ceilings, and to null when none is known", () => {
    const h = new HealthRegistry(0, () => 1);
    h.recordOk({ ...REF, key: "idle:u", instanceName: "idle" });
    const none = enrichHealthSnapshot(h.snapshot(), []);
    expect(none.attachmentMaxBytes).toBeNull();
    expect(none.attachmentMaxImageBytes).toBeNull();
    expect(none.targets[0]).toMatchObject({ attachmentMaxBytes: null, attachmentMaxImageBytes: null });
    const seen = enrichHealthSnapshot(h.snapshot(), [], new Map(), null, new Map([["idle", CAPTURED]]));
    expect(seen.targets[0]).toMatchObject({ attachmentMaxBytes: 19464192, attachmentMaxImageBytes: 6291456 });
    expect(seen.attachmentMaxImageBytes).toBe(6291456);
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

describe("GET /health carries a live session's ceilings, and keeps them once it is idle", () => {
  const config = {
    openclawGatewayUrl: "ws://127.0.0.1:1",
    openclawToken: "t",
    deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
    instanceName: "primary",
    bridgeSharedSecret: "s",
    maxBodyBytes: 64 * 1024 * 1024,
  } as unknown as BridgeConfig;
  const ROUTING = { chatId: "c1", openclawChatId: "turn:x", agentId: "alice", canonical: "olivier", instanceName: "primary" };
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = null;
  });

  it("per target and at the top, from the handshake of the session that is live", async () => {
    const gw = fakeGateway({ describe: [{ sessionId: "s-1", systemSent: true }] });
    Object.assign(gw, { maxPayload: MAX_PAYLOAD, attachmentCeilings: CAPTURED });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const served = servedMap(config, {} as ConvexWriter);
    const registry = new SessionRegistry(served, () => 1000);
    const health = new HealthRegistry(1000, () => 2000);
    health.recordOk({ key: "primary:olivier", instanceName: "primary", canonical: "olivier", agentId: "alice", gatewayHost: "h" });
    server = createBridgeServer({ shared: sharedFromConfig(config), served, registry, health });
    await new Promise<void>((res) => server!.listen(0, res));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    type Body = {
      attachmentMaxBytes: number | null;
      attachmentMaxImageBytes: number | null;
      targets: { attachmentMaxBytes: number | null; attachmentMaxImageBytes: number | null }[];
    };
    try {
      // No session yet, nothing seen: unknown.
      const cold = (await (await fetch(url)).json()) as Body;
      expect(cold.attachmentMaxBytes).toBeNull();
      expect(cold.targets[0]).toMatchObject({ attachmentMaxBytes: null, attachmentMaxImageBytes: null });

      const session = await registry.acquire(ROUTING);
      await sleep(5);
      const live = (await (await fetch(url)).json()) as Body;
      expect(live.attachmentMaxBytes).toBe(19464192);
      expect(live.attachmentMaxImageBytes).toBe(6291456);
      expect(live.targets[0]).toMatchObject({ attachmentMaxBytes: 19464192, attachmentMaxImageBytes: 6291456 });

      // The socket closes: the instance's last-seen ceilings keep being published.
      session.connection.close();
      const idle = (await (await fetch(url)).json()) as Body;
      expect(idle.targets[0]).toMatchObject({ attachmentMaxBytes: 19464192, attachmentMaxImageBytes: 6291456 });
      expect(idle.attachmentMaxImageBytes).toBe(6291456);
    } finally {
      registry.closeAll();
    }
  });
});
