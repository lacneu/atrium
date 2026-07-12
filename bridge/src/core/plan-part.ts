// Work-plan extraction from a coalesced tool.status event (pure module).
//
// GPT-5-family runs on OpenClaw expose the builtin `update_plan` tool: the
// model maintains an ordered step list ({step, status}) it re-sends on every
// progress change. Each successful call becomes a compact kind:"plan" part;
// the UI renders the LAST part as the plan's current state and streams the
// progression live as parts arrive. Shapes pinned LIVE against the
// 2026.7.1-beta.2 bench (capture 2026-07-12):
//   input  = { explanation?, plan: [{step, status}] }
//   output = { content: [], details: { status:"updated", explanation?, plan } }

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanPart {
  kind: "plan";
  steps: { step: string; status: PlanStepStatus }[];
  /** The model's short "what changed" note for THIS update. */
  explanation?: string;
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
export function planPartFromTool(
  name: string | null,
  phase: string | null,
  input: unknown,
  output: unknown,
): PlanPart | null {
  if (name !== "update_plan" || phase !== "completed") return null;
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
