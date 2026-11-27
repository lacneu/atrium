// A YouTube video card in the assistant message body, standing where the agent wrote
// `[embed url="https://www.youtube.com/watch?v=…" title="…" /]` (widgets/shortcodes.ts).
//
// Behaviour of the upstream Control UI card (ui/src/pages/chat/components/
// youtube-video-card.tsx at v2026.10.33): a thumbnail, a Play button, the title and a link
// to YouTube. NO PLAYER IS LOADED BEFORE A CLICK — the frame exists only while the video
// plays, one player at a time on the page, and closing it removes the frame. The card is
// handed a video id and a start time, never an address: every URL it uses is rebuilt by
// youtubeVideo.ts, and a pair that does not rebuild renders nothing.

import { ExternalLink, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";
import { youTubePlayerUrl, youTubeVideoAddresses, type YouTubeVideo } from "./youtubeVideo";

interface YouTubeVideoPartProps {
  data?: { videoId?: string; startSeconds?: number; title?: string };
}

/** upstream youtube-video-card.tsx:111-118, attribute for attribute. The frame is a third
 *  party's origin, so `allow-same-origin` gives it its own storage and nothing of Atrium's;
 *  the referrer is the page's origin alone, which YouTube's player requires. */
export const YOUTUBE_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";
export const YOUTUBE_FRAME_ALLOW = "autoplay; encrypted-media; fullscreen; picture-in-picture";
export const YOUTUBE_FRAME_REFERRER_POLICY = "strict-origin-when-cross-origin";

/** YouTube requires a player viewport of at least 200 × 200 CSS pixels. */
const MIN_PLAYER_WIDTH = 200;

/** Stops the card that is playing, so a second Play never leaves two players running. */
let stopActivePlayer: (() => void) | null = null;

export function YouTubeVideoPart({ data }: YouTubeVideoPartProps) {
  const video = useMemo(
    () => youTubeVideoAddresses({ videoId: data?.videoId, startSeconds: data?.startSeconds }),
    [data?.videoId, data?.startSeconds],
  );
  const title = data?.title?.trim() || m.youtube_default_title();
  // A click authorizes ONE video, so the state is that video's identity, not a flag:
  // assistant-ui keeps a part by its index and may hand this card another video while it
  // plays, and a flag reset by an effect let that other video's frame — autoplaying — reach
  // the DOM for one commit (codex). The frame exists only when the identity matches the
  // video rendered now, decided during render.
  const watchUrl = video?.watchUrl ?? null;
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);
  const playing = watchUrl !== null && playingUrl === watchUrl;
  const thumbnailFailed = video !== null && failedThumbnail === video.thumbnailUrl;
  // Another video forgets the previous click, so returning to it does not play it again
  // unasked (React's "adjust state when a prop changes", in render).
  const [shownUrl, setShownUrl] = useState(watchUrl);
  if (shownUrl !== watchUrl) {
    setShownUrl(watchUrl);
    setPlayingUrl(null);
  }
  const [wideEnough, setWideEnough] = useState(true);
  const cardRef = useRef<HTMLElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const refocusPlay = useRef(false);

  const stop = useCallback(() => setPlayingUrl(null), []);
  const release = useCallback(() => {
    if (stopActivePlayer === stop) stopActivePlayer = null;
  }, [stop]);
  // Released on unmount and when the card is handed another video.
  useEffect(() => release, [watchUrl, release]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWideEnough(entry.contentRect.width >= MIN_PLAYER_WIDTH);
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [watchUrl]);

  // Closing the player hands the focus back to the control that opened it.
  useEffect(() => {
    if (!playing && refocusPlay.current) {
      refocusPlay.current = false;
      playRef.current?.focus();
    }
  }, [playing]);

  if (!video) return null;
  return (
    <YouTubeVideoCard
      video={video}
      title={title}
      playing={playing}
      wideEnough={wideEnough}
      thumbnailFailed={thumbnailFailed}
      cardRef={cardRef}
      playRef={playRef}
      onPlay={() => {
        stopActivePlayer?.();
        stopActivePlayer = stop;
        setPlayingUrl(video.watchUrl);
      }}
      onClose={() => {
        refocusPlay.current = true;
        release();
        setPlayingUrl(null);
      }}
      onThumbnailError={() => setFailedThumbnail(video.thumbnailUrl)}
    />
  );
}

interface YouTubeVideoCardProps {
  video: YouTubeVideo;
  title: string;
  playing: boolean;
  wideEnough: boolean;
  thumbnailFailed: boolean;
  cardRef?: Ref<HTMLElement>;
  playRef?: Ref<HTMLButtonElement>;
  onPlay?: () => void;
  onClose?: () => void;
  onThumbnailError?: () => void;
}

/** The card for one state, with no state of its own: what is drawn — and above all
 *  whether a frame exists — is a function of `playing` and `wideEnough` alone. */
export function YouTubeVideoCard({
  video,
  title,
  playing,
  wideEnough,
  thumbnailFailed,
  cardRef,
  playRef,
  onPlay,
  onClose,
  onThumbnailError,
}: YouTubeVideoCardProps) {
  const showPlayer = playing && wideEnough;
  const thumbnail = thumbnailFailed ? null : (
    <img
      className="oc-youtube__thumb"
      src={video.thumbnailUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={onThumbnailError}
    />
  );

  return (
    <section className="oc-youtube" aria-label={title} ref={cardRef}>
      <div className="oc-youtube__stage">
        {showPlayer ? (
          <iframe
            className="oc-youtube__frame"
            src={youTubePlayerUrl(video)}
            title={m.youtube_player_title({ title })}
            sandbox={YOUTUBE_FRAME_SANDBOX}
            allow={YOUTUBE_FRAME_ALLOW}
            allowFullScreen
            referrerPolicy={YOUTUBE_FRAME_REFERRER_POLICY}
          />
        ) : wideEnough ? (
          <button
            type="button"
            className="oc-youtube__preview"
            aria-label={m.youtube_play({ title })}
            ref={playRef}
            onClick={onPlay}
          >
            {thumbnail}
            <span className="oc-youtube__play" aria-hidden="true">
              <Play />
            </span>
          </button>
        ) : (
          <a
            className="oc-youtube__preview"
            href={video.watchUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={m.youtube_open_video({ title })}
          >
            {thumbnail}
            <span className="oc-youtube__play" aria-hidden="true">
              <ExternalLink />
            </span>
          </a>
        )}
      </div>
      <div className="oc-youtube__footer">
        <div className="oc-youtube__caption">
          <span className="oc-youtube__provider">{m.youtube_provider()}</span>
          <p className="oc-youtube__title">{title}</p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <a href={video.watchUrl} target="_blank" rel="noopener noreferrer">
            {m.youtube_open()}
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
        {showPlayer ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={m.youtube_close()}
            title={m.youtube_close()}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {wideEnough ? null : (
        <p className="oc-youtube__notice" role="status">
          {m.youtube_narrow()}
        </p>
      )}
    </section>
  );
}
