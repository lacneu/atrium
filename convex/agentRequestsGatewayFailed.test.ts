// AN APPROVAL THE GATEWAY DID NOT HONOUR — the Convex half.
//
// Production sequence (OpenClaw 2026.9.36 and 2026.10.33, upstream openclaw/openclaw#170994):
// the bridge records the exec approval (`upsertFromBridge`), someone allows it and the
// gateway's resolution settles the card `allowed` (`settleFromBridge`), then the run's own
// `approval` / `resolved` / `failed` says the request failed and the command did not run —
// the bridge joins it to the card and calls `markGatewayFailedFromBridge`. The two last
// writes may reach Convex in either order.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { outcomeOf, type AgentRequestView } from "../src/chat/agentRequestsView";

const modules = import.meta.glob("./**/*.ts");
const INSTANCE = "prod";
type T = ReturnType<typeof convexTest>;

async function seed(t: T) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user", canonical: "alice" });
    await ctx.db.insert("instances", { name: INSTANCE, gatewayUrl: "ws://gateway", kind: "openclaw" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0, instanceName: INSTANCE, agentId: "alice" });
    return { userId, chatId };
  });
}

const COMMAND = "echo SECRET_COMMAND_TEXT";
const EXEC = {
  source: "openclaw.exec" as const,
  providerRequestId: "daebea08-9639-4053-a8eb-b68ac2c22c61",
  providerCreatedAt: 1795567231887,
  approvalKind: "exec" as const,
  sessionKey: "agent:alice:atrium:chat:alice:c1",
  approval: { command: COMMAND, decisions: ["allow-once", "allow-always", "deny"] },
};

const record = (t: T, chatId: Id<"chats">, over: Record<string, unknown> = {}) =>
  t.mutation(internal.agentRequests.upsertFromBridge, {
    chatId,
    boundInstanceName: INSTANCE,
    ...EXEC,
    expiresAt: Date.now() + 30 * 60_000,
    ...over,
  });
const allow = (t: T, chatId: Id<"chats">) =>
  t.mutation(internal.agentRequests.settleFromBridge, {
    chatId,
    boundInstanceName: INSTANCE,
    providerRequestId: EXEC.providerRequestId,
    providerCreatedAt: EXEC.providerCreatedAt,
    family: "approval",
    status: "allowed",
    decision: "allow-once",
  });
const failed = (t: T, chatId: Id<"chats">, over: Record<string, unknown> = {}) =>
  t.mutation(internal.agentRequests.markGatewayFailedFromBridge, {
    chatId,
    boundInstanceName: INSTANCE,
    providerRequestId: EXEC.providerRequestId,
    providerCreatedAt: EXEC.providerCreatedAt,
    ...over,
  });
const listed = async (t: T, userId: Id<"users">, chatId: Id<"chats">) =>
  (await t
    .withIdentity({ subject: `${userId}|session` })
    .query(api.agentRequests.listForChat, { chatId })) as unknown as AgentRequestView[];
const traces = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query("traceEvents").collect())
      .filter((e) => e.kind === "agent.request")
      .map((e) => JSON.parse(e.meta ?? "{}") as Record<string, unknown>)
      .filter((m) => m.phase === "gateway_failed"),
  );

describe("an exec approval allowed, then failed on the gateway", () => {
  test("the card keeps its verdict and carries the gateway's word — shown as not run, never as allowed", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const card = await record(t, chatId);
    await allow(t, chatId);
    expect(await failed(t, chatId)).toEqual({ outcome: "marked" });

    const row = (await t.run((ctx) => ctx.db.get(card.id!)))!;
    expect(row).toMatchObject({ status: "allowed", decision: "allow-once", gatewayFailed: true });
    const [view] = await listed(t, userId, chatId);
    expect(view).toMatchObject({ status: "allowed", gatewayFailed: true });
    expect(outcomeOf(view!, Date.now())).toBe("not_run");
  });

  test("the same word before the verdict: the two writes commute", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await record(t, chatId);
    expect(await failed(t, chatId)).toEqual({ outcome: "marked" });
    // Still waiting: the card shows what it showed before.
    const [pending] = await listed(t, userId, chatId);
    expect(pending).toMatchObject({ status: "pending", gatewayFailed: true });
    expect(outcomeOf(pending!, Date.now())).toBeNull();
    await allow(t, chatId);
    const [view] = await listed(t, userId, chatId);
    expect(outcomeOf(view!, Date.now())).toBe("not_run");
  });

  test("without the gateway's word the card is exactly what it was: allowed", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await record(t, chatId);
    await allow(t, chatId);
    const [view] = await listed(t, userId, chatId);
    expect(view!.gatewayFailed).toBe(false);
    expect(outcomeOf(view!, Date.now())).toBe("allowed_elsewhere");
  });
});

describe("which card is marked", () => {
  test("no card of that request: nothing is written, nothing is kept for later", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    expect(await failed(t, chatId)).toEqual({ outcome: "none" });
    const card = await record(t, chatId);
    expect((await t.run((ctx) => ctx.db.get(card.id!)))!.gatewayFailed).toBeUndefined();
    expect(await traces(t)).toEqual([]);
  });

  test("another generation of the same id is another request", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const card = await record(t, chatId);
    expect(await failed(t, chatId, { providerCreatedAt: EXEC.providerCreatedAt + 1 })).toEqual({ outcome: "none" });
    expect((await t.run((ctx) => ctx.db.get(card.id!)))!.gatewayFailed).toBeUndefined();
  });

  test("only an OpenClaw exec approval: a plugin approval under the same id is left alone", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const card = await record(t, chatId, {
      source: "openclaw.plugin",
      approvalKind: "plugin",
      approval: { title: "Send", decisions: ["allow-once", "deny"] },
    });
    expect(await failed(t, chatId)).toEqual({ outcome: "none" });
    expect((await t.run((ctx) => ctx.db.get(card.id!)))!.gatewayFailed).toBeUndefined();
  });

  test("another instance's bridge cannot mark this conversation's card", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await record(t, chatId);
    await expect(failed(t, chatId, { boundInstanceName: "other" })).rejects.toThrow(/cross-instance/);
  });
});

describe("what the operator can count", () => {
  test("one trace per occurrence — the card's status and decision, never the command", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    await record(t, chatId);
    await allow(t, chatId);
    await failed(t, chatId);
    // A replay of the same word (the bridge retries, two sockets saw the frame).
    expect(await failed(t, chatId)).toEqual({ outcome: "marked" });

    const seen = await traces(t);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      phase: "gateway_failed",
      source: "openclaw.exec",
      cardStatus: "allowed",
      decision: "allow-once",
      elsewhere: true,
    });
    expect(typeof seen[0]!.sinceResolvedMs).toBe("number");
    expect(JSON.stringify(seen)).not.toContain("SECRET_COMMAND_TEXT");
    expect(JSON.stringify(seen)).not.toContain(EXEC.providerRequestId);
  });
});
