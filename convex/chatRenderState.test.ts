/// <reference types="vite/client" />
//
// Pure shared render-state + PHI-redaction helpers (convex/lib/chatRenderState).
// These are the SINGLE SOURCE for both the frontend run-status chip and the
// key-authed diagnostic projection, so pinning them here pins both.

import { describe, expect, test } from "vitest";
import {
  runStatusKind,
  textLenBucket,
  normalizeMessageErrorCode,
  mimeTypeBase,
} from "./lib/chatRenderState";

describe("runStatusKind (shared client/API derivation)", () => {
  test("maps every lifecycle state the client renders", () => {
    expect(runStatusKind(undefined, false)).toBe("thinking"); // optimistic placeholder
    expect(runStatusKind("streaming", false)).toBe("thinking");
    expect(runStatusKind("streaming", true)).toBe("generating");
    expect(runStatusKind("error", false)).toBe("error");
    expect(runStatusKind("aborted", false)).toBe("aborted");
    expect(runStatusKind("complete", true)).toBeNull();
    expect(runStatusKind("weird", false)).toBeNull();
  });
});

describe("textLenBucket (no exact length leaves)", () => {
  test("coarse buckets", () => {
    expect(textLenBucket(0)).toBe("0");
    expect(textLenBucket(50)).toBe("1-100");
    expect(textLenBucket(100)).toBe("1-100");
    expect(textLenBucket(500)).toBe("101-1k");
    expect(textLenBucket(1000)).toBe("101-1k");
    expect(textLenBucket(5000)).toBe("1k+");
  });
});

describe("normalizeMessageErrorCode (raw gateway text never leaves)", () => {
  test("known codes pass; anything else collapses to 'unknown'", () => {
    expect(normalizeMessageErrorCode("stream_orphaned")).toBe("stream_orphaned");
    expect(normalizeMessageErrorCode("gateway_timeout")).toBe("gateway_timeout");
    expect(normalizeMessageErrorCode("Patient Jean Dupont not found at /records")).toBe(
      "unknown",
    );
    expect(normalizeMessageErrorCode(null)).toBeNull();
    expect(normalizeMessageErrorCode("")).toBeNull();
  });
});

describe("mimeTypeBase (strips the filename-leaking name= param)", () => {
  test("keeps the base type only", () => {
    expect(mimeTypeBase('application/pdf; name="jean_dupont_biopsy.pdf"')).toBe(
      "application/pdf",
    );
    expect(mimeTypeBase("image/png")).toBe("image/png");
    expect(mimeTypeBase(null)).toBeNull();
    expect(mimeTypeBase(undefined)).toBeNull();
  });
});
