/// <reference types="vite/client" />
//
// The YouTube video card as it RENDERS: no player before a click, the upstream frame
// attributes after it, every address rebuilt on a fixed origin, and — for a URL the parser
// refuses — a plain link through the reply's own Markdown renderer. SSR render, no jsdom.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, test } from "vitest";

import { m } from "@/paraglide/messages.js";
import { AgentAnchor } from "../MarkdownText";
import { renderableText } from "./shortcodes";
import { YouTubeVideoCard, YouTubeVideoPart } from "./YouTubeVideoPart";
import { youTubeVideoAddresses } from "./youtubeVideo";

const ID = "AbC123_-xyz";
const part = (data: Record<string, unknown>) => renderToStaticMarkup(createElement(YouTubeVideoPart, { data }));
const card = (state: { playing: boolean; wideEnough?: boolean; thumbnailFailed?: boolean }, title = "Demo") =>
  renderToStaticMarkup(
    createElement(YouTubeVideoCard, {
      video: youTubeVideoAddresses({ videoId: ID, startSeconds: 90 })!,
      title,
      wideEnough: true,
      thumbnailFailed: false,
      ...state,
    }),
  );
/** The attributes of the first `<tag …>` of a markup, as written. */
const attrsOf = (html: string, tag: string): Record<string, string> => {
  const open = new RegExp(`<${tag}\\b([^>]*)>`).exec(html)?.[1] ?? "";
  return Object.fromEntries([...open.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!, a[2] ?? ""]));
};
const unescape = (value: string) => value.replace(/&amp;/g, "&");

describe("the card before a click", () => {
  const html = part({ videoId: ID, startSeconds: 90, title: "Demo" });

  test("no frame exists, and the player's origin appears nowhere in the markup", () => {
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("youtube-nocookie.com");
  });

  test("a named Play button over a lazy, referrer-less thumbnail from the image host", () => {
    expect(attrsOf(html, "button")).toMatchObject({ type: "button", "aria-label": m.youtube_play({ title: "Demo" }) });
    expect(attrsOf(html, "img")).toMatchObject({
      src: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
      alt: "",
      loading: "lazy",
      referrerPolicy: "no-referrer",
    });
  });

  test("the title, and a link to the rebuilt watch page that opens apart from the app", () => {
    expect(html).toContain(">Demo</p>");
    const link = attrsOf(html, "a");
    expect(unescape(link.href!)).toBe(`https://www.youtube.com/watch?v=${ID}&t=90`);
    expect(link).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
    expect(html).toContain(m.youtube_open());
  });

  test("an untitled video is named by the default title; a title is text, never markup", () => {
    expect(part({ videoId: ID, startSeconds: 0 })).toContain(`aria-label="${m.youtube_default_title()}"`);
    const hostile = part({ videoId: ID, startSeconds: 0, title: '<img src=x onerror=1>"' });
    expect(hostile.match(/<img/g)).toHaveLength(1);
    expect(hostile).toContain("&lt;img src=x onerror=1&gt;");
  });

  test.each([
    [{ videoId: `${ID}x`, startSeconds: 0 }],
    [{ videoId: '"><iframe src=//evil>', startSeconds: 0 }],
    [{ videoId: ID, startSeconds: "1&autoplay=1" }],
    [{ url: `https://www.youtube.com/watch?v=${ID}` }],
    [{}],
  ])("a part that does not rebuild into a video renders nothing: %j", (data) => {
    expect(part(data)).toBe("");
  });
});

describe("the card once Play was clicked", () => {
  const html = card({ playing: true });

  test("one frame, on the player origin, with upstream's sandbox, permissions and referrer policy", () => {
    expect(html.match(/<iframe/g)).toHaveLength(1);
    const frame = attrsOf(html, "iframe");
    expect(unescape(frame.src!)).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}?playsinline=1&start=90&autoplay=1`,
    );
    expect(frame).toMatchObject({
      sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox",
      allow: "autoplay; encrypted-media; fullscreen; picture-in-picture",
      referrerPolicy: "strict-origin-when-cross-origin",
      title: m.youtube_player_title({ title: "Demo" }),
    });
    expect(frame).toHaveProperty("allowFullScreen");
    // The sandbox grants neither top navigation, forms, nor downloads.
    expect(frame.sandbox).not.toMatch(/top-navigation|allow-forms|allow-downloads|allow-modals/);
  });

  test("the thumbnail and Play are gone, a named Close control is offered", () => {
    expect(html).not.toContain("<img");
    expect(html).not.toContain(m.youtube_play({ title: "Demo" }));
    expect(html).toContain(`aria-label="${m.youtube_close()}"`);
    expect(card({ playing: false })).not.toContain(m.youtube_close());
  });
});

describe("degraded states never frame anything", () => {
  test("too narrow for YouTube's minimum player: the stage is a link, even if it was playing", () => {
    for (const playing of [true, false]) {
      const html = card({ playing, wideEnough: false });
      expect(html).not.toContain("<iframe");
      expect(html).not.toContain("<button");
      expect(html).toContain(`aria-label="${m.youtube_open_video({ title: "Demo" })}"`);
      expect(html).toContain(m.youtube_narrow());
    }
  });

  test("a thumbnail that failed to load leaves the Play button", () => {
    const html = card({ playing: false, thumbnailFailed: true });
    expect(html).not.toContain("<img");
    expect(html).toContain(m.youtube_play({ title: "Demo" }));
  });
});

describe("a refused URL through the reply's Markdown renderer", () => {
  const render = (shortcode: string) =>
    renderToStaticMarkup(
      createElement(Streamdown, {
        components: { a: AgentAnchor } as never,
        children: renderableText(shortcode, new Set(), false),
      }),
    );

  test("an https address is ONE safe link labelled by the title, and no frame or image", () => {
    const html = render(`See [embed url="https://youtube.com.evil.tld/watch?v=${ID}" title="A *video* <b>x</b>" /] now`);
    expect(html.match(/<a /g)).toHaveLength(1);
    const link = attrsOf(html, "a");
    expect(unescape(link.href!)).toBe(`https://youtube.com.evil.tld/watch?v=${ID}`);
    expect(link).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
    expect(html).toContain("A *video* &lt;b&gt;x&lt;/b&gt;</a>");
    expect(html).not.toMatch(/<iframe|<img|<em>|<b>/);
  });

  test("a title cannot open a second link, and a hostile query stays inside the one href", () => {
    const ok = render(`[embed url="https://example.test/a b?q=)>(x" title="t)(https://evil.example)" /]`);
    expect(ok.match(/<a /g)).toHaveLength(1);
    expect(unescape(attrsOf(ok, "a").href!)).toBe("https://example.test/a%20b?q=)%3E(x");
    expect(ok).not.toContain('href="https://evil.example');
  });

  test("anything else stays the text the agent wrote", () => {
    const html = render(`[embed url="javascript:alert(1)" title="x" /]`);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<iframe");
    expect(html).toContain("[embed url=");
  });
});
