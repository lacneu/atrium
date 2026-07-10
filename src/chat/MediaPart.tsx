import { m } from "@/paraglide/messages.js";
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
  if (nativelyViewable || convertible) {
    return (
      <button
        type="button"
        className="oc-media oc-media--file oc-media--viewable"
        onClick={() =>
          viewer.openFor({
            url,
            filename: name,
            mimeType: mime || null,
            // Only convertible Office files carry the source id → rendition path.
            sourceStorageId: convertible ? storageId : undefined,
          })
        }
        title={name}
        aria-label={m.docviewer_open_aria({ name })}
      >
        <span className="oc-media__icon" aria-hidden>
          📄
        </span>
        <span className="oc-media__name">{name}</span>
      </button>
    );
  }
  return (
    <a
      className="oc-media oc-media--file"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="oc-media__icon" aria-hidden>
        ⬇
      </span>
      <span className="oc-media__name">{name}</span>
    </a>
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
