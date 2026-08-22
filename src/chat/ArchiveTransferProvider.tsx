// The archive transfer, shared by everything that can start one.
//
// A CONTEXT rather than props: the two places that offer an export sit deep in
// the sidebar tree, and a transfer is a single-at-a-time affair — two of them
// interleaving multi-call sequences over one import is precisely what must not
// happen, so there is one instance and everyone reads it.

import { createContext, useContext, type ReactNode } from "react";
import * as m from "@/paraglide/messages.js";
import { useToast } from "@/components/ui/toast";
import {
  useArchiveTransfer,
  type TransferState,
} from "./useArchiveTransfer";

interface ArchiveActions {
  state: TransferState;
  exportChat: (chatId: string, title: string) => void;
  exportFolder: (projectId: string, name: string) => void;
  importArchive: (file: File, targetProjectId: string | null) => void;
  /** Ask for a file and import it. Kept here so a menu deep in the tree does not
   *  have to carry an input element down with it. */
  pickAndImport: (targetProjectId: string | null) => void;
}

const ArchiveContext = createContext<ArchiveActions | null>(null);

export function ArchiveTransferProvider({ children }: { children: ReactNode }) {
  const transfer = useArchiveTransfer();
  const toast = useToast();

  const report = (error: unknown, fallback: string): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("folder_too_large")) {
      toast.error(m.archive_folder_too_large());
      return;
    }
    if (message.includes("already running")) {
      toast.error(m.archive_busy());
      return;
    }
    if (message.includes("archive_too_large")) {
      toast.error(m.archive_too_large());
      return;
    }
    if (message.includes("not_a_zip") || message.includes("no manifest")) {
      toast.error(m.archive_not_a_zip());
      return;
    }
    toast.error(fallback, error);
  };

  const value: Omit<ArchiveActions, "pickAndImport"> = {
    state: transfer.state,
    exportChat: (chatId, title) => {
      void transfer
        .exportChats([chatId], title)
        .then(({ missingBlobs }) => {
          // The archive says so too, but the person who asked for it is the one
          // who can still do something about it.
          if (missingBlobs.length > 0) {
            toast.error(
              m.archive_export_incomplete({ count: missingBlobs.length }),
            );
          } else {
            toast.success(m.archive_export_done());
          }
        })
        .catch((error: unknown) => report(error, m.archive_export_failed()));
    },
    exportFolder: (projectId, name) => {
      void transfer
        .exportFolder(projectId, name)
        .then(({ missingBlobs }) => {
          if (missingBlobs.length > 0) {
            toast.error(
              m.archive_export_incomplete({ count: missingBlobs.length }),
            );
          } else {
            toast.success(m.archive_export_done());
          }
        })
        .catch((error: unknown) => report(error, m.archive_export_failed()));
    },
    importArchive: (file, targetProjectId) => {
      void transfer
        .importArchive(file, targetProjectId)
        .then(({ written, purged }) => {
          toast.success(
            m.archive_import_done({ count: written }),
            purged ? undefined : m.archive_import_unpurged(),
          );
        })
        // The orchestration undoes a failed import before it throws, so this
        // really is "nothing was kept" rather than a hopeful phrase.
        .catch((error: unknown) => report(error, m.archive_import_failed()));
    },
  };

  const withPicker: ArchiveActions = {
    ...value,
    pickAndImport: (targetProjectId) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".zip,application/zip";
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (file !== undefined) value.importArchive(file, targetProjectId);
      });
      input.click();
    },
  };

  return (
    <ArchiveContext.Provider value={withPicker}>
      {children}
    </ArchiveContext.Provider>
  );
}

/** Null outside the provider, so a component can offer the action only where it
 *  is actually wired rather than crash. */
export function useArchiveActions(): ArchiveActions | null {
  return useContext(ArchiveContext);
}

/** What the transfer is doing, in words. Null when nothing is running. */
export function transferLabel(state: TransferState): string | null {
  if (!state.running) return null;
  const progress = state.progress;
  if (progress === null) return m.archive_working_packing();
  switch (progress.phase) {
    case "sections":
      return m.archive_working_sections({ count: progress.done });
    case "blobs":
      return m.archive_working_blobs({ count: progress.done });
    case "packing":
      return m.archive_working_packing();
    case "reading":
      return m.archive_working_reading({ count: progress.done });
    case "uploading":
      return m.archive_working_uploading({
        done: progress.done,
        total: progress.total ?? progress.done,
      });
    case "writing":
      return m.archive_working_writing({ count: progress.done });
  }
}
