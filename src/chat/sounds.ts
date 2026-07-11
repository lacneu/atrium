// Atrium sound cues — synthesized with WebAudio (no binary asset, no network
// fetch). Two distinct cues, both short and quiet:
//
//   - notification: the "Atrium signature" — two soft heartbeat-like tones
//     (a fifth apart, echoing the brand's ECG/heartbeat motif), ~320 ms.
//   - reply finished: a single higher, even shorter blip (~140 ms) so running
//     several conversations in parallel stays discreet.
//
// Design constraints honored here:
//   - Autoplay policy: an AudioContext created before any user gesture starts
//     "suspended" — resume() is attempted and every failure is swallowed (a
//     missed cue must never surface an error).
//   - Throttle: at most one cue per 400 ms window (a burst of notifications
//     must not machine-gun the speaker).
//   - All entry points are behind user prefs (the callers check `ui.effective`)
//     — this module never decides WHETHER to play, only HOW.

let ctx: AudioContext | null = null;
let lastPlayedAt = 0;

const THROTTLE_MS = 400;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** One enveloped sine tone. Times are relative to ctx.currentTime. */
function tone(
  ac: AudioContext,
  freq: number,
  startS: number,
  durS: number,
  peak: number,
): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const t0 = ac.currentTime + startS;
  // Fast attack, exponential-ish release — soft, no click.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durS);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + durS + 0.02);
}

function play(build: (ac: AudioContext) => void): void {
  const now = Date.now();
  if (now - lastPlayedAt < THROTTLE_MS) return;
  const ac = audioContext();
  if (!ac) return;
  lastPlayedAt = now;
  const run = () => {
    try {
      build(ac);
    } catch {
      // Never let a sound cue break the UI.
    }
  };
  if (ac.state === "suspended") {
    // Autoplay policy: works after any prior user gesture; otherwise the
    // resume rejects and the cue is silently skipped.
    void ac.resume().then(run, () => {});
  } else {
    run();
  }
}

/** The Atrium signature — two soft heartbeat tones (new bell notification). */
export function playNotificationSound(): void {
  play((ac) => {
    tone(ac, 660, 0, 0.16, 0.12); // E5
    tone(ac, 440, 0.14, 0.2, 0.1); // A4 — the "dub" of the lub-dub
  });
}

/** A single discreet blip — an assistant reply just finished. */
export function playReplySound(): void {
  play((ac) => {
    tone(ac, 880, 0, 0.14, 0.08); // A5, quieter and shorter than the signature
  });
}
