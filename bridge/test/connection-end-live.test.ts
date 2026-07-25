/**
 * The connection end, over a REAL socket.
 *
 * `connection-end.test.ts` pins the classification; this one pins the READING —
 * the part a pure test cannot reach: the client must pick the `shutdown` notice
 * and the WebSocket close code off the wire, and it must do so WITHOUT swallowing
 * the frame (observe-only is the standing invariant on the frame path: a reading
 * is added, never removed).
 *
 * A real `ws` server is spun up per test and completes the genuine Ed25519
 * handshake, so the hello-ok policy capture rides along on the same proof.
 */

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";

import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { classifyGatewayError } from "../src/core/dispatch-errors.js";

const MAX_PAYLOAD = 26_214_400; // 25 MiB, the live value
const MAX_BUFFERED = 52_428_800; // 50 MiB = upstream MAX_BUFFERED_BYTES

function deviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    id: "test-device",
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Minimal gateway: challenge → hello-ok, then whatever the test asks for. */
function startFakeGateway() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let live: WsSocket | null = null;
  const ready = new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  wss.on("connection", (socket) => {
    live = socket;
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-1", ts: 1 },
      }),
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "2026.7.1", connId: "conn-1" },
              policy: { maxPayload: MAX_PAYLOAD, maxBufferedBytes: MAX_BUFFERED },
            },
          }),
        );
      }
    });
  });
  return {
    ready,
    get url() {
      return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    },
    get socket() {
      return live;
    },
    async stop() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

let gateway: ReturnType<typeof startFakeGateway> | null = null;

afterEach(async () => {
  await gateway?.stop();
  gateway = null;
});

describe("connection end over a real socket", () => {
  it("records an announced shutdown AND still delivers the frame to the consumer", async () => {
    gateway = startFakeGateway();
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    // The hello-ok policy is captured whole — the buffer ceiling is what makes the
    // slow-consumer condition measurable instead of guessed.
    expect(conn.maxPayload).toBe(MAX_PAYLOAD);
    expect(conn.maxBufferedBytes).toBe(MAX_BUFFERED);

    const frames = conn.frames();
    gateway.socket!.send(
      JSON.stringify({
        type: "event",
        event: "shutdown",
        payload: { reason: "operator restart", restartExpectedMs: 12_000 },
      }),
    );
    const first = await frames.next();
    // NOT swallowed: the notice is read at connection scope and the frame travels
    // on unchanged, so the normalizer and the drift detector still see it.
    expect(first.done).toBe(false);
    expect((first.value as Record<string, unknown>).event).toBe("shutdown");
    expect(conn.shutdownAnnounced).toBe(true);

    gateway.socket!.close(1012, "service restart");
    await frames.next(); // terminates when the socket goes away
    expect(conn.connectionEnd?.kind).toBe("gateway_restarting");
    expect(conn.connectionEnd?.restartExpectedMs).toBe(12_000);
  });

  it("names a 1008 slow-consumer close, off the wire", async () => {
    gateway = startFakeGateway();
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    const frames = conn.frames();
    gateway.socket!.close(1008, "slow consumer");
    await frames.next();
    expect(conn.connectionEnd?.kind).toBe("slow_consumer");
    // Nothing was announced, so nothing must be invented.
    expect(conn.shutdownAnnounced).toBe(false);
    expect(conn.connectionEnd?.restartExpectedMs).toBeNull();
  });

  it("keeps an auth refusal distinct from saturation — same 1008, different reason", async () => {
    gateway = startFakeGateway();
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    const frames = conn.frames();
    gateway.socket!.close(1008, "unauthorized: device token mismatch");
    await frames.next();
    expect(conn.connectionEnd?.kind).toBe("unauthorized");
  });

  it("names the end on a request still awaiting its ack (the pre-turn exit)", async () => {
    // A close landing while we await the `chat.send` ack rejects the PENDING request
    // — and that rejection, not any turn state, is what the dispatch path
    // classifies. Before this the name was lost right here (codex P2).
    gateway = startFakeGateway();
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    // A request the fake gateway never answers.
    const pending = conn.request("chat.send", { text: "x" }).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    gateway.socket!.close(1008, "slow consumer");
    const message = await pending;
    expect(message).toContain("[slow_consumer]");
    expect(classifyGatewayError(new Error(message))).toBe("CONNECTION_SATURATED");
  });

  it("keeps an announced shutdown that lands DURING the handshake", async () => {
    // The gateway broadcasts `shutdown` to every connection, including one still
    // shaking hands — and at that moment there is no connection object to hold the
    // notice. Losing it made a send that coincided with a restart report a generic
    // disconnect instead of the restart the gateway had just announced (codex P2).
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    wss.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "shutdown",
          payload: { reason: "operator restart", restartExpectedMs: 20_000 },
        }),
      );
      // …and only then the challenge — the notice must survive the phase logic.
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "n", ts: 1 },
        }),
      );
      socket.on("message", () => socket.close(1012, "service restart"));
    });
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const failure = await OpenClawConnection.connect(url, "tok", deviceIdentity()).then(
      () => new Error("connected"),
      (e: Error) => e,
    );
    expect(failure.message).toContain("[gateway_restarting]");
    expect(classifyGatewayError(failure)).toBe("GATEWAY_RESTARTING");
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("carries a handshake shutdown into a connection that then SUCCEEDS", async () => {
    // The notice is consumed before the connection object exists. If the handshake
    // then completes, the installed reader never sees that frame again — so without
    // an explicit hand-off the later close reads as an unexplained drop instead of
    // the restart the gateway announced (codex P2).
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    let live: WsSocket | null = null;
    wss.on("connection", (socket) => {
      live = socket;
      socket.send(
        JSON.stringify({
          type: "event",
          event: "shutdown",
          payload: { reason: "operator restart", restartExpectedMs: 5_000 },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "n", ts: 1 },
        }),
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          // The handshake SUCCEEDS despite the pending shutdown.
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 4,
                server: { version: "2026.7.1", connId: "c" },
                policy: { maxPayload: MAX_PAYLOAD, maxBufferedBytes: MAX_BUFFERED },
              },
            }),
          );
        }
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const conn = await OpenClawConnection.connect(url, "tok", deviceIdentity());
    expect(conn.shutdownAnnounced).toBe(true);
    const frames = conn.frames();
    live!.close(1012, "service restart");
    await frames.next();
    expect(conn.connectionEnd?.kind).toBe("gateway_restarting");
    expect(conn.connectionEnd?.restartExpectedMs).toBe(5_000);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("names a refusal that lands DURING the handshake (before hello-ok)", async () => {
    // The steady-state reader is not installed yet at that point, so this close
    // travels through the handshake listener — which used to flatten every refusal
    // into "closed during connect" and read as a network fault (codex P2).
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    wss.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "n", ts: 1 },
        }),
      );
      // Refuse instead of answering the connect request.
      socket.on("message", () => socket.close(1008, "unauthorized: signature invalid"));
    });
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const failure = await OpenClawConnection.connect(url, "tok", deviceIdentity()).then(
      () => new Error("connected"),
      (e: Error) => e,
    );
    expect(failure.message).toContain("[unauthorized]");
    expect(classifyGatewayError(failure)).toBe("AUTH_TOKEN_MISMATCH");
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

describe("the inbound queue is bounded (G-27)", () => {
  it("closes rather than grow without bound, and NAMES why", async () => {
    // Unbounded, this queue is our own version of the gateway's slow-consumer
    // problem: a consumer that falls behind grows it until the process dies, taking
    // every session with it. Closing is the safe failure — reconnect + transcript
    // recovery already exist; an out-of-memory kill loses everything in flight.
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    let live: WsSocket | null = null;
    wss.on("connection", (socket) => {
      live = socket;
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "n", ts: 1 },
        }),
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 4,
                server: { version: "2026.7.1", connId: "c" },
                policy: { maxPayload: MAX_PAYLOAD, maxBufferedBytes: MAX_BUFFERED },
              },
            }),
          );
        }
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const conn = await OpenClawConnection.connect(url, "tok", deviceIdentity());
    // Nobody consumes: every frame piles up in the queue.
    for (let i = 0; i < 10_050; i++) {
      live!.send(JSON.stringify({ type: "event", event: "tick", seq: i + 1 }));
    }
    // Wait for the connection to give up on its own.
    for (let i = 0; i < 200 && conn.connectionEnd === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.connectionEnd?.kind).toBe("inbound_overflow");
    // The queue is EMPTIED on the way out: `frames()` shifts from it before it
    // checks `closed`, so leaving it full would keep the consumer normalizing and
    // writing for a long time instead of ending the turn and letting transcript
    // recovery take over.
    expect(conn.inboundQueueLen).toBe(0);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

describe("the byte ceiling measures the BACKLOG, not the traffic", () => {
  it("consumed frames stop counting, so a healthy connection never trips", async () => {
    // Tracking a running total that never comes back down would close a perfectly
    // healthy long-lived connection after 128 MiB of ordinary traffic (codex P1).
    gateway = startFakeGateway();
    await gateway.ready;
    const conn = await OpenClawConnection.connect(gateway.url, "tok", deviceIdentity());
    // Send FIRST, with nobody waiting, so the frames really sit in the queue — a
    // consumer already blocked on `next()` receives them directly and the queue is
    // never involved (an earlier version of this test measured nothing).
    for (let i = 0; i < 5; i++) {
      gateway.socket!.send(
        JSON.stringify({ type: "event", event: "tick", seq: i, pad: "x".repeat(50_000) }),
      );
    }
    for (let i = 0; i < 100 && conn.inboundQueueLen < 5; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.inboundQueueBytes).toBeGreaterThan(200_000);
    // …then drain them.
    const frames = conn.frames();
    for (let i = 0; i < 5; i++) await frames.next();
    // Traffic flowed; the BACKLOG is empty, so nothing counts against the ceiling.
    expect(conn.inboundQueueLen).toBe(0);
    expect(conn.inboundQueueBytes).toBe(0);
    expect(conn.connectionEnd).toBeNull();
    conn.close(); // let the fixture's server shut down
  });
});

describe("the inbound queue is bounded in BYTES too", () => {
  it("closes on a few large frames, long before the frame count", async () => {
    // A frame cap is not a memory bound: the gateway admits frames up to its
    // maxPayload, so ten thousand large ones are gigabytes of retained JSON — an
    // out-of-memory kill in exactly the scenario the guard exists for.
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      maxPayload: 64 * 1024 * 1024,
    });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    let live: WsSocket | null = null;
    wss.on("connection", (socket) => {
      live = socket;
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "n", ts: 1 },
        }),
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 4,
                server: { version: "2026.7.1", connId: "c" },
                policy: { maxPayload: MAX_PAYLOAD, maxBufferedBytes: MAX_BUFFERED },
              },
            }),
          );
        }
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const conn = await OpenClawConnection.connect(url, "tok", deviceIdentity());
    // ~10 MiB per frame, nobody consuming: far under the 10 000-frame ceiling.
    const big = "x".repeat(10 * 1024 * 1024);
    for (let i = 0; i < 15 && conn.connectionEnd === null; i++) {
      live!.send(JSON.stringify({ type: "event", event: "tick", seq: i, big }));
      await new Promise((r) => setTimeout(r, 20));
    }
    for (let i = 0; i < 200 && conn.connectionEnd === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.connectionEnd?.kind).toBe("inbound_overflow");
    conn.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }, 30_000);
});
