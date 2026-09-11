/// <reference types="vite/client" />
//
// POST /api/v1/deliver-media — the API boundary of the lost-delivery repair.
//
// Driven through the REAL route, which is the only thing that proves the key
// actually authenticates and the gate actually gates. Three properties live
// here and nowhere else:
//
//   - the permission. `selfheal` is NOT enough: the `agent` service role holds
//     it, and this operation adds content to a settled conversation from a
//     directory several conversations share.
//   - EVERY authenticated call is audited, the malformed ones included. Returning
//     early on a bad body used to skip both the trace and its durable row, so a
//     key probing this route left no trail at all.
//   - a bad request is REFUSED WHOLE, never repaired. Filtering a bad entry out
//     answered 200 while silently doing nothing for it, and letting a path
//     through meant the bridge's own 400 came back as a 502 — a caller's mistake
//     filed as a server fault.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { hashKey } from "./lib/apikeys";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ADMIN_KEY = "oc_test_admin_key";
const AGENT_KEY = "oc_test_agent_key";

async function seed(t: TestConvex<typeof schema>) {
  const adminHash = await hashKey(ADMIN_KEY);
  const agentHash = await hashKey(AGENT_KEY);
  return await t.run(async (ctx) => {
    const human = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: human, role: "admin" });
    const mk = async (roleKey: string, hashedKey: string) => {
      const serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: `svc-${roleKey}`,
        roleKey,
        disabled: false,
        createdByUserId: human,
      });
      await ctx.db.insert("apiKeys", {
        serviceAccountId,
        hashedKey,
        prefix: `oc_test_${roleKey}`,
        lastFour: "key1",
        disabled: false,
        createdAt: Date.now(),
      });
    };
    // A CUSTOM role holding the dedicated permission — the supported way an
    // operator reaches this route, since a service account may never be `admin`.
    await ctx.db.insert("roles", {
      key: "repairer",
      name: "Repairer",
      builtin: false,
      permissions: ["media.repair"],
    });
    await mk("repairer", adminHash);
    await mk("agent", agentHash);
    const chatId = await ctx.db.insert("chats", {
      userId: human,
      updatedAt: 1,
      instanceName: "ataraxis",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId: human,
      role: "assistant",
      status: "complete",
      text: "",
      updatedAt: 2,
    });
    return { chatId, messageId };
  });
}

const call = (
  t: TestConvex<typeof schema>,
  key: string,
  body: Record<string, unknown>,
) =>
  t.fetch("/api/v1/deliver-media", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const auditRows = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) => ctx.db.query("accessLog").collect());

describe("POST /api/v1/deliver-media", () => {
  test("an AGENT key is refused: selfheal is not this permission", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    const res = await call(t, AGENT_KEY, {
      chatId,
      messageId,
      filenames: ["v.pdf"],
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("media.repair");
  });

  test("a malformed body is REFUSED and still audited", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);

    // Not an array.
    expect((await call(t, ADMIN_KEY, { chatId, messageId, filenames: "v.pdf" })).status).toBe(400);
    // A non-string entry is not silently dropped.
    expect(
      (await call(t, ADMIN_KEY, { chatId, messageId, filenames: ["v.pdf", 42] })).status,
    ).toBe(400);
    // A path never reaches the bridge (whose 400 would surface as a 502).
    expect(
      (await call(t, ADMIN_KEY, { chatId, messageId, filenames: ["../etc/passwd"] })).status,
    ).toBe(400);
    // Over the batch cap.
    expect(
      (
        await call(t, ADMIN_KEY, {
          chatId,
          messageId,
          filenames: Array.from({ length: 17 }, (_, i) => `f${i}.pdf`),
        })
      ).status,
    ).toBe(400);
    // Target not fully named.
    expect((await call(t, ADMIN_KEY, { chatId, filenames: ["v.pdf"] })).status).toBe(400);
    // A REPEATED name. The bridge would answer about it twice, the response's
    // partition check would reject that for non-uniqueness, and the API would
    // return 502 — a server fault — AFTER the file had actually been attached.
    expect(
      (await call(t, ADMIN_KEY, { chatId, messageId, filenames: ["a.pdf", "a.pdf"] })).status,
    ).toBe(400);

    // EVERY one of them left a durable row: six calls, six audited.
    const rows = await auditRows(t);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.route).toBe("/api/v1/deliver-media");
      expect(row.status).toBe(400);
    }
  });

  test("a JSON body that is not an object is a 400, not a 500", async () => {
    // `JSON.parse("null")` succeeds and a cast does not change the value: the
    // next property read threw, and the malformed call escaped the audited 400
    // this route promises for every authenticated request.
    const t = convexTest(schema, modules);
    await seed(t);
    for (const raw of ["null", '"a string"', "[1,2]", "42"]) {
      const res = await t.fetch("/api/v1/deliver-media", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          "Content-Type": "application/json",
        },
        body: raw,
      });
      expect(res.status, `body ${raw}`).toBe(400);
    }
    const rows = await auditRows(t);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.status).toBe(400);
  });

  test("a WILDCARD custom role grants a service account NOTHING", async () => {
    // The lot's whole permission argument is that `media.repair` reaches no
    // service account. `HUMAN_ONLY_ROLE_KEYS` blocks the `admin` roleKey — but it
    // checks the KEY, and an admin could create a CUSTOM role holding "*" and
    // assign it, handing that API key every permission present and future. The
    // wildcard belongs to the built-in admin role, which is human-only.
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    const WILDCARD_KEY = "oc_test_wildcard_key";
    await t.run(async (ctx) => {
      const human = (await ctx.db.query("users").first())!._id;
      // Stored DIRECTLY: a row written before the write path refused it.
      await ctx.db.insert("roles", {
        key: "sneaky",
        name: "Sneaky",
        builtin: false,
        permissions: ["*"],
      });
      const serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: "svc-sneaky",
        roleKey: "sneaky",
        disabled: false,
        createdByUserId: human,
      });
      await ctx.db.insert("apiKeys", {
        serviceAccountId,
        hashedKey: await hashKey(WILDCARD_KEY),
        prefix: "oc_test_sneaky",
        lastFour: "key1",
        disabled: false,
        createdAt: Date.now(),
      });
    });
    const res = await call(t, WILDCARD_KEY, {
      chatId,
      messageId,
      filenames: ["v.pdf"],
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("media.repair");
  });

  test("the 403 is audited too", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await call(t, AGENT_KEY, { chatId, messageId, filenames: ["v.pdf"] });
    const rows = await auditRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: "/api/v1/deliver-media",
      status: 403,
    });
  });
});
