import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { Download, ExternalLink, FileText, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentMarkdown } from "./MarkdownText";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { PdfViewer } from "./PdfViewer";
import { PromptBridgeContext, buildInlineDocBlock } from "./promptBridge";
import { LARGE_PASTE_CHARS } from "./pasteRouting";
import { useToast } from "@/components/ui/toast";
import {
  isConvertibleDocument,
  CSV_PREVIEW_MAX_COLS,
  JSON_TREE_MAX_CHILDREN,
  JSON_TREE_OPEN_MAX_ENTRIES,
  LOG_PREVIEW_MAX_LINES,
  TEXT_PREVIEW_MAX_BYTES,
  classifyLogLine,
  compareCsvCells,
  forcedCsvDelimiter,
  parseCsvPreview,
  viewerKindFor,
} from "./documentViewerView";

// The Document Viewer: a third occupant of the chat's shared right column
// (beside Sources and the sub-agent monitor) that renders a conversation file
// IN PLACE — the conversation stays live on the left, exactly the split-view
// ChatGPT ships for documents. Release A renders what the browser can do
// faithfully by itself (PDF via pdf.js, images, media, text); office formats
// show an honest no-preview state — Release B feeds them through the
// instance-designated converter AGENT (gateway skills → PDF), never through
// conversion infra embedded in Atrium (community-software rule). The panel is
// provider-agnostic: it takes the file part's resolved Convex storage URL,
// whether the file came from the user, an OpenClaw agent or a Hermes agent.

export type ViewerDoc = {
  url: string;
  filename: string;
  mimeType: string | null;
  // STABLE identity of the displayed version (signed URLs rotate): the
  // version-tracking comparison and the draft's source anchor key on it.
  // Absent on legacy openers → URL comparison fallback.
  storageId?: string;
  // Set ONLY for a convertible Office file: its source storage id, which keys the
  // on-demand PDF rendition (the instance converter agent produces it). Absent for
  // natively-viewable files (PDF/image/text/media).
  sourceStorageId?: string;
};

export interface DocumentViewerApi {
  activeDoc: ViewerDoc | null;
  openFor: (doc: ViewerDoc) => void;
  close: () => void;
}

export const DocumentViewerContext = createContext<DocumentViewerApi>({
  activeDoc: null,
  openFor: () => {},
  close: () => {},
});

export function useDocumentViewer(): DocumentViewerApi {
  return useContext(DocumentViewerContext);
}

export function DocumentViewerContent({
  doc,
  chatId,
  onClose,
}: {
  doc: ViewerDoc;
  /** The chat this document belongs to — keys the edit draft + the version
   *  tracking. Null on legacy call sites (edit affordances hidden). */
  chatId: string | null;
  onClose: () => void;
}) {
  const kind = viewerKindFor(doc.mimeType, doc.filename);
  // A convertible Office file renders THROUGH a PDF rendition (Release B).
  const needsRendition = kind === "none" && doc.sourceStorageId !== undefined;
  const viewer = useDocumentViewer();
  // VERSION TRACKING (collaborative documents): the panel follows (chat,
  // filename), not a frozen URL — when the agent delivers a NEWER version of
  // this document, offer to switch to it in place.
  const latest = useQuery(
    api.documentDrafts.latestDeliveredFile,
    chatId !== null
      ? {
          chatId: chatId as Id<"chats">,
          filename: doc.filename,
          ...(doc.storageId !== undefined
            ? { currentStorageId: doc.storageId }
            : {}),
        }
      : "skip",
  ) as
    | { url: string; storageId: string; mimeType: string; createdAt: number }
    | null
    | undefined;
  // STABLE comparison: signed URLs rotate, so a URL mismatch alone would
  // cry "new version" on a mere re-sign (codex P2). Fall back to the URL
  // only for legacy openers that did not pass a storageId.
  const newer =
    latest !== undefined &&
    latest !== null &&
    (doc.storageId !== undefined
      ? latest.storageId !== doc.storageId
      : latest.url !== doc.url)
      ? latest
      : null;
  return (
    <div className="oc-docviewer">
      <header className="oc-docviewer__header">
        <FileText size={15} aria-hidden className="oc-docviewer__icon" />
        <span className="oc-docviewer__name" title={doc.filename}>
          {doc.filename}
        </span>
        <a
          className="oc-docviewer__action"
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          title={m.docviewer_open_tab()}
          aria-label={m.docviewer_open_tab()}
        >
          <ExternalLink size={14} />
        </a>
        <a
          className="oc-docviewer__action"
          href={doc.url}
          download={doc.filename}
          title={m.docviewer_download()}
          aria-label={m.docviewer_download()}
        >
          <Download size={14} />
        </a>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          aria-label={m.docviewer_close()}
        >
          <X size={15} />
        </Button>
      </header>
      <div className="oc-docviewer__body">
        {newer !== null ? (
          <div className="oc-docviewer__newversion" role="status">
            <span>{m.docviewer_new_version()}</span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                // FULL new-version identity: a redelivery can change the
                // mime/format, so classification, re-attachment AND the
                // Office-rendition decision follow the NEW metadata, never
                // the version being replaced (codex P2).
                viewer.openFor({
                  url: newer.url,
                  filename: doc.filename,
                  mimeType: newer.mimeType || null,
                  storageId: newer.storageId,
                  sourceStorageId: isConvertibleDocument(
                    newer.mimeType,
                    doc.filename,
                  )
                    ? newer.storageId
                    : undefined,
                })
              }
            >
              {m.docviewer_open_new_version()}
            </Button>
          </div>
        ) : null}
        {kind === "pdf" ? (
          <PdfViewer url={doc.url} filename={doc.filename} />
        ) : kind === "image" ? (
          <div className="oc-docviewer__imagewrap">
            <img src={doc.url} alt={doc.filename} className="oc-docviewer__image" />
          </div>
        ) : kind === "video" ? (
          <video controls preload="metadata" src={doc.url} className="oc-docviewer__video" />
        ) : kind === "audio" ? (
          <div className="oc-docviewer__audiowrap">
            <audio controls preload="metadata" src={doc.url} className="oc-docviewer__audio" />
          </div>
        ) : kind === "text" ? (
          <TextPreview
            key={doc.url}
            url={doc.url}
            chatId={chatId}
            filename={doc.filename}
            mimeType={doc.mimeType}
            storageId={doc.storageId ?? null}
          />
        ) : kind === "markdown" || kind === "csv" || kind === "log" || kind === "json" ? (
          // Keyed by URL: switching files must reset any per-document view
          // state back to this type's default.
          <TextPreview
            key={doc.url}
            url={doc.url}
            chatId={chatId}
            filename={doc.filename}
            mimeType={doc.mimeType}
            storageId={doc.storageId ?? null}
            rich={kind}
            csvDelimiter={
              kind === "csv"
                ? forcedCsvDelimiter(doc.mimeType, doc.filename)
                : undefined
            }
          />
        ) : needsRendition ? (
          <RenditionView
            sourceStorageId={doc.sourceStorageId as string}
            downloadUrl={doc.url}
            filename={doc.filename}
          />
        ) : (
          <div className="oc-docviewer__fallback">
            <p>{m.docviewer_no_preview()}</p>
            <a
              href={doc.url}
              target="_blank"
              rel="noopener noreferrer"
              className="oc-docviewer__fallbacklink"
            >
              {m.docviewer_download()}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

/** Office-file rendition: reactively read the PDF rendition of the source file;
 *  trigger the conversion once if none exists yet; show a preparing spinner while
 *  the instance converter agent works, the PDF via pdf.js when ready, and an
 *  honest download fallback when conversion is unconfigured or failed. */
function RenditionView({
  sourceStorageId,
  downloadUrl,
  filename,
}: {
  sourceStorageId: string;
  downloadUrl: string;
  filename: string;
}) {
  const rendition = useQuery(api.fileRenditions.getRendition, {
    sourceStorageId: sourceStorageId as Id<"_storage">,
  });
  const request = useMutation(api.fileRenditions.requestRendition);
  // Trigger the conversion at most once per (mounted) source: the server is
  // idempotent (the pending row is the guard), but we also guard the client so a
  // reactive re-render can't spam the mutation. `pending` from getRendition means
  // "convertible + configured, no job yet" → kick it off.
  const triggered = useRef<string | null>(null);
  useEffect(() => {
    triggered.current = null; // a new source resets the one-shot guard
  }, [sourceStorageId]);
  useEffect(() => {
    if (rendition?.status !== "pending") return;
    if (triggered.current === sourceStorageId) return;
    triggered.current = sourceStorageId;
    void request({ sourceStorageId: sourceStorageId as Id<"_storage"> }).catch(
      (e) => {
        console.error("[docviewer] rendition request failed:", e);
      },
    );
  }, [rendition?.status, sourceStorageId, request]);

  if (rendition === undefined) {
    return <div className="oc-docviewer__loading">{m.docviewer_loading()}</div>;
  }
  if (rendition.status === "ready") {
    return <PdfViewer url={rendition.pdfUrl} filename={rendition.filename} />;
  }
  if (rendition.status === "pending") {
    return (
      <div className="oc-docviewer__preparing">
        <span className="oc-docviewer__spinner" aria-hidden />
        <p>{m.docviewer_preparing()}</p>
        <a
          href={downloadUrl}
          download={filename}
          className="oc-docviewer__fallbacklink"
        >
          {m.docviewer_download()}
        </a>
      </div>
    );
  }
  // unconfigured | failed → honest no-preview + download.
  return (
    <div className="oc-docviewer__fallback">
      <p>
        {rendition.status === "unconfigured"
          ? m.docviewer_no_preview()
          : m.docviewer_conversion_failed()}
      </p>
      <a
        href={downloadUrl}
        download={filename}
        className="oc-docviewer__fallbacklink"
      >
        {m.docviewer_download()}
      </a>
    </div>
  );
}

/** The interpreted-by-default text kinds and their mode labels. */
type RichTextKind = "markdown" | "csv" | "log" | "json";

function richModeLabel(rich: RichTextKind): string {
  switch (rich) {
    case "markdown":
      return m.docviewer_view_rendered();
    case "csv":
      return m.docviewer_view_table();
    case "log":
      return m.docviewer_view_colorized();
    case "json":
      return m.docviewer_view_tree();
  }
}

// The user's remembered view choice PER TYPE (purely cosmetic and local —
// same storage tier as the sidebar's collapse state): someone who always
// wants raw CSVs should not re-click on every file.
const rawPrefKey = (rich: RichTextKind) => `oc.docviewer.raw.${rich}`;

/** Text preview, size-capped: the panel must render a 100 MB log's HEAD,
 *  never freeze on it. A fetch failure (e.g. storage CORS) degrades to the
 *  open-in-tab fallback — honest, never a blank panel. */
function TextPreview({
  url,
  chatId,
  filename,
  mimeType,
  storageId,
  rich,
  csvDelimiter,
}: {
  url: string;
  /** Draft key (collaborative documents). Null = editing unavailable. */
  chatId: string | null;
  filename: string;
  /** Original mime — preserved on the re-attached edited file (codex P2). */
  mimeType: string | null;
  /** Stable id of the displayed version (draft source anchor). */
  storageId: string | null;
  /** Rich kind: render INTERPRETED by default, raw behind the toggle. */
  rich?: RichTextKind;
  /** Delimiter imposed by the file's TYPE (.tsv → tab); undefined = detect. */
  csvDelimiter?: string;
}) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; text: string; truncated: boolean }
    | { phase: "error" }
  >({ phase: "loading" });
  const [raw, setRawState] = useState(
    () => (rich ? localStorage.getItem(rawPrefKey(rich)) === "1" : false),
  );
  const setRaw = (next: boolean) => {
    setRawState(next);
    if (rich) localStorage.setItem(rawPrefKey(rich), next ? "1" : "0");
  };
  // COLLABORATIVE EDITING: the user's auto-saved draft of this document. The
  // interpreted/raw views render the DRAFT text when one exists (previewing
  // your own edit is the point of the canvas loop) behind an explicit badge;
  // the delivered original stays reachable by discarding the draft.
  const [editing, setEditing] = useState(false);
  const draft = useQuery(
    api.documentDrafts.getDraft,
    chatId !== null
      ? { chatId: chatId as Id<"chats">, filename }
      : "skip",
  ) as
    | { text: string; sourceStorageId: string | null; updatedAt: number }
    | null
    | undefined;
  // Editing waits for BOTH the file and the draft query: entering the editor
  // before an existing draft resolved would seed it with the ORIGINAL text
  // and the first keystroke would overwrite the saved draft (codex P2).
  const editable =
    chatId !== null &&
    state.phase === "ready" &&
    !state.truncated &&
    draft !== undefined;
  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const truncated = blob.size > TEXT_PREVIEW_MAX_BYTES;
        const slice = truncated ? blob.slice(0, TEXT_PREVIEW_MAX_BYTES) : blob;
        const text = await slice.text();
        if (!cancelled) setState({ phase: "ready", text, truncated });
      } catch (e) {
        console.error("[docviewer] text fetch failed:", (e as Error)?.message ?? e);
        if (!cancelled) setState({ phase: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (state.phase === "loading") {
    return <div className="oc-docviewer__loading">{m.docviewer_loading()}</div>;
  }
  if (state.phase === "error") {
    return (
      <div className="oc-docviewer__fallback">
        <p>{m.docviewer_error()}</p>
        <a href={url} target="_blank" rel="noopener noreferrer" className="oc-docviewer__fallbacklink">
          {m.docviewer_open_tab()}
        </a>
      </div>
    );
  }
  const showRendered = rich !== undefined && !raw;
  const truncatedNote = state.truncated ? (
    <p className="oc-docviewer__truncated">{m.docviewer_text_truncated()}</p>
  ) : null;
  const displayText = draft?.text ?? state.text;
  const draftNote =
    draft != null ? (
      <DraftNote
        chatId={chatId as string}
        filename={filename}
        diverged={
          draft.sourceStorageId !== null &&
          storageId !== null &&
          draft.sourceStorageId !== storageId
        }
      />
    ) : null;
  const body = editing ? (
    <DocumentEditor
      chatId={chatId as string}
      filename={filename}
      mimeType={mimeType}
      sourceStorageId={storageId}
      initialText={displayText}
      hasDraft={draft != null}
      onExit={() => setEditing(false)}
    />
  ) : showRendered && rich === "markdown" ? (
      <div className="oc-docviewer__mdwrap">
        <AgentMarkdown text={displayText} />
      </div>
    ) : showRendered && rich === "csv" ? (
      <CsvTableView
        text={displayText}
        textTruncated={state.truncated}
        delimiter={csvDelimiter}
      />
    ) : showRendered && rich === "log" ? (
      <LogView text={displayText} textTruncated={state.truncated} />
    ) : showRendered && rich === "json" ? (
      <JsonTreeView text={displayText} />
    ) : (
      <pre className="oc-docviewer__text">{displayText}</pre>
    );
  if (rich === undefined && !editable) {
    return (
      <div className="oc-docviewer__textwrap">
        {truncatedNote}
        {draftNote}
        {body}
      </div>
    );
  }
  // Rich kinds: the mode bar stays FIXED above its own scroll area, so a
  // sticky element inside the content (the CSV header) can anchor to top: 0.
  return (
    <div className="oc-docviewer__textwrap oc-docviewer__textwrap--bar">
      <div className="oc-docviewer__mdbar" role="group" aria-label={m.docviewer_md_view_label()}>
        {rich !== undefined ? (
          <>
            <Button
              type="button"
              size="sm"
              variant={showRendered && !editing ? "secondary" : "ghost"}
              aria-pressed={showRendered && !editing}
              onClick={() => {
                setEditing(false);
                setRaw(false);
              }}
            >
              {richModeLabel(rich)}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={raw && !editing ? "secondary" : "ghost"}
              aria-pressed={raw && !editing}
              onClick={() => {
                setEditing(false);
                setRaw(true);
              }}
            >
              {m.docviewer_view_raw()}
            </Button>
          </>
        ) : null}
        {editable ? (
          <Button
            type="button"
            size="sm"
            variant={editing ? "secondary" : "ghost"}
            aria-pressed={editing}
            onClick={() => setEditing((e) => !e)}
            className="oc-docviewer__editbtn"
          >
            <Pencil size={13} aria-hidden />
            {m.docviewer_edit()}
            {draft != null ? <span className="oc-docviewer__draftdot" aria-hidden /> : null}
          </Button>
        ) : null}
      </div>
      {editing ? (
        // The editor fills the WHOLE remaining panel height (its textarea is
        // the scroll surface) — nesting it in the scroller collapsed the
        // work area to its min-height (user report).
        body
      ) : (
        <div className="oc-docviewer__textscroll">
          {/* Padding lives on this inner wrapper, NOT the scroller: sticky
              offsets resolve against the scroller's padding edge in Chrome, and
              scroller padding would leave a see-through strip above a stuck
              header. */}
          <div className="oc-docviewer__scrollpad">
            {truncatedNote}
            {draftNote}
            {body}
          </div>
        </div>
      )}
    </div>
  );
}

/** The draft badge shown OUTSIDE the editor, with an inline discard: a draft
 *  must never be stuck (e.g. a preview-truncated new delivery disables the
 *  editor, which used to hold the only delete affordance — codex P2). */
function DraftNote({
  chatId,
  filename,
  diverged,
}: {
  chatId: string;
  filename: string;
  diverged: boolean;
}) {
  const deleteDraft = useMutation(api.documentDrafts.deleteDraft);
  const toast = useToast();
  return (
    <p className="oc-docviewer__draftnote">
      {diverged ? m.docviewer_draft_diverged() : m.docviewer_draft_badge()}
      <button
        type="button"
        className="oc-docviewer__draftnote-discard"
        onClick={() =>
          void deleteDraft({ chatId: chatId as Id<"chats">, filename })
            .then((res) => {
              if ((res as { applied: boolean }).applied === false) {
                toast.error(m.docviewer_save_not_applied());
              }
            })
            .catch(() => toast.error(m.docviewer_discard_failed()))
        }
      >
        {m.docviewer_discard_draft()}
      </button>
    </p>
  );
}

/** The collaborative-document EDITOR: a plain monospace textarea over the
 *  draft text, auto-saved (debounced) to the per-user Convex draft — never
 *  mutating the delivered file (chat-history integrity). "Use in prompt"
 *  hands the edited version back to the agent through the composer: a file
 *  attachment when the instance supports them, an inline fenced block when
 *  it does not (Hermes) — the full-compliance path. */
function DocumentEditor({
  chatId,
  filename,
  mimeType,
  sourceStorageId,
  initialText,
  hasDraft,
  onExit,
}: {
  chatId: string;
  filename: string;
  mimeType: string | null;
  sourceStorageId: string | null;
  initialText: string;
  hasDraft: boolean;
  onExit: () => void;
}) {
  const saveDraft = useMutation(api.documentDrafts.saveDraft);
  const deleteDraft = useMutation(api.documentDrafts.deleteDraft);
  const bridgeRef = useContext(PromptBridgeContext);
  const toast = useToast();
  // LOCAL parachute for the unmount flush: if that last save fails (network
  // blip) the component — sole holder of the text — is already gone, so the
  // failure parks the text in localStorage and the next editor mount for the
  // same document restores + re-saves it (codex P2: never a silent loss).
  const fallbackKey = `oc.docdraft.fallback.${chatId}.${filename}`;
  const [text, setText] = useState(() => {
    try {
      const parked = localStorage.getItem(fallbackKey);
      if (parked !== null) return parked;
    } catch {
      // storage unavailable -> plain initial text
    }
    return initialText;
  });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const debounceRef = useRef(0);
  const latestRef = useRef(text);
  latestRef.current = text;
  // TRUE once the user explicitly discarded: the unmount flush below must
  // not resurrect the draft it just deleted (codex P1).
  const discardedRef = useRef(false);
  // TRUE after a real user edit in THIS session: only then may a save
  // re-anchor sourceStorageId onto the displayed version — an unchanged
  // open/close must keep a diverged draft flagged (codex P2).
  const dirtyRef = useRef(false);

  const flush = useCallback(
    (value: string) => {
      setSaveState("saving");
      void saveDraft({
        chatId: chatId as Id<"chats">,
        filename,
        text: value,
        ...(sourceStorageId !== null && (dirtyRef.current || !hasDraft)
          ? { sourceStorageId }
          : {}),
      })
        .then((res) => {
          // An impersonating admin's writes are server-side no-ops: showing
          // "saved" would be fictional (codex P2).
          if ((res as { applied: boolean }).applied === false) {
            toast.error(m.docviewer_save_not_applied());
            setSaveState("idle");
            return;
          }
          setSaveState("saved");
        })
        .catch((e) => {
          console.error("[docviewer] draft save failed:", e);
          toast.error(m.docviewer_save_failed());
          setSaveState("idle");
        });
    },
    [saveDraft, chatId, filename, sourceStorageId, hasDraft, toast],
  );
  const onChange = (value: string) => {
    dirtyRef.current = true;
    setText(value);
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => flush(value), 800);
  };
  // FLUSH on unmount/exit: a save settling <800ms before leaving must not be
  // lost (same rule as the bookmark scroll persistence).
  useEffect(() => {
    // A parked fallback found at mount: it IS the user's latest text — flush
    // it to the real draft now, and clear the parachute once that lands.
    try {
      if (localStorage.getItem(fallbackKey) !== null) {
        dirtyRef.current = true;
        void saveDraft({
          chatId: chatId as Id<"chats">,
          filename,
          text: latestRef.current,
          ...(sourceStorageId !== null ? { sourceStorageId } : {}),
        }).then(() => localStorage.removeItem(fallbackKey));
      }
    } catch {
      // storage unavailable -> nothing parked
    }
    // TAB DESTRUCTION (close/reload <800ms after the last keystroke): the
    // React cleanup's async mutation may never leave the dying page — park
    // the text SYNCHRONOUSLY on pagehide; the parachute clears once a real
    // save confirms (codex P2).
    const onPageHide = () => {
      if (!dirtyRef.current || discardedRef.current) return;
      try {
        localStorage.setItem(fallbackKey, latestRef.current);
      } catch {
        // storage full/unavailable
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.clearTimeout(debounceRef.current);
      if (discardedRef.current) return;
      // Only a REAL edit flushes (an unchanged open/close must neither touch
      // the draft nor silently re-anchor it — codex P1/P2). dirty ALONE
      // decides: a user who reverted to the initial text after an
      // intermediate auto-save still needs that reversion persisted
      // (codex P2 — comparing to initialText would drop it).
      if (dirtyRef.current) {
        // Park FIRST (synchronous), then try the real save: if the context
        // dies mid-mutation the parachute already holds the text (codex P2).
        try {
          localStorage.setItem(fallbackKey, latestRef.current);
        } catch {
          // storage full/unavailable
        }
        void saveDraft({
          chatId: chatId as Id<"chats">,
          filename,
          text: latestRef.current,
          ...(sourceStorageId !== null ? { sourceStorageId } : {}),
        })
          .then(() => {
            try {
              localStorage.removeItem(fallbackKey);
            } catch {
              // best effort
            }
          })
          .catch(() => {
            // parachute already written above
          });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount recovery + unmount flush only
  }, []);

  const useInPrompt = () => {
    const bridge = bridgeRef?.current ?? null;
    if (bridge === null) {
      toast.error(m.docviewer_prompt_unavailable());
      return;
    }
    window.clearTimeout(debounceRef.current);
    flush(text);
    if (bridge.canAttach) {
      // ORIGINAL mime preserved (a JSON/CSV/log re-attached as markdown would
      // reach the agent mistyped — codex P2); strip existing params first.
      const baseMime = (mimeType ?? "text/plain").split(";")[0]!.trim();
      const file = new File([text], filename, {
        type: `${baseMime}; charset=utf-8`,
      });
      // Success feedback = the composer chip + its sr-only announcement
      // (owned by the bridge); a toast here covered this panel's buttons.
      void bridge.attachFile(file).catch((e) => {
        console.error("[docviewer] attach failed:", e);
        toast.error(m.docviewer_prompt_attach_failed());
      });
    } else {
      // The inline path exists because this instance/mode cannot carry an
      // attachment — but a huge inline document is exactly what the
      // large-paste guard protects the context window from. Refuse honestly
      // past the same threshold (codex P2).
      if (text.length > LARGE_PASTE_CHARS) {
        toast.error(m.docviewer_inline_too_large());
        return;
      }
      bridge.insertText(
        buildInlineDocBlock(filename, text, m.docviewer_inline_label()),
      );
    }
  };
  const discard = () => {
    discardedRef.current = true;
    window.clearTimeout(debounceRef.current);
    try {
      localStorage.removeItem(fallbackKey);
    } catch {
      // best effort
    }
    // AWAIT the deletion: closing on a failed delete would leave the draft
    // silently overriding the delivered document (codex P2).
    void deleteDraft({ chatId: chatId as Id<"chats">, filename })
      .then((res) => {
        if ((res as { applied: boolean }).applied === false) {
          discardedRef.current = false;
          toast.error(m.docviewer_save_not_applied());
          return;
        }
        onExit();
      })
      .catch((e) => {
        console.error("[docviewer] draft discard failed:", e);
        discardedRef.current = false;
        toast.error(m.docviewer_discard_failed());
      });
  };
  return (
    <div className="oc-docviewer__editor">
      <textarea
        className="oc-docviewer__editarea"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label={m.docviewer_edit()}
      />
      <div className="oc-docviewer__editbar">
        <span className="oc-docviewer__savestate" role="status">
          {saveState === "saving"
            ? m.docviewer_saving()
            : saveState === "saved"
              ? m.docviewer_saved()
              : "\u00a0"}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={discard}>
          {m.docviewer_discard_draft()}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={useInPrompt}>
          {m.docviewer_use_in_prompt()}
        </Button>
      </div>
    </div>
  );
}

/** CSV as a real table: sticky header, click-to-sort columns, bounded rows
 *  (the raw mode always shows everything the preview fetched). */
function CsvTableView({
  text,
  textTruncated,
  delimiter,
}: {
  text: string;
  textTruncated: boolean;
  delimiter?: string;
}) {
  const preview = useMemo(
    () => parseCsvPreview(text, undefined, delimiter),
    [text, delimiter],
  );
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return preview.rows;
    return [...preview.rows].sort(
      (a, b) => compareCsvCells(a[sort.col] ?? "", b[sort.col] ?? "") * sort.dir,
    );
  }, [preview.rows, sort]);
  if (preview.header.length === 0) {
    return <pre className="oc-docviewer__text">{text}</pre>;
  }
  // Column cap: a 10k-column header times every rendered row is a frozen tab.
  // Cells beyond it stay reachable through the raw mode.
  const header = preview.header.slice(0, CSV_PREVIEW_MAX_COLS);
  const colsCapped = preview.header.length > header.length;
  return (
    <div className="oc-docviewer__csvwrap">
      {preview.truncatedRows ? (
        <p className="oc-docviewer__truncated">
          {textTruncated
            ? // The byte cap clipped the file itself: the parsed row count is
              // NOT the file's total, so do not present it as one.
              m.docviewer_csv_rows_partial({ shown: preview.rows.length })
            : m.docviewer_csv_rows_shown({
                shown: preview.rows.length,
                total: preview.totalRows,
              })}
        </p>
      ) : null}
      {colsCapped ? (
        <p className="oc-docviewer__truncated">
          {m.docviewer_csv_cols_shown({
            shown: header.length,
            total: preview.header.length,
          })}
        </p>
      ) : null}
      <table className="oc-docviewer__csv">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i}>
                <button
                  type="button"
                  className="oc-docviewer__csvsort"
                  onClick={() =>
                    setSort((s) =>
                      s?.col === i
                        ? s.dir === 1
                          ? { col: i, dir: -1 }
                          : null
                        : { col: i, dir: 1 },
                    )
                  }
                  aria-label={m.docviewer_csv_sort({ column: h })}
                >
                  {h}
                  {sort?.col === i ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {header.map((_, ci) => (
                <td key={ci}>{r[ci] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Log lines tinted by level (timestamps and identifiers stay untouched —
 *  the classification is line-level, deliberately simple). Line-capped: one
 *  <span> per line must not turn a short-lined 512 KiB preview into a frozen
 *  panel; the raw mode still shows the whole fetched text. */
function LogView({ text, textTruncated }: { text: string; textTruncated: boolean }) {
  const lines = useMemo(() => {
    const all = text.split("\n");
    // A trailing newline is a file convention, not an extra empty line.
    if (all.length > 1 && all[all.length - 1] === "") all.pop();
    return all;
  }, [text]);
  const shown = useMemo(() => lines.slice(0, LOG_PREVIEW_MAX_LINES), [lines]);
  const capped = lines.length > shown.length;
  return (
    <>
      {capped ? (
        <p className="oc-docviewer__truncated">
          {textTruncated
            ? m.docviewer_log_lines_partial({ shown: shown.length })
            : m.docviewer_log_lines_shown({ shown: shown.length, total: lines.length })}
        </p>
      ) : null}
      <pre className="oc-docviewer__text oc-docviewer__logview">
        {shown.map((line, i) => (
          <span key={i} className={`oc-logline oc-logline--${classifyLogLine(line)}`}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </>
  );
}

/** JSON as a collapsible tree (native <details>, first two levels open). An
 *  unparseable payload (invalid, or clipped by the preview byte cap) falls
 *  back to the raw text with an honest note. */
function JsonTreeView({ text }: { text: string }) {
  const parsed = useMemo(() => {
    try {
      // Reviver with source access (ES2024): JSON.parse rounds integers past
      // Number.MAX_SAFE_INTEGER (64-bit ids), and the tree would then display
      // a silently different value than the file. Where the runtime provides
      // the raw lexeme, keep such integers lossless as BigInt; elsewhere this
      // degrades to the plain (rounded) number.
      const reviver = (_key: string, value: unknown, context?: { source?: string }) => {
        if (
          typeof value === "number" &&
          Number.isInteger(value) &&
          !Number.isSafeInteger(value) &&
          typeof context?.source === "string" &&
          /^-?\d+$/.test(context.source)
        ) {
          try {
            return BigInt(context.source);
          } catch {
            return value;
          }
        }
        return value;
      };
      return { ok: true as const, value: JSON.parse(text, reviver as never) as unknown };
    } catch {
      return { ok: false as const };
    }
  }, [text]);
  if (!parsed.ok) {
    return (
      <>
        <p className="oc-docviewer__truncated">{m.docviewer_json_invalid()}</p>
        <pre className="oc-docviewer__text">{text}</pre>
      </>
    );
  }
  return (
    <div className="oc-docviewer__jsonwrap">
      <JsonNode value={parsed.value} depth={0} />
    </div>
  );
}

/** Entry count of a container WITHOUT materializing entry tuples. */
function jsonSize(value: object): number {
  if (Array.isArray(value)) return value.length;
  let n = 0;
  for (const k in value) {
    if (Object.prototype.hasOwnProperty.call(value, k)) n++;
  }
  return n;
}

/** At most `limit` entries of a container — nothing beyond the limit is ever
 *  allocated, so a flat 250k-entry preview costs 500 tuples, not 250k. */
function jsonEntriesBounded(
  value: object,
  limit: number,
): ReadonlyArray<readonly [string, unknown]> {
  if (Array.isArray(value)) {
    return value.slice(0, limit).map((v, i) => [String(i), v] as const);
  }
  const out: Array<readonly [string, unknown]> = [];
  for (const k in value) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
    if (out.length >= limit) break;
    out.push([k, (value as Record<string, unknown>)[k]]);
  }
  return out;
}

function JsonNode({ value, depth, name }: { value: unknown; depth: number; name?: string }) {
  // Children mount LAZILY on expand, a node auto-opens only when SMALL, and an
  // expanded node mounts at most JSON_TREE_MAX_CHILDREN children: a flat
  // 100k-entry root must not freeze the panel through any of those paths.
  const isContainer = value !== null && typeof value === "object";
  const total = isContainer ? jsonSize(value as object) : 0;
  const [open, setOpen] = useState(
    depth < 2 && total <= JSON_TREE_OPEN_MAX_ENTRIES,
  );
  const label = name !== undefined ? <span className="oc-json__key">{name}: </span> : null;
  if (!isContainer) {
    const kind = value === null ? "null" : typeof value === "bigint" ? "number" : typeof value;
    return (
      <div className="oc-json__leaf">
        {label}
        <span className={`oc-json__val oc-json__val--${kind}`}>
          {typeof value === "bigint" ? value.toString() : JSON.stringify(value)}
        </span>
      </div>
    );
  }
  const shown = open
    ? jsonEntriesBounded(value as object, JSON_TREE_MAX_CHILDREN)
    : [];
  const summary = Array.isArray(value) ? `[${total}]` : `{${total}}`;
  return (
    <details
      className="oc-json__node"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        {label}
        <span className="oc-json__summary">{summary}</span>
      </summary>
      {open ? (
        <div className="oc-json__children">
          {shown.map(([k, v]) => (
            <JsonNode key={k} name={k} value={v} depth={depth + 1} />
          ))}
          {total > shown.length ? (
            <div className="oc-json__more">
              {m.docviewer_json_more({ count: total - shown.length })}
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
