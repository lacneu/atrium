import { describe, expect, test } from "vitest";
import { digestLabel, exactBytes, formatFileSize } from "./fileMetaView";

describe("formatFileSize", () => {
  test("bytes stay whole", () => {
    expect(formatFileSize(0, "fr-FR")).toBe("0 o");
    expect(formatFileSize(999, "fr-FR")).toBe("999 o");
  });

  test("it climbs one unit at a time, decimal", () => {
    // 1000, not 1024: the user compares this against their file manager.
    expect(formatFileSize(1000, "en-US")).toBe("1 kB");
    expect(formatFileSize(1_234_567, "en-US")).toBe("1.2 MB");
    expect(formatFileSize(5_000_000_000, "en-US")).toBe("5 GB");
  });

  test("the SYMBOLS follow the locale, not just the separators", () => {
    // An English UI reading "1.2 Mo" is the defect this pins.
    expect(formatFileSize(1_234_567, "fr-FR")).toBe("1,2 Mo");
    expect(formatFileSize(1_234_567, "en-US")).toBe("1.2 MB");
    expect(formatFileSize(999, "en-US")).toBe("999 B");
  });

  test("it stops at the largest unit instead of inventing one", () => {
    expect(formatFileSize(9e15, "en-US")).toMatch(/ TB$/);
  });

  test("a nonsensical size reads as unknown, never as 0 o", () => {
    expect(formatFileSize(Number.NaN, "fr-FR")).toBe("—");
    expect(formatFileSize(-1, "fr-FR")).toBe("—");
  });
});

describe("exactBytes", () => {
  test("the exact count is grouped for the eye", () => {
    expect(exactBytes(1_234_567, "en-US")).toBe("1,234,567");
  });
});

describe("digestLabel", () => {
  test("absent or blank = no digest to show", () => {
    expect(digestLabel(null)).toBeNull();
    expect(digestLabel("   ")).toBeNull();
  });

  test("present = shown WHOLE, in either encoding, never re-encoded", () => {
    // The encoding is the backend's: the convex-test harness answers base64, the
    // docs describe hex. Neither is reformatted, so both pass through intact.
    for (const d of [
      "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ]) {
      expect(digestLabel(d)).toBe(d);
    }
  });

  test("surrounding whitespace is the ONE thing trimmed", () => {
    // Otherwise a padded value renders as a digest carrying invisible characters,
    // which a reader would copy and then fail to match.
    const d = "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";
    expect(digestLabel(`  ${d}\n`)).toBe(d);
  });
});
