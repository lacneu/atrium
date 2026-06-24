// Provenance item classification — the ONE source of truth shared by the Sources
// UI (src/chat/sourcesView.ts) and the documentary-attach trust boundary
// (convex/documentAttachments.ts), so the "findable document vs synthesized
// context" rule can never drift between what the UI shows and what the server
// allows. Pure (no Convex/DOM imports) so both runtimes import it directly, like
// convex/lib/chatRenderState. Normative contract: docs/provenance/PROVENANCE_CONTRACT.md.

/** The provenance item fields, structurally matching BOTH the stored `messagePart`
 *  provenance item (convex/schema.ts) and the client `ProvenanceItemView`
 *  (src/chat/convexTypes.ts), so either shape — or a plain literal — satisfies it.
 *  The classifier only reads `file_name` + `context`; the rest are listed so a caller
 *  can pass a full item without an excess-property error. */
export interface ProvenanceItemLike {
  id?: string;
  type?: string;
  date?: string;
  score?: number;
  text?: string;
  file_name?: string;
  collection?: string;
  /** Explicit discriminator (provenance/v1, ADDITIVE): a documents-group item MAY set
   *  `context: true` to declare it is a SYNTHESIZED context excerpt with no openable
   *  source file (e.g. LightRAG's whole-graph blob), as opposed to a findable document. */
  context?: boolean;
}

export type ProvenanceGroup = "memory" | "documents";

/** A provenance item is one of three kinds for the Sources affordance:
 *  - `memory`   — conversational recall (no external referent);
 *  - `document` — a FINDABLE source file (openable + attachable);
 *  - `context`  — a synthesized context excerpt (shown, never attachable). */
export type ProvenanceItemKind = "memory" | "document" | "context";

/**
 * Classify one provenance item by its report `group` + the explicit `context` flag,
 * with a backward-compat inference for plugins that predate the flag:
 *  - memory group              -> "memory"
 *  - documents + `context:true` -> "context"  (explicit intent)
 *  - documents + no `file_name` -> "context"  (INFERRED: a documents item with no
 *       openable file is a synthesized excerpt — keeps pre-`context` emitters, e.g. an
 *       old LightRAG `lightrag-context` blob, classified correctly)
 *  - documents + `file_name`    -> "document" (findable / attachable)
 */
export function provenanceItemKind(
  item: ProvenanceItemLike,
  group: ProvenanceGroup,
): ProvenanceItemKind {
  if (group === "memory") return "memory";
  if (item.context === true || !item.file_name) return "context";
  return "document";
}

/** A findable document has an openable source file the documentary agent can fetch —
 *  the ONLY attachable kind. Used by BOTH the UI (offer the "Source d'origine" slot)
 *  and the server attach gate (build the allowed-reference set), so they never drift. */
export function isFindableDocumentItem(
  item: ProvenanceItemLike,
  group: ProvenanceGroup,
): boolean {
  return provenanceItemKind(item, group) === "document";
}
