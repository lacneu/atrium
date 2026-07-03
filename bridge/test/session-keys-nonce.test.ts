// Pinned safeSessionPart vectors SHARED with convex/rehydrationCompose.test.ts
// (the "gateway session-part mirror" block): the hybrid-rehydration correlate
// mirrors this sanitization Convex-side to match the summarize-job nonce inside
// the echoed turnSessionKey. Any behavior drift between the two implementations
// must break loudly on BOTH sides.

import { describe, expect, test } from "vitest";
import {
  buildSessionKey,
  safeSessionPart,
} from "../src/providers/openclaw/session-keys.js";

describe("safeSessionPart — shared correlation vectors", () => {
  test("sanitization vectors (mirror of the Convex copy)", () => {
    expect(safeSessionPart("summarize:abc123:1782960000000")).toBe(
      "summarize-abc123-1782960000000",
    );
    expect(safeSessionPart("  weird value!  ")).toBe("weird-value");
    expect(safeSessionPart("--dots.kept.--")).toBe("dots.kept");
    expect(safeSessionPart("///")).toBe("unknown");
  });

  test("the summarize nonce lands as the FINAL session-key segment", () => {
    const key = buildSessionKey("summarize:jd7abc:42", "olivier", "u");
    expect(key.endsWith(":summarize-jd7abc-42")).toBe(true);
  });
});
