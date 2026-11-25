// The YouTube link parser: which addresses an agent may name, and the ONLY addresses the
// page then uses. Table-driven, the upstream cases (ui/src/lib/chat/youtube-video.test.ts
// at v2026.10.33) plus Atrium's own hostile ones.
import { describe, expect, it } from "vitest";

import {
  YOUTUBE_PLAYER_ORIGIN,
  copyTextOfContent,
  parseYouTubeVideoUrl,
  youTubePlayerUrl,
  youTubeVideoAddresses,
} from "./youtubeVideo";

const ID = "AbC123_-xyz";

describe("parseYouTubeVideoUrl", () => {
  it.each([
    `https://youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&si=tracking&autoplay=1`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=tracking`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}/`,
    `https://www.youtube.com/embed/${ID}?origin=https://untrusted.example`,
    `https://youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    // The host is case-insensitive, and an explicit default port is no port.
    `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`,
    `https://www.youtube.com:443/watch?v=${ID}`,
    // Nothing else the agent wrote survives: player parameters, a playlist, a fragment.
    `https://www.youtube.com/watch?v=${ID}&list=PLx&index=3&enablejsapi=1&origin=https://evil.example#frag`,
  ])("rebuilds a supported link on fixed origins, copying no parameter: %s", (url) => {
    expect(parseYouTubeVideoUrl(url)).toEqual({
      videoId: ID,
      startSeconds: 0,
      watchUrl: `https://www.youtube.com/watch?v=${ID}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${ID}?playsinline=1`,
      thumbnailUrl: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
    });
  });

  it.each([
    ["?t=90", 90],
    ["?t=90s", 90],
    ["?t=1h2m3s", 3723],
    ["?t=2m", 120],
    ["#t=1m30s", 90],
    ["?start=15&t=30#t=45", 15],
    ["?t=30#t=45", 30],
    ["?start=0&t=30", 0],
  ] as const)("keeps the requested start time from %s", (suffix, seconds) => {
    const video = parseYouTubeVideoUrl(`https://youtu.be/${ID}${suffix}`);
    expect(video?.startSeconds).toBe(seconds);
    expect(video?.watchUrl).toBe(`https://www.youtube.com/watch?v=${ID}${seconds > 0 ? `&t=${seconds}` : ""}`);
    expect(video?.embedUrl).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}?playsinline=1${seconds > 0 ? `&start=${seconds}` : ""}`,
    );
  });

  it.each([
    undefined,
    null,
    "",
    "not a URL",
    // Scheme.
    `http://www.youtube.com/watch?v=${ID}`,
    `javascript:alert(1)//www.youtube.com/watch?v=${ID}`,
    `javascript://www.youtube.com/watch?v=${ID}`,
    `data:text/html,https://www.youtube.com/watch?v=${ID}`,
    `//www.youtube.com/watch?v=${ID}`,
    `/watch?v=${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    // Look-alike and wrong hosts.
    `https://www.youtube.com.evil.example/watch?v=${ID}`,
    `https://youtube.com.evil.tld/watch?v=${ID}`,
    `https://evilyoutube.com/watch?v=${ID}`,
    `https://youtube.com.evil.tld/embed/${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be.evil.tld/${ID}`,
    `https://www.youtube-nocookie.com.evil.tld/embed/${ID}`,
    `https://www.youtube.com./watch?v=${ID}`,
    `https://evil.example/?https://www.youtube.com/watch?v=${ID}`,
    `https://evil.example/#https://www.youtube.com/watch?v=${ID}`,
    `https://evil.example\\@www.youtube.com/watch?v=${ID}`,
    // Credentials and ports.
    `https://youtube.com@evil.example/watch?v=${ID}`,
    `https://user:password@www.youtube.com/watch?v=${ID}`,
    `https://user@www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:8443/watch?v=${ID}`,
    // Paths that are not a video.
    `https://www.youtube.com/playlist?list=${ID}`,
    `https://www.youtube.com/watch/${ID}`,
    `https://www.youtube.com/redirect?q=https://evil.example&v=${ID}`,
    `https://www.youtube.com/embed/${ID}/../../redirect`,
    `https://www.youtube-nocookie.com/watch?v=${ID}`,
    `https://youtu.be/${ID}/extra`,
    // The id: exactly eleven characters of the alphabet.
    "https://www.youtube.com/watch?v=short",
    `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/watch?v=${ID}${ID}`,
    `https://youtu.be/${ID}x`,
    `https://www.youtube.com/embed/${ID}x`,
    "https://www.youtube.com/watch?v=AbC123%2F-xyz",
    "https://www.youtube.com/watch?v=AbC123%22-xyz",
    "https://www.youtube.com/watch?v=AbC12%3Cb%3Exy",
    "https://www.youtube.com/watch?v=",
    "https://www.youtube.com/watch",
    // Ambiguity.
    `https://www.youtube.com/watch?v=${ID}&v=other123456`,
    `https://youtu.be/${ID}?v=other123456`,
    `https://youtu.be/${ID}?start=1&start=2`,
    `https://youtu.be/${ID}?t=1&t=2`,
    `https://youtu.be/${ID}#t=1&t=2`,
    // Start times.
    `https://youtu.be/${ID}?t=-1`,
    `https://youtu.be/${ID}?t=1.5`,
    `https://youtu.be/${ID}?t=`,
    `https://youtu.be/${ID}?t=forever`,
    `https://youtu.be/${ID}?t=90%26autoplay%3D1`,
    `https://youtu.be/${ID}?t=9007199254740992`,
    `https://youtu.be/${ID}?t=9007199254740991h`,
  ])("refuses an unsupported, look-alike or ambiguous link: %s", (url) => {
    expect(parseYouTubeVideoUrl(url)).toBeNull();
  });
});

describe("youTubeVideoAddresses — what the card rebuilds from what it is handed", () => {
  it("builds the three addresses from an id and a start time alone", () => {
    expect(youTubeVideoAddresses({ videoId: ID, startSeconds: 42 })).toEqual({
      videoId: ID,
      startSeconds: 42,
      watchUrl: `https://www.youtube.com/watch?v=${ID}&t=42`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${ID}?playsinline=1&start=42`,
      thumbnailUrl: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
    });
  });

  it.each([
    [{ videoId: `${ID}x`, startSeconds: 0 }],
    [{ videoId: "AbC123/-xyz", startSeconds: 0 }],
    [{ videoId: 'AbC12"-xyz&', startSeconds: 0 }],
    [{ videoId: undefined, startSeconds: 0 }],
    [{ videoId: 12345678901, startSeconds: 0 }],
    [{ videoId: ID, startSeconds: -1 }],
    [{ videoId: ID, startSeconds: 1.5 }],
    [{ videoId: ID, startSeconds: "5&autoplay=1" }],
    [{ videoId: ID, startSeconds: undefined }],
    [{ videoId: ID, startSeconds: Number.NaN }],
  ])("refuses a pair that is not an id and a whole number of seconds: %j", (ref) => {
    expect(youTubeVideoAddresses(ref)).toBeNull();
  });

  it("the player address is on the one origin the page may frame, set to play on the click", () => {
    const video = youTubeVideoAddresses({ videoId: ID, startSeconds: 7 })!;
    const player = new URL(youTubePlayerUrl(video));
    expect(player.origin).toBe(YOUTUBE_PLAYER_ORIGIN);
    expect(player.pathname).toBe(`/embed/${ID}`);
    expect([...player.searchParams]).toEqual([
      ["playsinline", "1"],
      ["start", "7"],
      ["autoplay", "1"],
    ]);
  });
});

describe("copyTextOfContent — the copied reply keeps the video's link", () => {
  it("joins the texts, a video card reading as its title and rebuilt watch address", () => {
    expect(
      copyTextOfContent([
        { type: "text", text: "Watch this:" },
        { type: "data-youtube", data: { videoId: ID, startSeconds: 90, title: "Demo" } },
        { type: "data-widget", data: {} },
        { type: "text", text: "Done." },
      ]),
    ).toBe(`Watch this:\nDemo — https://www.youtube.com/watch?v=${ID}&t=90\nDone.`);
  });

  it("an untitled video is its address; a part that does not rebuild adds nothing", () => {
    expect(
      copyTextOfContent([
        { type: "data-youtube", data: { videoId: ID, startSeconds: 0 } },
        { type: "data-youtube", data: { videoId: "nope", startSeconds: 0, title: "x" } },
      ]),
    ).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });
});
