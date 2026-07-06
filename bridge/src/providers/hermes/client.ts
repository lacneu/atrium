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

  /** Interrupt an in-flight run (POST /v1/runs/{id}/stop). Best-effort. */
  async stopRun(runId: string): Promise<void> {
    await this.json("POST", `/v1/runs/${encodeURIComponent(runId)}/stop`);
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
    // P2). The timer is cleared once headers arrive — the BODY stream (the
    // generation) is then deliberately unbounded. External Stop still aborts
    // the body via the same controller.
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
