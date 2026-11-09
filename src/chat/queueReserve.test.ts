// @vitest-environment node
//
// THE END OF THE REPLY IS FOLLOWED ABOVE THE QUEUED CARDS (lot 29), by assistant-ui's
// REAL follow — ThreadPrimitive.Viewport and its useThreadViewportAutoScroll — with the
// app's real QueuedDock and every stylesheet the app loads, in a real Chrome: its
// frames, its transitions, under virtual time. The reader is at the end of a reply; a
// message is queued and no text arrives after it. Once the reserve's transition is
// over — at once under reduced motion — the transcript is at its end and the reply's
// bubble is above the cards. On lot 28 the reserve was a spacer that neither of the
// follow's observers saw grow: the transcript stopped short of its end, the bubble's
// foot under the cards.
import { join } from "node:path";
import { build, type Plugin, type Rollup } from "vite";
import { describe, expect, test } from "vitest";
import { followReserve, longestTimeMs } from "./queueReserve";
import { appCss, chromeOrFail, ROOT, runChromeLive } from "./browserProbe.testkit";

const ENTRY = "virtual:queue-reserve-probe";

// The page's code: plain createElement, the bundle's only source of its own.
const ENTRY_CODE = String.raw`
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useLocalRuntime } from "@assistant-ui/react";
import { QueuedDock } from "/src/chat/QueuedDock.tsx";
import { QueueDockContext } from "/src/chat/queueDockContext.ts";

const LINE = "Une ligne de la reponse, assez longue pour revenir a la ligne dans la colonne du fil. ";
const messages = Array.from({ length: 10 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: [{ type: "text", text: LINE.repeat(i % 2 ? 8 : 1) }],
}));
const adapter = { async *run() {} };
const Message = () => h(MessagePrimitive.Root, { className: "oc-msg" }, h(MessagePrimitive.Content, null));
let setQueued = null;
function Thread() {
  const [queued, set] = useState([]);
  setQueued = set;
  const dock = { queuedTurns: queued, cancelQueued: async () => true };
  return h(
    ThreadPrimitive.Root,
    { className: "oc-thread", style: { height: "600px" } },
    h(ThreadPrimitive.Viewport, { className: "oc-thread__viewport" }, h(ThreadPrimitive.Messages, { components: { Message } })),
    h("div", { className: "oc-scrolldown-anchor" }),
    h(QueueDockContext.Provider, { value: dock }, h(QueuedDock)),
    h(
      "form",
      { className: "oc-composer" },
      h("textarea", { className: "oc-composer__input", rows: 1 }),
      h("div", { className: "oc-composer__bar" }, h("button", { type: "button", className: "oc-composer__send" }, "Envoyer")),
    ),
  );
}
function App() {
  const runtime = useLocalRuntime(adapter, { initialMessages: messages });
  return h(AssistantRuntimeProvider, { runtime }, h(Thread));
}
createRoot(document.getElementById("root")).render(h(App));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const out = { errors: [], samples: [], stage: "mounted" };
  const write = () => (document.getElementById("out").textContent = JSON.stringify(out));
  write();
  try {
    await sleep(1500);
    out.stage = "settled";
    write();
    const vp = document.querySelector(".oc-thread__viewport");
    const atEnd = () => Math.abs(vp.scrollHeight - vp.scrollTop - vp.clientHeight) <= 1;
    out.before = { atEnd: atEnd(), bubbles: vp.querySelectorAll(".oc-msg").length, overflow: vp.scrollHeight > vp.clientHeight + 100 };
    out.transition = getComputedStyle(vp, "::after").transitionDuration;
    setQueued([{ messageId: "q1", text: "Un message mis en file pendant que l'agent travaille", pending: false, mine: true, canCancel: true }]);
    const t0 = performance.now();
    await new Promise((done) => {
      const frame = () => {
        const q = document.querySelector(".oc-queue-dock");
        const last = [...vp.querySelectorAll(".oc-msg")].pop();
        out.samples.push({
          t: Math.round(performance.now() - t0),
          atEnd: atEnd(),
          lastBottom: last.getBoundingClientRect().bottom,
          cardsTop: q ? q.getBoundingClientRect().top : null,
          reserve: vp.style.getPropertyValue("--oc-dock-pad"),
        });
        out.stage = "following";
        write();
        if (performance.now() - t0 < 1600) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
    out.stage = "done";
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  write();
})();
`;

type Sample = { t: number; atEnd: boolean; lastBottom: number; cardsTop: number | null; reserve: string };
type Out = { errors: string[]; stage: string; before: { atEnd: boolean; bubbles: number; overflow: boolean }; transition: string; samples: Sample[] };

/** The page's bundle: React, assistant-ui and the dock, as the app's build compiles them. */
async function bundle(): Promise<string> {
  const virtual: Plugin = {
    name: "queue-reserve-probe",
    resolveId: (id) => (id === ENTRY ? `\0${ENTRY}` : null),
    load: (id) => (id === `\0${ENTRY}` ? ENTRY_CODE : null),
  };
  const res = await build({
    root: ROOT,
    configFile: false,
    logLevel: "error",
    plugins: [virtual],
    resolve: { alias: { "@": join(ROOT, "src") } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // The production JSX runtime, as React itself is bundled here (vitest's own
    // NODE_ENV would make Vite emit the development one).
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

function page(css: string, code: string): string {
  // An error before the scenario writes its result is the result.
  const onError = `addEventListener("error", (e) => { document.getElementById("out").textContent = JSON.stringify({ errors: [String(e.message) + " at " + e.lineno], before: null, transition: "", samples: [] }); });`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>${css}</style></head><body><pre id="out"></pre><div id="root"></div><script>${onError}</script><script type="module">${code.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

describe("the reserve's follow, unit by unit (lot 29)", () => {
  test("a transition's longest time, in ms", () => {
    expect(longestTimeMs("0.2s")).toBe(200);
    expect(longestTimeMs("0s, 150ms")).toBe(150);
    expect(longestTimeMs("")).toBe(0);
  });
  test("it asks nothing of a reader who is not at the end", () => {
    let asked = 0;
    const store = { getState: () => ({ isAtBottom: false, scrollToBottom: () => void asked++ }) };
    const stop = followReserve({ ownerDocument: { defaultView: null } } as unknown as HTMLElement, store);
    stop();
    expect(asked).toBe(0);
  });
});

const chrome = chromeOrFail("queueReserve.test.ts");

describe.skipIf(chrome === null)("the end of the reply is followed above the queued cards — assistant-ui's own follow, in Chrome (lot 29)", () => {
  const ready = (async () => {
    const [css, code] = await Promise.all([appCss(), bundle()]);
    const html = page(css, code);
    // Real time: virtual time runs no animation frame and no transition.
    const runs = {
      motion: await runChromeLive<Out>(chrome!, html),
      reduced: await runChromeLive<Out>(chrome!, html, { media: [{ name: "prefers-reduced-motion", value: "reduce" }] }),
    };
    return runs;
  })();

  const check = (out: Out, settledFrom: number) => {
    expect(out.errors).toEqual([]);
    // The reader is at the end of a transcript that scrolls.
    expect(out.before).toEqual({ atEnd: true, bubbles: 10, overflow: true });
    const shown = out.samples.filter((s) => s.cardsTop !== null);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[shown.length - 1].reserve).not.toBe("");
    const settled = out.samples.filter((s) => s.t >= settledFrom);
    expect(settled.length).toBeGreaterThan(10);
    const bad = settled
      .filter((s) => !s.atEnd || s.cardsTop === null || s.lastBottom > s.cardsTop + 0.5)
      .map((s) => `${s.t} ms: ${s.atEnd ? "at the end" : "short of the end"}, bubble's foot ${s.lastBottom.toFixed(1)} vs cards ${s.cardsTop?.toFixed(1)}`);
    expect(bad).toEqual([]);
  };

  test("with the reserve's transition: once it is over, at the end, the bubble above the cards", async () => {
    const { motion } = await ready;
    expect(longestTimeMs(motion.transition)).toBeGreaterThan(0);
    check(motion, 900);
  }, 240_000);

  test("under reduced motion: no transition, and the follow is there at once", async () => {
    const { reduced } = await ready;
    expect(longestTimeMs(reduced.transition)).toBe(0);
    check(reduced, 300);
  }, 240_000);
});
