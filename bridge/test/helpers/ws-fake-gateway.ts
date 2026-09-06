// A SOCKET-level fake gateway: the handshake choreography (`connect.challenge` →
// `connect` → `hello-ok`) a real `OpenClawConnection` needs, plus a per-method
// responder and a way to PUSH an event frame down the wire. The RPC-level fake
// (`fake-gateway.ts`) stands in for the connection object; this one stands in for the
// gateway BEHIND a real connection, for tests of the receive loop itself (frame gaps,
// connection end, `config.changed`). One choreography, one place: a handshake change
// (protocol bump, a new required hello-ok field) is made here, not per test.
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

/** Return this from `onMethod` to leave the request UNANSWERED — for the cases that
 *  test a request still awaiting its ack when the socket ends. */
export const NO_ANSWER: unique symbol = Symbol("no-answer");

export const MAX_PAYLOAD = 26_214_400;
export const MAX_BUFFERED = 52_428_800;

export function deviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    id: "test-device",
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export interface WsFakeGateway {
  /** Resolves once the server listens. */
  ready: Promise<void>;
  url: string;
  /** The live socket of the last client, or null. */
  socket: WsSocket | null;
  /** HTTP headers of the last upgrade request, or null before the first connect. */
  upgradeHeaders: Record<string, string | undefined> | null;
  /** How many clients have connected. Counts SOCKETS, which is what an extra
   *  handshake costs — the unit a batching claim has to be measured in. */
  upgradeCount: number;
  /** Push one frame to the connected client, verbatim. */
  push(frame: unknown): void;
  /** Every request received, in order: `{method, params}`. */
  requests: { method: string; params: unknown }[];
  stop(): Promise<void>;
}

/**
 * @param opts.version   the `server.version` announced in hello-ok
 * @param opts.onMethod  answers a request: return the `payload` of an ok response,
 *                       `{ error }` for a refusal, or `NO_ANSWER` to leave it pending;
 *                       unknown methods are answered `{}` when no `onMethod` is given
 */
export function startWsFakeGateway(opts: {
  version?: string;
  onMethod?: (
    method: string,
    params: unknown,
  ) => unknown | Promise<unknown> | typeof NO_ANSWER | { error: { code: string; message?: string } };
} = {}): WsFakeGateway {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const requests: { method: string; params: unknown }[] = [];
  const gw: WsFakeGateway = {
    ready: new Promise<void>((resolve) => wss.once("listening", () => resolve())),
    get url() {
      return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    },
    socket: null,
    upgradeHeaders: null,
    upgradeCount: 0,
    push(frame) {
      gw.socket?.send(JSON.stringify(frame));
    },
    requests,
    async stop() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  wss.on("connection", (socket, req) => {
    gw.socket = socket;
    // The HTTP upgrade headers, captured so a test can assert what the bridge
    // STATED about itself — the whole of trusted-proxy identity lives here and
    // nowhere in the frames.
    gw.upgradeHeaders = { ...req.headers } as Record<string, string | undefined>;
    gw.upgradeCount += 1;
    socket.send(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n", ts: 1 } }),
    );
    socket.on("message", (raw) => {
      void (async () => {
      const frame = JSON.parse(raw.toString()) as { id: string; method?: string; params?: unknown };
      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: opts.version ?? "2026.9.1", connId: "conn-1" },
              policy: { maxPayload: MAX_PAYLOAD, maxBufferedBytes: MAX_BUFFERED },
            },
          }),
        );
        return;
      }
      if (frame.method === undefined) return;
      requests.push({ method: frame.method, params: frame.params });
      const answer = (await opts.onMethod?.(frame.method, frame.params)) ?? {};
      if (answer === NO_ANSWER) return;
      const refusal = (answer as { error?: { code: string; message?: string } })?.error;
      if (refusal) {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: refusal }));
      } else {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: answer }));
      }
      })();
    });
  });
  return gw;
}
