// Provenance contract (provenance/v1) — the bridge half.
//
// Gateway plugins that inject context into the LLM (conversational memory,
// document RAG) can REPORT what they injected by emitting a plugin agent
// event on a stream ending in `.provenance` (plugin events are gateway-scoped
// to `<pluginId>` / `<pluginId>.<suffix>`, and the gateway stamps `pluginId`
// into the data — the emitter identity is authenticated, not declarative).
// The bridge turns each valid report into a `kind:"provenance"` message part
// on the assistant message of the SAME run, so the chat UI can show "which
// sources fed this reply" under the chat's own ACL.
//
// Full normative contract: atrium docs/PROVENANCE_CONTRACT.md.
// This module is PURE (no I/O) — every bound and rejection is unit-tested.

/** Stream suffix plugins must use: `<pluginId>.provenance`. */
export const PROVENANCE_STREAM_SUFFIX = ".provenance";

/** Hard bounds — a report is a UI affordance, never a payload channel. */
export const MAX_PROVENANCE_ITEMS = 24;
export const MAX_ITEM_TEXT_CHARS = 2_000;
export const MAX_STRING_CHARS = 300;
export const MAX_PART_JSON_CHARS = 32_000;
/** Per-turn cap across ALL emitting plugins (enforced by the sink). */
export const MAX_PROVENANCE_PARTS_PER_TURN = 8;

/** One retrieved item. Memory items use id/type/date; document items use
 *  file_name/collection; both may carry score and (level "full") text. A
 *  documents-group item may set `context:true` (provenance/v1, additive) to declare
 *  it a SYNTHESIZED context excerpt (no openable source file) — see
 *  docs/provenance/PROVENANCE_CONTRACT.md + convex/lib/provenance.ts. */
export interface ProvenanceItem {
  id?: string;
  type?: string;
  date?: string;
  score?: number;
  text?: string;
  file_name?: string;
  /** Human DISPLAY name for a document item (provenance/v1, additive). The UI shows it
   *  instead of file_name; file_name stays the stable retrieval/attach key. */
  title?: string;
  collection?: string;
  context?: boolean;
}

/** Mirrors convex/schema.ts messagePart `provenance` variant. */
export interface ProvenancePart {
  kind: "provenance";
  v: number;
  /** Gateway-stamped emitter id (authenticated — never client-declared). */
  pluginId: string;
  /** Reporting source family, e.g. "hindsight" | "knowledge". */
  source: string;
  /** UI grouping: conversational memory vs documentary knowledge. */
  group: "memory" | "documents";
  injected?: { chars?: number; position?: string; truncated?: boolean };
  retrieval?: {
    route?: string;
    bank?: string;
    collections?: string[];
    lightragMode?: string;
  };
  items: ProvenanceItem[];
}

export function isProvenanceStream(stream: unknown): stream is string {
  return (
    typeof stream === "string" &&
    stream.length > PROVENANCE_STREAM_SUFFIX.length &&
    stream.endsWith(PROVENANCE_STREAM_SUFFIX)
  );
}

const str = (v: unknown, max = MAX_STRING_CHARS): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function parseItem(raw: unknown): ProvenanceItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const item: ProvenanceItem = {};
  const id = str(o.id);
  const type = str(o.type);
  const date = str(o.date);
  const score = num(o.score);
  const text = str(o.text, MAX_ITEM_TEXT_CHARS);
  const fileName = str(o.file_name);
  const title = str(o.title);
  const collection = str(o.collection);
  if (id !== undefined) item.id = id;
  if (type !== undefined) item.type = type;
  if (date !== undefined) item.date = date;
  if (score !== undefined) item.score = score;
  if (text !== undefined) item.text = text;
  if (fileName !== undefined) item.file_name = fileName;
  if (title !== undefined) item.title = title;
  if (collection !== undefined) item.collection = collection;
  // Additive discriminator: ONLY a literal `true` is accepted (a context excerpt);
  // any other value is dropped, like every other off-shape field on this boundary.
  if (o.context === true) item.context = true;
  // An item must carry at least ONE IDENTIFYING field — an empty object is noise,
  // never a source the user could act on. `title` is display-only metadata for a
  // document (it has no stable ref of its own), so a title-ONLY item is dropped.
  const { title: _title, ...identifying } = item;
  return Object.keys(identifying).length > 0 ? item : null;
}

/**
 * Validate + bound a provenance report from the network into the storable
 * part shape. Returns null for anything off-contract — a malformed report
 * must never break a turn NOR smuggle unbounded data into Convex.
 *
 * The shape is rebuilt field-by-field (no spread of network data): unknown
 * fields are DROPPED, every string is truncated, items are capped, and the
 * final JSON size is enforced as a last-resort belt.
 */
export function parseProvenanceReport(data: unknown): ProvenancePart | null {
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;
  if (o.v !== 1) return null; // unknown contract version: ignore (fwd-compat)
  const pluginId = str(o.pluginId);
  const source = str(o.source);
  const group = o.kind === "memory" || o.kind === "documents" ? o.kind : null;
  if (!pluginId || !source || group === null) return null;
  if (!Array.isArray(o.items)) return null;

  const items = o.items
    .slice(0, MAX_PROVENANCE_ITEMS)
    .map(parseItem)
    .filter((i): i is ProvenanceItem => i !== null);
  if (items.length === 0) return null; // nothing citable: skip the part

  const part: ProvenancePart = { kind: "provenance", v: 1, pluginId, source, group, items };

  if (typeof o.injected === "object" && o.injected !== null) {
    const inj = o.injected as Record<string, unknown>;
    const injected: ProvenancePart["injected"] = {};
    const chars = num(inj.chars);
    const position = str(inj.position);
    if (chars !== undefined) injected.chars = chars;
    if (position !== undefined) injected.position = position;
    if (typeof inj.truncated === "boolean") injected.truncated = inj.truncated;
    if (Object.keys(injected).length > 0) part.injected = injected;
  }

  if (typeof o.retrieval === "object" && o.retrieval !== null) {
    const ret = o.retrieval as Record<string, unknown>;
    const retrieval: NonNullable<ProvenancePart["retrieval"]> = {};
    const route = str(ret.route);
    const bank = str(ret.bank);
    if (route !== undefined) retrieval.route = route;
    if (bank !== undefined) retrieval.bank = bank;
    if (Array.isArray(ret.collections)) {
      const collections = ret.collections
        .slice(0, 8)
        .map((c) => str(c))
        .filter((c): c is string => c !== undefined);
      if (collections.length > 0) retrieval.collections = collections;
    }
    const lightrag = ret.lightrag;
    if (typeof lightrag === "object" && lightrag !== null) {
      const mode = str((lightrag as Record<string, unknown>).mode);
      if (mode !== undefined) retrieval.lightragMode = mode;
    }
    if (Object.keys(retrieval).length > 0) part.retrieval = retrieval;
  }

  // Last-resort size belt: a report passing the per-field bounds could still
  // be bloated (24 items x 2k chars); refuse anything beyond the doc budget.
  if (JSON.stringify(part).length > MAX_PART_JSON_CHARS) return null;
  return part;
}

/**
 * Extract a provenance part from a RAW gateway frame, for the PRE-TURN window
 * (the report fires at prompt-build, racing the chat.send ack -> beginTurn).
 * Admits only agent events of THIS session (sessionKey must match) carrying a
 * runId — the caller stashes by runId and flushes the entries matching the
 * ack. Returns null for any other frame.
 */
/**
 * Stable CONTENT signature of a provenance part (pluginId + source + group +
 * items). Lets the pre-turn stash drop an EXACT-duplicate report a plugin may
 * emit more than once in a single turn (e.g. a hook registered twice on a
 * reload), WITHOUT collapsing two genuinely-distinct reports that share a group
 * — openclaw-knowledge's pgvector and LightRAG reports are both group
 * "documents" but carry different `items`, so their signatures differ.
 */
export function provenanceSignature(part: ProvenancePart): string {
  return JSON.stringify([part.pluginId, part.source, part.group, part.items]);
}

export function parseProvenanceFrame(
  frame: unknown,
  sessionKey: string,
): { runId: string; part: ProvenancePart } | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f.type !== "event" || f.event !== "agent") return null;
  const payload = f.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (!isProvenanceStream(p.stream)) return null;
  if (p.sessionKey !== sessionKey) return null;
  if (typeof p.runId !== "string" || p.runId.length === 0) return null;
  const part = parseProvenanceReport(p.data);
  if (part === null) return null;
  return { runId: p.runId, part };
}
