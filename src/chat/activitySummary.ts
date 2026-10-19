// THE ACTIVITY BLOCK'S SUMMARY, AS THE CONTROL UI WRITES IT (OpenClaw v2026.9.33).
//
// A run of consecutive tool calls is ONE collapsible block whose label counts the operations
// by family — "4 commands · 1 other operation · 1 failed" (ui/src/lib/chat/
// tool-call-grouping.ts `describeToolGroup`/`summarizeToolGroup`, rendered by
// ui/src/pages/chat/components/chat-message-group.ts:204-386 `renderActivityGroup`).
//
// PORTED, NOT VENDORED, and said so: the counting lives in src/agents/
// agent-activity-presentation.ts, whose import closure reaches the whole gateway-protocol
// barrel (`../session-cards/progress-card-input.js` → `packages/gateway-protocol/src/
// index.js`), and the label in a Control UI module bound to its i18n catalogue and typebox.
// The two functions below are those upstream functions line for line (`summarizeAgentActivity`
// :70-114 with its category table :116-152, `resolveCompletedActivityWrappers` :7-22); the
// labels are the Control UI's own strings (en.ts `chat.toolCards.activity.*`, the French ones
// from its translation memory). The nesting itself (`groupToolCalls`) IS vendored, with its
// upstream test (src/vendor/upstream-activity).

import { m } from "@/paraglide/messages.js";
import { groupToolCalls, type ToolCallIdentity } from "../vendor/upstream-activity/src/chat/tool-call-grouping";

/** One operation, as the Control UI's prepared activity names it. */
export type ActivityItem = {
  itemId: string;
  toolCallId?: string;
  title: string;
  name?: string;
  commandBearing?: boolean;
  status?: string;
  hideFromChannelProgress?: boolean;
  suppressChannelProgress?: boolean;
};

/** src/agents/agent-activity-presentation.ts:7-22 — only recorded, unambiguous children
 *  replace a successfully completed wrapper. */
export function resolveCompletedActivityWrappers<
  Call extends ToolCallIdentity & { activity?: { status?: string } },
>(calls: readonly Call[]): Set<Call> {
  const wrappers = new Set<Call>();
  const pending = groupToolCalls(calls);
  while (pending.length > 0) {
    const group = pending.pop()!;
    if (group.children.length > 0 && group.card.activity?.status === "completed") {
      wrappers.add(group.card);
    }
    for (const child of group.children) {
      pending.push(child);
    }
  }
  return wrappers;
}

/** src/agents/agent-activity-presentation.ts:70-114. */
export function summarizeAgentActivity(items: readonly ActivityItem[]) {
  const operations = new Map(
    items
      .filter((item) => !item.suppressChannelProgress)
      .map((item) => [item.toolCallId ?? item.itemId, item]),
  );
  const counts = { commands: 0, reads: 0, edits: 0, writes: 0, searches: 0, fetches: 0, other: 0 };
  const outcomes = { failed: 0, blocked: 0, skipped: 0, unknown: 0 };
  let total = 0;
  for (const item of operations.values()) {
    if (item.hideFromChannelProgress || item.suppressChannelProgress) {
      continue;
    }
    // Prepared names describe operations, not successful effects or distinct
    // files. Free-form titles and metadata belong only in individual details.
    const name = (item.name ?? "").toLowerCase();
    const category = item.commandBearing ? "commands" : (ACTIVITY_CATEGORIES.get(name) ?? "other");
    counts[category] += 1;
    total += 1;
    if (item.status === "failed" || item.status === "blocked" || item.status === "skipped") {
      outcomes[item.status] += 1;
    } else if (!item.status) {
      outcomes.unknown += 1;
    }
  }
  return { total, counts, outcomes };
}

const ACTIVITY_CATEGORIES = new Map<
  string,
  "commands" | "reads" | "edits" | "writes" | "searches" | "fetches"
>([
  ["exec", "commands"],
  ["bash", "commands"],
  ["shell", "commands"],
  ["run_command", "commands"],
  ["run_terminal_cmd", "commands"],
  ["read", "reads"],
  ["read_file", "reads"],
  ["readfile", "reads"],
  ["notebookread", "reads"],
  ["notebook_read", "reads"],
  ["edit", "edits"],
  ["apply_patch", "edits"],
  ["applypatch", "edits"],
  ["patch", "edits"],
  ["edit_file", "edits"],
  ["multiedit", "edits"],
  ["multi_edit", "edits"],
  ["notebookedit", "edits"],
  ["notebook_edit", "edits"],
  ["write", "writes"],
  ["write_file", "writes"],
  ["create_file", "writes"],
  ["grep", "searches"],
  ["glob", "searches"],
  ["find", "searches"],
  ["ls", "searches"],
  ["list", "searches"],
  ["codebase_search", "searches"],
  ["web_search", "searches"],
  ["web_fetch", "fetches"],
  ["webfetch", "fetches"],
  ["fetch", "fetches"],
]);

type Category = keyof ReturnType<typeof summarizeAgentActivity>["counts"];

const CATEGORY_LABEL: Record<Category, (count: number) => string> = {
  commands: (n) => (n === 1 ? m.activity_summary_commands_one() : m.activity_summary_commands_many({ count: String(n) })),
  reads: (n) => (n === 1 ? m.activity_summary_reads_one() : m.activity_summary_reads_many({ count: String(n) })),
  edits: (n) => (n === 1 ? m.activity_summary_edits_one() : m.activity_summary_edits_many({ count: String(n) })),
  writes: (n) => (n === 1 ? m.activity_summary_writes_one() : m.activity_summary_writes_many({ count: String(n) })),
  searches: (n) => (n === 1 ? m.activity_summary_searches_one() : m.activity_summary_searches_many({ count: String(n) })),
  fetches: (n) => (n === 1 ? m.activity_summary_fetches_one() : m.activity_summary_fetches_many({ count: String(n) })),
  other: (n) => (n === 1 ? m.activity_summary_other_one() : m.activity_summary_other_many({ count: String(n) })),
};

const OUTCOME_LABEL: Record<"failed" | "blocked" | "skipped" | "unknown", (count: number) => string> = {
  failed: (n) => m.activity_summary_failed({ count: String(n) }),
  blocked: (n) => m.activity_summary_blocked({ count: String(n) }),
  skipped: (n) => m.activity_summary_skipped({ count: String(n) }),
  unknown: (n) => m.activity_summary_unknown({ count: String(n) }),
};

/** ui/src/lib/chat/tool-call-grouping.ts:24-44 `describeToolGroup`. */
export function describeToolGroup(items: readonly ActivityItem[]) {
  const summary = summarizeAgentActivity(items);
  const label = (Object.entries(summary.counts) as Array<[Category, number]>)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => CATEGORY_LABEL[kind](count))
    .join(" · ");
  const outcomes = (Object.entries(summary.outcomes) as Array<[keyof typeof OUTCOME_LABEL, number]>)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ kind, label: OUTCOME_LABEL[kind](count) }));
  return { total: summary.total, label, outcomes };
}

/** ui/src/lib/chat/tool-call-grouping.ts:46-60 `summarizeToolGroup`. */
export function summarizeToolGroup(
  items: readonly ActivityItem[],
  options: { includeInlineOutcomes?: boolean } = {},
): string {
  const summary = describeToolGroup(items);
  return (
    [
      summary.label,
      ...summary.outcomes
        .filter(
          ({ kind }) =>
            options.includeInlineOutcomes !== false || (kind !== "failed" && kind !== "skipped"),
        )
        .map(({ label }) => label),
    ]
      .filter(Boolean)
      .join(" · ") || m.activity_summary_raw_details()
  );
}
