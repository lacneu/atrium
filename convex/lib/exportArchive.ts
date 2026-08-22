// What an exported conversation contains — and, just as deliberately, what it
// does not.
//
// An export that is silent about its omissions reads as complete. Whoever opens
// one months later has no way to tell a conversation that carried no attachments
// from one whose attachments were dropped, so the manifest states the omissions
// as plainly as the contents.

/** Bumped when the archive's shape changes in a way a reader must notice. */
export const ARCHIVE_FORMAT_VERSION = 1;

/** Rows read per bounded page. Small enough that any single call stays well
 *  inside a Convex read, large enough that a long conversation does not take
 *  hundreds of round trips. */
export const EXPORT_PAGE_SIZE = 200;

/** Folders walked per bounded page while resolving a subtree. */
export const FOLDER_PAGE_SIZE = 100;

/**
 * Folders one subtree may contain.
 *
 * The per-parent bound alone does not bound the WALK: a tree where every folder
 * has ninety-nine children stays under it at each step while reading tens of
 * thousands of rows in one Convex transaction, which fails as a limit error
 * rather than as an answer. A budget turns that into a reported incompleteness.
 */
export const MAX_FOLDERS = 2_000;

/**
 * Keys that name bytes in THIS deployment's storage.
 *
 * They are removed wherever they appear, at any depth. A message part carries one
 * for every attachment, nested inside free-form JSON, so a strip that only looked
 * at top-level keys let the pointer travel even while the `files` section was
 * carefully removing its own.
 */
export const STORAGE_POINTER_KEYS: ReadonlyArray<string> = [
  "storageId",
  "sourceStorageId",
  "pdfStorageId",
];

/**
 * Keys that name a PERSON, at any depth.
 *
 * `subAgentReports.thread[].authorUserId` is the one that made this recursive: an
 * exchange with an administrator put their identifier in the archive while the
 * manifest claimed no owner identities travel.
 */
export const IDENTITY_KEYS: ReadonlyArray<string> = [
  "userId",
  "realUserId",
  "authorUserId",
];

/**
 * Message fields that are dispatch or session state rather than the exchange.
 *
 * `turnSessionKey` and `dispatchOutboxId` are the ones worth naming: they are
 * exactly the session and queue state the manifest promises to leave behind, and
 * a modern assistant reply carries both.
 */
export const MESSAGE_FIELDS_DROPPED: ReadonlyArray<string> = [
  "turnSessionKey",
  "dispatchOutboxId",
  "announceReplayArmed",
  "announceReplayRun",
  "autoRetry",
  "boundInstance",
];

/**
 * How deep a folder subtree may be walked.
 *
 * `projects.parentId` is a plain reference with nothing forbidding a cycle, so a
 * walk that trusted it would never terminate. The depth is bounded and a subtree
 * that exceeds it is REPORTED rather than silently truncated — a partial export
 * that looks whole is the failure this whole file guards against.
 */
export const MAX_FOLDER_DEPTH = 64;

/** The per-chat sections, in the order an archive lists them. */
export const CHAT_SECTIONS = [
  "messages",
  "messageParts",
  "files",
  "subAgents",
  "subAgentToolParts",
  "subAgentInteractions",
  "documentDrafts",
  "chatBookmarks",
  "documentAttachments",
] as const;

export type ChatSection = (typeof CHAT_SECTIONS)[number];

/**
 * What an archive deliberately leaves behind, with the reason. Copied into every
 * manifest so a reader is told, not left to infer.
 */
export const NOT_EXPORTED: ReadonlyArray<{ what: string; why: string }> = [
  {
    what: "live streaming buffers",
    why: "the in-flight text of a turn that had not finished; the finished message carries it",
  },
  {
    what: "dispatch queue and delivery records",
    why: "the state of sending, which means nothing once the exchange is over",
  },
  {
    what: "traces, audit log and access log",
    why: "operational records of this deployment, not of the conversation",
  },
  {
    what: "notifications and read markers",
    why: "per-reader state, which the importing reader has their own of",
  },
  {
    what: "feedback reports and the replies to them",
    why: "a report's thread carries administrator replies, which are read through a permission and an audit trail of their own; exporting a conversation must not be a way around them",
  },
  {
    what: "resumable provider session handles",
    why: "such a handle belongs to the gateway that issued it; replaying one elsewhere would present a key that gateway never handed out. Correlation keys that merely link rows to each other are kept — they are what holds the archive together",
  },
  {
    what: "identities of who owned the rows",
    why: "an import gives every row to the importing user, so carrying the original owner would only put a person's identifier in a file",
  },
];

/**
 * Fields dropped from an exported chat, and why. Named rather than silently
 * omitted, because two of them look harmless and are not.
 */
export const CHAT_FIELDS_DROPPED: ReadonlyArray<string> = [
  // Handed to the gateway on dispatch when the instance name matches. A restored
  // chat on a deployment whose instance happens to share that name — "primary" is
  // the default everywhere — would make the bridge present a session key the
  // gateway never issued.
  "recoverableSession",
  "openclawChatId",
  // THE SAME HANDLE UNDER ANOTHER NAME. On a per-turn routed conversation this
  // is what the bridge sends as `openclawChatId` (convex/bridge.ts, convex/talk.ts),
  // so dropping only the field literally called that left the gateway session in
  // the archive regardless.
  "routingSegment",
  "providerResetCount",
  // Per-owner and per-deployment; an import re-derives them.
  "userId",
  "sortKey",
  "sidebarHidden",
  // Queue and lifecycle state, meaningless once exported.
  "pendingFetch",
  "pendingSummarize",
  "pendingCurate",
  "pendingConvert",
  "forkPendingRehydration",
  "stoppedAt",
  "lastRoutedInstanceName",
  "lastRoutedAgentId",
];

/** A reference the archive could not keep, stated so a reader is not misled. */
export interface DroppedReference {
  /** Archive-local id of the row whose reference was dropped. */
  from: string;
  field: string;
  reason: "outside_export_scope";
}

/**
 * Strip a chat down to what may travel.
 *
 * Returns a NEW object rather than mutating: the row handed in is a live
 * database document, and an export must never be able to change what it reads.
 */
export function stripChatForExport(
  chat: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(chat)) {
    if (CHAT_FIELDS_DROPPED.includes(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Strip any other exported row.
 *
 * RECURSIVE, deliberately. Removing only top-level keys let two things through
 * that the manifest promises are absent: the storage pointer nested inside a
 * message part, and the author identifier nested inside a report's thread.
 *
 * `collect` is called with every storage pointer removed, so a caller that can
 * resolve one to bytes may put an archive key in its place.
 */
export function stripRowForExport(
  row: Record<string, unknown>,
  options: {
    drop?: ReadonlyArray<string>;
    collect?: (pointer: string) => void;
    /**
     * Keys whose value is the USER'S OWN data and is passed through untouched.
     *
     * A tool's `input`/`output` is free-form business content. Removing anything
     * inside it that merely SHARES A NAME with one of Atrium's structural keys —
     * a customer record with a `userId`, an external system's `storageId` —
     * would silently mangle what the conversation actually said. Nothing in
     * there is a pointer into this deployment, because an import resolves bytes
     * only through the archive's own blob map.
     */
    opaque?: ReadonlyArray<string>;
  } = {},
): Record<string, unknown> {
  const drop = options.drop ?? [];
  const opaque = options.opaque ?? [];
  const walk = (value: unknown, top: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, false));
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner === undefined) continue;
      if (IDENTITY_KEYS.includes(key)) continue;
      if (top && drop.includes(key)) continue;
      if (opaque.includes(key)) {
        out[key] = inner;
        continue;
      }
      if (STORAGE_POINTER_KEYS.includes(key)) {
        if (typeof inner === "string") options.collect?.(inner);
        continue;
      }
      out[key] = walk(inner, false);
    }
    return out;
  };
  return walk(row, true) as Record<string, unknown>;
}

/** Part keys whose contents are the user's own data, never Atrium structure. */
export const OPAQUE_PART_KEYS: ReadonlyArray<string> = ["input", "output"];

/**
 * Sub-agent fields that are gateway session state rather than the exchange.
 *
 * `sessionMeta` carries the provider's own session identifiers. `childSessionKey`
 * is deliberately NOT here: it is what links a sub-agent to its tool calls and
 * its interactions, so removing it would leave the archive holding rows that no
 * longer say what they belong to — and unlike a resumable handle, nothing ever
 * replays it against a gateway.
 */
export const SUBAGENT_FIELDS_DROPPED: ReadonlyArray<string> = ["sessionMeta"];
