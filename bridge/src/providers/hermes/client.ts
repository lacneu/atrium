// Hermes gateway HTTP client. Unlike OpenClaw (one persistent multiplexed
// WebSocket), Hermes is REST + per-turn SSE: each turn is a `POST
// /api/sessions/{id}/chat/stream` that streams Server-Sent Events then ends.
// Session continuity is the session id (created lazily, first turn) reused
// across turns — Atrium stores it in the same `providerChatId` slot OpenClaw
// used for `openclawChatId`. Auth is a static Bearer token (the gateway's
// API_SERVER_KEY), NOT a per-turn socket handshake.
//
// This module is the ONLY Hermes-specific transport; everything it produces
// flows through the shared normalizer → TurnSink → convex-writer downstream.

import { SseParser, type SseFrame } from "./sse.js";

export interface HermesClientOptions {
  /** Gateway API base, e.g. "http://nas:8642" (no trailing slash needed). */
  baseUrl: string;
  /** API_SERVER_KEY bearer token. */
  token: string;
  /** Per-request timeout (ms) for non-streaming calls. Streaming has none. */
  requestTimeoutMs?: number;
}

export interface HermesHealth {
  status: string;
  platform?: string;
  version?: string;
}

/**
 * What the bridge LEARNED when it asked the provider to stop a run.
 *
 * THREE names, ONE consequence: only `interrupted` lets the chat keep its provider
 * session; the other two drop it, because a run that may still be going owns server-side
 * state nobody can account for (the rule lot 30 settled). They stay distinct anyway,
 * because after the fact they answer different questions:
 *
 *   * `ineffective` — PROOF nothing was stopped (a 404 `run_not_found`, or no run id to
 *     name, so nothing was even asked). On the REST transport this is STRUCTURAL and
 *     therefore constant, not an incident.
 *   * `unknown` — we could not learn. Network, timeout, 5xx. Rare, and on WS it does not
 *     even mean the interrupt failed — only that its answer was lost.
 *
 * Collapsing them would make "your chat forgot after you pressed Stop" untriageable.
 */
export type HermesInterruptVerdict = "interrupted" | "ineffective" | "unknown";

const DEFAULT_TIMEOUT_MS = 15_000;

export class HermesError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    // Fold the CODE into the message: the bridge's classifyGatewayError reads
    // only Error.message, so a bare "HTTP 401" would misclassify as
    // UPSTREAM_ERROR instead of AUTH_TOKEN_MISMATCH — appending `[UNAUTHORIZED]`
    // (lowercased "unauthorized") lets the existing regex catch it (codex P2).
    super(`${message} [${code}]`);
    this.name = "HermesError";
  }
}

function messageOf(err: unknown): string {
  const e = err as { message?: string } | null;
  return (e && typeof e.message === "string" && e.message) || String(err);
}

export class HermesClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: HermesClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async json<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: this.authHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new HermesError(
          `Hermes ${method} ${path} -> HTTP ${res.status}`,
          res.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR",
          res.status,
        );
      }
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HermesError(
          `Hermes ${method} ${path}: non-JSON response`,
          "BAD_RESPONSE",
          res.status,
        );
      }
    } catch (err) {
      if (err instanceof HermesError) throw err;
      const e = err as { name?: string; message?: string };
      throw new HermesError(
        e?.message ?? String(err),
        e?.name === "AbortError" ? "TIMEOUT" : "NETWORK",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Gateway reachability + version. Tolerates BOTH a JSON body and a plain
   *  "ok" text body (some builds return text) — a reachable gateway must never
   *  read as a network error just because /health isn't JSON. */
  async health(): Promise<HermesHealth> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/health`, {
        method: "GET",
        headers: this.authHeaders(),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new HermesError(
          `Hermes GET /health -> HTTP ${res.status}`,
          res.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR",
          res.status,
        );
      }
      const body = (await res.text()).trim();
      try {
        return JSON.parse(body) as HermesHealth;
      } catch {
        return { status: body || "ok" };
      }
    } catch (err) {
      if (err instanceof HermesError) throw err;
      const e = err as { name?: string; message?: string };
      throw new HermesError(
        e?.message ?? String(err),
        e?.name === "AbortError" ? "TIMEOUT" : "NETWORK",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** The gateway's declared feature set — drives the compat manifest + capability gates. */
  async capabilities(): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>("GET", "/v1/capabilities");
  }

  /** The advertised model (Hermes exposes ONE agent as a model). */
  async models(): Promise<{ data: Array<{ id: string }> }> {
    return this.json("GET", "/v1/models");
  }

  /** Reuse an existing session id, or create one lazily (first turn of a chat). */
  async ensureSession(existing: string | null): Promise<string> {
    if (existing) return existing;
    const res = await this.json<{ session: { id: string } }>("POST", "/api/sessions", {});
    const id = res?.session?.id;
    if (!id) throw new HermesError("Hermes session create returned no id", "BAD_RESPONSE");
    return id;
  }

  /**
   * Interrupt an in-flight run (POST /v1/runs/{id}/stop) and report WHAT HAPPENED.
   *
   * Not best-effort, and not a courtesy: cancelling our HTTP read stops US reading, so
   * this call is the only thing that can end the run on the other side. The caller has
   * to know whether it did, because a run still going owns a session nobody can vouch
   * for — see `HermesInterruptVerdict`.
   *
   * The 404 is the load-bearing case. Upstream answers `run_not_found` when the id is in
   * neither `_active_run_agents` nor `_active_run_tasks`, and the SSE transport this
   * client drives (`/api/sessions/{id}/chat/stream`) registers its run id in neither. So
   * on that transport the 404 is a CERTAINTY, and reading it is how the bridge stops
   * assuming otherwise.
   */
  async stopRun(runId: string): Promise<HermesInterruptVerdict> {
    try {
      await this.json("POST", `/v1/runs/${encodeURIComponent(runId)}/stop`);
      return "interrupted";
    } catch (err) {
      // 404 = the gateway looked and has no such run: PROOF nothing was stopped.
      // Anything else (network, timeout, 5xx, an unparseable body) leaves the question
      // open — the gateway may well have interrupted before failing to say so.
      if (err instanceof HermesError && err.status === 404) return "ineffective";
      return "unknown";
    }
  }

  /**
   * OPEN one turn's SSE stream: POST the message and return the streaming
   * Response once the gateway ACCEPTS it (2xx headers received). Throws a
   * HermesError on a pre-stream dispatch failure (unreachable / 401 / 5xx) —
   * this is the point that decides `/send`'s 200-vs-502, mirroring OpenClaw's
   * "reply on ack, stream async" contract. `readStream` then drains it.
   */
  async openStream(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    // Bound the ACCEPTANCE (headers) phase: a gateway that accepts the TCP
    // connection but never sends SSE headers must not hang /send forever (codex
    // P2). The timer is cleared once headers arrive.
    //
    // The BODY stream used to be deliberately unbounded, and that decision is now
    // superseded: a provider that holds the connection open and says nothing left the
    // turn waiting for the Convex watchdog twelve minutes later. The body's bound lives
    // in the CALLER (`turn.ts`), which is where the frames are seen and so where silence
    // can be told from progress — this function only sees a stream. Both the caller's
    // silence give-up and an external Stop arrive through the signal below.
    const ctrl = new AbortController();
    const onExternal = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onExternal, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(
        `${this.base}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
        {
          method: "POST",
          headers: this.authHeaders({ Accept: "text/event-stream" }),
          body: JSON.stringify({ message: text }),
          signal: ctrl.signal,
        },
      );
    } catch (err) {
      if (timedOut) {
        throw new HermesError("Hermes chat/stream: accept timeout", "TIMEOUT");
      }
      if ((err as { name?: string })?.name === "AbortError") throw err;
      throw new HermesError(messageOf(err), "NETWORK");
    } finally {
      // Headers arrived (or the fetch settled): stop bounding — but KEEP the
      // external-abort link so Stop still cancels the body read.
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new HermesError(
        `Hermes chat/stream -> HTTP ${res.status}`,
        res.status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR",
        res.status,
      );
    }
    if (!res.body) {
      throw new HermesError("Hermes chat/stream returned no body", "BAD_RESPONSE");
    }
    return res;
  }

  /** Drain an opened stream, invoking `onFrame` per SSE frame until EOF. */
  async readStream(res: Response, onFrame: (frame: SseFrame) => void): Promise<void> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          onFrame(frame);
        }
      }
      for (const frame of parser.end()) onFrame(frame);
    } finally {
      reader.releaseLock?.();
    }
  }
}
