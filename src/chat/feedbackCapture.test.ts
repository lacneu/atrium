import { describe, expect, test } from "vitest";
import { captureDisplayed } from "./feedbackCapture";

const buttonIn = (sourceText: string | null) =>
  ({
    closest: () => ({
      querySelector: () => (sourceText === null ? null : { textContent: sourceText }),
    }),
  }) as unknown as HTMLElement;

describe("captureDisplayed", () => {
  test("a bubble alone: the open source view is what was shown", () => {
    expect(captureDisplayed(buttonIn("brut"), "stocké")).toEqual({ displayedText: "brut", sourceWasOpen: true });
    expect(captureDisplayed(buttonIn(null), "stocké")).toEqual({ displayedText: "stocké", sourceWasOpen: false });
  });
  test("the last bubble of a display group (phase 5, codex pass 2 #3): the whole answer, the open source only recorded", () => {
    expect(captureDisplayed(buttonIn("Résultat."), "Je délègue.\n\nRésultat.", true)).toEqual({
      displayedText: "Je délègue.\n\nRésultat.",
      sourceWasOpen: true,
    });
  });
});
