import { useEffect, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { formatDateTime } from "@/lib/format";
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

// Settings › Integrations. Configures NON-SECRET integration knobs (host /
// baseUrl / workspace / enabled + the tts/talk settings). API KEYS are NEVER
// edited here — they live in the deployment env; this UI only shows a per-vendor
// "configured" indicator derived server-side from env presence. Resolution
// precedence (server): Convex value -> env -> default, so an empty field falls
// back to env (never clobbers a deployment that sets the env var).
//
// Status honesty: Langfuse/Opik have a REAL consumer (the trace shipper) → live.
// TTS/Talk are consumed by the bridge worker (not built yet) → stored + labeled
// as applied by the bridge (upcoming).

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

      {/* Talk (realtime voice) is configured in Settings > Agents > Voice >
          Talk — the voice features' home (user request 2026-07-16); this tab
          stays trace-vendors only. */}
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
