# Provenance contract (provenance/v1)

How an OpenClaw gateway **plugin** tells the Atrium chat UI *which sources fed a reply*,
so the user can see them in the per-message **Sources** panel (and, for documents, fetch
the original file). **Atrium owns this contract** — it defines the Sources UI features;
a plugin conforms to it while bridging however OpenClaw injected the RAG context.

Canonical machine schema: [`provenance.v1.schema.json`](./provenance.v1.schema.json)
(`$id: https://atrium.lacneu.com/schema/provenance.v1.schema.json`). Validate your
emitted reports against it in your plugin's tests. A deployment also **serves** the
registered schemas at `GET /api/v1/schemas` (list) and `GET /api/v1/schemas/provenance.v1`
(this one) — **public** (no auth, cacheable), like public API docs; the same is surfaced
by the MCP tools `list_schemas` / `get_schema` and the CLI `atrium schemas` /
`atrium schema --id provenance.v1`.

## Transport

Emit a **plugin agent event** (gateway SDK `emitAgentEvent`) per turn:

- `stream` MUST be `"<pluginId>.provenance"` (gateway-scoped to your plugin).
- `runId` is REQUIRED (carried by the `before_prompt_build` context).
- The gateway **stamps the authenticated `pluginId`** into the report — you never
  declare it yourself (so a report's emitter identity is trustworthy).
- A violation returns `{ emitted: false, reason }` and never throws. Emission must
  never break or delay a turn.

The bridge (`bridge/src/core/provenance.ts`) turns each valid report into a
`kind:"provenance"` message part on the assistant message of the SAME run, under the
chat's own ACL. It is a **fail-closed trust boundary**: it rebuilds the report
field-by-field, drops unknown fields, truncates every string, and caps the items — so
conforming to the schema is necessary, but the bridge bounds still apply.

## Report shape

```jsonc
{
  "v": 1,
  "source": "knowledge",        // your source family ("knowledge" | "hindsight" | …)
  "kind": "documents",          // "memory" | "documents" → the Sources section
  "injected": { "chars": 3818, "position": "system_append", "truncated": true },
  "retrieval": { "route": "lightrag", "lightrag": { "mode": "hybrid" } },
  "items": [ /* ≤ 24 items */ ]
}
```

## Item kinds (the part Atrium renders)

An item's **kind** is *derived*, not a free field. The single rule lives in
[`convex/lib/provenance.ts`](../../convex/lib/provenance.ts) (`provenanceItemKind`) and
is used by BOTH the UI and the server attach gate so they never disagree:

| Report `kind` | Item has `file_name`? | `context: true`? | → kind | In the UI |
|---|---|---|---|---|
| `memory` | — | — | **memory** | "Conversational memory" — recall, not attachable |
| `documents` | yes | no | **document** | "Documents" — findable; offers **Source d'origine** (fetch the file) + is counted |
| `documents` | yes | **yes** | **context** | "Context" — shown, never attachable |
| `documents` | no | — | **context** | "Context" — shown, never attachable (backward-compat inference) |

- A **document** item MUST carry a real `file_name` (the file the documentary agent
  fetches). It is the ONLY attachable kind.
- A **context** item is a *synthesized* excerpt with no openable source — e.g.
  LightRAG's whole-graph context blob. Declare it explicitly with **`context: true`**.
  Legacy emitters that omit the flag still classify correctly *iff* the item has no
  `file_name` (the inference) — but new plugins SHOULD set the flag.

### Item fields

`id`, `file_name`, `context`, `type` (free-form / retrieval mode — NOT a discriminator),
`collection`, `date`, `score`, `text`. `text` is the source excerpt, only at the
operator's `full` level. What it holds depends on the retriever: for a **verbatim-
injected** source (pgvector) it is the injected chunk; for a **synthesizing** retriever
(LightRAG — see below) a document item's `text` is the **retrieved source content per
document** (the material the graph synthesized from), shown so the user sees what the RAG
pulled for each source. Never fabricate it. See the schema for bounds (24 items,
2000-char text, 300-char strings).

## Levels (operator opt-in)

`off` (default — no emission) · `metadata` (items without `text`) · `full` (+ excerpts).

## Note for retrieval that SYNTHESIZES (LightRAG and similar)

When the retriever returns a synthesized context (knowledge graph) PLUS a list of source
documents it attributed that context to, emit **both**: one `context: true` item for the
injected blob, and one **document** item per source `file_name`. Surface the source
documents from the retriever's attribution **even if the injected context was truncated**
— the attribution is "sources that fed the graph", not "sources whose text survived
injection". (This is the fix for the prod bug where a 92%-truncated context dropped every
real source and left only the opaque blob.)

Each source document item SHOULD also carry, at `full`, the **retrieved content** the
retriever pulled for that document (in its `text`) and a `score` when the retriever
provides one — so the user sees the actual source material per document, not just an
opaque id. This per-document content is deliberately distinct from, and complementary
to, the `context: true` blob: the blob is the verbatim (often truncated) injection the
LLM saw; the per-document `text` is the richer retrieved source — and because it is a
separate field, it is **not** subject to the context-blob truncation, so the user sees
each document's relevant content even when the injected blob was heavily truncated.
