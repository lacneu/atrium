// Bounding a message part's NESTING, so a deep tool payload is stored instead of refused.
//
// Convex refuses a document nested more than 16 levels ("Document is too nested"). A tool
// part's `input`/`output` is `v.any()` — whatever the gateway returned — and OpenClaw
// 2026.9.6's code-mode tool search returns a tool's full JSON Schema inside its result:
// 19 levels on the bench (2026-09-25). The insert threw, `addPart` answered 500, and the
// tool card was lost while the turn went on.
//
// A subtree past the bound is kept as its JSON TEXT: nothing is dropped, the card renders,
// and the document stays within the limit. The bound leaves room for the row itself
// (row -> part -> input/output are three levels above the value).

/** Levels a part's `input`/`output` value may use before a subtree becomes JSON text. */
export const PART_VALUE_MAX_DEPTH = 10;

function bounded(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= PART_VALUE_MAX_DEPTH) return JSON.stringify(value);
  if (Array.isArray(value)) return value.map((v) => bounded(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = bounded(v, depth + 1);
  return out;
}

/** The part with its tool `input`/`output` bounded in depth; any other part unchanged. */
export function boundPartDepth<P extends { kind: string }>(part: P): P {
  if (part.kind !== "tool") return part;
  const p = part as P & { input?: unknown; output?: unknown };
  return {
    ...p,
    ...(p.input !== undefined ? { input: bounded(p.input, 1) } : {}),
    ...(p.output !== undefined ? { output: bounded(p.output, 1) } : {}),
  };
}
