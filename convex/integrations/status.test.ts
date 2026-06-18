/// <reference types="vite/client" />
//
// The API/MCP-safe integration status projection (#5). It is what an AI agent
// reads over /api/v1/integrations to learn whether Opik/Langfuse are wired — so
// the load-bearing guarantee is SOC2: it exposes `configured`/`enabled` + the
// NON-SECRET endpoints + shipping cursors, and NEVER the key material.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "../schema";
import { loadIntegrationsStatusPublic } from "./status";

const modules = import.meta.glob("../**/*.ts");

const ENV = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "OPIK_API_KEY",
  "OPIK_KEY",
] as const;

describe("loadIntegrationsStatusPublic (API/MCP-safe integration status)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("no keys -> configured:false for both vendors; the shape an agent reads is intact", async () => {
    const t = convexTest(schema, modules);
    for (const k of ENV) delete process.env[k];
    const s = await t.run((ctx) => loadIntegrationsStatusPublic(ctx));
    expect(s.langfuse.configured).toBe(false);
    expect(s.opik.configured).toBe(false);
    expect(s.langfuse).toHaveProperty("host");
    expect(s.opik).toHaveProperty("baseUrl");
    expect(s.opik).toHaveProperty("workspace");
    expect(Array.isArray(s.cursors)).toBe(true);
  });

  test("both Langfuse keys present -> configured:true", async () => {
    const t = convexTest(schema, modules);
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-x";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-x";
    const s = await t.run((ctx) => loadIntegrationsStatusPublic(ctx));
    expect(s.langfuse.configured).toBe(true);
  });

  // SOC2 SENTINEL: even with secrets set, NONE of the key material may appear in
  // the projection an agent receives. If this ever fails, a key is leaking.
  test("the projection NEVER contains the secret key material (SOC2)", async () => {
    const t = convexTest(schema, modules);
    process.env.LANGFUSE_PUBLIC_KEY = "pk-SENTINEL-lf-public";
    process.env.LANGFUSE_SECRET_KEY = "sk-SENTINEL-lf-secret";
    process.env.OPIK_API_KEY = "SENTINEL-opik-key";
    const s = await t.run((ctx) => loadIntegrationsStatusPublic(ctx));
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain("SENTINEL-lf-public");
    expect(serialized).not.toContain("SENTINEL-lf-secret");
    expect(serialized).not.toContain("SENTINEL-opik-key");
  });
});
