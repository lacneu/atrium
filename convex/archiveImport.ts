// Reading an archive back into this deployment.
//
// The archive is a FILE. Nothing in it names a row here, nobody in it owns
// anything here, and no count in it may be believed. Three rules carry most of
// the safety, and each of them exists because the obvious alternative is wrong:
//
//   - the owner is taken from the caller's session, never from the archive;
//   - a storage pointer is never read from the archive, only from bytes this
//     user has themselves uploaded and had registered;
//   - every identifier the archive uses is re-minted, and the mapping recorded,
//     because an archive identifier means something ELSE here.
//
// An import spans several calls because an archive holds more rows than one
// transaction may write. That is why there is a session row: it lets batches
// agree, and it lets an import be abandoned instead of leaving a folder of
// conversations nobody can name.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { requireAgentMembership } from "./chats";
import { requireActive } from "./lib/access";
import {
  pickReconciledIdentity,
  readDeploymentOrigin,
} from "./lib/deploymentIdentity";
import {
  CHAT_FIELDS_DROPPED,
  CHAT_SECTIONS,
  MESSAGE_FIELDS_DROPPED,
  OPAQUE_PART_KEYS,
  STORAGE_POINTER_KEYS,
} from "./lib/exportArchive";
import {
  ArchiveRejected,
  MAX_ROWS_PER_BATCH,
  assertRowAcceptable,
  isArchiveId,
  sanitizeFilename,
  validateManifest,
} from "./lib/importArchive";
import { assertOwnsUpload } from "./uploads";

/** Identity rows read; mirrors the identity module's own bound. */
const MERGED_ROW_SCAN = 16;
/** Rows deleted per abandon pass. Bounded, and resumed by calling again. */
const ABANDON_BATCH = 100;

/** The sections an import accepts, and which of their fields name other rows.
 *
 *  TABLE-DRIVEN so a section cannot be added without saying what it references:
 *  a reference left unmapped would point at whatever that identifier happens to
 *  name HERE, which is the whole danger. */
const SECTION_REFS: Record<
  string,
  ReadonlyArray<{ field: string; kind: string; required: boolean }>
> = {
  chats: [{ field: "forkedFromChatId", kind: "chats", required: false }],
  messages: [
    { field: "chatId", kind: "chats", required: true },
    { field: "quotedMessageId", kind: "messages", required: false },
  ],
  messageParts: [{ field: "messageId", kind: "messages", required: true }],
  files: [
    { field: "chatId", kind: "chats", required: true },
    { field: "messageId", kind: "messages", required: true },
  ],
  subAgents: [
    { field: "chatId", kind: "chats", required: true },
    { field: "parentMessageId", kind: "messages", required: false },
  ],
  subAgentToolParts: [{ field: "chatId", kind: "chats", required: true }],
  subAgentInteractions: [{ field: "chatId", kind: "chats", required: true }],
  documentDrafts: [{ field: "chatId", kind: "chats", required: true }],
  chatBookmarks: [
    { field: "chatId", kind: "chats", required: true },
    { field: "messageId", kind: "messages", required: true },
  ],
  documentAttachments: [
    { field: "sourceMessageId", kind: "messages", required: true },
  ],
};

const sectionValidator = v.union(
  v.literal("chats"),
  ...CHAT_SECTIONS.map((name) => v.literal(name)),
);

/**
 * Mapping kind under which a detached chat's agent is remembered.
 *
 * NOT an identifier: it is the name of the agent that answered, kept so the
 * messages of that conversation can say so. In an ordinary single-agent
 * conversation the agent exists ONLY on the chat — the messages carry none — so
 * without this a foreign import loses the attribution of every message it holds.
 */
const CHAT_AGENT_LABEL = "chatAgentLabel";

/** What an archive identifier became here, or null when this import never saw it. */
async function mappedId(
  ctx: MutationCtx,
  importId: Id<"archiveImports">,
  kind: string,
  archiveId: string,
): Promise<string | null> {
  const row = await ctx.db
    .query("archiveImportIds")
    .withIndex("by_import_kind_archive", (q) =>
      q.eq("importId", importId).eq("kind", kind).eq("archiveId", archiveId),
    )
    .first();
  return row?.mappedId ?? null;
}

async function recordMapping(
  ctx: MutationCtx,
  importId: Id<"archiveImports">,
  kind: string,
  archiveId: string,
  newId: string,
): Promise<void> {
  await ctx.db.insert("archiveImportIds", {
    importId,
    kind,
    archiveId,
    mappedId: newId,
  });
}

/** Load an import this user owns and that is still open. */
async function openImport(
  ctx: MutationCtx,
  userId: Id<"users">,
  importId: Id<"archiveImports">,
): Promise<Doc<"archiveImports">> {
  const session = await ctx.db.get(importId);
  if (session === null || session.userId !== userId) {
    throw new Error("Not found: import does not exist");
  }
  if (session.status !== "applying") {
    throw new Error("Conflict: import is no longer open");
  }
  return session;
}

/**
 * Open an import.
 *
 * Everything the archive claims is checked HERE, before a single row is written:
 * a format this version cannot read is refused rather than half-understood, and
 * whether agents may be reattached is decided once so every batch applies the
 * same rule even if the deployment's identity were to change mid-import.
 */
export const beginImport = mutation({
  args: {
    manifest: v.any(),
    targetProjectId: v.optional(v.union(v.id("projects"), v.null())),
  },
  handler: async (ctx, { manifest, targetProjectId }) => {
    const { userId } = await requireActive(ctx);
    const { formatVersion, origin } = validateManifest(manifest);

    const target = targetProjectId ?? null;
    if (target !== null) {
      const folder = await ctx.db.get(target);
      if (folder === null || folder.userId !== userId) {
        // A folder identifier from the caller, checked like any other: an import
        // must not be a way to write into someone else's folder.
        throw new Error("Not found: folder does not exist");
      }
    }

    const identityRows = await ctx.db
      .query("deploymentIdentity")
      .take(MERGED_ROW_SCAN);
    const here = pickReconciledIdentity(identityRows, readDeploymentOrigin());
    // BOTH must be known and equal. An archive with no origin, or a deployment
    // that cannot vouch for its own identity, means "cannot tell" — and cannot
    // tell is foreign, which is the safe reading: foreign history is readable and
    // never reattached.
    const fromThisDeployment = here !== null && origin === here;

    const now = Date.now();
    return await ctx.db.insert("archiveImports", {
      userId,
      status: "applying",
      formatVersion,
      origin,
      fromThisDeployment,
      targetProjectId: target,
      startedAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Apply one bounded batch of one section.
 *
 * `blobs` maps an archive blob key to a storage id the CALLER uploaded. The id is
 * checked against this user's upload registry, so an archive cannot name bytes it
 * does not own — the archive's own storage pointers are refused outright.
 */
export const importBatch = mutation({
  args: {
    importId: v.id("archiveImports"),
    section: sectionValidator,
    rows: v.array(v.any()),
    blobs: v.optional(
      v.array(v.object({ key: v.string(), storageId: v.id("_storage") })),
    ),
  },
  handler: async (ctx, { importId, section, rows, blobs }) => {
    const { userId } = await requireActive(ctx);
    const session = await openImport(ctx, userId, importId);
    if (rows.length > MAX_ROWS_PER_BATCH) {
      throw new ArchiveRejected("batch_too_large");
    }
    // EVERY row is checked before ANY is written: a batch that failed halfway
    // would leave rows behind whose references the rest of the import expects.
    for (const row of rows) {
      assertRow(row);
    }

    const blobByKey = new Map<string, Id<"_storage">>();
    for (const blob of blobs ?? []) {
      await assertOwnsUploadLocal(ctx, userId, blob.storageId);
      blobByKey.set(blob.key, blob.storageId);
    }

    let written = 0;
    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const archiveId = row._id;
      if (!isArchiveId(archiveId)) {
        throw new ArchiveRejected("bad_archive_id");
      }
      // Already applied: a retried batch must not duplicate rows.
      if ((await mappedId(ctx, importId, section, archiveId)) !== null) {
        continue;
      }
      const prepared = await prepareRow(ctx, session, section, row, blobByKey);
      if (prepared === null) continue;
      const newId = await ctx.db.insert(section as "messages", prepared as never);
      await recordMapping(ctx, importId, section, archiveId, newId);
      written += 1;
    }
    await ctx.db.patch(importId, { updatedAt: Date.now() });
    return { written };
  },
});

/** Close an import. Nothing further may be applied to it. */
/**
 * Close an import, and clear the mapping it needed.
 *
 * The mapping exists only so batches can resolve each other's references; once
 * closed, nothing reads it. Left behind, every import would durably double the
 * rows it wrote. Purged in bounded passes — call again while `done` is false.
 */
export const finishImport = mutation({
  args: { importId: v.id("archiveImports") },
  handler: async (ctx, { importId }) => {
    const { userId } = await requireActive(ctx);
    const session = await ctx.db.get(importId);
    if (session === null || session.userId !== userId) {
      throw new Error("Not found: import does not exist");
    }
    if (session.status === "abandoned") {
      throw new Error("Conflict: import was abandoned");
    }
    // Closed on the FIRST call, so no further batch is accepted while the purge
    // is still running.
    if (session.status === "applying") {
      await ctx.db.patch(importId, { status: "done", updatedAt: Date.now() });
    }
    const mappings = await ctx.db
      .query("archiveImportIds")
      .withIndex("by_import", (q) => q.eq("importId", importId))
      .take(ABANDON_BATCH);
    for (const mapping of mappings) await ctx.db.delete(mapping._id);
    return { done: mappings.length < ABANDON_BATCH };
  },
});

/**
 * Undo an import, in bounded passes.
 *
 * An import that failed halfway must not leave a folder of conversations nobody
 * can name: the mapping table records exactly what this import created, so
 * removal is precise rather than a guess at what looks recent. Returns whether
 * more remains, so the caller keeps calling.
 */
export const abandonImport = mutation({
  args: { importId: v.id("archiveImports") },
  handler: async (ctx, { importId }) => {
    const { userId } = await requireActive(ctx);
    const session = await ctx.db.get(importId);
    if (session === null || session.userId !== userId) {
      throw new Error("Not found: import does not exist");
    }
    if (session.status === "done") {
      throw new Error("Conflict: a finished import is not undone this way");
    }
    const mappings = await ctx.db
      .query("archiveImportIds")
      .withIndex("by_import", (q) => q.eq("importId", importId))
      .take(ABANDON_BATCH);
    for (const mapping of mappings) {
      const doc = await ctx.db.get(mapping.mappedId as Id<"messages">);
      if (doc !== null) await ctx.db.delete(mapping.mappedId as Id<"messages">);
      await ctx.db.delete(mapping._id);
    }
    const done = mappings.length < ABANDON_BATCH;
    await ctx.db.patch(importId, {
      status: done ? "abandoned" : "applying",
      updatedAt: Date.now(),
    });
    return { done };
  },
});

// ── helpers ────────────────────────────────────────────────────────────────

/** Sections whose table declares an owner. Assigning one to a table that does
 *  not declare it is rejected by the schema — which is every part, tool and
 *  interaction row, i.e. most of a real conversation. */
const USER_SCOPED_SECTIONS: ReadonlyArray<string> = [
  "chats",
  "messages",
  "files",
  "subAgents",
  "documentDrafts",
  "chatBookmarks",
  "documentAttachments",
];

/**
 * States that only make sense while something is LIVE, and what they become.
 *
 * Nothing resumes them after an import: the streaming rows, the dispatch queue
 * and the delivery records are all deliberately absent from an archive. Left as
 * they were, a running sub-agent makes the imported conversation look busy and
 * blocks new sends until a reaper notices.
 */
const TERMINALISE: Record<string, Record<string, string>> = {
  messages: { streaming: "aborted" },
  subAgents: { running: "aborted" },
  subAgentToolParts: { running: "error" },
  subAgentInteractions: { pending: "error" },
  documentAttachments: { pending: "not_found" },
};

/**
 * A session key an imported sub-agent may keep.
 *
 * The export keeps `childSessionKey` because it is what links a sub-agent to its
 * tool calls and its interactions. But it is ALSO what "Interact" sends to the
 * gateway — so importing it unchanged, from an archive of this very deployment,
 * would let the copy drive the ORIGINAL conversation's sub-agent. Re-minting
 * keeps the joins and makes the key match nothing on any gateway.
 */
const importedSessionKey = (
  importId: Id<"archiveImports">,
  archiveKey: string,
): string => `imported:${importId}:${archiveKey}`.slice(0, 200);

/** Refuse a row the archive should never have contained. */
function assertRow(row: unknown): void {
  assertRowAcceptable(row, STORAGE_POINTER_KEYS, OPAQUE_PART_KEYS);
}

/** The existing IDOR gate, reused rather than reinvented: a storage id is only
 *  usable by the user who uploaded it and had it registered. */
async function assertOwnsUploadLocal(
  ctx: MutationCtx,
  userId: Id<"users">,
  storageId: Id<"_storage">,
): Promise<void> {
  await assertOwnsUpload(ctx, userId, storageId);
}

/**
 * Whether this deployment's own agent may be reattached to imported history.
 *
 * TWO gates, and they answer different questions. The origin says whether these
 * identifiers mean anything here at all; membership says whether this particular
 * user may use that agent. An archive can claim the first — it is a value in a
 * file — so it can never be allowed to decide the second.
 */
async function mayReattach(
  ctx: MutationCtx,
  session: Doc<"archiveImports">,
  userId: Id<"users">,
  instanceName: unknown,
  agentId: unknown,
): Promise<boolean> {
  if (!session.fromThisDeployment) return false;
  if (typeof instanceName !== "string" || typeof agentId !== "string") {
    return false;
  }
  try {
    await requireAgentMembership(ctx, userId, instanceName, agentId);
    return true;
  } catch {
    // Not entitled — or the agent no longer exists. Either way the history is
    // imported unattached rather than bound to something this user may not use.
    return false;
  }
}

/**
 * One archive row, turned into something this deployment can store.
 *
 * Returns null when the row cannot stand: a reference it needs was never
 * imported, or bytes it needs were not supplied. Skipping beats writing a row
 * that points at nothing.
 */
async function prepareRow(
  ctx: MutationCtx,
  session: Doc<"archiveImports">,
  section: string,
  row: Record<string, unknown>,
  blobByKey: Map<string, Id<"_storage">>,
): Promise<Record<string, unknown> | null> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    // The archive's own identifiers and timestamps are ITS deployment's, and
    // Convex mints both. Carrying them would be writing another database's keys.
    if (key === "_id" || key === "_creationTime") continue;
    if (key === "archiveBlobKey" || key === "archiveBlobKeys") continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  // THE OWNER IS THE CALLER — where the table has an owner at all. Never the
  // archive: it is a value in a file, and honouring it would let anyone hand
  // someone else's history to a third party, or claim a row as theirs.
  if (USER_SCOPED_SECTIONS.includes(section)) out.userId = session.userId;
  else delete out.userId;

  for (const ref of SECTION_REFS[section] ?? []) {
    const archiveRef = row[ref.field];
    if (archiveRef === undefined || archiveRef === null) {
      delete out[ref.field];
      if (ref.required) return null;
      continue;
    }
    if (!isArchiveId(archiveRef)) throw new ArchiveRejected("bad_archive_id");
    const mapped = await mappedId(ctx, session._id, ref.kind, archiveRef);
    if (mapped === null) {
      // A reference to something outside this archive, or to a row that was
      // refused. Required means the row cannot stand; optional means it stands
      // WITHOUT the link rather than with a link to whatever that identifier
      // happens to name here.
      if (ref.required) return null;
      delete out[ref.field];
      continue;
    }
    out[ref.field] = mapped;
  }

  if (section === "chats") {
    // Placement is the IMPORTER'S choice, never the archive's: its projectId
    // names a folder in another database.
    if (session.targetProjectId === null) delete out.projectId;
    else out.projectId = session.targetProjectId;
    const keep = await mayReattach(
      ctx,
      session,
      session.userId,
      row.instanceName,
      row.agentId,
    );
    if (!keep) {
      if (typeof row.agentId === "string" && isArchiveId(row._id)) {
        // Remembered against the CHAT's archive identifier, so the messages
        // imported afterwards can find it.
        await recordMapping(
          ctx,
          session._id,
          CHAT_AGENT_LABEL,
          row._id,
          row.agentId.slice(0, 200),
        );
      }
      delete out.instanceName;
      delete out.agentId;
    }
    // Session state cannot be here — the export removes it — but an archive is a
    // file, so the fields are dropped again rather than trusted to be absent.
    // THE SAME LIST THE EXPORT APPLIES, applied again. The export removes these,
    // but an archive is a file: trusting their absence means a hand-edited one
    // decides. A future `stoppedAt` alone would have this deployment refuse the
    // conversation's sub-agent deliveries.
    for (const field of CHAT_FIELDS_DROPPED) {
      // `userId` is on that list because it must not TRAVEL. Here it is the one
      // field the import must set — the owner is the caller — so the shared list
      // is applied around it rather than over it.
      if (field === "userId") continue;
      delete out[field];
    }
    // A chat with a `kind` is a HIDDEN utility conversation — the listings, the
    // search and the folder views all exclude it. Importing one would create a
    // conversation nobody can see, and one this deployment might then reuse as
    // its own documentary or summarizer chat. An import restores conversations.
    delete out.kind;
    if (typeof out.updatedAt !== "number") out.updatedAt = Date.now();
  }

  // The join that holds sub-agent rows together, re-minted so it cannot be routed.
  if (typeof row.childSessionKey === "string") {
    out.childSessionKey = importedSessionKey(session._id, row.childSessionKey);
  }

  // A state that was LIVE when the archive was written. Nothing resumes it here.
  const terminal = TERMINALISE[section];
  if (terminal !== undefined && typeof out.status === "string") {
    const replacement = terminal[out.status];
    if (replacement !== undefined) out.status = replacement;
  }

  if (section === "messages") {
    const keep = await mayReattach(
      ctx,
      session,
      session.userId,
      row.routedInstanceName,
      row.routedAgentId,
    );
    if (!keep) {
      // AN INERT LABEL, not a dropped field. Absence of `routedAgentId` already
      // MEANS "inherit the turn's agent, else the chat's", so leaving an imported
      // message unrouted would attribute it to whichever agent the reader later
      // binds — the archive would appear to say something it does not.
      const routed =
        typeof row.routedAgentId === "string"
          ? row.routedAgentId.slice(0, 200)
          : null;
      // A per-turn routed message names its own agent. An ordinary one does not —
      // the agent lives on the conversation — so the chat's own is used, or the
      // attribution of every message in a single-agent conversation is lost.
      const fromChat =
        routed !== null || !isArchiveId(row.chatId)
          ? null
          : await mappedId(ctx, session._id, CHAT_AGENT_LABEL, row.chatId);
      const label = routed ?? fromChat;
      if (label !== null) out.importedAgentLabel = label;
      delete out.routedAgentId;
      delete out.routedInstanceName;
    }
    for (const field of MESSAGE_FIELDS_DROPPED) delete out[field];
    // ORDER IS REBASED. `orderTime` is the source deployment's clock and ordering
    // falls back to it before the creation time Convex mints here, so a message
    // that had been queued there would sort ahead of everything imported after
    // it — reordering any conversation that used mid-turn sending.
    delete out.orderTime;
    if (typeof out.updatedAt !== "number") out.updatedAt = Date.now();
  }

  if (section === "messageParts") {
    // The export removed the pointer NESTED in the part and recorded the archive
    // key instead. Dropping that key without putting the new bytes back left a
    // media part with no storage at all — which the schema refuses, so every
    // batch carrying an attachment failed.
    const keys = row.archiveBlobKeys;
    const key = Array.isArray(keys) && typeof keys[0] === "string" ? keys[0] : null;
    const storageId = key === null ? undefined : blobByKey.get(key);
    const part = out.part as Record<string, unknown> | undefined;
    const needsBytes =
      part !== undefined &&
      (part.kind === "media" || part.kind === "file");
    if (storageId !== undefined && part !== undefined) {
      out.part = { ...part, storageId };
    } else if (needsBytes) {
      // A part of this kind cannot exist without its bytes — the export says so
      // itself when it could not resolve them. Skipping it beats failing the
      // whole batch on a row the schema will refuse anyway.
      return null;
    }
  }

  if (section === "files" || section === "documentAttachments") {
    const key = row.archiveBlobKey;
    const storageId = typeof key === "string" ? blobByKey.get(key) : undefined;
    if (storageId === undefined) {
      // `files` cannot exist without its bytes; an attachment can (pending or
      // failed ones legitimately carry none).
      if (section === "files") return null;
    } else {
      out.storageId = storageId;
    }
    if (section === "documentAttachments" && storageId === undefined) {
      // `ready` promises a file. Without bytes the reader is offered a download
      // that resolves to nothing, while the message's own count still announces
      // it — so the row says plainly that the file is not here.
      out.status = "not_found";
    }
    out.filename = sanitizeFilename(row.filename);
  }

  return out;
}
