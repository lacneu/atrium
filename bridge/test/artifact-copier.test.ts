// THE TRANSCRIPT FILE COPIER (final design step 2): `artifacts.download` → the ticketed URL →
// the bytes, streamed into Convex storage with their SHA-256; `MEDIA:` through the media
// fetcher, named with the session. The fake gateway below enforces the upstream rules the
// cited tests fix (v2026.9.33), so each case shows what Atrium does under them.

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { ArtifactCopier, COPY_RETRY_DELAYS_MS, type DownloadGrant } from "../src/core/artifact-copier.js";
import { GatewayHttpMediaFetcher } from "../src/core/gateway-http-media-fetcher.js";
import type { MediaFetcher } from "../src/core/media-fetcher.js";
import type { TranscriptFileFailedReport, TranscriptFileToCopy } from "../src/convex-writer.js";
import {
  classifyArtifactDownloadError,
  requestArtifactDownload,
} from "../src/providers/openclaw/artifact-download.js";
import { GatewayAnsweredError } from "../src/providers/openclaw/openclaw-client.js";

const BASE = "http://gw.test:18790";
const SK = "agent:alice:atrium:chat:u:c1";
const ATTACHMENT = "03d85d8e-b298-4812-b5a1-3fffb6ad2e8b";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ART = `artifact_managed_media_${ATTACHMENT}`;
const BYTES = "PROBE_REFONTE_OK";
const SHA = createHash("sha256").update(BYTES).digest("hex");
const canonical = (id: string) => `/api/chat/media/outgoing/${encodeURIComponent(SK)}/${id}/full`;
const ticketed = (id: string) => `${canonical(id)}?mediaTicket=v1.ticket-for-${id}`;

/** The managed media route (src/gateway/managed-image-attachments.ts:1526-1608): a ticket
 *  valid for THIS attachment serves without authentication; anything else needs an
 *  authorized OWNER request — never what Atrium sends. */
function managedRoute(opts: { gone?: boolean; body?: string; length?: number } = {}) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: url.toString(), headers });
    if (opts.gone) return new Response("not found", { status: 404 });
    const m = /\/api\/chat\/media\/outgoing\/[^/]+\/([^/]+)\/full$/.exec(url.pathname);
    const ticket = url.searchParams.get("mediaTicket");
    const ticketOk = m !== null && ticket === `v1.ticket-for-${m[1]}`;
    if (!ticketOk) return new Response("", { status: 401 });
    const body = opts.body ?? BYTES;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": String(opts.length ?? Buffer.byteLength(body)),
      },
    });
  });
  return { fetchImpl, seen };
}

type Harness = {
  copier: ArtifactCopier;
  uploads: Array<{ bytes: string; mimeType: string }>;
  copied: Array<{ fileId: string; sha256: string; sizeBytes: number; storageId: string }>;
  failed: TranscriptFileFailedReport[];
  sleeps: number[];
  downloads: number;
};

function harness(o: {
  grant?: () => DownloadGrant;
  fetchImpl?: typeof fetch;
  identityHeaders?: Record<string, string>;
  fetcher?: MediaFetcher;
  maxBytes?: number;
  duplicate?: boolean;
}): Harness {
  const h: Harness = { uploads: [], copied: [], failed: [], sleeps: [], downloads: 0 } as unknown as Harness;
  h.copier = new ArtifactCopier({
    download: async () => {
      h.downloads++;
      return o.grant?.() ?? { ok: true, url: ticketed(ATTACHMENT), mimeType: "text/plain", sizeBytes: 16 };
    },
    httpBase: () => BASE,
    identityHeaders: () => o.identityHeaders ?? {},
    mediaFetcher: () => o.fetcher,
    maxBytes: () => o.maxBytes ?? 1024 * 1024,
    upload: async (stream, mimeType) => {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
      h.uploads.push({ bytes: Buffer.concat(chunks).toString("utf8"), mimeType });
      return `storage-${h.uploads.length}`;
    },
    copied: async (r) => {
      h.copied.push(r);
      return { ok: true, state: "copied", duplicate: o.duplicate === true };
    },
    failed: async (r) => {
      h.failed.push(r);
      return { ok: true };
    },
    ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
    log: () => {},
  });
  return h;
}

const managedFile = (extra: Partial<TranscriptFileToCopy> = {}): TranscriptFileToCopy => ({
  fileId: "f1",
  sessionKey: SK,
  artifactId: ART,
  kind: "document",
  mimeType: "text/plain",
  sizeBytes: 16,
  attempts: 0,
  ...extra,
});

describe("src/gateway/managed-image-attachments.test.ts (v2026.9.33)", () => {
  // :896 "serves an exact transcript image through a short-lived artifact ticket" — and a
  // ticket presented for another attachment id is refused (401).
  it(":896 the ticketed URL is read with NO credential, and the bytes reach storage with their sha256", async () => {
    const route = managedRoute();
    const h = harness({ fetchImpl: route.fetchImpl as unknown as typeof fetch });
    const outcome = await h.copier.copyWithRetries(managedFile());
    expect(outcome).toEqual({ kind: "copied", duplicate: false });
    expect(route.seen).toHaveLength(1);
    expect(route.seen[0]!.url).toBe(`${BASE}${ticketed(ATTACHMENT)}`);
    expect(Object.keys(route.seen[0]!.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(h.uploads).toEqual([{ bytes: BYTES, mimeType: "text/plain" }]);
    expect(h.copied).toEqual([{ fileId: "f1", storageId: "storage-1", sha256: SHA, sizeBytes: 16, mimeType: "text/plain" }]);
    expect(h.failed).toEqual([]);
  });

  it(":896 a ticket that does not match the attachment is refused — retried with a fresh grant, never answered with a credential", async () => {
    const route = managedRoute();
    let n = 0;
    const h = harness({
      fetchImpl: route.fetchImpl as unknown as typeof fetch,
      // First grant names a ticket for ANOTHER attachment (401), the next one is right.
      grant: () => ({ ok: true, url: n++ === 0 ? ticketed(ATTACHMENT).replace(`ticket-for-${ATTACHMENT}`, `ticket-for-${OTHER}`) : ticketed(ATTACHMENT) }),
    });
    const outcome = await h.copier.copyWithRetries(managedFile());
    expect(outcome.kind).toBe("copied");
    expect(h.downloads).toBe(2);
    expect(h.sleeps).toEqual([COPY_RETRY_DELAYS_MS[0]]);
    for (const s of route.seen) expect(Object.keys(s.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  // :1128 "rejects unauthenticated requests before serving bytes": the canonical URL with no
  // ticket and no credential is 401 — so a grant without its ticket can never succeed, and
  // the copier never "repairs" it with an owner Bearer.
  it(":1128 a grant whose URL lacks its ticket is retried, then left pending — never read with a Bearer", async () => {
    const route = managedRoute();
    const h = harness({ fetchImpl: route.fetchImpl as unknown as typeof fetch, grant: () => ({ ok: true, url: canonical(ATTACHMENT) }) });
    const outcome = await h.copier.copyWithRetries(managedFile());
    expect(outcome).toEqual({ kind: "retry", reason: "http_401" });
    expect(route.seen).toHaveLength(1 + COPY_RETRY_DELAYS_MS.length);
    expect(h.failed).toEqual([{ fileId: "f1", outcome: "retry", reason: "http_401" }]);
    expect(h.uploads).toEqual([]);
  });

  // :1141 "rejects non-owner trusted-proxy requests with self-declared session ownership" and
  // :1167 "serves owner trusted-proxy requests with admin scope": the HEADER path needs an
  // owner — which a person's identity is not. Atrium takes the ticket path, which does not
  // depend on the auth mode: in trusted-proxy it ATTRIBUTES the request (identity headers)
  // and still sends no credential.
  it(":1141/:1167 in trusted-proxy mode the identity headers ride the ticketed read, no Authorization", async () => {
    const route = managedRoute();
    const identity = { "x-forwarded-user": "atrium-system", "x-forwarded-proto": "https" };
    const h = harness({ fetchImpl: route.fetchImpl as unknown as typeof fetch, identityHeaders: identity });
    expect((await h.copier.copyWithRetries(managedFile())).kind).toBe("copied");
    expect(route.seen[0]!.headers).toEqual(identity);
  });
});

describe("outcomes the gateway states", () => {
  it("artifacts.download answers artifact_not_found (a reset killed the copy): gone, at once, no retry", async () => {
    const h = harness({ grant: () => ({ ok: false, reason: "artifact_not_found" }) });
    expect(await h.copier.copyWithRetries(managedFile())).toEqual({ kind: "gone", reason: "artifact_not_found" });
    expect(h.sleeps).toEqual([]);
    expect(h.failed).toEqual([{ fileId: "f1", outcome: "gone", reason: "artifact_not_found" }]);
  });

  it("the ticket was minted, then the record left the transcript (404): gone", async () => {
    const route = managedRoute({ gone: true });
    const h = harness({ fetchImpl: route.fetchImpl as unknown as typeof fetch });
    expect(await h.copier.copyWithRetries(managedFile())).toEqual({ kind: "gone", reason: "not_found" });
  });

  it("over the media cap: refused, from the grant's size, before any byte is read", async () => {
    const route = managedRoute();
    const h = harness({ fetchImpl: route.fetchImpl as unknown as typeof fetch, maxBytes: 10 });
    expect(await h.copier.copyWithRetries(managedFile({ sizeBytes: undefined }))).toEqual({ kind: "refused", reason: "too_large" });
    expect(route.seen).toEqual([]);
  });

  it("over the media cap with no size announced: refused when the flow passes it", async () => {
    const route = managedRoute({ body: "x".repeat(64), length: 0 });
    const h = harness({
      fetchImpl: (async (i: string, init?: RequestInit) => {
        const r = await route.fetchImpl(i, init);
        // Chunked: no Content-Length at all.
        return new Response(r.body, { status: r.status, headers: { "content-type": "text/plain" } });
      }) as unknown as typeof fetch,
      grant: () => ({ ok: true, url: ticketed(ATTACHMENT) }),
      maxBytes: 10,
    });
    expect(await h.copier.copyWithRetries(managedFile({ sizeBytes: undefined }))).toEqual({ kind: "refused", reason: "too_large" });
    expect(h.copied).toEqual([]);
  });

  it("a URL off the gateway's origin or off the managed route is never followed", async () => {
    const route = managedRoute();
    const h = harness({
      fetchImpl: route.fetchImpl as unknown as typeof fetch,
      grant: () => ({ ok: true, url: `https://elsewhere.example${ticketed(ATTACHMENT)}` }),
    });
    expect((await h.copier.copyOnce(managedFile())).kind).toBe("retry");
    expect(route.seen).toEqual([]);
  });

  it("the race is Convex's: a copy that lost reports `copied` as a duplicate", async () => {
    const route = managedRoute();
    const h = harness({ fetchImpl: route.fetchImpl as unknown as typeof fetch, duplicate: true });
    expect(await h.copier.copyWithRetries(managedFile())).toEqual({ kind: "copied", duplicate: true });
    expect(h.copier.stats.duplicates).toBe(1);
  });

  it("one file is copied once by this process however often it is handed over", async () => {
    const route = managedRoute();
    const h = harness({ fetchImpl: route.fetchImpl as unknown as typeof fetch });
    h.copier.enqueue([managedFile(), managedFile()]);
    h.copier.enqueue([managedFile()]);
    await h.copier.idle();
    expect(h.uploads).toHaveLength(1);
  });
});

describe("providers/openclaw/artifact-download.ts", () => {
  it("only the gateway's two named refusals decide; any other refusal is transient", () => {
    const answered = (type: string) => new GatewayAnsweredError("INVALID_REQUEST: x", { type, artifactId: ART }, "INVALID_REQUEST");
    expect(classifyArtifactDownloadError(answered("artifact_not_found"))).toEqual({ ok: false, reason: "artifact_not_found" });
    expect(classifyArtifactDownloadError(answered("artifact_download_unsupported"))).toEqual({
      ok: false,
      reason: "artifact_download_unsupported",
    });
    expect(classifyArtifactDownloadError(answered("artifact_scope_not_found"))).toEqual({ ok: false, reason: "transient" });
    expect(classifyArtifactDownloadError(new Error("artifacts.download timed out"))).toEqual({ ok: false, reason: "transient" });
  });

  it("the request is the Control UI's own: {sessionKey, artifactId}, no transport, 30 s", async () => {
    const calls: unknown[] = [];
    const conn = {
      request: async (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
        calls.push([method, params, timeoutMs]);
        return { payload: { artifact: { id: ART, mimeType: "text/plain", sizeBytes: 16 }, url: ticketed(ATTACHMENT), expiresAt: "x" } };
      },
    };
    const grant = await requestArtifactDownload(conn, SK, ART);
    expect(calls).toEqual([["artifacts.download", { sessionKey: SK, artifactId: ART }, 30_000]]);
    expect(grant).toEqual({ ok: true, url: ticketed(ATTACHMENT), mimeType: "text/plain", sizeBytes: 16 });
  });
});

describe("src/gateway/control-ui-assistant-media-policy.test.ts (v2026.9.33) — MEDIA: through the fetcher", () => {
  /** The `/__openclaw__/assistant-media` route (src/gateway/control-ui.ts:429-526): the meta
   *  probe mints a ticket for the NAMED session; the bytes are served only to the same
   *  session (`sameSession`), else 404. */
  function mediaRoute() {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      seen.push(url.toString());
      const session = url.searchParams.get("sessionKey") ?? "";
      if (url.searchParams.get("meta") === "1") {
        return Response.json({ available: true, mediaTicket: `v1.${session}` });
      }
      if (url.searchParams.get("mediaTicket") !== `v1.${session}` || session === "") {
        return new Response("not found", { status: 404 });
      }
      return new Response("MEDIA_BYTES", { status: 200, headers: { "content-type": "text/plain" } });
    });
    return { fetchImpl, seen };
  }

  // :157 "binds relative media tickets to the execution directory within the session root"
  // and :441 "does not … move an allowed image ticket to another session": a ticket is good
  // for the session it was minted for — the copier names the ROW's session on both requests.
  it(":157/:441 the meta probe and the download name the row's session, and the bytes are copied", async () => {
    const route = mediaRoute();
    const fetcher = new GatewayHttpMediaFetcher({
      httpBase: BASE,
      token: () => "tok",
      maxBytes: 1024,
      fetchImpl: route.fetchImpl as unknown as typeof fetch,
    });
    const h = harness({ fetcher });
    const outcome = await h.copier.copyWithRetries({ fileId: "m1", sessionKey: SK, mediaSource: "chart.png", kind: "image", attempts: 0 });
    expect(outcome.kind).toBe("copied");
    expect(route.seen.map((u) => new URL(u).searchParams.get("sessionKey"))).toEqual([SK, SK]);
    expect(h.uploads).toEqual([{ bytes: "MEDIA_BYTES", mimeType: "text/plain" }]);
  });

  it(":441 without the session, the same reference is refused (what the fetcher did before) — off/shadow callers unchanged", async () => {
    const route = mediaRoute();
    const fetcher = new GatewayHttpMediaFetcher({
      httpBase: BASE,
      token: () => "tok",
      maxBytes: 1024,
      fetchImpl: route.fetchImpl as unknown as typeof fetch,
    });
    const opened = await fetcher.open("chart.png");
    expect(opened).toEqual({ ok: false, reason: "fetch_error" });
    expect(route.seen.every((u) => !new URL(u).searchParams.has("sessionKey"))).toBe(true);
  });

  it("media disabled on the instance: refused (media_disabled), stated at once", async () => {
    const h = harness({});
    expect(await h.copier.copyWithRetries({ fileId: "m1", sessionKey: SK, mediaSource: "/x/a.txt", kind: "document", attempts: 0 })).toEqual({
      kind: "refused",
      reason: "media_disabled",
    });
  });

  it("a fetcher verdict maps to gone / refused; a transport failure is retried", async () => {
    const answer = (reason: "not_found" | "path_escape" | "fetch_error"): MediaFetcher => ({
      open: async () => ({ ok: false, reason }),
    });
    const file = { fileId: "m1", sessionKey: SK, mediaSource: "/x/a.txt", kind: "document", attempts: 0 };
    expect(await harness({ fetcher: answer("not_found") }).copier.copyOnce(file)).toEqual({ kind: "gone", reason: "not_found" });
    expect(await harness({ fetcher: answer("path_escape") }).copier.copyOnce(file)).toEqual({ kind: "refused", reason: "path_escape" });
    expect(await harness({ fetcher: answer("fetch_error") }).copier.copyOnce(file)).toEqual({ kind: "retry", reason: "fetch_error" });
  });

  it("the copied MEDIA bytes carry their own sha256", async () => {
    const fetcher: MediaFetcher = {
      open: async () => ({ ok: true, stream: Readable.from([Buffer.from(BYTES)]), mimeType: "text/plain", size: 16 }),
    };
    const h = harness({ fetcher });
    await h.copier.copyWithRetries({ fileId: "m1", sessionKey: SK, mediaSource: "/x/a.txt", kind: "document", attempts: 0 });
    expect(h.copied[0]).toMatchObject({ sha256: SHA, sizeBytes: 16 });
  });
});
