// OpenClaw Gateway WebSocket client.
//
// Faithful TS port of backend/app/openclaw_client.py (verified against the
// production Open WebUI pipe). Load-bearing details, do NOT "simplify":
//   - connect.challenge -> Ed25519-sign the payload
//       v2|deviceId|clientId|clientMode|role|scopes|ts|token|nonce
//     with clientId="cli" AND clientMode="cli" (these classify the connection
//     as channel=webchat; "web" lands elsewhere) and `ts` used VERBATIM as the
//     gateway issued it (fabricating ts yields an unverifiable signature).
//   - signature is base64url, '=' padding stripped.
//   - WS ping disabled (the gateway drives keepalive; a client ping it never
//     answers tears the socket down).
//   - request/response correlation by `id`; res frames are {type:res,id,ok,
//     payload|error}. Non-res frames are pushed to an inbound queue.
//   - clean close on gateway close/error/timeout: reject all pending requests,
//     signal the inbound consumer, and terminate the socket (no zombie).

import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import WebSocket, { type RawData } from "ws";

import type { DeviceIdentity } from "../../config.js";

// DEV-ONLY raw-frame capture. When OPENCLAW_CAPTURE_FRAMES holds a file path, every
// inbound gateway frame is appended (full, untruncated) as one JSON line — the
// ground-truth material for building version-accurate fixtures + diagnosing how a
// given OpenClaw version (e.g. 6.5) actually transports media. Best-effort and
// LOCAL-ONLY: never set in prod, since raw frames can carry message content.
const CAPTURE_FRAMES_PATH =
  typeof process !== "undefined"
    ? process.env?.OPENCLAW_CAPTURE_FRAMES
    : undefined;
function captureFrame(frame: unknown): void {
  if (!CAPTURE_FRAMES_PATH) return;
  try {
    appendFileSync(CAPTURE_FRAMES_PATH, JSON.stringify(frame) + "\n");
  } catch {
    /* best-effort dev capture — never disturb the read loop */
  }
}

// Operator scopes the bridge requests at connect. `operator.admin` IS required:
// the bridge calls `sessions.patch` (to set verboseLevel=full) which the gateway
// gates behind `operator.admin` ("missing scope: operator.admin" otherwise).
// `read`/`write` cover chat.send + event streaming. NOTE (#61): the auth model is
// transport-trust based, NOT scope based — requesting admin only fails over an
// UNTRUSTED transport (plain ws from a non-loopback peer), which is why the local
// harness routes the host bridge through the oc-loopback socat sidecar
// (loopback = trusted) and production uses wss (also trusted). Over a trusted
// transport the gateway grants admin to the paired device normally.
const DEFAULT_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
] as const;

// Load-bearing client identity (see file header / backend/app/openclaw_client.py).
const CLIENT_ID = "cli";
const CLIENT_MODE = "cli";
const CLIENT_VERSION = "1.0.0";
const CLIENT_PLATFORM = "linux";
const CLIENT_ROLE = "operator";

// 30s (was 10s): a cold-start gateway — especially the emulated amd64 image on
// arm64 finishing plugin/codex init — can take >10s to complete the WS device
// handshake; 10s dropped the first message right after a (re)start. A real
// production cold start benefits too.
const CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class OpenClawError extends Error {}

// Debug instrumentation, gated by BRIDGE_DEBUG=1. Logs the handshake (incl. the
// gateway `server.version` — the version oracle the live harness keys on), every
// outgoing request (method + sessionKey ONLY — never the message text, no PHI),
// every correlated `res`/ack, and every raw inbound frame (the diagnosis +
// fixture material for the auto-adjust loop). Off by default; verbose at our
// scale only when explicitly enabled.
function dbg(...args: unknown[]): void {
  if (process.env.BRIDGE_DEBUG === "1") {
    console.log("[oc]", ...args);
  }
}

function clip(value: unknown, max = 1200): string {
  if (value === undefined) return "undefined";
  let s: string;
  if (typeof value === "string") s = value;
  else {
    const j = JSON.stringify(value);
    // JSON.stringify returns undefined for undefined/functions/symbols.
    s = typeof j === "string" ? j : String(value);
  }
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max})` : s;
}

/** A raw inbound gateway frame (anything that is not a request/response ack). */
export type GatewayFrame = Record<string, unknown> & { type?: unknown };

interface ResponseFrame {
  type: "res";
  id: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

/** Normalize a gateway URL to a ws:// or wss:// scheme. */
export function normalizeWsUrl(url: string): string {
  if (!url.includes("://")) {
    return `ws://${url}`;
  }
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme === "ws" || scheme === "wss") {
    return url;
  }
  if (scheme === "http") {
    return "ws://" + url.slice("http://".length);
  }
  if (scheme === "https") {
    return "wss://" + url.slice("https://".length);
  }
  throw new OpenClawError(`Unsupported OpenClaw Gateway URL scheme: ${scheme}`);
}

/** Build the signed device object for the connect request. */
export function signChallenge(
  device: DeviceIdentity,
  nonce: string,
  ts: unknown,
  token: string,
): Record<string, unknown> {
  const payload = [
    "v2",
    device.id,
    CLIENT_ID,
    CLIENT_MODE,
    CLIENT_ROLE,
    DEFAULT_SCOPES.join(","),
    String(ts),
    token,
    nonce,
  ].join("|");
  const key = createPrivateKey(device.privateKey);
  // Ed25519: the algorithm is null (the key type fixes it); pass the message
  // directly. Output base64url without '=' padding (mirrors the Python rstrip).
  const signature = cryptoSign(null, Buffer.from(payload, "utf8"), key);
  return {
    id: device.id,
    publicKey: device.publicKey,
    signature: signature.toString("base64url").replace(/=+$/, ""),
    signedAt: ts,
    nonce,
  };
}

interface PendingRequest {
  resolve: (frame: ResponseFrame) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A live, authenticated connection to the OpenClaw Gateway.
 *
 * Construct via `OpenClawConnection.connect(...)`. Inbound (non-ack) frames are
 * delivered through `frames()` (an async generator) which terminates cleanly
 * when the socket closes. Request/response is `request(method, params)`.
 */
export class OpenClawConnection {
  private readonly ws: WebSocket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queue: GatewayFrame[] = [];
  private waiter: ((frame: GatewayFrame | null) => void) | null = null;
  private closed = false;
  private closeError: Error | null = null;

  // The gateway applies verboseLevel=full once per connection (sticky); we
  // track it so chat.send does not re-patch every turn.
  verboseFullApplied = false;

  // Cached `models.list` (deduped {id,label}), fetched once per connection and
  // mirrored into sessionMeta so the header's model picker has a stable list.
  // `null` = not yet fetched; `[]` = fetched, none available.
  availableModels: { id: string; label: string }[] | null = null;

  // Gateway server version captured from the connect hello-ok payload
  // (`payload.server.version`, verified live — the same field the harness'
  // version oracle keys on). `null` when the handshake does not carry it; the
  // compat manifest then applies its CONSERVATIVE capability policy.
  gatewayVersion: string | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /** Connect and complete the Ed25519 handshake. Resolves once connect ok. */
  static connect(
    gatewayUrl: string,
    token: string,
    device: DeviceIdentity,
  ): Promise<OpenClawConnection> {
    return new Promise((resolve, reject) => {
      let settled = false;
      // ping_interval=None equivalent: ws does not auto-ping unless we ask.
      const ws = new WebSocket(normalizeWsUrl(gatewayUrl));

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        try {
          ws.terminate();
        } catch {
          /* socket may already be gone */
        }
        reject(err instanceof OpenClawError ? err : new OpenClawError(err.message));
      };

      const connectTimer = setTimeout(
        () => fail(new OpenClawError("OpenClaw connect handshake timed out")),
        CONNECT_TIMEOUT_MS,
      );

      ws.once("error", (err: Error) => fail(err));

      // Phase 1: await connect.challenge. Phase 2: await the connect res.
      let phase: "challenge" | "connect" = "challenge";
      let connection: OpenClawConnection | null = null;
      let reqId = "";

      ws.on("message", (raw: RawData) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return; // ignore malformed frames during handshake
        }
        if (phase === "challenge") {
          if (frame.type !== "event" || frame.event !== "connect.challenge") {
            fail(new OpenClawError("OpenClaw did not send connect.challenge"));
            return;
          }
          const challenge = (frame.payload ?? {}) as Record<string, unknown>;
          const nonce = challenge.nonce;
          const ts = challenge.ts;
          if (typeof nonce !== "string" || !nonce || ts === undefined || ts === null) {
            fail(new OpenClawError("connect.challenge missing nonce or ts"));
            return;
          }
          let signedDevice: Record<string, unknown>;
          try {
            signedDevice = signChallenge(device, nonce, ts, token);
          } catch (err) {
            fail(new OpenClawError(`device signing failed: ${(err as Error).message}`));
            return;
          }
          reqId = randomUUID();
          phase = "connect";
          ws.send(
            JSON.stringify({
              type: "req",
              id: reqId,
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 4,
                client: {
                  id: CLIENT_ID,
                  version: CLIENT_VERSION,
                  platform: CLIENT_PLATFORM,
                  mode: CLIENT_MODE,
                },
                role: CLIENT_ROLE,
                scopes: DEFAULT_SCOPES,
                auth: { token },
                device: signedDevice,
                locale: "en-US",
                userAgent: "atrium-bridge/0.1.0",
                caps: ["agent-events", "tool-events"],
              },
            }),
          );
          return;
        }
        // phase === "connect": expect the res for our connect request.
        if (frame.type !== "res" || frame.id !== reqId) {
          return; // ignore unrelated frames until our connect ack lands
        }
        if (frame.ok) {
          // hello-ok: server info is under `payload` (verified live: frame.payload
          // = {type:"hello-ok", protocol, server:{version,connId}, features,...}).
          const payload = (frame.payload ?? frame.result ?? {}) as Record<string, unknown>;
          const server = (payload.server ?? {}) as Record<string, unknown>;
          dbg(
            "connect hello-ok | server.version=",
            server.version ?? "?",
            "| connId=",
            server.connId ?? "?",
            "| role/scopes=",
            clip({ role: payload.role, scopes: payload.scopes }, 200),
          );
          dbg("connect hello-ok (raw):", clip(frame, 20000));
          settled = true;
          clearTimeout(connectTimer);
          connection = new OpenClawConnection(ws);
          // Capture the gateway version for the compat manifest (defensive:
          // an absent/non-string field leaves null -> conservative policy).
          connection.gatewayVersion =
            typeof server.version === "string" && server.version.length > 0
              ? server.version
              : null;
          connection.attachReader();
          resolve(connection);
          return;
        }
        const error = (frame.error ?? {}) as Record<string, unknown>;
        dbg("connect FAILED (raw):", clip(frame, 1500));
        fail(
          new OpenClawError(
            `${(error.code as string) ?? "CONNECT_FAILED"}: ` +
              `${(error.message as string) ?? "OpenClaw connect failed"}`,
          ),
        );
      });
    });
  }

  /**
   * Swap the handshake listeners for the steady-state reader. Called once the
   * connect ack lands. The handshake `message` listener stays attached but is a
   * no-op afterwards (phase is "connect" and ids no longer match); we add the
   * authoritative reader here.
   */
  private attachReader(): void {
    this.ws.removeAllListeners("message");
    this.ws.removeAllListeners("error");
    this.ws.on("message", (raw: RawData) => this.onMessage(raw));
    this.ws.on("error", (err: Error) => this.onClose(new OpenClawError(err.message)));
    this.ws.on("close", () =>
      this.onClose(new OpenClawError("OpenClaw Gateway connection closed")),
    );
  }

  private onMessage(raw: RawData): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return; // drop malformed frames
    }
    // DEV-ONLY ground-truth frame capture (see captureFrame): the FULL untruncated
    // frame exactly as received — fixture + version-diagnosis material. No-op unless
    // OPENCLAW_CAPTURE_FRAMES is set (never in prod: frames may carry content).
    captureFrame(frame);
    if (frame.type === "res") {
      const id = String(frame.id);
      dbg(
        "res <-",
        id,
        frame.ok ? "ok" : "ERR " + clip(frame.error, 300),
        frame.ok ? clip(frame.result, 400) : "",
      );
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve(frame as unknown as ResponseFrame);
      }
      return; // acks are correlated, never forwarded to the inbound consumer
    }
    // Raw inbound frame: the diagnosis + first-fixture material for the harness.
    dbg("frame <-", clip(frame));
    this.push(frame as GatewayFrame);
  }

  private push(frame: GatewayFrame): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(frame);
    } else {
      this.queue.push(frame);
    }
  }

  private onClose(err: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = err;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null); // unblock the inbound consumer so frames() terminates
    }
    try {
      this.ws.terminate();
    } catch {
      /* already gone */
    }
  }

  /**
   * Async iterator over inbound (non-ack) gateway frames. Terminates when the
   * socket closes. Consume in a `for await` loop in the run-manager.
   */
  async *frames(): AsyncGenerator<GatewayFrame> {
    while (true) {
      const buffered = this.queue.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) {
        return;
      }
      const next = await new Promise<GatewayFrame | null>((resolve) => {
        this.waiter = resolve;
      });
      if (next === null) {
        return; // closed while waiting
      }
      yield next;
    }
  }

  /** Send a request and await its correlated response (rejects on error/!ok). */
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<ResponseFrame> {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new OpenClawError("connection is closed"),
      );
    }
    // Log method + sessionKey ONLY — never params.message (the user text = PHI).
    dbg("req ->", method, "| key=", clip(params.sessionKey ?? params.key ?? "", 90));
    return new Promise<ResponseFrame>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OpenClawError(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (frame) => {
          if (frame.ok === false) {
            const error = frame.error ?? {};
            reject(
              new OpenClawError(
                `${error.code ?? "REQUEST_FAILED"}: ${error.message ?? method + " failed"}`,
              ),
            );
            return;
          }
          resolve(frame);
        },
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new OpenClawError((err as Error).message));
      }
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Cleanly close the socket and reject any in-flight requests. */
  close(): void {
    this.onClose(new OpenClawError("connection closed by bridge"));
  }
}

/**
 * Build the OpenClaw idempotencyKey for a send (mirror of the Python helper):
 * sha256("<sessionKey>|<clientMessageId>") so an at-least-once dispatch from
 * Convex never produces a duplicate gateway send.
 */
export async function idempotencyKey(
  sessionKey: string,
  clientMessageId: string | null | undefined,
): Promise<string> {
  if (!clientMessageId) {
    return `webchat-${randomUUID()}`;
  }
  const digest = createHash("sha256")
    .update(`${sessionKey}|${clientMessageId}`)
    .digest("hex");
  return `webchat-${digest}`;
}
