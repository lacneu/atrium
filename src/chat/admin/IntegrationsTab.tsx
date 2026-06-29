import { useEffect, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { m } from "@/paraglide/messages.js";
import { api } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Settings › Intégrations. Configures NON-SECRET integration knobs (host /
// baseUrl / workspace / enabled + the tts/talk settings). API KEYS are NEVER
// edited here — they live in the deployment env; this UI only shows a per-vendor
// "configured" indicator derived server-side from env presence. Resolution
// precedence (server): Convex value -> env -> default, so an empty field falls
// back to env (never clobbers a deployment that sets the env var).
//
// Status honesty: Langfuse/Opik have a REAL consumer (the trace shipper) → live.
// TTS/Talk are consumed by the bridge worker (not built yet) → stored + labeled
// "appliqué par le bridge (à venir)".

type VendorKnobs = {
  host?: string;
  baseUrl?: string;
  workspace?: string;
  enabled?: boolean;
};
type VoiceKnobs = Record<string, string | number | boolean | undefined>;
type OtlpKnobs = { endpoint?: string; enabled?: boolean };

type Status = {
  langfuse: { configured: boolean; enabled: boolean; effectiveHost: string };
  opik: {
    configured: boolean;
    enabled: boolean;
    effectiveBaseUrl: string;
    effectiveWorkspace: string;
  };
  otlp: {
    configured: boolean;
    enabled: boolean;
    effectiveEndpoint: string;
    headersSet: boolean;
  };
  config: {
    langfuse: VendorKnobs;
    opik: VendorKnobs;
    otlp: OtlpKnobs;
    tts: VoiceKnobs;
    talk: VoiceKnobs;
  };
  secrets: { openai: boolean };
  cursors: Array<{
    vendor: string;
    lastAt: number;
    failureCount: number;
    lastError: string | null;
    lastErrorStatus: number | null;
  }>;
};

export function IntegrationsTab() {
  const status = useQuery(api.integrations.status.status, {}) as
    | Status
    | undefined;
  const setCfg = useMutation(api.admin.setIntegrationConfig);

  // Local editable draft, seeded once when the status first loads. The admin is
  // the only editor, so we don't fight reactive updates after seeding.
  const [draft, setDraft] = useState<Status["config"] | null>(null);
  useEffect(() => {
    if (status && draft === null) setDraft(status.config);
  }, [status, draft]);

  if (!status || !draft) {
    return <p className="oc-admin__hint">{m.integrations_loading()}</p>;
  }

  const d = draft;
  const setField = (
    section: keyof Status["config"],
    key: string,
    value: string | number | boolean | undefined,
  ) => setDraft({ ...d, [section]: { ...d[section], [key]: value } });

  // Commit one section to Convex (called on blur for text, immediately for
  // selects/checkboxes). Typed against the BACKEND validator (not the loose
  // frontend VoiceKnobs), so a field name that drifts from
  // convex/admin.setIntegrationConfig is a tsc error — not a silent runtime
  // validator rejection (the `as never` trap the reviewer flagged).
  type SetArgs = NonNullable<Parameters<typeof setCfg>[0]>;
  const commit = <K extends keyof SetArgs>(
    section: K,
    patch: NonNullable<SetArgs[K]>,
  ) => void setCfg({ [section]: patch } as SetArgs);

  return (
    <>
      <p className="oc-admin__hint">
        {m.integrations_intro_before()} <strong>{m.integrations_intro_no_api_key()}</strong>{" "}
        {m.integrations_intro_after()}
      </p>

      {/* ── Langfuse (trace shipping — LIVE) ─────────────────────────── */}
      <Section
        title="Langfuse"
        status={
          status.langfuse.configured ? (
            status.langfuse.enabled ? (
              <Badge variant="secondary">{m.integrations_status_active()}</Badge>
            ) : (
              <Badge variant="outline">{m.integrations_status_paused()}</Badge>
            )
          ) : (
            <Badge variant="outline">{m.integrations_status_key_missing()}</Badge>
          )
        }
        note={m.integrations_langfuse_note()}
      >
        <Field label={m.integrations_field_host()}>
          <Input
            value={d.langfuse.host ?? ""}
            placeholder={status.langfuse.effectiveHost}
            onChange={(e) => setField("langfuse", "host", e.target.value)}
            onBlur={() => commit("langfuse", { host: d.langfuse.host ?? "" })}
          />
        </Field>
        <ToggleRow
          label={m.integrations_toggle_traces_enabled()}
          checked={d.langfuse.enabled ?? true}
          onChange={(v) => {
            setField("langfuse", "enabled", v);
            commit("langfuse", { enabled: v });
          }}
        />
      </Section>

      {/* ── Opik (trace shipping — LIVE) ─────────────────────────────── */}
      <Section
        title="Opik"
        status={
          status.opik.configured ? (
            status.opik.enabled ? (
              <Badge variant="secondary">{m.integrations_status_active()}</Badge>
            ) : (
              <Badge variant="outline">{m.integrations_status_paused()}</Badge>
            )
          ) : (
            <Badge variant="outline">{m.integrations_status_key_missing()}</Badge>
          )
        }
        note={m.integrations_opik_note()}
      >
        <Field label={m.integrations_field_base_url()}>
          <Input
            value={d.opik.baseUrl ?? ""}
            placeholder={status.opik.effectiveBaseUrl}
            onChange={(e) => setField("opik", "baseUrl", e.target.value)}
            onBlur={() => commit("opik", { baseUrl: d.opik.baseUrl ?? "" })}
          />
        </Field>
        <Field label={m.integrations_field_workspace()}>
          <Input
            value={d.opik.workspace ?? ""}
            placeholder={status.opik.effectiveWorkspace || m.integrations_opik_workspace_placeholder()}
            onChange={(e) => setField("opik", "workspace", e.target.value)}
            onBlur={() =>
              commit("opik", { workspace: d.opik.workspace ?? "" })
            }
          />
        </Field>
        <ToggleRow
          label={m.integrations_toggle_traces_enabled()}
          checked={d.opik.enabled ?? true}
          onChange={(v) => {
            setField("opik", "enabled", v);
            commit("opik", { enabled: v });
          }}
        />
      </Section>

      {/* ── OTLP / OpenTelemetry (generic trace exporter — LIVE) ─────── */}
      <Section
        title="OpenTelemetry (OTLP)"
        status={
          status.otlp.configured ? (
            status.otlp.enabled ? (
              <Badge variant="secondary">{m.integrations_status_active()}</Badge>
            ) : (
              <Badge variant="outline">{m.integrations_status_paused()}</Badge>
            )
          ) : (
            <Badge variant="outline">
              {m.integrations_status_endpoint_missing()}
            </Badge>
          )
        }
        note={m.integrations_otlp_note()}
      >
        <Field label={m.integrations_field_otlp_endpoint()}>
          <Input
            value={d.otlp.endpoint ?? ""}
            placeholder={
              status.otlp.effectiveEndpoint ||
              "https://otlp.example.com/v1/traces"
            }
            onChange={(e) => setField("otlp", "endpoint", e.target.value)}
            onBlur={() => commit("otlp", { endpoint: d.otlp.endpoint ?? "" })}
          />
        </Field>
        <OtlpHeadersField headersSet={status.otlp.headersSet} />
        <ToggleRow
          label={m.integrations_toggle_traces_enabled()}
          checked={d.otlp.enabled ?? true}
          onChange={(v) => {
            setField("otlp", "enabled", v);
            commit("otlp", { enabled: v });
          }}
        />
      </Section>

      {/* ── TTS (consumer = bridge, pending) ─────────────────────────── */}
      <Section
        title={m.integrations_tts_title()}
        status={<Badge variant="outline">{m.integrations_status_bridge_pending()}</Badge>}
        note={m.integrations_tts_note()}
      >
        <Field label={m.integrations_field_auto_mode()}>
          <SelectField
            value={(d.tts.auto as string) ?? "off"}
            options={[
              ["off", m.integrations_tts_auto_off()],
              ["always", m.integrations_tts_auto_always()],
              ["inbound", m.integrations_tts_auto_inbound()],
              ["tagged", m.integrations_tts_auto_tagged()],
            ]}
            onChange={(v) => {
              setField("tts", "auto", v);
              commit("tts", { auto: v });
            }}
          />
        </Field>
        <Field label={m.integrations_field_provider()}>
          <SelectField
            value={(d.tts.provider as string) ?? "openai"}
            options={[
              ["openai", "OpenAI"],
              ["elevenlabs", "ElevenLabs"],
              ["microsoft", m.integrations_tts_provider_microsoft()],
              ["azure", "Azure Speech"],
              ["google", "Google Gemini"],
            ]}
            onChange={(v) => {
              setField("tts", "provider", v);
              commit("tts", { provider: v });
            }}
          />
        </Field>
        <Field label={m.integrations_field_model()}>
          <Input
            value={(d.tts.model as string) ?? ""}
            placeholder="eleven_multilingual_v2"
            onChange={(e) => setField("tts", "model", e.target.value)}
            onBlur={() => commit("tts", { model: (d.tts.model as string) ?? "" })}
          />
        </Field>
        <Field label={m.integrations_field_voice()}>
          <Input
            value={(d.tts.voice as string) ?? ""}
            placeholder={m.integrations_tts_voice_placeholder()}
            onChange={(e) => setField("tts", "voice", e.target.value)}
            onBlur={() => commit("tts", { voice: (d.tts.voice as string) ?? "" })}
          />
        </Field>
      </Section>

      {/* ── Talk / STS (consumer = bridge, pending) ──────────────────── */}
      <Section
        title={m.integrations_talk_title()}
        status={<Badge variant="outline">{m.integrations_status_bridge_pending()}</Badge>}
        note={
          status.secrets.openai
            ? m.integrations_talk_note_key_present()
            : m.integrations_talk_note_key_absent()
        }
      >
        <ToggleRow
          label={m.integrations_talk_enable()}
          checked={(d.talk.enabled as boolean) ?? false}
          onChange={(v) => {
            setField("talk", "enabled", v);
            commit("talk", { enabled: v });
          }}
        />
        <Field label={m.integrations_field_realtime_provider()}>
          <SelectField
            value={(d.talk.realtimeProvider as string) ?? "openai"}
            options={[
              ["openai", "OpenAI (gpt-realtime)"],
              ["google", "Google"],
            ]}
            onChange={(v) => {
              setField("talk", "realtimeProvider", v);
              commit("talk", { realtimeProvider: v });
            }}
          />
        </Field>
        <Field label={m.integrations_field_realtime_model()}>
          <Input
            value={(d.talk.realtimeModel as string) ?? ""}
            placeholder="gpt-realtime-2"
            onChange={(e) => setField("talk", "realtimeModel", e.target.value)}
            onBlur={() =>
              commit("talk", { realtimeModel: (d.talk.realtimeModel as string) ?? "" })
            }
          />
        </Field>
        <Field label={m.integrations_field_voice()}>
          <Input
            value={(d.talk.voice as string) ?? ""}
            placeholder="cedar / marin"
            onChange={(e) => setField("talk", "voice", e.target.value)}
            onBlur={() => commit("talk", { voice: (d.talk.voice as string) ?? "" })}
          />
        </Field>
        <Field label={m.integrations_field_transport()}>
          <SelectField
            value={(d.talk.transport as string) ?? "webrtc"}
            options={[
              ["webrtc", m.integrations_talk_transport_webrtc()],
              ["provider-websocket", "Provider WebSocket"],
              ["gateway-relay", "Gateway relay"],
            ]}
            onChange={(v) => {
              setField("talk", "transport", v);
              commit("talk", { transport: v });
            }}
          />
        </Field>
        <Field label={m.integrations_field_locale()}>
          <Input
            value={(d.talk.speechLocale as string) ?? ""}
            placeholder="fr-CA"
            onChange={(e) => setField("talk", "speechLocale", e.target.value)}
            onBlur={() =>
              commit("talk", { speechLocale: (d.talk.speechLocale as string) ?? "" })
            }
          />
        </Field>
        <ToggleRow
          label={m.integrations_talk_interrupt()}
          checked={(d.talk.interruptOnSpeech as boolean) ?? true}
          onChange={(v) => {
            setField("talk", "interruptOnSpeech", v);
            commit("talk", { interruptOnSpeech: v });
          }}
        />
      </Section>

      {/* ── Voice wake (feasibility note — not buildable in browser) ──── */}
      <section className="oc-int__section">
        <div className="oc-int__section-head">
          <h3 className="oc-uipa__h">{m.integrations_voicewake_title()}</h3>
          <Badge variant="outline">{m.integrations_voicewake_badge()}</Badge>
        </div>
        <p className="oc-uipa__note">
          {m.integrations_voicewake_note()}
          <code> voicewake.get/set</code>.
        </p>
      </section>

      <DataTableShell
        title={m.integrations_cursors_title()}
        rows={status.cursors.map((c) => ({ ...c, _id: c.vendor }))}
        emptyHint={m.integrations_cursors_empty()}
        columns={[
          {
            header: m.integrations_col_vendor(),
            cell: (c) => <Badge variant="secondary">{c.vendor}</Badge>,
            sort: (c) => c.vendor,
          },
          {
            header: m.integrations_col_last_send(),
            cell: (c) =>
              c.lastAt > 0 ? new Date(c.lastAt).toLocaleString("fr-FR") : "—",
            sort: (c) => (c.lastAt > 0 ? c.lastAt : null),
          },
          {
            header: m.integrations_col_consecutive_failures(),
            cell: (c) => String(c.failureCount),
            sort: (c) => c.failureCount,
          },
          {
            header: m.integrations_col_last_http_status(),
            cell: (c) => c.lastErrorStatus ?? "—",
            sort: (c) => c.lastErrorStatus ?? null,
          },
          {
            header: m.integrations_col_last_error(),
            cell: (c) => c.lastError ?? "—",
            sort: (c) => c.lastError ?? null,
          },
        ]}
      />
    </>
  );
}

function Section({
  title,
  status,
  note,
  children,
}: {
  title: string;
  status: React.ReactNode;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="oc-int__section">
      <div className="oc-int__section-head">
        <h3 className="oc-uipa__h">{title}</h3>
        {status}
      </div>
      {note ? <p className="oc-uipa__note">{note}</p> : null}
      <div className="oc-int__fields">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="oc-int__field">
      <span className="oc-int__field-label">{label}</span>
      {children}
    </label>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="oc-int__toggle">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <span>{label}</span>
    </label>
  );
}

function SelectField({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// The OTLP auth headers — a write-only SECRET. Unlike the other fields it is NOT
// part of the setIntegrationConfig draft: it is encrypted via the setOtlpHeaders
// ACTION (which validates the JSON shape + returns a clear error on bad input),
// and the stored value NEVER comes back (status exposes only `headersSet`). On
// save the input clears (write-only). A clear button removes the stored headers.
function OtlpHeadersField({ headersSet }: { headersSet: boolean }) {
  const setHeaders = useAction(api.integrations.otlpSecret.setOtlpHeaders);
  const clearHeaders = useMutation(api.integrations.otlpSecret.clearOtlpHeaders);
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await setHeaders({ headersJson: val });
      setVal(""); // write-only: never echo the secret back
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label={m.integrations_field_otlp_headers()}>
      <Input
        value={val}
        placeholder={
          headersSet
            ? m.integrations_otlp_headers_set()
            : m.integrations_otlp_headers_placeholder()
        }
        onChange={(e) => setVal(e.target.value)}
      />
      <div className="oc-int__otlp-headers-actions">
        <Button
          size="sm"
          disabled={busy || val.trim().length === 0}
          onClick={() => void save()}
        >
          {m.integrations_otlp_headers_save()}
        </Button>
        {headersSet ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void clearHeaders({})}
          >
            {m.integrations_otlp_headers_clear()}
          </Button>
        ) : null}
      </div>
      {err ? <p className="oc-int__otlp-headers-error">{err}</p> : null}
      <p className="oc-uipa__note">{m.integrations_otlp_headers_hint()}</p>
    </Field>
  );
}
