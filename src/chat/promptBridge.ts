// Bridge between the right-panel document viewer and the chat COMPOSER: the
// "use in prompt" action needs to attach a file (instances with attachment
// support) or insert fenced inline text (instances without — Hermes), from a
// component that renders OUTSIDE the composer. The composer publishes its
// capabilities into a ref-carried contract; the viewer consumes it on click.
//
// Pure helpers below are unit-tested; the context itself is wiring.

import { createContext, type MutableRefObject } from "react";

export interface PromptBridge {
  /** TRUE when a file can be attached RIGHT NOW: the routed instance
   *  supports attachments AND the composer is not in queued mode (queued
   *  follow-ups are text-only — an attachment would silently not ride). */
  canAttach: boolean;
  /** Add a file to the composer (existing attachment pipeline: chips, size
   *  policy, shared-fs/inline transport). */
  attachFile: (file: File) => Promise<void>;
  /** Append text to the composer draft (the inline fallback). */
  insertText: (text: string) => void;
}

/** THE composer's contract, module-level so the two subtrees that need it can
 *  reach it without being nested one inside the other.
 *
 *  The viewer moved out of the conversation and into the persistent column,
 *  which is the conversation's SIBLING — outside any provider it renders. The
 *  context alone would hand that viewer a null bridge, and "use in prompt" would
 *  report itself unavailable on every document. There is one composer on screen
 *  at a time, so one ref is the honest shape; the context stays for the nested
 *  case and simply defaults to it. */
export const sharedPromptBridge: MutableRefObject<PromptBridge | null> = {
  current: null,
};

export const PromptBridgeContext =
  createContext<MutableRefObject<PromptBridge | null> | null>(
    sharedPromptBridge,
  );

/** A backtick fence LONGER than any run inside the content, so a markdown
 *  document containing ``` blocks nests safely (min 3). */
export function fenceFor(text: string): string {
  let longest = 0;
  const runs = text.match(/`+/g);
  if (runs !== null) {
    for (const run of runs) longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** The inline block sent when attachments are unsupported: a labeled fenced
 *  copy of the edited document the agent can read from the prompt itself.
 *  `label` is the localized "(edited by the user)" framing (i18n key). */
export function buildInlineDocBlock(
  filename: string,
  text: string,
  label: string,
): string {
  const fence = fenceFor(text);
  return `\n${filename} ${label}\n${fence}\n${text}\n${fence}\n`;
}
