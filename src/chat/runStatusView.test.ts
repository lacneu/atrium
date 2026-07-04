// UI-4: unit tests for the run-status chip mapping. The states are transient
// (sub-second) so the live capture cannot reliably prove every branch — these do.

import { describe, expect, it } from "vitest";
import {
  runStatusView,
  runStatusOutageLabel,
  errorDetailView,
  messageHasText,
} from "./runStatusView";

describe("runStatusView", () => {
  it("streaming with NO text -> thinking", () => {
    expect(runStatusView("streaming", false)).toEqual({
      kind: "thinking",
      label: "Réflexion…",
    });
  });

  it("streaming WITH text -> generating", () => {
    expect(runStatusView("streaming", true)).toEqual({
      kind: "generating",
      label: "Génération…",
    });
  });

  it("error -> error chip (regardless of text)", () => {
    expect(runStatusView("error", false)?.kind).toBe("error");
    expect(runStatusView("error", true)?.kind).toBe("error");
  });

  it("aborted -> aborted chip", () => {
    expect(runStatusView("aborted", true)).toEqual({
      kind: "aborted",
      label: "Interrompu",
    });
  });

  it("complete -> no chip (null), even with text", () => {
    expect(runStatusView("complete", true)).toBeNull();
    expect(runStatusView("complete", false)).toBeNull();
  });

  it("undefined status -> thinking (the core's optimistic placeholder fills the gap)", () => {
    // The assistant-ui upcoming-message placeholder carries no status; it must
    // render the SAME thinking indicator so the send->first-token gap is covered
    // and hands off seamlessly to the real streaming doc.
    expect(runStatusView(undefined, false)).toEqual({
      kind: "thinking",
      label: "Réflexion…",
    });
  });

  it("unknown (non-empty) status -> no chip", () => {
    expect(runStatusView("weird", true)).toBeNull();
  });
});

describe("messageHasText", () => {
  it("true only for a non-empty text part", () => {
    expect(messageHasText([{ type: "text", text: "hi" }])).toBe(true);
    expect(messageHasText([{ type: "text", text: "" }])).toBe(false);
    expect(messageHasText([{ type: "text", text: "   " }])).toBe(false);
  });

  it("ignores non-text parts (tool/file/reasoning)", () => {
    expect(
      messageHasText([
        { type: "tool-call", text: undefined },
        { type: "file" },
      ]),
    ).toBe(false);
  });

  it("true when a text part coexists with other parts", () => {
    expect(
      messageHasText([{ type: "tool-call" }, { type: "text", text: "ok" }]),
    ).toBe(true);
  });

  it("false for undefined / empty content", () => {
    expect(messageHasText(undefined)).toBe(false);
    expect(messageHasText([])).toBe(false);
  });
});

describe("runStatusOutageLabel (honest in-flight label on gateway outage)", () => {
  it("returns the outage label for the IN-FLIGHT kinds while degraded", () => {
    expect(runStatusOutageLabel("thinking", true)).toContain("passerelle");
    expect(runStatusOutageLabel("generating", true)).toContain("passerelle");
  });
  it("never overrides a settled kind (error/aborted keep their own presentation)", () => {
    expect(runStatusOutageLabel("error", true)).toBeNull();
    expect(runStatusOutageLabel("aborted", true)).toBeNull();
  });
  it("returns null when the gateway is healthy (normal labels untouched)", () => {
    expect(runStatusOutageLabel("thinking", false)).toBeNull();
    expect(runStatusOutageLabel("generating", false)).toBeNull();
  });
});

describe("errorDetailView (actionable error classification)", () => {
  it("context_length -> localized headline + raw gateway text demoted to detail", () => {
    const v = errorDetailView("Context window exceeded", "context_length");
    expect(v.headline).toBeTruthy();
    expect(v.headline).not.toBe("Context window exceeded");
    expect(v.detail).toBe("Context window exceeded");
  });

  it("unknown code -> no headline, raw text stays the message", () => {
    const v = errorDetailView("some gateway error", "weird_code");
    expect(v.headline).toBeNull();
    expect(v.detail).toBe("some gateway error");
  });

  it("stream_orphaned via error string (legacy path, no errorCode) keeps its headline", () => {
    const v = errorDetailView("stream_orphaned", null);
    expect(v.headline).toBeTruthy();
    expect(v.detail).toBeNull(); // the code string is not a useful detail
  });

  it("rate_limit / timeout / refusal all classify", () => {
    for (const code of ["rate_limit", "timeout", "refusal"]) {
      expect(errorDetailView(null, code).headline).toBeTruthy();
    }
  });

  it("no error, no code -> nothing", () => {
    const v = errorDetailView(null, null);
    expect(v.headline).toBeNull();
    expect(v.detail).toBeNull();
  });
});
