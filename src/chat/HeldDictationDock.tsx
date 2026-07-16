// The DETACHED COMPOSER — a pinned draft's floating home while the user
// navigates away from its conversation. Rendered in the persistent chrome
// (router RootShell). Fully editable (type + dictate), draggable by its header,
// resizable from its corner, and sendable (which returns to the target chat).
// The text + engine are owned by the module store (dictationHold.ts); this
// component is the cross-conversation surface for them.

import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { GripVertical, Mic, MicOff, PinOff, Send, X } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import {
  appendHeldDictation,
  clampGeometry,
  getHeldDictation,
  markHeldEngineEnded,
  reattachHeldEngine,
  releaseHeldDictation,
  requestHeldRestore,
  requestHeldSend,
  setHeldGeometry,
  setHeldInterim,
  setHeldText,
  stopHeldEngine,
  subscribeHeldDictation,
  type HeldGeometry,
} from "./dictationHold";
import {
  dictationSupported,
  resolveSpeechLang,
  startDictation,
  type DictationHandle,
} from "./speech";
import { getLocale } from "@/paraglide/runtime.js";
import { createPortal } from "react-dom";
import { useToast } from "@/components/ui/toast";
import { currentEngineGen } from "./dictationHold";

/** A pointer drag reporting incremental deltas from the last position. Shared
 *  by the header (move) and the corner (resize). */
function useDrag(
  onDelta: (dx: number, dy: number) => void,
): (e: React.PointerEvent) => void {
  const last = useRef<{ x: number; y: number } | null>(null);
  const cb = useRef(onDelta);
  cb.current = onDelta;
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (last.current === null) return;
      cb.current(e.clientX - last.current.x, e.clientY - last.current.y);
      last.current = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      last.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);
  return (e: React.PointerEvent) => {
    last.current = { x: e.clientX, y: e.clientY };
  };
}

export function HeldDictationDock() {
  const held = useSyncExternalStore(subscribeHeldDictation, getHeldDictation);
  const navigate = useNavigate();
  const toast = useToast();
  // Identity boundary: this component lives as long as the authenticated
  // chrome — logout / impersonation remounts it, stopping + purging the hold.
  useEffect(() => () => void releaseHeldDictation(), []);

  const moveBy = useCallback((dx: number, dy: number) => {
    const g = getHeldDictation()?.geom;
    if (g === undefined) return;
    setHeldGeometry({ ...g, x: g.x + dx, y: g.y + dy });
  }, []);
  const resizeBy = useCallback((dx: number, dy: number) => {
    const g = getHeldDictation()?.geom;
    if (g === undefined) return;
    setHeldGeometry({ ...g, w: g.w + dx, h: g.h + dy });
  }, []);
  const onHeaderDown = useDrag(moveBy);
  const onCornerDown = useDrag(resizeBy);

  // Re-clamp to the viewport on window resize (the panel must never strand
  // off-screen).
  useEffect(() => {
    const onResize = () => {
      const g = getHeldDictation()?.geom;
      if (g !== undefined) setHeldGeometry(g);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Local dictation engine (owned by the store while detached).
  const engineRef = useRef<DictationHandle | null>(null);
  useEffect(() => () => engineRef.current?.stop(), []);
  const recording = held?.recording ?? false;
  const toggleMic = useCallback(() => {
    // The STORE is the source of truth for "recording": the engine may live in
    // the store (pinned from the composer) with no local handle here — so drive
    // stop/start off the store's flag, never engineRef alone (codex P1).
    if (getHeldDictation()?.recording === true) {
      // Stop the engine but DON'T settle synchronously: SpeechRecognition may
      // still emit a trailing final before onEnd. The engine's onEnd flips
      // recording=false AFTER that final lands, so a capture (send) taken once
      // the button re-enables is complete (codex re-review P1). A fallback timer
      // force-settles THIS generation if onEnd never fires (engine died) — and
      // is ignored if a newer engine already bumped the generation.
      const gen = currentEngineGen();
      engineRef.current?.stop();
      engineRef.current = null;
      stopHeldEngine();
      window.setTimeout(() => markHeldEngineEnded(gen), 1500);
      return;
    }
    if (!dictationSupported()) return;
    const lang = getHeldDictation()?.voiceLang || resolveSpeechLang("", getLocale());
    // Session guard: an OLD engine's async onEnd/onError must never reset a
    // newer session's state — key off the store's engine generation (codex P2).
    const session: { h: DictationHandle | null; gen: number } = {
      h: null,
      gen: 0,
    };
    const settle = () => {
      if (engineRef.current === session.h) engineRef.current = null;
      markHeldEngineEnded(session.gen);
    };
    const h = startDictation({
      lang,
      // A stale engine (a newer session bumped the generation) must not write
      // its trailing transcript into the current hold (codex re-review P2) —
      // the same guard `settle` already applies to onEnd.
      onText: (t, meta) => {
        if (session.gen !== currentEngineGen()) return;
        appendHeldDictation(t, meta.paragraph);
      },
      onInterim: (t) => {
        if (session.gen !== currentEngineGen()) return;
        setHeldInterim(t);
      },
      onEnd: settle,
      onError: (code) => {
        settle();
        if (code === "not-allowed" || code === "service-not-allowed") {
          toast.error(m.chat_mic_error_denied());
        } else if (code !== "no-speech" && code !== "aborted") {
          toast.error(m.chat_mic_error_generic({ code }));
        }
      },
    });
    if (h === null) {
      toast.error(m.chat_mic_error_unsupported());
      return;
    }
    session.h = h;
    engineRef.current = h;
    reattachHeldEngine(() => h.stop());
    session.gen = currentEngineGen();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast identity stable
  }, [toast]);

  if (held === null) return null;

  const clamped: HeldGeometry = clampGeometry(held.geom, {
    w: window.innerWidth,
    h: window.innerHeight,
  });

  // Portal to <body>: a `position: fixed` panel rendered inside the chrome can
  // be trapped by an ancestor containing block (the same "invisible fixed"
  // bug the expanded composer hit) — the portal escapes it. The component
  // stays in the identity-keyed tree, so the logout/impersonation cleanup
  // still fires.
  return createPortal(
    <div
      className={`oc-detach${recording ? " oc-detach--live" : ""}`}
      style={{
        left: `${clamped.x}px`,
        top: `${clamped.y}px`,
        width: `${clamped.w}px`,
        height: `${clamped.h}px`,
      }}
      role="dialog"
      aria-label={m.dictation_dock_title()}
    >
      {/* Left grip: the primary MOVE handle (the user reads "this composer is
          draggable" at a glance). The header is also draggable for reach. */}
      <div
        className="oc-detach__handle"
        onPointerDown={onHeaderDown}
        title={m.dictation_dock_move()}
        aria-label={m.dictation_dock_move()}
      >
        <GripVertical size={16} aria-hidden />
      </div>
      <div className="oc-detach__head" onPointerDown={onHeaderDown}>
        {recording ? (
          <span className="oc-detach__wave" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : null}
        <span className="oc-detach__chip" title={held.targetLabel}>
          {held.targetLabel || m.dictation_dock_title()}
        </span>
        <button
          type="button"
          className="oc-detach__close"
          title={m.dictation_dock_discard()}
          aria-label={m.dictation_dock_discard()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => releaseHeldDictation()}
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <textarea
        className="oc-detach__input"
        value={held.text}
        placeholder={m.dictation_dock_title()}
        onChange={(e) => setHeldText(e.target.value)}
        // Read-only while a send is in flight: no edit may race the release
        // (codex re-review P1). The discard/X stays enabled as an escape hatch.
        readOnly={held.sending}
        autoFocus
      />
      {recording && held.interim !== "" ? (
        <div className="oc-detach__interim" aria-hidden>
          {held.interim}
        </div>
      ) : null}

      <div className="oc-detach__bar">
        {held.voiceEnabled && dictationSupported() ? (
          <button
            type="button"
            className={`oc-detach__icon${recording ? " oc-detach__icon--rec" : ""}`}
            title={recording ? m.chat_mic_stop() : m.chat_mic_start()}
            aria-label={recording ? m.chat_mic_stop() : m.chat_mic_start()}
            aria-pressed={recording}
            // No mic toggle mid-send (the panel is read-only in flight).
            disabled={held.sending}
            onClick={toggleMic}
          >
            {recording ? (
              <MicOff size={16} aria-hidden />
            ) : (
              <Mic size={16} aria-hidden />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className="oc-detach__icon"
          title={recording ? m.dictation_dock_stop_first() : m.dictation_dock_unpin()}
          aria-label={m.dictation_dock_unpin()}
          // Stop the mic first so a trailing final is captured; never act
          // mid-send (codex re-review P1/P2).
          disabled={held.sending || recording}
          onClick={() => {
            // Non-destructive un-pin: hand the draft back to the owner composer
            // (which absorbs it inline + releases the hold) and return there.
            requestHeldRestore();
            void navigate({
              to: "/chat/$chatId",
              params: { chatId: held.targetChatId },
            });
          }}
        >
          <PinOff size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="oc-detach__send"
          // Disabled while recording: stop the mic first so the trailing final
          // is in the text before it's captured (codex re-review P1); and while
          // a send is already in flight (no double enqueue).
          disabled={held.text.trim() === "" || recording || held.sending}
          title={recording ? m.dictation_dock_stop_first() : m.dictation_dock_send()}
          aria-label={m.dictation_dock_send()}
          onClick={() => {
            // Defer the routed/queued send to the target composer, then return
            // there (the user's confirmed behavior).
            requestHeldSend(held.text);
            void navigate({
              to: "/chat/$chatId",
              params: { chatId: held.targetChatId },
            });
          }}
        >
          <Send size={15} aria-hidden />
          {m.dictation_dock_send()}
        </button>
      </div>

      <button
        type="button"
        className="oc-detach__resize"
        aria-label={m.dictation_dock_resize()}
        onPointerDown={onCornerDown}
      />
    </div>,
    document.body,
  );
}
