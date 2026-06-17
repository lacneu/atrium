import { describe, it, expect } from "vitest";
import { processLogoImage } from "./processLogoImage";
import { m } from "@/paraglide/messages.js";

// processLogoImage's decode/canvas/re-encode path needs a real browser (canvas +
// createImageBitmap), so it is exercised in the live UI rather than here. Its
// INPUT GUARDS, however, run BEFORE any decoding and ARE unit-testable. We pin the
// EXACT guard message (not a bare .toThrow): decodeImage cannot succeed in this
// env, so a bare matcher would stay green even if a guard were removed (the decode
// would throw a DIFFERENT error). Matching the message makes the guard discriminating.
describe("processLogoImage input guards (pre-decode)", () => {
  it("INVERSE: rejects a non-image file with the not-image message", async () => {
    const notImage = new Blob(["plain text, not an image"], {
      type: "text/plain",
    });
    await expect(processLogoImage(notImage)).rejects.toThrow(
      m.charts_logo_err_not_image(),
    );
  });

  it("INVERSE: rejects an empty/typeless blob (no image/* prefix)", async () => {
    const typeless = new Blob([new Uint8Array(4)]);
    await expect(processLogoImage(typeless)).rejects.toThrow(
      m.charts_logo_err_not_image(),
    );
  });

  it("INVERSE: rejects an oversized image (> 12 MiB) with the too-large message", async () => {
    const huge = new Blob([new Uint8Array(12 * 1024 * 1024 + 1)], {
      type: "image/png",
    });
    await expect(processLogoImage(huge)).rejects.toThrow(
      m.charts_logo_err_too_large(),
    );
  });
});
