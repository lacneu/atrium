/// <reference types="vite/client" />
//
// THE PROVIDER REVOKED THE AGENT'S CREDENTIAL (prod 2026-10-02, agent `jerome`).
//
// Three turns failed under upstream's "Context is too large …" headline while the cause
// was a 401 on an invalidated OAuth token. These tests follow the class through Convex:
// the finalize writes it on the trace WITH the agent and the provider (ids only), the
// detector raises it CRITICAL on the first occurrence, the retry policy leaves it alone,
// the allowlist keeps it countable, and a row stored before the class existed is still
// recognized from its text.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  isProviderAuthRevokedFailureText,
  normalizeMessageErrorCode,
  reauthProviderFromText,
} from "./lib/chatRenderState";
import { RETRYABLE_KINDS, retryDecision } from "./turnRetry";
import { actionForErrorCode } from "./lib/diagnose";
import { classifySubAgentError } from "./lib/subAgentFailure";

const modules = import.meta.glob("./**/*.ts");

// Composed as v2026.9.6 composes it (see bridge/test/failure-classifier.test.ts): the
// preflight-compaction wrapper around a model-fallback summary and its re-authentication
// hint. Gateway text only.
const PROD_REVOKED_TEXT =
  "⚠️ Context is too large and auto-compaction could not recover this turn. Reason: " +
  "All models failed (2): openai/gpt-5.6-sol: 401: Encountered invalidated oauth token for user (auth) | " +
  "openai/gpt-5.6-terra: 401: Encountered invalidated oauth token for user (auth). " +
  "Re-authenticate with: openclaw models auth login --provider 'openai' --force. " +
  "Try again, use /compact, or use /new to start a fresh session.";

async function seedStreamingMessage(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "ataraxis",
      agentId: "jerome",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
    return { chatId, messageId };
  });
}

describe("provider_auth_revoked in Convex", () => {
  test("finalize puts the class, the agent and the provider on the trace — never the text", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingMessage(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: PROD_REVOKED_TEXT,
      errorKind: "provider_auth_revoked",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.errorCode).toBe("provider_auth_revoked");
    // Never scheduled for a retry: every attempt would meet the same refusal.
    expect(msg?.autoRetry).toBeUndefined();

    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    const finalize = traces.find(
      (e) => e.kind === "assistant.stream" && String(e.meta).includes('"finalize"'),
    );
    const meta = JSON.parse(String(finalize?.meta)) as Record<string, unknown>;
    expect(meta.errorCode).toBe("provider_auth_revoked");
    expect(meta.agentId).toBe("jerome");
    expect(meta.instanceName).toBe("ataraxis");
    expect(meta.authProvider).toBe("openai");
    // Metadata only: no word of the gateway's sentence rides the trace.
    expect(String(finalize?.meta)).not.toMatch(/invalidated|Context is too large|Re-authenticate/);
  });

  test("another class carries no agent on its trace", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingMessage(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: "rate limited",
      errorKind: "rate_limit",
    });
    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    const finalize = traces.find(
      (e) => e.kind === "assistant.stream" && String(e.meta).includes('"finalize"'),
    );
    expect(String(finalize?.meta)).not.toContain("agentId");
  });

  test("ONE occurrence raises a CRITICAL anomaly naming the agent and the provider", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingMessage(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: PROD_REVOKED_TEXT,
      errorKind: "provider_auth_revoked",
    });
    const res = await t.mutation(internal.anomalies.detectAnomalies, {});
    expect(res.detected).toContain("assistant.cause.provider_auth_revoked");
    const open = await t.query(internal.anomalies.anomaliesInternal, { status: "open" });
    const row = open.find((a) => a.kind === "assistant.cause.provider_auth_revoked");
    expect(row?.severity).toBe("critical");
    const evidence = JSON.parse(String(row?.evidence)) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      cause: "provider_auth_revoked",
      count: 1,
      agents: ["ataraxis/jerome"],
      providers: ["openai"],
    });
    expect(String(row?.evidence)).not.toMatch(/invalidated|oauth token/);
    expect(row?.message).toContain("ataraxis/jerome");
  });

  test("a single occurrence of an ordinary cause stays a WARN", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedStreamingMessage(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: "rate limited",
      errorKind: "rate_limit",
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const open = await t.query(internal.anomalies.anomaliesInternal, { status: "open" });
    expect(open.find((a) => a.kind === "assistant.cause.rate_limit")?.severity).toBe("warn");
  });

  test("never retried, always countable, and the operator is told what to run", () => {
    expect(RETRYABLE_KINDS.has("provider_auth_revoked")).toBe(false);
    expect(normalizeMessageErrorCode("provider_auth_revoked")).toBe("provider_auth_revoked");
    // READ-ONLY diagnosis: never a per-agent login, which would shadow the shared one.
    const action = actionForErrorCode("provider_auth_revoked");
    expect(action).toContain("openclaw models auth list --provider <provider> --agent <agentId>");
    expect(action).toContain("openclaw models auth order get --provider <provider> --agent <agentId>");
    expect(action).not.toMatch(/openclaw models auth --agent <agentId> login --provider/);
    // A delegated child refused the same way is named, not `api_error` (its 401) nor
    // `timeout` (an "expired" token).
    expect(classifySubAgentError("error", PROD_REVOKED_TEXT)).toBe("provider_auth_revoked");
    expect(
      classifySubAgentError("error", "HTTP 401: Your authentication token has been expired"),
    ).toBe("provider_auth_revoked");
    expect(classifySubAgentError("error", "boom", "provider_auth_revoked")).toBe(
      "provider_auth_revoked",
    );
  });

  test("retryDecision refuses it, on a zero-content turn the retry would otherwise take", () => {
    expect(
      retryDecision({
        status: "error",
        errorKind: "provider_auth_revoked",
        finalTextLen: 0,
        partCount: 0,
        chatBusy: false,
        lastAttempt: 0,
      }),
    ).toBeNull();
  });
});

describe("the stored-text mirror (rows written before the class existed)", () => {
  test("recognizes the production text and names its provider", () => {
    expect(isProviderAuthRevokedFailureText(PROD_REVOKED_TEXT)).toBe(true);
    expect(isProviderAuthRevokedFailureText(PROD_REVOKED_TEXT.slice(0, 240))).toBe(true);
    expect(reauthProviderFromText(PROD_REVOKED_TEXT)).toBe("openai");
  });

  test("operator values cannot carry it, and the provider must look like one", () => {
    expect(
      isProviderAuthRevokedFailureText(
        'Session "401: Encountered invalidated oauth token" changed while starting work. Retry.',
      ),
    ).toBe(false);
    expect(
      isProviderAuthRevokedFailureText(
        "⚠️ Context is too large and auto-compaction could not recover this turn. Reason: " +
          "All models failed (2): acme/(401:revoked-token): fetch failed (unknown) | " +
          "acme/(401:revoked-token)-b: fetch failed (unknown).",
      ),
    ).toBe(false);
    expect(
      isProviderAuthRevokedFailureText(
        "Authentication failed (provider returned HTTP 401). Your provider token may have expired — try the request again in a moment.",
      ),
    ).toBe(false);
    expect(
      reauthProviderFromText("Re-authenticate with: openclaw models auth login --provider 'a b; rm' --force"),
    ).toBeNull();
    expect(reauthProviderFromText("no hint here")).toBeNull();
  });
});
