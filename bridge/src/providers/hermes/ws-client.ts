// Hermes JSON-RPC/WebSocket client (`hermes serve` /api/ws — the tui_gateway
// dispatch surface). This is Hermes's RICH transport: one persistent
// connection per instance, requests multiplexed by JSON-RPC id, streaming
// events multiplexed by `session_id`. Live-captured contract (bench 0.18.0,
// fixture test/fixtures/hermes/ws-capture.jsonl):
//
//   connect → event gateway.ready
//   session.create {} → {session_id, stored_session_id, info{model,...}}
//   prompt.submit {session_id, text} → ACK {status:"streaming"}   ← acceptance
//   events: session.info / message.start / status.update /
//           thinking.delta{text} / message.delta{text} /
//           reasoning.available / message.complete{text, usage{...},
//           status:"complete"} / session.title
//   abort: session.interrupt {session_id}
//
// AUTH (two modes, both server-verified in web_server._ws_auth_reason):
//   token    — `?token=<HERMES_DASHBOARD_SESSION_TOKEN>` (loopback / legacy).
//   password — gated public bind: POST /auth/password-login {provider,
//              username, password} → session cookie → POST /api/auth/ws-ticket
//              → `?ticket=` (single-use, 30 s TTL; one ticket PER connection —
//              the documented pattern).
// The credential in the instance's `apiKey` secret selects the mode:
// "user:password" (a colon) → password flow; otherwise → static token.

import WebSocket from "ws";
import { decodeInboundFrame, protocolDrift } from "../openclaw/protocol-drift.js";

export interface HermesWsOptions {
  /** The `hermes serve` base, e.g. "http://nas:9119". */
  baseUrl: string;
  /** Static token OR "user:password" (colon = password→ticket flow). */
  credential: string;
  requestTimeoutMs?: number;
  /** Called for every event notification: (type, sessionId, payload). */
  onEvent: (type: string, sessionId: string, payload: Record<string, unknown>) => void;
  onClose?: (reason: string) => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class HermesWsError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    // Same trick as HermesError: fold the code into the message so the
    // bridge's classifyGatewayError (message-regex based) classifies it.
    super(`${message} [${code}]`);
    this.name = "HermesWsError";
  }
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** A value that is a plain JSON object, or null. Used on the NESTED members of a frame:
 *  the shared decoder validates the envelope, and every `?? {}` below it was a place where
 *  a corrupt inner value became an empty one that read as valid. */
function asJsonObject(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** The Hermes WS decode — the shared decoder with this transport's site.
 *
 *  Exported so the failure paths are testable without a socket, which is the point: the
 *  bug this closes lived exactly here and a structural "the module calls the sensor" check
 *  could not see it. */
export function decodeWsFrame(raw: unknown): Record<string, unknown> | null {
  return decodeInboundFrame(raw, "hermes-ws-parse");
}

export class HermesWsClient {
  private readonly httpBase: string;
  private readonly credential: string;
  private readonly timeoutMs: number;
  private readonly onEvent: HermesWsOptions["onEvent"];
  private readonly onClose?: HermesWsOptions["onClose"];

  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(opts: HermesWsOptions) {
    this.httpBase = opts.baseUrl.replace(/\/+$/, "");
    this.credential = opts.credential;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onEvent = opts.onEvent;
    this.onClose = opts.onClose;
  }

  /** True when the underlying socket is open. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Resolve the WS auth query: static token, or password→ticket (gated). */
  private async authQuery(): Promise<string> {
    const colon = this.credential.indexOf(":");
    if (colon === -1) {
      return `token=${encodeURIComponent(this.credential)}`;
    }
    // Password flow: login → session cookie → single-use ws-ticket.
    const username = this.credential.slice(0, colon);
    const password = this.credential.slice(colon + 1);
    const login = await fetch(`${this.httpBase}/auth/password-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "basic", username, password }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!login.ok) {
      throw new HermesWsError(
        `Hermes password-login -> HTTP ${login.status}`,
        login.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR",
      );
    }
    const cookies = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const ticketRes = await fetch(`${this.httpBase}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { Cookie: cookies },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!ticketRes.ok) {
      throw new HermesWsError(
        `Hermes ws-ticket -> HTTP ${ticketRes.status}`,
        ticketRes.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR",
      );
    }
    const body = (await ticketRes.json()) as { ticket?: string };
    if (!body.ticket) {
      throw new HermesWsError("Hermes ws-ticket returned no ticket", "BAD_RESPONSE");
    }
    return `ticket=${encodeURIComponent(body.ticket)}`;
  }

  /** Connect (idempotent). Resolves after the server's gateway.ready event.
   *  A connect already IN FLIGHT is reused — two early callers (e.g. a
   *  discovery poll racing a /send on a fresh client) must share ONE socket,
   *  never open two (codex P2). */
  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.doConnect().catch((err) => {
      // A failed connect must not poison future attempts.
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private async doConnect(): Promise<void> {
    this.closed = false;
    const qs = await this.authQuery();
    const wsUrl = `${this.httpBase.replace(/^http/, "ws")}/api/ws?${qs}`;
    const ws = new WebSocket(wsUrl, { maxPayload: 32 * 1024 * 1024 });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new HermesWsError("Hermes WS connect timeout", "TIMEOUT"));
        ws.terminate();
      }, this.timeoutMs);
      let sawReady = false;
      ws.on("message", (raw) => {
        const obj = decodeWsFrame(raw);
        if (obj === null) return; // unreadable frame: reported inside, then ignored
        try {
          this.route(obj);
          // The server emits gateway.ready right after accept — that's "open".
          if (!sawReady && this.isReadyEvent(obj)) {
            sawReady = true;
            clearTimeout(timer);
            resolve();
          }
        } catch (err) {
          // Routing is the last unguarded step of this reader. It is SWALLOWED after
          // reporting rather than rethrown: an unhandled throw in a socket callback can
          // take the process down, and no single unreadable frame is worth the bridge.
          protocolDrift.observeException(null, err, "hermes-ws-route");
        }
      });
      ws.on("close", (code) => {
        clearTimeout(timer);
        const reason = `Hermes WS closed (code ${code})`;
        if (!sawReady) reject(new HermesWsError(reason, code === 4401 ? "UNAUTHORIZED" : "NETWORK"));
        // Only clear state if THIS socket is still the active one — a stale
        // socket's close must not tear down a newer connection (codex P2).
        if (this.ws === ws) {
          this.failAllPending(new HermesWsError(reason, "NETWORK"));
          this.ws = null;
          this.ready = null;
          if (!this.closed) this.onClose?.(reason);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        if (!sawReady) reject(new HermesWsError(String((err as Error).message ?? err), "NETWORK"));
      });
    });
  }

  private isReadyEvent(obj: Record<string, unknown>): boolean {
    if (obj.method !== "event") return false;
    const p = obj.params as { type?: string } | undefined;
    return p?.type === "gateway.ready";
  }

  private route(obj: Record<string, unknown>): void {
    // JSON-RPC reply → settle its pending call.
    if (typeof obj.id === "number" && (obj.result !== undefined || obj.error !== undefined)) {
      const p = this.pending.get(obj.id);
      if (p) {
        this.pending.delete(obj.id);
        clearTimeout(p.timer);
        if (obj.error !== undefined) {
          const e = obj.error as { code?: number; message?: string };
          p.reject(new HermesWsError(e?.message ?? "RPC error", "RPC_ERROR"));
        } else {
          p.resolve((obj.result ?? {}) as Record<string, unknown>);
        }
      }
      return;
    }
    // Event notification → fan out by session id.
    if (obj.method === "event") {
      // The OUTER frame being an object says nothing about what is nested in it. `?? {}`
      // turned a `params.payload` of `null` — or a primitive, or an array — into an empty
      // object, so a `message.complete` whose payload was corrupt read as a clean terminal
      // and settled the turn `complete` on whatever text had accumulated: a truncated or
      // empty answer wearing a success badge, on the DEFAULT transport (raised in review).
      // Same defect as the SSE body, one transport over, and it is refused the same way.
      const params = asJsonObject(obj.params);
      if (params === null) {
        protocolDrift.observeException(
          null,
          new TypeError("WS event params is not a JSON object"),
          "hermes-ws-parse",
        );
        return;
      }
      const type = typeof params.type === "string" ? params.type : "";
      const sid = typeof params.session_id === "string" ? params.session_id : "";
      // An ABSENT payload (missing key) is legitimate — several events carry none.
      // Anything else that is not an object is REPORTED, and here the two failure modes
      // pull in opposite directions: dropping the event risks a turn that never receives
      // its terminal and hangs until the watchdog, while passing `{}` through risks a
      // corrupt terminal settling as a clean, empty success. Both are real; only one can
      // be chosen without evidence about what Hermes actually sends.
      //
      // Chosen: preserve today's behaviour (`{}`), and make the case VISIBLE so the next
      // lot decides with measurements instead of a guess. That lot is already scoped —
      // it owns the WS terminal handling and its live validation.
      let payload: Record<string, unknown> = {};
      if (params.payload !== undefined) {
        const parsed = asJsonObject(params.payload);
        if (parsed === null) {
          protocolDrift.observeException(
            null,
            new TypeError("WS event payload is not a JSON object"),
            "hermes-ws-parse",
          );
        } else {
          payload = parsed;
        }
      }
      if (type) this.onEvent(type, sid, payload);
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** One JSON-RPC call. Auto-connects. */
  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new HermesWsError("Hermes WS not connected", "NETWORK");
    }
    const id = this.nextId++;
    const req = { jsonrpc: "2.0", id, method, params };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesWsError(`Hermes WS ${method} timeout`, "TIMEOUT"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(req), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new HermesWsError(String(err.message ?? err), "NETWORK"));
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    this.failAllPending(new HermesWsError("Hermes WS closing", "NETWORK"));
    this.ws?.close();
    this.ws = null;
    this.ready = null;
  }
}
