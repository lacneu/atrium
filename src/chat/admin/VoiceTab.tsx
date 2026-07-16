import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Mic, Volume2, AudioLines } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convexApi";
import { APP_HOST } from "@/lib/appHost";
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
  playGatewayAudio,
  stopGatewayAudio,
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

// Gateway-preview generation, MODULE-level so it is shared across every
// instance card: audio output is global (one clip at a time), so a test on
// ANY card must supersede an in-flight preview from ANY other card.
let previewGeneration = 0;

function VoiceInstanceCard({ instance }: { instance: InstanceRow }) {
  const upsert = useMutation(api.admin.upsertInstanceConfig);
  const cfg = instance.config ?? {};
  const stored = {
    enabled: cfg.voiceEnabled === true,
    engine: cfg.voiceEngine === "gateway" ? "gateway" : "browser",
    lang: typeof cfg.voiceLang === "string" ? cfg.voiceLang : "auto",
    rate: typeof cfg.voiceRate === "number" ? String(cfg.voiceRate) : "1",
    autoRead: cfg.voiceAutoRead === true,
  };
  const [draft, setDraft] = useState(stored);
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">(
    "idle",
  );
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState(false);
  const preview = useAction(api.voice.gatewayTtsPreview);
  useEffect(() => {
    setDraft({
      enabled: cfg.voiceEnabled === true,
      engine: cfg.voiceEngine === "gateway" ? "gateway" : "browser",
      lang: typeof cfg.voiceLang === "string" ? cfg.voiceLang : "auto",
      rate: typeof cfg.voiceRate === "number" ? String(cfg.voiceRate) : "1",
      autoRead: cfg.voiceAutoRead === true,
    });
    setState("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance._id]);

  const dirty =
    draft.enabled !== stored.enabled ||
    draft.engine !== stored.engine ||
    draft.lang !== stored.lang ||
    draft.rate !== stored.rate ||
    draft.autoRead !== stored.autoRead;

  async function save(): Promise<void> {
    setState("saving");
    try {
      const next: Record<string, unknown> = { ...(instance.config ?? {}) };
      next.voiceEnabled = draft.enabled;
      if (draft.engine === "gateway") next.voiceEngine = "gateway";
      else delete next.voiceEngine;
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
      // No confirmation copy: the Save button re-disabling (dirty=false once
      // the subscription echoes the stored config) IS the feedback.
      setState("idle");
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
        <span className="oc-cdefaults__label">{m.voice_engine_label()}</span>
        <Select
          value={draft.engine}
          onValueChange={(v) => setDraft({ ...draft, engine: v })}
          disabled={!draft.enabled}
        >
          <SelectTrigger size="sm" aria-label={m.voice_engine_label()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="browser">{m.voice_engine_browser()}</SelectItem>
            {instance.kind !== "hermes" ? (
              <SelectItem value="gateway">{m.voice_engine_gateway()}</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>
      {draft.engine === "gateway" ? (
        <p className="oc-cdefaults__help">{m.voice_engine_gateway_help()}</p>
      ) : null}
      {/* Language + auto-read only apply to the BROWSER engine. The gateway
          synthesizes with its own configured voice (language and voice are
          gateway-side, not controllable per request), and auto-read is
          browser-only — so both are hidden on a gateway-engine instance rather
          than shown as dead controls. */}
      {draft.engine !== "gateway" ? (
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
      ) : null}
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
      {draft.engine !== "gateway" ? (
        <>
          <label className="oc-cdefaults__inline" style={{ cursor: "pointer" }}>
            <Checkbox
              checked={draft.autoRead}
              onCheckedChange={(v) =>
                setDraft({ ...draft, autoRead: v === true })
              }
              disabled={!draft.enabled}
              aria-label={m.voice_autoread_label()}
            />
            <span className="oc-cdefaults__label">
              {m.voice_autoread_label()}
            </span>
          </label>
          <p className="oc-cdefaults__help">{m.voice_autoread_help()}</p>
        </>
      ) : null}
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
          disabled={!draft.enabled || testing}
          onClick={() => {
            const rate = Number.parseFloat(draft.rate) || 1;
            // Every test — either engine — supersedes any in-flight preview and
            // silences whatever is playing, so a slow gateway synthesis can
            // never land on top of a newer test (codex P2).
            const gen = ++previewGeneration;
            setTestError(false);
            stopSpeaking();
            stopGatewayAudio();
            if (draft.engine !== "gateway") {
              speakText(m.voice_test_sentence(), {
                lang: resolveSpeechLang(draft.lang, getLocale()),
                rate,
              });
              return;
            }
            // Gateway engine: synthesize the sample through the instance's own
            // gateway TTS, then play it at the configured rate.
            setTesting(true);
            preview({ instanceName: instance.name, text: m.voice_test_sentence() })
              .then(({ mime, audioBase64 }: { mime: string; audioBase64: string }) => {
                if (gen !== previewGeneration) return; // stopped / superseded
                playGatewayAudio(audioBase64, mime, { rate });
              })
              .catch(() => {
                if (gen === previewGeneration) setTestError(true);
              })
              // Always clear THIS card's loading state — the card only ever has
              // one preview in flight (its Test button is disabled while
              // testing), so being superseded by another card must not leave it
              // stuck (codex P2). The generation guard gates playback/error, not
              // this card's own spinner.
              .finally(() => setTesting(false));
          }}
        >
          {testing ? m.conf_applying() : m.voice_test_button()}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            previewGeneration++;
            setTesting(false);
            stopSpeaking();
            stopGatewayAudio();
          }}
        >
          {m.voice_stop_button()}
        </Button>
      </div>
      {state === "error" || testError ? (
        <p className="oc-cdefaults__error" role="alert">
          {testError ? m.voice_test_gateway_error() : m.cdefaults_save_error()}
        </p>
      ) : null}
    </section>
  );
}

/** Dictation card — includes the SYSTEM feature gate switch (the same
 *  `voiceInput` gate the Preferences admin mode exposes): admins enable the
 *  mic pipeline right here instead of hunting for it in the Preferences
 *  admin mode. Users still opt in individually. */
function DictationCard({ stt }: { stt: boolean }) {
  const me = useQuery(api.me.getMe, { host: APP_HOST }) as
    | {
        role?: string;
        ui?: { featuresEnabled?: Record<string, boolean | undefined> };
      }
    | undefined
    | null;
  const setFeature = useMutation(api.admin.setFeatureEnabled);
  const gateOn = me?.ui?.featuresEnabled?.voiceInput === true;
  const isAdmin = me?.role === "admin";
  return (
    <section className="oc-voice__card">
      <header className="oc-voice__cardhead">
        <span className="oc-voice__instance">{m.voice_dictation_title()}</span>
        <Badge variant={stt ? "secondary" : "outline"}>
          {stt ? m.voice_status_ready() : m.voice_status_unavailable()}
        </Badge>
        <Badge variant={gateOn ? "secondary" : "destructive"}>
          {gateOn ? m.voice_gate_on() : m.voice_gate_off()}
        </Badge>
      </header>
      {isAdmin ? (
        <label className="oc-cdefaults__inline" style={{ cursor: "pointer" }}>
          <Checkbox
            checked={gateOn}
            onCheckedChange={(v) =>
              void setFeature({ key: "voiceInput", enabled: v === true })
            }
            aria-label={m.voice_gate_label()}
          />
          <span className="oc-cdefaults__label">{m.voice_gate_label()}</span>
        </label>
      ) : null}
      <p className="oc-cdefaults__help">{m.voice_dictation_help()}</p>
    </section>
  );
}

export function VoiceTab() {
  const instances = useQuery(api.admin.listInstances, {}) as
    | InstanceRow[]
    | undefined;
  const tts = useMemo(() => ttsSupported(), []);
  const stt = useMemo(() => dictationSupported(), []);
  // Sub-tab = a SEARCH PARAM (navigable, shareable URL), same pattern as the
  // Traces tab's latency/events split.
  const { section } = useSearch({ from: "/settings/voice" });
  const navigate = useNavigate({ from: "/settings/voice" });

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

      <Tabs
        value={section}
        onValueChange={(v) =>
          void navigate({
            search: { section: v as "readaloud" | "dictation" | "talk" },
            replace: true,
          })
        }
      >
        <TabsList className="w-full">
          <TabsTrigger value="readaloud" className="flex-1 gap-1.5">
            <Volume2 size={13} aria-hidden />
            {m.voice_seg_readaloud()}
          </TabsTrigger>
          <TabsTrigger value="dictation" className="flex-1 gap-1.5">
            <Mic size={13} aria-hidden />
            {m.voice_dictation_title()}
          </TabsTrigger>
          <TabsTrigger value="talk" className="flex-1 gap-1.5">
            <AudioLines size={13} aria-hidden />
            {m.voice_talk_title()}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="readaloud">
          {instances === undefined ? (
            <p className="oc-admin__hint">{m.common_loading()}</p>
          ) : instances.length === 0 ? (
            <p className="oc-admin__hint">{m.voice_no_instances()}</p>
          ) : (
            instances.map((inst) => (
              <VoiceInstanceCard key={inst._id} instance={inst} />
            ))
          )}
        </TabsContent>

        <TabsContent value="dictation">
          <DictationCard stt={stt} />
        </TabsContent>

        <TabsContent value="talk">
          <section className="oc-voice__card">
            <header className="oc-voice__cardhead">
              <span className="oc-voice__instance">{m.voice_talk_title()}</span>
            </header>
            <p className="oc-cdefaults__help">{m.voice_talk_help()}</p>
          </section>
          {instances === undefined ? (
            <p className="oc-admin__hint">{m.common_loading()}</p>
          ) : instances.length === 0 ? (
            <p className="oc-admin__hint">{m.voice_no_instances()}</p>
          ) : (
            instances.map((inst) => (
              <TalkInstanceCard key={inst._id} instance={inst} />
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * PER-INSTANCE talk switch — realtime voice is a GATEWAY feature (the gateway
 * owns provider/model/voice defaults and the realtime API key); this flag only
 * decides whether Atrium OFFERS the conversation button on this instance's
 * chats (default OFF). Same write path as the per-instance read-aloud settings.
 */
function TalkInstanceCard({ instance }: { instance: InstanceRow }) {
  const upsert = useMutation(api.admin.upsertInstanceConfig);
  const cfg = instance.config ?? {};
  const enabled = cfg.talkEnabled === true;
  const hermes = instance.kind === "hermes";
  return (
    <section className="oc-voice__card">
      <header className="oc-voice__cardhead">
        <span className="oc-voice__instance">{instance.name}</span>
        <Badge variant="secondary">{hermes ? "Hermes" : "OpenClaw"}</Badge>
      </header>
      {hermes ? (
        // No talk surface on Hermes — say it instead of a dead switch.
        <p className="oc-cdefaults__help">{m.voice_talk_hermes_note()}</p>
      ) : (
        <label className="oc-cdefaults__inline" style={{ cursor: "pointer" }}>
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) => {
              const next: Record<string, unknown> = { ...cfg };
              if (v === true) next.talkEnabled = true;
              else delete next.talkEnabled;
              void upsert({
                instanceId: instance._id as Id<"instances">,
                config: next,
              });
            }}
            aria-label={m.integrations_talk_enable()}
          />
          <span className="oc-cdefaults__label">{m.integrations_talk_enable()}</span>
        </label>
      )}
    </section>
  );
}
