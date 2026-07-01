import { m } from "@/paraglide/messages.js";
import type { SubAgentSessionMeta } from "./subAgentActivityView";

// Pure assembly of a self-contained Markdown export of a sub-agent's session — its
// task, static config, each tool call (input + output), and the final result/error.
// Pure so it is unit-tested without a DOM; the panel wraps the output into a
// downloaded `.md` file. This is the USER's own data (in-app), so the full tool
// args/results are included — the SOC2 content-free floor is for the observability
// surfaces (MCP / traces), not for what the user exports of their own run.

export type SubAgentExportTool = {
  name: string;
  status: string;
  argsText?: string;
  resultText?: string;
};

export type SubAgentExportInput = {
  taskName?: string;
  status: string;
  parentAgentLabel?: string;
  sessionMeta?: SubAgentSessionMeta;
  result?: string;
  error?: string;
  tools: ReadonlyArray<SubAgentExportTool>;
};

/** A filesystem-safe, short slug of the task for the download filename. */
export function subAgentExportFilename(taskName: string | undefined): string {
  const base = (taskName ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const slug = base.replace(/^-+|-+$/g, "").slice(0, 40);
  return `sous-agent${slug ? `-${slug}` : ""}.md`;
}

export function buildSubAgentExportMarkdown(input: SubAgentExportInput): string {
  const lines: string[] = [];
  const title = input.taskName?.trim() || m.subagent_panel_kind();
  lines.push(`# ${m.subagent_panel_kind()} — ${title}`, "");

  const meta: string[] = [];
  if (input.parentAgentLabel) {
    meta.push(`- ${m.subagent_bar_parent()} : ${input.parentAgentLabel}`);
  }
  const sm = input.sessionMeta;
  if (sm?.model) {
    meta.push(
      `- ${m.subagent_bar_model()} : ${sm.model}${
        sm.modelProvider ? ` (${sm.modelProvider})` : ""
      }`,
    );
  }
  if (sm?.thinkingLevel) {
    meta.push(`- ${m.subagent_bar_reasoning()} : ${sm.thinkingLevel}`);
  }
  if (sm?.fastMode !== undefined) {
    meta.push(
      `- ${m.subagent_bar_speed()} : ${
        sm.fastMode ? m.subagent_bar_fast() : m.subagent_bar_standard()
      }`,
    );
  }
  if (sm?.controlScope) meta.push(`- ${m.subagent_bar_scope()} : ${sm.controlScope}`);
  if (sm?.subagentRole) meta.push(`- ${m.subagent_bar_role()} : ${sm.subagentRole}`);
  if (sm?.spawnDepth !== undefined) {
    meta.push(`- ${m.subagent_bar_depth()} : ${sm.spawnDepth}`);
  }
  if (meta.length) lines.push(...meta, "");

  if (input.tools.length > 0) {
    lines.push(`## ${m.subagent_panel_tools()} (${input.tools.length})`, "");
    for (const t of input.tools) {
      lines.push(`### ${t.name} — ${t.status}`, "");
      if (t.argsText) lines.push("**Input**", "", "```", t.argsText, "```", "");
      if (t.resultText) lines.push("**Output**", "", "```", t.resultText, "```", "");
    }
  }

  if (input.error) {
    lines.push(`## ${m.subagent_panel_error()}`, "", input.error, "");
  }
  // The result is itself Markdown — include it raw (not fenced).
  if (input.result) {
    lines.push(`## ${m.subagent_panel_result()}`, "", input.result, "");
  }

  return `${lines.join("\n").trim()}\n`;
}
