/// <reference types="vite/client" />
//
// The context-overflow card's WIRED exits (W2, P4).
//
// The label used to end with advice — and one of the things it advised was
// `/reset`, a command Atrium does not have. Two pins here: the refusal
// classifier (a gateway that DECLINED to compact must not read as a defect — the
// other exit is the one that works), and the label itself, which must no longer
// tell the user what to do by hand.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import { isCompactRefusal } from "./ContextLengthActions";
import { CONTEXT_OVERFLOW_CODES, errorDetailView } from "./runStatusView";

describe("isCompactRefusal", () => {
  test("every gateway REFUSAL is recognized as such", () => {
    for (const err of [
      new Error("already_in_flight"),
      new Error("already_active"),
      new Error("deferred_compaction_not_scheduled"),
      new Error("below_threshold"),
      new Error("already_compacted_recently"),
      new Error("unsupported_harness_compaction"),
      // The CANONICAL form raised by compactSession from the bridge's own
      // `{compacted:false, reason}` answer — the only one that actually reaches
      // this function on the overflow card's button.
      new Error("compact_refused"),
      new Error("compact_refused:no transcript"),
      new Error("compact_refused:already_active"),
      // The structural reasons the pre-send guard blocks on must ALSO read as
      // refusals here: they are exactly the sessions whose user presses this
      // button, and "that did not work" would be the wrong thing to tell them.
      new Error("no transcript"),
      new Error("no sessionId"),
    ]) {
      expect(isCompactRefusal(err), err.message).toBe(true);
    }
  });

  test("a ConvexError's payload is read too (its message is not the code)", () => {
    // A ConvexError reaching the client carries the string in `.data`; reading only
    // `.message` would classify every real refusal as a defect.
    expect(isCompactRefusal({ data: "compact_refused:no transcript" })).toBe(true);
  });

  test("a REAL failure is not a refusal (it must report as a failure)", () => {
    expect(isCompactRefusal(new Error("HTTP 500"))).toBe(false);
    expect(isCompactRefusal(new Error("no_agent"))).toBe(false);
    expect(isCompactRefusal(undefined)).toBe(false);
  });
});

describe("the whole overflow FAMILY gets the wired exits", () => {
  test("each overflow class has a label, and the card acts on all of them", () => {
    // A class added to one list and forgotten in the other shows the right
    // headline with no way out — the exact dead end this lot removes.
    const dir = new URL("../../messages/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const code of CONTEXT_OVERFLOW_CODES) {
      for (const f of files) {
        const msgs = JSON.parse(readFileSync(new URL(f, dir), "utf-8"));
        expect(
          String(msgs[`runstatus_error_${code}`] ?? ""),
          `${code} in ${f}`,
        ).not.toBe("");
      }
    }
  });

  test("an overflow recognized only by its PHRASING still gets the actions", () => {
    // `errorDetailView` has a text fallback for a bare overflow with no errorCode
    // (an older or divergent bridge). The card keys its buttons on the RESOLVED
    // class, so that case gets a headline AND a way out — keying on the raw
    // errorCode left it a dead end on the one failure the app can act on itself.
    const view = errorDetailView("maximum context length exceeded", null);
    expect(view.headline).not.toBeNull();
    expect(view.code).toBe("context_length");
    expect(CONTEXT_OVERFLOW_CODES.has(view.code!)).toBe(true);
  });

  test("an unrelated failure resolves to no overflow class", () => {
    // The mirror image: the actions must not appear on a failure they cannot fix.
    const view = errorDetailView("no_agent", null);
    expect(
      view.code === null || !CONTEXT_OVERFLOW_CODES.has(view.code),
    ).toBe(true);
  });

  test("the card reads the CONVEX message id, not assistant-ui's own", () => {
    // `forkChat` takes an `Id<"messages">`. Every other per-message action in the
    // app reads `custom.messageId` for exactly that reason; keying the branch
    // button on the framework's `msg.id` would leave the withheld-send card with
    // one working exit instead of the two it promises — on the one turn that has no
    // other way out.
    const src = readFileSync(new URL("./RunStatus.tsx", import.meta.url), "utf-8");
    const ctx = src.slice(src.indexOf("const ctxMessageId"));
    expect(ctx.slice(0, 300)).toMatch(/custom as \{ messageId\?/);
  });

  test("each action REPORTS what it did (silence reads as nothing happened)", () => {
    expect(m.ctxerr_act_compacted().length).toBeGreaterThan(20);
    expect(m.ctxerr_act_branched().length).toBeGreaterThan(20);
  });

  test("the WITHHELD send does not claim the turn ran", () => {
    // Nothing was sent and nothing was billed: reusing the mid-turn overflow
    // wording would have told the user their agent had tried and failed.
    const dir = new URL("../../messages/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const msgs = JSON.parse(readFileSync(new URL(f, dir), "utf-8"));
      const withheld = String(msgs.runstatus_error_context_length_presend ?? "");
      expect(withheld, f).not.toBe(
        String(msgs.runstatus_error_context_length ?? ""),
      );
      expect(withheld.toLowerCase(), f).toMatch(/not sent|n'a pas été envoyé/);
    }
  });
});

describe("the context_length label (P4)", () => {
  test("states the FACT and stops — no manual workaround, no `/reset`, in EVERY locale", () => {
    // Read the message FILES, not the compiled accessor: that one resolves a
    // single locale, so advice re-added to the other translation would sail
    // through. P4 applies to every language the app ships.
    const dir = new URL("../../messages/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const label = String(
        JSON.parse(readFileSync(new URL(f, dir), "utf-8"))
          .runstatus_error_context_length ?? "",
      );
      expect(label, f).not.toMatch(/\/reset/);
      // The exits are BUTTONS now; the sentence must not prescribe them.
      expect(label.toLowerCase(), f).not.toMatch(
        /réessayez|retry|compactez|compact the session|démarrez un nouveau|start a new chat/,
      );
    }
  });

  test("the two exits have their own labels", () => {
    expect(m.ctxerr_act_compact()).not.toBe("");
    expect(m.ctxerr_act_branch()).not.toBe("");
    // A refusal explains WHY and points at the other exit.
    expect(m.ctxerr_act_compact_refused().length).toBeGreaterThan(30);
  });
});
