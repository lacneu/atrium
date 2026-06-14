import { m } from "@/paraglide/messages.js";
import type {
  ProvenanceItemView,
  ProvenancePartView,
} from "./convexTypes";

// Pure projections for the per-message "Sources" affordance (provenance/v1 —
// docs/PROVENANCE_CONTRACT.md). Mirrors the toolActivityView idiom: every
// label branch (including the parameterized plurals) is unit-testable without
// a DOM harness (GC-P5 lesson), and the component stays a thin shell.
//
// DATA-DRIVEN visibility: an instance without context-injecting plugins
// produces no provenance parts, so summarize() yields zero counts and the
// component renders NOTHING — no capability wiring, the data is the signal.

export interface SourcesSummary {
  /** Total MEMORY items (conversational recall) across parts. */
  memory: number;
  /** Total DOCUMENT items (documentary retrieval) across parts. */
  documents: number;
}

export function summarizeProvenance(
  parts: ProvenancePartView[],
): SourcesSummary {
  const summary: SourcesSummary = { memory: 0, documents: 0 };
  for (const part of parts) {
    if (part.group === "memory") summary.memory += part.items.length;
    else summary.documents += part.items.length;
  }
  return summary;
}

/** "2 souvenirs · 1 document" — every plural branch has its own message. */
export function summaryLabel(summary: SourcesSummary): string {
  const segments: string[] = [];
  if (summary.memory > 0) {
    segments.push(
      summary.memory === 1
        ? m.sources_memory_one()
        : m.sources_memory_plural({ count: summary.memory }),
    );
  }
  if (summary.documents > 0) {
    segments.push(
      summary.documents === 1
        ? m.sources_documents_one()
        : m.sources_documents_plural({ count: summary.documents }),
    );
  }
  return segments.join(" · ");
}

/** Display title for one retrieved item, by best identifying field. */
export function itemTitle(item: ProvenanceItemView): string {
  return item.file_name ?? item.id ?? item.type ?? m.sources_item_untitled();
}

/** Compact metadata chips for one item: type, date, collection, score. */
export function itemMeta(item: ProvenanceItemView): string[] {
  const chips: string[] = [];
  // For document items the title is the file name, so `type` is informative;
  // for memory items whose title IS the type, repeating it would be noise.
  if (item.type && itemTitle(item) !== item.type) chips.push(item.type);
  if (item.date) chips.push(item.date);
  if (item.collection) chips.push(item.collection);
  if (typeof item.score === "number") {
    chips.push(m.sources_score({ score: item.score.toFixed(2) }));
  }
  return chips;
}

/** Group parts for rendering: memory first (it frames the reply), then docs. */
export function orderedParts(
  parts: ProvenancePartView[],
): ProvenancePartView[] {
  return [...parts].sort((a, b) =>
    a.group === b.group ? 0 : a.group === "memory" ? -1 : 1,
  );
}

export function groupLabel(group: ProvenancePartView["group"]): string {
  return group === "memory"
    ? m.sources_group_memory()
    : m.sources_group_documents();
}
