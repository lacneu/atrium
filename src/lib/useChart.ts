import { useEffect, useState } from "react";
import { COLOR_TOKENS, type ChartTokens } from "../../convex/lib/charts";

// Runtime application of a "charte graphique" (P3). A chart is a named palette
// that overrides the BASE CSS custom properties declared in src/index.css
// (`--background`, `--radius`, `--ui-font-sans`, ...) via
// documentElement.style.setProperty. It NEVER touches the `@theme inline`
// mappings (`--color-*`, `--radius-md`) — those resolve THROUGH the base vars,
// so overriding a base var propagates to every Tailwind utility automatically.
//
// The registry is imported DIRECTLY from the pure module convex/lib/charts.ts
// (it imports nothing from the Convex runtime), so backend and frontend share a
// SINGLE source of truth for key -> tokens and can never drift. This mirrors how
// src/chat/convexApi.ts reaches ../../convex/_generated/api.
//
// Apply is via setProperty ONLY — we never build a <style> string (the same
// path P4 will harden for user-supplied charts). Colors are mode-scoped (two
// sets, light + dark); radius + fonts are mode-independent.

/**
 * Resolve a theme MODE (which may be "system") down to a concrete "light" |
 * "dark", staying live when the OS preference flips. State-backed so a change
 * triggers a re-render (and therefore a chart re-application) — a plain derived
 * value would not. `mode` is undefined until getMe resolves; we then fall back
 * to the same `oc.theme` localStorage cache useApplyTheme reads, so the chart
 * and the `.dark` class agree from first paint.
 *
 * This is a SECOND matchMedia listener alongside useApplyTheme's (they compute
 * the identical result), which keeps useApplyChart a pure applicator and avoids
 * touching useTheme.ts.
 */
export function useResolvedMode(
  mode: "light" | "dark" | "system" | undefined,
): "light" | "dark" {
  const effective =
    mode ??
    ((localStorage.getItem("oc.theme") as
      | "light"
      | "dark"
      | "system"
      | null) ??
      "system");

  const resolve = (): "light" | "dark" => {
    if (effective === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return effective;
  };

  const [resolved, setResolved] = useState<"light" | "dark">(resolve);

  useEffect(() => {
    setResolved(resolve());
    if (effective !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective]);

  return resolved;
}

// Apply one chart's tokens for a concrete mode. Always iterates the FULL
// COLOR_TOKENS list and removeProperty()s any the chart does not define, so
// switching charts (or applying a partial chart) never leaks a stale var from a
// previously applied chart. radius + fonts likewise clear when unset.
function applyChartTokens(
  tokens: ChartTokens | null,
  mode: "light" | "dark",
) {
  const style = document.documentElement.style;
  // `?.colors?.` (not just `tokens?.colors`): a malformed/legacy token object
  // (e.g. `{}` from a stale brand cache) is non-null but has no `colors`, so a
  // bare `tokens?.colors[mode]` would deref undefined and crash the (login) paint.
  const colors = tokens?.colors?.[mode];
  for (const token of COLOR_TOKENS) {
    const value = colors?.[token];
    if (value !== undefined) {
      style.setProperty("--" + token, value);
    } else {
      style.removeProperty("--" + token);
    }
  }
  // Shape + typography are mode-independent.
  if (tokens?.radius !== undefined) {
    style.setProperty("--radius", tokens.radius);
  } else {
    style.removeProperty("--radius");
  }
  if (tokens?.fontSans !== undefined) {
    style.setProperty("--ui-font-sans", tokens.fontSans);
  } else {
    style.removeProperty("--ui-font-sans");
  }
  if (tokens?.fontMono !== undefined) {
    style.setProperty("--ui-font-mono", tokens.fontMono);
  } else {
    style.removeProperty("--ui-font-mono");
  }
}

/**
 * Apply the EFFECTIVE chart's TOKENS (resolved SERVER-SIDE in getMe —
 * `me.resolvedChartTokens`, builtin from the code registry OR custom from the DB,
 * fed from RoleGate) for the current `effectiveMode`. Reapplies whenever the
 * tokens object or the mode changes. P4 moved key->tokens resolution to the
 * server, so this hook is now a PURE applicator (no builtin lookup, no
 * builtin/custom branching in the browser). A null/undefined tokens clears every
 * override → the native index.css look. `tokens` is undefined until getMe
 * resolves; we treat that as "no override yet" (native look) rather than
 * guessing, since charts — unlike the `.dark` class — have no anti-flash cache.
 *
 * Note: getMe pushes a fresh tokens object on every change, so editing a custom
 * chart re-pushes new tokens here and the live UI re-applies. Identical re-applies
 * are idempotent (setProperty/removeProperty), so no memoization is needed.
 */
export function useApplyChart(
  tokens: ChartTokens | null | undefined,
  effectiveMode: "light" | "dark",
) {
  useEffect(() => {
    applyChartTokens(tokens ?? null, effectiveMode);
  }, [tokens, effectiveMode]);
}
