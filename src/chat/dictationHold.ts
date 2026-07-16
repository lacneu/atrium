// DETACHED COMPOSER — the pin that lets a draft (typed or dictated) survive
// navigation as a floating, draggable, resizable mini-composer.
//
// The composer (and any SpeechRecognition handle) is mounted PER CHAT: leaving
// the conversation unmounts it. When the user PINS the composer,
// ownership of the text (and the live engine, if dictating) moves to this
// module-level store; a floating panel rendered in the persistent chrome keeps
// it editable, dictatable and sendable while the user navigates elsewhere.
// Returning to the target chat re-syncs the composer from the store.
//
// Pure module + tiny subscribe surface (no React): unit-testable, and immune
// to the mount/unmount churn it exists to survive.

export type HeldGeometry = {
  /** Top-left position in px (viewport). */
  x: number;
  y: number;
  /** Panel size in px. */
  w: number;
  h: number;
};

export type HeldDictation = {
  /** Monotonic id, unique per pin (never reused). Async actions capture it so a
   *  late resolve only touches the SAME hold — never a replacement pin (codex
   *  re-review P1). */
  holdId: number;
  /** TRUE while a detached send is in flight (queueSend awaiting): the panel is
   *  read-only so no edit/second-send races the release (codex re-review P1).
   *  The discard/X stays enabled — an escape hatch if the send hangs. */
  sending: boolean;
  /** The conversation the draft belongs to (send target). */
  targetChatId: string;
  /** Display label for the panel chip (the chat title at pin time). */
  targetLabel: string;
  /** The full prompt text so far (committed segments + manual edits). */
  text: string;
  /** The engine's in-flight hypothesis (ghost text, replaced per event). */
  interim: string;
  /** TRUE while a dictation engine is live for this hold. */
  recording: boolean;
  /** Floating panel geometry (persisted across pins). */
  geom: HeldGeometry;
  /** When non-null, the target composer must SEND this text and release the
   *  hold — the panel's "send" navigates to the target and defers the actual
   *  send to the target composer (which owns routing / queue). */
  pendingSend: string | null;
  /** Monotonic id bumped on EVERY requestHeldSend. The consuming effect keys
   *  off this (not the text) so a RETRY of the same text is a distinct action,
   *  while a StrictMode replay (same id) is ignored (codex re-review P1). */
  pendingSendId: number;
  /** When non-null, the target composer must ABSORB this text back into its
   *  inline runtime and release the hold — a NON-destructive un-pin (the dock's
   *  "dock back" and the target note's "recover here" both request it). */
  pendingRestore: string | null;
  /** Voice-input governance captured at pin time (the panel is cross-chat and
   *  cannot read the target's UI-prefs / admin gate) — the mic hides in the
   *  panel exactly as it would in the origin composer. */
  voiceEnabled: boolean;
  /** The target instance's configured dictation language at pin time, so a
   *  dictation resumed from the panel recognizes in the right language. */
  voiceLang: string;
};

type Listener = () => void;

const GEOM_KEY = "oc.detachedComposer.geom";
const MIN_W = 300;
const MIN_H = 200;

let held: HeldDictation | null = null;
// Monotonic pin id: every hold gets a fresh, never-reused value so an async
// action can prove it is still acting on the SAME pin (codex re-review P1).
let holdSeq = 0;
// Monotonic send-action id: bumped on every requestHeldSend so a retry of the
// same text is a fresh action, distinguishable from a StrictMode replay.
let sendActionSeq = 0;
let stopEngine: (() => void) | null = null;
// Monotonic engine generation: every hold/reattach bumps it. A dictation
// session captures the value at start; its async onEnd/onError only settles
// the store when it is STILL the current generation — a stale session's
// terminal never marks a newer one as ended (codex P2).
let engineGen = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeHeldDictation(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Snapshot for useSyncExternalStore — stable reference between changes. */
export function getHeldDictation(): HeldDictation | null {
  return held;
}

/** Clamp a geometry so the panel always stays reachable on screen (its header
 *  never leaves the viewport). Pure. */
export function clampGeometry(
  g: HeldGeometry,
  viewport: { w: number; h: number },
): HeldGeometry {
  // Size yields to the viewport as the FINAL bound: on a viewport narrower/
  // shorter than the minimum, the panel shrinks below MIN rather than
  // overflowing (the CSS min-width/min-height are `min(…, 100vw/dvh)` to match).
  const w = Math.min(Math.max(MIN_W, Math.min(g.w, viewport.w)), viewport.w);
  const h = Math.min(Math.max(MIN_H, Math.min(g.h, viewport.h)), viewport.h);
  // Keep the panel FULLY on screen (flush to an edge if it is larger than the
  // viewport) — a persisted off-screen position (a past drag past the edge)
  // must never leave the panel invisible.
  const x = Math.max(0, Math.min(g.x, viewport.w - w));
  const y = Math.max(0, Math.min(g.y, viewport.h - h));
  return { x, y, w, h };
}

function defaultGeom(): HeldGeometry {
  // Centred near the BOTTOM by default, echoing where the inline composer sat
  // (visual continuity when the composer detaches). Clamped at render time.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.min(720, Math.round(vw * 0.72));
  const h = Math.min(300, Math.round(vh * 0.42));
  return { x: Math.round((vw - w) / 2), y: vh - h - 28, w, h };
}

function loadGeom(): HeldGeometry {
  let g: HeldGeometry | null = null;
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(GEOM_KEY)
        : null;
    if (raw !== null) {
      const p = JSON.parse(raw) as Partial<HeldGeometry>;
      if (
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        typeof p.w === "number" &&
        typeof p.h === "number"
      ) {
        g = { x: p.x, y: p.y, w: p.w, h: p.h };
      }
    }
  } catch {
    // corrupt / unavailable — fall through to default
  }
  if (g === null) g = defaultGeom();
  // Clamp against the CURRENT viewport: a geometry persisted while another
  // (larger) window was open, or dragged off-screen, must never pin the panel
  // out of view.
  if (typeof window !== "undefined" && window.innerWidth && window.innerHeight) {
    g = clampGeometry(g, { w: window.innerWidth, h: window.innerHeight });
  }
  return g;
}

function saveGeom(g: HeldGeometry): void {
  try {
    localStorage?.setItem(GEOM_KEY, JSON.stringify(g));
  } catch {
    // storage full / unavailable — geometry is a convenience, never fatal
  }
}

/** Pin the composer as a floating panel. `recording`/`stop` are supplied only
 *  when a dictation is live at pin time (manual pins pass recording:false).
 *  ONE pin at a time — pinning over an existing hold is a no-op (returns
 *  false; the UI hides the pin affordance whenever a hold exists). */
export function holdDictation(init: {
  targetChatId: string;
  targetLabel: string;
  text: string;
  voiceEnabled: boolean;
  voiceLang: string;
  recording?: boolean;
  stop?: () => void;
}): boolean {
  if (held !== null) return false;
  holdSeq += 1;
  held = {
    holdId: holdSeq,
    sending: false,
    targetChatId: init.targetChatId,
    targetLabel: init.targetLabel,
    text: init.text,
    interim: "",
    recording: init.recording ?? false,
    geom: loadGeom(),
    pendingSend: null,
    pendingSendId: 0,
    pendingRestore: null,
    voiceEnabled: init.voiceEnabled,
    voiceLang: init.voiceLang,
  };
  stopEngine = init.stop ?? null;
  engineGen++;
  emit();
  return true;
}

/** A dictation RESUMED (the panel's mic, or the target composer's mic while
 *  held): the store takes the new engine and records again. */
export function reattachHeldEngine(stop: () => void): void {
  if (held === null) return;
  stopEngine = stop;
  engineGen++;
  if (!held.recording) {
    held = { ...held, recording: true };
    emit();
  }
}

/** The current engine generation — a session captures this at start. */
export function currentEngineGen(): number {
  return engineGen;
}

/** Append a committed dictation segment to the held text (paragraph = a long
 *  spoken pause preceded it). No-op when nothing is held. */
export function appendHeldDictation(piece: string, paragraph: boolean): void {
  if (held === null) return;
  held = { ...held, text: appendDictated(held.text, piece, paragraph) };
  emit();
}

export function setHeldInterim(interim: string): void {
  if (held === null || held.interim === interim) return;
  held = { ...held, interim };
  emit();
}

/** Set the held text outright (manual editing from the panel, or the target
 *  composer mirroring its own edits back). No-op on identical text. */
export function setHeldText(text: string): void {
  if (held === null || held.text === text) return;
  held = { ...held, text };
  emit();
}

/** Back-compat alias (the target composer mirrors its edits into the store). */
export const syncHeldText = setHeldText;

/** Move/resize the floating panel (clamped) and persist the geometry. */
export function setHeldGeometry(geom: HeldGeometry): void {
  if (held === null) return;
  const vw =
    typeof window !== "undefined" && window.innerWidth
      ? window.innerWidth
      : geom.w;
  const vh =
    typeof window !== "undefined" && window.innerHeight
      ? window.innerHeight
      : geom.h;
  const clamped = clampGeometry(geom, { w: vw, h: vh });
  held = { ...held, geom: clamped };
  saveGeom(clamped);
  emit();
}

/** Request the target composer to SEND `text` and release the hold. The panel
 *  sets this then navigates to the target chat; the target composer performs
 *  the routed/queued send it owns. */
export function requestHeldSend(text: string): void {
  if (held === null) return;
  // Mark the send in flight: the panel goes read-only so an edit / second click
  // cannot race the release (codex re-review P1). A fresh pendingSendId makes a
  // retry of the same text a distinct action (codex re-review P1).
  sendActionSeq += 1;
  held = { ...held, pendingSend: text, pendingSendId: sendActionSeq, sending: true };
  emit();
}

export function clearHeldPendingSend(): void {
  if (held === null || held.pendingSend === null) return;
  held = { ...held, pendingSend: null };
  emit();
}

/** Clear the in-flight flag ONLY if the current hold is still `holdId` — a late
 *  failure of a send whose pin was discarded + replaced must not unlock the NEW
 *  pin (codex re-review P1). */
export function endHeldSendingById(holdId: number): void {
  if (held === null || held.holdId !== holdId || !held.sending) return;
  held = { ...held, sending: false };
  emit();
}

/** Release ONLY if the current hold is still `holdId` — an async send that
 *  resolves after the hold was discarded + replaced must not drop the NEW pin
 *  (codex re-review P1). Returns the released text, or "" if it was a no-op. */
export function releaseHeldDictationById(holdId: number): string {
  if (held === null || held.holdId !== holdId) return "";
  return releaseHeldDictation();
}

/** Request the target composer to ABSORB the held text back into its inline
 *  runtime and release the hold (a non-destructive un-pin). The dock/note calls
 *  this then navigates to the target; the target composer restores the draft.
 *  Snapshots the CURRENT text so a later dock edit can't change what's restored. */
export function requestHeldRestore(): void {
  if (held === null) return;
  held = { ...held, pendingRestore: held.text };
  emit();
}

export function clearHeldPendingRestore(): void {
  if (held === null || held.pendingRestore === null) return;
  held = { ...held, pendingRestore: null };
  emit();
}

/** The engine ended (mic off / error): the hold stays visible with its text
 *  until released, but stops claiming a live recording. `gen` (when given) must
 *  match the current generation — a stale session's terminal is ignored. */
export function markHeldEngineEnded(gen?: number): void {
  if (held === null || !held.recording) return;
  if (gen !== undefined && gen !== engineGen) return;
  held = { ...held, recording: false, interim: "" };
  emit();
}

/** Stop the ENGINE only — the held text and panel stay (only the mic goes
 *  quiet). */
export function stopHeldEngine(): void {
  try {
    stopEngine?.();
  } catch {
    // engine already gone
  }
  stopEngine = null;
}

/** Stop the engine (if still running) and drop the hold entirely. Returns the
 *  final text so the caller (composer on the target chat) can absorb it. */
export function releaseHeldDictation(): string {
  const text = held?.text ?? "";
  try {
    stopEngine?.();
  } catch {
    // engine already gone
  }
  stopEngine = null;
  held = null;
  emit();
  return text;
}

/** Append one committed dictation piece to the current prompt text: single
 *  spacing on the same paragraph, a blank line when a long spoken pause asked
 *  for a paragraph break. Pure. */
export function appendDictated(
  current: string,
  piece: string,
  paragraph: boolean,
): string {
  const p = piece.trim();
  if (p === "") return current;
  if (current === "") return p;
  const base = current.replace(/\s+$/, "");
  return paragraph ? `${base}\n\n${p}` : `${base} ${p}`;
}
