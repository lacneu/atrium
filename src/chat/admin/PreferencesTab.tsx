import { useState } from "react";
import { localeOptions } from "../localePickerView";
import { APP_HOST } from "@/lib/appHost";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convexApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";
import { type Locale } from "@/paraglide/runtime.js";
import { FONT_SCALES, type FontScale } from "@/lib/useFontScale";
import { PreferencesPanel } from "../PreferencesPanel";
import { TimezoneCombobox } from "./TimezoneCombobox";

// Localized labels for the text-size choices (call-time so they re-localize).
const FONT_SCALE_LABELS: Record<FontScale, () => string> = {
  sm: () => m.fontsize_sm(),
  md: () => m.fontsize_md(),
  lg: () => m.fontsize_lg(),
  xl: () => m.fontsize_xl(),
  "2xl": () => m.fontsize_2xl(),
  "3xl": () => m.fontsize_3xl(),
};

// Settings > Preferences (user-scoped, gated on chats.read like Files). Holds the
// personal preferences that used to live in the account menu / its modal:
//  - Language: the user's OWN locale pref (null = follow the admin default). The
//    button value mirrors the old menu radio; setLocale writes Convex, getMe's
//    resolvedLocale then drives useApplyLocale (Paraglide reload-on-change).
//  - Interface: the UI-toggle form (PreferencesPanel), formerly the modal body.
// Visible to ALL approved users — the account menu now only carries theme mode +
// sign out.
export function PreferencesTab() {
  const me = useQuery(api.me.getMe, { host: APP_HOST }) as
    | {
        locale: Locale | null;
        name: string | null;
        fontScale: FontScale | null;
        timezone: string | null;
      }
    | undefined;
  const setLocale = useMutation(api.me.setLocale);
  const setTimezone = useMutation(api.me.setTimezone);
  // OPTIMISTIC (mirror of UserMenu's setThemeMode): the whole UI resizes the
  // instant a size is clicked — useApplyFontScale reads resolvedFontScale from
  // the local getMe cache, so patching it here skips the server round-trip lag.
  const setFontScale = useMutation(api.me.setFontScale).withOptimisticUpdate(
    (store, { scale }) => {
      const cur = store.getQuery(api.me.getMe, { host: APP_HOST });
      if (!cur) return;
      store.setQuery(
        api.me.getMe,
        { host: APP_HOST },
        { ...cur, fontScale: scale, resolvedFontScale: scale ?? "md" },
      );
    },
  );
  const setMyName = useMutation(api.me.setMyName);
  const toast = useToast();
  const localePref: Locale | "default" = me?.locale ?? "default";

  // Display-name editor. `draft === null` means "follow the server value"; once
  // the user types, the draft holds until saved (then reset to follow again).
  const savedName = me?.name ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const nameValue = draft ?? savedName;
  const nameDirty = nameValue.trim() !== savedName.trim();
  async function saveName() {
    try {
      await setMyName({ name: nameValue });
      setDraft(null);
      toast.success(m.preferences_name_saved());
    } catch (err) {
      toast.error(m.preferences_name_error(), err);
    }
  }

  return (
    <div className="oc-appearance">
      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h2 className="oc-show__title">{m.preferences_name_title()}</h2>
          <p className="oc-show__desc">{m.preferences_name_desc()}</p>
        </div>
        <div className="oc-show__row">
          <Input
            className="max-w-xs"
            value={nameValue}
            maxLength={120}
            placeholder={m.preferences_name_placeholder()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameDirty) {
                e.preventDefault();
                void saveName();
              }
            }}
          />
          <Button size="sm" disabled={!nameDirty} onClick={() => void saveName()}>
            {m.settings_save()}
          </Button>
        </div>
        <p className="oc-show__desc">{m.preferences_name_note()}</p>
      </section>

      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h2 className="oc-show__title">{m.preferences_language_title()}</h2>
          <p className="oc-show__desc">{m.preferences_language_desc()}</p>
        </div>
        <div className="oc-show__row">
          {/* Derived from SUPPORTED_LOCALES (endonym labels) + the "default"
              (inherit admin) entry — scales to any number of languages. */}
          {localeOptions().map((opt) => (
            <Button
              key={opt.value}
              variant={localePref === opt.value ? "default" : "outline"}
              size="sm"
              onClick={() => void setLocale({ locale: opt.value })}
            >
              {opt.label}
            </Button>
          ))}
          <Button
            variant={localePref === "default" ? "default" : "outline"}
            size="sm"
            onClick={() => void setLocale({ locale: null })}
          >
            {m.usermenu_theme_default()}
          </Button>
        </div>
        <p className="oc-show__desc">{m.preferences_language_note()}</p>
      </section>

      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h2 className="oc-show__title">{m.preferences_timezone_title()}</h2>
          <p className="oc-show__desc">{m.preferences_timezone_desc()}</p>
        </div>
        <div className="oc-show__row">
          {/* Same searchable IANA picker as the cron editor (shared component).
              Empty value = follow the browser; the explicit button clears back
              to that default. */}
          <TimezoneCombobox
            value={me?.timezone ?? ""}
            onChange={(tz) => void setTimezone({ timezone: tz })}
          />
          <Button
            variant={me?.timezone === null || me?.timezone === undefined ? "default" : "outline"}
            size="sm"
            onClick={() => void setTimezone({ timezone: null })}
          >
            {m.preferences_timezone_browser()}
          </Button>
        </div>
        <p className="oc-show__desc">{m.preferences_timezone_note()}</p>
      </section>

      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h2 className="oc-show__title">{m.preferences_fontsize_title()}</h2>
          <p className="oc-show__desc">{m.preferences_fontsize_desc()}</p>
        </div>
        <div className="oc-show__row">
          {/* Same button-radio pattern as the language row above. The active
              value is the user's pref resolved to the "md" code default (no
              admin default for text size — comfort is personal). */}
          {FONT_SCALES.map((scale) => (
            <Button
              key={scale}
              variant={(me?.fontScale ?? "md") === scale ? "default" : "outline"}
              size="sm"
              onClick={() => void setFontScale({ scale })}
            >
              {FONT_SCALE_LABELS[scale]()}
            </Button>
          ))}
        </div>
        <p className="oc-show__desc">{m.preferences_fontsize_note()}</p>
      </section>

      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h2 className="oc-show__title">{m.preferences_interface_title()}</h2>
          <p className="oc-show__desc">{m.preferences_interface_desc()}</p>
        </div>
        <PreferencesPanel />
      </section>
    </div>
  );
}
