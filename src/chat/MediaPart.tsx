import { m } from "@/paraglide/messages.js";
import { ArrowRight, Download } from "lucide-react";
import { useLightbox } from "./ImageLightbox";
import { useDocumentViewer } from "./DocumentViewer";
import { isConvertibleDocument, viewerKindFor } from "./documentViewerView";
// Renders a `file` content part produced by convertMessage from the bridge's
// `media {items}` events (kind:"media") and from kind:"file" parts. The data URL
// is a resolved Convex storage URL (server-side ctx.storage.getUrl); the browser
// never receives a storageId-to-path mapping or a filesystem path.
//
// Audio is rendered with a native <audio> player so OpenClaw TTS output is
// playable inline. Images render inline. Every other file renders as a chip:
// when the Document Viewer can show it (PDF, text — see viewerKindFor), the
// click opens it in the right-column viewer with the conversation still live;
// otherwise it stays the open-in-new-tab link. assistant-ui routes `file`
// content parts to this component.

// assistant-ui renders a `file` content part as `<File {...part} />` (the part
// fields are SPREAD as props, NOT wrapped in `{part}` — same contract as
// ToolCard). So we destructure the fields directly; reading `part.mimeType` off
// a non-existent `part` prop is what crashed the message render before.
interface FileContentPartProps {
  type?: "file";
  mimeType?: string;
  data?: string; // resolved Convex storage URL
  filename?: string;
  storageId?: string; // opaque key → the Document Viewer's rendition request
}

export function MediaPart({ mimeType, data, filename, storageId }: FileContentPartProps) {
  const mime = mimeType ?? "";
  const url = data ?? "";
  const name = filename ?? "attachment";
  // Defensive: a file part with no resolved URL renders nothing rather than a
  // broken link (e.g. storage URL not yet available).
  if (!url) {
    return null;
  }

  if (mime.startsWith("audio/")) {
    return (
      <div className="oc-media oc-media--audio">
        {/* TTS playback for OpenClaw audio output. */}
        <audio controls preload="metadata" src={url} className="oc-media__audio">
          <a href={url} download={name}>
            {m.media_download_audio()}
          </a>
        </audio>
        <span className="oc-media__name">{name}</span>
      </div>
    );
  }

  if (mime.startsWith("image/")) {
    return <ImageThumb url={url} name={name} />;
  }

  if (mime.startsWith("video/")) {
    return (
      <div className="oc-media oc-media--video">
        <video controls preload="metadata" src={url} className="oc-media__video" />
        <span className="oc-media__name">{name}</span>
      </div>
    );
  }

  return <FileChip url={url} name={name} mime={mime} storageId={storageId} />;
}

/** Non-media file chip. Three cases:
 *   1. natively viewable (PDF, text — viewerKindFor) → open in the right-column
 *      Document Viewer (split view, conversation stays live);
 *   2. a CONVERTIBLE Office file WITH a storageId → the viewer renders a PDF
 *      rendition on demand (the instance converter agent produces it);
 *   3. anything else → the open-in-new-tab link.
 *  NOT `download`: that attribute is silently IGNORED for a cross-origin URL (the
 *  Convex storage origin differs from the app), so the click would navigate the
 *  CURRENT tab to the file instead. */
function FileChip({
  url,
  name,
  mime,
  storageId,
}: {
  url: string;
  name: string;
  mime: string;
  storageId?: string;
}) {
  const viewer = useDocumentViewer();
  const nativelyViewable = viewerKindFor(mime, name) !== "none";
  const convertible = !!storageId && isConvertibleDocument(mime, name);
  const previewable = nativelyViewable || convertible;
  // DOWNLOAD is the primary action again (the whole left zone AND the explicit
  // download icon) — routing every viewable/convertible chip into the viewer
  // made the FILE itself unreachable (live report: a delivered 22MB PPTX the
  // user could not save). The PREVIEW is the extra affordance: an arrow at the
  // far right, only when the right panel can actually show the document.
  // A real download needs the BLOB round-trip: the storage URL is another
  // origin, where the anchor `download` attribute is ignored (a PDF would just
  // open in a tab). The controls stay REAL anchors (middle-click / "save link
  // as" keep working natively); the click intercepts for the blob download and
  // on a fetch failure falls back to opening the direct URL — a popup-blocked
  // open (the async hop lost the user activation) last-resorts to a same-tab
  // navigation so the button never silently does nothing.
  const download = (e: React.MouseEvent) => {
    // Modified clicks (ctrl/cmd/shift/middle) keep the anchor's native
    // behavior — open in a new tab/window exactly as a real link promises.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    void (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const obj = URL.createObjectURL(await res.blob());
        const a = document.createElement("a");
        a.href = obj;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(obj), 30_000);
      } catch {
        // window.open with the "noopener" feature returns null EVEN on
        // success — open a blank proxy instead (null only when actually
        // BLOCKED), sever the opener by hand, then navigate it; a genuinely
        // blocked popup last-resorts to a same-tab navigation so the button
        // never silently does nothing.
        const w = window.open("", "_blank");
        if (w) {
          w.opener = null;
          w.location.href = url;
        } else {
          window.location.href = url;
        }
      }
    })();
  };
  return (
    <span className="oc-media oc-media--file oc-filechip" title={name}>
      <a
        className="oc-filechip__main"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={download}
        aria-label={m.chat_filechip_download({ name })}
      >
        <span className="oc-media__icon" aria-hidden>
          📄
        </span>
        <span className="oc-media__name">{name}</span>
      </a>
      <a
        className="oc-filechip__btn"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={download}
        title={m.chat_filechip_download({ name })}
        aria-label={m.chat_filechip_download({ name })}
      >
        <Download size={14} aria-hidden />
      </a>
      {previewable ? (
        <button
          type="button"
          className="oc-filechip__btn"
          onClick={() =>
            viewer.openFor({
              url,
              filename: name,
              mimeType: mime || null,
              // Stable version identity (signed URLs rotate): keys the
              // viewer's version tracking + the edit draft's source anchor.
              storageId,
              // Only convertible Office files carry the source id → rendition path.
              sourceStorageId: convertible ? storageId : undefined,
            })
          }
          title={m.docviewer_open_aria({ name })}
          aria-label={m.docviewer_open_aria({ name })}
        >
          <ArrowRight size={14} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** Image rendered as a bounded THUMBNAIL that opens the app lightbox on click
 *  (a wall of full-width images makes a conversation unreadable). Applies to
 *  user attachments AND agent/Hermes-generated images alike. */
function ImageThumb({ url, name }: { url: string; name: string }) {
  const { open } = useLightbox();
  return (
    <button
      type="button"
      className="oc-media oc-media--thumb"
      onClick={() => open({ url, name })}
      title={name}
      aria-label={name}
    >
      <img
        src={url}
        alt={name}
        className="oc-media__thumbimg"
        loading="lazy"
        decoding="async"
      />
    </button>
  );
}
