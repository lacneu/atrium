// The transport split is MODEL-NATIVE (always inline) vs TOOL-READ (inline when the
// frame can carry it, reference otherwise) — these tests pin that it is NOT literally
// image-vs-non-image (mode and size gate reference) and that it discriminates
// correctly per mode.

import { describe, expect, test } from "vitest";
import {
  DEFAULT_GATEWAY_MAX_PAYLOAD,
  FRAME_ENVELOPE_OVERHEAD_BYTES,
  maxRawInboundBytes,
} from "./attachmentLimits";
import { isModelNativeMime, planAttachmentTransports } from "./mediaTransport";

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

// A frame roomy enough for anything these small sizes need: the per-test budgets
// below are expressed against it explicitly where the frame is the point.
const ROOMY = DEFAULT_GATEWAY_MAX_PAYLOAD;
const one = (mimeType: string, size = 100, inboundMediaMode: "inline" | "shared-fs" = "shared-fs") =>
  planAttachmentTransports({
    inboundMediaMode,
    maxPayload: ROOMY,
    attachments: [{ mimeType, size }],
  })[0];

describe("planAttachmentTransports — the mode", () => {
  test("inline mode → everything inline (no reference transport), whatever its size", () => {
    expect(one("video/mp4", 100, "inline")).toBe("inline");
    expect(one("image/png", 100, "inline")).toBe("inline");
    // Size does not route in inline mode: the dispatch's frame check refuses it.
    expect(one("video/mp4", 500 * 1024 * 1024, "inline")).toBe("inline");
  });

  test("shared-fs mode → a model-native image is inline, always", () => {
    expect(one("image/png")).toBe("inline");
    // Even one the frame cannot carry: there is no "vision via path", and the
    // dispatch's frame check is what refuses it, as before.
    expect(one("image/png", 500 * 1024 * 1024)).toBe("inline");
  });
});

// THE DEFECT THIS LOT FIXES (2026-10-02). Every tool-read file on a shared-fs
// instance used to be staged by the bridge and quoted as a path. A sandboxed or
// workspace-only agent's `read` tool refuses that path — measured on the bench
// against OpenClaw 2026.9.6, "Path escapes sandbox root (~/.openclaw/workspace-alice)"
// — while the same file sent as a native `chat.send` attachment is offloaded,
// staged and (text/PDF) extracted by the gateway itself. So a tool-read file goes
// native whenever the frame can carry it.
describe("planAttachmentTransports — a tool-read file on shared-fs", () => {
  test("small enough for the frame → INLINE (the gateway's own attachment path)", () => {
    for (const mime of ["text/plain", "application/pdf", "video/mp4", "audio/mpeg"]) {
      expect(one(mime), mime).toBe("inline");
    }
  });

  test("larger than the frame can carry → REFERENCE (the shared-fs leg, any size)", () => {
    const tooBig = maxRawInboundBytes(ROOMY) + 1;
    expect(one("video/mp4", tooBig)).toBe("reference");
    expect(one("application/pdf", tooBig)).toBe("reference");
    // …and exactly at the frame's raw ceiling it still fits.
    expect(one("application/pdf", maxRawInboundBytes(ROOMY))).toBe("inline");
  });

  test("an empty or unsized file is a REFERENCE: the gateway refuses an empty payload outright", () => {
    expect(one("text/plain", 0)).toBe("reference");
    expect(
      planAttachmentTransports({
        inboundMediaMode: "shared-fs",
        maxPayload: ROOMY,
        attachments: [{ mimeType: "text/plain", size: null }],
      }),
    ).toEqual(["reference"]);
  });

  test("the frame is shared: files are admitted IN ORDER until it is full, the rest by reference", () => {
    // Room for two 300-byte files (400 base64 bytes each), not three.
    const maxPayload = FRAME_ENVELOPE_OVERHEAD_BYTES + 800;
    expect(
      planAttachmentTransports({
        inboundMediaMode: "shared-fs",
        maxPayload,
        attachments: [
          { mimeType: "text/plain", size: 300 },
          { mimeType: "text/plain", size: 300 },
          { mimeType: "text/plain", size: 300 },
        ],
      }),
    ).toEqual(["inline", "inline", "reference"]);
  });

  test("a model-native image is reserved FIRST, wherever it sits — a document never pushes it out", () => {
    // Room for exactly one 300-byte file. The photo is LAST; were the frame filled in
    // order, the document would take the room and the photo would overflow — and a
    // photo cannot go by reference.
    const maxPayload = FRAME_ENVELOPE_OVERHEAD_BYTES + 400;
    expect(
      planAttachmentTransports({
        inboundMediaMode: "shared-fs",
        maxPayload,
        attachments: [
          { mimeType: "application/pdf", size: 300 },
          { mimeType: "image/jpeg", size: 300 },
        ],
      }),
    ).toEqual(["reference", "inline"]);
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
    // …even a tiny one the frame could carry: sent native, the GATEWAY would classify
    // it by its `image/` prefix and hand it to the model as an image — the very
    // dead end this allowlist exists to avoid.
    expect(one("image/svg+xml", 100)).toBe("reference");
  });

  test("the four decodable raster formats stay model-native", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isModelNativeMime(mime), mime).toBe(true);
      expect(one(mime), mime).toBe("inline");
    }
  });

  test("other undecodable image subtypes are tool-read too (same root cause)", () => {
    for (const mime of ["image/tiff", "image/bmp", "image/heic", "image/x-icon"]) {
      expect(isModelNativeMime(mime), mime).toBe(false);
      expect(one(mime), mime).toBe("reference");
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
    expect(one("image/svg+xml", 100, "inline")).toBe("inline");
  });
});
