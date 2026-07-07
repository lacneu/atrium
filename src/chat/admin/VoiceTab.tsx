import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convexApi";
import type { Id } from "../../../convex/_generated/dataModel";
import { m } from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ttsSupported,
  dictationSupported,
  speakText,
  stopSpeaking,
  resolveSpeechLang,
} from "../speech";
import { getLocale } from "@/paraglide/runtime.js";
import "./confTabs.css";

// Settings > Agents > Voix — per-instance voice settings (read-aloud + dictation
// + the realtime-talk placeholder). The engines run in the USER'S BROWSER (Web
// Speech API): no API key, no gateway dependency, identical for OpenClaw and
// Hermes instances. What IS per-instance: whether read-aloud is offered, its
// language (an agent that answers in English should be read in English), the
// speaking rate, and auto-read. Stored in the instance config (same channel as
// the summarize/curation knobs).

const LANG_OPTIONS: ReadonlyArray<readonly [string, () => string]> = [
  ["auto", () => m.voice_lang_auto()],
  ["fr-FR", () => m.voice_lang_fr()],
  ["en-US", () => m.voice_lang_en_us()],
  ["en-GB", () => m.voice_lang_en_gb()],
  ["de-DE", () => m.voice_lang_de()],
  ["es-ES", () => m.voice_lang_es()],
];

const RATE_OPTIONS: ReadonlyArray<readonly [string, () => string]> = [
  ["0.75", () => m.voice_rate_slow()],
  ["1", () => m.voice_rate_normal()],
  ["1.25", () => m.voice_rate_fast()],
  ["1.5", () => m.voice_rate_faster()],
];

type InstanceRow = {
  _id: string;
  name: string;
  kind?: string;
  config?: Record<string, unknown>;
};

function VoiceInstanceCard({ instance }: { instance: InstanceRow }) {
  const upsert = useMutation(api.admin.upsertInstanceConfig);
  const cfg = instance.config ?? {};
  const stored = {
    enabled: cfg.voiceEnabled === true,
    lang: typeof cfg.voiceLang === "string" ? cfg.voiceLang : "auto",
    rate: typeof cfg.voiceRate === "number" ? String(cfg.voiceRate) : "1",
    autoRead: cfg.voiceAutoRead === true,
  };
  const [draft, setDraft] = useState(stored);
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">(
    "idle",
  );
  useEffect(() => {
    setDraft({
      enabled: cfg.voiceEnabled === true,
      lang: typeof cfg.voiceLang === "string" ? cfg.voiceLang : "auto",
      rate: typeof cfg.voiceRate === "number" ? String(cfg.voiceRate) : "1",
      autoRead: cfg.voiceAutoRead === true,
    });
    setState("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance._id]);

  const dirty =
    draft.enabled !== stored.enabled ||
    draft.lang !== stored.lang ||
    draft.rate !== stored.rate ||
    draft.autoRead !== stored.autoRead;

  async function save(): Promise<void> {
    setState("saving");
    try {
      const next: Record<string, unknown> = { ...(instance.config ?? {}) };
      next.voiceEnabled = draft.enabled;
      if (draft.lang === "auto") delete next.voiceLang;
      else next.voiceLang = draft.lang;
      const rate = Number.parseFloat(draft.rate);
      if (!Number.isFinite(rate) || rate === 1) delete next.voiceRate;
      else next.voiceRate = rate;
      if (draft.autoRead) next.voiceAutoRead = true;
      else delete next.voiceAutoRead;
      await upsert({
        instanceId: instance._id as Id<"instances">,
        config: next,
      });
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <section className="oc-voice__card">
      <header className="oc-voice__cardhead">
        <span className="oc-voice__instance">{instance.name}</span>
        <Badge variant="secondary">
          {instance.kind === "hermes" ? "Hermes" : "OpenClaw"}
        </Badge>
      </header>
      <label className="oc-cdefaults__inline" style={{ cursor: "pointer" }}>
        <Checkbox
          checked={draft.enabled}
          onCheckedChange={(v) => setDraft({ ...draft, enabled: v === true })}
          aria-label={m.voice_enable_label()}
        />
        <span className="oc-cdefaults__label">{m.voice_enable_label()}</span>
      </label>
      <div className="oc-voice__row">
        <span className="oc-cdefaults__label">{m.voice_lang_label()}</span>
        <Select
          value={draft.lang}
          onValueChange={(v) => setDraft({ ...draft, lang: v })}
          disabled={!draft.enabled}
        >
          <SelectTrigger size="sm" aria-label={m.voice_lang_label()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANG_OPTIONS.map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="oc-voice__row">
        <span className="oc-cdefaults__label">{m.voice_rate_label()}</span>
        <Select
          value={draft.rate}
          onValueChange={(v) => setDraft({ ...draft, rate: v })}
          disabled={!draft.enabled}
        >
          <SelectTrigger size="sm" aria-label={m.voice_rate_label()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RATE_OPTIONS.map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="oc-cdefaults__inline" style={{ cursor: "pointer" }}>
        <Checkbox
          checked={draft.autoRead}
          onCheckedChange={(v) => setDraft({ ...draft, autoRead: v === true })}
          disabled={!draft.enabled}
          aria-label={m.voice_autoread_label()}
        />
        <span className="oc-cdefaults__label">{m.voice_autoread_label()}</span>
      </label>
      <p className="oc-cdefaults__help">{m.voice_autoread_help()}</p>
      <div className="oc-cdefaults__inline">
        <Button
          size="sm"
          disabled={!dirty || state === "saving"}
          onClick={() => void save()}
        >
          {state === "saving" ? m.conf_applying() : m.cdefaults_save()}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!draft.enabled}
          onClick={() => {
            const rate = Number.parseFloat(draft.rate) || 1;
            speakText(m.voice_test_sentence(), {
              lang: resolveSpeechLang(draft.lang, getLocale()),
              rate,
            });
          }}
        >
          {m.voice_test_button()}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => stopSpeaking()}>
          {m.voice_stop_button()}
        </Button>
      </div>
      {state === "done" ? (
        <p className="oc-admin__hint" role="status">
          {m.cdefaults_saved()}
        </p>
      ) : null}
      {state === "error" ? (
        <p className="oc-cdefaults__error" role="alert">
          {m.cdefaults_save_error()}
        </p>
      ) : null}
    </section>
  );
}

export function VoiceTab() {
  const instances = useQuery(api.admin.listInstances, {}) as
    | InstanceRow[]
    | undefined;
  const tts = useMemo(() => ttsSupported(), []);
  const stt = useMemo(() => dictationSupported(), []);

  return (
    <div className="oc-admin__tab oc-voice">
      <p className="oc-admin__hint">{m.voice_tab_desc()}</p>

      {/* Browser capability line: the engines live client-side, so state it. */}
      <div className="oc-voice__support">
        <Badge variant={tts ? "secondary" : "destructive"}>
          {tts ? m.voice_support_tts_ok() : m.voice_support_tts_missing()}
        </Badge>
        <Badge variant={stt ? "secondary" : "destructive"}>
          {stt ? m.voice_support_stt_ok() : m.voice_support_stt_missing()}
        </Badge>
      </div>

      {instances === undefined ? (
        <p className="oc-admin__hint">{m.common_loading()}</p>
      ) : instances.length === 0 ? (
        <p className="oc-admin__hint">{m.voice_no_instances()}</p>
      ) : (
        instances.map((inst) => (
          <VoiceInstanceCard key={inst._id} instance={inst} />
        ))
      )}

      <section className="oc-voice__card">
        <header className="oc-voice__cardhead">
          <span className="oc-voice__instance">{m.voice_dictation_title()}</span>
          <Badge variant={stt ? "secondary" : "outline"}>
            {stt ? m.voice_status_ready() : m.voice_status_unavailable()}
          </Badge>
        </header>
        <p className="oc-cdefaults__help">{m.voice_dictation_help()}</p>
      </section>

      <section className="oc-voice__card">
        <header className="oc-voice__cardhead">
          <span className="oc-voice__instance">{m.voice_talk_title()}</span>
          <Badge variant="outline">{m.voice_talk_coming()}</Badge>
        </header>
        <p className="oc-cdefaults__help">{m.voice_talk_help()}</p>
      </section>
    </div>
  );
}
