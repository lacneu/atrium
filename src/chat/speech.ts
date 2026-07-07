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
  start: () => void;
  stop: () => void;
};

function recognitionCtor(): (new () => RecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as new () => RecognitionLike) ??
    (w.webkitSpeechRecognition as new () => RecognitionLike) ??
    null
  );
}

export function dictationSupported(): boolean {
  return recognitionCtor() !== null;
}

export type DictationHandle = { stop: () => void };

/** Start a dictation session. `onText` receives the FINAL transcript pieces as
 *  they settle (interim results are not surfaced — the composer only ever gets
 *  committed text). Returns null when the browser has no engine. */
export function startDictation(opts: {
  lang: string;
  onText: (finalText: string) => void;
  onEnd: () => void;
  onError: (code: string) => void;
}): DictationHandle | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = opts.lang;
  rec.interimResults = false;
  rec.continuous = true;
  rec.onresult = (ev: unknown) => {
    const e = ev as {
      resultIndex: number;
      results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
    };
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r?.isFinal && r[0]?.transcript) opts.onText(r[0].transcript);
    }
  };
  rec.onend = opts.onEnd;
  rec.onerror = (ev: unknown) => {
    const code = String((ev as { error?: string }).error ?? "unknown");
    opts.onError(code);
  };
  try {
    rec.start();
  } catch {
    return null;
  }
  return { stop: () => rec.stop() };
}
