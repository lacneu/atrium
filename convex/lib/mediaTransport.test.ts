// The transport split is MODEL-NATIVE (inline) vs TOOL-READ (reference) — these
// tests pin that it is NOT literally image-vs-non-image (mode gates reference) and
// that it discriminates correctly per mode.

import { describe, expect, test } from "vitest";
import { classifyAttachment, isModelNativeMime } from "./mediaTransport";

describe("isModelNativeMime", () => {
  test("images are model-native (Vision)", () => {
    expect(isModelNativeMime("image/png")).toBe(true);
    expect(isModelNativeMime("image/jpeg")).toBe(true);
    expect(isModelNativeMime("IMAGE/WEBP")).toBe(true); // case-insensitive
  });
  test("video / audio / docs are NOT model-native (tool-read)", () => {
    expect(isModelNativeMime("video/mp4")).toBe(false);
    expect(isModelNativeMime("audio/mpeg")).toBe(false);
    expect(isModelNativeMime("application/pdf")).toBe(false);
    expect(isModelNativeMime(null)).toBe(false);
    expect(isModelNativeMime(undefined)).toBe(false);
  });
});

describe("classifyAttachment", () => {
  test("inline mode → everything inline (no reference transport)", () => {
    expect(
      classifyAttachment({ mimeType: "video/mp4", inboundMediaMode: "inline" }),
    ).toBe("inline");
    expect(
      classifyAttachment({ mimeType: "image/png", inboundMediaMode: "inline" }),
    ).toBe("inline");
  });

  test("shared-fs mode → tool-read goes by REFERENCE, model-native stays inline", () => {
    expect(
      classifyAttachment({ mimeType: "video/mp4", inboundMediaMode: "shared-fs" }),
    ).toBe("reference");
    expect(
      classifyAttachment({ mimeType: "audio/mpeg", inboundMediaMode: "shared-fs" }),
    ).toBe("reference");
    expect(
      classifyAttachment({
        mimeType: "application/pdf",
        inboundMediaMode: "shared-fs",
      }),
    ).toBe("reference");
    // A Vision image MUST stay inline even in shared-fs (the model needs the bytes).
    expect(
      classifyAttachment({ mimeType: "image/png", inboundMediaMode: "shared-fs" }),
    ).toBe("inline");
  });

  test("the criterion is purpose, NOT image-vs-non-image: a tool-read file in inline mode is inline, an image in shared-fs is inline", () => {
    // same MIME, different mode → different transport (mode gates reference)
    expect(
      classifyAttachment({ mimeType: "application/pdf", inboundMediaMode: "inline" }),
    ).toBe("inline");
    expect(
      classifyAttachment({ mimeType: "application/pdf", inboundMediaMode: "shared-fs" }),
    ).toBe("reference");
    // A DECODABLE image never becomes a reference, regardless of mode. "image/*"
    // is NOT the rule — see the svg+xml cases below, which are the reason this
    // comment is narrower than it used to be.
    expect(
      classifyAttachment({ mimeType: "image/gif", inboundMediaMode: "shared-fs" }),
    ).toBe("inline");
  });
});

// The defect these pin (production, 2026-09-11): a user attached two SVG logos and
// the agent reported them "not accessible", four turns running. `image/svg+xml`
// matched the old `image/*` rule, so it was pinned to the INLINE path and handed to
// a Vision model that cannot decode XML — while inline leaves no file on disk for a
// tool to read either. The attachment reached NOBODY.
describe("an image the model cannot decode is tool-read, not model-native", () => {
  test("SVG is NOT model-native (no Vision API decodes XML)", () => {
    expect(isModelNativeMime("image/svg+xml")).toBe(false);
    expect(isModelNativeMime("IMAGE/SVG+XML")).toBe(false);
  });

  test("an SVG rides BY REFERENCE in shared-fs, so a tool can actually read it", () => {
    expect(
      classifyAttachment({
        mimeType: "image/svg+xml",
        inboundMediaMode: "shared-fs",
      }),
    ).toBe("reference");
  });

  test("the four decodable raster formats stay model-native", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isModelNativeMime(mime), mime).toBe(true);
      expect(
        classifyAttachment({ mimeType: mime, inboundMediaMode: "shared-fs" }),
        mime,
      ).toBe("inline");
    }
  });

  test("other undecodable image subtypes are tool-read too (same root cause)", () => {
    for (const mime of ["image/tiff", "image/bmp", "image/heic", "image/x-icon"]) {
      expect(isModelNativeMime(mime), mime).toBe(false);
    }
  });

  test("a parameterised or oddly-cased type classifies on its BASE type", () => {
    expect(isModelNativeMime("image/png; charset=binary")).toBe(true);
    expect(isModelNativeMime("  Image/PNG  ")).toBe(true);
    // ...and the parameter cannot smuggle an undecodable type back in.
    expect(isModelNativeMime("image/svg+xml; charset=utf-8")).toBe(false);
  });

  test("inline mode is unchanged: an SVG there still has no reference transport", () => {
    // Stated so the limit is visible: this fix repairs shared-fs instances. On an
    // `inline` instance there is no reference leg at all, so an SVG remains
    // undeliverable to the model — that is a MODE choice, not this function's doing.
    expect(
      classifyAttachment({ mimeType: "image/svg+xml", inboundMediaMode: "inline" }),
    ).toBe("inline");
  });
});
