// GatewayHttpMediaFetcher — the NO-shared-filesystem outbound-media path.
// Drives the exact two-step contract verified live on OpenClaw 2026.6.5
// (authenticated meta-probe -> gateway-minted ticket -> ticketed download) with a
// mocked fetch, covering success AND every failure branch + the reason codes the
// SOC2 diagnostic keys on. No gateway needed.

import { describe, it, expect } from "vitest";
import type { Readable } from "node:stream";
import { GatewayHttpMediaFetcher } from "../src/core/gateway-http-media-fetcher.js";
import { MEDIA_TOO_LARGE_CODE, type OpenResult } from "../src/core/media-fetcher.js";

const BASE = "http://gw.invalid:18790";
const PATH = "/home/node/.openclaw/media/outbound/report---abc.md";

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}
function opened(r: OpenResult): Extract<OpenResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected bytes, got skip "${r.reason}"`);
  return r;
}
function skip(r: OpenResult): string {
  if (r.ok) throw new Error("expected a skip, got bytes");
  return r.reason;
}

interface MockOpts {
  meta: { status?: number; body?: unknown; throws?: boolean };
  download?: {
    status?: number;
    contentType?: string;
    contentLength?: string;
    content?: string;
    noBody?: boolean;
  };
}
function mockGateway(opts: MockOpts) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, auth: headers["Authorization"] ?? null });
    if (u.includes("meta=1")) {
      if (opts.meta.throws) throw new Error("network down");
      const status = opts.meta.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => opts.meta.body,
        headers: new Headers(),
      } as unknown as Response;
    }
    const d = opts.download ?? {};
    const status = d.status ?? 200;
    const h = new Headers();
    if (d.contentType) h.set("content-type", d.contentType);
    if (d.contentLength) h.set("content-length", d.contentLength);
    const body = d.noBody
      ? null
      : new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(d.content ?? ""));
            c.close();
          },
        });
    return {
      ok: status >= 200 && status < 300,
      status,
      body,
      headers: h,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const fetcher = (fetchImpl: typeof fetch, maxBytes = 1024) =>
  new GatewayHttpMediaFetcher({ httpBase: BASE, token: "TKN", maxBytes, fetchImpl });

describe("GatewayHttpMediaFetcher", () => {
  it("SUCCESS: meta(Bearer)->ticket->download(no Bearer) streams bytes + mime + size", async () => {
    const { fetchImpl, calls } = mockGateway({
      meta: { body: { available: true, mediaTicket: "v1.tkt.sig" } },
      download: { contentType: "text/markdown", contentLength: "7", content: "content" },
    });
    const got = opened(await fetcher(fetchImpl).open(PATH));
    expect(got.mimeType).toBe("text/markdown");
    expect(got.size).toBe(7);
    expect(await drain(got.stream)).toBe("content");
    // The meta probe carries the Bearer; the ticketed download does NOT.
    const meta = calls.find((c) => c.url.includes("meta=1"))!;
    const dl = calls.find((c) => c.url.includes("mediaTicket="))!;
    expect(meta.auth).toBe("Bearer TKN");
    expect(dl.auth).toBeNull();
    // source is URL-encoded in BOTH requests; the ticket is encoded in the download.
    expect(meta.url).toContain(encodeURIComponent(PATH));
    expect(dl.url).toContain("mediaTicket=" + encodeURIComponent("v1.tkt.sig"));
  });

  it("not_found when the gateway reports available:false", async () => {
    const { fetchImpl } = mockGateway({
      meta: { body: { available: false, code: "file-not-found" } },
    });
    expect(skip(await fetcher(fetchImpl).open(PATH))).toBe("not_found");
  });

  it("not_found when available:true but no ticket (defensive)", async () => {
    const { fetchImpl } = mockGateway({ meta: { body: { available: true } } });
    expect(skip(await fetcher(fetchImpl).open(PATH))).toBe("not_found");
  });

  it("fetch_error on a 401 meta probe (bad/absent token)", async () => {
    const { fetchImpl } = mockGateway({
      meta: { status: 401, body: { error: { type: "unauthorized" } } },
    });
    expect(skip(await fetcher(fetchImpl).open(PATH))).toBe("fetch_error");
  });

  it("fetch_error when the network throws (gateway unreachable)", async () => {
    const { fetchImpl } = mockGateway({ meta: { throws: true } });
    expect(skip(await fetcher(fetchImpl).open(PATH))).toBe("fetch_error");
  });

  it("too_large via meta.size (when the gateway reports it)", async () => {
    const { fetchImpl } = mockGateway({
      meta: { body: { available: true, mediaTicket: "t", size: 99_999 } },
    });
    expect(skip(await fetcher(fetchImpl, 1024).open(PATH))).toBe("too_large");
  });

  it("too_large via download Content-Length (6.5 meta has no size)", async () => {
    const { fetchImpl } = mockGateway({
      meta: { body: { available: true, mediaTicket: "t" } },
      download: { contentLength: "99999", content: "x" },
    });
    expect(skip(await fetcher(fetchImpl, 1024).open(PATH))).toBe("too_large");
  });

  it("fetch_error when the download responds non-2xx", async () => {
    const { fetchImpl } = mockGateway({
      meta: { body: { available: true, mediaTicket: "t" } },
      download: { status: 500, content: "boom" },
    });
    expect(skip(await fetcher(fetchImpl).open(PATH))).toBe("fetch_error");
  });

  it("fetch_error when the download has no body", async () => {
    const { fetchImpl } = mockGateway({
      meta: { body: { available: true, mediaTicket: "t" } },
      download: { noBody: true },
    });
    expect(skip(await fetcher(fetchImpl).open(PATH))).toBe("fetch_error");
  });

  it("enforces the byte cap on the STREAM when Content-Length is absent (chunked)", async () => {
    // 6.5 meta has no size and a chunked download omits Content-Length, so the
    // cap can only be enforced on the actual flow — the stream must error past it.
    const big = "x".repeat(4096);
    const { fetchImpl } = mockGateway({
      meta: { body: { available: true, mediaTicket: "t" } },
      download: { content: big }, // no contentLength header
    });
    const got = opened(await fetcher(fetchImpl, 1024).open(PATH));
    // The error must carry MEDIA_TOO_LARGE_CODE so the writer reports `too_large`
    // (operator fix: cap/size) and not a generic upload/storage failure.
    const err = await drain(got.stream).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exceeds/);
    expect((err as { code?: string }).code).toBe(MEDIA_TOO_LARGE_CODE);
  });

  it("falls back to filename mime when the download omits Content-Type", async () => {
    const { fetchImpl } = mockGateway({
      meta: { body: { available: true, mediaTicket: "t" } },
      download: { content: "%PDF" }, // no content-type header
    });
    const got = opened(
      await fetcher(fetchImpl).open("/home/node/.openclaw/media/outbound/x.pdf"),
    );
    expect(got.mimeType).toBe("application/pdf");
  });

  it("size is null (UNKNOWN) for a chunked download — no Content-Length, no meta.size", async () => {
    // The 6.5 case: meta has no size and the download omits Content-Length. The
    // bytes still flow, but the size is unknowable up front — must be null (NOT 0,
    // which the diagnostic would read as an empty file).
    const { fetchImpl } = mockGateway({
      meta: { body: { available: true, mediaTicket: "t" } },
      download: { content: "hello" }, // within cap, no contentLength
    });
    const got = opened(await fetcher(fetchImpl, 1024).open(PATH));
    expect(got.size).toBeNull();
    expect(await drain(got.stream)).toBe("hello");
  });

  it("route_absent (NOT fetch_error) when the meta probe 404s — old gateway w/o the route", async () => {
    // 6.5 returns 200 {available:false} for a missing FILE; a 404 means the gateway
    // has no assistant-media ROUTE at all (pre-6.x) -> distinct, actionable signal.
    const { fetchImpl } = mockGateway({ meta: { status: 404, body: {} } });
    expect(skip(await fetcher(fetchImpl).open(PATH))).toBe("route_absent");
  });

  it("fetch_error (never a hang) when the connection times out", async () => {
    // A gateway that accepts the socket but never responds: the AbortSignal fires
    // after timeoutMs and the open() resolves to a best-effort skip — TurnSink's
    // awaited addMedia can never stall the turn.
    const hanging = (async (_url: unknown, init?: RequestInit) =>
      await new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const f = new GatewayHttpMediaFetcher({
      httpBase: BASE,
      token: "TKN",
      maxBytes: 1024,
      timeoutMs: 15,
      fetchImpl: hanging,
    });
    expect(skip(await f.open(PATH))).toBe("fetch_error");
  });

  it("does NOT abort a slow-to-consume body (no idle timer) — backpressure isn't a stall", async () => {
    // The returned stream is consumed only AFTER the writer gets a Convex upload
    // URL; a slow upload backpressures reads. With a SHORT connect timeout, a body
    // read long after open() must still deliver — the connect deadline bounds only
    // the probe+headers, never the consumer-paced body.
    const { fetchImpl } = mockGateway({
      meta: { body: { available: true, mediaTicket: "t" } },
      download: { content: "delivered-late" },
    });
    const f = new GatewayHttpMediaFetcher({
      httpBase: BASE,
      token: "TKN",
      maxBytes: 1024,
      timeoutMs: 15,
      fetchImpl,
    });
    const got = opened(await f.open(PATH));
    await new Promise((r) => setTimeout(r, 60)); // 4x the connect timeout
    expect(await drain(got.stream)).toBe("delivered-late"); // not dropped
  });
});
