import { useEffect } from "react";
import { getLocale, setLocale, type Locale } from "@/paraglide/runtime.js";

export type { Locale };

/**
 * Apply a UI language whose SOURCE OF TRUTH is Convex (getMe.resolvedLocale).
 *
 * This hook does NOT own locale state — Paraglide's localStorage strategy owns
 * first-paint (unset => baseLocale "fr", no flash). The hook only RECONCILES the
 * server preference into Paraglide: on a real mismatch it calls `setLocale`,
 * which writes localStorage AND reloads the page ONCE. `setLocale` is a no-op
 * (no reload) when the locale already matches — its built-in
 * `newLocale !== currentLocale` guard — so this is loop-safe even though the
 * effect can run whenever getMe pushes a new resolved locale. After the reload,
 * localStorage == server, so the next pass is a no-op. `locale` is undefined
 * until getMe resolves; we skip it then (first-paint already correct).
 *
 * Impersonation note: getMe.resolvedLocale is the EFFECTIVE user's locale (the
 * impersonation target's, like the theme), so starting/stopping impersonation
 * between users of DIFFERENT locales triggers a reload here (the theme only
 * flips a class). This is self-healing — after the reload localStorage matches
 * the server again. It can race the `navigate({to:"/"})` that the identity-change
 * guard in router.tsx also fires; the chat read is server-guarded regardless, so
 * the worst case is the target landing on a deep chat URL that renders
 * access-denied until they navigate. Rare (admin-only + differing locales).
 */
export function useApplyLocale(locale: Locale | undefined) {
  useEffect(() => {
    if (!locale) return;
    // a11y: keep <html lang> in sync with the active locale (the index.html
    // inline script seeds it at first paint; this corrects it post-hydration and
    // after a same-page locale change). Idempotent, runs before the early return.
    document.documentElement.lang = locale;
    let current: Locale | undefined;
    try {
      current = getLocale();
    } catch {
      current = undefined; // no locale resolved yet
    }
    if (current === locale) return; // already applied → no write, no reload
    setLocale(locale); // writes localStorage + reloads once (mismatch only)
  }, [locale]);
}
