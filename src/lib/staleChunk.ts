// A failed DYNAMIC IMPORT after a deploy = the hashed chunk files this session's
// index.html references were replaced by a new release (stale-chunk). The router's
// reset() would re-run the SAME dead import forever; the only real fix is a full
// page reload, which fetches the fresh index.html and its new chunk graph.

/** True when an error is a stale-chunk dynamic-import failure (per-browser message
 *  shapes: Chromium / Safari / Firefox / Vite CSS preload). Pure. */
export function isStaleChunkError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error ?? "");
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("Unable to preload CSS")
  );
}

const RELOAD_GUARD_KEY = "atrium:chunkReloadAt";
const RELOAD_GUARD_WINDOW_MS = 60_000;

/** sessionStorage, or null when unavailable. Even REFERENCING sessionStorage can
 *  throw a SecurityError (sandboxed iframe / blocked storage), so the read itself is
 *  guarded — the error fallback must never re-crash while deciding to self-heal. */
function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Should this stale-chunk failure trigger an AUTOMATIC full reload? True at most
 * once per guard window (sessionStorage) — a genuinely broken deploy must land on
 * the visible error screen, not a reload loop. Records the attempt when true.
 * `storage` is injectable for tests; when unavailable (private-mode edge) there is
 * no loop guard possible, so NO auto reload (the manual button still works).
 */
export function shouldAutoReloadForStaleChunk(
  now: number,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage(),
): boolean {
  if (storage === null) return false;
  try {
    const last = Number(storage.getItem(RELOAD_GUARD_KEY) ?? 0);
    if (Number.isFinite(last) && now - last < RELOAD_GUARD_WINDOW_MS) return false;
    storage.setItem(RELOAD_GUARD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
