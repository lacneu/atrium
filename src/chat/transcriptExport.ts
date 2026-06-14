// Pure transcript serializers (Markdown + JSON) for the chat export.
//
// Pure + unit-tested on purpose: the export is trust-sensitive (a file named
// "the transcript" must not silently drop content), so the truncation marker,
// the role labels, and the non-text part handling are PINNED by tests rather
// than eyeballed. No I/O, no Date.now() — the caller passes `exportedAt`.
//
// Deliberate part handling (pinned by the test):
//   - file / media parts  -> a "[fichier : <name>]" line (the artifact is not
//     embedded, only named — the download links live in the live UI).
//   - tool / reasoning parts -> OMITTED (execution detail, not conversation).

import { m } from "@/paraglide/messages.js";

export interface ExportPart {
  kind: string;
  filename?: string;
  name?: string;
}

export interface ExportMessage {
  role: "user" | "assistant" | "system";
  text: string;
  /** epoch ms */
  createdAt: number;
  parts?: ExportPart[];
}

export interface ExportOpts {
  title?: string;
  /** True when the source was capped (e.g. the 200-message window). */
  truncated?: boolean;
  /** epoch ms, passed in (keeps the function pure/testable). */
  exportedAt?: number;
}

const ROLE_LABEL: Record<ExportMessage["role"], string> = {
  user: m.transcript_role_user(),
  assistant: "OpenClaw",
  system: m.transcript_role_system(),
};

// Stated as a CAP, not an assertion of omission: at exactly 200 messages nothing
// is actually dropped (`listByChat` does `.take(200)`), so claiming "older
// messages omitted" would be false in that boundary case. The cap wording is
// accurate whether or not older turns exist, and still warns the reader.
const TRUNCATION_NOTE = m.transcript_truncation_note();

/** UTC, stable across machines/timezones -> deterministic test output. */
function formatTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** The file attachments named on a message (file/media parts), in order. */
function attachmentNames(parts: ExportPart[] | undefined): string[] {
  if (!parts) return [];
  return parts
    .filter((p) => p.kind === "file" || p.kind === "media")
    .map((p) => p.filename)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

export function transcriptToMarkdown(
  messages: ExportMessage[],
  opts: ExportOpts = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${opts.title?.trim() || m.transcript_default_title()}`);
  if (opts.exportedAt != null) {
    lines.push("");
    lines.push(`_${m.transcript_exported_at({ date: formatTs(opts.exportedAt) })}_`);
  }
  if (opts.truncated) {
    lines.push("");
    lines.push(TRUNCATION_NOTE);
  }
  for (const msg of messages) {
    lines.push("");
    lines.push(`## ${ROLE_LABEL[msg.role]} · ${formatTs(msg.createdAt)}`);
    const text = msg.text.trim();
    if (text.length > 0) {
      lines.push("");
      lines.push(text);
    }
    for (const name of attachmentNames(msg.parts)) {
      lines.push("");
      lines.push(m.transcript_attachment({ name }));
    }
  }
  return lines.join("\n") + "\n";
}

export function transcriptToJson(
  messages: ExportMessage[],
  opts: ExportOpts = {},
): string {
  const doc = {
    title: opts.title?.trim() || m.transcript_default_title(),
    exportedAt: opts.exportedAt ?? null,
    truncated: Boolean(opts.truncated),
    messageCount: messages.length,
    messages: messages.map((m) => ({
      role: m.role,
      createdAt: m.createdAt,
      text: m.text,
      attachments: attachmentNames(m.parts),
    })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Safe, readable download filename stem from a chat title (no extension). */
export function exportFilename(title: string | null | undefined): string {
  const base = (title ?? "").trim() || "conversation";
  const slug = base
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "conversation";
}
