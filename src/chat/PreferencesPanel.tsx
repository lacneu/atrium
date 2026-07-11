import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "./convexApi";
import { APP_HOST } from "@/lib/appHost";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages.js";
import {
  isMac,
  shortcutFromEvent,
  shortcutLabel,
  type Shortcut,
} from "@/lib/shortcuts";
import { PREF_META, groupAndFilterPrefs } from "./prefsMeta";
import { uiPrefOptimisticUpdate } from "./uiPrefOptimistic";
import {
  canGovernPrefs,
  govDefaultPatch,
  govDefaultValue,
  govGateKey,
} from "./prefsGovernance";

// User UI-preferences form (the interface-config toggles). Extracted from the
// former PreferencesDialog so it can live inside the Settings > Preferences tab
// (the modal was removed when these prefs moved out of the account menu).
//
// Renders the toggles the SERVER returns (getMe.ui.effective keys), grouped by
// category with an accent-insensitive filter (prefsMeta.groupAndFilterPrefs); a
// key with no display metadata still appears (in the "other" group). The server
// is the real gate (setUiPref rejects a locked feature); here locked rows are
// greyed with a "locked" note.
//
// GOVERNANCE (merged from the former admin "UI preferences" tab): an admin gets
// a "manage defaults & locks" switch (OFF by default — disclosure of the rare).
// When on, each row reveals ITS key's governance controls — the admin default
// (on/off/inherit -> admin.setUiPrefDefault) and, for system-gated prefs, the
// feature gate (admin.setFeatureEnabled). Same pattern as the Apparence tab
// (user pick + admin defaults on one surface, gated on me.role === "admin");
// the server independently enforces admin on both mutations.

type UiState = {
  effective: Record<string, boolean>;
  locked: Record<string, boolean>;
  userOverrides: Record<string, boolean | undefined>;
  defaults: Record<string, boolean | undefined>;
  featuresEnabled: Record<string, boolean | undefined>;
};

// Gate-specific help per system-gated pref (migrated from the former UiPrefsTab
// GATED_FEATURES list — the label reuses the pref's own i18n label).
const GATE_HELP: Record<string, () => string> = {
  voiceInput: () => m.uiprefs_gate_voiceInput_help(),
};

// Per-row governance zone (rendered only in governance mode): the admin default
// select + the system-gate checkbox when the key is gated.
function PrefGovernance({ prefKey, ui }: { prefKey: string; ui: UiState }) {
  const setDefault = useMutation(api.admin.setUiPrefDefault);
  const setFeature = useMutation(api.admin.setFeatureEnabled);
  const gateKey = govGateKey(prefKey);
  const gateHelp = gateKey ? GATE_HELP[prefKey]?.() : undefined;
  return (
    <div className="oc-prefs__gov">
      <div className="oc-prefs__gov-row">
        <span className="oc-prefs__gov-label">{m.prefs_gov_default_label()}</span>
        <Select
          value={govDefaultValue(ui.defaults[prefKey])}
          onValueChange={(v) =>
            void setDefault({ key: prefKey, value: govDefaultPatch(v) })
          }
        >
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="on">{m.uiprefs_value_on()}</SelectItem>
            <SelectItem value="off">{m.uiprefs_value_off()}</SelectItem>
            <SelectItem value="inherit">{m.uiprefs_value_inherit()}</SelectItem>
          </SelectContent>
        </Select>
        {gateKey ? (
          <span className="oc-prefs__gov-gate">
            <Checkbox
              checked={ui.featuresEnabled[gateKey] === true}
              onCheckedChange={(v) =>
                void setFeature({ key: gateKey, enabled: v === true })
              }
              aria-label={m.prefs_gov_gate_label()}
            />
            {m.prefs_gov_gate_label()}
          </span>
        ) : null}
      </div>
      {gateHelp ? <span className="oc-prefs__gov-help">{gateHelp}</span> : null}
    </div>
  );
}


/** Dictation-shortcut recorder: the user RECORDS a combination (press it while
 *  armed) rather than typing syntax. Requires a real modifier (mod/alt) so a
 *  bare letter can never fire while typing; Escape cancels, × clears. Stored
 *  on the profile — it follows the user across devices. */
function DictationShortcutCard({
  current,
  enabled,
}: {
  current: Shortcut | null;
  enabled: boolean;
}) {
  const setShortcut = useMutation(api.me.setDictationShortcut);
  const [recording, setRecording] = useState(false);
  const [rejected, setRejected] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const sc = shortcutFromEvent(e);
      if (sc === null) {
        // Pure modifier press: keep waiting. Anything else invalid: flash why.
        if (!["Shift", "Control", "Meta", "Alt"].includes(e.key)) {
          setRejected(true);
          window.setTimeout(() => setRejected(false), 1800);
        }
        return;
      }
      setRecording(false);
      void setShortcut({ shortcut: sc });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, setShortcut]);
  return (
    <div className={`oc-prefs__row${enabled ? "" : " is-locked"}`}>
      <div className="oc-prefs__info">
        <span className="oc-prefs__label">
          {m.prefs_dictation_shortcut_label()}
          {current ? (
            <Badge variant="secondary">{shortcutLabel(current, isMac())}</Badge>
          ) : null}
        </span>
        <span className="oc-prefs__help">
          {rejected
            ? m.prefs_dictation_shortcut_invalid()
            : recording
              ? m.prefs_dictation_shortcut_recording()
              : m.prefs_dictation_shortcut_help()}
        </span>
      </div>
      <div className="oc-prefs__ctl">
        {current && !recording ? (
          <button
            type="button"
            className="oc-prefs__reset"
            onClick={() => void setShortcut({ shortcut: null })}
          >
            {m.prefs_dictation_shortcut_clear()}
          </button>
        ) : null}
        <button
          type="button"
          className="oc-prefs__reset"
          disabled={!enabled}
          aria-pressed={recording}
          onClick={() => setRecording((r) => !r)}
        >
          {recording
            ? m.prefs_dictation_shortcut_cancel()
            : current
              ? m.prefs_dictation_shortcut_change()
              : m.prefs_dictation_shortcut_record()}
        </button>
      </div>
    </div>
  );
}

export function PreferencesPanel() {
  const [query, setQuery] = useState("");
  // Governance mode (admins only): hidden behind an explicit switch so the
  // everyday user view stays uncluttered.
  const [govMode, setGovMode] = useState(false);
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const ui = me?.ui as UiState | undefined;
  const governing = canGovernPrefs(me?.role) && govMode;
  // OPTIMISTIC (shared updater): each checkbox flips instantly; the write + its
  // getMe-invalidation cascade run in the background. Convex rolls the patch back
  // if the server rejects (e.g. a gated feature), so the box snaps back.
  const setPref = useMutation(api.me.setUiPref).withOptimisticUpdate(
    uiPrefOptimisticUpdate,
  );

  const groups = useMemo(
    () => (ui ? groupAndFilterPrefs(Object.keys(ui.effective), query) : []),
    [ui, query],
  );

  if (!ui) {
    return <div className="oc-prefs__empty">{m.common_loading()}</div>;
  }

  return (
    // Single wrapper (NOT a fragment): the Settings sections are a
    // `220px | 1fr` grid, and a fragment's children become separate grid
    // cells — the list then lands in the 220px heading column (the crushed
    // layout caught on 2026-06-11). One root keeps the panel in the 1fr cell.
    <div className="oc-prefs-panel">
      {canGovernPrefs(me?.role) ? (
        <label className="oc-prefs__gov-toggle">
          <Checkbox
            checked={govMode}
            onCheckedChange={(v) => setGovMode(v === true)}
            aria-label={m.prefs_admin_mode_toggle()}
          />
          {m.prefs_admin_mode_toggle()}
        </label>
      ) : null}
      {governing ? (
        // Governance-mode header: the general notes that are not per-key
        // (migrated from the former UiPrefsTab intro / gates / defaults notes).
        <div className="oc-prefs__gov-head">
          <p>{m.uiprefs_intro()}</p>
          <p>{m.uiprefs_gates_note()}</p>
          <p>{m.uiprefs_defaults_note()}</p>
        </div>
      ) : null}
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={m.prefs_filter_placeholder()}
        aria-label={m.prefs_filter_placeholder()}
        className="mb-2"
      />
      {groups.length === 0 ? (
        <div className="oc-prefs__empty">{m.prefs_no_match()}</div>
      ) : (
        <div className="oc-prefs">
          {/* One CARD per category (clear boundaries instead of a flat run-on
              list), rows inside separated by hairlines. The everyday view stays
              quiet: a badge only marks the EXCEPTIONS — a personalised value
              (with its reset affordance) or a locked/system-gated row — never
              the default state of every row. */}
          {groups.map((group) => (
            <section key={group.id} className="oc-prefs__card">
              <h4 className="oc-prefs__cat">{group.label}</h4>
              {group.keys.map((key) => {
                const meta = PREF_META[key];
                const label = meta ? meta.label() : key;
                const help = meta?.help?.();
                const locked = ui.locked[key];
                const checked = ui.effective[key];
                const overridden = ui.userOverrides[key] !== undefined;
                return (
                  <div
                    key={key}
                    className={`oc-prefs__row${locked ? " is-locked" : ""}`}
                  >
                    <div className="oc-prefs__info">
                      <span className="oc-prefs__label">
                        {label}
                        {locked ? (
                          <Badge variant="outline">
                            {m.prefs_badge_locked()}
                          </Badge>
                        ) : overridden ? (
                          <Badge variant="secondary">
                            {m.prefs_badge_custom()}
                          </Badge>
                        ) : null}
                      </span>
                      {help ? (
                        <span className="oc-prefs__help">{help}</span>
                      ) : null}
                    </div>
                    <div className="oc-prefs__ctl">
                      {!locked && overridden ? (
                        <button
                          type="button"
                          className="oc-prefs__reset"
                          onClick={() => void setPref({ key, value: null })}
                        >
                          {m.prefs_reset()}
                        </button>
                      ) : null}
                      <Switch
                        checked={checked}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          // System notifications need the BROWSER permission,
                          // which can only be requested on a user gesture —
                          // this toggle IS that gesture. Fire-and-forget: the
                          // pref stores the intent either way; the arrival
                          // hook re-checks Notification.permission at fire
                          // time (a later browser-side grant just works).
                          if (
                            key === "notifSystem" &&
                            v &&
                            typeof Notification !== "undefined" &&
                            Notification.permission === "default"
                          ) {
                            void Notification.requestPermission();
                          }
                          void setPref({ key, value: v });
                        }}
                        aria-label={label}
                      />
                    </div>
                    {governing ? <PrefGovernance prefKey={key} ui={ui} /> : null}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
      <DictationShortcutCard
        current={(me as { dictationShortcut?: Shortcut | null } | undefined | null)?.dictationShortcut ?? null}
        enabled={ui.effective.voiceInput === true}
      />
    </div>
  );
}
