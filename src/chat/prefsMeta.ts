import { m } from "@/paraglide/messages.js";

// Shared display metadata for the UI-preferences module (the interface-config
// toggles). Consumed by BOTH the user Preferences dialog (checkboxes) and the
// admin "UI preferences" tab (default-value selects), so categorization +
// filtering live here ONCE. Server keys are the source of truth (UI_PREF_KEYS);
// this is display-only — a key with no entry still renders (in "other").

export type PrefCategory =
  | "messages"
  | "composer"
  | "sidebar"
  | "notifications"
  | "other";

// Ordered categories (display order). "other" is the FALLBACK bucket: any pref
// whose key has no explicit category lands here so it can NEVER silently vanish
// from the list as the registry grows — the whole point of "to find them better".
export const PREF_CATEGORIES: { id: PrefCategory; label: () => string }[] = [
  { id: "messages", label: () => m.pref_category_messages() },
  { id: "composer", label: () => m.pref_category_composer() },
  { id: "sidebar", label: () => m.pref_category_sidebar() },
  { id: "notifications", label: () => m.pref_category_notifications() },
  { id: "other", label: () => m.pref_category_other() },
];

type PrefMeta = {
  category: PrefCategory;
  label: () => string;
  help?: () => string;
};

// label/help resolve through Paraglide at call time → they re-localize FR↔EN.
export const PREF_META: Record<string, PrefMeta> = {
  showSource: {
    category: "messages",
    label: () => m.pref_showSource_label(),
    help: () => m.pref_showSource_help(),
  },
  showReport: {
    category: "messages",
    label: () => m.pref_showReport_label(),
    help: () => m.pref_showReport_help(),
  },
  copyAssistant: {
    category: "messages",
    label: () => m.pref_copyAssistant_label(),
  },
  copyUser: { category: "messages", label: () => m.pref_copyUser_label() },
  showDelete: { category: "messages", label: () => m.pref_showDelete_label() },
  showTools: {
    category: "messages",
    label: () => m.pref_showTools_label(),
    help: () => m.pref_showTools_help(),
  },
  voiceInput: {
    category: "composer",
    label: () => m.pref_voiceInput_label(),
    help: () => m.pref_voiceInput_help(),
  },
  showUsage: {
    category: "composer",
    label: () => m.pref_showUsage_label(),
    help: () => m.pref_showUsage_help(),
  },
  autoReadAloud: {
    category: "composer",
    label: () => m.pref_autoReadAloud_label(),
    help: () => m.pref_autoReadAloud_help(),
  },
  showChatAge: {
    category: "sidebar",
    label: () => m.pref_showChatAge_label(),
    help: () => m.pref_showChatAge_help(),
  },
  notifSound: {
    category: "notifications",
    label: () => m.pref_notifSound_label(),
    help: () => m.pref_notifSound_help(),
  },
  notifSystem: {
    category: "notifications",
    label: () => m.pref_notifSystem_label(),
    help: () => m.pref_notifSystem_help(),
  },
  replySound: {
    category: "notifications",
    label: () => m.pref_replySound_label(),
    help: () => m.pref_replySound_help(),
  },
};

/** Accent- + case-insensitive normalization so a FR filter matches diacritics. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

export type PrefGroup = { id: PrefCategory; label: string; keys: string[] };

/**
 * Group server-provided pref `keys` by category and filter by `query`. An
 * unknown key falls into "other" (NEVER dropped). The match is accent-insensitive
 * over the pref's label + help + key + its category label (so typing a category
 * name surfaces its prefs). Returns the non-empty groups in category order.
 */
export function groupAndFilterPrefs(keys: string[], query: string): PrefGroup[] {
  const q = normalizeText(query.trim());
  const catLabel = new Map<PrefCategory, string>(
    PREF_CATEGORIES.map((c) => [c.id, c.label()]),
  );
  const byCat = new Map<PrefCategory, string[]>(
    PREF_CATEGORIES.map((c) => [c.id, []]),
  );

  for (const key of keys) {
    const meta = PREF_META[key];
    const cat: PrefCategory = meta?.category ?? "other"; // fallback, never dropped
    if (q) {
      const label = meta ? meta.label() : key;
      const help = meta?.help ? meta.help() : "";
      const hay = normalizeText(
        `${label} ${help} ${key} ${catLabel.get(cat) ?? ""}`,
      );
      if (!hay.includes(q)) continue;
    }
    byCat.get(cat)!.push(key);
  }

  return PREF_CATEGORIES.map((c) => ({
    id: c.id,
    label: catLabel.get(c.id)!,
    keys: byCat.get(c.id)!,
  })).filter((g) => g.keys.length > 0);
}
