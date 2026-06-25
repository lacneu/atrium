// Renders a `file` content part produced by convertMessage from the bridge's
// `media {items}` events (kind:"media") and from kind:"file" parts. The data URL
// is a resolved Convex storage URL (server-side ctx.storage.getUrl); the browser
// never receives a storageId-to-path mapping or a filesystem path.
//
// Audio is rendered with a native <audio> player so OpenClaw TTS output is
// playable inline. Images render inline; everything else becomes a download
// link. assistant-ui routes `file` content parts to this component.

// assistant-ui renders a `file` content part as `<File {...part} />` (the part
// fields are SPREAD as props, NOT wrapped in `{part}` — same contract as
// ToolCard). So we destructure the fields directly; reading `part.mimeType` off
// a non-existent `part` prop is what crashed the message render before.
interface FileContentPartProps {
  type?: "file";
  mimeType?: string;
  data?: string; // resolved Convex storage URL
  filename?: string;
}

export function MediaPart({ mimeType, data, filename }: FileContentPartProps) {
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
            Download audio
          </a>
        </audio>
        <span className="oc-media__name">{name}</span>
      </div>
    );
  }

  if (mime.startsWith("image/")) {
    return (
      <figure className="oc-media oc-media--image">
        <img
          src={url}
          alt={name}
          className="oc-media__img"
          loading="lazy"
          decoding="async"
        />
        <figcaption className="oc-media__name">{name}</figcaption>
      </figure>
    );
  }

  if (mime.startsWith("video/")) {
    return (
      <div className="oc-media oc-media--video">
        <video controls preload="metadata" src={url} className="oc-media__video" />
        <span className="oc-media__name">{name}</span>
      </div>
    );
  }

  return (
    // ALWAYS open in a new tab and let the browser render by content-type. NOT
    // `download`: that attribute is silently IGNORED for a cross-origin URL (the
    // Convex storage origin differs from the app), so the click would navigate the
    // CURRENT tab to the file instead. `target="_blank"` makes the new tab explicit
    // regardless of origin; the browser then honors the stored Content-Type
    // (PDF/image inline, others download).
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
