import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  getKpi,
  getKpiInput,
  getSchema,
  getSchemaInput,
  listAnomalies,
  listAnomaliesInput,
  listSchemas,
  listTraces,
  listTracesInput,
  queryOpenClaw,
  queryOpenClawInput,
  reportAnomaly,
  reportAnomalyInput,
  startDeliveryRecord,
  stopDeliveryRecord,
  getDeliveryReport,
  getDeliveryReportInput,
  listDeliverySessions,
  deleteDeliverySessions,
  deleteDeliverySessionsInput,
} from "../src/tools.js";
import { type Config } from "../src/config.js";

const CONFIG: Config = {
  base: "http://127.0.0.1:3213",
  apiKey: "oc_live_TESTKEY1234",
};

/** Fake `fetch` that records inputs and returns a canned JSON 200. */
function fakeFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Parse the JSON body of a recorded request. */
function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("schema registry tools wire format", () => {
  it("list_schemas GETs /schemas", async () => {
    const { impl, calls } = fakeFetch();
    await listSchemas(CONFIG, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3213/api/v1/schemas");
    expect(calls[0]!.init?.method).not.toBe("POST");
  });

  it("get_schema GETs /schemas/:id (url-encoded id)", async () => {
    const { impl, calls } = fakeFetch();
    await getSchema(CONFIG, { id: "provenance.v1" }, { fetchImpl: impl });
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3213/api/v1/schemas/provenance.v1",
    );
  });

  it("get_schema input requires a non-empty id", () => {
    const schema = z.object(getSchemaInput);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ id: "provenance.v1" }).success).toBe(true);
  });
});

describe("queryOpenClaw wire format (H1)", () => {
  it("POSTs { question, payload } — never prompt/chatId/runId/params", async () => {
    const { impl, calls } = fakeFetch();
    await queryOpenClaw(
      CONFIG,
      { question: "why is latency high?", payload: { window: "1h" } },
      { fetchImpl: impl },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3213/api/v1/openclaw/query");
    expect(calls[0]!.init!.method).toBe("POST");

    const body = bodyOf(calls[0]!.init);
    expect(body).toEqual({
      question: "why is latency high?",
      payload: { window: "1h" },
    });
    expect(body).not.toHaveProperty("prompt");
    expect(body).not.toHaveProperty("chatId");
    expect(body).not.toHaveProperty("runId");
    expect(body).not.toHaveProperty("params");
  });
});

describe("reportAnomaly wire format (M6)", () => {
  it("POSTs `evidence` (not `details`)", async () => {
    const { impl, calls } = fakeFetch();
    await reportAnomaly(
      CONFIG,
      {
        kind: "api.error_ratio",
        severity: "critical",
        message: "error ratio exceeded threshold",
        evidence: { ratio: 0.42 },
      },
      { fetchImpl: impl },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3213/api/v1/anomalies");
    expect(calls[0]!.init!.method).toBe("POST");

    const body = bodyOf(calls[0]!.init);
    expect(body.evidence).toEqual({ ratio: 0.42 });
    expect(body).not.toHaveProperty("details");
    expect(body.severity).toBe("critical");
    expect(body.message).toBe("error ratio exceeded threshold");
  });

  it("POSTs `attachments` verbatim (agent-authored proposal documents)", async () => {
    const { impl, calls } = fakeFetch();
    await reportAnomaly(
      CONFIG,
      {
        kind: "improvement_proposal",
        severity: "info",
        message: "proposal: fix X",
        attachments: [{ name: "2026-07-10-fix-x.md", content: "# Fix X\n..." }],
      },
      { fetchImpl: impl },
    );

    const body = bodyOf(calls[0]!.init);
    expect(body.attachments).toEqual([
      { name: "2026-07-10-fix-x.md", content: "# Fix X\n..." },
    ]);
  });
});

describe("reportAnomaly input schema (M6)", () => {
  const schema = z.object(reportAnomalyInput);

  it("requires severity in {info,warn,critical} — rejects 'error'", () => {
    const r = schema.safeParse({
      kind: "k",
      severity: "error",
      message: "m",
    });
    expect(r.success).toBe(false);
  });

  it("requires message (rejects when missing)", () => {
    const r = schema.safeParse({ kind: "k", severity: "warn" });
    expect(r.success).toBe(false);
  });

  it("requires severity (rejects when missing)", () => {
    const r = schema.safeParse({ kind: "k", message: "m" });
    expect(r.success).toBe(false);
  });

  it("accepts a valid info|warn|critical anomaly with evidence", () => {
    for (const severity of ["info", "warn", "critical"] as const) {
      const r = schema.safeParse({
        kind: "k",
        severity,
        message: "m",
        evidence: { x: 1 },
      });
      expect(r.success).toBe(true);
    }
  });

  it("exposes `evidence`, not `details`", () => {
    expect(reportAnomalyInput).toHaveProperty("evidence");
    expect(reportAnomalyInput).not.toHaveProperty("details");
  });

  it("accepts valid attachments and rejects out-of-bounds ones", () => {
    const ok = schema.safeParse({
      kind: "k",
      severity: "info",
      message: "m",
      attachments: [{ name: "p.md", content: "text" }],
    });
    expect(ok.success).toBe(true);

    // 5 items > max 4
    const tooMany = schema.safeParse({
      kind: "k",
      severity: "info",
      message: "m",
      attachments: Array.from({ length: 5 }, (_, i) => ({
        name: `p${i}.md`,
        content: "x",
      })),
    });
    expect(tooMany.success).toBe(false);

    // content over 48k chars
    const tooBig = schema.safeParse({
      kind: "k",
      severity: "info",
      message: "m",
      attachments: [{ name: "p.md", content: "x".repeat(48_001) }],
    });
    expect(tooBig.success).toBe(false);

    // empty name
    const emptyName = schema.safeParse({
      kind: "k",
      severity: "info",
      message: "m",
      attachments: [{ name: "", content: "x" }],
    });
    expect(emptyName.success).toBe(false);
  });
});

describe("queryOpenClaw input schema (H1)", () => {
  const schema = z.object(queryOpenClawInput);

  it("exposes question + payload only (no prompt/chatId/runId/params)", () => {
    expect(queryOpenClawInput).toHaveProperty("question");
    expect(queryOpenClawInput).toHaveProperty("payload");
    expect(queryOpenClawInput).not.toHaveProperty("prompt");
    expect(queryOpenClawInput).not.toHaveProperty("chatId");
    expect(queryOpenClawInput).not.toHaveProperty("runId");
    expect(queryOpenClawInput).not.toHaveProperty("params");
  });

  it("accepts both fields optional", () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ question: "q" }).success).toBe(true);
    expect(schema.safeParse({ payload: { a: 1 } }).success).toBe(true);
  });
});

describe("listTraces correlationId filter (M7)", () => {
  it("sends ?correlationId=", async () => {
    const { impl, calls } = fakeFetch();
    await listTraces(
      CONFIG,
      { correlationId: "chat123:run456", limit: 20 },
      { fetchImpl: impl },
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("correlationId")).toBe("chat123:run456");
    expect(url.searchParams.get("limit")).toBe("20");
  });
});

describe("listAnomalies since filter (L8)", () => {
  it("sends ?since=", async () => {
    const { impl, calls } = fakeFetch();
    await listAnomalies(
      CONFIG,
      { since: "2026-06-01T00:00:00Z", status: "open" },
      { fetchImpl: impl },
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("since")).toBe("2026-06-01T00:00:00Z");
    expect(url.searchParams.get("status")).toBe("open");
  });
});

describe("listTraces filter params serialize into the query string", () => {
  it("sends from/to/statusClass/q exactly as named (relative tokens pass through)", async () => {
    const { impl, calls } = fakeFetch();
    await listTraces(
      CONFIG,
      { from: "now-24h", statusClass: "4xx", q: "x" },
      { fetchImpl: impl },
    );
    // Raw URL check: the spec wants ?from=now-24h&statusClass=4xx&q=x.
    const raw = calls[0]!.url;
    expect(raw).toContain("?");
    const url = new URL(raw);
    expect(url.searchParams.get("from")).toBe("now-24h");
    expect(url.searchParams.get("statusClass")).toBe("4xx");
    expect(url.searchParams.get("q")).toBe("x");
  });

  it("serializes every supported param under its spec name", async () => {
    const { impl, calls } = fakeFetch();
    await listTraces(
      CONFIG,
      {
        limit: 50,
        q: "boom",
        from: "now-7d",
        to: "now",
        kind: "api.call",
        status: 404,
        statusClass: "4xx",
        direction: "inbound",
        principalType: "service",
        roleKey: "admin",
        correlationId: "chat1:run2",
      },
      { fetchImpl: impl },
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("q")).toBe("boom");
    expect(url.searchParams.get("from")).toBe("now-7d");
    expect(url.searchParams.get("to")).toBe("now");
    expect(url.searchParams.get("kind")).toBe("api.call");
    expect(url.searchParams.get("status")).toBe("404");
    expect(url.searchParams.get("statusClass")).toBe("4xx");
    expect(url.searchParams.get("direction")).toBe("inbound");
    expect(url.searchParams.get("principalType")).toBe("service");
    expect(url.searchParams.get("roleKey")).toBe("admin");
    expect(url.searchParams.get("correlationId")).toBe("chat1:run2");
  });

  it("omits params that were not provided", async () => {
    const { impl, calls } = fakeFetch();
    await listTraces(CONFIG, { q: "only" }, { fetchImpl: impl });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("q")).toBe("only");
    for (const absent of [
      "limit",
      "from",
      "to",
      "kind",
      "status",
      "statusClass",
      "direction",
      "principalType",
      "roleKey",
      "correlationId",
    ]) {
      expect(url.searchParams.has(absent)).toBe(false);
    }
  });

  it("produces no query string when no args are given", async () => {
    const { impl, calls } = fakeFetch();
    await listTraces(CONFIG, {}, { fetchImpl: impl });
    expect(calls[0]!.url).toBe("http://127.0.0.1:3213/api/v1/traces");
    expect(calls[0]!.url).not.toContain("?");
  });
});

describe("listAnomalies new filter params serialize correctly", () => {
  it("sends q/from/to/severity/source/kind under their spec names", async () => {
    const { impl, calls } = fakeFetch();
    await listAnomalies(
      CONFIG,
      {
        q: "spike",
        from: "now-1h",
        to: "now",
        status: "open",
        severity: "critical",
        source: "detector",
        kind: "api.error_ratio",
      },
      { fetchImpl: impl },
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("q")).toBe("spike");
    expect(url.searchParams.get("from")).toBe("now-1h");
    expect(url.searchParams.get("to")).toBe("now");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("severity")).toBe("critical");
    expect(url.searchParams.get("source")).toBe("detector");
    expect(url.searchParams.get("kind")).toBe("api.error_ratio");
  });

  it("omits unspecified params", async () => {
    const { impl, calls } = fakeFetch();
    await listAnomalies(CONFIG, { severity: "warn" }, { fetchImpl: impl });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("severity")).toBe("warn");
    for (const absent of ["q", "from", "to", "status", "source", "kind", "since", "limit"]) {
      expect(url.searchParams.has(absent)).toBe(false);
    }
  });
});

describe("getKpi from/to filter params serialize correctly", () => {
  it("sends metric/since/from/to under their spec names", async () => {
    const { impl, calls } = fakeFetch();
    await getKpi(
      CONFIG,
      { metric: "latency", since: "2026-06-01T00:00:00Z", from: "now-24h", to: "now" },
      { fetchImpl: impl },
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("metric")).toBe("latency");
    expect(url.searchParams.get("since")).toBe("2026-06-01T00:00:00Z");
    expect(url.searchParams.get("from")).toBe("now-24h");
    expect(url.searchParams.get("to")).toBe("now");
    // KPI exposes no `q` filter.
    expect(url.searchParams.has("q")).toBe(false);
  });

  it("omits unspecified params", async () => {
    const { impl, calls } = fakeFetch();
    await getKpi(CONFIG, { from: "now-6h" }, { fetchImpl: impl });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("from")).toBe("now-6h");
    for (const absent of ["metric", "since", "to", "q"]) {
      expect(url.searchParams.has(absent)).toBe(false);
    }
  });
});

describe("centralized input schemas (shared by server/cli/tests)", () => {
  it("listTracesInput accepts the new params with correct types", () => {
    const schema = z.object(listTracesInput);
    expect(
      schema.safeParse({
        from: "now-24h",
        to: "now",
        statusClass: "4xx",
        status: 404,
        q: "x",
        direction: "inbound",
        principalType: "service",
        roleKey: "admin",
      }).success,
    ).toBe(true);
  });

  it("listTracesInput rejects an invalid statusClass and non-int status", () => {
    const schema = z.object(listTracesInput);
    expect(schema.safeParse({ statusClass: "3xx" }).success).toBe(false);
    expect(schema.safeParse({ status: 4.5 }).success).toBe(false);
  });

  it("getKpiInput exposes from/to and no q", () => {
    expect(getKpiInput).toHaveProperty("from");
    expect(getKpiInput).toHaveProperty("to");
    expect(getKpiInput).not.toHaveProperty("q");
  });

  it("listAnomaliesInput exposes q/from/to/severity/source/kind", () => {
    for (const key of ["q", "from", "to", "severity", "source", "kind"]) {
      expect(listAnomaliesInput).toHaveProperty(key);
    }
  });
});

describe("delivery recorder tools wire format (Phase 4)", () => {
  it("start_delivery_record POSTs /delivery-record/start", async () => {
    const { impl, calls } = fakeFetch();
    await startDeliveryRecord(CONFIG, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3213/api/v1/delivery-record/start",
    );
    expect(calls[0]!.init!.method).toBe("POST");
  });

  it("stop_delivery_record POSTs /delivery-record/stop", async () => {
    const { impl, calls } = fakeFetch();
    await stopDeliveryRecord(CONFIG, { fetchImpl: impl });
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3213/api/v1/delivery-record/stop",
    );
    expect(calls[0]!.init!.method).toBe("POST");
  });

  it("get_delivery_report GETs /delivery-report with the sessionId query", async () => {
    const { impl, calls } = fakeFetch();
    await getDeliveryReport(CONFIG, { sessionId: "sess1" }, { fetchImpl: impl });
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3213/api/v1/delivery-report?sessionId=sess1",
    );
    expect(calls[0]!.init?.method).not.toBe("POST");
  });

  it("get_delivery_report omits sessionId when not provided", async () => {
    const { impl, calls } = fakeFetch();
    await getDeliveryReport(CONFIG, {}, { fetchImpl: impl });
    expect(calls[0]!.url).toBe("http://127.0.0.1:3213/api/v1/delivery-report");
  });

  it("get_delivery_report input accepts an optional sessionId", () => {
    const schema = z.object(getDeliveryReportInput);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ sessionId: "x" }).success).toBe(true);
  });
});

describe("delivery sessions list/delete wire format (Phase 5)", () => {
  it("list_delivery_sessions GETs /delivery-sessions", async () => {
    const { impl, calls } = fakeFetch();
    await listDeliverySessions(CONFIG, { fetchImpl: impl });
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3213/api/v1/delivery-sessions",
    );
    expect(calls[0]!.init?.method).not.toBe("POST");
  });

  it("delete_delivery_sessions POSTs /delivery-record/delete with sessionIds", async () => {
    const { impl, calls } = fakeFetch();
    await deleteDeliverySessions(
      CONFIG,
      { sessionIds: ["s1", "s2"] },
      { fetchImpl: impl },
    );
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3213/api/v1/delivery-record/delete",
    );
    expect(calls[0]!.init!.method).toBe("POST");
    expect(bodyOf(calls[0]!.init)).toEqual({ sessionIds: ["s1", "s2"] });
  });

  it("delete_delivery_sessions input requires a non-empty sessionIds array", () => {
    const schema = z.object(deleteDeliverySessionsInput);
    expect(schema.safeParse({ sessionIds: [] }).success).toBe(false);
    expect(schema.safeParse({ sessionIds: ["s1"] }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });
});
