// Vitest global setup.
//
// Paraglide's localStorage strategy reads `localStorage` inside getLocale(). The
// edge-runtime test environment has no real localStorage, so any test that
// imports a message function (`m.*`) crashes with "localStorage.getItem is not a
// function". Provide a minimal in-memory Storage stub → getLocale falls back to
// the baseLocale ("fr"), giving tests deterministic French strings without a
// browser. Harmless for the Convex tests (they don't touch localStorage).
if (
  typeof globalThis.localStorage === "undefined" ||
  typeof globalThis.localStorage.getItem !== "function"
) {
  const store = new Map<string, string>();
  const stub: Storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
  });
}
