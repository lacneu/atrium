// SEND WHILE DICTATING (0.103.1). Send used to be disabled while the mic was live: the
// inline composer needed a first committed final, and the pinned panel refused outright
// ("stop the microphone first"). The user dictates and sends in one gesture now: the
// message is what the composer SHOWS at the click — committed text plus the hypothesis
// still in flight — and the dictation ends without delivering anything it still holds, so
// no late segment lands in the next draft or in another conversation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendHeldDictation,
  canSendWhileDictating,
  clearHeldPendingSend,
  currentEngineGen,
  endHeldSendingById,
  getHeldDictation,
  heldSendText,
  clearHeldPendingRestore,
  holdDictation,
  markHeldEngineEnded,
  markHeldFinalizing,
  reattachHeldEngine,
  releaseHeldDictation,
  releaseHeldKeepingWords,
  requestHeldRestore,
  requestHeldSend,
  retireHeldEngine,
  setHeldInterim,
  stopHeldEngine,
  visibleDictationText,
} from "./dictationHold";
import {
  localDictationEventAllowed,
  retireForNewSession,
  type ComposerDictationSession,
} from "./dictationSessionGuard";
import { startDictation, type DictationHandle } from "./speech";
import {
  inlineFinal,
  inlineHypothesisShown,
  retirePreviousForStart,
  takeComposerForSend,
  type InlineHost,
  type InlineSession,
} from "./inlineDictation";

describe("the text a send carries while dictating", () => {
  it("is the committed text followed by the hypothesis on screen", () => {
    expect(visibleDictationText("Bonjour", "le monde")).toBe("Bonjour le monde");
    expect(visibleDictationText("", "tout en vol")).toBe("tout en vol");
    expect(visibleDictationText("rien en vol", "  ")).toBe("rien en vol");
  });
  it("send is offered as soon as anything shows — a hypothesis alone counts", () => {
    expect(canSendWhileDictating("", "je dis")).toBe(true);
    expect(canSendWhileDictating("déjà écrit", "")).toBe(true);
    expect(canSendWhileDictating("  ", "  ")).toBe(false);
  });
});

describe("the pinned panel sends while its mic is live", () => {
  beforeEach(() => {
    releaseHeldDictation();
  });
  it("carries the hypothesis it shows, only while the mic is live", () => {
    expect(heldSendText({ text: "écrit", interim: "en vol", recording: true })).toBe("écrit en vol");
    expect(heldSendText({ text: "écrit", interim: "en vol", recording: false })).toBe("écrit");
  });
  it("retires the engine: stopped, its generation passed, the hold no longer recording", () => {
    const stop = vi.fn();
    holdDictation({
      targetChatId: "chat-a",
      targetLabel: "A",
      text: "écrit",
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop,
    });
    reattachHeldEngine(stop);
    setHeldInterim("en vol");
    const sessionGen = currentEngineGen();
    const text = heldSendText(getHeldDictation()!);
    retireHeldEngine();
    expect(text).toBe("écrit en vol");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getHeldDictation()?.recording).toBe(false);
    expect(getHeldDictation()?.interim).toBe("");
    // The guard every session applies before writing a late segment into the hold or the
    // target composer (HeldDictationDock `session.gen`, the controller's `holdGen`).
    expect(sessionGen !== currentEngineGen()).toBe(true);
  });
});

describe("a refused send from the pinned panel keeps every word that was shown (Codex pass 1)", () => {
  beforeEach(() => {
    releaseHeldDictation();
  });
  const pinLive = (text: string, interim: string) => {
    holdDictation({
      targetChatId: "chat-a",
      targetLabel: "A",
      text,
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop: () => {},
    });
    setHeldInterim(interim);
  };
  /** The panel's click, then the target composer refusing it (unavailable, or the queue
   *  saying no): `clearHeldPendingSend` + `endHeldSendingById`, as Composer does. */
  const clickThenRefuse = () => {
    const text = heldSendText(getHeldDictation()!);
    retireHeldEngine();
    requestHeldSend(text);
    const holdId = getHeldDictation()!.holdId;
    clearHeldPendingSend();
    endHeldSendingById(holdId);
    return text;
  };
  it("a dictation that was all hypothesis is still there after the refusal", () => {
    pinLive("", "tout est encore en vol");
    const sent = clickThenRefuse();
    expect(sent).toBe("tout est encore en vol");
    expect(getHeldDictation()?.text).toBe("tout est encore en vol");
    expect(getHeldDictation()?.sending).toBe(false);
  });
  it("final text and hypothesis both stay, in the order shown", () => {
    pinLive("Bonjour", "le monde");
    clickThenRefuse();
    expect(getHeldDictation()?.text).toBe("Bonjour le monde");
  });
});

describe("the pinned panel's Stop leaves a finalizing window, and a send in it retires the engine (Codex pass 3)", () => {
  beforeEach(() => {
    releaseHeldDictation();
  });
  it("Stop, then the old 1.5 s fallback, then Send: the shown hypothesis is sent and nothing reaches the next draft", () => {
    const stop = vi.fn();
    holdDictation({
      targetChatId: "chat-a",
      targetLabel: "A",
      text: "committed",
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop,
    });
    // A dictation transferred from the composer: its session captured this generation.
    const sessionGen = currentEngineGen();
    setHeldInterim("tail");
    // The panel's Stop: engine told to stop (it may still settle for its grace).
    const gen = currentEngineGen();
    stopHeldEngine();
    markHeldFinalizing(gen);
    expect(getHeldDictation()?.finalizing).toBe(true);
    // Send during the finalizing window: what the panel shows, engine retired.
    const held = getHeldDictation()!;
    const sent = heldSendText(held);
    if (held.recording || held.finalizing) retireHeldEngine();
    requestHeldSend(sent);
    releaseHeldDictation(); // the target composer's success path
    expect(sent).toBe("committed tail");
    // The session's late final ("tail") is checked against the generation it captured:
    // it is stale, so it reaches neither a hold nor the next draft.
    expect(sessionGen !== currentEngineGen()).toBe(true);
  });

  it("a release always passes the generation: a pinned session cannot outlive its pin", () => {
    holdDictation({
      targetChatId: "chat-a",
      targetLabel: "A",
      text: "x",
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop: () => {},
    });
    const sessionGen = currentEngineGen();
    releaseHeldDictation();
    expect(sessionGen !== currentEngineGen()).toBe(true);
  });

  it("the engine's own end closes the finalizing window", () => {
    holdDictation({
      targetChatId: "chat-a",
      targetLabel: "A",
      text: "x",
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop: () => {},
    });
    const gen = currentEngineGen();
    stopHeldEngine();
    markHeldFinalizing(gen);
    markHeldEngineEnded(gen);
    expect(getHeldDictation()?.finalizing).toBe(false);
    expect(getHeldDictation()?.recording).toBe(false);
  });
});

describe("a callback of a retired composer session touches nothing (Codex pass 3)", () => {
  it("A's late hypothesis never reaches B: only the live session, in its own chat", () => {
    const a: ComposerDictationSession = { startedChatId: "chat-a", stale: false };
    // Navigation to B retires A; B starts its own session.
    a.stale = true;
    const b: ComposerDictationSession = { startedChatId: "chat-b", stale: false };
    expect(localDictationEventAllowed(a, b, "chat-b")).toBe(false);
    expect(localDictationEventAllowed(b, b, "chat-b")).toBe(true);
    // Even a non-retired session of A is refused in B, and a superseded one anywhere.
    const a2: ComposerDictationSession = { startedChatId: "chat-a", stale: false };
    expect(localDictationEventAllowed(a2, a2, "chat-b")).toBe(false);
    expect(localDictationEventAllowed(a2, b, "chat-a")).toBe(false);
  });
});

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((ev: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  results: Array<{ isFinal: boolean; 0: { transcript: string } }> = [];
  constructor() {
    FakeRecognition.last = this;
  }
  start() {}
  stop() {}
  abort() {}
  hear(transcript: string, isFinal: boolean) {
    const i = this.results.length > 0 && !this.results[this.results.length - 1]!.isFinal ? this.results.length - 1 : this.results.length;
    this.results[i] = { isFinal, 0: { transcript } };
    this.onresult?.({ resultIndex: i, results: this.results });
  }
}

describe("the inline composer sends while dictating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("sends exactly what was visible, and the next draft receives nothing late", () => {
    // The composer as the controller drives it: finals append, the ghost mirrors interims.
    let draft = "";
    let ghost = "";
    let recording = true;
    const h = startDictation({
      lang: "fr-FR",
      onText: (t) => {
        draft = draft === "" ? t : `${draft} ${t}`;
      },
      onInterim: (t) => {
        ghost = t;
      },
      onEnd: () => {
        recording = false;
      },
      onError: () => {},
    })!;
    FakeRecognition.last!.hear("Écris un poème", true);
    FakeRecognition.last!.hear("sur la mer", false);
    // The click: what the composer shows, then the session is discarded (flushForSend).
    const sent = visibleDictationText(draft, ghost);
    h.discard();
    draft = ""; // the send clears the composer
    // The engine settles what it was hearing, then ends.
    FakeRecognition.last!.hear("sur la mer", true);
    FakeRecognition.last!.onend?.();
    vi.runAllTimers();
    expect(sent).toBe("Écris un poème sur la mer");
    expect(draft).toBe("");
    expect(recording).toBe(false);
  });
});

describe("Stop, then an immediate resume: the words still finalizing are kept once (Codex pass 4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition });
    releaseHeldDictation();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("inline composer: the stopped session's hypothesis is folded once, its late final ignored", () => {
    // The controller's wiring, as in ConvexChat.tsx: one live session, callbacks checked by
    // localDictationEventAllowed, and a new session retiring the previous one.
    let draft = "";
    let live: (ComposerDictationSession & { recs: FakeRecognition[] }) | null = null;
    const open = () => {
      const session: ComposerDictationSession & { recs: FakeRecognition[] } = {
        startedChatId: "chat-a",
        stale: false,
        recs: [],
      };
      const prev = live;
      const folded = retireForNewSession(prev);
      if (folded !== null) draft = draft === "" ? folded : `${draft} ${folded}`;
      live = session;
      const h = startDictation({
        lang: "fr-FR",
        onText: (t) => {
          if (!localDictationEventAllowed(session, live, "chat-a")) return;
          draft = draft === "" ? t : `${draft} ${t}`;
        },
        onInterim: (t) => {
          if (session.stale) return;
          session.lastInterim = t;
        },
        onEnd: () => {
          session.finalizing = false;
        },
        onError: () => {},
      })!;
      session.recs.push(FakeRecognition.last!);
      return { session, h };
    };
    const first = open();
    FakeRecognition.last!.hear("ancienne fin", false);
    // The user's Stop: the engine settles for its grace.
    first.session.finalizing = true;
    first.h.stop();
    // …and resumes at once, before the stopped engine's final.
    open();
    first.session.recs[0]!.hear("ancienne fin finalisée", true); // too late: stale
    FakeRecognition.last!.hear("nouvelle phrase", true);
    expect(draft).toBe("ancienne fin nouvelle phrase");

    // When the final DID arrive before the resume, nothing is folded: no duplicate.
    draft = "";
    live = null;
    const third = open();
    FakeRecognition.last!.hear("dit", false);
    third.session.finalizing = true;
    third.h.stop();
    FakeRecognition.last!.hear("dit en entier", true); // settles: the hypothesis clears
    open();
    FakeRecognition.last!.hear("puis la suite", true);
    expect(draft).toBe("dit en entier puis la suite");
  });

  it("pinned panel: resuming during the finalizing window folds the hypothesis into the draft once", () => {
    holdDictation({
      targetChatId: "chat-a",
      targetLabel: "A",
      text: "début",
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop: () => {},
    });
    const oldGen = currentEngineGen();
    setHeldInterim("ancienne fin");
    stopHeldEngine();
    markHeldFinalizing(oldGen);
    reattachHeldEngine(() => {}); // the mic, clicked again at once
    expect(getHeldDictation()?.text).toBe("début ancienne fin");
    expect(getHeldDictation()?.interim).toBe("");
    // The old engine's late final is checked against its generation: dropped.
    expect(oldGen !== currentEngineGen()).toBe(true);
    // The new engine's words follow.
    setHeldInterim("nouvelle phrase");
    expect(getHeldDictation()?.text).toBe("début ancienne fin");
  });
});

describe("every path that ends or hands over a held dictation keeps the words in flight once (Codex pass 5)", () => {
  beforeEach(() => {
    releaseHeldDictation();
  });
  const pinLive = () => {
    holdDictation({
      targetChatId: "chat-a",
      targetLabel: "A",
      text: "Bonjour",
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop: () => {},
    });
    setHeldInterim("le monde");
    return currentEngineGen();
  };
  /** "Récupérer ici": the target composer absorbs the restore, then releases (Composer). */
  const restoreHere = () => {
    requestHeldRestore();
    const restored = getHeldDictation()!.pendingRestore;
    clearHeldPendingRestore();
    releaseHeldDictation();
    return restored;
  };

  it("Récupérer ici while recording: the restored draft holds the phrase in progress, the late final is dropped", () => {
    const sessionGen = pinLive();
    expect(restoreHere()).toBe("Bonjour le monde");
    expect(sessionGen !== currentEngineGen()).toBe(true);
  });

  it("Récupérer ici while finalizing (after the panel's Stop): same", () => {
    const sessionGen = pinLive();
    stopHeldEngine();
    markHeldFinalizing(sessionGen);
    expect(restoreHere()).toBe("Bonjour le monde");
    expect(sessionGen !== currentEngineGen()).toBe(true);
  });

  it("the composer's own stop/release while held here hands the phrase in progress back, once", () => {
    const sessionGen = pinLive();
    expect(releaseHeldKeepingWords()).toBe("le monde");
    expect(getHeldDictation()).toBeNull();
    expect(sessionGen !== currentEngineGen()).toBe(true);
    // Nothing held, nothing live: no words.
    expect(releaseHeldKeepingWords()).toBe("");
  });

  it("a resume while still recording folds the phrase in progress too", () => {
    const sessionGen = pinLive();
    reattachHeldEngine(() => {});
    expect(getHeldDictation()?.text).toBe("Bonjour le monde");
    expect(getHeldDictation()?.interim).toBe("");
    expect(sessionGen !== currentEngineGen()).toBe(true);
  });

  it("a discard keeps nothing (the draft is thrown away)", () => {
    pinLive();
    releaseHeldDictation();
    expect(getHeldDictation()).toBeNull();
  });
});

describe("the hypothesis is handed over at every transfer, from the real upstream state (Codex pass 6)", () => {
  /** A composer dictation as the controller runs it: a real engine session, its draft and
   *  `lastInterim` filled by the engine's own events — then pinned exactly as `hold()`
   *  does (text + the live session's hypothesis + its stop), and routed to the hold like
   *  the controller's callbacks (generation-checked). Nothing is pre-seeded in the store. */
  const dictateThenPin = (final: string | null, interim: string) => {
    let draft = "";
    const session: ComposerDictationSession & { holdGen?: number } = { startedChatId: "chat-a", stale: false };
    const h = startDictation({
      lang: "fr-FR",
      onText: (t, meta) => {
        if (session.holdGen !== undefined) {
          if (session.holdGen !== currentEngineGen()) return;
          appendHeldDictation(t, meta.paragraph);
          return;
        }
        draft = draft === "" ? t : `${draft} ${t}`;
      },
      onInterim: (t) => {
        if (session.holdGen !== undefined && session.holdGen !== currentEngineGen()) return;
        session.lastInterim = t;
        if (session.holdGen !== undefined) setHeldInterim(t);
      },
      onEnd: () => {},
      onError: () => {},
    })!;
    const rec = FakeRecognition.last!;
    if (final !== null) rec.hear(final, true);
    rec.hear(interim, false);
    // hold(): the controller's own call.
    holdDictation({
      targetChatId: "chat-a",
      targetLabel: "A",
      text: draft,
      interim: session.lastInterim ?? "",
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop: () => h.stop(),
    });
    session.holdGen = currentEngineGen();
    return { rec, h };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition });
    releaseHeldDictation();
  });
  afterEach(() => {
    releaseHeldDictation();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pin keeps the hypothesis as a hypothesis (not glued to the text)", () => {
    dictateThenPin("Bonjour", "le monde");
    expect(getHeldDictation()?.text).toBe("Bonjour");
    expect(getHeldDictation()?.interim).toBe("le monde");
  });

  it("pin → Récupérer ici before the next voice result: 'Bonjour le monde', the late final dropped", () => {
    const { rec } = dictateThenPin("Bonjour", "le monde");
    requestHeldRestore();
    const restored = getHeldDictation()!.pendingRestore;
    clearHeldPendingRestore();
    releaseHeldDictation();
    rec.hear("le monde", true); // the engine's late final: stale
    expect(restored).toBe("Bonjour le monde");
    expect(getHeldDictation()).toBeNull();
  });

  it("pin → Récupérer ici when everything was hypothesis: the draft is that hypothesis, not empty", () => {
    dictateThenPin(null, "tout en vol");
    requestHeldRestore();
    expect(getHeldDictation()!.pendingRestore).toBe("tout en vol");
  });

  it("pin → Send from the panel: the hypothesis rides the send", () => {
    dictateThenPin("Bonjour", "le monde");
    const held = getHeldDictation()!;
    const sent = heldSendText(held);
    retireHeldEngine();
    requestHeldSend(sent);
    expect(sent).toBe("Bonjour le monde");
  });

  it("pin → panel Stop → Récupérer ici during finalizing: kept once", () => {
    const { rec } = dictateThenPin("Bonjour", "le monde");
    const gen = currentEngineGen();
    stopHeldEngine();
    markHeldFinalizing(gen);
    requestHeldRestore();
    rec.hear("le monde", true); // stale
    expect(getHeldDictation()!.pendingRestore).toBe("Bonjour le monde");
    expect(getHeldDictation()!.text).toBe("Bonjour le monde");
  });

  it("pin → the composer's own stop while held here: the words come back once", () => {
    const { rec } = dictateThenPin("Bonjour", "le monde");
    expect(releaseHeldKeepingWords()).toBe("le monde");
    rec.hear("le monde", true); // stale
    expect(getHeldDictation()).toBeNull();
  });

  it("pin → resume (reattach) while recording: folded once, the new engine's words follow", () => {
    const { rec } = dictateThenPin("Bonjour", "le monde");
    reattachHeldEngine(() => {});
    rec.hear("le monde", true); // the old engine: stale
    expect(getHeldDictation()?.text).toBe("Bonjour le monde");
    expect(getHeldDictation()?.interim).toBe("");
  });

  it("pin → the engine's own final settles the hypothesis: nothing is lost nor doubled", () => {
    const { rec } = dictateThenPin("Bonjour", "le monde");
    rec.hear("le monde", true);
    expect(getHeldDictation()?.text).toBe("Bonjour le monde");
    expect(getHeldDictation()?.interim).toBe("");
  });

  it("pin → discard: nothing kept", () => {
    dictateThenPin("Bonjour", "le monde");
    releaseHeldDictation();
    expect(getHeldDictation()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// PROPERTY TEST (Codex pass 7), the detached panel: seeded random timelines of engine events
// and user actions (Stop, immediate resume, Send, Récupérer ici, release keeping words,
// discard, re-pin) against the REAL startDictation + held store, sessions routed as the
// controller and the panel route them (generation-checked). Invariants:
//   (a) every final a CURRENT session emits reaches the surviving text exactly once;
//   (b) the text sent equals the text the panel shows at the click, and every transfer
//       (send, Récupérer ici, release keeping words, resume) keeps exactly what was shown;
//   (c) nothing from a retired session (late event of an older engine) appears anywhere.
// ---------------------------------------------------------------------------------------

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

class PanelRecognition {
  static last: PanelRecognition | null = null;
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((ev: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onaudioend: (() => void) | null = null;
  dead = false;
  private results: Array<{ isFinal: boolean; 0: { transcript: string } }> = [];
  constructor() {
    PanelRecognition.last = this;
  }
  start() {}
  stop() {}
  abort() {
    this.dead = true;
  }
  emit(transcript: string, isFinal: boolean) {
    const last = this.results[this.results.length - 1];
    const i = last !== undefined && !last.isFinal ? this.results.length - 1 : this.results.length;
    this.results[i] = { isFinal, 0: { transcript } };
    this.onresult?.({ resultIndex: i, results: this.results });
  }
}

/** What the panel shows: its text, plus the hypothesis while the mic is live or settling. */
const shownOf = (h: { text: string; interim: string; recording: boolean; finalizing: boolean }) =>
  h.recording || h.finalizing ? visibleDictationText(h.text, h.interim) : h.text;

type PanelSession = { gen: number; recs: PanelRecognition[]; h: { stop: () => void; discard: () => void } };

function runPanelTimeline(seed: number): string | null {
  const rnd = prng(seed);
  releaseHeldDictation();
  const sessions: PanelSession[] = [];
  let expected: string[] = [];
  let n = 0;
  const openSession = (): PanelSession => {
    const s = { gen: -1, recs: [] as PanelRecognition[] } as unknown as PanelSession;
    const h = startDictation({
      lang: "fr-FR",
      onText: (t, meta) => {
        if (s.gen !== currentEngineGen()) return;
        appendHeldDictation(t, meta.paragraph);
      },
      onInterim: (t) => {
        if (s.gen !== currentEngineGen()) return;
        setHeldInterim(t);
      },
      onEnd: () => markHeldEngineEnded(s.gen),
      onError: () => {},
    })!;
    s.h = h;
    s.recs.push(PanelRecognition.last!);
    sessions.push(s);
    return s;
  };
  /** A fresh pin: a composer dictation handed to the panel (hold(), then its generation). */
  const pin = () => {
    const s = openSession();
    holdDictation({
      targetChatId: "chat-a",
      targetLabel: "A",
      text: "",
      interim: "",
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop: () => s.h.stop(),
    });
    s.gen = currentEngineGen();
    expected = [];
  };
  const current = () => sessions.find((s) => s.gen === currentEngineGen()) ?? null;
  const liveRec = (s: PanelSession | null) => {
    const r = s?.recs[s.recs.length - 1] ?? null;
    return r !== null && !r.dead && r === PanelRecognition.last ? r : null;
  };
  /** The surviving text of a draft must hold every expected final once, in order. */
  const check = (label: string, text: string): string | null => {
    const toks = text.split(/\s+/).filter(Boolean);
    if (new Set(toks).size !== toks.length) return `${label}: duplicate in "${text}"`;
    if (toks.some((t) => t.startsWith("s"))) return `${label}: stale words in "${text}"`;
    const finals = toks.filter((t) => t.startsWith("f"));
    if (JSON.stringify(finals) !== JSON.stringify(expected)) {
      return `${label}: finals ${JSON.stringify(finals)} != expected ${JSON.stringify(expected)} ("${text}")`;
    }
    return null;
  };
  pin();
  for (let step = 0; step < 50; step++) {
    const x = rnd();
    const held = getHeldDictation();
    if (held === null) {
      pin();
      continue;
    }
    const s = current();
    const r = liveRec(s);
    if (x < 0.22) {
      if (r !== null) r.emit(`i${++n}`, false);
    } else if (x < 0.4) {
      if (r !== null) {
        const tok = `f${++n}`;
        r.emit(tok, true);
        expected.push(tok);
      }
    } else if (x < 0.45) {
      if (r !== null) {
        r.dead = true;
        r.onend?.();
      }
    } else if (x < 0.5) {
      // A late final of a retired session.
      const old = sessions.filter((o) => o !== s);
      const o = old[Math.floor(rnd() * old.length)];
      const orec = o?.recs[o.recs.length - 1];
      if (orec !== undefined) orec.emit(`s${++n}`, true);
    } else if (x < 0.57) {
      // The panel's Stop.
      if (held.recording && s !== null) {
        const gen = currentEngineGen();
        stopHeldEngine();
        markHeldFinalizing(gen);
      }
    } else if (x < 0.63) {
      // The mic again (immediate resume included).
      if (!held.recording) {
        const shownBefore = shownOf(held);
        const ns = openSession();
        reattachHeldEngine(() => ns.h.stop());
        ns.gen = currentEngineGen();
        if (getHeldDictation()!.text !== shownBefore) return `resume: "${getHeldDictation()!.text}" != shown "${shownBefore}"`;
      }
    } else if (x < 0.69) {
      // Send.
      const shown = shownOf(held);
      const sent = heldSendText(held);
      if (held.recording || held.finalizing) retireHeldEngine();
      // A refused send leaves the draft as it was sent (the release only follows success).
      if (getHeldDictation()!.text !== sent) return `send: draft "${getHeldDictation()!.text}" != sent "${sent}"`;
      requestHeldSend(sent);
      releaseHeldDictation();
      if (sent !== shown) return `send: sent "${sent}" != shown "${shown}"`;
      const bad = check("send", sent);
      if (bad !== null) return bad;
      pin();
    } else if (x < 0.74) {
      // Récupérer ici.
      const shown = shownOf(held);
      requestHeldRestore();
      const restored = getHeldDictation()!.pendingRestore ?? "";
      if (restored !== shown) return `restore: "${restored}" != shown "${shown}"`;
      clearHeldPendingRestore();
      releaseHeldDictation();
      const bad = check("restore", restored);
      if (bad !== null) return bad;
      pin();
    } else if (x < 0.78) {
      // The composer's own stop/release while held here (it mirrors the held text).
      const mirror = held.text;
      const shown = shownOf(held);
      const words = releaseHeldKeepingWords();
      if ((words === "" ? mirror : `${mirror} ${words}`).trim() !== shown.trim()) {
        return `release: "${mirror}" + "${words}" != shown "${shown}"`;
      }
      const bad = check("release", words === "" ? mirror : `${mirror} ${words}`);
      if (bad !== null) return bad;
      pin();
    } else if (x < 0.8) {
      releaseHeldDictation(); // discard: the draft is gone, nothing expected
      pin();
    } else {
      vi.advanceTimersByTime(Math.floor(rnd() * 6_000));
    }
  }
  // The end: let every engine settle, then the draft that survives is checked.
  const held = getHeldDictation();
  if (held !== null && held.recording) {
    const gen = currentEngineGen();
    stopHeldEngine();
    markHeldFinalizing(gen);
  }
  vi.runAllTimers();
  const last = getHeldDictation();
  if (last !== null) {
    const bad = check("final draft", visibleDictationText(last.text, last.finalizing || last.recording ? last.interim : ""));
    if (bad !== null) return bad;
  }
  return null;
}

describe("property: random panel timelines against the real engine and held store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { webkitSpeechRecognition: PanelRecognition });
  });
  afterEach(() => {
    releaseHeldDictation();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("holds its invariants over 2,000 seeds", () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      let failure: string | null;
      try {
        failure = runPanelTimeline(seed);
      } catch (e) {
        failure = String(e);
      }
      if (failure !== null) throw new Error(`seed ${seed}: ${failure}`);
    }
  });
});

// ---------------------------------------------------------------------------------------
// PROPERTY TEST (Codex pass 8), the INLINE composer: seeded random timelines mixing engine
// events with inline user actions (start, Stop, immediate restart, send by button/Enter,
// typing, clearing, chat switch A↔B), against the REAL startDictation and the controller's
// rules (inlineDictation.ts: inlineFinal, inlineHypothesisShown, retirePreviousForStart,
// sessionOwnsWords, takeComposerForSend), the controller glue reproduced line for line
// (handle, mic state, ghost). Invariants:
//   (a) every final of the current session lands exactly once in a sent message or the
//       surviving draft (unless the user cleared it);
//   (b) the text sent equals the text the composer showed (draft + ghost);
//   (c) after a send, no engine event of a session that existed at that send ever adds
//       anything to the composer;
//   (d) nothing dictated in chat A is ever added to the composer while it shows chat B.
// ---------------------------------------------------------------------------------------

class InlineRecognition {
  static instances: InlineRecognition[] = [];
  owner = -1;
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((ev: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onaudioend: (() => void) | null = null;
  dead = false;
  private results: Array<{ isFinal: boolean; 0: { transcript: string } }> = [];
  constructor() {
    InlineRecognition.instances.push(this);
  }
  start() {}
  stop() {}
  abort() {
    this.dead = true;
  }
  emit(transcript: string, isFinal: boolean) {
    const last = this.results[this.results.length - 1];
    const i = last !== undefined && !last.isFinal ? this.results.length - 1 : this.results.length;
    this.results[i] = { isFinal, 0: { transcript } };
    this.onresult?.({ resultIndex: i, results: this.results });
  }
}

function runInlineTimeline(seed: number): string | null {
  const rnd = prng(seed);
  InlineRecognition.instances = [];
  let chat = "A";
  let draft = "";
  const host: InlineHost = { chatId: () => chat, getText: () => draft, setText: (t) => (draft = t) };
  // The controller's React state and refs.
  let live = null as InlineSession | null;
  let handle = null as DictationHandle | null;
  let micOn = false;
  let finalizingView = false;
  let ghost = "";
  const sessions: Array<InlineSession & { id: number }> = [];
  const tokensOf = new Map<string, number>(); // dictated token -> session id
  const expected: string[] = [];
  const sent: string[] = [];
  const cleared = new Set<string>();
  const forbidden = new Set<number>(); // sessions that existed at a send
  let n = 0;
  let violation: string | null = null;

  const toks = (t: string) => t.split(/\s+/).filter(Boolean);
  let before = new Set<string>();
  const observe = (label: string) => {
    const now = toks(draft);
    for (const t of now) {
      if (before.has(t)) continue;
      const sid = tokensOf.get(t);
      if (sid === undefined) continue;
      const s = sessions.find((x) => x.id === sid)!;
      if (forbidden.has(sid)) violation ??= `(c) ${label}: "${t}" from session ${sid} after a send`;
      if (s.startedChatId !== chat) violation ??= `(d) ${label}: "${t}" from chat ${s.startedChatId} in chat ${chat}`;
    }
    before = new Set(now);
  };

  const start = () => {
    retirePreviousForStart(live, host);
    finalizingView = false;
    ghost = "";
    const id = sessions.length;
    const session = { id, h: null, boundToHold: false, startedChatId: chat, stale: false, recording: false } as InlineSession & {
      id: number;
    };
    class Owned extends InlineRecognition {
      constructor() {
        super();
        this.owner = id;
      }
    }
    vi.stubGlobal("window", { webkitSpeechRecognition: Owned });
    live = session;
    sessions.push(session);
    const h = startDictation({
      lang: "fr-FR",
      onText: (t, meta) => {
        if (session.stale) return;
        inlineFinal(session, live, host, t, meta.paragraph);
      },
      onInterim: (t) => {
        if (session.stale) return;
        session.lastInterim = t;
        if (inlineHypothesisShown(session, live, host)) ghost = t;
      },
      onEnd: () => {
        session.finalizing = false;
        session.recording = false;
        session.ended = true;
        if (session.stale || (handle !== null && handle !== session.h)) return;
        handle = null;
        micOn = false;
        finalizingView = false;
        ghost = "";
      },
      onError: () => {},
    })!;
    session.h = h;
    handle = h;
    session.recording = true;
    micOn = true;
  };
  const stop = () => {
    const local = handle !== null && live !== null && live.h === handle;
    if (local) {
      live!.finalizing = true;
      live!.recording = false;
    }
    handle?.stop();
    handle = null;
    micOn = false;
    if (local) finalizingView = true;
    else ghost = "";
  };
  /** Send (button or Enter): the dictation path while the composer's view says the mic owns
   *  the send, else the plain composer send. */
  const send = () => {
    // The composer's view (ConvexChat.tsx): `ownsSend` = mic on or finalizing; the ghost
    // shows while either holds.
    const ownsSend = micOn || finalizingView;
    const shown = ownsSend && ghost !== "" ? visibleDictationText(draft, ghost) : draft;
    let text: string;
    if (ownsSend) {
      text = takeComposerForSend(live, host);
      handle = null;
      micOn = false;
      finalizingView = false;
      ghost = "";
    } else {
      text = draft;
    }
    if (text.trim() === "") return;
    if (text !== shown) violation ??= `(b) sent "${text}" != shown "${shown}"`;
    sent.push(text);
    for (const s of sessions) forbidden.add(s.id);
    draft = "";
    before = new Set();
  };
  const switchChat = () => {
    if (handle !== null && live !== null) live.stale = true;
    if (live !== null && live.finalizing === true && !live.boundToHold) {
      live.stale = true;
      live.h?.discard();
    }
    handle?.discard();
    handle = null;
    micOn = false;
    finalizingView = false;
    ghost = "";
    chat = chat === "A" ? "B" : "A";
  };
  const newestAlive = (sid: number) => {
    const mine = InlineRecognition.instances.filter((r) => r.owner === sid);
    const r = mine[mine.length - 1];
    return r !== undefined && !r.dead ? r : null;
  };

  for (let step = 0; step < 60 && violation === null; step++) {
    const x = rnd();
    const s = live as (InlineSession & { id: number }) | null;
    const r = s !== null ? newestAlive(s.id) : null;
    if (x < 0.2) {
      if (r !== null && s !== null) {
        const tok = `${s.startedChatId}i${++n}`;
        tokensOf.set(tok, s.id);
        r.emit(tok, false);
      }
    } else if (x < 0.36) {
      if (r !== null && s !== null) {
        const tok = `${s.startedChatId}f${++n}`;
        tokensOf.set(tok, s.id);
        if (s === live && !s.stale && !s.ended && s.startedChatId === chat) expected.push(tok);
        r.emit(tok, true);
      }
    } else if (x < 0.4) {
      r?.onaudioend?.();
    } else if (x < 0.45) {
      if (r !== null) {
        r.dead = true;
        r.onend?.();
      }
    } else if (x < 0.48) {
      // A late event of an older session's engine.
      const old = sessions[Math.floor(rnd() * sessions.length)];
      const orec = old !== undefined ? InlineRecognition.instances.filter((i) => i.owner === old.id).pop() : undefined;
      if (orec !== undefined && old !== live) {
        const tok = `${old!.startedChatId}f${++n}`;
        tokensOf.set(tok, old!.id);
        orec.emit(tok, true);
      }
    } else if (x < 0.55) {
      if (!micOn) start();
    } else if (x < 0.61) {
      if (micOn) stop();
    } else if (x < 0.68) {
      send();
    } else if (x < 0.72) {
      draft = draft === "" ? `t${++n}` : `${draft} t${++n}`;
    } else if (x < 0.74) {
      for (const t of toks(draft)) cleared.add(t);
      draft = "";
      before = new Set();
    } else if (x < 0.78) {
      switchChat();
    } else {
      vi.advanceTimersByTime(Math.floor(rnd() * 6_000));
    }
    observe(`step ${step}`);
  }
  if (violation !== null) return violation;
  if (micOn) stop();
  vi.runAllTimers();
  observe("end");
  if (violation !== null) return violation;
  // (a)
  const all = [...sent.flatMap(toks), ...toks(draft)];
  if (new Set(all).size !== all.length) return `(a) duplicate in ${JSON.stringify(all)}`;
  for (const t of expected) {
    if (!all.includes(t) && !cleared.has(t)) return `(a) final ${t} lost (sent ${JSON.stringify(sent)}, draft "${draft}")`;
  }
  return null;
}

describe("property: random inline-composer timelines against the real engine and controller rules", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("holds its invariants over 2,000 seeds", () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      let failure: string | null;
      try {
        failure = runInlineTimeline(seed);
      } catch (e) {
        failure = String(e);
      }
      if (failure !== null) throw new Error(`seed ${seed}: ${failure}`);
    }
  });
});
