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
import { mutation, query } from "./_generated/server";
import { requireAgentMembership } from "./chats";
import { requireActive } from "./lib/access";
import { QUEUED_ORDER_SENTINEL } from "./lib/messageOrder";
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
/** Open imports listed at once. A user has one in flight, not a hundred. */
const OPEN_IMPORTS_SCAN = 50;

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

/** Mapping kind under which the bytes this import uploaded are recorded, so they
 *  can be discarded without letting a caller name any blob they like. */
const IMPORT_BLOB = "blob";

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
    // WHICH rows, not just how many. A row can be skipped for want of a
    // reference, and the caller decides from this whether the bytes it uploaded
    // for that row are still needed.
    const writtenIds: string[] = [];
    let orderCursor = session.orderCursor ?? 0;
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
      const prepared = await prepareRow(
        ctx,
        session,
        section,
        row,
        blobByKey,
        session.startedAt + orderCursor,
      );
      if (prepared === null) continue;
      // Advanced only for a row that is WRITTEN, so the sequence has no holes
      // and stays the same on a retried batch.
      if (section === "messages") orderCursor += 1;
      const newId = await ctx.db.insert(section as "messages", prepared as never);
      await recordMapping(ctx, importId, section, archiveId, newId);
      writtenIds.push(archiveId);
      written += 1;
    }
    await ctx.db.patch(importId, { updatedAt: Date.now(), orderCursor });
    return { written, writtenIds };
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
/**
 * The imports this user left open.
 *
 * Without it an interrupted import is UNREACHABLE: a closed tab leaves a session
 * nobody can name, so it can never be finished nor undone, and its rows and its
 * bytes stay for ever. The index exists for exactly this; nothing was asking it.
 */
export const listOpenImports = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    const rows = await ctx.db
      .query("archiveImports")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "applying"),
      )
      .take(OPEN_IMPORTS_SCAN);
    return rows.map((row) => ({
      importId: row._id,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      targetProjectId: row.targetProjectId,
    }));
  },
});

/**
 * Record that this import uploaded these bytes.
 *
 * It is what lets them be discarded later without a caller being able to name
 * any storage id they like.
 */
export const registerImportBlob = mutation({
  args: { importId: v.id("archiveImports"), storageId: v.id("_storage") },
  handler: async (ctx, { importId, storageId }) => {
    const { userId } = await requireActive(ctx);
    await openImport(ctx, userId, importId);
    await assertOwnsUploadLocal(ctx, userId, storageId);
    const already = await ctx.db
      .query("archiveImportIds")
      .withIndex("by_import_kind_archive", (q) =>
        q
          .eq("importId", importId)
          .eq("kind", IMPORT_BLOB)
          .eq("archiveId", storageId),
      )
      .first();
    if (already === null) {
      await recordMapping(ctx, importId, IMPORT_BLOB, storageId, storageId);
    }
    // A HEARTBEAT, written where the work happens. Every blob is uploaded before
    // the first batch, so a large archive can spend a long time here — and
    // another tab, seeing a session untouched since it began, would take it for
    // one a closed tab left behind and undo it mid-transfer.
    await ctx.db.patch(importId, { updatedAt: Date.now() });
  },
});

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
 * Remove bytes an import uploaded but never used.
 *
 * The undo above removes the ROWS this import wrote; it never learned about a
 * blob whose batch failed before running. Without this they stay for ever, and a
 * repeated bad import becomes a way to fill the storage.
 *
 * Refuses a blob that is IN USE: a key can only be discarded while nothing
 * points at it, or an import could delete an attachment of an existing
 * conversation by naming its storage id.
 */
export const discardUpload = mutation({
  args: { importId: v.id("archiveImports"), storageId: v.id("_storage") },
  handler: async (ctx, { importId, storageId }) => {
    const { userId } = await requireActive(ctx);
    const session = await ctx.db.get(importId);
    if (session === null || session.userId !== userId) {
      return { discarded: false };
    }
    // ONLY bytes THIS import uploaded. Without the import to scope it, a caller
    // could name any storage id of their own — including an attachment of a
    // conversation they still have — and have the bytes deleted underneath it.
    const registered = await ctx.db
      .query("archiveImportIds")
      .withIndex("by_import_kind_archive", (q) =>
        q.eq("importId", importId).eq("kind", IMPORT_BLOB).eq("archiveId", storageId),
      )
      .first();
    if (registered === null) return { discarded: false };
    const owned = await ctx.db
      .query("uploads")
      .withIndex("by_user_storage", (q) =>
        q.eq("userId", userId).eq("storageId", storageId),
      )
      .unique();
    if (owned === null) return { discarded: false };
    const discarded = await discardImportBlob(ctx, userId, storageId);
    if (discarded) await ctx.db.delete(registered._id);
    return { discarded };
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
    // PHASE ONE: the rows. Paged with a CURSOR rather than judged from one page —
    // a hundred attachments are registered before any row is written, so the
    // first page can be nothing but blobs, and "no rows here" would be false.
    // A blob the import's own file row still references cannot be discarded, and
    // dropping its mapping anyway left nothing able to name those bytes
    // afterwards: the same leak, arrived at from the other side.
    if (session.rowsCleared !== true) {
      const page = await ctx.db
        .query("archiveImportIds")
        .withIndex("by_import", (q) => q.eq("importId", importId))
        .paginate({
          numItems: ABANDON_BATCH,
          cursor: session.abandonCursor ?? null,
        });
      for (const mapping of page.page) {
        if (mapping.kind === IMPORT_BLOB) continue;
        const doc = await ctx.db.get(mapping.mappedId as Id<"messages">);
        if (doc !== null) {
          await ctx.db.delete(mapping.mappedId as Id<"messages">);
        }
        await ctx.db.delete(mapping._id);
      }
      await ctx.db.patch(importId, {
        status: "applying",
        updatedAt: Date.now(),
        abandonCursor: page.isDone ? null : page.continueCursor,
        ...(page.isDone ? { rowsCleared: true } : {}),
      });
      return { done: false };
    }

    const mappings = await ctx.db
      .query("archiveImportIds")
      .withIndex("by_import", (q) => q.eq("importId", importId))
      .take(ABANDON_BATCH);
    // A refusal in phase two means the bytes are referenced by something that is
    // NOT this import — not an orphan, and the mapping has done its job either
    // way.
    for (const mapping of mappings) {
      if (mapping.kind === IMPORT_BLOB) {
        await discardImportBlob(
          ctx,
          session.userId,
          mapping.mappedId as Id<"_storage">,
        );
      } else {
        const doc = await ctx.db.get(mapping.mappedId as Id<"messages">);
        if (doc !== null) {
          await ctx.db.delete(mapping.mappedId as Id<"messages">);
        }
      }
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

/**
 * Remove bytes an import uploaded, unless a row still names them.
 *
 * BOTH tables are checked: an attachment can point at storage with no `files`
 * row beside it, so checking only that one deletes bytes a row still names.
 */
async function discardImportBlob(
  ctx: MutationCtx,
  userId: Id<"users">,
  // Written by `registerImportBlob` from a validated `v.id("_storage")`, so the
  // mapping's value is one — it never comes from the archive.
  id: Id<"_storage">,
): Promise<boolean> {
  const owned = await ctx.db
    .query("uploads")
    .withIndex("by_user_storage", (q) =>
      q.eq("userId", userId).eq("storageId", id),
    )
    .unique();
  if (owned === null) return false;
  const usedByFile = await ctx.db
    .query("files")
    .withIndex("by_storage", (q) => q.eq("storageId", id))
    .first();
  const usedByAttachment = await ctx.db
    .query("documentAttachments")
    .withIndex("by_storage", (q) => q.eq("storageId", id))
    .first();
  if (usedByFile !== null || usedByAttachment !== null) return false;
  await ctx.storage.delete(id);
  await ctx.db.delete(owned._id);
  return true;
}

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
  /** This message's position in the import's own sequence. */
  orderAt: number,
): Promise<Record<string, unknown> | null> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    // The archive's own identifiers and timestamps are ITS deployment's, and
    // Convex mints both. Carrying them would be writing another database's keys.
    if (key === "_id" || key === "_creationTime") continue;
    if (key === "archiveBlobKey" || key === "archiveBlobKeys") continue;
    // COMPUTED HERE, never taken from the archive. It is what the interface shows
    // in place of an agent name, so an archive that supplied its own would choose
    // that text — unbounded, and attached to history it did not answer.
    if (key === "importedAgentLabel") continue;
    if (key === "archiveOrder") continue;
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
      // Kept ON THE CONVERSATION, not copied onto its messages. A message's own
      // label is the agent that answered THAT turn; a conversation-wide fallback
      // written per message would override the real routed agent of every turn
      // in a multi-agent conversation.
      if (typeof row.agentId === "string") {
        out.importedAgentLabel = row.agentId.slice(0, 200);
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
    // Stamped so a copy is never mistaken for its original — which is exactly
    // what a same-deployment import produces: same title, same content, same
    // agent, and nothing else to tell them apart.
    out.importedAt = session.startedAt;
    out.importedFromOrigin = session.origin;
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
      // ONLY this message's own routed agent. Where it has none, the reader
      // falls back to the conversation's imported label — the same chain the
      // live attribution uses — instead of this message claiming an agent that
      // answered a different turn.
      if (typeof row.routedAgentId === "string") {
        out.importedAgentLabel = row.routedAgentId.slice(0, 200);
      }
      delete out.routedAgentId;
      delete out.routedInstanceName;
    }
    for (const field of MESSAGE_FIELDS_DROPPED) delete out[field];
    // THE SOURCE'S OWN DISPLAY ORDER, carried rather than reconstructed.
    //
    // Deleting it left the conversation on TWO clocks — a message that had
    // carried one fell back to the creation time minted here while its
    // neighbours did not — so an answer could be shown before the question it
    // answers. Re-basing on arrival order fixed that but could not fix an
    // inversion that crossed a page boundary at the source, and would have made
    // it permanent. The value the source sorts by needs no page to be complete.
    //
    // Every imported message carries one, so no two clocks ever meet. A hand
    // edited archive that omits it falls back to the import's own sequence.
    // RANK PRESERVED, CLOCK REBASED.
    //
    // The archive carries the order the SOURCE displays — which is what sorting
    // a page could not reconstruct — but carries it as the source's timestamps.
    // Copied verbatim, an archive from a machine whose clock runs ahead sorts its
    // whole history after messages written here afterwards, and a follow-up still
    // parked at the source carries the value meaning "after everything", which
    // would sit last for all time.
    //
    // So the carried order is used as a RANK — the rows arrive in it — and the
    // position comes from this import's own sequence. Nothing imported lands in
    // the future, and no imported conversation is ever on two clocks.
    out.orderTime = orderAt;
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
      // The filename here is the one the conversation RENDERS and a download
      // uses — the same reason the other sections sanitise theirs. Leaving this
      // one raw applied the guard everywhere except where it is read.
      out.part = {
        ...part,
        storageId,
        ...(part.filename === undefined
          ? {}
          : { filename: sanitizeFilename(part.filename) }),
      };
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
