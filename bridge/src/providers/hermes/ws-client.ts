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
  onEvent: (
    type: string,
    sessionId: string,
    payload: Record<string, unknown>,
    /** Set only when the ROUTER made this event up — see `SyntheticOrigin`. It
     *  travels beside the payload, never inside it, because the payload is the
     *  provider's and this fact is ours. */
    synthetic?: SyntheticOrigin,
  ) => void;
  onClose?: (reason: string) => void;
  /**
   * A SERVER→CLIENT request (Hermes 0.21.3+): the gateway asks this client a question —
   * `approval`, `clarify`, `sudo`, `secret`, … — as a JSON-RPC request frame with a string
   * id (`srq-…`) and waits for the response carrying that id (tui_gateway/server_requests.py).
   * Returns true when a turn took it; false leaves it to the client, which answers `-32601`
   * so the agent is told at once that nobody here can answer, instead of waiting out its
   * deadline for a card no one will see.
   */
  onServerRequest?: (
    sessionId: string,
    id: string,
    method: string,
    params: Record<string, unknown>,
  ) => boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** The lane event a server→client request is delivered as — a name Hermes never emits, so
 *  it cannot collide with one of its events. Payload: `{id, method, params}`. */
export const HERMES_SERVER_REQUEST_EVENT = "atrium.server_request";

/**
 * Refuse the server→client requests a `session.resume` answer lists as still open
 * (`open_requests`, Hermes 0.21.3+). They belong to a run whose turn Atrium LOST (a dropped
 * socket, a restart): the new prompt will be queued or redirected into that run, never
 * ACKed `streaming`, so no turn of ours can carry their cards — and left unanswered they
 * hold the agent for its whole deadline, without limit when a clarify timeout is <= 0
 * (server.py `_clarify_timeout_seconds`). Refused `-32601`, Hermes withdraws them (an
 * approval as withdrawn, never as denied) and the run moves on. Returns the ids refused.
 */
export function refuseOpenRequests(
  client: Partial<Pick<HermesWsClient, "rejectServerRequest">>,
  resumed: unknown,
): string[] {
  const list =
    typeof resumed === "object" && resumed !== null
      ? (resumed as { open_requests?: unknown }).open_requests
      : undefined;
  if (!Array.isArray(list)) return [];
  const refused: string[] = [];
  for (const raw of list) {
    const id =
      typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
        ? (raw as { id: string }).id
        : "";
    if (!id) continue;
    client.rejectServerRequest?.(id, "the run that asked it was lost; the question never reached anyone");
    refused.push(id);
  }
  return refused;
}

/** The server→client request methods a turn answers (tui_gateway/contracts/
 *  server_requests.py). Any other — vault prompts, desktop previews, the tour — is answered
 *  `-32601` by the client: Atrium has no surface for it, and saying so at once beats a
 *  wait for a card that never exists. */
export const HERMES_SERVER_REQUESTS_TAKEN: ReadonlySet<string> = new Set([
  "approval",
  "clarify",
  "sudo",
  "secret",
  "terminal.read",
]);

export class HermesWsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** The JSON-RPC error code of an RPC_ERROR, when the server gave one. */
    readonly rpcCode?: number,
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

/** What ONE `event` notification means for the session it names — or null when it means
 *  nothing this build can act upon.
 *
 *  Exported so the failure paths are testable without a socket. The outer frame being an
 *  object says nothing about what is nested in it: `?? {}` turned a corrupt `params` or
 *  `payload` into an empty object, so a `message.complete` whose payload was unreadable
 *  read as a clean terminal and settled the turn on whatever text had accumulated.
 *
 *  Every unreadable shape is reported (W9/C4) — class and site only, never the body. What
 *  differs is the CONSEQUENCE, and it follows from what the frame still tells us:
 *   - `params` unreadable: we do not know whose turn this was. Report and drop; the turn's
 *     own recv deadline is what bounds the loss.
 *   - `payload` unreadable on a TERMINAL: we know the session. Hand that turn an error so
 *     it settles now instead of waiting for a terminal that already arrived broken.
 *   - `payload` unreadable on anything else: a lost delta. Report only — ending a turn
 *     over a delta trades a visible defect for a worse one. */
/**
 * WHY this event is not what the provider actually sent.
 *
 * OUT OF BAND, deliberately. The first attempt stamped a reserved key inside the
 * payload — and the payload comes from Hermes: a genuine `error` event carrying
 * that key would have been filed for ever as a decode failure of ours. A verdict
 * meant to survive its traces cannot be forgeable by the party it describes.
 */
export type SyntheticOrigin = "unreadable_terminal";

export function routeEventDecision(rawParams: unknown): {
  type: string;
  sid: string;
  payload: Record<string, unknown>;
  /** Absent on every event the provider really sent. */
  synthetic?: SyntheticOrigin;
} | null {
  const params = asJsonObject(rawParams);
  if (params === null) {
    protocolDrift.observeException(
      null,
      new TypeError("WS event params is not a JSON object"),
      "hermes-ws-parse",
    );
    return null;
  }
  const type = typeof params.type === "string" ? params.type : "";
  const sid = typeof params.session_id === "string" ? params.session_id : "";
  let payload: Record<string, unknown> = {};
  let payloadUnreadable = false;
  if (params.payload !== undefined) {
    const parsed = asJsonObject(params.payload);
    if (parsed === null) {
      protocolDrift.observeException(
        null,
        new TypeError("WS event payload is not a JSON object"),
        "hermes-ws-parse",
      );
      payloadUnreadable = true;
    } else {
      payload = parsed;
    }
  }
  if (type === "") return null;
  if (payloadUnreadable && WS_TERMINAL_EVENTS.has(type)) {
    return {
      type: "error",
      sid,
      payload: { message: "Hermes sent a terminal event this build could not read." },
      // The promotion to `error` is lossy by design — the reader needs one terminal
      // shape — but the DISTINCTION must survive it: filed as a provider failure, a
      // protocol drift of OURS would sit in the message's stored verdict for ever,
      // read long after the traces that could contradict it expired.
      synthetic: "unreadable_terminal",
    };
  }
  return { type, sid, payload };
}

/** The event types that END a turn on this transport.
 *
 *  DERIVED from `ws-turn.ts`'s own switch — the cases that call `settle()` — rather than
 *  guessed from the names: inventing a terminal vocabulary the reader does not share is
 *  how a "fix" ends turns the reader would have continued. */
export const WS_TERMINAL_EVENTS = new Set(["message.complete", "error"]);

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
  private readonly onServerRequest?: HermesWsOptions["onServerRequest"];

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
    this.onServerRequest = opts.onServerRequest;
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
    this.ready = this.doConnect()
      .then(() => this.advertise())
      .catch((err) => {
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

  /**
   * Say, once per connection and before any turn can use it, that this client answers
   * server→client requests. From Hermes 0.21.4 a WebSocket client that never says so gets
   * every one of them failed at once — approvals WITHDRAWN, clarify/sudo/secret answered
   * empty — with nothing on the wire to show it (server_requests.py `_unanswerable`,
   * session_transports.py). An older Hermes has no such method and answers -32601:
   * that is the one expected refusal, and it changes nothing there (it still sends
   * prompts as events). Any OTHER failure fails the connect, so the next call retries
   * rather than running turns whose questions would silently never reach anyone.
   */
  private async advertise(): Promise<void> {
    try {
      await this.rawCall("client.capabilities", { server_requests: true });
    } catch (err) {
      // ONLY "unknown method" (-32601, both generations: server.py @ v2026.7.20,
      // rpc_dispatch.py @ v2026.9.24) means an older Hermes. Any other refusal — invalid
      // params, an internal error — is a Hermes that HAS the method and did not record us:
      // its questions would all fail unseen.
      if (err instanceof HermesWsError && err.code === "RPC_ERROR" && err.rpcCode === -32601) return;
      this.ws?.close();
      throw err;
    }
  }

  /** Refuse one server→client request (`-32601`): Hermes then gives up on it at once —
   *  an approval is WITHDRAWN, never denied — instead of waiting out its deadline. */
  rejectServerRequest(id: string, message: string): void {
    this.sendFrame({ jsonrpc: "2.0", id, error: { code: -32601, message } });
  }

  /** Write one frame on the open socket (a response to a server→client request). */
  private sendFrame(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame), () => {
      /* a dead socket fails every pending wait on close; nothing to add here */
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
          p.reject(
            new HermesWsError(
              e?.message ?? "RPC error",
              "RPC_ERROR",
              typeof e?.code === "number" ? e.code : undefined,
            ),
          );
        } else {
          p.resolve((obj.result ?? {}) as Record<string, unknown>);
        }
      }
      return;
    }
    // A server→client REQUEST (string id + method): the gateway asks, this client answers.
    if (typeof obj.id === "string" && typeof obj.method === "string" && obj.method !== "event") {
      const params = asJsonObject(obj.params) ?? {};
      const sid = typeof params.session_id === "string" ? params.session_id : "";
      const taken = this.onServerRequest?.(sid, obj.id, obj.method, params) ?? false;
      if (!taken) {
        this.sendFrame({
          jsonrpc: "2.0",
          id: obj.id,
          error: { code: -32601, message: `Atrium cannot answer ${obj.method} here` },
        });
      }
      return;
    }
    // Event notification → fan out by session id.
    if (obj.method === "event") {
      const decision = routeEventDecision(obj.params);
      if (decision !== null)
        this.onEvent(
          decision.type,
          decision.sid,
          decision.payload,
          decision.synthetic,
        );
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
    return this.rawCall(method, params);
  }

  /** One JSON-RPC call on the socket as it is — no connect (the connect itself uses it). */
  private rawCall(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
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
