// @vitest-environment node
//
// THE CARD RE-USED FOR ANOTHER VIDEO, IN A REAL CHROME. assistant-ui keeps a message part by
// its index, so the same YouTubeVideoPart can be handed a different video while its state
// still says "playing". The click authorized ONE video: no frame for another may ever reach
// the DOM — not even for the one commit before an effect would have reset the state. Every
// address a frame is given is recorded as it is set, so a frame that lived for one commit
// (or a frame of the previous video re-pointed at the next one) is caught.

import { build, type Plugin, type Rollup } from "vite";
import { describe, expect, test } from "vitest";

import { chromeOrFail, ROOT, runChrome } from "../browserProbe.testkit";
import { youTubePlayerUrl, youTubeVideoAddresses } from "./youtubeVideo";

const A = "AbC123_-xyz";
const B = "ZyX987_-abc";
const playerOf = (videoId: string) => youTubePlayerUrl(youTubeVideoAddresses({ videoId, startSeconds: 0 })!);

const ENTRY = "virtual:youtube-replace-probe";
const ENTRY_CODE = String.raw`
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { YouTubeVideoPart } from "/src/chat/widgets/YouTubeVideoPart.tsx";

const host = document.getElementById("root");
// Every address a frame is given, when it is given: React may re-use the frame of the
// previous video and only change its src, which no insertion record would show.
const frames = [];
const setAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name, value) {
  if (this.tagName === "IFRAME" && name === "src") frames.push(String(value));
  return setAttribute.call(this, name, value);
};
const srcOf = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
Object.defineProperty(HTMLIFrameElement.prototype, "src", {
  ...srcOf,
  set(value) {
    frames.push(String(value));
    srcOf.set.call(this, value);
  },
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const root = createRoot(host);
const show = (videoId) =>
  flushSync(() => root.render(h(YouTubeVideoPart, { data: { videoId, startSeconds: 0, title: videoId } })));
const play = () => flushSync(() => host.querySelector("button.oc-youtube__preview").click());
const state = () => ({
  frames: frames.slice(),
  frameNow: host.querySelector("iframe")?.getAttribute("src") ?? null,
  playButton: host.querySelector("button.oc-youtube__preview") !== null,
});

(async () => {
  const out = {};
  try {
    show("${A}");
    await tick();
    play();
    await tick();
    out.clicked = state();
    show("${B}");
    await tick();
    out.replaced = state();
    show("${A}");
    await tick();
    out.returned = state();
    show("${B}");
    await tick();
    play();
    await tick();
    out.clickedB = state();
    show("${A}");
    await tick();
    out.back = state();
  } catch (e) {
    out.error = String(e && e.stack || e);
  }
  document.getElementById("out").textContent = JSON.stringify(out);
})();
`;

/** The page's bundle: React and the card, as the app's build compiles them. */
async function bundle(): Promise<string> {
  const virtual: Plugin = {
    name: "youtube-replace-probe",
    resolveId: (id) => (id === ENTRY ? `\0${ENTRY}` : null),
    load: (id) => (id === `\0${ENTRY}` ? ENTRY_CODE : null),
  };
  const res = await build({
    root: ROOT,
    configFile: false,
    logLevel: "error",
    plugins: [virtual],
    resolve: { alias: { "@": `${ROOT}/src` } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    oxc: { jsx: { runtime: "automatic", development: false } },
    build: {
      write: false,
      minify: false,
      modulePreload: false,
      rollupOptions: { input: ENTRY, output: { format: "es", codeSplitting: false } },
    },
  });
  const output = (Array.isArray(res) ? res[0] : res) as Rollup.RollupOutput;
  const entry = output.output.find((o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry);
  if (!entry) throw new Error("no bundle");
  return entry.code;
}

type State = { frames: string[]; frameNow: string | null; playButton: boolean };
type Out = { clicked: State; replaced: State; returned: State; clickedB: State; back: State; error?: string };

const chrome = chromeOrFail("youTubeVideoReplace.test.ts");

describe.skipIf(chrome === null)("a card handed another video while it plays (Chrome)", () => {
  test("only the clicked video is ever framed; the next one waits for its own click", async () => {
    const code = await bundle();
    const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out"></pre><div id="root"></div><script type="module">${code.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
    // No network: the frame's address is what is asserted, never what it would load.
    const out = await runChrome<Out>(chrome!, page, { flags: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
    expect(out.error).toBeUndefined();

    // The click on A frames A, once.
    expect(out.clicked.frames).toEqual([playerOf(A)]);
    expect(out.clicked.frameNow).toBe(playerOf(A));

    // A replaced by B without a click: no frame for B was ever inserted, and B offers Play.
    expect(out.replaced.frames).toEqual([playerOf(A)]);
    expect(out.replaced.frameNow).toBeNull();
    expect(out.replaced.playButton).toBe(true);

    // Back to A, still without a click: the earlier click on A does not come back with it.
    expect(out.returned.frames).toEqual([playerOf(A)]);
    expect(out.returned.frameNow).toBeNull();
    expect(out.returned.playButton).toBe(true);

    // B's own click frames B.
    expect(out.clickedB.frames).toEqual([playerOf(A), playerOf(B)]);
    expect(out.clickedB.frameNow).toBe(playerOf(B));

    // Back to A after B played: B's click authorizes nothing for A.
    expect(out.back.frames).toEqual([playerOf(A), playerOf(B)]);
    expect(out.back.frameNow).toBeNull();
    expect(out.back.playButton).toBe(true);
  }, 240_000);
});
