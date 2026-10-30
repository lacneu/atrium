// The title of a reasoning block (0.103.0) — pure, so the rule is tested without a render.
//
// The DURATION is the turn's own, the one fact the bubble already shows (convertMessage.ts
// `generationMs`, read from the same metadata — never a second clock). It is said only where
// it is true of the reasoning: a settled turn that did nothing but think and answer. A turn
// that also ran tools spent part of that time in them, so its blocks are titled without it.

import { m } from "@/paraglide/messages.js";
import { formatDurationShort } from "@/lib/format";

export function thinkingTitle(facts: {
  /** The block is being written: the bubble runs and no answer follows it yet. */
  writing: boolean;
  /** The settled turn's duration (null: unknown or still running). */
  generationMs: number | null;
  /** The turn ran tools (its duration is not the reasoning's). */
  hasToolActivity: boolean;
}): string {
  if (facts.writing) return m.reasoning_title_writing();
  if (facts.generationMs !== null && Number.isFinite(facts.generationMs) && !facts.hasToolActivity) {
    const duration = formatDurationShort(facts.generationMs);
    if (duration !== null) return m.reasoning_title_duration({ duration });
  }
  return m.reasoning_title();
}
