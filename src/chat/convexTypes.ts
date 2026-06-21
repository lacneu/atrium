// Shared client-side types mirroring the Convex schema documents that the
// chat UI consumes. These intentionally describe ONLY the fields the browser
// is allowed to see. Server filesystem paths, gateway tokens, device
// identities and Convex service keys live in the bridge env and MUST NEVER be
// part of any document shipped to the browser (security invariant).
//
// The shapes here match the Convex `messages` / `messageParts` schema:
//
//   messages(chatId, userId, role, runId?, status, text, error?, updatedAt)
//   messageParts(messageId, order, part = union{
//       {kind:"tool", name, phase, input?, output?}
//     | {kind:"media", storageId, filename, mimeType}
//     | {kind:"file",  storageId, filename, mimeType}
//     | {kind:"reasoning", text}
//   })
//
// The Convex query `api.messages.listByChat` is expected to return each message
// already joined with its ordered parts AND with resolved storage URLs for
// media/file parts (ctx.storage.getUrl on the server), because the browser
// cannot turn a storageId into a URL on its own and must never receive raw
// storage internals. See `ConvexMessagePartView` below for the resolved shape.

export type ConvexId<TableName extends string> = string & {
  readonly __tableName?: TableName;
};

export type MessageRole = "user" | "assistant" | "system";

export type MessageStatus = "streaming" | "complete" | "error" | "aborted";

export type ToolPhase = "started" | "running" | "completed" | "error";

/**
 * A message part as the *client* sees it.
 *
 * Note the difference from the stored schema: media/file parts carry a resolved
 * `url` (produced server-side via ctx.storage.getUrl) instead of the raw
 * `storageId`. `storageId` is kept only as an opaque key for React list keys /
 * dedupe; it is never a filesystem path.
 */
export type ConvexMessagePartView =
  | {
      kind: "tool";
      name: string;
      phase: ToolPhase | string;
      input?: unknown;
      output?: unknown;
    }
  | {
      kind: "media";
      storageId: string;
      filename: string;
      mimeType: string;
      /** Resolved download URL (server-side ctx.storage.getUrl). */
      url: string | null;
    }
  | {
      kind: "file";
      storageId: string;
      filename: string;
      mimeType: string;
      url: string | null;
    }
  | {
      kind: "reasoning";
      text: string;
    }
  | ProvenancePartView;

/**
 * Provenance report (provenance/v1 — docs/PROVENANCE_CONTRACT.md): what a
 * gateway context-injecting plugin fed the LLM for this turn. `pluginId` is
 * gateway-stamped (authenticated emitter). Rendered by SourcesActivity.
 *
 * The REACTIVE stream (listByChat) carries the COMPACT projection: item texts
 * stripped, `hasExcerpts` set when the on-demand detail query
 * (messages.getProvenanceParts) has more. The detail query returns the same
 * shape WITH texts.
 */
export interface ProvenancePartView {
  kind: "provenance";
  v: number;
  pluginId: string;
  source: string;
  group: "memory" | "documents";
  hasExcerpts?: boolean;
  injected?: { chars?: number; position?: string; truncated?: boolean };
  retrieval?: {
    route?: string;
    bank?: string;
    collections?: string[];
    lightragMode?: string;
  };
  items: ProvenanceItemView[];
}

export interface ProvenanceItemView {
  id?: string;
  type?: string;
  date?: string;
  score?: number;
  text?: string;
  file_name?: string;
  collection?: string;
}

/**
 * A chat message as returned by `api.messages.listByChat`.
 *
 * IMPORTANT: `listByChat` returns parts as a FLAT, already-ordered array of
 * `ConvexMessagePartView` (server-side it resolves storage URLs and sorts by
 * `order`, then drops the row wrapper). The client therefore iterates
 * `message.parts` directly — there is no `{ part, order }` row nesting.
 */
export interface ConvexMessageView {
  _id: ConvexId<"messages">;
  chatId: ConvexId<"chats">;
  _creationTime: number;
  role: MessageRole;
  runId?: string;
  status: MessageStatus;
  text: string;
  error?: string;
  /** L2: count of ready downloadable document attachments (Sources-chip badge). */
  attachedDocCount?: number;
  updatedAt: number;
  parts: ConvexMessagePartView[];
}

export function isToolPart(
  p: ConvexMessagePartView,
): p is Extract<ConvexMessagePartView, { kind: "tool" }> {
  return p.kind === "tool";
}

export function isMediaPart(
  p: ConvexMessagePartView,
): p is Extract<ConvexMessagePartView, { kind: "media" }> {
  return p.kind === "media";
}

export function isFilePart(
  p: ConvexMessagePartView,
): p is Extract<ConvexMessagePartView, { kind: "file" }> {
  return p.kind === "file";
}

export function isReasoningPart(
  p: ConvexMessagePartView,
): p is Extract<ConvexMessagePartView, { kind: "reasoning" }> {
  return p.kind === "reasoning";
}
