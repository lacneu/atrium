// Work-plan extraction from a coalesced tool.status event (pure module).
//
// GPT-5-family runs on OpenClaw expose the builtin `update_plan` tool: the
// model maintains an ordered step list ({step, status}) it re-sends on every
// progress change. Each successful call becomes a compact kind:"plan" part;
// the UI renders the CURRENT one — the part of greatest `stamp`, not the last
// row written (convex/lib/planOrder.ts) — and streams the progression live as
// parts arrive. Shapes pinned LIVE against the
// 2026.7.1-beta.2 bench (capture 2026-07-12):
//   input  = { explanation?, plan: [{step, status}] }
//   output = { content: [], details: { status:"updated", explanation?, plan } }

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanPart {
  kind: "plan";
  steps: { step: string; status: PlanStepStatus }[];
  /** The model's short "what changed" note for THIS update. */
  explanation?: string;
  /** Set by the sink when it RECEIVES the frame (core/turn-sink.ts), never by
   *  the readers below: it orders plan writes by cause instead of by arrival
   *  (src/chat/planView.ts). */
  stamp?: number;
}

const STEP_CAP = 300;
const EXPLANATION_CAP = 500;
const MAX_STEPS = 50;

const STEP_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readPlan(v: unknown): PlanPart["steps"] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const steps: PlanPart["steps"] = [];
  for (const item of v) {
    if (!isRecord(item) || typeof item.step !== "string" || item.step === "") {
      continue; // skip malformed entries, keep the readable ones
    }
    const status =
      typeof item.status === "string" && STEP_STATUSES.has(item.status)
        ? (item.status as PlanStepStatus)
        : "pending"; // unknown status reads as not-done (never a false check)
    steps.push({ step: item.step.slice(0, STEP_CAP), status });
    if (steps.length >= MAX_STEPS) break;
  }
  return steps.length > 0 ? steps : null;
}

/**
 * Extract a PlanPart from a coalesced tool.status event, or null when the
 * call is not a successful update_plan. The RESULT's details are
 * authoritative (the gateway validated them); the input args are the
 * fallback when a drifted result omits the plan.
 */
/**
 * Work plan from the NATIVE `stream:"plan"` agent event (G-22).
 *
 * The gateway emits `{phase:"update", explanation?, steps}` in TWO shapes,
 * both verified in the deployed 2026.7.1 build:
 *   - `handleTurnPlanUpdated` → `steps: [{step, status}]` — the SAME shape the
 *     `update_plan` tool result carries, so it goes through the SAME reader;
 *   - `splitPlanText` → `steps: ["a line", …]` — plain lines, no status. The
 *     honest default is `pending`: the gateway stated none, and inventing
 *     `in_progress` would show progress that was never reported.
 *
 * Deliberately built from the same primitives as `planPartFromTool` (`readPlan`,
 * the caps): the two paths render the SAME part, and a divergence between them
 * would be invisible to the reader while being wrong for one of the providers.
 */
export function planPartFromPlanStream(data: unknown): PlanPart | null {
  if (!isRecord(data)) return null;
  const raw = data.steps;
  if (!Array.isArray(raw)) return null;
  // ZERO steps is a statement, not silence: gateway 2026.8.1+ emits the plan
  // stream for every `progress_card` put with `steps: normalize(input).steps ?? []`
  // (embedded-agent-subscribe.handlers.tools.results.ts), so a markdown-only or
  // clearing call — which REPLACES the card and drops its checklist — arrives as
  // an empty update, on delivery runs too where no tool frame exists. It is
  // materialized as an empty plan so the stale checklist is hidden (codex P2).
  if (raw.length === 0) return { kind: "plan", steps: [] };
  // Normalize the string shape into the structured one, then use the SHARED
  // reader for everything else (caps, status allowlist, malformed entries).
  const normalized = raw.map((entry) =>
    typeof entry === "string" ? { step: entry, status: "pending" } : entry,
  );
  const steps = readPlan(normalized);
  if (steps === null) return null;
  const explanationRaw = data.explanation;
  const explanation =
    typeof explanationRaw === "string" && explanationRaw !== ""
      ? explanationRaw.slice(0, EXPLANATION_CAP)
      : undefined;
  return {
    kind: "plan",
    steps,
    ...(explanation !== undefined ? { explanation } : {}),
  };
}

/** The tool names that carry a work plan, ACROSS gateway versions.
 *
 *  `update_plan` (<= 2026.7.x) became `progress_card` at 2026.8.1 (upstream
 *  `ProgressCardStepSchema`: the same `plan: [{step, status}]` argument and the
 *  same three statuses `pending` | `in_progress` | `completed`). The two are
 *  read from DIFFERENT places, though: `update_plan` from the tool call
 *  (planPartFromTool), `progress_card` from the native `plan` stream the gateway
 *  emits for every successful call (planPartFromPlanStream) — its RESULT
 *  carries only a {completed, total} count. This predicate only names the
 *  family (turn-sink's tool-activity exemption); it does not decide where a
 *  plan is read from. */
export function isPlanTool(name: string | null): boolean {
  return name === "update_plan" || name === "progress_card";
}

export function planPartFromTool(
  name: string | null,
  phase: string | null,
  input: unknown,
  output: unknown,
): PlanPart | null {
  if (!isPlanTool(name) || phase !== "completed") return null;
  // `progress_card` (2026.8.1+) is served by the NATIVE plan stream: the gateway
  // emits it, normalized (invisible/bidi characters stripped), for every
  // successful call — with `steps: []` for a markdown-only or clearing put
  // (readProgressCardPlanInput: `steps ?? []`) — BEFORE the tool result, which
  // carries only counts. Reading the raw `input.plan` here again appended a
  // second, unnormalized plan that became the UI's truth (codex P2). The tool
  // path reads `update_plan` only (<= 2026.7.x, no plan stream on its runs).
  if (name === "progress_card") return null;
  const details =
    isRecord(output) && isRecord(output.details) ? output.details : null;
  const inputObj = isRecord(input) ? input : null;
  const steps = readPlan(details?.plan) ?? readPlan(inputObj?.plan);
  if (steps === null) return null;
  const explanationRaw = details?.explanation ?? inputObj?.explanation;
  const explanation =
    typeof explanationRaw === "string" && explanationRaw !== ""
      ? explanationRaw.slice(0, EXPLANATION_CAP)
      : undefined;
  return {
    kind: "plan",
    steps,
    ...(explanation !== undefined ? { explanation } : {}),
  };
}
