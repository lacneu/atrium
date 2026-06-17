import type { OptimisticLocalStore } from "convex/browser";
import { api } from "./convexApi";
import { APP_HOST } from "@/lib/appHost";

// Shared OPTIMISTIC updater for me.setUiPref — used by BOTH the composer's
// "Outils" quick toggle (ConvexChat) and the Settings > Preferences checkboxes
// (PreferencesPanel), so every UI-pref control flips instantly.
//
// Why: a profile write invalidates getMe, which cascades a re-run of EVERY
// profile-reading query on the page (~14 on the chat screen). Without an
// optimistic patch the control only flips AFTER that round-trip + cascade — on a
// constrained backend that reads as a multi-second lag. Convex rolls the patch
// back automatically if the mutation throws (e.g. a system-gated feature), so a
// rejected toggle visibly snaps back to its real state.
export function uiPrefOptimisticUpdate(
  store: OptimisticLocalStore,
  { key, value }: { key: string; value: boolean | null },
): void {
  const cur = store.getQuery(api.me.getMe, { host: APP_HOST });
  if (!cur?.ui) return;
  const effective = { ...cur.ui.effective };
  const userOverrides = { ...cur.ui.userOverrides };
  const ek = key as keyof typeof effective;
  const ok = key as keyof typeof userOverrides;
  if (value === null) {
    // Reset to the admin default: clear the override; the server's resolved
    // `effective` lands a moment later (we don't hold the admin default locally).
    delete userOverrides[ok];
  } else {
    effective[ek] = value;
    userOverrides[ok] = value;
  }
  store.setQuery(
    api.me.getMe,
    { host: APP_HOST },
    { ...cur, ui: { ...cur.ui, effective, userOverrides } },
  );
}
