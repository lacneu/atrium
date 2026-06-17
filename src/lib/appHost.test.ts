import { describe, it, expect, vi, afterEach } from "vitest";
import { readCachedBrand, writeCachedBrand } from "./appHost";

/** Minimal in-memory localStorage (edge-runtime has none by default). */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

afterEach(() => vi.unstubAllGlobals());

describe("appHost brand cache", () => {
  it("round-trips a cached brand for a host (valid token shape)", () => {
    vi.stubGlobal("localStorage", makeStorage());
    const brand = {
      tokens: { colors: { light: { primary: "x" }, dark: { primary: "y" } } },
      brand: { label: "Acme" },
    };
    writeCachedBrand("chat.acme.com", brand);
    expect(readCachedBrand("chat.acme.com")).toEqual(brand);
  });

  it("round-trips a NATIVE (tokens:null) cache", () => {
    vi.stubGlobal("localStorage", makeStorage());
    const native = { tokens: null, brand: { label: "Atrium", isDefault: true } };
    writeCachedBrand("x.acme.com", native);
    expect(readCachedBrand("x.acme.com")).toEqual(native);
  });

  it("scopes the cache PER host (one host's brand never bleeds into another)", () => {
    vi.stubGlobal("localStorage", makeStorage());
    const a = { tokens: null, brand: "A" };
    const b = { tokens: { colors: { light: {}, dark: {} } }, brand: "B" };
    writeCachedBrand("a.acme.com", a);
    writeCachedBrand("b.acme.com", b);
    expect(readCachedBrand("a.acme.com")).toEqual(a);
    expect(readCachedBrand("b.acme.com")).toEqual(b);
  });

  it("returns null for a host with no cached brand", () => {
    vi.stubGlobal("localStorage", makeStorage());
    expect(readCachedBrand("never-seen.acme.com")).toBeNull();
  });

  it("INVERSE: a malformed/stale shape (tokens without colors) is treated as ABSENT (null), never applied", () => {
    const s = makeStorage();
    // Valid JSON, WRONG shape (e.g. an old app version's cache). If returned, it
    // would crash applyChartTokens via tokens.colors[mode] on the login paint.
    s.setItem("oc.brand.stale.acme.com", JSON.stringify({ tokens: {}, brand: {} }));
    s.setItem("oc.brand.weird.acme.com", JSON.stringify({ tokens: 7 }));
    s.setItem("oc.brand.arr.acme.com", JSON.stringify(["not", "an", "object"]));
    vi.stubGlobal("localStorage", s);
    expect(readCachedBrand("stale.acme.com")).toBeNull();
    expect(readCachedBrand("weird.acme.com")).toBeNull();
    expect(readCachedBrand("arr.acme.com")).toBeNull();
  });

  it("INVERSE: corrupt JSON in storage → null (never throws)", () => {
    const s = makeStorage();
    s.setItem("oc.brand.bad.acme.com", "{ not valid json");
    vi.stubGlobal("localStorage", s);
    expect(readCachedBrand("bad.acme.com")).toBeNull();
  });

  it("INVERSE: writeCachedBrand swallows a storage error (quota / disabled)", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      getItem: () => null,
    } as unknown as Storage);
    expect(() =>
      writeCachedBrand("x.acme.com", { tokens: null, brand: null }),
    ).not.toThrow();
  });

  it("INVERSE: readCachedBrand swallows a storage error → null", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: storage disabled");
      },
    } as unknown as Storage);
    expect(readCachedBrand("x.acme.com")).toBeNull();
  });
});
