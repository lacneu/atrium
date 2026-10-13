import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { convexToJson } from "convex/values";

// A query whose FAILURE must not break the chat render (codex phase 6 pass 5): `useQuery`
// throws a server error into the render tree; `useQueries` hands it back as a value.
// The pure step is exported for its test.
export function valueOrNull<T>(v: T | Error | undefined): T | null | undefined {
  if (v instanceof Error) return null;
  return v;
}

export function useQueryOrNull<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q> | "skip",
): FunctionReturnType<Q> | null | undefined {
  const skip = args === "skip";
  const name = getFunctionName(query);
  const argsKey = skip ? "" : JSON.stringify(convexToJson(args));
  // `useQueries` subscribes ANEW whenever this object's identity changes, and that
  // resubscription sets state during render: an object rebuilt on every render loops until
  // React gives up ("Too many re-renders") — every chat page fell into the route error
  // boundary in 0.98.0. Keyed like convex's own `useQuery`: function name + serialized args.
  const queries = useMemo(
    (): RequestForQueries => (args === "skip" ? {} : { q: { query, args } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on name + serialized args
    [name, argsKey, skip],
  );
  const results = useQueries(queries);
  const v = (results as Record<string, unknown>).q as FunctionReturnType<Q> | Error | undefined;
  if (v instanceof Error) console.warn("[follow-up] state unavailable:", v.message);
  return valueOrNull(v);
}
