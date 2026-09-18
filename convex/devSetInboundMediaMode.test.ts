/// <reference types="vite/client" />
//
// The bench pins the inbound transport for one scenario and restores it afterwards,
// from whatever this mutation reported as `previous` — literally, except that a
// reported `null` becomes `"inline"`, the default the deployment was already
// behaving as (the field then exists where it did not before).
//
// Nothing locked that contract. Returning `{ ok: true }` alone left every
// deterministic test — in both repositories — green: the runner reads
// `set.previous`, gets `undefined`, and skips the restore entirely, so the catalogue
// can still be GO while the deployment stays on `shared-fs` and poisons every run
// after it (codex). The consumer's guard lives in the bench; this is the producer's
// half of the same contract.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

let prevAnon: string | undefined;
let prevInstances: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  prevInstances = process.env.DEV_LIVE_INSTANCES;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1"; // unlock dev.* helpers
  process.env.DEV_LIVE_INSTANCES = "bench";
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
  if (prevInstances === undefined) delete process.env.DEV_LIVE_INSTANCES;
  else process.env.DEV_LIVE_INSTANCES = prevInstances;
});

const seedInstance = (t: ReturnType<typeof convexTest>, config?: unknown) =>
  t.run((ctx) =>
    ctx.db.insert("instances", {
      name: "bench",
      gatewayUrl: "ws://127.0.0.1:1",
      ...(config === undefined ? {} : { config: config as never }),
    }),
  );

const configOf = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => {
    // `t.run`'s ctx is not schema-typed, so the named index is out of reach here — a
    // full scan over a one-row table in a test says the same thing.
    const all = await ctx.db.query("instances").collect();
    return all.find((i) => i.name === "bench")?.config ?? null;
  });

const modeOf = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => {
    const all = await ctx.db.query("instances").collect();
    return all.find((i) => i.name === "bench")?.config?.inboundMediaMode ?? null;
  });

describe("dev.testSetInboundMediaMode — the value the bench puts back", () => {
  test("reports the PREVIOUS mode and applies the new one", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t, { inboundMediaMode: "inline" });

    const res = await t.mutation(api.dev.testSetInboundMediaMode, {
      instanceName: "bench",
      mode: "shared-fs",
    });

    expect(res.ok).toBe(true);
    expect(
      res.ok === true ? res.previous : undefined,
      "the previous mode was not reported, so the bench has nothing to restore",
    ).toBe("inline");
    expect(await modeOf(t)).toBe("shared-fs");
  });

  test("reports null when the field was UNSET — the case the restore turns into \"inline\"", async () => {
    const t = convexTest(schema, modules);
    await seedInstance(t);

    const res = await t.mutation(api.dev.testSetInboundMediaMode, {
      instanceName: "bench",
      mode: "shared-fs",
    });

    // null, not undefined: the runner restores only when `previous !== undefined`,
    // so an absent field must still be a reported value.
    expect(res.ok === true ? res.previous : "missing").toBe(null);
    expect(await modeOf(t)).toBe("shared-fs");
  });

  test("reports shared-fs when that is what was there — not a constant", async () => {
    // A producer answering `null` when absent and `"inline"` otherwise passed the two
    // cases above (codex), and would have turned a deployment that was ALREADY
    // shared-fs into inline at the first restore.
    const t = convexTest(schema, modules);
    await seedInstance(t, { inboundMediaMode: "shared-fs" });

    const res = await t.mutation(api.dev.testSetInboundMediaMode, {
      instanceName: "bench",
      mode: "inline",
    });

    expect(res.ok === true ? res.previous : "missing").toBe("shared-fs");
    expect(await modeOf(t)).toBe("inline");
  });

  test("a round trip leaves the deployment exactly as it was — the WHOLE config", async () => {
    // Not just the one field: the patch rebuilds `config`, and dropping the spread
    // would erase every other setting on the first pin, with nothing to restore them
    // from (codex).
    const t = convexTest(schema, modules);
    await seedInstance(t, {
      inboundMediaMode: "inline",
      inboundAgentMount: "/home/node/.openclaw/media/inbound/published",
      outboundAgentMount: "/home/node/.openclaw/media/outbound",
    });

    const set = await t.mutation(api.dev.testSetInboundMediaMode, {
      instanceName: "bench",
      mode: "shared-fs",
    });
    // The neighbours must survive the PIN, not merely the round trip: the scenario
    // runs between the two calls, and it runs against them.
    const pinned = await configOf(t);
    expect(pinned?.inboundAgentMount).toBe("/home/node/.openclaw/media/inbound/published");
    expect(pinned?.outboundAgentMount).toBe("/home/node/.openclaw/media/outbound");

    await t.mutation(api.dev.testSetInboundMediaMode, {
      instanceName: "bench",
      mode: (set.ok === true ? set.previous : null) ?? "inline",
    });

    const after = await configOf(t);
    expect(after?.inboundMediaMode).toBe("inline");
    expect(after?.inboundAgentMount).toBe("/home/node/.openclaw/media/inbound/published");
    expect(after?.outboundAgentMount).toBe("/home/node/.openclaw/media/outbound");
  });

  test("refuses an instance outside the dev allowlist", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "ataraxis", gatewayUrl: "ws://127.0.0.1:1" }),
    );
    await expect(
      t.mutation(api.dev.testSetInboundMediaMode, {
        instanceName: "ataraxis",
        mode: "shared-fs",
      }),
    ).rejects.toThrow();
  });
});
