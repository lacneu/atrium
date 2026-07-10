import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { Download, ExternalLink, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { PdfViewer } from "./PdfViewer";
import {
  TEXT_PREVIEW_MAX_BYTES,
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
  onClose,
}: {
  doc: ViewerDoc;
  onClose: () => void;
}) {
  const kind = viewerKindFor(doc.mimeType, doc.filename);
  // A convertible Office file renders THROUGH a PDF rendition (Release B).
  const needsRendition = kind === "none" && doc.sourceStorageId !== undefined;
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
          <TextPreview url={doc.url} />
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

/** Plain-text preview, size-capped: the panel must render a 100 MB log's HEAD,
 *  never freeze on it. A fetch failure (e.g. storage CORS) degrades to the
 *  open-in-tab fallback — honest, never a blank panel. */
function TextPreview({ url }: { url: string }) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; text: string; truncated: boolean }
    | { phase: "error" }
  >({ phase: "loading" });
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
  return (
    <div className="oc-docviewer__textwrap">
      {state.truncated ? (
        <p className="oc-docviewer__truncated">{m.docviewer_text_truncated()}</p>
      ) : null}
      <pre className="oc-docviewer__text">{state.text}</pre>
    </div>
  );
}
