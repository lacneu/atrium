// THE DICTATION OUTLIVES THE BROWSER'S SESSION (0.103.1). Chrome ends a recognition
// session on its own — silence, its session cap, a network hiccup — while the user is still
// dictating. The mic button stayed lit over a deaf engine: the user had to turn it off and
// on to go on. One dictation now spans as many engine sessions as it needs, and ends — with
// the button — only when the user stops, a fatal error happens, or the engine cannot be
// restarted. A fake recognizer stands in for the browser's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DICTATION_SILENT_SESSIONS_MAX,
  DICTATION_STOP_GRACE_MS,
  DICTATION_STOP_MAX_MS,
  startDictation,
} from "./speech";

type Result = { isFinal: boolean; 0: { transcript: string } };

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static failStartAfter = Infinity;
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((ev: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onaudioend: (() => void) | null = null;
  started = false;
  stopCalls = 0;
  abortCalls = 0;
  private results: Result[] = [];
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.instances.length > FakeRecognition.failStartAfter) {
      throw new Error("InvalidStateError");
    }
    this.started = true;
  }
  stop() {
    this.stopCalls++;
  }
  abort() {
    this.abortCalls++;
  }
  /** The engine hears something: a hypothesis, or a final. */
  hear(transcript: string, isFinal: boolean) {
    const last = this.results[this.results.length - 1];
    const index = last !== undefined && !last.isFinal ? this.results.length - 1 : this.results.length;
    this.results[index] = { isFinal, 0: { transcript } };
    this.onresult?.({ resultIndex: index, results: this.results });
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
  end() {
    this.onend?.();
  }
}

const latest = () => FakeRecognition.instances[FakeRecognition.instances.length - 1]!;

function dictate() {
  const texts: string[] = [];
  const interims: string[] = [];
  const errors: string[] = [];
  let ends = 0;
  const handle = startDictation({
    lang: "fr-FR",
    onText: (t) => texts.push(t),
    onInterim: (t) => interims.push(t),
    onEnd: () => {
      ends++;
    },
    onError: (code) => errors.push(code),
  });
  return { handle, texts, interims, errors, ends: () => ends };
}

beforeEach(() => {
  FakeRecognition.instances = [];
  FakeRecognition.failStartAfter = Infinity;
  vi.useFakeTimers();
  vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a dictation the browser ends on its own", () => {
  it("goes on in a fresh session, without the user doing anything", () => {
    const d = dictate();
    const first = latest();
    first.hear("bonjour", true);
    first.end(); // Chrome closes the session (its cap, silence, a hiccup)
    vi.runOnlyPendingTimers();
    expect(FakeRecognition.instances.length).toBe(2);
    expect(latest().started).toBe(true);
    expect(d.ends()).toBe(0); // the button stays lit, and the mic is live again
    latest().hear("le monde", true);
    expect(d.texts).toEqual(["bonjour", "le monde"]);
  });

  it("delivers each final once — the new session's results start over", () => {
    const d = dictate();
    latest().hear("un", true);
    latest().end();
    vi.runOnlyPendingTimers();
    latest().hear("deux", true);
    latest().end();
    vi.runOnlyPendingTimers();
    latest().hear("trois", true);
    expect(d.texts).toEqual(["un", "deux", "trois"]);
  });

  it("keeps a hypothesis the closing session never finalized — the reader saw it", () => {
    const d = dictate();
    latest().hear("en cours de phr", false);
    latest().end();
    vi.runOnlyPendingTimers();
    expect(d.texts).toEqual(["en cours de phr"]);
    expect(d.interims[d.interims.length - 1]).toBe(""); // the ghost is cleared
  });

  it("ignores a late event of a session it already replaced", () => {
    const d = dictate();
    const old = latest();
    old.hear("avant", true);
    old.end();
    vi.runOnlyPendingTimers();
    old.hear("fantôme", true);
    old.end();
    expect(d.texts).toEqual(["avant"]);
    expect(FakeRecognition.instances.length).toBe(2);
    expect(d.ends()).toBe(0);
  });

  it("treats a deaf engine (audio closed, no end) as an ended session", () => {
    const d = dictate();
    const deaf = latest();
    deaf.hear("phrase", true);
    deaf.onaudioend?.();
    vi.advanceTimersByTime(3_000);
    vi.runOnlyPendingTimers();
    expect(FakeRecognition.instances.length).toBe(2);
    expect(deaf.abortCalls).toBe(1);
    expect(d.ends()).toBe(0);
  });
});

describe("the dictation ends — and the button with it — only when it must", () => {
  it("the user stops: no restart, one end", () => {
    const d = dictate();
    latest().hear("fin", true);
    d.handle!.stop();
    expect(latest().stopCalls).toBe(1);
    latest().end();
    vi.runAllTimers();
    expect(FakeRecognition.instances.length).toBe(1);
    expect(d.ends()).toBe(1);
    expect(d.texts).toEqual(["fin"]);
  });

  it("the user stops between two sessions: it ends there, nothing restarts", () => {
    const d = dictate();
    latest().end();
    d.handle!.stop();
    vi.runAllTimers();
    expect(FakeRecognition.instances.length).toBe(1);
    expect(d.ends()).toBe(1);
  });

  it("a fatal error (permission refused) ends it with its reason, no restart", () => {
    const d = dictate();
    latest().fail("not-allowed");
    latest().end();
    vi.runAllTimers();
    expect(d.errors).toEqual(["not-allowed"]);
    expect(d.ends()).toBe(1);
    expect(FakeRecognition.instances.length).toBe(1);
  });

  it("a recoverable error (no-speech, network) is followed by a restart, not an end", () => {
    const d = dictate();
    latest().fail("no-speech");
    latest().end();
    vi.runOnlyPendingTimers();
    expect(d.errors).toEqual([]);
    expect(d.ends()).toBe(0);
    expect(FakeRecognition.instances.length).toBe(2);
  });

  it("an engine that keeps ending at once is given up on, bounded, with a reason", () => {
    const d = dictate();
    for (let i = 0; i < 20 && d.ends() === 0; i++) {
      latest().end();
      vi.runOnlyPendingTimers();
    }
    expect(d.ends()).toBe(1);
    expect(d.errors).toEqual(["engine-gave-up"]);
    expect(FakeRecognition.instances.length).toBeLessThanOrEqual(6);
  });

  it("an engine that refuses to start again is given up on", () => {
    const d = dictate();
    FakeRecognition.failStartAfter = 1;
    latest().end();
    vi.runOnlyPendingTimers();
    expect(d.errors).toEqual(["engine-gave-up"]);
    expect(d.ends()).toBe(1);
  });
});

describe("the restart budget is spent by sessions that heard nothing (Codex pass 1)", () => {
  it("a deaf engine that keeps closing its audio is given up on, bounded — the watchdog's wait is no proof of health", () => {
    const d = dictate();
    for (let i = 0; i < 30 && d.ends() === 0; i++) {
      latest().onaudioend?.();
      vi.advanceTimersByTime(3_000); // the watchdog declares the session over
      vi.runOnlyPendingTimers(); // the restart
    }
    expect(d.errors).toEqual(["engine-gave-up"]);
    expect(d.ends()).toBe(1);
    expect(FakeRecognition.instances.length).toBeLessThanOrEqual(6);
  });

  it("a long silent pause (the browser ends silent sessions on its own) does not stop it early", () => {
    const d = dictate();
    // Twelve silent sessions of 8 s each — about a minute and a half of silence.
    for (let i = 0; i < DICTATION_SILENT_SESSIONS_MAX; i++) {
      vi.advanceTimersByTime(8_000);
      latest().fail("no-speech");
      latest().end();
      vi.runOnlyPendingTimers();
    }
    expect(d.ends()).toBe(0);
    expect(d.errors).toEqual([]);
    // …and the user speaks again: the budget starts over.
    latest().hear("je reprends", true);
    for (let i = 0; i < DICTATION_SILENT_SESSIONS_MAX; i++) {
      vi.advanceTimersByTime(8_000);
      latest().end();
      vi.runOnlyPendingTimers();
    }
    expect(d.ends()).toBe(0);
    expect(d.texts).toEqual(["je reprends"]);
  });

  it("silence that never ends is bounded too: the button goes off with a reason", () => {
    const d = dictate();
    for (let i = 0; i < 40 && d.ends() === 0; i++) {
      vi.advanceTimersByTime(8_000);
      latest().end();
      vi.runOnlyPendingTimers();
    }
    expect(d.errors).toEqual(["engine-gave-up"]);
    expect(d.ends()).toBe(1);
    expect(FakeRecognition.instances.length).toBe(DICTATION_SILENT_SESSIONS_MAX + 1);
  });
});

describe("a voluntary stop waits for the engine's last word (Codex pass 2)", () => {
  it("a final that arrives 3.1 s after stop() + audioend is delivered — the deaf watchdog is for restarts only", () => {
    const d = dictate();
    latest().hear("dernière phr", false);
    d.handle!.stop();
    latest().onaudioend?.(); // capture ended; recognition is still processing
    vi.advanceTimersByTime(3_100);
    latest().hear("dernière phrase", true);
    latest().end();
    vi.runAllTimers();
    expect(d.texts).toEqual(["dernière phrase"]);
    expect(latest().abortCalls).toBe(0);
    expect(d.ends()).toBe(1);
    expect(FakeRecognition.instances.length).toBe(1);
  });

  it("past the grace, the hypothesis on screen is delivered exactly once, and a later final is ignored", () => {
    const d = dictate();
    latest().hear("jamais finalisée", false);
    d.handle!.stop();
    latest().onaudioend?.();
    vi.advanceTimersByTime(DICTATION_STOP_GRACE_MS);
    expect(d.texts).toEqual(["jamais finalisée"]);
    expect(d.ends()).toBe(1);
    latest().hear("jamais finalisée", true); // too late: the dictation is over
    latest().end();
    vi.runAllTimers();
    expect(d.texts).toEqual(["jamais finalisée"]);
    expect(d.ends()).toBe(1);
  });

  it("a stop whose engine ends normally (final, then end) delivers once, with no grace delivery", () => {
    const d = dictate();
    latest().hear("propre", false);
    d.handle!.stop();
    latest().hear("propre", true);
    latest().end();
    vi.runAllTimers();
    expect(d.texts).toEqual(["propre"]);
    expect(d.ends()).toBe(1);
  });
});

describe("the timers measure the absence of PROGRESS, not time since audioend/stop (Codex pass 7)", () => {
  it("auto-restart watchdog: an interim at +2.9 s re-arms it, the final at +3.1 s is kept whole", () => {
    const d = dictate();
    latest().onaudioend?.();
    vi.advanceTimersByTime(2_900);
    latest().hear("Envoie le rapport", false);
    vi.advanceTimersByTime(200);
    latest().hear("Envoie le rapport demain", true);
    expect(d.texts).toEqual(["Envoie le rapport demain"]);
    expect(latest().abortCalls).toBe(0);
    expect(FakeRecognition.instances.length).toBe(1);
  });

  it("stop grace: progress after stop() re-arms it, a final 7 s after the stop is still kept", () => {
    const d = dictate();
    latest().hear("une longue", false);
    d.handle!.stop();
    vi.advanceTimersByTime(4_000);
    latest().hear("une longue phrase", false);
    vi.advanceTimersByTime(3_000); // 7 s after the stop, 3 s after the last progress
    latest().hear("une longue phrase finie", true);
    latest().end();
    vi.runAllTimers();
    expect(d.texts).toEqual(["une longue phrase finie"]);
    expect(d.ends()).toBe(1);
  });
});

describe("discard: the caller took the visible text (send while dictating)", () => {
  it("delivers nothing more — no late final can reach the next draft", () => {
    const d = dictate();
    latest().hear("déjà là", true);
    latest().hear("encore en vol", false);
    const interimsBefore = d.interims.length;
    d.handle!.discard();
    latest().hear("encore en vol", true); // the engine settles what it heard
    latest().end();
    vi.runAllTimers();
    expect(d.texts).toEqual(["déjà là"]);
    expect(d.interims.length).toBe(interimsBefore);
    expect(d.ends()).toBe(1);
    expect(FakeRecognition.instances.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// PROPERTY TEST (Codex pass 7): seeded random timelines of engine events and user actions
// against the REAL startDictation, with fake timers. Invariants:
//   (a) every final the CURRENT recognizer emits (newest instance, neither ended nor
//       aborted, dictation neither finished nor discarded) reaches onText exactly once, in
//       order; nothing reaches onText twice; nothing after a discard or after onEnd;
//   (d) no hot loop: every recognizer after the first follows an end or an abort, the
//       timers always drain, onEnd fires exactly once once the user stopped;
//   (e) no recognizer still making progress is cut: Atrium aborts one (outside a discard)
//       only after DICTATION_AUDIO_END_GRACE_MS (3 s) without a result, or once the stop's
//       total bound has passed.
// ---------------------------------------------------------------------------------------

/** mulberry32: small, seedable, deterministic. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class PropRecognition {
  static instances: PropRecognition[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((ev: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onaudioend: (() => void) | null = null;
  dead = false;
  aborted = false;
  lastProgressAt = Date.now();
  /** Set by the timeline when the abort is the user's discard (exempt from (e)). */
  static userAbort = false;
  static stoppedAt: number | null = null;
  static cutWhileProgressing: string | null = null;
  private results: Array<{ isFinal: boolean; 0: { transcript: string } }> = [];
  constructor() {
    PropRecognition.instances.push(this);
  }
  start() {}
  stop() {}
  abort() {
    if (!this.aborted && !PropRecognition.userAbort) {
      const quiet = Date.now() - this.lastProgressAt;
      const pastStopBound =
        PropRecognition.stoppedAt !== null && Date.now() - PropRecognition.stoppedAt >= DICTATION_STOP_MAX_MS;
      if (quiet < 3_000 && !pastStopBound) PropRecognition.cutWhileProgressing = `cut after ${quiet} ms of silence`;
    }
    this.aborted = true;
  }
  emit(transcript: string, isFinal: boolean) {
    this.lastProgressAt = Date.now();
    const last = this.results[this.results.length - 1];
    const i = last !== undefined && !last.isFinal ? this.results.length - 1 : this.results.length;
    this.results[i] = { isFinal, 0: { transcript } };
    this.onresult?.({ resultIndex: i, results: this.results });
  }
}

function runTimeline(seed: number): string | null {
  const rnd = prng(seed);
  PropRecognition.instances = [];
  PropRecognition.userAbort = false;
  PropRecognition.stoppedAt = null;
  PropRecognition.cutWhileProgressing = null;
  const texts: string[] = [];
  let ends = 0;
  let finishedAt = -1;
  let discardedAt = -1;
  let step = 0;
  const handle = startDictation({
    lang: "fr-FR",
    onText: (t) => {
      if (finishedAt >= 0) throw new Error(`onText after onEnd: ${t}`);
      if (discardedAt >= 0) throw new Error(`onText after discard: ${t}`);
      texts.push(t);
    },
    onInterim: () => {
      if (finishedAt >= 0) throw new Error("onInterim after onEnd");
    },
    onEnd: () => {
      ends++;
      finishedAt = step;
    },
    onError: () => {},
  });
  if (handle === null) return "no handle";
  const expected: string[] = [];
  let endsFired = 0;
  let stopped = false;
  let n = 0;
  const live = () => {
    const r = PropRecognition.instances[PropRecognition.instances.length - 1]!;
    return !r.dead && !r.aborted ? r : null;
  };
  for (step = 0; step < 60; step++) {
    const x = rnd();
    const r = live();
    if (x < 0.25) {
      if (r !== null) r.emit(`i${++n}`, false);
    } else if (x < 0.45) {
      if (r !== null) {
        const tok = `f${++n}`;
        const counts = finishedAt < 0 && discardedAt < 0;
        r.emit(tok, true);
        if (counts) expected.push(tok);
      }
    } else if (x < 0.52) {
      r?.onaudioend?.();
    } else if (x < 0.6) {
      if (r !== null) {
        r.dead = true;
        endsFired++;
        r.onend?.();
      }
    } else if (x < 0.64) {
      if (r !== null) {
        r.onerror?.({ error: "no-speech" });
        r.dead = true;
        endsFired++;
        r.onend?.();
      }
    } else if (x < 0.65) {
      if (r !== null) {
        r.onerror?.({ error: "not-allowed" });
        r.dead = true;
        endsFired++;
        r.onend?.();
      }
    } else if (x < 0.69) {
      // A late event of an OLDER recognizer: must be ignored.
      const old = PropRecognition.instances[Math.floor(rnd() * PropRecognition.instances.length)]!;
      if (old !== PropRecognition.instances[PropRecognition.instances.length - 1]) old.emit(`s${++n}`, true);
    } else if (x < 0.72) {
      if (!stopped) {
        stopped = true;
        PropRecognition.stoppedAt = Date.now();
        handle.stop();
      }
    } else if (x < 0.73) {
      if (discardedAt < 0 && finishedAt < 0) {
        discardedAt = step;
        PropRecognition.userAbort = true;
        handle.discard();
      }
    } else {
      vi.advanceTimersByTime(Math.floor(rnd() * 6_000));
    }
  }
  if (!stopped) {
    PropRecognition.stoppedAt = Date.now();
    handle.stop();
  }
  vi.runAllTimers();
  // (e)
  if (PropRecognition.cutWhileProgressing !== null) return PropRecognition.cutWhileProgressing;
  // (a)
  const finals = texts.filter((t) => t.startsWith("f"));
  if (JSON.stringify(finals) !== JSON.stringify(expected)) {
    return `finals ${JSON.stringify(finals)} != expected ${JSON.stringify(expected)}`;
  }
  if (new Set(texts).size !== texts.length) return `duplicate delivery ${JSON.stringify(texts)}`;
  if (texts.some((t) => t.startsWith("s"))) return `stale recognizer delivered ${JSON.stringify(texts)}`;
  // (d)
  const aborts = PropRecognition.instances.filter((r) => r.aborted).length;
  if (PropRecognition.instances.length > 1 + endsFired + aborts) {
    return `recognizers ${PropRecognition.instances.length} > 1 + ends ${endsFired} + aborts ${aborts}`;
  }
  if (ends !== 1) return `onEnd fired ${ends} times`;
  return null;
}

describe("property: random engine timelines against the real startDictation", () => {
  it("holds its invariants over 2,500 seeds", () => {
    vi.stubGlobal("window", { webkitSpeechRecognition: PropRecognition });
    for (let seed = 1; seed <= 2_500; seed++) {
      let failure: string | null;
      try {
        failure = runTimeline(seed);
      } catch (e) {
        failure = String(e);
      }
      if (failure !== null) throw new Error(`seed ${seed}: ${failure}`);
    }
  });
});
