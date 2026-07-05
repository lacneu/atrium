// Dedicated, full-width Settings tab for the per-instance prompt injections. Lives apart
// from the cramped bridge-config DIALOG (the long instruction texts need room), and lists
// instances from the Convex records (api.admin.listInstances) — so an instance can be
// configured BEFORE it is connected / made available to users.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { FieldHelp, FieldLabel } from "./FieldLabel";
import { type Instance } from "./BridgeTab";
import {
  effectiveTemplate,
  fillTemplate,
  PROMPT_INJECTION_KEYS,
  PROMPT_INJECTIONS,
  type PromptInjectionDef,
  type PromptInjectionKey,
} from "../../../convex/lib/promptInjections";
import {
  buildConfigOverride,
  formFromConfig,
  type ConfigForm,
  type InjectionForm,
} from "./bridgeConfigForm";
import "./confTabs.css";

// i18n for each registry injection (paraglide can't index dynamically → a static map).
const INJECTION_I18N: Record<
  PromptInjectionKey,
  { label: () => string; help: () => string }
> = {
  media_delivery: {
    label: m.injection_media_delivery_label,
    help: m.injection_media_delivery_help,
  },
  documentary_fetch: {
    label: m.injection_documentary_fetch_label,
    help: m.injection_documentary_fetch_help,
  },
  inbound_files: {
    label: m.injection_inbound_files_label,
    help: m.injection_inbound_files_help,
  },
  history_summary: {
    label: m.injection_history_summary_label,
    help: m.injection_history_summary_help,
  },
  file_curation: {
    label: m.injection_file_curation_label,
    help: m.injection_file_curation_help,
  },
};

// Example values for the "Preview" — realistic stand-ins for each placeholder so the admin
// sees what the agent actually receives, with their custom wording rendered.
const PLACEHOLDER_EXAMPLES: Record<string, string> = {
  outboundDir: "/home/node/.openclaw/media/outbound",
  references: "- gdrive/1a2b3c4d5e6f7890abcd\n- gdrive/0f9e8d7c6b5a4321dcba",
  files: "- /home/node/.openclaw/media/inbound/rapport.pdf (124800 o, application/pdf)",
  previous_summary: "Projet Alpha : budget 40 000 EUR ; choix du serveur en cours.",
  new_messages: "Utilisateur : Compare OVH et Scaleway.\nAssistant : Comparaison en cours.",
  max_chars: "6000",
  file_name: "MEMORY.md",
  budget_chars: "20000",
  feedback: "Trop de suppressions dans la section des liens, garde-les.",
  content: "# Memory index\n- [Fait 1](fait-1.md) - note du projet",
};

// What each placeholder corresponds to (shown in a per-placeholder help bubble so an admin
// editing a template knows what a variable injects). Falls back to the raw name if unmapped.
const PLACEHOLDER_I18N: Record<string, () => string> = {
  outboundDir: m.placeholder_outboundDir,
  references: m.placeholder_references,
  files: m.placeholder_files,
  previous_summary: m.placeholder_previous_summary,
  new_messages: m.placeholder_new_messages,
  max_chars: m.placeholder_max_chars,
  file_name: m.placeholder_file_name,
  budget_chars: m.placeholder_budget_chars,
  feedback: m.placeholder_feedback,
  content: m.placeholder_content,
};

export function PromptInjectionsTab() {
  const instances = useQuery(api.admin.listInstances, {});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (instances === undefined) {
    return <div className="oc-settings__tab-loading" aria-busy="true" />;
  }
  if (instances.length === 0) {
    return (
      <div className="oc-injtab">
        <p className="oc-admin__hint">{m.injection_tab_no_instances()}</p>
      </div>
    );
  }

  // Select by _id (instance names are NOT unique — a duplicate name must stay reachable).
  const current = instances.find((i) => i._id === selectedId) ?? instances[0];

  return (
    <div className="oc-injtab">
      <div className="oc-injtab__head">
        <FieldLabel
          label={m.injection_section_title()}
          help={m.injection_section_help()}
        />
        <label className="oc-injtab__picker">
          <span>{m.injection_tab_instance()}</span>
          <Select value={current._id} onValueChange={(v) => setSelectedId(v)}>
            <SelectTrigger size="sm" className="min-w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {instances.map((inst) => (
                <SelectItem key={inst._id} value={inst._id}>
                  {inst.displayName ?? inst.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      {/* Keyed by instance id so the editor seeds fresh per instance (no stale form). */}
      <InstanceInjectionsEditor key={current._id} instance={current} />
    </div>
  );
}

function InstanceInjectionsEditor({ instance }: { instance: Instance }) {
  const save = useMutation(api.admin.upsertInstanceConfig);
  const toast = useToast();
  const stored = (instance.config ?? {}) as Partial<ConfigForm>;
  const [form, setForm] = useState<ConfigForm>(() => formFromConfig(stored));
  const [saving, setSaving] = useState(false);

  const rows = form.promptInjections;
  const setRow = (key: string, patch: Partial<InjectionForm>) =>
    setForm({
      ...form,
      promptInjections: { ...rows, [key]: { ...rows[key], ...patch } },
    });

  async function submit() {
    setSaving(true);
    try {
      // buildConfigOverride preserves this instance's TRANSPORT overrides (unchanged in
      // this editor) and persists only the explicit injection overrides — a bare Save
      // never freezes defaults, and editing injections here never wipes the bridge config.
      await save({
        instanceId: instance._id as Id<"instances">,
        config: buildConfigOverride(form, stored),
      });
      // Silent-on-success (app convention); only a FAILURE surfaces a toast.
    } catch (err) {
      toast.error(m.bridge_config_save_failed(), err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="oc-injtab__body">
      {PROMPT_INJECTION_KEYS.map((key) => (
        <InjectionCard
          key={key}
          injKey={key}
          def={PROMPT_INJECTIONS[key]}
          i18n={INJECTION_I18N[key]}
          row={rows[key] ?? { enabled: true, template: PROMPT_INJECTIONS[key].defaultTemplate }}
          onChange={(patch) => setRow(key, patch)}
        />
      ))}
      <div className="oc-injtab__actions">
        <Button size="sm" onClick={() => void submit()} disabled={saving}>
          {m.bridge_config_save()}
        </Button>
      </div>
    </div>
  );
}

function InjectionCard({
  injKey,
  def,
  i18n,
  row,
  onChange,
}: {
  injKey: PromptInjectionKey;
  def: PromptInjectionDef;
  i18n: { label: () => string; help: () => string };
  row: InjectionForm;
  onChange: (patch: Partial<InjectionForm>) => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const isCustom = row.template.trim() !== def.defaultTemplate;
  const disabled = def.togglable && !row.enabled;
  // Fill the placeholders with realistic example values. Preview the template ACTUALLY
  // applied (effectiveTemplate) — when disabled, that's the registry fallback (empty for
  // an add-on, bare references for documentary), so the preview never lies on the disable
  // path.
  const exampleVars = Object.fromEntries(
    def.placeholders.map((p) => [p, PLACEHOLDER_EXAMPLES[p] ?? `{${p}}`]),
  );
  const effTemplate = effectiveTemplate(injKey, row);
  const preview = effTemplate ? fillTemplate(effTemplate, exampleVars) : "";

  return (
    <section className="oc-injcard">
      <div className="oc-injcard__head">
        {def.togglable ? (
          <label className="oc-field--row">
            <Checkbox
              checked={row.enabled}
              onCheckedChange={(v) => onChange({ enabled: v === true })}
            />
            <FieldLabel label={i18n.label()} help={i18n.help()} />
          </label>
        ) : (
          <FieldLabel label={i18n.label()} help={i18n.help()} />
        )}
        {isCustom && (
          <span className="oc-injection__badge">
            {m.injection_customized_badge()}
          </span>
        )}
      </div>
      <textarea
        className="oc-injcard__text"
        value={row.template}
        disabled={disabled}
        rows={8}
        spellCheck={false}
        onChange={(e) => onChange({ template: e.target.value })}
      />
      <div className="oc-injection__foot">
        <div className="oc-injcard__phs">
          <span className="oc-injection__ph">{m.injection_placeholders()}</span>
          {def.placeholders.map((p) => (
            <span className="oc-injcard__ph-chip" key={p}>
              <code>{`{${p}}`}</code>
              <FieldHelp text={(PLACEHOLDER_I18N[p] ?? (() => p))()} />
            </span>
          ))}
        </div>
        <div className="oc-injcard__btns">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview((s) => !s)}
          >
            {showPreview ? m.injection_preview_hide() : m.injection_preview()}
          </Button>
          {isCustom && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ template: def.defaultTemplate })}
            >
              {m.injection_reset()}
            </Button>
          )}
        </div>
      </div>
      {showPreview && (
        <div className="oc-injcard__preview">
          {preview ? (
            <>
              <pre className="oc-injcard__previewtext">{preview}</pre>
              <span className="oc-injection__ph">
                {m.injection_preview_note()}
              </span>
            </>
          ) : (
            <span className="oc-injection__ph">
              {m.injection_preview_disabled_empty()}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
