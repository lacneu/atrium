import { describe, expect, it, beforeEach } from "vitest";
import {
  appendDictated,
  clampGeometry,
  clearHeldPendingSend,
  clearHeldPendingRestore,
  currentEngineGen,
  endHeldSendingById,
  reattachHeldEngine,
  releaseHeldDictationById,
  requestHeldSend,
  requestHeldRestore,
  setHeldGeometry,
  appendHeldDictation,
  getHeldDictation,
  holdDictation,
  markHeldEngineEnded,
  releaseHeldDictation,
  setHeldInterim,
  stopHeldEngine,
  subscribeHeldDictation,
  syncHeldText,
} from "./dictationHold";

describe("appendDictated (spoken paragraphing)", () => {
  it("joins same-paragraph pieces with a single space", () => {
    expect(appendDictated("Bonjour", "le monde", false)).toBe("Bonjour le monde");
    expect(appendDictated("Bonjour  ", " le monde ", false)).toBe("Bonjour le monde");
  });
  it("a long spoken pause opens a paragraph", () => {
    expect(appendDictated("Premier point.", "Second point.", true)).toBe(
      "Premier point.\n\nSecond point.",
    );
  });
  it("empty pieces and empty current are inert/identity", () => {
    expect(appendDictated("texte", "   ", true)).toBe("texte");
    expect(appendDictated("", "début", true)).toBe("début");
  });
});

describe("held dictation store (the pin's lifecycle)", () => {
  beforeEach(() => {
    releaseHeldDictation();
  });

  it("hold -> append -> interim -> release round-trip, with notifications", () => {
    let notified = 0;
    const un = subscribeHeldDictation(() => notified++);
    let stopped = false;
    holdDictation({
      targetChatId: "chatA",
      targetLabel: "Ma conversation",
      voiceEnabled: false,
      voiceLang: "fr-FR",
      text: "Début",
      recording: true,
      stop: () => {
        stopped = true;
      },
    });
    appendHeldDictation("suite dictée", false);
    setHeldInterim("hypothèse en cours");
    const held = getHeldDictation();
    expect(held?.text).toBe("Début suite dictée");
    expect(held?.interim).toBe("hypothèse en cours");
    expect(held?.recording).toBe(true);
    const finalText = releaseHeldDictation();
    expect(finalText).toBe("Début suite dictée");
    expect(stopped).toBe(true);
    expect(getHeldDictation()).toBeNull();
    expect(notified).toBeGreaterThanOrEqual(4);
    un();
  });

  it("stopHeldEngine quiets the mic but keeps the text and the dock", () => {
    let stopped = false;
    holdDictation({
      targetChatId: "chatA",
      targetLabel: "L",
      voiceEnabled: false,
      voiceLang: "fr-FR",
      text: "T",
      stop: () => {
        stopped = true;
      },
    });
    stopHeldEngine();
    markHeldEngineEnded();
    expect(stopped).toBe(true);
    const held = getHeldDictation();
    expect(held).not.toBeNull();
    expect(held?.recording).toBe(false);
    expect(held?.text).toBe("T");
    // Release after an already-stopped engine never throws.
    expect(releaseHeldDictation()).toBe("T");
  });

  it("syncHeldText mirrors the composer back into the store (dock preview truth)", () => {
    holdDictation({ targetChatId: "c", targetLabel: "L", text: "a", voiceEnabled: false, voiceLang: "fr-FR", stop: () => {} });
    syncHeldText("a edited");
    expect(getHeldDictation()?.text).toBe("a edited");
  });

  it("ONE pin at a time: pinning over an existing hold is refused", () => {
    expect(
      holdDictation({ targetChatId: "A", targetLabel: "A", text: "brouillon A", voiceEnabled: false, voiceLang: "fr-FR", stop: () => {} }),
    ).toBe(true);
    expect(
      holdDictation({ targetChatId: "B", targetLabel: "B", text: "b", voiceEnabled: false, voiceLang: "fr-FR", stop: () => {} }),
    ).toBe(false);
    expect(getHeldDictation()?.targetChatId).toBe("A");
    expect(getHeldDictation()?.text).toBe("brouillon A");
  });

  it("reattach: a resumed dictation re-arms recording and the stop control", () => {
    holdDictation({ targetChatId: "A", targetLabel: "A", text: "t", voiceEnabled: false, voiceLang: "fr-FR", stop: () => {} });
    stopHeldEngine();
    markHeldEngineEnded();
    expect(getHeldDictation()?.recording).toBe(false);
    let stopped = false;
    reattachHeldEngine(() => {
      stopped = true;
    });
    expect(getHeldDictation()?.recording).toBe(true);
    releaseHeldDictation();
    expect(stopped).toBe(true);
  });

  it("append with a paragraph pause structures the held text too", () => {
    holdDictation({ targetChatId: "c", targetLabel: "L", text: "Un.", voiceEnabled: false, voiceLang: "fr-FR", stop: () => {} });
    appendHeldDictation("Deux.", true);
    expect(getHeldDictation()?.text).toBe("Un.\n\nDeux.");
  });

  it("markHeldEngineEnded ignores a STALE engine generation", () => {
    holdDictation({
      targetChatId: "A",
      targetLabel: "A",
      text: "t",
      voiceEnabled: true,
      voiceLang: "fr-FR",
      recording: true,
      stop: () => {},
    });
    const staleGen = currentEngineGen();
    // A newer engine reattaches (bumps the generation) and records again.
    reattachHeldEngine(() => {});
    expect(getHeldDictation()?.recording).toBe(true);
    // The OLD session's terminal must NOT settle the newer one.
    markHeldEngineEnded(staleGen);
    expect(getHeldDictation()?.recording).toBe(true);
    // The CURRENT generation's terminal does settle it.
    markHeldEngineEnded(currentEngineGen());
    expect(getHeldDictation()?.recording).toBe(false);
  });

  it("clampGeometry keeps the panel reachable on screen", () => {
    const vp = { w: 1000, h: 800 };
    // too big -> clamped to viewport + min sizes honored
    expect(clampGeometry({ x: 0, y: 0, w: 5000, h: 5000 }, vp)).toMatchObject({
      w: 1000,
      h: 800,
    });
    expect(clampGeometry({ x: 0, y: 0, w: 10, h: 10 }, vp)).toMatchObject({
      w: 300,
      h: 200,
    });
    // off the right/bottom -> pulled fully back into the viewport
    const off = clampGeometry({ x: 5000, y: 5000, w: 300, h: 200 }, vp);
    expect(off.x).toBe(1000 - 300);
    expect(off.y).toBe(800 - 200);
    // off the top-left -> flush to the top-left corner
    const left = clampGeometry({ x: -9999, y: -50, w: 300, h: 200 }, vp);
    expect(left.x).toBe(0);
    expect(left.y).toBe(0);
    // viewport SMALLER than the minimum -> size yields to the viewport (never
    // wider/taller than the screen), flush to the corner.
    const tiny = clampGeometry({ x: 0, y: 0, w: 300, h: 200 }, { w: 250, h: 150 });
    expect(tiny.w).toBe(250);
    expect(tiny.h).toBe(150);
    expect(tiny.x).toBe(0);
    expect(tiny.y).toBe(0);
  });

  it("requestHeldRestore/clear carries the text back for a non-destructive un-pin", () => {
    holdDictation({ targetChatId: "A", targetLabel: "A", text: "à récupérer", voiceEnabled: false, voiceLang: "fr-FR" });
    expect(getHeldDictation()?.pendingRestore).toBeNull();
    requestHeldRestore();
    expect(getHeldDictation()?.pendingRestore).toBe("à récupérer");
    clearHeldPendingRestore();
    expect(getHeldDictation()?.pendingRestore).toBeNull();
  });

  it("a pin carries the voice gate + language for the cross-chat panel", () => {
    holdDictation({
      targetChatId: "A",
      targetLabel: "A",
      text: "t",
      voiceEnabled: true,
      voiceLang: "en-US",
      recording: true,
      stop: () => {},
    });
    const held = getHeldDictation();
    expect(held?.voiceEnabled).toBe(true);
    expect(held?.voiceLang).toBe("en-US");
  });

  it("a MANUAL pin (no engine) holds just the text; recording is false", () => {
    expect(
      holdDictation({ targetChatId: "A", targetLabel: "A", text: "brouillon tapé", voiceEnabled: false, voiceLang: "fr-FR" }),
    ).toBe(true);
    const held = getHeldDictation();
    expect(held?.recording).toBe(false);
    expect(held?.text).toBe("brouillon tapé");
    expect(held?.geom).toBeDefined();
  });

  it("requestHeldSend/clear carries the text + marks sending + bumps a fresh id per action", () => {
    holdDictation({ targetChatId: "A", targetLabel: "A", text: "à envoyer", voiceEnabled: false, voiceLang: "fr-FR" });
    const holdId = getHeldDictation()?.holdId as number;
    requestHeldSend("à envoyer");
    expect(getHeldDictation()?.pendingSend).toBe("à envoyer");
    expect(getHeldDictation()?.sending).toBe(true);
    const firstSendId = getHeldDictation()?.pendingSendId as number;
    expect(firstSendId).toBeGreaterThan(0);
    clearHeldPendingSend();
    expect(getHeldDictation()?.pendingSend).toBeNull();
    // clearing the pending does NOT lift the in-flight lock (release/endSending does)
    expect(getHeldDictation()?.sending).toBe(true);
    // a RETRY of the SAME text is a DISTINCT action (fresh id) — never a replay
    requestHeldSend("à envoyer");
    expect(getHeldDictation()?.pendingSendId).toBeGreaterThan(firstSendId);
    // endHeldSendingById only unlocks the SAME pin
    endHeldSendingById(holdId + 999);
    expect(getHeldDictation()?.sending).toBe(true);
    endHeldSendingById(holdId);
    expect(getHeldDictation()?.sending).toBe(false);
  });

  it("releaseHeldDictationById only releases the SAME pin (a replaced pin survives)", () => {
    holdDictation({ targetChatId: "A", targetLabel: "A", text: "premier", voiceEnabled: false, voiceLang: "fr-FR" });
    const firstId = getHeldDictation()?.holdId as number;
    // the first pin is discarded and a NEW pin replaces it (fresh holdId)
    releaseHeldDictation();
    holdDictation({ targetChatId: "B", targetLabel: "B", text: "second", voiceEnabled: false, voiceLang: "fr-FR" });
    const secondId = getHeldDictation()?.holdId as number;
    expect(secondId).not.toBe(firstId);
    // a late resolve of the first send must NOT drop the new pin
    expect(releaseHeldDictationById(firstId)).toBe("");
    expect(getHeldDictation()?.text).toBe("second");
    // releasing the CURRENT pin by its id works
    expect(releaseHeldDictationById(secondId)).toBe("second");
    expect(getHeldDictation()).toBeNull();
  });

  it("setHeldGeometry clamps and persists", () => {
    holdDictation({ targetChatId: "A", targetLabel: "A", text: "t", voiceEnabled: false, voiceLang: "fr-FR" });
    setHeldGeometry({ x: 10, y: 20, w: 500, h: 400 });
    const g = getHeldDictation()?.geom;
    expect(g?.w).toBe(500);
    expect(g?.h).toBe(400);
  });

  it("store mutations without a hold are inert (no throw, no ghost state)", () => {
    appendHeldDictation("x", false);
    setHeldInterim("y");
    markHeldEngineEnded();
    expect(getHeldDictation()).toBeNull();
  });
});
