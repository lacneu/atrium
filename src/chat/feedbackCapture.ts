// What the reader was shown when they flagged a message: the source view's raw text when it
// was open, else the stored text the bubble rendered (FeedbackDialog.tsx). Pure over the
// DOM it is handed.

export function captureDisplayed(
  btn: HTMLElement,
  rawText: string,
  /** Phase 5: the bubble is the last of a delegation's display group. Its source view
   *  shows that bubble alone, while the report freezes the whole answer (convex/feedback.ts):
   *  the displayed text is then the group's, the open source only recorded. */
  grouped = false,
): { displayedText: string; sourceWasOpen: boolean } {
  const root = btn.closest(".oc-msg");
  const pre = root?.querySelector<HTMLElement>(".oc-msg__source-pre");
  const t = pre?.textContent;
  if (pre && t != null && t !== "(aucun texte)") {
    return { displayedText: grouped ? rawText : t, sourceWasOpen: true };
  }
  return { displayedText: rawText, sourceWasOpen: false };
}
