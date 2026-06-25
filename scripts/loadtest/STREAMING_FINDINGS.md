# Streaming latency — diagnosis & findings

Investigation into "the streaming reply lags MORE as it gets longer, the OpenClaw
Control UI doesn't". Reproduced and measured locally with the load harness
(`run.mjs`, extended for this) + a `chrome-devtools` frame probe on the real UI.

## TL;DR

A latency that **grows with reply length** is an **O(n²)** signature, not WAN or
model latency (those are constant per token). There are **two** independent O(n²)
costs, both rooted in re-processing the *whole growing reply on every token*:

1. **Client markdown re-parse (DOMINANT, user-visible).** react-markdown re-parses
   the entire growing string on every streamed token → O(n²) parse. This is the
   jank you see. **Plain text does NOT have it** (proof below).
2. **Convex reactive re-push (network/bandwidth).** `getStreamingText` returns the
   full live text; Convex re-sends the **whole** result on every change, so a reply
   streamed in K deltas pushes ~K/2× its own size over the socket. Convex's own
   docs call this out as the reason their `persistent-text-streaming` component
   exists.

What was NOT the cause: backend saturation (Convex Cloud probe = ~11–14 ms),
the `appendDelta` write (flat — see below), WAN distance, or the LLM.

## Measurements

### Server / network (harness — `run.mjs`)
Added two metrics (`scripts/loadtest/run.mjs`):
- **appendDelta WRITE latency, early vs late** — is the per-delta write O(1) or O(n)?
- **push amplification** = Σ(live-text bytes a subscriber received) / final length —
  ≈1 means incremental delivery, ~K/2 means the full text is re-sent every delta.

`node scripts/loadtest/run.mjs --users 1 --chats 1 --deltas 150 --deltaChars 12 --deltaMs 40`

```
appendDelta WRITE latency early=17.1ms vs late=17.4ms  -> ×1.01  (FLAT — write is not the problem)
push amplification (cum bytes / final len)             -> 75.5   (= K/2 — FULL text re-sent each delta)
```
→ The write is fine; Convex re-pushes the full growing text every delta (O(n²) bytes).
For a ~1.8 KB reply the subscriber receives ~136 KB. **Measured**: the single growing
`text` field is re-sent in full (75.5×, not ~1×). **Inferred (NOT measured)**: that a
`streamingChunks` array read via `.collect()` would re-push fully too — likely, given
this result + that Convex built an HTTP-stream component instead of recommending chunk
rows, but a 30-line throwaway (a tiny table + growing-array query + the push-amplitude
metric) would settle it before anyone designs the network fix around chunk storage.
Incremental reactive delivery would otherwise need `usePaginatedQuery`-style paging.

**Metric caveats (don't over-read these numbers):**
- *Push amplification UNDERCOUNTS.* It sums bytes per subscriber `onUpdate`, but Convex
  may coalesce several rapid `appendDelta` writes into one query re-run — so under
  concurrency / fast deltas the ratio drops below the true K/2. The clean number here
  (75.5 ≈ (K+1)/2, K=150) is from a SINGLE subscriber at `--deltaMs 40`; treat it as a
  floor, not a tight figure, under load.
- *The write-latency split is RTT-dominated.* At ~1.8 KB the per-delta HTTP round-trip
  dwarfs the row rewrite, so "FLAT ×1.01" proves the write isn't the problem AT THIS
  SIZE — it does NOT prove the rewrite is O(1) (a genuine O(n) rewrite would only
  surface at much larger texts). Adequate for ranking causes; not a proof of O(1).

### Client render (chrome-devtools frame probe on the real UI)
rAF inter-frame gap (a frame >32 ms = dropped/jank), split early/mid/late thirds of
one streamed reply on `localhost:5174`, driven by `drive-one.mjs`:

220-delta reply (~4 KB), thirds:

| content | early gap | mid | late | late jank |
|---|---|---|---|---|
| **markdown** (before fix)        | 12 ms | 25 ms | **41 ms** | **76 %** |
| **plain text** (same length)     |  9 ms |  8 ms | **9 ms**  | **0 %**  |
| **markdown + fix** (this change) | 11 ms | 12 ms | **23 ms** | **26 %** |

→ Plain text is **flat** even though the client still receives the full growing text
each push — so the cost is the **markdown parse**, not the network deserialize. The
late third is where it hurts (matches "lags more over time").

**The fix is partial — it does not cover very long replies.** A 500-delta markdown
drive (post-fix) stays janky throughout (per-frame gap 46 → 88 ms across quartiles,
~100% dropped frames). The residual O(n²) parse dominates again once the reply is big
enough. (Absolute numbers there are inflated — that drive ran on a chat already
holding several prior synthetic replies, so the base DOM was heavy; the *trend* is
the real signal.) **Beyond ~moderate length, block-split (below) is required.**

NB: a naive `longtask` probe (>50 ms only) reported "3 long tasks" and falsely
suggested render was cheap — the per-token renders grow from ~2 ms to ~40 ms, almost
all *under* the 50 ms longtask threshold. Use the rAF gap probe, not longtask.

## What this change ships (low-risk, client-only)

`src/chat/MarkdownText.tsx` — TWO INDEPENDENT changes; either can be reverted alone:

- **`smooth={false}`** — ⚠️ this is a USER-FACING behaviour change. The smooth-reveal
  animation re-rendered (and re-parsed) the full text on every animation frame,
  multiplying the parse frequency above the delta rate. Removing it is the main lever
  (late gap 41→23 ms, jank 76%→26% on the 220-delta reply) and makes text appear
  token-as-it-arrives — arguably closer to the Control UI feel the user likes, but it
  IS a change to the streaming animation. Revert = delete this one line.
- **`unstable_memoizeMarkdownComponents`** (the `components` map) — per-block
  `React.memo` keyed by the parsed hast node, so unchanged blocks skip
  *reconcile/DOM/layout*. NOT cleanly isolated in an A/B here: in the smooth=true
  regime its effect was small (41→39 ms) because the *parse* dominates, not reconcile.
  Kept as the assistant-ui-recommended baseline and because reconcile/DOM cost clearly
  matters for large DOMs (the 500-delta run above). Revert = restore `components={{ a: AgentAnchor }}`.

Verified: headings/lists/code blocks/inline code/blockquotes/links all still render;
`tsc` + `vite build` clean; `markdownLinks` tests pass.

## What remains (bigger, needs a decision)

1. **Block-split the markdown parse — completes the client fix.** The residual O(n²)
   is react-markdown re-parsing the whole string each token. Parsing only the last
   (growing) block and memoizing completed blocks by source string makes per-token
   parse O(1). Options: a custom block-splitting renderer, or `streamdown`. Risk:
   it replaces/augments the markdown renderer (a UX-sensitive surface; would re-home
   assistant-ui's code-block handling and the smooth option) — worth doing with a UX
   sign-off, not blind.
2. **Incremental live delivery — fixes the network re-push.** Convex re-sends the full
   text per delta. The Convex-recommended pattern is HTTP streaming
   (`persistent-text-streaming`), but it is *client-driven* and Atrium's live text is
   *bridge-pushed*, so it doesn't drop in. An adapted design: a Convex HTTP action
   that streams DB-backed chunks (the bridge writes append-only chunks; the client
   reads the HTTP stream incrementally; the reactive query serves only history /
   other clients). Bigger architectural change — for the user to prioritise.
   Cheaper partial mitigation: coarsen the bridge flush cadence (fewer full re-pushes;
   amplification drops linearly with the number of pushes) at the cost of chunkier
   streaming.

## Tooling added (reusable)

- `run.mjs` — new metrics: appendDelta early-vs-late write latency, push amplification,
  `--deltaChars` to reach realistic reply sizes.
- `drive-one.mjs` — drive ONE synthetic turn on an EXISTING chat (`<chatId> [deltas]
  [deltaChars] [deltaMs] [plain|md]`); companion for the browser/perf-trace repro.
  `md` streams realistic markdown; finalizes with the same accumulated text.

### Reproduce the client measurement
1. `bash dev.sh` (Convex :3212/:3213 + Vite :5174), open a chat, copy its `/chat/<id>`.
2. In the DevTools console, install an rAF inter-frame-gap probe:
   ```js
   window.__fm = { frames: [] };
   let last = performance.now();
   (function tick(now){ const g = now - last; last = now;
     if (window.__fm.frames.length < 5000) window.__fm.frames.push({ ts: Date.now(), gap: Math.round(g) });
     requestAnimationFrame(tick); })(performance.now());
   ```
3. Drive a turn (note the `START=`/`END=` epochs it prints on stderr):
   `node scripts/loadtest/drive-one.mjs <chatId> 220 0 25 md`
4. Read the gaps, split by thirds of the [START,END] window:
   ```js
   const start=START, end=END, f=window.__fm.frames.filter(x=>x.ts>=start&&x.ts<=end), d=end-start;
   const seg=(a,b)=>f.filter(x=>x.ts>=start+d*a&&x.ts<start+d*b).map(x=>x.gap);
   const st=a=>a.length?{n:a.length,avg:Math.round(a.reduce((p,c)=>p+c)/a.length),jank32:a.filter(g=>g>32).length}:{n:0};
   ({early:st(seg(0,.33)), mid:st(seg(.33,.66)), late:st(seg(.66,1))});
   ```
5. Compare with `... 220 18 25 plain` — markdown grows late, plain stays flat. Use a
   FRESH empty chat per run; prior replies inflate the baseline.
