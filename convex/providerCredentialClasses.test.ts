/// <reference types="vite/client" />
//
// ERROR LABELS, STRUCTURED FIRST (0.91.3) — the Convex hop of the classes the bridge now mints.
//
// A credential refusal is split three ways (revoked / permission / unnamed), the provider
// account's billing and an unknown model are named, a provider logout reads as its own end,
// and upstream's generic wrappers without a cause are named for what they are. Each class is
// stored, allowlisted on the trace, never retried, counted under its own anomaly — the
// provider-account ones CRITICAL on the first occurrence, with the agent in the evidence.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { normalizeMessageErrorCode, PER_AGENT_FAILURE_CAUSES } from "./lib/chatRenderState";
import { RETRYABLE_KINDS, retryDecision } from "./turnRetry";
import { actionForErrorCode } from "./lib/diagnose";
import { classifySubAgentError } from "./lib/subAgentFailure";

const modules = import.meta.glob("./**/*.ts");

// A 403 behind upstream's re-authentication hint (model-fallback-runner.ts:698-701,
// failover-error.ts:486-502): 0.91.2 called this an expired credential.
const PERMISSION_TEXT =
  "All models failed (2): openai/gpt-5.6-sol: 403 Forbidden: unsupported_country_region_territory (auth) | " +
  "openai/gpt-5.6-terra: 403 Forbidden: unsupported_country_region_territory (auth). " +
  "Re-authenticate with: openclaw models auth login --provider 'openai' --force";

const NEW_CLASSES = [
  "provider_permission_denied",
  "provider_auth_failed",
  "provider_billing",
  "model_not_found",
  "provider_access_removed",
  "compaction_failed_no_cause",
  "run_failed_no_cause",
] as const;

async function seed(t: ReturnType<typeof convexTest>) {
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

describe("the new classes in Convex", () => {
  test("every one is allowlisted (countable) and none is retried", () => {
    for (const cls of NEW_CLASSES) {
      expect(normalizeMessageErrorCode(cls), cls).toBe(cls);
      expect(RETRYABLE_KINDS.has(cls), cls).toBe(false);
      expect(
        retryDecision({
          status: "error",
          errorKind: cls,
          finalTextLen: 0,
          partCount: 0,
          chatBusy: false,
          lastAttempt: 0,
        }),
        cls,
      ).toBeNull();
    }
  });

  test("a permission refusal: agent + provider on the trace, CRITICAL on the first, never the text", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error: PERMISSION_TEXT,
      errorKind: "provider_permission_denied",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.errorCode).toBe("provider_permission_denied");
    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    const finalize = traces.find(
      (e) => e.kind === "assistant.stream" && String(e.meta).includes('"finalize"'),
    );
    const meta = JSON.parse(String(finalize?.meta)) as Record<string, unknown>;
    expect(meta).toMatchObject({
      errorCode: "provider_permission_denied",
      agentId: "jerome",
      instanceName: "ataraxis",
      authProvider: "openai",
    });
    expect(String(finalize?.meta)).not.toMatch(/Forbidden|unsupported_country|Re-authenticate/);

    await t.mutation(internal.anomalies.detectAnomalies, {});
    const open = await t.query(internal.anomalies.anomaliesInternal, { status: "open" });
    const row = open.find((a) => a.kind === "assistant.cause.provider_permission_denied");
    expect(row?.severity).toBe("critical");
    expect(JSON.parse(String(row?.evidence))).toMatchObject({
      cause: "provider_permission_denied",
      agents: ["ataraxis/jerome"],
      providers: ["openai"],
    });
  });

  test("each provider-account class names the agent and is critical on the first occurrence", async () => {
    for (const cls of ["provider_auth_failed", "provider_billing", "model_not_found"]) {
      expect(PER_AGENT_FAILURE_CAUSES.has(cls), cls).toBe(true);
      const t = convexTest(schema, modules);
      const { messageId } = await seed(t);
      await t.mutation(internal.stream.finalize, {
        messageId,
        status: "error",
        error: "LLM request failed.",
        errorKind: cls,
      });
      await t.mutation(internal.anomalies.detectAnomalies, {});
      const open = await t.query(internal.anomalies.anomaliesInternal, { status: "open" });
      const row = open.find((a) => a.kind === `assistant.cause.${cls}`);
      expect(row?.severity, cls).toBe("critical");
      expect(JSON.parse(String(row?.evidence)), cls).toMatchObject({ agents: ["ataraxis/jerome"] });
    }
  });

  test("a gateway that withheld the cause is counted as itself, a WARN", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seed(t);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "error",
      error:
        "⚠️ Context is too large and auto-compaction could not recover this turn. Try again, use /compact, or use /new to start a fresh session.",
      errorKind: "compaction_failed_no_cause",
    });
    await t.mutation(internal.anomalies.detectAnomalies, {});
    const open = await t.query(internal.anomalies.anomaliesInternal, { status: "open" });
    expect(
      open.find((a) => a.kind === "assistant.cause.compaction_failed_no_cause")?.severity,
    ).toBe("warn");
    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    const finalize = traces.find(
      (e) => e.kind === "assistant.stream" && String(e.meta).includes('"finalize"'),
    );
    expect(String(finalize?.meta)).not.toContain("agentId");
  });

  test("the operator's read-only diagnosis exists for the two new credential codes", () => {
    for (const code of ["provider_permission_denied", "provider_auth_failed"]) {
      const action = actionForErrorCode(code);
      expect(action, code).toContain("openclaw models auth list --provider <provider> --agent <agentId>");
      expect(action, code).not.toMatch(/models auth --agent <agentId> login --provider/);
    }
    expect(actionForErrorCode("provider_permission_denied")).toMatch(/does not help/);
  });
});

describe("a delegated child's failure category (R12)", () => {
  test("a 401 'expired' token is a credential, not a timeout", () => {
    expect(
      classifySubAgentError("error", "401: the access token has been revoked"),
    ).toBe("provider_auth_revoked");
    expect(classifySubAgentError("error", "HTTP 401: session expired")).toBe("api_error");
    expect(classifySubAgentError("error", "session expired")).toBe("unknown");
    expect(classifySubAgentError("error", PERMISSION_TEXT)).toBe("provider_permission_denied");
    expect(classifySubAgentError("error", "boom", "provider_auth_failed")).toBe(
      "provider_auth_failed",
    );
  });

  test("the reapers' own sentences still read as before", () => {
    expect(
      classifySubAgentError("error", "Sous-agent expiré — aucune activité, observateur probablement perdu"),
    ).toBe("timeout");
    expect(
      classifySubAgentError("error", "background task expired (no delivery, unverifiable)"),
    ).toBe("timeout");
    expect(classifySubAgentError("error", "Run timed out after 600s")).toBe("timeout");
  });
});
