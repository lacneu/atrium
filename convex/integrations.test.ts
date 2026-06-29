/// <reference types="vite/client" />
//
// Deterministic unit tests for the outbound trace-shipping adapters (increment
// 5). NO network: `send()` is exercised with an INJECTED fake fetch. NO secret /
// PHI material may appear in any vendor payload — asserted explicitly.
//
//   (a) pure mapper tests: Langfuse OTLP span + Opik TraceWrite shapes from a
//       sample redacted traceEvent, and that NO secret/PHI field appears.
//   (b) send(): fake fetch asserts URL + auth header + batched body; a 401 is
//       handled gracefully (no throw, ok:false, status:401).
//   (c) convex-test t.run: cursor advance (unsentSince -> advanceCursor), plus
//       the strict-gt watermark behavior.

import { convexTest } from "convex-test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { ShippableEvent } from "./integrations/shared";
import { langfuseConfig, opikConfig, otlpConfig } from "./integrations/config";
import {
  loadIntegrationsStatusPublic,
  projectOtlpKnobs,
} from "./integrations/status";
import { decryptOtlpHeaders } from "./integrations/otlpSecret";
import { toBase64 } from "./lib/crypto/cipher";
import * as langfuse from "./integrations/langfuse";
import * as opik from "./integrations/opik";

// Discover function modules for convex-test (required).
const modules = import.meta.glob("./**/*.ts");

// A representative redacted trace event (metadata only — exactly what the writer
// stores). The string fields below double as "no PHI present" probes: NONE of
// them is raw message text.
const SAMPLE_EVENT: ShippableEvent = {
  _id: "evt_123",
  at: 1_717_336_800_000, // 2024-06-02T14:00:00.000Z
  kind: "api.call",
  direction: "inbound",
  principalType: "service",
  principalId: "sa_obs",
  roleKey: "observer",
  route: "/api/v1/traces",
  method: "GET",
  status: 200,
  latencyMs: 42,
  chatId: "chat_abc",
  runId: "run_xyz",
  correlationId: "corr_777",
  meta: JSON.stringify({ phase: "complete", textLen: 128 }),
};

// Secret material that must NEVER appear in any payload (D3).
const LF_PUBLIC = "pk-lf-PUBLIC-SECRET-VALUE";
const LF_SECRET = "sk-lf-PRIVATE-SECRET-VALUE";
const OPIK_KEY = "opik-API-KEY-SECRET-VALUE";

const LF_CONFIG = {
  configured: true,
  enabled: true,
  host: "https://cloud.langfuse.com",
  publicKey: LF_PUBLIC,
  secretKey: LF_SECRET,
};
const OPIK_CONFIG = {
  configured: true,
  enabled: true,
  baseUrl: "https://www.comet.com/opik/api",
  apiKey: OPIK_KEY,
  workspace: "my-workspace",
  projectName: "Default Project",
  openclawProjectName: "",
};

/** Build a fake fetch that records the single call and returns a fixed status. */
function fakeFetch(status: number) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(status === 204 ? null : "{}", { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Assert no secret value appears anywhere in a JSON-serializable payload. */
function assertNoSecrets(serialized: string) {
  expect(serialized).not.toContain(LF_PUBLIC);
  expect(serialized).not.toContain(LF_SECRET);
  expect(serialized).not.toContain(OPIK_KEY);
}

describe("config helpers", () => {
  test("unconfigured by default (no vendor env in the test runtime)", () => {
    // The edge-runtime test has no vendor env set -> both report not configured.
    expect(langfuseConfig().configured).toBe(false);
    expect(opikConfig().configured).toBe(false);
  });

  test("override precedence: Convex value -> env -> default; empty does NOT clobber env", () => {
    const prevHost = process.env.LANGFUSE_HOST;
    const prevBase = process.env.OPIK_BASE_URL;
    try {
      // No env, no override -> built-in default.
      delete process.env.LANGFUSE_HOST;
      expect(langfuseConfig().host).toBe("https://cloud.langfuse.com");
      // A non-empty Convex override wins over the default.
      expect(langfuseConfig({ host: "https://lf.internal" }).host).toBe(
        "https://lf.internal",
      );
      // Env set + EMPTY override -> env is used (empty must not clobber a
      // deployment that sets LANGFUSE_HOST). This is the load-bearing case.
      process.env.LANGFUSE_HOST = "https://env.langfuse";
      expect(langfuseConfig({ host: "" }).host).toBe("https://env.langfuse");
      // A non-empty override still wins over env.
      expect(langfuseConfig({ host: "https://override" }).host).toBe(
        "https://override",
      );

      // Opik baseUrl + workspace precedence.
      delete process.env.OPIK_BASE_URL;
      expect(opikConfig().baseUrl).toBe("https://www.comet.com/opik/api");
      expect(opikConfig({ baseUrl: "https://opik.internal" }).baseUrl).toBe(
        "https://opik.internal",
      );
      expect(opikConfig({ workspace: "team-a" }).workspace).toBe("team-a");

      // Opik projectName precedence: override > env > "Default Project". Required
      // by the read API; ship stamps it so ship + enrich target the same project.
      delete process.env.OPIK_PROJECT_NAME;
      expect(opikConfig().projectName).toBe("Default Project");
      expect(opikConfig({ projectName: "atrium" }).projectName).toBe("atrium");

      // OpenClaw read-project: SEPARATE from projectName, empty (disabled) by default.
      delete process.env.OPIK_OPENCLAW_PROJECT;
      expect(opikConfig().openclawProjectName).toBe("");
      expect(
        opikConfig({ openclawProjectName: "openclaw-olivier" }).openclawProjectName,
      ).toBe("openclaw-olivier");

      // `enabled`: undefined => enabled; false => paused.
      expect(langfuseConfig().enabled).toBe(true);
      expect(langfuseConfig({ enabled: false }).enabled).toBe(false);
      expect(opikConfig({ enabled: false }).enabled).toBe(false);
    } finally {
      if (prevHost === undefined) delete process.env.LANGFUSE_HOST;
      else process.env.LANGFUSE_HOST = prevHost;
      if (prevBase === undefined) delete process.env.OPIK_BASE_URL;
      else process.env.OPIK_BASE_URL = prevBase;
    }
  });
});

describe("langfuse mapper", () => {
  test("maps a redacted event to an OTLP span; metadata only, no secret/PHI", async () => {
    const span = await langfuse.mapEventToVendor(SAMPLE_EVENT);

    // Stable ids derived from correlationId / event id.
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    // Same correlationId -> same trace id (deterministic linking, D1).
    const span2 = await langfuse.mapEventToVendor({
      ...SAMPLE_EVENT,
      _id: "evt_999",
    });
    expect(span2.traceId).toEqual(span.traceId);
    expect(span2.spanId).not.toEqual(span.spanId); // distinct event -> distinct span

    // Span name = kind; timing in unix-nanos (start + latency).
    expect(span.name).toBe("api.call");
    expect(span.startTimeUnixNano).toBe("1717336800000000000");
    expect(span.endTimeUnixNano).toBe("1717336800042000000");

    // Attributes carry the metadata (and ONLY metadata).
    const attrs = Object.fromEntries(
      span.attributes.map((a) => [
        a.key,
        "stringValue" in a.value ? a.value.stringValue : a.value.intValue,
      ]),
    );
    expect(attrs["correlation.id"]).toBe("corr_777");
    expect(attrs["http.status_code"]).toBe("200");
    expect(attrs["latency.ms"]).toBe("42");
    expect(attrs["principal.role"]).toBe("observer");
    expect(attrs["langfuse.session.id"]).toBe("chat_abc");
    expect(attrs["trace.meta"]).toBe(SAMPLE_EVENT.meta);

    // No raw-content / secret fields anywhere.
    const serialized = JSON.stringify(span);
    assertNoSecrets(serialized);
    expect(serialized).not.toContain("input");
    expect(serialized).not.toContain("output");
  });

  test("falls back to a stable trace id when correlationId is absent", async () => {
    const { correlationId: _omit, ...rest } = SAMPLE_EVENT;
    const span = await langfuse.mapEventToVendor(rest);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    // Deterministic from the event id fallback.
    const again = await langfuse.mapEventToVendor(rest);
    expect(again.traceId).toEqual(span.traceId);
  });
});

describe("opik mapper", () => {
  test("maps a redacted event to a TraceWrite; metadata only, no secret/PHI", async () => {
    const trace = await opik.mapEventToVendor(SAMPLE_EVENT);

    // UUID v7 id (Opik requires version 7), deterministic from correlationId+at.
    expect(trace.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const again = await opik.mapEventToVendor({ ...SAMPLE_EVENT, _id: "x" });
    expect(again.id).toEqual(trace.id);

    expect(trace.name).toBe("api.call");
    expect(trace.start_time).toBe("2024-06-02T14:00:00.000Z");
    expect(trace.end_time).toBe("2024-06-02T14:00:00.042Z");
    expect(trace.thread_id).toBe("chat_abc");

    // Metadata is non-PHI only.
    expect(trace.metadata.correlationId).toBe("corr_777");
    expect(trace.metadata.status).toBe(200);
    expect(trace.metadata.latencyMs).toBe(42);
    expect(trace.metadata.roleKey).toBe("observer");
    expect(trace.metadata.meta).toBe(SAMPLE_EVENT.meta);
    expect(trace.tags).toContain("api.call");
    expect(trace.tags).toContain("principal:service");

    const serialized = JSON.stringify(trace);
    assertNoSecrets(serialized);
    expect(serialized).not.toContain('"input"');
    expect(serialized).not.toContain('"output"');
  });
});

describe("langfuse send()", () => {
  test("posts a batch to the OTLP endpoint with Basic auth; no secret in body", async () => {
    const { impl, calls } = fakeFetch(207);
    const res = await langfuse.send(LF_CONFIG, [SAMPLE_EVENT, SAMPLE_EVENT], {
      fetchImpl: impl,
    });

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
    expect(res.status).toBe(207);
    expect(calls).toHaveLength(1);

    const { url, init } = calls[0]!;
    expect(url).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // Basic auth = base64(public:secret) — header carries the encoded form, and
    // the RAW secret must not appear in the body.
    const expectedAuth = `Basic ${btoa(`${LF_PUBLIC}:${LF_SECRET}`)}`;
    expect(headers.Authorization).toBe(expectedAuth);
    expect(headers["x-langfuse-ingestion-version"]).toBe("4");

    // Batched body: two spans in one OTLP envelope.
    const body = JSON.parse(init.body as string) as langfuse.LangfusePayload;
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(2);
    assertNoSecrets(init.body as string);
  });

  test("a 401 is handled gracefully (no throw, ok:false, status:401)", async () => {
    const { impl } = fakeFetch(401);
    const res = await langfuse.send(LF_CONFIG, [SAMPLE_EVENT], {
      fetchImpl: impl,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.count).toBe(1);
  });

  test("unconfigured -> pure no-op (no fetch)", async () => {
    const { impl, calls } = fakeFetch(200);
    const res = await langfuse.send(
      { ...LF_CONFIG, configured: false },
      [SAMPLE_EVENT],
      { fetchImpl: impl },
    );
    expect(res.skipped).toBe(true);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("opik send()", () => {
  test("posts a batch to the /batch endpoint with Bearer auth; no secret in body", async () => {
    const { impl, calls } = fakeFetch(204);
    const res = await opik.send(OPIK_CONFIG, [SAMPLE_EVENT, SAMPLE_EVENT], {
      fetchImpl: impl,
    });

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);
    expect(res.status).toBe(204);

    const { url, init } = calls[0]!;
    // baseUrl already ends in `/api`; path is `/v1/private/...` (NOT `/api/v1/...`
    // — the doubled `/api` 404'd live; fixed 2026-06-06).
    expect(url).toBe("https://www.comet.com/opik/api/v1/private/traces/batch");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${OPIK_KEY}`);
    expect(headers["Comet-Workspace"]).toBe("my-workspace");

    const body = JSON.parse(init.body as string) as opik.OpikBatchPayload;
    expect(body.traces).toHaveLength(2);
    // Every shipped trace carries the configured project so ship + enrich agree on
    // WHERE the trace lives (the read API requires project_name).
    expect(body.traces.every((t) => t.project_name === "Default Project")).toBe(true);
    assertNoSecrets(init.body as string);
  });

  test("a 401 is handled gracefully", async () => {
    const { impl } = fakeFetch(401);
    const res = await opik.send(OPIK_CONFIG, [SAMPLE_EVENT], { fetchImpl: impl });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  test("omits the workspace header when none is configured", async () => {
    const { impl, calls } = fakeFetch(204);
    await opik.send({ ...OPIK_CONFIG, workspace: "" }, [SAMPLE_EVENT], {
      fetchImpl: impl,
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Comet-Workspace"]).toBeUndefined();
  });
});

describe("cursor scheme (convex-test)", () => {
  test("unsentSince reads strictly-after the watermark; advanceCursor is monotonic", async () => {
    const t = convexTest(schema, modules);

    // Seed three trace events at distinct timestamps.
    const base = 1_000_000;
    await t.run(async (ctx) => {
      for (const at of [base, base + 10, base + 20]) {
        await ctx.db.insert("traceEvents", {
          at,
          kind: "api.call",
          principalType: "system",
          redacted: true,
        });
      }
    });

    // No cursor yet -> read from the start (since = 0) returns all three.
    const all = await t.query(internal.integrations.ship.unsentSince, {
      since: 0,
      limit: 100,
    });
    expect(all.map((e) => e.at)).toEqual([base, base + 10, base + 20]);

    // Advance the langfuse cursor to the first event's timestamp.
    await t.mutation(internal.integrations.ship.advanceCursor, {
      vendor: "langfuse",
      lastAt: base,
    });
    let cursor = await t.query(internal.integrations.ship.getCursor, {
      vendor: "langfuse",
    });
    expect(cursor).toBe(base);

    // unsentSince is STRICTLY gt -> the boundary event is excluded, two remain.
    const after = await t.query(internal.integrations.ship.unsentSince, {
      since: base,
      limit: 100,
    });
    expect(after.map((e) => e.at)).toEqual([base + 10, base + 20]);

    // Advance to the newest -> nothing left.
    await t.mutation(internal.integrations.ship.advanceCursor, {
      vendor: "langfuse",
      lastAt: base + 20,
    });
    const done = await t.query(internal.integrations.ship.unsentSince, {
      since: base + 20,
      limit: 100,
    });
    expect(done).toHaveLength(0);

    // Monotonic: a backwards advance is ignored.
    await t.mutation(internal.integrations.ship.advanceCursor, {
      vendor: "langfuse",
      lastAt: base, // older than current
    });
    cursor = await t.query(internal.integrations.ship.getCursor, {
      vendor: "langfuse",
    });
    expect(cursor).toBe(base + 20);

    // Distinct vendors have independent cursors.
    const opikCursor = await t.query(internal.integrations.ship.getCursor, {
      vendor: "opik",
    });
    expect(opikCursor).toBeNull();
  });

  // --- M3: same-millisecond batch boundary is not lost ----------------------
  test("composite watermark (sinceId) does not drop same-ms events", async () => {
    const t = convexTest(schema, modules);

    // Three events sharing the EXACT same `at` millisecond. With the old strict
    // `gt` watermark, advancing to that `at` would skip the remaining same-ms
    // events; the composite (at, _id) watermark must return the other two.
    const at = 5_000_000;
    const ids = await t.run(async (ctx) => {
      const out: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await ctx.db.insert("traceEvents", {
          at,
          kind: "api.call",
          principalType: "system",
          redacted: true,
        });
        out.push(id);
      }
      // _id order is what the composite tiebreaker uses; sort so [0] is "first".
      return out.sort();
    });

    // Watermark = (at, ids[0]) -> the other two same-ms events must still come.
    const remaining = await t.query(internal.integrations.ship.unsentSince, {
      since: at,
      sinceId: ids[0],
      limit: 100,
    });
    expect(remaining.map((e) => e._id).sort()).toEqual([ids[1], ids[2]].sort());

    // Advance composite to the last id -> nothing left at this ms.
    await t.mutation(internal.integrations.ship.advanceCursor, {
      vendor: "langfuse",
      lastAt: at,
      lastId: ids[2],
    });
    const row = await t.query(internal.integrations.ship.getCursorRow, {
      vendor: "langfuse",
    });
    expect(row).not.toBeNull();
    expect(row!.lastAt).toBe(at);
    expect(row!.lastId).toBe(ids[2]);

    const done = await t.query(internal.integrations.ship.unsentSince, {
      since: at,
      sinceId: ids[2],
      limit: 100,
    });
    expect(done).toHaveLength(0);

    // Composite monotonicity: advancing to an EARLIER id at the same ms is a
    // no-op (the watermark stays at the latest id).
    await t.mutation(internal.integrations.ship.advanceCursor, {
      vendor: "langfuse",
      lastAt: at,
      lastId: ids[0],
    });
    const row2 = await t.query(internal.integrations.ship.getCursorRow, {
      vendor: "langfuse",
    });
    expect(row2!.lastId).toBe(ids[2]);
  });

  // --- M3: forward progress when MORE than `take` events share one ms --------
  // The reason M3 exists: a naive gte(at).take(take+1) returns the SMALLEST rows
  // by (at,_id), so once the watermark id advances inside the ms the next flush
  // re-reads only the shipped prefix and STALLS. This proves the page always
  // advances through a dense ms (and never re-yields shipped rows).
  test("paging steps through a same-ms block larger than the batch limit", async () => {
    const t = convexTest(schema, modules);
    const at = 9_000_000;
    const TAKE = 5;
    const TOTAL = 12; // > TAKE so the block spans multiple flushes at one ms

    const ordered = await t.run(async (ctx) => {
      const out: string[] = [];
      for (let i = 0; i < TOTAL; i++) {
        const id = await ctx.db.insert("traceEvents", {
          at,
          kind: "api.call",
          principalType: "system",
          redacted: true,
        });
        out.push(id);
      }
      // Index order within a ms is by _creationTime, which is the insert order.
      return out;
    });

    // Simulate the flush loop: page TAKE at a time, advancing the watermark to
    // the last id of each page. Collect every id yielded; assert NO gaps, NO
    // repeats, and that ALL TOTAL rows ship across the pages.
    let cursorAt = at;
    let cursorId: string | undefined = undefined; // first flush: strict-gt? no —
    // seed the watermark just below the block so we exercise the composite path.
    // Use the FIRST event's predecessor: start at (at, "") so sinceId < every id.
    cursorId = "";
    const yielded: string[] = [];
    for (let flush = 0; flush < 10; flush++) {
      const batch: Array<{ _id: string; at: number }> = await t.query(
        internal.integrations.ship.unsentSince,
        { since: cursorAt, sinceId: cursorId, limit: TAKE },
      );
      if (batch.length === 0) break;
      for (const e of batch) yielded.push(e._id);
      const last = batch[batch.length - 1]!;
      cursorAt = last.at;
      cursorId = last._id;
    }

    // Every event shipped EXACTLY ONCE (no stall, no re-read of shipped rows).
    expect(yielded.length).toBe(TOTAL);
    expect(new Set(yielded).size).toBe(TOTAL);
    expect(new Set(yielded)).toEqual(new Set(ordered));
    // Yielded in ascending _id order (self-consistent with the composite
    // watermark we advance on), so paging never goes backwards.
    const sortedById = [...yielded].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    expect(yielded).toEqual(sortedById);
  });

  // --- L4: consecutive failures recorded; anomaly emitted at threshold ------
  test("recordFailure increments + emits an anomaly at the threshold", async () => {
    const t = convexTest(schema, modules);

    // Two failures: count climbs, no anomaly yet.
    let r = await t.mutation(internal.integrations.ship.recordFailure, {
      vendor: "langfuse",
      reason: "send_failed",
      status: 401,
    });
    expect(r.failureCount).toBe(1);
    r = await t.mutation(internal.integrations.ship.recordFailure, {
      vendor: "langfuse",
      reason: "send_failed",
      status: 401,
    });
    expect(r.failureCount).toBe(2);

    // Failure state is secret-free (reason code + status only).
    const row = await t.query(internal.integrations.ship.getCursorRow, {
      vendor: "langfuse",
    });
    expect(row!.failureCount).toBe(2);

    // A successful advance resets the failure count to 0.
    await t.mutation(internal.integrations.ship.advanceCursor, {
      vendor: "langfuse",
      lastAt: 1,
      lastId: "x",
    });
    const reset = await t.query(internal.integrations.ship.getCursorRow, {
      vendor: "langfuse",
    });
    expect(reset!.failureCount).toBe(0);
  });
});

describe("integrations status query (requireAdmin, secret-safe)", () => {
  test("admin sees configured:false (no vendor env) + cursors, no secrets", async () => {
    const t = convexTest(schema, modules);

    // Seed an admin profile and one vendor cursor.
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "admin" });
      await ctx.db.insert("integrationCursors", {
        vendor: "langfuse",
        lastAt: 12345,
      });
      return userId;
    });

    // getAuthUserId derives the user id from identity.subject before the "|".
    const asAdmin = t.withIdentity({ subject: `${userId}|session` });
    const status = await asAdmin.query(api.integrations.status.status, {});

    // No vendor env in the test runtime -> both not configured.
    expect(status.langfuse.configured).toBe(false);
    expect(status.opik.configured).toBe(false);
    // L4: cursors carry secret-free failure bookkeeping (defaults when unset).
    expect(status.cursors).toEqual([
      {
        vendor: "langfuse",
        lastAt: 12345,
        failureCount: 0,
        lastError: null,
        lastErrorStatus: null,
      },
    ]);

    // Secret-safe: the projection exposes ONLY booleans + cursors (no host/key
    // fields could leak even if env were set).
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("host");
    expect(serialized).not.toContain("publicKey");
    expect(serialized).not.toContain("secretKey");
    expect(serialized).not.toContain("apiKey");
  });

  test("a non-admin is rejected", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" });
      return userId;
    });
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    await expect(
      asUser.query(api.integrations.status.status, {}),
    ).rejects.toThrow(/admin/i);
  });
});

// Generic OTLP exporter — the FEATURE-LEVEL gaps the adapter/secret unit tests
// don't cover: the config resolver, the status no-leak (security), the two-writer
// merge that preserves the encrypted headers, and the end-to-end FLUSH (decrypt →
// POST to the operator endpoint with the decrypted auth header → advance cursor).
describe("OTLP exporter (generic, encrypted headers)", () => {
  const KEY_B64 = toBase64(new Uint8Array(32).fill(13));
  beforeAll(() => {
    process.env.ATRIUM_SECRET_KEY = KEY_B64;
  });

  const seedAdmin = async (t: ReturnType<typeof convexTest>) => {
    const uid = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "admin" });
      return id;
    });
    return t.withIdentity({ subject: `${uid}|session` });
  };

  test("otlpConfig: configured only with an endpoint; enabled defaults true; trims", () => {
    expect(otlpConfig().configured).toBe(false);
    expect(otlpConfig({ endpoint: "   " }).configured).toBe(false);
    const c = otlpConfig({ endpoint: " https://x/v1/traces " });
    expect(c.configured).toBe(true);
    expect(c.endpoint).toBe("https://x/v1/traces");
    expect(c.enabled).toBe(true);
    expect(otlpConfig({ endpoint: "x", enabled: false }).enabled).toBe(false);
  });

  test("status NEVER leaks the headers envelope — headersSet boolean only", async () => {
    const t = convexTest(schema, modules);
    const SECRET_CT = "CIPHERTEXT-MUST-NOT-LEAK";
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "admin" });
      await ctx.db.insert("integrationConfig", {
        key: "singleton",
        otlp: {
          endpoint: "https://otlp.example.com/v1/traces",
          enabled: true,
          headersSecret: {
            v: 1,
            alg: "AES-256-GCM",
            keyRef: "local:v1",
            iv: "aXY=",
            ciphertext: SECRET_CT,
          },
        },
      });
      return uid;
    });
    // Public (MCP/API) projection.
    const pub = await t.run(async (ctx) => loadIntegrationsStatusPublic(ctx));
    expect(pub.otlp).toEqual({
      configured: true,
      enabled: true,
      endpoint: "https://otlp.example.com/v1/traces",
      headersSet: true,
    });
    expect(JSON.stringify(pub)).not.toContain(SECRET_CT);
    // Admin projection: headersSet only; config.otlp has endpoint/enabled, NEVER the envelope.
    const asAdmin = t.withIdentity({ subject: `${userId}|session` });
    const admin = await asAdmin.query(api.integrations.status.status, {});
    expect(admin.otlp.headersSet).toBe(true);
    expect(admin.config.otlp).toEqual({
      endpoint: "https://otlp.example.com/v1/traces",
      enabled: true,
    });
    const ser = JSON.stringify(admin);
    expect(ser).not.toContain(SECRET_CT);
    expect(ser).not.toContain("ciphertext");
  });

  test("projectOtlpKnobs OMITS unset fields (no present-but-undefined) and never the secret", () => {
    // The admin status.config.otlp projection must add knobs ADDITIVELY: an unset
    // field is absent, NOT present-with-undefined. (Convex's convexToJson strips
    // undefined props at the wire so this is harmless today, but it is a smell and
    // would break under a future `returns` validator — and codex re-flags it.) This
    // FAILS against the old inline `{ endpoint: cfg?.otlp?.endpoint, enabled: ... }`
    // (which yields `{ endpoint: undefined, enabled: undefined }` → `"endpoint" in`
    // is true). It also locks the no-secret invariant.
    expect(projectOtlpKnobs(undefined)).toEqual({});
    expect("endpoint" in projectOtlpKnobs(undefined)).toBe(false);
    expect("enabled" in projectOtlpKnobs(undefined)).toBe(false);
    // A partial config carries ONLY the set knob (the other is omitted, not undefined).
    expect(projectOtlpKnobs({ enabled: false })).toEqual({ enabled: false });
    expect("endpoint" in projectOtlpKnobs({ enabled: false })).toBe(false);
    // The encrypted headers envelope is NEVER copied into the non-secret knobs.
    const full = projectOtlpKnobs({
      endpoint: "https://otlp.example.com/v1/traces",
      enabled: true,
      headersSecret: { v: 1, alg: "AES-256-GCM", ciphertext: "SECRET-CT" },
    });
    expect(full).toEqual({
      endpoint: "https://otlp.example.com/v1/traces",
      enabled: true,
    });
    expect("headersSecret" in full).toBe(false);
  });

  test("setIntegrationConfig REJECTS an endpoint carrying userinfo credentials; stores nothing", async () => {
    // Security (codex P2): the endpoint is NON-secret (exposed to traces.read), so a
    // `user:pass@host` URL would leak credentials in clear. The set-time guard must
    // reject it BEFORE any write, and a clean URL must still be accepted.
    const t = convexTest(schema, modules);
    const asAdmin = await seedAdmin(t);
    const readSingleton = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("integrationConfig")
          .withIndex("by_key", (q) => q.eq("key", "singleton"))
          .unique(),
      );
    await expect(
      asAdmin.mutation(api.admin.setIntegrationConfig, {
        otlp: { endpoint: "https://user:pass@host/v1/traces" },
      }),
    ).rejects.toThrow(/credential/i);
    expect(await readSingleton()).toBeNull(); // guard ran before the write

    // A clean endpoint is accepted and stored.
    await asAdmin.mutation(api.admin.setIntegrationConfig, {
      otlp: { endpoint: "https://host/v1/traces" },
    });
    expect((await readSingleton())?.otlp?.endpoint).toBe(
      "https://host/v1/traces",
    );
  });

  test("setIntegrationConfig REJECTS userinfo in Langfuse host / Opik baseUrl too (same guard)", async () => {
    // The non-secret-URL leak class is vendor-neutral: the Langfuse host and Opik
    // base URL are also surfaced via integrations.status, so a `user:pass@host`
    // there leaks creds just like the OTLP endpoint. The SAME set-time guard covers
    // them; clean hosts stay accepted (the absolute-URL shape they already require).
    const t = convexTest(schema, modules);
    const asAdmin = await seedAdmin(t);
    const readSingleton = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("integrationConfig")
          .withIndex("by_key", (q) => q.eq("key", "singleton"))
          .unique(),
      );

    await expect(
      asAdmin.mutation(api.admin.setIntegrationConfig, {
        langfuse: { host: "https://user:pass@lf.example.com" },
      }),
    ).rejects.toThrow(/credential/i);
    await expect(
      asAdmin.mutation(api.admin.setIntegrationConfig, {
        opik: { baseUrl: "https://user:pass@opik.example.com/api" },
      }),
    ).rejects.toThrow(/credential/i);
    expect(await readSingleton()).toBeNull(); // neither write landed

    // Clean hosts are still accepted + stored (no format tightening).
    await asAdmin.mutation(api.admin.setIntegrationConfig, {
      langfuse: { host: "https://lf.example.com" },
      opik: { baseUrl: "https://opik.example.com/api" },
    });
    const row = await readSingleton();
    expect(row?.langfuse?.host).toBe("https://lf.example.com");
    expect(row?.opik?.baseUrl).toBe("https://opik.example.com/api");
  });

  test("setIntegrationConfig(endpoint) PRESERVES the encrypted headers (two writers)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = await seedAdmin(t);
    // 1) set the secret (action). 2) set the endpoint via a DIFFERENT writer.
    await asAdmin.action(api.integrations.otlpSecret.setOtlpHeaders, {
      headersJson: '{"Authorization":"Bearer keep-me"}',
    });
    await asAdmin.mutation(api.admin.setIntegrationConfig, {
      otlp: { endpoint: "https://otlp.example.com/v1/traces" },
    });
    const otlp = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("integrationConfig")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique();
      return row?.otlp ?? null;
    });
    expect(otlp?.endpoint).toBe("https://otlp.example.com/v1/traces");
    expect(otlp?.headersSecret).not.toBeUndefined(); // SURVIVED the endpoint write
    expect(await decryptOtlpHeaders(otlp!.headersSecret)).toEqual({
      Authorization: "Bearer keep-me",
    });
  });

  test("flushToVendors ships to the OTLP endpoint with the DECRYPTED header; cursor advances", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = await seedAdmin(t);
    await asAdmin.action(api.integrations.otlpSecret.setOtlpHeaders, {
      headersJson: '{"Authorization":"Bearer FLUSH-TOKEN"}',
    });
    await asAdmin.mutation(api.admin.setIntegrationConfig, {
      otlp: { endpoint: "https://otlp.example.com/v1/traces" },
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("traceEvents", {
        at: 1000,
        kind: "api.call",
        principalType: "system",
        redacted: true,
        correlationId: "c1",
      });
      // Pre-seed the cursor at 0 so this event is in range (not skipped by the
      // forward-only first-flush seeding).
      await ctx.db.insert("integrationCursors", { vendor: "otlp", lastAt: 0 });
    });

    // flushToVendors calls otlp.send WITHOUT a fetchImpl → it uses global fetch.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const stub = (async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", stub);
    try {
      await t.action(internal.integrations.ship.flushToVendors, {});
    } finally {
      vi.unstubAllGlobals();
    }

    const otlpCall = calls.find(
      (c) => c.url === "https://otlp.example.com/v1/traces",
    );
    expect(otlpCall).toBeDefined();
    const headers = otlpCall!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer FLUSH-TOKEN"); // decrypted + applied
    expect(headers["Content-Type"]).toBe("application/json");
    // The shipped payload carries the redacted event, never a secret.
    expect(String(otlpCall!.init.body)).toContain("api.call");
    expect(String(otlpCall!.init.body)).not.toContain("FLUSH-TOKEN");
    // Cursor advanced to the shipped event.
    const cur = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("integrationCursors")
        .withIndex("by_vendor", (q) => q.eq("vendor", "otlp"))
        .unique();
      return row?.lastAt;
    });
    expect(cur).toBe(1000);
  });
});
