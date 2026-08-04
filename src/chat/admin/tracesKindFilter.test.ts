/// <reference types="vite/client" />
//
// A RARE KIND MUST BE ASKABLE, not merely queryable.
//
// The backend index (traceEvents.by_kind_at) finds a rare kind — but only for a
// caller who already knows its exact name. The Traces filter built its choices
// from the kinds SEEN in the current window, which is precisely what a rare kind
// falls out of once busier ones fill it. The operator then had no way to trigger
// the indexed query at all, and the diagnostic dead end stayed exactly where it
// was (live 2026-08-04: `openclaw.dispatch` was returned by correlationId and
// unreachable from this tab).
//
// Derived from the source: the repo has no React mount environment, and the
// defect here is a control that LOOKS complete — a populated dropdown.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const src = readFileSync(new URL("./TracesTab.tsx", import.meta.url), "utf8");
const anomalies = readFileSync(
  new URL("./AnomaliesTab.tsx", import.meta.url),
  "utf8",
);
const schemas = readFileSync(
  new URL("../../lib/routing/searchSchemas.ts", import.meta.url),
  "utf8",
);

describe("the Traces kind filter accepts a kind it has never seen", () => {
  test("it is a typable input, not a closed list", () => {
    expect(
      /list="oc-trace-kinds"/.test(src),
      "a closed Select can only ever offer what the window already contained",
    ).toBe(true);
    expect(
      /<datalist id="oc-trace-kinds">/.test(src),
      "the kinds seen stay available as suggestions",
    ).toBe(true);
  });

  test("the discovered kinds still feed the suggestions", () => {
    // The window-derived list keeps its value — it is the fast path for the
    // common kinds. What changed is that it is no longer the ONLY path.
    const datalist = src.slice(src.indexOf('<datalist id="oc-trace-kinds">'));
    expect(datalist.slice(0, 300)).toContain("kindOptions.map");
  });

  test("clearing the field means ALL, never an empty kind filter", () => {
    // An empty string sent as `kind` would ask the index for events whose kind
    // is "" — always none — and read as "nothing happened".
    expect(/setKind\(v === "" \? ALL_KINDS : v\)/.test(src)).toBe(true);
  });
});

// THE PATH AN OPERATOR ACTUALLY WALKS: an anomaly names a correlation, the
// button opens its traces. Sent as free text it was post-filtered over a bounded
// recent window, so on a busy day — the only day it is used — it opened an EMPTY
// list for a chain that exists. And guessing the kind by hand does not save it:
// the anomaly reads `openclaw.dispatch_failures` while the trace is
// `openclaw.dispatch`.
describe("the anomaly drill-down reaches its chain under load", () => {
  test("the route carries a real correlationId param", () => {
    expect(/correlationId: z\.string\(\)\.optional\(\)/.test(schemas)).toBe(true);
  });

  test("the button navigates by correlationId, not by free text", () => {
    expect(
      /search: \{ correlationId: corr, limit: 100 \}/.test(anomalies),
      "as `q` it is post-filtered over a bounded scan and can miss the chain",
    ).toBe(true);
    expect(
      /search: \{ q: corr/.test(anomalies),
      "the free-text drill-down must be gone, not merely duplicated",
    ).toBe(false);
  });

  test("the tab passes it as a TOP-LEVEL arg, which is what uses the index", () => {
    const call = src.slice(src.indexOf("const filtered = useQuery"));
    const args = call.slice(0, call.indexOf("filter: {"));
    expect(
      args.includes("correlationId"),
      "inside `filter` it would be post-filtered again",
    ).toBe(true);
  });
});
