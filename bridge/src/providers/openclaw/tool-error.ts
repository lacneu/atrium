// THE ERROR OUTCOME OF A TOOL RESULT READ FROM THE HISTORY, AS OPENCLAW v2026.9.33 DECIDES IT
// (0.101.2 audit, then its final review). With `chat.history` activity — what a transcript
// row stands for — the Control UI reads only the activity's status (`isToolCardError`,
// ui/src/lib/chat/tool-cards.ts:136-137), and that status is `isError === true ||
// isToolResultError(block)` (src/infra/agent-activity-events.ts:296): the flag, then the
// STRUCTURED `details` (`isToolResultError`, src/agents/tool-result-error.ts:90-130, ported
// below as is). Only a result with no `details` falls back on the Control UI's reading of the
// output text (`isToolErrorOutput`, src/chat/tool-content.ts:72-116; tests
// ui/src/pages/chat/components/chat-tool-cards.outcome.test.ts:270, :291) — so an `exec` that
// exits 0 printing `{"error":"rate limited"}` is a success, and a refused `sessions_send`
// (`details.status: "forbidden"`) a failure.

import { normalizeOptionalLowercaseString } from "../../vendor/upstream-redact/packages/normalization-core/src/string-coerce.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** src/chat/tool-content.ts:59-62. */
export function readToolErrorFlag(value: Record<string, unknown>): boolean | undefined {
  const raw = value.isError ?? value.is_error;
  return typeof raw === "boolean" ? raw : undefined;
}

const TOOL_NOT_FOUND_PATTERN = /^tool not found\.?$/i;
const MAX_ERROR_DETECT_CHARS = 20_000;
const TOOL_ERROR_STATUSES = new Set(["error", "failed", "timeout"]);

function hasToolErrorStatus(value: unknown): boolean {
  return typeof value === "string" && TOOL_ERROR_STATUSES.has(value.trim().toLowerCase());
}

/** src/chat/tool-content.ts:72-116. */
export function isToolErrorOutput(outputText: string | undefined): boolean {
  if (!outputText) {
    return false;
  }
  const trimmed = outputText.trim();
  if (!trimmed) {
    return false;
  }
  if (TOOL_NOT_FOUND_PATTERN.test(trimmed)) {
    return true;
  }
  if (trimmed.length > MAX_ERROR_DETECT_CHARS) {
    return false;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  const obj = parsed;
  const explicitErrorFlag = readToolErrorFlag(obj);
  if (explicitErrorFlag !== undefined) {
    return explicitErrorFlag;
  }
  if ("error" in obj) {
    const value = obj.error;
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (value && typeof value === "object") {
      return true;
    }
  }
  return hasToolErrorStatus(obj.status);
}

/** ui/src/lib/chat/tool-cards.ts:87-106 (`extractToolText`). */
export function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    const parts = item.content.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

// src/agents/tool-result-error.ts:26-32, 69-130 — as is.
function readToolErrorField(error: object, key: string): unknown {
  try {
    return key in error ? (error as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

export function readToolResultDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  try {
    const details = readToolErrorField(result, "details");
    return details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readToolResultStatus(result: unknown): string | undefined {
  const details = readToolResultDetails(result);
  return normalizeOptionalLowercaseString(
    details ? readToolErrorField(details, "status") : undefined,
  );
}

export function isToolResultError(result: unknown): boolean {
  const details = readToolResultDetails(result);
  const normalized = readToolResultStatus(result);
  const ok = details ? readToolErrorField(details, "ok") : undefined;
  const success = details ? readToolErrorField(details, "success") : undefined;
  const explicitlySuccessful = ok === true || success === true;
  if (ok === false || success === false) {
    return true;
  }
  const hasFailureStatus =
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "timeout" ||
    normalized === "timed_out" ||
    normalized === "blocked" ||
    normalized === "denied" ||
    normalized === "forbidden" ||
    normalized === "unavailable" ||
    normalized === "approval-unavailable" ||
    normalized === "disabled" ||
    normalized === "aborted" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "killed" ||
    normalized === "invalid";
  if (hasFailureStatus && !explicitlySuccessful) {
    return true;
  }
  const timedOut = details ? readToolErrorField(details, "timedOut") : undefined;
  const error = details ? readToolErrorField(details, "error") : undefined;
  if (timedOut === true || Boolean(error)) {
    return true;
  }
  if (normalized === "completed") {
    return false;
  }
  const exitCode = details ? readToolErrorField(details, "exitCode") : undefined;
  return typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
}

/** A history tool result's outcome: the flag (the result's, else its message's) when it says
 *  failed, else the structured `details` (`isError === true || isToolResultError(block)`,
 *  agent-activity-events.ts:296); only a result WITHOUT `details` is read from its flag, then
 *  its output text (the Control UI's fallback when no activity exists). */
export function historyToolResultFailed(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
): boolean {
  const flag = readToolErrorFlag(item) ?? (item === message ? undefined : readToolErrorFlag(message));
  if (flag === true) return true;
  if (readToolResultDetails(item) !== undefined) return isToolResultError(item);
  return flag ?? isToolErrorOutput(extractToolText(item));
}
