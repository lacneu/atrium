// Browser voice seam (Web Speech API) — the ONLY module touching
// speechSynthesis / SpeechRecognition. Read-aloud (TTS) + dictation (STT) run
// entirely in the user's browser: no API key, no gateway round-trip, and they
// work identically for OpenClaw and Hermes instances (the per-instance config
// only carries language/rate/auto-read knobs).
//
// The markdown→speech text pass and the config resolution are PURE (unit
// tested); the speak/dictation wrappers are thin, defensive adapters over the
// browser objects (feature-detected — absent engines degrade to "unsupported",
// never a crash).

/** Per-instance voice settings as the chat surface consumes them. */
export type ChatVoiceConfig = {
  enabled: boolean;
  /** BCP-47 tag or "auto" (follow the UI locale). */
  lang: string;
  /** 0.5..2 (1 = normal). */
  rate: number;
  autoRead: boolean;
  /** Read-aloud engine: "browser" (Web Speech) or "gateway" (instance TTS). */
  engine: string;
};

/** Resolve "auto" to a concrete BCP-47 tag using the UI locale. */
export function resolveSpeechLang(
  configLang: string,
  uiLocale: string,
): string {
  if (configLang && configLang !== "auto") return configLang;
  // The UI locale is "fr"/"en" — widen to the canonical regional tag the
  // speech engines ship voices for.
  if (uiLocale.startsWith("fr")) return "fr-FR";
  if (uiLocale.startsWith("en")) return "en-US";
  return uiLocale || "fr-FR";
}

/** Markdown → speakable text: strip the constructs that read as noise
 *  (fences/code, links → their label, images dropped, emphasis markers,
 *  headings/list bullets, tables flattened). Pure. */
export function stripMarkdownForSpeech(md: string): string {
  let t = md;
  // fenced code blocks: announce, don't spell out
  t = t.replace(/```[\s\S]*?```/g, " (bloc de code) ");
  t = t.replace(/`([^`]+)`/g, "$1");
  // images gone, links keep their label
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // headings / blockquotes / list markers / hrules
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/^\s*>\s?/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+\.\s+/gm, "");
  t = t.replace(/^\s*([-_*]\s*){3,}$/gm, " ");
  // tables: cells become comma-separated prose
  t = t.replace(/^\s*\|(.+)\|\s*$/gm, (_, row: string) =>
    row
      .split("|")
      .map((c: string) => c.trim())
      .filter((c: string) => c && !/^:?-{2,}:?$/.test(c))
      .join(", "),
  );
  // emphasis markers
  t = t.replace(/(\*\*|__|\*|_|~~)/g, "");
  // collapse whitespace
  t = t.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, ". ").replace(/\n/g, " ");
  return t.trim();
}

// ---------------------------------------------------------------------------
// Read-aloud (speechSynthesis)
// ---------------------------------------------------------------------------

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Speak `text`; only ONE utterance at a time (starting a new one cancels the
 *  previous — the natural "read this instead" gesture). `onEnd` fires on both
 *  natural end and cancellation. */
export function speakText(
  text: string,
  opts: { lang: string; rate: number; onEnd?: () => void },
): boolean {
  if (!ttsSupported()) return false;
  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = opts.lang;
  u.rate = Math.min(2, Math.max(0.5, opts.rate || 1));
  if (opts.onEnd) {
    u.onend = opts.onEnd;
    u.onerror = opts.onEnd;
  }
  // Chrome swallows an utterance queued in the SAME tick as cancel() — only
  // cancel when something is playing, and give the engine a beat before the
  // new speak.
  if (synth.speaking || synth.pending) {
    synth.cancel();
    window.setTimeout(() => synth.speak(u), 60);
  } else {
    synth.speak(u);
  }
  return true;
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

// ---------------------------------------------------------------------------
// Dictation (SpeechRecognition)
// ---------------------------------------------------------------------------

type RecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onaudioend?: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as RecognitionCtor) ??
    (w.webkitSpeechRecognition as RecognitionCtor) ??
    null
  );
}

export function dictationSupported(): boolean {
  return recognitionCtor() !== null;
}

/** `stop()`: the user ends the dictation — the engine settles what it heard (a trailing
 *  final may still arrive), then `onEnd`. `discard()`: the dictation ends and NOTHING it
 *  still holds is delivered — the caller already took the visible text (send while
 *  dictating); only `onEnd` follows. */
export type DictationHandle = { stop: () => void; discard: () => void };

/** A long silence between two FINAL transcript segments reads as a spoken
 *  paragraph break: the next committed piece is flagged so the composer can
 *  open a new paragraph instead of gluing everything into one block —
 *  long dictated prompts stay structured hands-free. */
const DICTATION_PARAGRAPH_PAUSE_MS = 2_500;

/** Errors after which the engine cannot continue: the dictation ends and says why. Any
 *  other end (Chrome closes a session on silence, on its own session cap, on a network
 *  hiccup) is not the user's doing: the dictation goes on in a fresh session. `aborted`
 *  is here because something else took the recognizer — restarting would fight it. */
const FATAL_DICTATION_ERRORS: ReadonlySet<string> = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
  "language-not-supported",
  "aborted",
]);

/** The pause before each consecutive restart of a session that heard nothing and either
 *  ended at once or went deaf (its audio closed without an end); past the last one the
 *  engine is declared unable to continue (`DICTATION_ENGINE_GAVE_UP`). Only SPEECH proves
 *  an engine healthy: a session that delivered a result resets every count, so a long
 *  dictation never runs out. */
export const DICTATION_RESTART_DELAYS_MS: readonly number[] = [0, 300, 1_000, 2_500];
/** Under this, a session that heard nothing ended "at once". */
const DICTATION_QUICK_END_MS = 3_000;
/** Consecutive silent sessions the browser closed on its own (it ends one after a few
 *  seconds of silence) before the dictation stops: about a minute and a half of silence
 *  with Chrome's no-speech timeout — a pause to think never ends it, a forgotten mic
 *  eventually does, and says so. */
export const DICTATION_SILENT_SESSIONS_MAX = 12;
/** After the user's stop, how long the engine may go WITHOUT PROGRESS (no result) before
 *  the dictation ends anyway — delivering, once, the hypothesis still on screen. Every
 *  result re-arms it: an engine still settling is never cut. `DICTATION_STOP_MAX_MS`
 *  bounds the whole wait since the stop, so an engine that never stops talking cannot
 *  hold the dictation open. */
export const DICTATION_STOP_GRACE_MS = 5_000;
export const DICTATION_STOP_MAX_MS = 20_000;
/** The engine closed its audio but never said the session ended: past this WITHOUT
 *  PROGRESS (every result re-arms it), the session is treated as ended (deaf engine) and a
 *  new one opens. Auto-restart only: after the user's stop, the stop grace decides. */
const DICTATION_AUDIO_END_GRACE_MS = 3_000;

/** The error code `onError` receives when the engine kept ending and could not be
 *  restarted. */
export const DICTATION_ENGINE_GAVE_UP = "engine-gave-up";

/** Start a dictation. `onText` receives the FINAL transcript pieces as they settle
 *  (`paragraph` = a long pause preceded this piece). `onInterim` (optional) streams the
 *  engine's CURRENT in-flight hypothesis — display-only ghost text, replaced on every
 *  event and cleared ("") when the segment finalizes.
 *
 *  ONE dictation spans as many engine sessions as it needs: the browser ends a session on
 *  its own (silence, its session cap, a network hiccup) while the user is still dictating
 *  — that used to leave the mic button lit over a deaf engine (0.103.1). Such an end
 *  opens a new session with the same callbacks; a fresh session restarts its result list,
 *  so nothing already delivered is delivered twice, and a hypothesis the closing session
 *  never finalized is delivered as final (the reader saw it). `onEnd` fires exactly once,
 *  when the dictation is really over: the user stopped, a fatal error (`onError` first),
 *  or the engine could not be restarted (`onError(DICTATION_ENGINE_GAVE_UP)` first).
 *  Returns null when the browser has no engine or refuses to start. */
export function startDictation(opts: {
  lang: string;
  onText: (finalText: string, meta: { paragraph: boolean }) => void;
  onInterim?: (interimText: string) => void;
  onEnd: () => void;
  onError: (code: string) => void;
}): DictationHandle | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const now = () => Date.now();
  const setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms);
  const clearTimer = (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>);

  let lastFinalAt = 0;
  // The SILENT gap ends when the next segment starts SPEAKING — its first
  // interim hypothesis, not its final (which lands after the whole sentence
  // and would count speech time as pause; a long sentence is no paragraph).
  let segmentStartAt: number | null = null;
  let current: RecognitionLike | null = null;
  let sessionStartedAt = 0;
  let heardThisSession = false;
  let quickEnds = 0;
  let silentEnds = 0;
  let pendingInterim = "";
  let stopped = false;
  let discarded = false;
  let fatal = false;
  let finished = false;
  let restartTimer: unknown = null;
  let deafTimer: unknown = null;
  let stopGraceTimer: unknown = null;
  let stoppedAt = 0;
  /** The deaf watchdog's / stop grace's re-arm on progress (set while one is armed). */
  let rearmDeaf: (() => void) | null = null;
  let rearmStopGrace: (() => void) | null = null;

  const clearDeaf = () => {
    if (deafTimer !== null) clearTimer(deafTimer);
    deafTimer = null;
    rearmDeaf = null;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearDeaf();
    if (restartTimer !== null) clearTimer(restartTimer);
    restartTimer = null;
    if (stopGraceTimer !== null) clearTimer(stopGraceTimer);
    stopGraceTimer = null;
    rearmStopGrace = null;
    current = null;
    if (!discarded) opts.onInterim?.("");
    opts.onEnd();
  };

  const deliverFinal = (text: string) => {
    const spokeAt = segmentStartAt ?? now();
    const paragraph = lastFinalAt !== 0 && spokeAt - lastFinalAt > DICTATION_PARAGRAPH_PAUSE_MS;
    lastFinalAt = now();
    segmentStartAt = null;
    opts.onText(text, { paragraph });
  };

  /** A session is over (its `end`, or a deaf engine): settle it, then go on or finish. */
  const sessionOver = (rec: RecognitionLike, deaf = false) => {
    if (rec !== current) return;
    current = null;
    clearDeaf();
    // What the closing session heard but never finalized: the reader saw it. (A final
    // clears it, so it is never delivered twice; a discard delivers nothing.)
    if (!discarded && !fatal && pendingInterim.trim() !== "") deliverFinal(pendingInterim);
    pendingInterim = "";
    if (stopped || fatal) {
      finish();
      return;
    }
    if (heardThisSession) {
      quickEnds = 0;
      silentEnds = 0;
    } else if (deaf || now() - sessionStartedAt < DICTATION_QUICK_END_MS) {
      // A deaf session's watchdog wait is no proof of health: it counts as a failure.
      quickEnds += 1;
    } else {
      silentEnds += 1;
    }
    if (quickEnds > DICTATION_RESTART_DELAYS_MS.length || silentEnds > DICTATION_SILENT_SESSIONS_MAX) {
      opts.onError(DICTATION_ENGINE_GAVE_UP);
      finish();
      return;
    }
    opts.onInterim?.("");
    const delay = quickEnds === 0 ? 0 : (DICTATION_RESTART_DELAYS_MS[quickEnds - 1] ?? 0);
    restartTimer = setTimer(() => {
      restartTimer = null;
      if (stopped) {
        finish();
        return;
      }
      if (!open()) {
        opts.onError(DICTATION_ENGINE_GAVE_UP);
        finish();
      }
    }, delay);
  };

  const open = (): boolean => {
    const rec = new Ctor();
    rec.lang = opts.lang;
    rec.interimResults = opts.onInterim !== undefined;
    rec.continuous = true;
    rec.onresult = (ev: unknown) => {
      if (rec !== current || discarded) return;
      const e = ev as {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      };
      const at = now();
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r?.[0]?.transcript) continue;
        heardThisSession = true;
        if (r.isFinal) deliverFinal(r[0].transcript);
        else interim += r[0].transcript;
      }
      if (interim !== "" && segmentStartAt === null) segmentStartAt = at;
      pendingInterim = interim;
      // PROGRESS: the engine is still working — the timers that would cut it start over.
      rearmDeaf?.();
      rearmStopGrace?.();
      // Always publish (including "") so a finalized segment clears the ghost.
      opts.onInterim?.(interim);
    };
    rec.onend = () => sessionOver(rec);
    rec.onerror = (ev: unknown) => {
      if (rec !== current) return;
      const code = String((ev as { error?: string }).error ?? "unknown");
      // Our own stop/discard can surface as `aborted`: not an error then.
      if (stopped) return;
      if (FATAL_DICTATION_ERRORS.has(code)) {
        fatal = true;
        opts.onError(code);
      }
      // Any other error is followed by the session's `end`, which restarts it.
    };
    rec.onaudioend = () => {
      // Capture ended, recognition may still be settling: after a stop, the stop's grace
      // waits for it — no watchdog.
      if (rec !== current || stopped) return;
      clearDeaf();
      const arm = () => {
        if (deafTimer !== null) clearTimer(deafTimer);
        deafTimer = setTimer(() => {
          deafTimer = null;
          rearmDeaf = null;
          if (rec !== current || stopped) return;
          try {
            rec.abort?.();
          } catch {
            // already gone
          }
          sessionOver(rec, true);
        }, DICTATION_AUDIO_END_GRACE_MS);
      };
      rearmDeaf = arm;
      arm();
    };
    current = rec;
    sessionStartedAt = now();
    heardThisSession = false;
    try {
      rec.start();
    } catch {
      current = null;
      return false;
    }
    return true;
  };

  if (!open()) return null;

  const end = (mode: "stop" | "discard") => {
    if (finished) return;
    stopped = true;
    if (mode === "discard") discarded = true;
    const rec = current;
    if (rec === null) {
      // Between two sessions: nothing is listening, the dictation ends here.
      finish();
      return;
    }
    clearDeaf();
    if (mode === "stop") {
      stoppedAt = now();
      const arm = () => {
        if (stopGraceTimer !== null) clearTimer(stopGraceTimer);
        const left = Math.min(DICTATION_STOP_GRACE_MS, Math.max(0, stoppedAt + DICTATION_STOP_MAX_MS - now()));
        stopGraceTimer = setTimer(() => {
          stopGraceTimer = null;
          rearmStopGrace = null;
          if (rec !== current) return;
          // The engine never settled: what it showed is delivered once, later events of
          // this session are ignored (it is no longer current), then the dictation ends.
          try {
            rec.abort?.();
          } catch {
            // already gone
          }
          sessionOver(rec);
        }, left);
      };
      rearmStopGrace = arm;
      arm();
    }
    try {
      if (mode === "discard" && rec.abort !== undefined) rec.abort();
      else rec.stop();
    } catch {
      sessionOver(rec);
    }
  };
  return { stop: () => end("stop"), discard: () => end("discard") };
}

// ---------------------------------------------------------------------------
// Gateway-audio playback (the "gateway voice" engine): plays a base64 clip the
// instance's gateway synthesized. Single active clip — starting a new one (or
// stopGatewayAudio / stopSpeaking-style toggles) stops the previous.
// ---------------------------------------------------------------------------

let activeClip: HTMLAudioElement | null = null;

export function playGatewayAudio(
  base64: string,
  mime: string,
  opts?: { rate?: number; onEnd?: () => void },
): boolean {
  try {
    stopGatewayAudio();
    const audio = new Audio(`data:${mime};base64,${base64}`);
    // The gateway synthesizes at 1×; speed is applied on PLAYBACK (the only
    // rate lever for gateway audio — tts.convert takes no speed param). This
    // shifts pitch slightly, acceptable in the 0.75–1.5 range the UI offers.
    audio.playbackRate = Math.min(2, Math.max(0.5, opts?.rate ?? 1));
    activeClip = audio;
    if (opts?.onEnd) {
      audio.onended = opts.onEnd;
      audio.onerror = opts.onEnd;
    }
    // play() is a promise — autoplay policies can reject it asynchronously;
    // surface that as "ended" so the button never sticks in speaking state.
    audio.play().catch(() => opts?.onEnd?.());
    return true;
  } catch {
    return false;
  }
}

export function stopGatewayAudio(): void {
  if (activeClip) {
    activeClip.pause();
    activeClip.onended = null;
    activeClip.onerror = null;
    activeClip = null;
  }
}

