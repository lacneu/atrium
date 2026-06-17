import { useState } from "react";
import { APP_HOST } from "@/lib/appHost";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convexApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";
import { type Locale } from "@/paraglide/runtime.js";
import { PreferencesPanel } from "../PreferencesPanel";

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
    | { locale: Locale | null; name: string | null }
    | undefined;
  const setLocale = useMutation(api.me.setLocale);
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
          {(["fr", "en", "default"] as const).map((opt) => (
            <Button
              key={opt}
              variant={localePref === opt ? "default" : "outline"}
              size="sm"
              onClick={() =>
                void setLocale({ locale: opt === "default" ? null : opt })
              }
            >
              {opt === "fr"
                ? m.language_fr()
                : opt === "en"
                  ? m.language_en()
                  : m.usermenu_theme_default()}
            </Button>
          ))}
        </div>
        <p className="oc-show__desc">{m.preferences_language_note()}</p>
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
