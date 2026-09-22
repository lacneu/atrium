// WHY a turn closed must survive the traces that used to be its only home.
//
// Prod triage 2026-09-21: an `empty_response` from the previous day, still red in
// its conversation — seven tool calls, no text — and `list_traces` returned
// nothing for either the message or the child key. The verdict had been computed
// and written only to a `chat.gateway_pressure` record that had since expired.
// Worse, that record fires conditionally, so an ordinary `gateway_final` was
// frequently computed and persisted nowhere at all.
import { describe, expect, test } from "vitest";
import {
  FINALIZE_CAUSES,
  UNCLASSIFIED_FINALIZE_CAUSE,
  finalizeCauseClass,
} from "./lib/finalizeCause";

describe("the ingest boundary buckets a reported cause", () => {
  test("a cause this deployment knows is kept verbatim", () => {
    for (const cause of FINALIZE_CAUSES) {
      expect(finalizeCauseClass(cause)).toBe(cause);
    }
  });

  test("an UNKNOWN but well-formed cause is recorded, not dropped", () => {
    // Dropping it would reproduce the gap: a newer bridge minting a word this
    // deployment has not learned would leave the operator with nothing, which
    // reads exactly like "we never computed one". `unclassified` says something
    // different, and actionable.
    expect(finalizeCauseClass("some_future_cause")).toBe(
      UNCLASSIFIED_FINALIZE_CAUSE,
    );
    expect(FINALIZE_CAUSES.has("some_future_cause")).toBe(false);
  });

  test("a malformed value is refused — storage never holds a raw wire string", () => {
    for (const bad of [
      "Context overflow: prompt too large", // a sentence, not a cause
      "GATEWAY_FINAL", // not our casing
      "cause with spaces",
      "x".repeat(200),
      "",
      "   ",
      42,
      null,
      undefined,
      { cause: "gateway_final" },
    ]) {
      expect(finalizeCauseClass(bad), `refused: ${String(bad)}`).toBeNull();
    }
  });

  test("the surrounding whitespace of an otherwise good value is tolerated", () => {
    expect(finalizeCauseClass("  gateway_final  ")).toBe("gateway_final");
  });

  test("every cause is content-free by shape — an enum, never prose", () => {
    // The field rides the SOC2 observability plane and the client projection.
    // Nothing here may carry a message, an error sentence or an identifier.
    for (const cause of FINALIZE_CAUSES) {
      expect(cause, `${cause} must be a bare token`).toMatch(
        /^[a-z][a-z0-9_]{0,39}$/,
      );
    }
  });
});
