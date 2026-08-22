// Wiring the archive orchestration to this deployment's client.
//
// Everything the loop needs is injected (see lib/chatArchive), so this file is
// only the adapter: which function answers which step, and how the finished file
// leaves — or arrives in — the browser.

import { useConvex } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  MAX_ARCHIVE_BYTES,
  applyArchive,
  buildArchive,
  staleImports,
  type ExportSource,
  type ImportTarget,
  type TransferProgress,
} from "@/lib/chatArchive";

export interface TransferState {
  running: boolean;
  progress: TransferProgress | null;
}

/** A filename the browser and the operating system will both accept. */
function archiveFilename(label: string): string {
  const stem =
    label
      .normalize("NFKD")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "conversation";
  return `atrium-${stem}.zip`;
}

/** Hand the finished archive to the browser. */
function download(archive: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([archive as BlobPart], { type: "application/zip" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoked on the next tick: revoking synchronously can race the download in
  // some browsers, and an object url held for ever pins the whole archive in
  // memory.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function useArchiveTransfer() {
  const convex = useConvex();
  const [state, setState] = useState<TransferState>({
    running: false,
    progress: null,
  });
  // A second transfer while one runs would interleave two multi-call sequences
  // over the same import; the ref is what a state read cannot promise.
  const busy = useRef(false);

  const source = useCallback(
    (): ExportSource => ({
      manifest: () => convex.action(api.archiveExport.exportManifest, {}),
      chat: (chatId) =>
        convex.query(api.archiveExport.exportChat, {
          chatId: chatId as Id<"chats">,
        }),
      section: (chatId, section, cursor) =>
        convex.query(api.archiveExport.exportChatSection, {
          chatId: chatId as Id<"chats">,
          section: section as "messages",
          cursor,
        }),
      blob: async (url) => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`attachment could not be read (${response.status})`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    }),
    [convex],
  );

  const target = useCallback(
    (): ImportTarget => ({
      begin: (manifest, targetProjectId) =>
        convex.mutation(api.archiveImport.beginImport, {
          manifest,
          targetProjectId: (targetProjectId ?? null) as Id<"projects"> | null,
        }),
      batch: (importId, section, rows, blobs) =>
        convex.mutation(api.archiveImport.importBatch, {
          importId: importId as Id<"archiveImports">,
          section: section as "messages",
          rows,
          blobs: blobs.map((blob) => ({
            key: blob.key,
            storageId: blob.storageId as Id<"_storage">,
          })),
        }),
      finish: (importId) =>
        convex.mutation(api.archiveImport.finishImport, {
          importId: importId as Id<"archiveImports">,
        }),
      abandon: (importId) =>
        convex.mutation(api.archiveImport.abandonImport, {
          importId: importId as Id<"archiveImports">,
        }),
      upload: async (bytes) => {
        const url = await convex.mutation(api.chats.generateUploadUrl, {});
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Blob([bytes as BlobPart]),
        });
        const { storageId } = (await response.json()) as { storageId: string };
        await convex.mutation(api.uploads.registerUpload, {
          storageId: storageId as Id<"_storage">,
        });
        return storageId;
      },
      registerBlob: async (importId, storageId) => {
        await convex.mutation(api.archiveImport.registerImportBlob, {
          importId: importId as Id<"archiveImports">,
          storageId: storageId as Id<"_storage">,
        });
      },
      discardUpload: async (importId, storageId) => {
        await convex.mutation(api.archiveImport.discardUpload, {
          importId: importId as Id<"archiveImports">,
          storageId: storageId as Id<"_storage">,
        });
      },
    }),
    [convex],
  );

  const run = useCallback(
    async <T,>(work: (report: (p: TransferProgress) => void) => Promise<T>) => {
      if (busy.current) {
        throw new Error("a transfer is already running");
      }
      busy.current = true;
      setState({ running: true, progress: null });
      try {
        return await work((progress) => setState({ running: true, progress }));
      } finally {
        busy.current = false;
        setState({ running: false, progress: null });
      }
    },
    [],
  );

  const exportChats = useCallback(
    (chatIds: string[], label: string) =>
      run(async (report) => {
        const { archive, missingBlobs } = await buildArchive(
          source(),
          chatIds,
          report,
        );
        download(archive, archiveFilename(label));
        // Reported, not swallowed: the archive says so too, but the person who
        // asked for it is the one who can still do something about it.
        return { missingBlobs };
      }),
    [run, source],
  );

  const exportFolder = useCallback(
    (projectId: string, label: string) =>
      run(async (report) => {
        const tree = await convex.query(api.archiveExport.exportFolderTree, {
          projectId: projectId as Id<"projects">,
        });
        if (!tree.complete) {
          // REFUSED rather than shipped short: a subtree missing folders looks
          // whole to whoever opens it.
          throw new Error("folder_too_large");
        }
        const chatIds: string[] = [];
        for (const folder of tree.folders) {
          let cursor: string | null = null;
          do {
            const page: { chatIds: Id<"chats">[]; cursor: string | null } =
              await convex.query(api.archiveExport.exportFolderChats, {
                projectId: folder._id as Id<"projects">,
                cursor,
              });
            chatIds.push(...page.chatIds);
            cursor = page.cursor;
          } while (cursor !== null);
        }
        const { archive, missingBlobs } = await buildArchive(
          source(),
          chatIds,
          report,
        );
        download(archive, archiveFilename(label));
        return { missingBlobs, chatCount: chatIds.length };
      }),
    [convex, run, source],
  );

  const importArchive = useCallback(
    (file: File, targetProjectId: string | null) =>
      run(async (report) => {
        // CHECKED BEFORE READING. `arrayBuffer` pulls the whole file into the
        // tab, and `readZip` copies each entry out again — so a file past the
        // ceiling has already taken the memory by the time anything could
        // object.
        if (file.size > MAX_ARCHIVE_BYTES) {
          throw new Error("archive_too_large");
        }
        return applyArchive(
          target(),
          new Uint8Array(await file.arrayBuffer()),
          targetProjectId,
          report,
        );
      }),
    [run, target],
  );

  // A tab closed mid-import cannot run its own undo: its rows, its mappings and
  // its bytes sit behind an `applying` session nobody can name afterwards. The
  // sweep is what names them.
  //
  // ONLY THE STALE ONES. Another tab may be running an import right now, and it
  // writes on every batch — tearing that down would break a transfer that is
  // working, in a window this person cannot see.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const open = await convex.query(api.archiveImport.listOpenImports, {});
        for (const row of staleImports(open, Date.now())) {
          let done = false;
          for (let i = 0; i < 1000 && !done && !cancelled; i += 1) {
            done = (
              await convex.mutation(api.archiveImport.abandonImport, {
                importId: row.importId,
              })
            ).done;
          }
        }
      } catch {
        // Housekeeping. A failure here must never stop the app from loading.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convex]);

  return { state, exportChats, exportFolder, importArchive };
}
