// A YouTube video an agent names in an `[embed url="…" /]` shortcode (OpenClaw 2026.10.33
// teaches webchat agents the form: src/agents/system-prompt.ts:875).
//
// Port of upstream `parseYouTubeVideoUrl` (ui/src/lib/chat/youtube-video.ts at v2026.10.33),
// same accepted hosts, paths and start times, same refusals. THE AGENT'S URL IS NEVER
// LOADED: only an 11-character video id and a start time are read from it, and every
// address the page uses (watch page, player, thumbnail) is rebuilt here on a fixed origin.
// So no parameter, path, port, credential or fragment the agent wrote can reach a frame's
// `src`, an image's `src` or a link's `href`.

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const YOUTUBE_EMBED_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;

/** The one origin the page frames a player from — also the page's `frame-src` opening
 *  (widgetSandbox.ts `pageFramePolicy`). */
export const YOUTUBE_PLAYER_ORIGIN = "https://www.youtube-nocookie.com";

/** What a card needs, and nothing the agent wrote verbatim. */
export type YouTubeVideoRef = { videoId: string; startSeconds: number };

export type YouTubeVideo = YouTubeVideoRef & {
  watchUrl: string;
  embedUrl: string;
  thumbnailUrl: string;
};

/** Seconds from `90`, `90s`, `1h2m3s`; 0 when absent; undefined when unreadable. */
function parseStartSeconds(value: string | null): number | undefined {
  if (value === null) return 0;
  let seconds: number;
  if (/^\d+$/u.test(value)) {
    seconds = Number(value);
  } else {
    const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/iu.exec(value);
    if (!units || !value) return undefined;
    seconds = Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/** The three addresses of a video, built from its id and start time alone. Null when the
 *  pair is not a valid one — the card re-checks what it is handed rather than trust it. */
export function youTubeVideoAddresses(ref: {
  videoId?: unknown;
  startSeconds?: unknown;
}): YouTubeVideo | null {
  const { videoId, startSeconds } = ref;
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) return null;
  if (typeof startSeconds !== "number" || !Number.isSafeInteger(startSeconds) || startSeconds < 0) return null;
  const start = startSeconds > 0 ? String(startSeconds) : null;
  return {
    videoId,
    startSeconds,
    watchUrl: `https://www.youtube.com/watch?v=${videoId}${start ? `&t=${start}` : ""}`,
    embedUrl: `${YOUTUBE_PLAYER_ORIGIN}/embed/${videoId}?playsinline=1${start ? `&start=${start}` : ""}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

/** The player address a click loads: the rebuilt one, set to start playing (upstream
 *  youtube-video-card.tsx:25-27 — the click IS the user's gesture). */
export function youTubePlayerUrl(video: YouTubeVideo): string {
  return `${video.embedUrl}&autoplay=1`;
}

/** Resolve a supported video link, or null: anything else is not a video Atrium plays. */
export function parseYouTubeVideoUrl(raw: string | undefined | null): YouTubeVideo | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    ["v", "start", "t"].some((key) => query.getAll(key).length > 1) ||
    fragment.getAll("t").length > 1
  ) {
    return null;
  }
  let videoId: string | undefined;
  if (YOUTUBE_HOSTS.has(url.hostname) && url.pathname === "/watch") {
    videoId = query.get("v") ?? undefined;
  } else {
    if (query.has("v")) return null;
    if (url.hostname === "youtu.be") {
      videoId = /^\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname)?.[1];
    } else if (YOUTUBE_HOSTS.has(url.hostname)) {
      videoId = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname)?.[1];
    } else if (YOUTUBE_EMBED_HOSTS.has(url.hostname)) {
      videoId = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname)?.[1];
    }
  }
  if (!videoId) return null;
  const startSeconds = parseStartSeconds(query.get("start") ?? query.get("t") ?? fragment.get("t"));
  if (startSeconds === undefined) return null;
  return youTubeVideoAddresses({ videoId, startSeconds });
}

/** A content part as "copy the reply" reads it. */
export type CopyablePart = {
  type?: string;
  text?: string;
  data?: { videoId?: unknown; startSeconds?: unknown; title?: unknown };
};

/** What "copy the reply" takes from a bubble: its texts, and — where a video card stands —
 *  the video's title and rebuilt watch address, so the copy keeps the link the reader
 *  sees instead of losing it with the shortcode the card replaced. */
export function copyTextOfContent(parts: ReadonlyArray<CopyablePart>): string {
  return parts
    .flatMap((part) => {
      if (part.type === "text" && typeof part.text === "string") return [part.text];
      if (part.type !== "data-youtube") return [];
      const video = youTubeVideoAddresses(part.data ?? {});
      if (!video) return [];
      const title = typeof part.data?.title === "string" ? part.data.title.trim() : "";
      return [title ? `${title} — ${video.watchUrl}` : video.watchUrl];
    })
    .join("\n");
}
