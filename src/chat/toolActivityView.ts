import { m } from "@/paraglide/messages.js";

// Pure logic for the grouped "agent activity" block (ToolActivity.tsx).
//
// Tool invocations no longer ride in the assistant-ui message CONTENT (stacked
// ToolCards used to push the late-arriving text out of view, and hiding them
// via the showTools pref left ZERO feedback during long tool-heavy turns).
// convertMessage now routes them through ThreadMessageLike
// `metadata.custom.toolParts`, and the summary/state derivation lives here as
// pure functions so the singular/plural + running branches are unit-tested
// (see toolActivity.test.ts — parameterized i18n messages must have EVERY
// branch exercised, the GC-P5 lesson).

/** One tool invocation, extracted from a Convex `kind:"tool"` message part. */
export type ToolActivityPart = {
  /** Stable synthetic id (message + run + part order) — React list key. */
  toolCallId: string;
  toolName: string;
  /** Parsed tool input (mirrors the old assistant-ui tool-call `args`). */
  args?: unknown;
  /** JSON form of the input, for streaming/partial display in ToolCard. */
  argsText?: string;
  /** Tool output, present once the tool completed. */
  result?: unknown;
  /** Bridge tool phase: "started" | "running" | "completed" | "error". */
  phase?: string;
};

/** Projection of a tool's `result` for display. An exec/bash result on OpenClaw
 *  2026.6.5 AND 2026.6.8 (verified by raw-frame capture) is ONLY the outcome
 *  envelope `{status, exitCode, durationMs}` -- the gateway does NOT transmit the
 *  command's stdout on the operator stream (the Control UI reads it from a
 *  gateway-internal channel). So dumping that envelope as raw JSON "output"
 *  misleads (it looks like the whole output). We render it as a clear OUTCOME
 *  instead, and surface that the stdout was not transmitted. A string result is
 *  real output; any richer object (web_search queries, apply_patch changes, or a
 *  FUTURE version that DOES include stdout alongside the envelope) keeps the full
 *  view. */
export type ToolResultView =
  | { kind: "text"; text: string }
  | {
      kind: "outcome";
      status: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { kind: "json"; text: string };

// The exact key set of the exec/bash outcome envelope (no stdout). A result whose
// keys are a SUBSET of these is the bare envelope; one extra key (e.g. a future
// `output`/`stdout`, or web_search's `query`) means there is real content to show.
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "status",
  "exitCode",
  "durationMs",
]);

function jsonText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatToolResult(result: unknown): ToolResultView {
  if (typeof result === "string") return { kind: "text", text: result };
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>;
    const keys = Object.keys(rec);
    // The EXEC envelope, and ONLY it: a numeric `exitCode` (the exec-specific
    // signal) AND no key beyond the envelope. This keeps a non-exec tool whose
    // result merely happens to be `{status}` / `{status, durationMs}` rendered as
    // its real JSON, not a misleading "output not transmitted" outcome.
    if (
      typeof rec.exitCode === "number" &&
      keys.every((k) => ENVELOPE_KEYS.has(k))
    ) {
      return {
        kind: "outcome",
        status: typeof rec.status === "string" ? rec.status : null,
        exitCode: rec.exitCode,
        durationMs: typeof rec.durationMs === "number" ? rec.durationMs : null,
      };
    }
  }
  return { kind: "json", text: jsonText(result) };
}

/** One-line label for an exec OUTCOME: "<done> exit 0 ... 15 ms" on success or
 *  "<failed> exit 1" on failure (the head + units come from i18n; the separator
 *  is the middot). Pure so every i18n branch is unit-tested. */
export function toolOutcomeLabel(v: {
  status: string | null;
  exitCode: number | null;
  durationMs: number | null;
}): string {
  // exitCode is the command's authoritative success signal: when present, ONLY 0
  // is success (a non-zero exit with status "completed" -- the call finished but
  // the command failed -- must read as a failure). status is the fallback only
  // when there is no exitCode (e.g. a non-exec tool).
  const ok = v.exitCode !== null ? v.exitCode === 0 : v.status === "completed";
  const bits = [ok ? m.tools_outcome_completed() : m.tools_outcome_failed()];
  if (v.exitCode !== null) bits.push(m.tools_outcome_exit({ code: v.exitCode }));
  if (v.durationMs !== null) {
    bits.push(m.tools_outcome_ms({ ms: v.durationMs }));
  }
  return bits.join(" · ");
}

export interface ToolActivitySummaryView {
  count: number;
  /** True while the turn is still producing tool activity (drives the spinner). */
  running: boolean;
  /** User-facing count label ("1 appel d'outil" / "N appels d'outils"). */
  label: string;
}

/** Message statuses after which no further tool activity can arrive. */
const TERMINAL_MESSAGE_STATUSES = new Set(["complete", "error", "aborted"]);
/** Tool phases that mean the invocation itself settled. */
const TERMINAL_TOOL_PHASES = new Set(["completed", "error"]);

function isRunning(
  parts: readonly ToolActivityPart[],
  messageStatus: string | undefined,
): boolean {
  if (parts.length === 0) return false;
  // Authoritative signal: the Convex message status (schema-required on real
  // messages, surfaced via metadata.custom.status).
  if (messageStatus === "streaming") return true;
  if (messageStatus !== undefined && TERMINAL_MESSAGE_STATUSES.has(messageStatus))
    return false;
  // Unknown/missing status (defensive — e.g. a placeholder frame): fall back to
  // "the last tool invocation has not settled yet".
  const last = parts[parts.length - 1];
  if (last.phase !== undefined && TERMINAL_TOOL_PHASES.has(last.phase))
    return false;
  return last.result === undefined || last.result === null;
}

// Argument keys that carry the human-meaningful "what is this call doing", in
// priority order: a Bash/exec `command`, a search `query`, a fetched `url`, a
// file `path`/`pattern`, … Mirrors what OpenClaw's Control UI shows on each tool
// row so a 30×Bash turn is legible WITHOUT expanding every card.
const PREVIEW_KEYS = [
  "command",
  "query",
  "url",
  "path",
  "pattern",
  "file",
  "cmd",
  "prompt",
] as const;

/**
 * A one-line, header-level preview of a tool's input. Prefers a known arg key,
 * falls back to the textual input; whitespace-collapsed to one line (CSS
 * ellipsis truncates the overflow). Empty when there is nothing to show — the
 * full input always remains in ToolCard's expandable "input" block.
 */
export function toolPreview(args: unknown, argsText: string | undefined): string {
  let raw = "";
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const rec = args as Record<string, unknown>;
    for (const key of PREVIEW_KEYS) {
      const v = rec[key];
      if (typeof v === "string" && v.trim()) {
        raw = v;
        break;
      }
    }
  }
  if (!raw) raw = argsText ?? (typeof args === "string" ? args : "");
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Derives the summary-row view from a message's tool parts + status.
 * Counter is LIVE for free: the bridge appends tool parts as OpenClaw frames
 * arrive, useQuery re-runs, convertMessage re-converts, and this recomputes.
 */
export function toolActivitySummary(
  parts: readonly ToolActivityPart[],
  messageStatus: string | undefined,
): ToolActivitySummaryView {
  const count = parts.length;
  const label =
    count === 1
      ? m.tools_activity_count({ count })
      : m.tools_activity_count_plural({ count });
  return { count, running: isRunning(parts, messageStatus), label };
}
