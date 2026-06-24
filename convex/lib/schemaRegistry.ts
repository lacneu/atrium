// Published contract schemas Atrium serves at GET /api/v1/schemas (and the MCP /
// CLI surface). These are the machine-readable contracts a plugin/integration author
// validates against. Registry-driven + intentionally minimal: to publish a NEW schema
// (e.g. a future conversational-provenance or a transport/WS-message contract), add an
// entry to SCHEMAS — no route/tool change. The canonical schema files live next to
// their human contracts (docs/); this module is the single place that registers them.
import provenanceV1 from "../../docs/provenance/provenance.v1.schema.json";

export interface RegisteredSchema {
  /** Stable registry id (the /api/v1/schemas/:id path segment), e.g. "provenance.v1". */
  id: string;
  title: string;
  /** Contract version (the `v` an emitter sends), e.g. "1". */
  version: string;
  /** Coarse family so the list stays navigable as schemas accrue. */
  category: string;
  description: string;
  /** The JSON Schema document itself. */
  schema: unknown;
}

export const SCHEMAS: RegisteredSchema[] = [
  {
    id: "provenance.v1",
    title: "Provenance report (provenance/v1)",
    version: "1",
    category: "provenance",
    description:
      "What a context-injecting OpenClaw plugin emits on the `<pluginId>.provenance` " +
      "agent-event stream so Atrium can show 'which sources fed this reply'. See " +
      "docs/provenance/PROVENANCE_CONTRACT.md.",
    schema: provenanceV1,
  },
];

/** Registry listing — metadata only (no schema bodies), for GET /api/v1/schemas. */
export function listSchemas(): Omit<RegisteredSchema, "schema">[] {
  return SCHEMAS.map(({ schema: _schema, ...meta }) => meta);
}

/** One registered schema by id, or undefined — for GET /api/v1/schemas/:id. */
export function getSchema(id: string): RegisteredSchema | undefined {
  return SCHEMAS.find((s) => s.id === id);
}
