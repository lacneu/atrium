/// <reference types="vite/client" />
//
// SOC2 boundary INVARIANT (§2c): no httpAction / key-authed / MCP route reads the
// CONTENT-BEARING plane-1 table `subAgentReports`. The `reportId` shipped in the
// plane-2 anomaly evidence is an OPAQUE pointer — safe even if it leaks, BECAUSE
// nothing on the observability plane can dereference it to content.
//
// This guard reads the actual source of the key-authed HTTP surface (convex/http.ts)
// and the MCP package (mcp/src/*) and asserts the table name never appears there.
// If a future change wires a route to read the table, this test fails LOUDLY —
// turning the boundary from prose into a tripwire. (Sources are loaded via Vite's
// `?raw` glob so the test runs under the edge-runtime environment without `fs`.)

import { describe, expect, it } from "vitest";

const TABLE = "subAgentReports";

const httpSources = import.meta.glob("./http.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// `**` so the tripwire survives a future mcp/src subdirectory (flat today).
const mcpSources = import.meta.glob("../mcp/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("plane-2 boundary: the content table is never on the observability surface", () => {
  it("loaded the source files it guards (glob is wired)", () => {
    // A self-check: if the globs ever resolve to nothing, the assertions below
    // would vacuously pass. Pin that http.ts and the MCP tools are actually read.
    expect(Object.keys(httpSources).length).toBeGreaterThan(0);
    expect(Object.keys(mcpSources).length).toBeGreaterThan(0);
  });

  it("convex/http.ts (the key-authed API surface) never references subAgentReports", () => {
    for (const [file, src] of Object.entries(httpSources)) {
      expect(src, `${file} must not reference ${TABLE}`).not.toContain(TABLE);
    }
  });

  it("mcp/src/* (the MCP package) never references subAgentReports", () => {
    for (const [file, src] of Object.entries(mcpSources)) {
      expect(src, `${file} must not reference ${TABLE}`).not.toContain(TABLE);
    }
  });
});
