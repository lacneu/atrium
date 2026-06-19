// Agent markdown links: only real http(s)/mailto URLs are navigable. A non-URL
// href (server file path, bare filename, media://) must NOT render as a navigating
// <a> — that made a click resolve to the app origin and show the home/404 screen
// instead of the file. This is the discriminating guard for that bug.

import { describe, expect, test } from "vitest";
import { isNavigableHref } from "./markdownLinks";

describe("isNavigableHref", () => {
  test("absolute http(s) / mailto URLs are navigable", () => {
    expect(isNavigableHref("https://example.com/a.pdf")).toBe(true);
    expect(isNavigableHref("http://127.0.0.1:3213/api/storage/abc")).toBe(true);
    expect(isNavigableHref("HTTPS://EXAMPLE.COM")).toBe(true); // case-insensitive
    expect(isNavigableHref("  https://x.io  ")).toBe(true); // trimmed
    expect(isNavigableHref("mailto:a@b.co")).toBe(true);
  });

  test("server paths / bare filenames / non-web schemes are NOT navigable (would open home)", () => {
    expect(isNavigableHref("/home/node/media/mon-rapport.pdf")).toBe(false);
    expect(isNavigableHref("mon-rapport.pdf")).toBe(false);
    expect(isNavigableHref("media/outbound/x.pdf")).toBe(false);
    expect(isNavigableHref("media://inbound/abc")).toBe(false);
    expect(isNavigableHref("file:///etc/passwd")).toBe(false);
    expect(isNavigableHref("./relative")).toBe(false);
    expect(isNavigableHref("javascript:alert(1)")).toBe(false); // also blocks XSS-y schemes
  });

  test("missing / non-string href is not navigable", () => {
    expect(isNavigableHref(undefined)).toBe(false);
    expect(isNavigableHref(null)).toBe(false);
    expect(isNavigableHref("")).toBe(false);
    expect(isNavigableHref(42)).toBe(false);
  });
});
