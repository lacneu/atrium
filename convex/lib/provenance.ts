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

// ===========================================================================
// SOC2-safe provenance STRUCTURE — the diagnostic shape behind GET
// /api/v1/chat-state (surfaced by the MCP). The reactive client path and the
// owner-scoped getProvenanceParts carry VALUES (file_name, text, score); the
// key-authed observability surface must not. This derivation emits only
// Atrium-DERIVED kinds, a bounded-enum group, ALLOWLISTED source/route, counts,
// and presence BOOLEANS — never a value, never raw emitter free-text. It exists
// so an operator can diagnose e.g. "the document items carry no score and no
// excerpt" (a bare LightRAG attribution turn) without seeing any content.
// ===========================================================================

/** The provenance PART fields the structure derivation reads — a structural subset of
 *  the stored/compacted provenance messagePart (convex/messages.ts ClientPart). */
export interface ProvenancePartLike {
  source?: string;
  group: ProvenanceGroup;
  hasExcerpts?: boolean;
  injected?: { truncated?: boolean };
  retrieval?: { route?: string };
  items: ProvenanceItemLike[];
}

/** Reporting-source families Atrium recognizes; an unknown emitter `source` folds to
 *  "other" so the structure never reflects arbitrary emitter free-text. */
const KNOWN_PROVENANCE_SOURCES = new Set(["knowledge", "hindsight"]);
/** Retrieval routes Atrium recognizes. The route discriminates whether a bare document
 *  is EXPECTED: pgvector items carry a per-chunk score + excerpt, LightRAG attribution
 *  references are file_name-only by design — so "documents with no score" is normal for
 *  `lightrag` but a regression for `pgvector`. */
const KNOWN_RETRIEVAL_ROUTES = new Set(["lightrag", "pgvector"]);

/** Pass a value through only if it is in the known set, else fold to "other" — never
 *  reflect raw emitter free-text on the SOC2 surface. Absent stays absent. */
function allowlistedLabel(
  value: string | undefined,
  known: Set<string>,
): string | undefined {
  if (value === undefined) return undefined;
  return known.has(value) ? value : "other";
}

export interface ProvenanceItemStructure {
  kind: ProvenanceItemKind;
  hasFileName: boolean;
  hasScore: boolean;
}

export interface ProvenancePartStructure {
  group: ProvenanceGroup;
  source?: string;
  retrievalRoute?: string;
  itemCount: number;
  /** At least one item carried an injected excerpt (part-level — never which/how much). */
  hasExcerpts: boolean;
  truncated?: boolean;
  items: ProvenanceItemStructure[];
}

/** SOC2-safe STRUCTURE of one provenance part (see the block comment above). */
export function provenancePartStructure(
  part: ProvenancePartLike,
): ProvenancePartStructure {
  const out: ProvenancePartStructure = {
    group: part.group,
    itemCount: part.items.length,
    // Robust to both the COMPACTED part (text stripped, `hasExcerpts` flag set) and a
    // raw part still carrying item text (the test fixtures) — either proves an excerpt.
    hasExcerpts:
      part.hasExcerpts === true ||
      part.items.some((i) => typeof i.text === "string" && i.text.length > 0),
    items: part.items.map((item) => ({
      kind: provenanceItemKind(item, part.group),
      hasFileName: Boolean(item.file_name),
      hasScore: typeof item.score === "number",
    })),
  };
  const source = allowlistedLabel(part.source, KNOWN_PROVENANCE_SOURCES);
  if (source !== undefined) out.source = source;
  const route = allowlistedLabel(part.retrieval?.route, KNOWN_RETRIEVAL_ROUTES);
  if (route !== undefined) out.retrievalRoute = route;
  if (part.injected?.truncated === true) out.truncated = true;
  return out;
}
