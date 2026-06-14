// Pure helpers for the merged Preferences tab: the user toggles AND the admin
// governance of the SAME keys (the former "Préférences UI" tab) now live on one
// surface — each row optionally reveals its governance controls when an admin
// switches the "manage defaults & locks" mode on. Extracted so the visibility
// rule and the tri-state mappings are unit-testable without rendering
// (prefsGovernance.test.ts). The server-side single sources stay untouched:
// admin.setUiPrefDefault / admin.setFeatureEnabled enforce admin for real.

import { UI_PREF_SYSTEM_GATE, isUiPrefKey } from "../../convex/lib/uiPrefs";

/** Only admins may see the governance mode (mirror of the other admin-gated
 * sections, e.g. the Apparence admin block: `me.role === "admin"`). */
export function canGovernPrefs(role: string | undefined): boolean {
  return role === "admin";
}

export type GovDefaultValue = "on" | "off" | "inherit";

/** Admin-default tri-state (true/false/unset) -> the <Select> value. */
export function govDefaultValue(def: boolean | undefined): GovDefaultValue {
  return def === true ? "on" : def === false ? "off" : "inherit";
}

/** <Select> value -> the setUiPrefDefault patch (null clears the default,
 * i.e. fall back to the built-in code default). */
export function govDefaultPatch(value: string): boolean | null {
  return value === "on" ? true : value === "off" ? false : null;
}

/** The system-gate (lock) key behind a pref — undefined when the pref is not
 * gated. Reads the SERVER registry (convex/lib/uiPrefs) so the merged panel
 * can never drift from what setUiPref actually enforces. */
export function govGateKey(prefKey: string): string | undefined {
  return isUiPrefKey(prefKey) ? UI_PREF_SYSTEM_GATE[prefKey] : undefined;
}
