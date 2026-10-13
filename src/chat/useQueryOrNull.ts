// A query whose FAILURE must not break the chat render (codex phase 6 pass 5): `useQuery`
// throws a failed query into the component tree, and the composer's follow-up state is an
// enhancement — without it the composer simply has no queue information. `useQueries`
// returns the error instead; it is reported once to the console and read as "no data".

import { useQueries } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

/** A query result that may be an error: the error reads as `null` (no data). */
export function valueOrNull<T>(v: T | Error | undefined): T | null | undefined {
  if (v instanceof Error) return null;
  return v;
}

export function useQueryOrNull<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q> | "skip",
): FunctionReturnType<Q> | null | undefined {
  const results = useQueries(args === "skip" ? {} : { q: { query, args } });
  const v = (results as Record<string, unknown>).q as FunctionReturnType<Q> | Error | undefined;
  if (v instanceof Error) console.warn("[follow-up] state unavailable:", v.message);
  return valueOrNull(v);
}
