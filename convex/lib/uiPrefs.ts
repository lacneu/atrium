// UI preferences — the single source of truth for which interface toggles exist,
// their code defaults, and which are gated behind a system-level feature flag.
//
// Resolution model (mirrors the theme system: user override -> admin default ->
// code default), PLUS a system gate: a feature whose underlying system is not yet
// enabled by an admin resolves to `false` AND is `locked` (the user cannot turn
// it on — the server rejects it; the UI greys it). CRITICAL: the gate is applied
// at READ time, so disabling a feature hides it WITHOUT deleting the user's stored
// override — re-enabling restores the user's choice.

export const UI_PREF_KEYS = [
  "showSource",
  "showReport",
  "copyAssistant",
  "copyUser",
  "showDelete",
  "showTools",
  "voiceInput",
  "showChatAge",
  "showUsage",
  "autoReadAloud",
  "notifSound",
  "notifSystem",
  "replySound",
] as const;

export type UiPrefKey = (typeof UI_PREF_KEYS)[number];
export type UiPrefsObject = Partial<Record<UiPrefKey, boolean>>;
export type FeaturesEnabled = Partial<Record<string, boolean>>;

// Default when neither the user nor the admin has set a value.
export const UI_PREF_CODE_DEFAULTS: Record<UiPrefKey, boolean> = {
  showSource: true,
  showReport: true,
  copyAssistant: true,
  copyUser: true,
  showDelete: true,
  // OFF by default = the CLEAN, content-focused conversation view (no tool-activity
  // / Sources blocks). The user opts IN to the analysis view (tool calls + sources,
  // drill-down detail) by enabling "Outils". The in-progress signal is preserved in
  // the clean view by the RunStatus line ("… traite votre message"), so disabling
  // tools never hides that a turn is being processed.
  showTools: false,
  voiceInput: false, // opt-in mic; needs the admin feature gate + user consent
  showChatAge: true, // compact relative age in the sidebar (OpenWebUI-style)
  // Subscription-usage gauge in the chat composer strip (the routed instance's
  // most-constrained rate window). ON by default: quota transparency is what
  // explains slowdowns/429s to the user; an admin can turn it off fleet-wide.
  showUsage: true,
  // Auto read-aloud OPT-OUT: when an instance enables voiceAutoRead, each user
  // may still silence it here (default ON = the admin's instance-level choice
  // applies, the user keeps the veto — matches the Voice tab's help text).
  autoReadAloud: true,
  // Sound cues are OPT-IN (no surprise audio; browser autoplay policies make
  // un-gestured audio unreliable anyway). notifSound/notifSystem fire on a NEW
  // bell notification (admins get anomalies + user reports there); replySound
  // fires when an assistant reply FINISHES in one of the user's chats.
  notifSound: false,
  // Browser (system-level) notification on a new bell notification. Turning it
  // on triggers the browser permission prompt (handled client-side on toggle).
  notifSystem: false,
  replySound: false,
};

// Pref key -> the `featuresEnabled` key that must be true before a user may turn
// it on. Absent => always available.
export const UI_PREF_SYSTEM_GATE: Partial<Record<UiPrefKey, string>> = {
  voiceInput: "voiceInput",
};

export function isUiPrefKey(s: string): s is UiPrefKey {
  return (UI_PREF_KEYS as readonly string[]).includes(s);
}

export function prefGateKey(key: UiPrefKey): string | undefined {
  return UI_PREF_SYSTEM_GATE[key];
}

export type ResolvedUiPrefs = {
  effective: Record<UiPrefKey, boolean>;
  locked: Record<UiPrefKey, boolean>;
  userOverrides: UiPrefsObject;
  defaults: UiPrefsObject;
  featuresEnabled: FeaturesEnabled;
};

/**
 * Resolve the effective UI prefs for a user: user override -> admin default ->
 * code default, with a system gate applied at read time.
 *
 * NOTE: the pre-module legacy profile fields (showTools/voiceInput) are
 * deliberately NOT consulted. They sat at override priority, which silently
 * SHADOWED the admin default (a user with a stale legacy value would never see a
 * changed admin default) while the UI still labeled it "default" — confusing and
 * contrary to "the admin default must apply". Dropping them makes the admin
 * default surface whenever the user has no explicit override.
 */
export function resolveUiPrefs(
  userOverrides: UiPrefsObject | undefined,
  adminDefaults: UiPrefsObject | undefined,
  featuresEnabled: FeaturesEnabled | undefined,
): ResolvedUiPrefs {
  const effective = {} as Record<UiPrefKey, boolean>;
  const locked = {} as Record<UiPrefKey, boolean>;
  for (const key of UI_PREF_KEYS) {
    const gate = UI_PREF_SYSTEM_GATE[key];
    const enabled = gate ? featuresEnabled?.[gate] === true : true;
    locked[key] = !enabled;
    if (!enabled) {
      effective[key] = false; // gated off — but the override below is NOT deleted
      continue;
    }
    effective[key] =
      userOverrides?.[key] ??
      adminDefaults?.[key] ??
      UI_PREF_CODE_DEFAULTS[key];
  }
  return {
    effective,
    locked,
    userOverrides: userOverrides ?? {},
    defaults: adminDefaults ?? {},
    featuresEnabled: featuresEnabled ?? {},
  };
}
