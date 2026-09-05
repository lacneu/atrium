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
import { createSeqTracker, type SeqGap } from "./frame-seq.js";
import {
  classifyConnectionEnd,
  readShutdownNotice,
  type ConnectionEnd,
  type ShutdownNotice,
} from "./connection-end.js";
import { decodeInboundFrame, protocolDrift } from "./protocol-drift.js";

// DEV-ONLY raw-frame capture. When OPENCLAW_CAPTURE_FRAMES holds a file path, every
// inbound gateway frame is appended (full, untruncated) as one JSON line — the
// ground-truth material for building version-accurate fixtures + diagnosing how a
// given OpenClaw version (e.g. 6.5) actually transports media. Best-effort and
// LOCAL-ONLY: never set in prod, since raw frames can carry message content.
//
// ENVELOPED, not bare. The frame alone cannot be replayed faithfully: the normalizer
// takes an injected clock, and every timeout and grace it implements (recv timeout,
// empty-final grace, lifecycle-end grace, private-ack grace) is a function of the delay
// BETWEEN frames. A capture without arrival times can only be replayed on a synthetic
// clock, which never reaches any of those thresholds — a golden corpus built from one is
// born blind to exactly the paths that decide whether a turn ends. `receivedAt` is the
// bridge's own wall clock, not gateway data: no frame field is added or modified.
const CAPTURE_FRAMES_PATH =
  typeof process !== "undefined"
    ? process.env?.OPENCLAW_CAPTURE_FRAMES
    : undefined;
function captureFrame(frame: unknown): void {
  if (!CAPTURE_FRAMES_PATH) return;
  try {
    appendFileSync(
      CAPTURE_FRAMES_PATH,
      JSON.stringify({ receivedAt: Date.now(), frame }) + "\n",
    );
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
  /** Buffered inbound frames, each carrying its WIRE size so the byte ceiling
   *  measures the CURRENT backlog. Tracking only a running total would never come
   *  back down, and a healthy long-lived connection would be closed as overflowing
   *  after 128 MiB of ordinary traffic (codex P1). */
  private readonly queue: { frame: GatewayFrame; bytes: number }[] = [];
  private waiter: ((frame: GatewayFrame | null) => void) | null = null;
  private closed = false;
  private closeError: Error | null = null;

  // The gateway applies verboseLevel=full once per connection (sticky); we
  // track it so chat.send does not re-patch every turn.
  verboseFullApplied = false;

  // Cached `models.list` (deduped {id,label}), mirrored into sessionMeta so the
  // header's model picker has a stable list.
  //
  // Keyed by OWNER, not per connection: from 2026.8.1 the request carries an
  // `agentId` and the answer is that agent's VISIBILITY scope, so one cache for a
  // multi-agent connection served the first agent's catalogue to every other chat
  // (codex). The key is the agent id, or `""` on the generations whose answer is
  // connection-wide.
  //
  // A FAILURE is cached too, but with an expiry: caching it forever left an empty
  // model picker with no message until the bridge restarted (the 2026-08-04 symptom),
  // while not caching it at all would pay an 8s timeout on every turn.
  modelsByOwner = new Map<
    string,
    { models: { id: string; label: string }[]; failedAt: number | null }
  >();

  // Gateway server version captured from the connect hello-ok payload
  // (`payload.server.version`, verified live — the same field the harness'
  // version oracle keys on). `null` when the handshake does not carry it; the
  // compat manifest then applies its CONSERVATIVE capability policy.
  gatewayVersion: string | null = null;

  // Max WS frame the gateway accepts, captured live from the hello-ok
  // `payload.policy.maxPayload` (observed 26214400 = 25 MiB). This is the ONE
  // authoritative limit for inbound attachments: they ride the JSON WS as inline
  // base64, so the whole chat.send frame (base64 ≈ raw×4/3 + envelope) must fit
  // here. The bridge enforces it (frame guard) and reports it so the composer +
  // Convex derive the same raw cap instead of hardcoding one. `null` until the
  // first connect (the server enforces regardless).
  maxPayload: number | null = null;

  // Per-connection send-buffer ceiling, from the hello-ok
  // `payload.policy.maxBufferedBytes` (50 MiB upstream). Past it the gateway
  // either DROPS our frames or closes us with `1008 "slow consumer"` — so this
  // is the number that makes that condition observable BEFORE it bites, instead
  // of being reconstructed after the fact from a hole in the seq counter.
  maxBufferedBytes: number | null = null;

  // NAMED CONNECTION END. A `shutdown` notice seen on this connection (the
  // gateway announcing its own restart), and the classification of how the
  // connection actually ended. `connectionEnd` stays null while the socket is
  // alive; the session reads it to attribute an HONEST cause to a turn that was
  // in flight instead of a blanket "connection lost".
  private shutdownNotice: ShutdownNotice | null = null;
  /** Set when WE closed for inbound overflow — the close that follows is ours. */
  private overflowClosing = false;
  connectionEnd: ConnectionEnd | null = null;
  /**
   * Carry over a `shutdown` notice seen DURING the handshake.
   *
   * The frame is broadcast to every connection, including one still shaking hands —
   * and it is consumed there, before this object exists. If the handshake then
   * SUCCEEDS, the installed reader will never see that frame again, so without this
   * hand-off the close that follows reads as an unexplained drop instead of the
   * restart the gateway announced (codex P2).
   */
  adoptShutdownNotice(notice: ShutdownNotice): void {
    this.shutdownNotice = notice;
  }

  /** True once the gateway announced a shutdown/restart on this connection. */
  get shutdownAnnounced(): boolean {
    return this.shutdownNotice !== null;
  }
  /** Inbound frames buffered but not yet consumed (drop-pressure witness). */
  get inboundQueueLen(): number {
    return this.queue.length;
  }

  /** …and their BYTES — the measure the ceiling actually enforces, and the one that
   *  says whether a connection is falling behind. Published (G-27) so the condition
   *  is observable before it bites, instead of reconstructed after a close. */
  get inboundQueueBytes(): number {
    return this.queuedBytes;
  }

  // ENVELOPE-SEQ CONTINUITY (frame-loss detection) — the contract and the
  // false-positive trap (targeted frames carry no seq) live in the pure
  // `frame-seq.ts` module so they are unit-testable without a socket.
  private readonly seq = createSeqTracker();
  /** Total frames the gateway is known to have dropped on this connection. */
  get gapsObserved(): number {
    return this.seq.missingTotal;
  }
  /** Set by the owner (session) to receive loss reports. */
  onFrameGap: ((gap: SeqGap) => void) | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /** Connect and complete the Ed25519 handshake. Resolves once connect ok. */
  static connect(
    gatewayUrl: string,
    token: string,
    device: DeviceIdentity,
    promoteDeviceToken?: (
      token: string,
      issuedAtMs?: number,
    ) => Promise<"stored" | "unchanged" | "superseded">,
    /**
     * How many promotions this chain has already performed. 0 = a re-issued token
     * is persisted AND reconnected with; 1 = it is persisted ONLY, and this socket
     * is kept.
     *
     * Both halves matter. Without the cap a gateway that mints a fresh token on
     * every connect drives an unbounded connect->promote->connect chain. Without
     * the persist-at-depth-1 half, the second handshake's token was DROPPED: the
     * live socket worked, but Convex and `config.openclawToken` still held the
     * first one, so the next reconnect — and every media request, which reads the
     * operator token per call — used a superseded credential.
     */
    promotionDepth = 0,
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
        reject(
          err instanceof OpenClawError ? err : new OpenClawError(err.message),
        );
      };

      const connectTimer = setTimeout(
        () => fail(new OpenClawError("OpenClaw connect handshake timed out")),
        CONNECT_TIMEOUT_MS,
      );

      ws.once("error", (err: Error) => fail(err));
      // A shutdown ANNOUNCED while we are still connecting. The connection object
      // does not exist yet (it is built at hello-ok), so the notice has nowhere to
      // live but here — and without it a send that coincides with a restart reports
      // a generic disconnect instead of the restart the gateway just announced
      // (codex P2).
      let handshakeShutdown: ShutdownNotice | null = null;
      // A clean socket close DURING the handshake (a 'close' with no preceding
      // 'error') would otherwise wait out the 30s connect timer before /send fails.
      // Fail fast. After a successful connect, attachReader removeAllListeners drops
      // this, and `fail` is a no-op once settled — so it can only fire mid-handshake.
      ws.once("close", (code: number, reason: Buffer) => {
        // A refusal can land AFTER our connect request and BEFORE hello-ok, i.e.
        // before the steady-state reader (and its classifier) is installed. Name it
        // here too, or an auth rejection reads as a plain disconnect and sends the
        // operator hunting for a network fault (codex P2). Same rule as the
        // steady-state path: the reason is matched, never propagated.
        const end = classifyConnectionEnd({
          code,
          reasonText: reason?.toString?.() ?? "",
          shutdown: handshakeShutdown,
        });
        fail(
          new OpenClawError(
            "OpenClaw closed the socket during connect" +
              (end.kind === "connection_closed" ? "" : ` [${end.kind}]`),
          ),
        );
      });

      // Phase 1: await connect.challenge. Phase 2: await the connect response.
      // Promotion persists the server-issued device token before reconnecting.
      let phase: "challenge" | "connect" | "promotion" = "challenge";
      let connection: OpenClawConnection | null = null;
      let reqId = "";

      ws.on("message", (raw: RawData) => {
        // One decoder for every transport (W9/C4). Parsing here meant a frame that
        // parses to `null` flowed on to the first property read and threw out of this
        // callback — during the handshake, before any session exists to absorb it.
        const frame = decodeInboundFrame(raw, "openclaw-handshake-parse");
        if (frame === null) return; // unreadable frame: reported inside, then ignored
        // Read a shutdown notice in EITHER phase, before anything else can reject
        // the frame: the gateway broadcasts it to every connection, including one
        // still shaking hands, and the close that follows must be named for what it
        // is. Recorded, never consumed — the phase logic below runs unchanged.
        const handshakeNotice = readShutdownNotice(frame);
        if (handshakeNotice) {
          handshakeShutdown = handshakeNotice;
          console.log(
            `[openclaw] gateway announced a shutdown DURING connect (restartExpectedMs=${
              handshakeNotice.restartExpectedMs ?? "unknown"
            })`,
          );
          return; // not the challenge nor our connect ack; keep waiting (or the close wins)
        }
        if (phase === "challenge") {
          if (frame.type !== "event" || frame.event !== "connect.challenge") {
            fail(new OpenClawError("OpenClaw did not send connect.challenge"));
            return;
          }
          const challenge = (frame.payload ?? {}) as Record<string, unknown>;
          const nonce = challenge.nonce;
          const ts = challenge.ts;
          if (
            typeof nonce !== "string" ||
            !nonce ||
            ts === undefined ||
            ts === null
          ) {
            fail(new OpenClawError("connect.challenge missing nonce or ts"));
            return;
          }
          let signedDevice: Record<string, unknown>;
          try {
            signedDevice = signChallenge(device, nonce, ts, token);
          } catch (err) {
            fail(
              new OpenClawError(
                `device signing failed: ${(err as Error).message}`,
              ),
            );
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
        if (phase !== "connect") return;
        // phase === "connect": expect the res for our connect request.
        if (frame.type !== "res" || frame.id !== reqId) {
          return; // ignore unrelated frames until our connect ack lands
        }
        if (frame.ok) {
          // hello-ok: server info is under `payload` (verified live: frame.payload
          // = {type:"hello-ok", protocol, server:{version,connId}, features,...}).
          const payload = (frame.payload ?? frame.result ?? {}) as Record<
            string,
            unknown
          >;
          const server = (payload.server ?? {}) as Record<string, unknown>;
          dbg(
            "connect hello-ok | server.version=",
            server.version ?? "?",
            "| connId=",
            server.connId ?? "?",
            "| role/scopes=",
            clip({ role: payload.role, scopes: payload.scopes }, 200),
          );
          const auth = (payload.auth ?? {}) as Record<string, unknown>;
          dbg("connect hello-ok metadata:", {
            payloadKeys: Object.keys(payload).sort(),
            authKeys: Object.keys(auth).sort(),
          });
          /**
           * Adopt THIS socket as the live connection. Extracted because the
           * handshake now has TWO ways of reaching it: the ordinary path, and a
           * device-token promotion that failed to persist. The hello-ok is already
           * in hand at both — the socket is authenticated and usable — so nothing
           * below may throw it away over a side-effect.
           */
          const finishConnection = (): void => {
            settled = true;
            clearTimeout(connectTimer);
            connection = new OpenClawConnection(ws);
            if (handshakeShutdown !== null) {
              connection.adoptShutdownNotice(handshakeShutdown);
            }
            // Capture the gateway version for the compat manifest (defensive:
            // an absent/non-string field leaves null -> conservative policy).
            connection.gatewayVersion =
              typeof server.version === "string" && server.version.length > 0
                ? server.version
                : null;
            // Capture the WS frame limit (policy.maxPayload) — the authoritative
            // inbound-attachment ceiling. Defensive: a non-number leaves null.
            const policy = (payload.policy ?? {}) as Record<string, unknown>;
            connection.maxPayload =
              typeof policy.maxPayload === "number" && policy.maxPayload > 0
                ? policy.maxPayload
                : null;
            connection.maxBufferedBytes =
              typeof policy.maxBufferedBytes === "number" &&
              policy.maxBufferedBytes > 0
                ? policy.maxBufferedBytes
                : null;
            // The gateway ANNOUNCES what it emits (G-70). Read before the reader is
            // attached, and read defensively: `features` is a closed object upstream, but
            // this is the connect path and a diagnostic must never be able to fail it.
            // The sensor itself total-catches; this guard only keeps a malformed payload
            // from throwing on property access.
            const features = (payload.features ?? {}) as Record<string, unknown>;
            protocolDrift.observeAnnouncedEvents(features.events);
            connection.attachReader();
            resolve(connection);
          };

          // DEVICE-TOKEN PROMOTION. `auth.deviceToken` is the gateway handing back a
          // durable per-device token to replace the bootstrap one. It is NOT declared
          // by the pinned contract (2026.7.1 vendors no frames.ts at all; the field
          // appears first in 2026.7.2-beta.5), so against an older gateway it simply
          // never arrives and this whole path stays dormant — which is why the dormant
          // case is LOGGED rather than left silent: a promoter that is configured and
          // never fires is indistinguishable from a broken one otherwise.
          const issuedDeviceToken = auth.deviceToken;
          // Promote even when the value EQUALS the token we connected with, as long
          // as this chain has not promoted yet. The gateway handing back the same
          // string still means "this is now your device token", and only the
          // promotion records that PROVENANCE. Skipping it left the row marked
          // `provisioner`, so a later enrollment was free to replace a token the
          // gateway had actually paired — locking the bridge out. At depth >= 1 an
          // equal value is simply the one we just stored, so there is nothing left
          // to record.
          const promotable =
            promoteDeviceToken !== undefined &&
            typeof issuedDeviceToken === "string" &&
            issuedDeviceToken.length > 0 &&
            (promotionDepth === 0 || issuedDeviceToken !== token);
          if (promotable && typeof issuedDeviceToken === "string") {
            // The handshake is OVER — hello-ok is in hand — so its deadline has
            // done its job. Left armed, it can fire DURING the promotion (which
            // carries its own, shorter timeout), terminate a socket that is already
            // authenticated, and reject the connection before the promotion has
            // even answered; the tolerant catch below would then find `settled` and
            // be unable to keep anything.
            clearTimeout(connectTimer);
            phase = "promotion";
            // The gateway states WHEN it issued this token. Carried through so a
            // slower handshake cannot overwrite a newer token with an older one —
            // concurrent connections to the same gateway are each handed their own.
            const issuedAtMs =
              typeof auth.issuedAtMs === "number" ? auth.issuedAtMs : undefined;
            void promoteDeviceToken(issuedDeviceToken, issuedAtMs)
              .then((outcome) => {
                if (settled) return;
                // A SUPERSEDED promotion means a concurrent handshake already
                // stored a newer token. Reconnecting with ours would walk backwards
                // to a credential Convex has deliberately replaced; keep the socket
                // we have, which the gateway itself just authenticated.
                if (outcome === "superseded") {
                  finishConnection();
                  return;
                }
                // AT DEPTH 1 the token is now persisted and in memory; keep THIS
                // socket. Reconnecting again is what would be unbounded, and there
                // is nothing left to gain: we are already authenticated with the
                // very token we just stored.
                // Nothing to reconnect for when the token did not change, or when
                // this chain has already spent its one reconnect.
                if (promotionDepth >= 1 || issuedDeviceToken === token) {
                  finishConnection();
                  return;
                }
                settled = true;
                ws.removeAllListeners();
                ws.close(1000, "device token promoted");
                // Exactly TWO sockets at most: this reconnect may still persist a
                // token the gateway re-issues, but it can no longer reconnect.
                resolve(
                  OpenClawConnection.connect(
                    gatewayUrl,
                    issuedDeviceToken,
                    device,
                    promoteDeviceToken,
                    promotionDepth + 1,
                  ),
                );
              })
              .catch((err: unknown) => {
                if (settled) return;
                // The hello-ok already succeeded: this socket is authenticated and
                // usable RIGHT NOW. Persisting the token is a side-effect on a
                // DIFFERENT system (Convex), and the write it performs is idempotent,
                // so it costs nothing to retry on the next connect. Failing the
                // connection here would trade a working gateway for a transient
                // outage of the credential store — the bridge must never do that.
                console.log(
                  "[openclaw] device token promotion failed; keeping the " +
                    "authenticated connection and retrying on the next connect: " +
                    (err instanceof Error ? err.message : String(err)),
                );
                finishConnection();
              });
            return;
          }
          if (promoteDeviceToken !== undefined) {
            dbg(
              "device token promotion configured but the gateway issued none",
              "| gatewayVersion=",
              server.version ?? "?",
              "| authKeys=",
              Object.keys(auth).sort(),
            );
          }
          finishConnection();
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
    this.ws.on("error", (err: Error) =>
      this.onClose(new OpenClawError(err.message)),
    );
    this.ws.on("close", (code: number, reason: Buffer) =>
      this.onClose(new OpenClawError("OpenClaw Gateway connection closed"), {
        code,
        // Decoded HERE and consumed HERE: the classification needs the text
        // (`1008` alone cannot tell a slow consumer from a refused device), and
        // only the derived code leaves this call.
        reasonText: reason?.toString?.() ?? "",
      }),
    );
  }

  private onMessage(raw: RawData): void {
    let frame: Record<string, unknown>;
    // The WIRE size, measured before parsing: what the queue actually costs in
    // memory is the frame's bytes, not the fact that it is one frame.
    const wireBytes =
      typeof (raw as { length?: unknown }).length === "number"
        ? (raw as unknown as { length: number }).length
        : 0;
    // THE SHARED SOCKET. Every chat rides this connection, so an unreadable frame that
    // threw out of the callback took all of them with it — and said nothing.
    const decoded = decodeInboundFrame(raw, "openclaw-ws-parse");
    if (decoded === null) return; // unreadable frame: reported inside, then dropped
    frame = decoded;
    // DEV-ONLY ground-truth frame capture (see captureFrame): the FULL untruncated
    // frame exactly as received — fixture + version-diagnosis material. No-op unless
    // OPENCLAW_CAPTURE_FRAMES is set (never in prod: frames may carry content).
    captureFrame(frame);
    // ANNOUNCED SHUTDOWN — recorded here, at connection scope, because that is
    // what it describes: every session on this socket is about to lose it. The
    // frame is then queued UNCHANGED like any other (observe-only: the normalizer
    // still ignores it, and the drift detector still sees it), so this adds a
    // reading without removing one.
    const notice = readShutdownNotice(frame);
    if (notice) {
      this.shutdownNotice = notice;
      console.log(
        `[openclaw] gateway announced a shutdown (restartExpectedMs=${
          notice.restartExpectedMs ?? "unknown"
        })`,
      );
    }
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
    // Envelope-seq continuity: a hole means the gateway dropped frames destined
    // for US (slow-consumer protection). Report and keep going — the frames that
    // DID arrive are valid, so a loss must never interrupt the stream.
    const gap = this.seq.observe(frame);
    if (gap !== null) {
      console.warn(
        `[openclaw] frame gap: ${gap.missing} frame(s) lost (expected ${gap.expected}, received ${gap.received})`,
      );
      try {
        this.onFrameGap?.(gap);
      } catch {
        /* a loss report must never break the receive loop */
      }
    }
    // Raw inbound frame: the diagnosis + first-fixture material for the harness.
    dbg("frame <-", clip(frame));
    this.push(frame as GatewayFrame, wireBytes);
  }

  /**
   * Ceiling on frames buffered but not yet consumed.
   *
   * Unbounded, this queue is the bridge's own version of the gateway's slow-consumer
   * problem: a consumer that falls behind grows it until the process dies, taking
   * every session with it. Closing instead is the SAFE failure — the reconnect plus
   * transcript recovery already exist and are exercised, whereas an out-of-memory
   * kill loses everything in flight.
   */
  private static readonly MAX_INBOUND_QUEUE = 10_000;
  /**
   * …and a BYTE ceiling, which is the one that actually protects the process
   * (codex P1). A frame cap alone is not a memory bound: the gateway admits frames
   * up to `maxPayload` (25 MiB live), so ten thousand large ones are gigabytes of
   * retained JSON — an out-of-memory kill in exactly the scenario this guard exists
   * for. Whichever ceiling is reached first closes the connection.
   */
  private static readonly MAX_INBOUND_BYTES = 128 * 1024 * 1024;
  private queuedBytes = 0;

  private push(frame: GatewayFrame, wireBytes = 0): void {
    // A CLOSED connection accumulates nothing. Frames keep arriving for a moment
    // after we close (the socket takes time to tear down), and queueing them would
    // quietly rebuild the backlog we just dropped.
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(frame);
      return;
    }
    if (
      this.queue.length >= OpenClawConnection.MAX_INBOUND_QUEUE ||
      this.queuedBytes + wireBytes >= OpenClawConnection.MAX_INBOUND_BYTES
    ) {
      console.error(
        `[openclaw] inbound queue overflow (${this.queue.length} frames, ${this.queuedBytes} bytes) — closing the connection; recovery re-reads the transcript`,
      );
      this.overflowClosing = true;
      // DROP what is queued before closing (codex P2): `frames()` shifts from this
      // queue before it checks `closed`, so leaving it full means the consumer keeps
      // normalizing and writing for a long time instead of ending the turn and
      // letting transcript recovery take over — the very thing the close is for.
      this.queue.length = 0;
      this.queuedBytes = 0;
      try {
        this.ws.close(1013, "inbound overflow");
      } catch {
        /* the socket may already be gone; onClose still runs below */
      }
      this.onClose(new OpenClawError("inbound queue overflow"));
      return;
    }
    this.queuedBytes += wireBytes;
    this.queue.push({ frame, bytes: wireBytes });
  }

  private onClose(
    err: Error,
    socket?: { code?: number; reasonText?: string },
  ): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Name the end ONCE, at the moment it happens: the announced-shutdown notice
    // and the close code are both gone afterwards, and a turn still in flight is
    // about to be attributed a cause.
    this.connectionEnd = this.overflowClosing
      ? {
          kind: "inbound_overflow" as const,
          restartExpectedMs: null,
          reasonPresent: true,
        }
      : classifyConnectionEnd({
          code: socket?.code ?? null,
          reasonText: socket?.reasonText ?? null,
          shutdown: this.shutdownNotice,
        });
    // The name must survive EVERY exit, not just a turn already streaming: a close
    // landing while we await the `chat.send` ack rejects the pending request, and
    // that rejection is what the dispatch path classifies. Appending the kind to
    // the message (the generic phrase kept intact, so the existing classifier still
    // recognizes a disconnect) is how the name reaches it — codex P2.
    this.closeError =
      this.connectionEnd.kind === "connection_closed"
        ? err
        : new OpenClawError(`${err.message} [${this.connectionEnd.kind}]`);
    if (this.connectionEnd.kind !== "connection_closed") {
      // Operator line, SOC2-safe: the derived KIND and counters, never the
      // gateway's reason text. The buffer ceiling rides along on a slow-consumer
      // close because that is the number the condition is measured against.
      console.log(
        `[openclaw] connection ended: ${this.connectionEnd.kind}` +
          ` (wsCode=${socket?.code ?? "?"}` +
          `${
            this.connectionEnd.kind === "slow_consumer"
              ? `, maxBufferedBytes=${this.maxBufferedBytes ?? "unknown"}, inboundQueueLen=${this.queue.length}`
              : ""
          }` +
          `${
            this.connectionEnd.restartExpectedMs !== null
              ? `, restartExpectedMs=${this.connectionEnd.restartExpectedMs}`
              : ""
          })`,
      );
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.closeError);
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
        // Consumed: it no longer counts against the backlog ceiling.
        this.queuedBytes -= buffered.bytes;
        if (this.queuedBytes < 0) this.queuedBytes = 0;
        yield buffered.frame;
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
    dbg(
      "req ->",
      method,
      "| key=",
      clip(params.sessionKey ?? params.key ?? "", 90),
    );
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
