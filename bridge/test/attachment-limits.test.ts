import { describe, expect, test } from "vitest";
import {
  base64ByteLength,
  maxRawInboundBytes,
  base64FitsFrame,
  FRAME_ENVELOPE_OVERHEAD_BYTES,
} from "../src/core/attachment-limits.js";

// The inbound-attachment cap is DERIVED from the gateway's maxPayload (no hardcoded
// file size). These pin the base64 math + the production incident so the derivation
// can't silently drift.

const GATEWAY_MAX_PAYLOAD = 26214400; // 25 MiB — observed live on 2026.6.5
const PPTX_BYTES = 21926171; // the exact file that failed in prod (20.91 MiB)

describe("base64ByteLength", () => {
  test("4 output chars per 3 input bytes (padded)", () => {
    expect(base64ByteLength(0)).toBe(0);
    expect(base64ByteLength(1)).toBe(4);
    expect(base64ByteLength(3)).toBe(4);
    expect(base64ByteLength(6)).toBe(8);
  });
  test("~4/3 inflation on a large file", () => {
    // 21.9 MiB raw -> ~29.2 MiB base64 (the inflation that overflows the WS frame).
    expect(base64ByteLength(PPTX_BYTES)).toBe(29234896);
  });
});

describe("maxRawInboundBytes (derive the raw cap from maxPayload)", () => {
  test("is maxPayload minus envelope, scaled by 3/4 (base64 headroom)", () => {
    const cap = maxRawInboundBytes(GATEWAY_MAX_PAYLOAD);
    expect(cap).toBe(Math.floor(((GATEWAY_MAX_PAYLOAD - FRAME_ENVELOPE_OVERHEAD_BYTES) * 3) / 4));
    // ~18.6 MiB, comfortably below the raw maxPayload number.
    expect(cap).toBeLessThan(GATEWAY_MAX_PAYLOAD);
  });

  test("THE production case: a 20.91 MiB file is over the derived cap", () => {
    expect(PPTX_BYTES).toBeGreaterThan(maxRawInboundBytes(GATEWAY_MAX_PAYLOAD));
  });

  test("a comfortably-smaller file is under the cap", () => {
    const seventeenMiB = 17 * 1024 * 1024;
    expect(seventeenMiB).toBeLessThan(maxRawInboundBytes(GATEWAY_MAX_PAYLOAD));
  });

  test("scales with maxPayload — NOT a hardcoded number (bigger gateway -> bigger cap)", () => {
    expect(maxRawInboundBytes(50 * 1024 * 1024)).toBeGreaterThan(
      maxRawInboundBytes(GATEWAY_MAX_PAYLOAD),
    );
  });

  test("a tiny maxPayload yields 0 (nothing fits), never negative", () => {
    expect(maxRawInboundBytes(1000)).toBe(0);
  });
});

describe("base64FitsFrame (the bridge frame guard)", () => {
  test("THE production case: the pptx base64 does NOT fit -> guard rejects (no connection-kill)", () => {
    expect(base64FitsFrame(base64ByteLength(PPTX_BYTES), GATEWAY_MAX_PAYLOAD)).toBe(false);
  });

  test("a 17 MiB file's base64 fits the frame", () => {
    expect(base64FitsFrame(base64ByteLength(17 * 1024 * 1024), GATEWAY_MAX_PAYLOAD)).toBe(true);
  });

  // DISCRIMINATING: the raw cap and the frame guard agree at the boundary — a file
  // at exactly the derived cap fits, one byte over does not.
  test("the derived raw cap and the frame guard are consistent", () => {
    const cap = maxRawInboundBytes(GATEWAY_MAX_PAYLOAD);
    expect(base64FitsFrame(base64ByteLength(cap), GATEWAY_MAX_PAYLOAD)).toBe(true);
    expect(base64FitsFrame(base64ByteLength(cap + 4096), GATEWAY_MAX_PAYLOAD)).toBe(false);
  });

  // DISCRIMINATING (Codex P3): when `usable` is NOT a multiple of 4 a plain
  // floor(usable*3/4) rounds UP past the frame (usable=6 -> raw=4 -> base64=8 > 6),
  // so a file exactly at the cap is accepted by the UI/Convex then rejected by the
  // bridge guard. The quantum-aligned formula must NEVER exceed `usable`.
  test("the raw cap never rounds past the frame for any usable size", () => {
    for (let extra = 1; extra <= 9; extra++) {
      const mp = FRAME_ENVELOPE_OVERHEAD_BYTES + extra;
      const raw = maxRawInboundBytes(mp);
      expect(base64ByteLength(raw)).toBeLessThanOrEqual(extra); // <= usable
      expect(base64FitsFrame(base64ByteLength(raw), mp)).toBe(true);
    }
  });
});
