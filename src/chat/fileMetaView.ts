// The file chip's metadata popover, as pure data.
//
// Kept out of the component so the two things that are easy to get wrong — the
// size a human reads, and the digest — are provable without a DOM.

const UNITS_FR = ["o", "ko", "Mo", "Go", "To"] as const;
const UNITS_EN = ["B", "kB", "MB", "GB", "TB"] as const;

/**
 * A human size in DECIMAL units (1 kB = 1000 B) — what macOS and most web UIs show.
 * Not universal, in either direction: Windows and several Linux file managers use
 * binary units under the same symbols, so the same file reads LARGER here than in
 * Explorer (1 500 000 bytes: 1.5 MB here, ~1.43 MB there), and S3 and Google Cloud
 * Storage bill per binary GiB. That is why the EXACT byte count is shown beside it (`exactBytes`) — a
 * rounded size is the wrong thing to quote when a transfer cap or a diff is in
 * question, and it is the one number nobody can disagree about.
 *
 * The SYMBOLS follow the locale: `o/ko/Mo` in French, `B/kB/MB` in English. An
 * earlier version emitted the French set everywhere, so an English UI read "1.2 Mo".
 */
export function formatFileSize(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = locale.startsWith("fr") ? UNITS_FR : UNITS_EN;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // Bytes are whole things; anything above shows one decimal, which is the
  // precision the eye actually uses at these magnitudes.
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  return `${formatted} ${units[unit]}`;
}

/** The exact count, grouped — always shown, never the only thing shown. */
export function exactBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  return new Intl.NumberFormat(locale).format(bytes);
}

/**
 * The stored digest, shown in FULL (wrapped). Full, because a truncated hash cannot
 * be compared against anything and comparing it is the only reason anyone reads one.
 *
 * Surrounding whitespace is trimmed — that is the ONE change made, so a padded value
 * cannot render as a digest with invisible characters a reader would copy. The value
 * itself is never re-encoded: the encoding belongs to the backend (the convex-test
 * harness answers base64, the docs describe hex, and this lot verified neither
 * against production).
 */
export function digestLabel(sha256: string | null): string | null {
  const trimmed = sha256?.trim();
  return trimmed ? trimmed : null;
}
