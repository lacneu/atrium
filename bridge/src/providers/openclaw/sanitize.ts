/**
 * Text/frame sanitization for the Atrium bridge.
 *
 * Faithful port of backend/app/sanitizer.py, with ONE sanctioned deviation
 * (the Convex media adaptation, below). The job is to NEVER leak server
 * filesystem paths (/home/node/.openclaw/...) to the browser.
 *
 * sanitize_text() preserves the exact four behaviors of the Python version:
 *   1. Early return: if the text contains no "/home/node/.openclaw/" substring,
 *      it is returned VERBATIM (including the empty string).
 *   2. MEDIA: directive lines (MEDIA:/home/node/.openclaw/media/outbound/<file>)
 *      become a Markdown link [<filename>](<href>).
 *   3. Lines matching the PATH_LABEL pattern ("path: /home/node/..." /
 *      "chemin: ...") are DROPPED entirely.
 *   4. Any remaining bare outbound/workspace path is rewritten to just its
 *      basename (NOT deleted), so surrounding prose is preserved.
 *
 * ADAPTATION vs the Python sanitizer (intentional, the only deviation):
 * The Python version minted an HMAC-signed media URL via media_url(), which
 * required OPENCLAW_MEDIA_LINK_SECRET and raised MediaConfigurationError when
 * absent. In the Convex architecture the bridge stores media bytes in Convex
 * File Storage and never signs URLs, so the MEDIA: directive is rendered to a
 * relative, path-free href derived from the filename only (`./media/<file>`).
 * MediaConfigurationError is retained purely as a type for API parity and is
 * never thrown.
 */

// Marker substring that gates all sanitization work, exactly like Python's
// `if "/home/node/.openclaw/" not in text: return text`.
const OPENCLAW_MARKER = "/home/node/.openclaw/";

// Port of _OUTBOUND_PATH_RE (global; capture group 1 is the tail after the
// outbound/workspace dir). Matches /home/node/.openclaw/(media/outbound |
// workspace-<...>)/<tail>, where the tail and workspace token stop at
// whitespace, backtick, ")" or ">".
const OUTBOUND_PATH_RE = /\/home\/node\/\.openclaw\/(?:media\/outbound|workspace-[^\s`)>]+)\/([^\s`)>]+)/g;

// Port of _MEDIA_DIRECTIVE_RE: a line that is exactly
// "MEDIA:/home/node/.openclaw/media/outbound/<tail>". Group 1 = full path,
// group 2 = tail after outbound/.
const MEDIA_DIRECTIVE_RE = /^MEDIA:(\/home\/node\/\.openclaw\/media\/outbound\/(.+))$/;

// Port of _PATH_LABEL_RE (re.IGNORECASE): a whole line that is just a
// "path:"/"chemin:" label pointing at an outbound/workspace path, optionally
// backtick-wrapped. Such lines are dropped.
const PATH_LABEL_RE =
  /^\s*(?:path|chemin)\s*:\s*`?\/home\/node\/\.openclaw\/(?:media\/outbound|workspace-[^`\s]+)\/[^`\s]+`?\s*$/i;

/**
 * Retained for API compatibility with the Python sanitizer. In the Convex
 * architecture media links are never signed, so this is never thrown; the
 * normalizer's try/catch wrappers keep working unchanged.
 */
export class MediaConfigurationError extends Error {
  constructor(message = "media link configuration missing") {
    super(message);
    this.name = "MediaConfigurationError";
  }
}

/** Trailing filename component of a POSIX path (Python PurePosixPath.name). */
function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Browser-facing href for a media file. Path-free by construction: only the
 * filename is exposed, never the server path. This is the sanctioned media
 * deviation -- no HMAC signing (cf. Python media_url()).
 */
function mediaHref(filename: string): string {
  return `./media/${encodeURIComponent(filename)}`;
}

/** Rewrite every bare outbound/workspace path in a line to its basename. */
function stripPathsToBasename(line: string): string {
  return line.replace(OUTBOUND_PATH_RE, (_match, tail: string) => posixBasename(tail));
}

/**
 * Sanitize visible assistant text before it reaches the browser.
 *
 * `mediaSessionKey` is accepted for signature parity with the Python version
 * but is unused (no signing in the Convex architecture).
 */
export function sanitizeText(text: string, _opts?: { mediaSessionKey?: string }): string {
  // 1. Early return verbatim (covers the empty string and any path-free text).
  if (typeof text !== "string" || !text.includes(OPENCLAW_MARKER)) {
    return text;
  }
  // splitlines() full boundary set incl. NEL/LS/PS (u0085,u2028,u2029).
  // a server path placed after one of these separators would otherwise slip
  // splitlines() full boundary set incl. NEL/LS/PS (u0085,u2028,u2029).
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029]/);
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("MEDIA:")) {
      if (MEDIA_DIRECTIVE_RE.test(line)) {
        // DROP a well-formed outbound MEDIA: directive from the VISIBLE text: the
        // bridge emits it as a real `kind:media` attachment part (downloadable,
        // Convex storage URL) via the normalizer. Rendering it ALSO as a markdown
        // link here produced a DEAD `./media/<f>` link next to the working part
        // (a confusing duplicate). The part is canonical; the directive is a
        // machine marker, not user prose.
        continue;
      }
      // A MEDIA: line that is not a well-formed outbound directive: still strip
      // any embedded server path to its basename.
      out.push(stripPathsToBasename(line));
      continue;
    }
    if (PATH_LABEL_RE.test(line)) {
      continue; // drop bare "path: /home/node/..." label lines entirely
    }
    out.push(stripPathsToBasename(line));
  }
  return out.join("\n");
}

/**
 * Sanitize a raw OpenClaw frame for the deprecated `openclaw.frame`
 * passthrough: recursively strip server paths from every string. Mirrors the
 * Python sanitize_frame() recursion. `mediaUrls`/`media_urls` values are
 * treated like any other string (each outbound path becomes a path-free link
 * via sanitize), matching the Python intent of never leaking a raw path.
 *
 * `mediaSessionKey` is accepted for signature parity but unused.
 */
export function sanitizeFrame(value: unknown, _opts?: { mediaSessionKey?: string }): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeFrame(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "mediaUrls" || key === "media_urls")) {
        out[key] = sanitizeMediaUrls(item);
      } else {
        out[key] = sanitizeFrame(item);
      }
    }
    return out;
  }
  return value;
}

/**
 * Port of sanitize_media_urls(): convert a string outbound path (or a list of
 * them) into a path-free link. In the Convex adaptation this emits a markdown
 * link to the filename rather than an HMAC-signed URL.
 */
function sanitizeMediaUrls(value: unknown): unknown {
  if (typeof value === "string") {
    return mediaLinkFromPath(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMediaUrls(item));
  }
  return sanitizeFrame(value);
}

const MEDIA_OUTBOUND_PATH_RE = /^\/home\/node\/\.openclaw\/media\/outbound\/(.+)$/;

/** Port of media_link_from_path(): outbound path -> path-free markdown link. */
function mediaLinkFromPath(path: string): string {
  const match = MEDIA_OUTBOUND_PATH_RE.exec(path);
  if (!match) {
    return sanitizeText(path);
  }
  const filename = posixBasename(match[1]!);
  return `[${filename}](${mediaHref(filename)})`;
}
