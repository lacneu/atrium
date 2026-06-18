// Trace enrichment — the SOC2 contract is load-bearing: the structural projection
// must NEVER carry input/output/message text/metadata, and the derivation must
// match ship.ts so an Atrium-shipped trace is found deterministically.

import { describe, expect, test } from "vitest";
import {
  projectLangfuseObservation,
  projectOpikSpan,
  langfuseTraceIdFor,
  opikTraceIdFor,
  enrichTraceByCorrelation,
  type FetchImpl,
} from "./enrich";
import type { LangfuseConfig, OpikConfig } from "./config";

const PHI = "PHI-PATIENT-NAME-John-Doe-secret-prompt";

const LF: LangfuseConfig = {
  configured: true,
  enabled: true,
  host: "https://lf.invalid",
  publicKey: "pk",
  secretKey: "sk",
};
const OP_OFF: OpikConfig = {
  configured: false,
  enabled: true,
  baseUrl: "https://opik.invalid",
  apiKey: "",
  workspace: "",
  projectName: "Default Project",
  openclawProjectName: "",
};
const OP_ON: OpikConfig = {
  configured: true,
  enabled: true,
  baseUrl: "https://opik.invalid",
  apiKey: "ok",
  workspace: "ws",
  projectName: "Default Project",
  openclawProjectName: "openclaw-test",
};

describe("SOC2 projection (the load-bearing allowlist)", () => {
  test("a Langfuse observation drops input/output/metadata; keeps only structure", () => {
    const node = projectLangfuseObservation({
      id: "obs-1",
      name: "llm-call",
      type: "GENERATION",
      level: "DEFAULT",
      startTime: "2026-06-18T00:00:00.000Z",
      endTime: "2026-06-18T00:00:01.500Z",
      parentObservationId: "obs-0",
      input: PHI, // <- must NOT survive
      output: PHI,
      metadata: { patient: PHI },
      statusMessage: PHI,
    });
    expect(node).toEqual({
      id: "obs-1",
      name: "llm-call",
      type: "GENERATION",
      level: "DEFAULT",
      startMs: Date.parse("2026-06-18T00:00:00.000Z"),
      durationMs: 1500,
      parentId: "obs-0",
    });
    expect(JSON.stringify(node)).not.toContain(PHI);
  });

  test("an Opik span drops input/output; keeps only structure", () => {
    const node = projectOpikSpan({
      id: "span-1",
      name: "tool:search",
      type: "tool",
      start_time: "2026-06-18T00:00:00.000Z",
      end_time: "2026-06-18T00:00:00.200Z",
      parent_span_id: null,
      input: { q: PHI },
      output: { result: PHI },
      metadata: { note: PHI },
    });
    expect(node?.id).toBe("span-1");
    expect(node?.name).toBe("tool:search");
    expect(node?.durationMs).toBe(200);
    expect(JSON.stringify(node)).not.toContain(PHI);
  });

  test("malformed rows -> null (dropped), never a throw", () => {
    expect(projectLangfuseObservation(null)).toBeNull();
    expect(projectLangfuseObservation({ name: "x" })).toBeNull(); // no id
    expect(projectOpikSpan("nope")).toBeNull();
  });
});

describe("deterministic derivation (matches ship.ts seeds)", () => {
  test("langfuseTraceIdFor is deterministic + 32 hex chars", async () => {
    const a = await langfuseTraceIdFor("corr-1");
    const b = await langfuseTraceIdFor("corr-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await langfuseTraceIdFor("corr-2")).not.toBe(a);
  });
  test("opikTraceIdFor is a deterministic UUID", async () => {
    const a = await opikTraceIdFor("corr-1", 1_000_000);
    expect(a).toBe(await opikTraceIdFor("corr-1", 1_000_000));
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("enrichTraceByCorrelation orchestration", () => {
  test("not configured -> available:false, each vendor reason explains why", async () => {
    const enrichment = await enrichTraceByCorrelation({
      correlationId: "corr-1",
      atMs: 1,
      langfuse: { ...LF, configured: false },
      opik: OP_OFF,
      fetchImpl: (async () => {
        throw new Error("should not fetch when unconfigured");
      }) as unknown as FetchImpl,
    });
    expect(enrichment.available).toBe(false);
    const lf = enrichment.vendors.find((v) => v.vendor === "langfuse")!;
    expect(lf.ok).toBe(false);
    expect(lf.reason).toBe("unconfigured");
  });

  test("Langfuse: fetches the correlationId-derived trace + projects structure; the FULL output carries NO PHI", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/api/public/v2/observations")) {
        // The fetch MUST be keyed by the deterministic derived trace id (the SOC2
        // path), not a session list — pin that the url carries it.
        expect(url).toContain(
          `traceId=${encodeURIComponent(await langfuseTraceIdFor("corr-1"))}`,
        );
        // The raw vendor rows DO carry PHI — the projection must strip it.
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: "o1",
                name: "agent-turn",
                type: "SPAN",
                level: "DEFAULT",
                startTime: "2026-06-18T00:00:00.000Z",
                endTime: "2026-06-18T00:00:02.000Z",
                parentObservationId: null,
                input: PHI,
                output: PHI,
              },
              {
                id: "o2",
                name: "llm-call",
                type: "GENERATION",
                startTime: "2026-06-18T00:00:00.100Z",
                endTime: "2026-06-18T00:00:01.900Z",
                parentObservationId: "o1",
                output: PHI,
              },
            ],
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as FetchImpl;

    const enrichment = await enrichTraceByCorrelation({
      correlationId: "corr-1",
      atMs: 1,
      langfuse: LF,
      opik: OP_OFF,
      fetchImpl,
    });

    expect(enrichment.available).toBe(true);
    const lf = enrichment.vendors.find((v) => v.vendor === "langfuse")!;
    expect(lf.ok).toBe(true);
    expect(lf.traces.length).toBeGreaterThanOrEqual(1);
    const trace = lf.traces[0]!;
    expect(trace.spanCount).toBe(2);
    expect(trace.typeCounts).toMatchObject({ SPAN: 1, GENERATION: 1 });
    expect(trace.spans.map((s) => s.name)).toEqual(["agent-turn", "llm-call"]);
    // THE SOC2 SENTINEL: serialize the ENTIRE enrichment — no PHI anywhere.
    expect(JSON.stringify(enrichment)).not.toContain(PHI);
  });

  test("WITHOUT chatId: no session list-search — only the deterministic observations fetch", async () => {
    const hits: string[] = [];
    const fetchImpl = (async (url: string) => {
      hits.push(url);
      if (url.includes("/api/public/traces?")) {
        throw new Error("no chatId given -> must NOT list-search");
      }
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response;
    }) as unknown as FetchImpl;

    await enrichTraceByCorrelation({
      correlationId: "corr-1",
      // no chatId
      atMs: 1,
      langfuse: LF,
      opik: OP_OFF,
      fetchImpl,
    });

    expect(hits).toHaveLength(1); // exactly one call — the observations fetch
    expect(hits[0]).toContain("/api/public/v2/observations");
    expect(hits.some((u) => u.includes("/api/public/traces?"))).toBe(false);
  });

  test("WITH chatId: list-searches the session, but ALWAYS with `fields=core` (no io on the wire) + merges the session trace ids", async () => {
    const listUrls: string[] = [];
    const obsTraceIds: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (url.includes("/api/public/traces?")) {
        listUrls.push(url);
        // THE SOC2 SENTINEL: the session list MUST request fields=core (excludes the
        // io group = input/output/metadata). Without it, the list returns content.
        expect(url).toContain("fields=core");
        expect(url).toContain("sessionId=chat-9");
        // The raw list rows carry io — proving we project to `id` only (PHI dropped).
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "sess-trace-A", input: PHI, output: PHI, metadata: { p: PHI } },
              { id: "sess-trace-B", input: PHI },
            ],
          }),
        } as unknown as Response;
      }
      if (url.includes("/api/public/v2/observations")) {
        const m = /traceId=([^&]+)/.exec(url);
        if (m) obsTraceIds.push(decodeURIComponent(m[1]!));
        return {
          ok: true,
          json: async () => ({
            data: [{ id: `obs-for`, name: "span", type: "SPAN" }],
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as FetchImpl;

    const enrichment = await enrichTraceByCorrelation({
      correlationId: "corr-1",
      chatId: "chat-9",
      atMs: 1,
      langfuse: LF,
      opik: OP_OFF,
      fetchImpl,
    });

    expect(listUrls).toHaveLength(1); // the session list WAS consulted
    // Observations fetched for the deterministic id AND both session-derived ids.
    expect(obsTraceIds).toContain(await langfuseTraceIdFor("corr-1"));
    expect(obsTraceIds).toContain("sess-trace-A");
    expect(obsTraceIds).toContain("sess-trace-B");
    // No PHI survived the id-only projection of the list rows.
    expect(JSON.stringify(enrichment)).not.toContain(PHI);
  });

  test("a vendor HTTP error degrades gracefully (reason http_<n>, no throw)", async () => {
    const fetchImpl = (async () => {
      return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
    }) as unknown as FetchImpl;
    const enrichment = await enrichTraceByCorrelation({
      correlationId: "corr-1",
      atMs: 1,
      langfuse: LF,
      opik: OP_OFF,
      fetchImpl,
    });
    const lf = enrichment.vendors.find((v) => v.vendor === "langfuse")!;
    expect(lf.traces).toEqual([]);
    expect(lf.reason).toBe("http_503");
  });

  test("Opik WITHOUT `at` -> needs_timestamp (never a fabricated `now` that silently misses)", async () => {
    // The Opik UUIDv7 bakes the ORIGINAL ship-time `at`; deriving from `now` would
    // produce a wrong id that returns zero spans = a false "no trace". Refuse instead.
    // Discriminating: it MUST NOT fetch (a fabricated id would hit the spans endpoint).
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return { ok: true, json: async () => ({ content: [] }) } as unknown as Response;
    }) as unknown as FetchImpl;
    const enrichment = await enrichTraceByCorrelation({
      correlationId: "corr-1",
      // atMs deliberately omitted
      langfuse: { ...LF, configured: false },
      opik: OP_ON,
      fetchImpl,
    });
    const op = enrichment.vendors.find((v) => v.vendor === "opik")!;
    expect(op.ok).toBe(false);
    expect(op.reason).toBe("needs_timestamp");
    expect(fetched).toBe(false);
  });

  test("Opik WITH `at` -> fetches the correlationId+at-derived trace id", async () => {
    const expectedId = await opikTraceIdFor("corr-1", 1_700_000_000_000);
    let sawId: string | null = null;
    const fetchImpl = (async (url: string) => {
      sawId = url;
      return { ok: true, json: async () => ({ content: [] }) } as unknown as Response;
    }) as unknown as FetchImpl;
    await enrichTraceByCorrelation({
      correlationId: "corr-1",
      atMs: 1_700_000_000_000,
      langfuse: { ...LF, configured: false },
      opik: OP_ON,
      fetchImpl,
    });
    expect(sawId).toContain(`trace_id=${encodeURIComponent(expectedId)}`);
    // The Opik read API REQUIRES project_name (400s without it — caught live).
    expect(sawId).toContain(
      `project_name=${encodeURIComponent("Default Project")}`,
    );
    // SOC2 layer-1: input/output/metadata excluded AT THE VENDOR.
    expect(sawId).toContain(
      `exclude=${encodeURIComponent(JSON.stringify(["input", "output", "metadata"]))}`,
    );
  });

  test("Opik thread-search: finds OpenClaw's OWN traces by thread_id in the SEPARATE project + reads spans there (SOC2 exclude), NO PHI", async () => {
    const threadId = "agent:olivier:webchat:chat:olivier:m97abc";
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes("/v1/private/traces?")) {
        // The thread-search MUST hit the OpenClaw project, filter by thread_id, and
        // exclude io (SOC2). The list rows carry PHI — we must project to id only.
        expect(url).toContain(`project_name=${encodeURIComponent("openclaw-test")}`);
        expect(url).toContain(encodeURIComponent("thread_id"));
        expect(url).toContain(encodeURIComponent(threadId));
        expect(url).toContain(
          `exclude=${encodeURIComponent(JSON.stringify(["input", "output", "metadata"]))}`,
        );
        return {
          ok: true,
          json: async () => ({
            content: [{ id: "oc-trace-1", input: PHI, output: PHI, name: PHI }],
          }),
        } as unknown as Response;
      }
      if (url.includes("/v1/private/spans")) {
        // Spans for the OpenClaw trace must be read from the OpenClaw project.
        expect(url).toContain(`project_name=${encodeURIComponent("openclaw-test")}`);
        expect(url).toContain("trace_id=oc-trace-1");
        return {
          ok: true,
          json: async () => ({
            content: [
              {
                id: "sp-1",
                name: "openclawmessage",
                type: "tool",
                start_time: "2026-06-18T00:00:00.000Z",
                end_time: "2026-06-18T00:00:01.000Z",
                parent_span_id: null,
                input: PHI,
                output: PHI,
              },
            ],
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as FetchImpl;

    const enrichment = await enrichTraceByCorrelation({
      correlationId: "corr-1",
      openclawThreadId: threadId,
      // no atMs -> the Atrium-own leg is skipped; the thread-search still runs.
      langfuse: { ...LF, configured: false },
      opik: OP_ON,
      fetchImpl,
    });

    const op = enrichment.vendors.find((v) => v.vendor === "opik")!;
    expect(op.ok).toBe(true);
    expect(op.traces).toHaveLength(1);
    expect(op.traces[0]!.spans.map((s) => s.name)).toEqual(["openclawmessage"]);
    expect(op.traces[0]!.spans[0]!.type).toBe("tool");
    expect(JSON.stringify(enrichment)).not.toContain(PHI); // id-only list + projected spans
  });

  test("Opik thread-search is SKIPPED when no OpenClaw project is configured", async () => {
    let hitTraces = false;
    const fetchImpl = (async (url: string) => {
      if (url.includes("/v1/private/traces?")) hitTraces = true;
      return { ok: true, json: async () => ({ content: [] }) } as unknown as Response;
    }) as unknown as FetchImpl;
    await enrichTraceByCorrelation({
      correlationId: "corr-1",
      openclawThreadId: "agent:x:webchat:chat:y:z",
      atMs: 1,
      langfuse: { ...LF, configured: false },
      opik: { ...OP_ON, openclawProjectName: "" }, // not configured
      fetchImpl,
    });
    expect(hitTraces).toBe(false); // no thread-search without an OpenClaw project
  });
});
