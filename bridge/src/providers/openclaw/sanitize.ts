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

/** The mount an unconfigured deployment uses (the image's own outbound dir). */
const DEFAULT_OUTBOUND_MOUNT = "/home/node/.openclaw/media/outbound";

/** Trim a configured mount to a comparable prefix: no trailing separator, and a
 *  blank value reads as "not configured" rather than as the filesystem root. */
function normaliseMount(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  // A ROOT mount ("/") is degenerate but Convex ACCEPTS it
  // (`isValidAgentMountPath`), and silently reading it as "not configured" sent
  // this lane looking for the image default while the agent wrote to `/` — the
  // delivery lost, with nothing anywhere saying why. Normalising to the empty
  // prefix makes the directive `MEDIA:/<tail>`, which is what such an instance
  // actually instructs.
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped;
}

/**
 * The shapes NO outbound path may have, whatever lane it arrived on.
 *
 * The owner's lane has refused these since the Python original
 * (`normalizer.isOutboundMediaPath`); the child lane had NO filter at all, so a
 * directive naming `<mount>/../../secrets.env` was handed to the fetcher — which
 * in `gateway-http` mode asks the gateway for that exact `source`. Same rule,
 * ONE definition; each lane adds its own prefix test on top (the owner's is "any
 * /media/outbound/", the child's is "the mount it was instructed to use").
 */
export function isUnsafeOutboundPath(path: string): boolean {
  if (typeof path !== "string" || path === "") return true;
  if (!path.startsWith("/")) return true;
  if (path.includes("..")) return true;
  if (path.includes("?")) return true; // query component
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return true; // scheme
  return false;
}

/** `MEDIA:<mount>/<tail>` for THIS mount. The tail is the rest of the line, so a
 *  filename with spaces survives (see the note above). */
function directiveRegExpFor(mount: string): RegExp {
  if (mount === DEFAULT_OUTBOUND_MOUNT) return MEDIA_DIRECTIVE_RE;
  const escaped = mount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^MEDIA:(${escaped}\\/(.+))$`);
}

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
function stripPathsToBasename(
  line: string,
  /** ALREADY normalised by the caller. Re-normalising here silently dropped the
   *  ROOT mount, whose normalised form is the empty prefix: the delivery was
   *  detected and its absolute path stayed in the visible text. */
  custom?: string | null,
): string {
  const stripped = line.replace(OUTBOUND_PATH_RE, (_m, tail: string) =>
    posixBasename(tail),
  );
  if (
    custom === null ||
    custom === undefined ||
    custom === DEFAULT_OUTBOUND_MOUNT
  ) {
    return stripped;
  }
  // "" is the ROOT mount: every absolute path in this text is inside it.
  // A CONFIGURED mount is a server path too. The regexes here are a port of the
  // Python original and know only the image's own directory, so on an instance
  // that overrides `outboundAgentMount` the absolute path reached the reader.
  return stripped.replace(customPathRegExpFor(custom), (_m, tail: string) =>
    posixBasename(tail),
  );
}

/** `<mount>/<tail>` for a configured mount, mirroring OUTBOUND_PATH_RE's stops. */
function customPathRegExpFor(mount: string): RegExp {
  const escaped = mount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\/([^\\s\`)>]+)`, "g");
}

/**
 * The files a text DELIVERS: one entry per well-formed `MEDIA:` directive line.
 *
 * Only DIRECTIVES count — a path merely mentioned in prose is not a delivery,
 * and treating it as one would re-attach files an agent happened to name while
 * reading old notes. The whole rest of the line is the path, so a filename with
 * spaces survives intact (the same rule the normalizer's discovery uses; a
 * bare-token scan truncates "IFOA Presentation.pdf" at the first space and then
 * fetches a path that does not exist).
 *
 * Exists for the CHILD lane: a sub-agent's frames are observation-only, so the
 * media pipeline never sees them, and a delegated answer that IS a delivery had
 * no way to reach the reader (prod 2026-09-09).
 */
export function outboundMediaDeliveries(
  text: string,
  /** The mount the agent was INSTRUCTED to write to for this turn. An instance
   *  may override it (`outboundAgentMount`), and the directive then names that
   *  path — the historic constant matched nothing and the delivery stayed lost,
   *  which is the very defect this function exists for. Defaults to the constant
   *  so a caller without the config behaves as before. */
  outboundAgentMount?: string | null,
): Array<{ filename: string; path: string }> {
  if (typeof text !== "string") return [];
  const mount = normaliseMount(outboundAgentMount) ?? DEFAULT_OUTBOUND_MOUNT;
  if (!text.includes(mount)) return [];
  const directive = directiveRegExpFor(mount);
  const out: Array<{ filename: string; path: string }> = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029]/)) {
    const m = directive.exec(line);
    if (m === null) continue;
    // trimEnd: the gateway file has no trailing whitespace, and a trailing space
    // makes the fetch path not-found.
    const path = m[1]!.trimEnd();
    // The child lane's HALF of the shared rule (the other half is the mount
    // prefix, which the regex above already enforced).
    if (isUnsafeOutboundPath(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ filename: posixBasename(path), path });
  }
  return out;
}

/**
 * Sanitize visible assistant text before it reaches the browser.
 *
 * `mediaSessionKey` is accepted for signature parity with the Python version
 * but is unused (no signing in the Convex architecture).
 */
export function sanitizeText(
  text: string,
  _opts?: {
    mediaSessionKey?: string;
    /**
     * FALSE when the caller does NOT emit a media part for a `MEDIA:` directive.
     *
     * Dropping the directive (the default) is right on the OWNER's lane: the
     * normalizer turns it into a real, downloadable attachment part, and keeping
     * the line too printed a dead link beside the working one. A SUB-AGENT's
     * frames are admitted for OBSERVATION ONLY — its content never becomes a
     * part — so on that lane the drop deletes the only trace of the delivery.
     * Prod 2026-09-09: a child produced a DOCX and a PDF, its entire answer was
     * the two directives, both were dropped, and the settled bubble was blank
     * while the gateway's own console listed both files.
     */
    mediaPartsEmitted?: boolean;
    /** The mount the agent was instructed to write to, when the instance
     *  overrides the image default. Without it a directive under a custom mount
     *  is not recognised as one AND its absolute path reaches the reader. */
    outboundAgentMount?: string | null;
  },
): string {
  const mount = normaliseMount(_opts?.outboundAgentMount);
  const marker = mount !== null ? `${mount}/` : OPENCLAW_MARKER;
  // 1. Early return verbatim (covers the empty string and any path-free text).
  if (
    typeof text !== "string" ||
    (!text.includes(OPENCLAW_MARKER) && !text.includes(marker))
  ) {
    return text;
  }
  const directive =
    mount !== null ? directiveRegExpFor(mount) : MEDIA_DIRECTIVE_RE;
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
      if (directive.test(line)) {
        if (_opts?.mediaPartsEmitted === false) {
          // Nothing downstream will carry this file, so NAME it. The basename
          // only — never the server path, and never a `./media/` link, which
          // would be dead on this lane and is exactly the confusion the drop
          // was introduced to remove.
          out.push(
            stripPathsToBasename(line, mount).replace(/^MEDIA:\s*/, ""),
          );
          continue;
        }
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
      out.push(stripPathsToBasename(line, mount));
      continue;
    }
    if (PATH_LABEL_RE.test(line)) {
      continue; // drop bare "path: /home/node/..." label lines entirely
    }
    out.push(stripPathsToBasename(line, mount));
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
