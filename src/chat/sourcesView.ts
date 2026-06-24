import { m } from "@/paraglide/messages.js";
import type {
  ProvenanceItemView,
  ProvenancePartView,
} from "./convexTypes";
// THE single classification rule, shared with the server attach gate
// (convex/documentAttachments.ts) so the UI and the trust boundary never drift.
import { provenanceItemKind } from "../../convex/lib/provenance";

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
  /** FINDABLE document items (a documents-group item WITH a file_name — a real
   *  source the documentary agent can open/attach). */
  documents: number;
  /** Synthesized CONTEXT excerpts (a documents-group item with NO file_name, e.g.
   *  LightRAG's whole-graph blob): shown as provenance, but with no external
   *  source document to open/attach — so it is NOT counted as a "document". This
   *  documents-no-file_name → context rule is also the backward-compat default of
   *  the normalized contract (Phase 2). */
  context: number;
}

export function summarizeProvenance(
  parts: ProvenancePartView[],
): SourcesSummary {
  const summary: SourcesSummary = { memory: 0, documents: 0, context: 0 };
  for (const part of parts) {
    for (const item of part.items) {
      const kind = provenanceItemKind(item, part.group);
      if (kind === "memory") summary.memory += 1;
      else if (kind === "document") summary.documents += 1;
      else summary.context += 1;
    }
  }
  return summary;
}

/** Whether a reply has ANY provenance worth a Sources chip — memory, findable
 *  documents, OR a synthesized context excerpt. A context-only reply (a LightRAG
 *  turn that returned no per-file references) MUST still surface the chip, else
 *  the user can never open the panel to see its context source. */
export function hasProvenance(summary: SourcesSummary): boolean {
  return summary.memory + summary.documents + summary.context > 0;
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
  if (summary.context > 0) {
    segments.push(
      summary.context === 1
        ? m.sources_context_one()
        : m.sources_context_plural({ count: summary.context }),
    );
  }
  return segments.join(" · ");
}

/** Display title for one retrieved item, by best identifying field. `title` (the human
 *  document name, provenance/v1) wins when present; otherwise `file_name` — which, for a
 *  LightRAG document, is the gdrive retrieval key shown when no readable name was found. */
export function itemTitle(item: ProvenanceItemView): string {
  return (
    item.title ?? item.file_name ?? item.id ?? item.type ?? m.sources_item_untitled()
  );
}

/** The stable underlying identifier shown UNDER the title when a human `title` replaced
 *  it (the gdrive `file_name`) — kept so the user sees, and can search, the real ref. */
export function itemSubId(item: ProvenanceItemView): string | undefined {
  return item.title && item.file_name ? item.file_name : undefined;
}

/** The reference handed to the documentary agent when attaching a document — the STABLE
 *  retrieval key (`file_name`, e.g. a gdrive id) the server's attach gate allows, NEVER
 *  the display `title`. A findable document always has a file_name; the fallback only
 *  guards a malformed item. */
export function attachReference(item: ProvenanceItemView): string {
  return item.file_name ?? itemTitle(item);
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

// ---------------------------------------------------------------------------
// Side-panel model (Sources slide-over): a "source" the user can select is ONE
// retrieved ITEM, not a whole report. We flatten parts → per-group entries with
// a stable selection key, ordered best-score-first, plus a keyword filter.
// Pure + table-testable (the panel stays a thin shell).
// ---------------------------------------------------------------------------

/** One selectable source = a single retrieved item, with its report context. */
export interface SourceEntry {
  /** Stable selection key (pluginId + group + item identity + position). */
  key: string;
  group: ProvenancePartView["group"];
  pluginId: string;
  source: string;
  item: ProvenanceItemView;
}

/** Flatten the parts of ONE group into selectable entries, best score first. */
export function sourceEntries(
  parts: ProvenancePartView[],
  group: ProvenancePartView["group"],
): SourceEntry[] {
  const entries: SourceEntry[] = [];
  parts.forEach((part, partIdx) => {
    if (part.group !== group) return;
    part.items.forEach((item, i) => {
      entries.push({
        key: `${part.pluginId}|${part.group}|${item.id ?? item.file_name ?? "?"}|${partIdx}.${i}`,
        group: part.group,
        pluginId: part.pluginId,
        source: part.source,
        item,
      });
    });
  });
  return entries.sort((a, b) => (b.item.score ?? 0) - (a.item.score ?? 0));
}

/** Case-insensitive keyword match over an entry's title + excerpt + meta chips. */
export function sourceMatchesQuery(entry: SourceEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const hay = [
    entryTitle(entry),
    // The underlying file_name (e.g. the gdrive retrieval key) — kept searchable even
    // when a human `title` replaced it as the visible heading.
    entry.item.file_name ?? "",
    entry.item.text ?? "",
    ...itemMeta(entry.item),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

/** A FINDABLE document: a documents-group item WITH a real file referent
 *  (file_name) the documentary agent can open/attach — it drives the asymmetric
 *  "Source d'origine" slot + the selectable checkbox. A documents-group item with
 *  NO file_name is a synthesized CONTEXT excerpt (e.g. LightRAG's whole-graph
 *  blob), which has no external source to open — so it must NOT offer the slot
 *  (the attach would send a non-file reference like "lightrag-context" the agent
 *  can never resolve). Memory items also have no file referent. */
export function isFindableDocument(entry: SourceEntry): boolean {
  return provenanceItemKind(entry.item, entry.group) === "document";
}

/** A synthesized context excerpt (a documents-group item declaring `context:true`,
 *  or — backward-compat — one with no file_name). Shown for transparency, but never
 *  attachable. */
export function isContextExcerpt(entry: SourceEntry): boolean {
  return provenanceItemKind(entry.item, entry.group) === "context";
}

/** Card title. A context excerpt gets a friendly label — its raw id is an
 *  internal sentinel (e.g. "lightrag-context") that reads as a fake document
 *  name; everything else uses the best identifying field (itemTitle). */
export function entryTitle(entry: SourceEntry): string {
  return isContextExcerpt(entry)
    ? m.sources_context_title()
    : itemTitle(entry.item);
}
