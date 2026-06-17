import { describe, it, expect } from "vitest";
import { normalizeDomain, hostCandidates } from "./domains";

describe("normalizeDomain", () => {
  it("lowercases, strips port / trailing dot / scheme / path", () => {
    expect(normalizeDomain("Chat.ACME.com")).toBe("chat.acme.com");
    expect(normalizeDomain("chat.acme.com:443")).toBe("chat.acme.com");
    expect(normalizeDomain("chat.acme.com.")).toBe("chat.acme.com");
    expect(normalizeDomain("https://chat.acme.com/login?x=1")).toBe(
      "chat.acme.com",
    );
  });
  it("accepts wildcards with a >=2-label base", () => {
    expect(normalizeDomain("*.acme.com")).toBe("*.acme.com");
    expect(normalizeDomain("*.b.acme.com")).toBe("*.b.acme.com");
  });
  it("rejects bare TLDs and single-label wildcards (no *.com / whole TLD)", () => {
    expect(normalizeDomain("*.com")).toBeNull();
    expect(normalizeDomain("com")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("*.")).toBeNull();
  });
  it("rejects invalid characters / malformed labels", () => {
    expect(normalizeDomain("ac me.com")).toBeNull();
    expect(normalizeDomain("acme..com")).toBeNull();
    expect(normalizeDomain("-acme.com")).toBeNull();
  });
  it("rejects an absurdly deep host (> MAX_LABELS) but accepts the boundary", () => {
    expect(normalizeDomain("a.b.c.d.e.f.g.h.i.j.com")).toBeNull(); // 11 labels
    expect(normalizeDomain("a.b.c.d.e.f.g.h.i.com")).toBe(
      "a.b.c.d.e.f.g.h.i.com",
    ); // 10 labels = boundary, still valid
  });
});

describe("hostCandidates (most-specific first; never *.<tld>)", () => {
  it("expands a deep host", () => {
    expect(hostCandidates("a.b.acme.com")).toEqual([
      "a.b.acme.com",
      "*.b.acme.com",
      "*.acme.com",
    ]);
  });
  it("expands a 3-label host", () => {
    expect(hostCandidates("chat.acme.com")).toEqual([
      "chat.acme.com",
      "*.acme.com",
    ]);
  });
  it("a 2-label apex yields only the exact host (no wildcard)", () => {
    expect(hostCandidates("acme.com")).toEqual(["acme.com"]);
  });
  it("normalizes the host (case/port) before expanding", () => {
    expect(hostCandidates("Chat.Acme.com:5173")).toEqual([
      "chat.acme.com",
      "*.acme.com",
    ]);
  });
  it("invalid hosts (localhost / single label) → [] (current behavior)", () => {
    expect(hostCandidates("localhost")).toEqual([]);
    expect(hostCandidates("")).toEqual([]);
  });
  it("an absurdly deep host (> MAX_LABELS) → [] (bounds the pre-auth expansion)", () => {
    // 11 labels: a client cannot drive one indexed read per label on brandForHost.
    expect(hostCandidates("a.b.c.d.e.f.g.h.i.j.com")).toEqual([]);
  });
  it("write=read symmetry: an exact stored domain is hit by its host", () => {
    const stored = normalizeDomain("Chat.Acme.com");
    expect(stored).not.toBeNull();
    expect(hostCandidates("chat.acme.com")).toContain(stored as string);
  });
  it("write=read symmetry: a wildcard stored domain is hit by a subdomain", () => {
    const stored = normalizeDomain("*.acme.com");
    expect(hostCandidates("x.y.acme.com")).toContain(stored as string);
  });
});
