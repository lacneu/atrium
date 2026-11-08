// A status region announces a CHANGE of its content (lot 23): what a screen reader
// hears is the sequence of the region's contents. The picker's wiring to this helper is
// read from its syntax tree in src/chat/blockPickerWiring.test.ts.
import { describe, expect, test } from "vitest";
import { liveStatus, STATUS_REFILL_MS, type Schedule } from "./liveStatus";

/** The region as the page holds it, every content it took, and a clock run by hand. */
function region() {
  let content = "";
  const contents: string[] = [content];
  const timers: Array<{ at: number; task: () => void; live: boolean }> = [];
  let now = 0;
  const schedule: Schedule = (task, ms) => {
    const timer = { at: now + ms, task, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  const status = liveStatus((text) => {
    if (text !== content) contents.push(text);
    content = text;
  }, schedule);
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (timer.live && timer.at <= now) {
        timer.live = false;
        timer.task();
      }
    }
  };
  return { status, advance, contents, content: () => content };
}

const REFUSED = "Ce passage a changé depuis l’ouverture de la liste : rien n’a été fait.";

describe("a refusal is announced each time (lot 23)", () => {
  test("the region is empty until the first refusal, which fills it on a later task", () => {
    const r = region();
    expect(r.content()).toBe("");
    r.status.say(REFUSED);
    expect(r.content(), "filled in the same task: no change for a region that appears filled").toBe("");
    r.advance(STATUS_REFILL_MS);
    expect(r.content()).toBe(REFUSED);
  });

  test("two refusals in a row: two changes to the message, the second after the region was emptied", () => {
    const r = region();
    r.status.say(REFUSED);
    r.advance(STATUS_REFILL_MS);
    r.status.say(REFUSED);
    expect(r.content(), "the second refusal first empties the region").toBe("");
    r.advance(STATUS_REFILL_MS);
    expect(r.contents).toEqual(["", REFUSED, "", REFUSED]);
  });

  test("a refusal again before the first was filled: one filling, the latest", () => {
    const r = region();
    r.status.say("premier");
    r.advance(STATUS_REFILL_MS / 2);
    r.status.say(REFUSED);
    r.advance(STATUS_REFILL_MS);
    expect(r.contents).toEqual(["", REFUSED]);
  });

  test("cleared — the list closed or read anew: empty, and a filling still to come is dropped", () => {
    const r = region();
    r.status.say(REFUSED);
    r.status.clear();
    r.advance(STATUS_REFILL_MS * 2);
    expect(r.contents).toEqual([""]);
  });
});
