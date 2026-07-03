import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { AlertTriangle } from "lucide-react";
import { api } from "../convexApi";
import type { Id } from "../../../convex/_generated/dataModel";
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KnobSegmented } from "../KnobRow";
import { capitalize } from "../sessionKnobs";
import {
  THINKING_DEFAULT_OPTIONS,
  parseChatDefaults,
  type ChatDefaultsView,
} from "./chatDefaultsView";
import { instanceTabGate, type InstanceCompat } from "../capabilities";
import { unsupportedInstanceLabel } from "./compatView";
import "./confTabs.css";

// Settings > chat defaults tab (CONF-4d, deflated per amendment A7): a HARD-CODED
// two-field form — default thinking level (segmented 6, the bench-verified
// enum) + default speed (fastMode on/off) — over api.agentFiles.get/
// setChatDefaults (admin-only server-side). Writing changes the gateway's
// GLOBAL openclaw.json, hence the explicit confirm before every save. Per-chat
// and per-agent overrides keep precedence over these defaults.

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "done"; current: ChatDefaultsView };

/** Atrium-side per-instance chat default: the summarize trigger threshold.
 *  Separate card below the GATEWAY defaults (this one is stored in the instance
 *  config, not on the gateway — it works even when the gateway is unreachable). */
function SummarizeThresholdCard({
  instance,
}: {
  instance: { _id: string; name: string; config?: Record<string, unknown> };
}) {
  const upsert = useMutation(api.admin.upsertInstanceConfig);
  const stored =
    typeof instance.config?.summarizeThresholdChars === "number"
      ? (instance.config.summarizeThresholdChars as number)
      : null;
  const [value, setValue] = useState<string>(stored !== null ? String(stored) : "");
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">(
    "idle",
  );
  useEffect(() => {
    setValue(stored !== null ? String(stored) : "");
    setState("idle");
  }, [instance._id, stored]);
  // Validate the WHOLE string (parseInt would silently truncate "1500.5" to
  // 1500 — the admin would save a value different from the one typed).
  const trimmed = value.trim();
  const parsed = trimmed === "" ? null : /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  const valid =
    parsed === null ||
    (Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 200_000);
  const dirty = (parsed ?? null) !== stored;
  async function save(): Promise<void> {
    setState("saving");
    try {
      const next: Record<string, unknown> = { ...(instance.config ?? {}) };
      if (parsed === null) delete next.summarizeThresholdChars;
      else next.summarizeThresholdChars = parsed;
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
    <div className="oc-cdefaults__row">
      <span className="oc-cdefaults__label">
        {m.cdefaults_summarize_threshold_label()}
      </span>
      <div className="oc-cdefaults__inline">
        <Input
          type="number"
          min={1000}
          max={200000}
          step={1000}
          placeholder="8000"
          value={value}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
          className="oc-cdefaults__number"
          aria-invalid={!valid}
        />
        <Button size="sm" disabled={!dirty || !valid || state === "saving"} onClick={() => void save()}>
          {state === "saving" ? m.conf_applying() : m.cdefaults_save()}
        </Button>
      </div>
      {!valid ? (
        <p className="oc-cdefaults__error" role="alert">
          {m.cdefaults_summarize_threshold_invalid()}
        </p>
      ) : null}
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
      <p className="oc-cdefaults__help">
        {m.cdefaults_summarize_threshold_help()}
      </p>
    </div>
  );
}

export function ChatDefaultsTab() {
  const getDefaults = useAction(api.agentFiles.getChatDefaults);
  const setDefaults = useAction(api.agentFiles.setChatDefaults);
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ status: "loading" });
  // The admin's pending selection (null = untouched / unknown from the gateway).
  const [draft, setDraft] = useState<ChatDefaultsView>({
    thinkingDefault: null,
    fastModeDefault: null,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Chat defaults are PER-GATEWAY (one bridge, N instances): pick which instance to
  // read/write. With several configured, the server fails closed without an explicit
  // instanceName (never silently edits the wrong gateway) — so we always pass one.
  const instances = useQuery(api.admin.listInstances, {}) as
    | Array<{ name: string }>
    | undefined;
  const [instanceName, setInstanceName] = useState<string | null>(null);
  useEffect(() => {
    if (!instances || instances.length === 0) return;
    if (!instanceName || !instances.some((i) => i.name === instanceName)) {
      setInstanceName(instances[0].name);
    }
  }, [instances, instanceName]);
  const multiInstance = (instances?.length ?? 0) > 1;
  // Loaded but EMPTY (fresh deployment, or all instances deleted): there is nothing to
  // configure — show an actionable hint, never an indefinite spinner (instanceName stays
  // null so the gate would otherwise hang on "loading" forever).
  const noInstances = instances !== undefined && instances.length === 0;

  // Capability gate scoped to the SELECTED instance (NOT the global snapshot): a
  // compatible chosen gateway must not be blocked just because ANOTHER configured
  // instance is absent/incompatible. Loading until the instance is resolved.
  const compatForInstance = useQuery(
    api.compat.forInstance,
    instanceName ? { instanceName } : "skip",
  ) as InstanceCompat | undefined;
  const gate = instanceName
    ? instanceTabGate(compatForInstance, "configDefaults")
    : "loading";
  const gateBlocked = gate === "loading" ? null : gate.blocked;
  // The explicit claim to send: required (and selectable) when several instances exist;
  // omitted for the sole-instance case (the server resolves the only gateway).
  const claimArg = useMemo(
    () => (multiInstance && instanceName ? { instanceName } : {}),
    [multiInstance, instanceName],
  );

  // Guard against a stale-load race: switching instance while a previous getDefaults is
  // in flight must NOT let the slow OLD-gateway response land under the NEW instanceName
  // (it would show — and potentially save — the wrong gateway's defaults). Only the
  // latest load applies its result.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setState({ status: "loading" });
    try {
      const current = parseChatDefaults(await getDefaults(claimArg));
      if (loadSeq.current !== seq) return; // superseded by a newer instance selection
      setState({ status: "done", current });
      setDraft(current);
    } catch {
      if (loadSeq.current !== seq) return;
      setState({ status: "error" });
    }
  }, [getDefaults, claimArg]);
  useEffect(() => {
    // No bridge round-trip while the compat verdict is pending or negative, or before
    // the instance to target is resolved (multi-instance).
    if (gateBlocked !== false) return;
    if (multiInstance && !instanceName) return;
    void load();
  }, [load, gateBlocked, multiInstance, instanceName]);

  const current = state.status === "done" ? state.current : null;
  const thinkingChanged =
    current !== null &&
    draft.thinkingDefault !== null &&
    draft.thinkingDefault !== current.thinkingDefault;
  const speedChanged =
    current !== null &&
    draft.fastModeDefault !== null &&
    draft.fastModeDefault !== current.fastModeDefault;
  const dirty = thinkingChanged || speedChanged;

  async function save() {
    setSaving(true);
    try {
      // Send ONLY the changed fields — an untouched knob must not be rewritten. The
      // explicit instance claim targets THIS gateway (never a silent first).
      await setDefaults({
        ...claimArg,
        ...(thinkingChanged
          ? { thinkingDefault: draft.thinkingDefault as string }
          : {}),
        ...(speedChanged
          ? { fastModeDefault: draft.fastModeDefault as boolean }
          : {}),
      });
      toast.success(m.cdefaults_saved());
      await load(); // re-read the gateway truth
    } catch (err) {
      toast.error(m.cdefaults_save_error(), err);
    } finally {
      setSaving(false);
    }
  }

  const thinkingOptions = useMemo(
    () =>
      THINKING_DEFAULT_OPTIONS.map((id) => ({ id, label: capitalize(id) })),
    [],
  );
  const speedOptions = useMemo(
    () => [
      { id: "fast", label: m.conf_speed_fast() },
      { id: "standard", label: m.conf_speed_standard() },
    ],
    [],
  );

  return (
    <div className="oc-cdefaults">
      <p className="oc-admin__hint">{m.cdefaults_desc()}</p>

      {multiInstance && instanceName ? (
        // Several gateways: defaults are PER-INSTANCE — choose which one explicitly
        // (the server fails closed without a claim, never edits the wrong gateway).
        <div className="oc-cdefaults__row">
          <span className="oc-cdefaults__label">{m.afiles_instance_label()}</span>
          <Select
            value={instanceName}
            onValueChange={(v) => setInstanceName(v)}
            disabled={saving}
          >
            <SelectTrigger size="sm" aria-label={m.afiles_instance_label()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(instances ?? []).map((i) => (
                <SelectItem key={i.name} value={i.name}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {noInstances ? (
        <p className="oc-admin__hint" role="status">
          {m.bridge_config_no_instances()}
        </p>
      ) : gate === "loading" ? (
        <p className="oc-admin__hint">{m.common_loading()}</p>
      ) : gate.blocked ? (
        // Whole-tab gate: disabled-and-EXPLAINED — the admin must understand
        // why the global-defaults form is unavailable on this deployment.
        <p className="oc-compat__blocked" role="status">
          <AlertTriangle size={14} aria-hidden />{" "}
          {unsupportedInstanceLabel(gate.gatewayVersion)}
        </p>
      ) : state.status === "loading" ? (
        <p className="oc-admin__hint">{m.common_loading()}</p>
      ) : state.status === "error" ? (
        <p className="oc-cdefaults__error" role="alert">
          {m.cdefaults_error_bridge()}{" "}
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {m.conf_retry()}
          </Button>
        </p>
      ) : (
        <>
          <div className="oc-cdefaults__row">
            <span className="oc-cdefaults__label">
              {m.cdefaults_thinking_label()}
            </span>
            <KnobSegmented
              options={thinkingOptions}
              value={draft.thinkingDefault}
              onChange={(id) => setDraft({ ...draft, thinkingDefault: id })}
              disabled={saving}
            />
            <p className="oc-cdefaults__help">{m.cdefaults_thinking_help()}</p>
          </div>
          <div className="oc-cdefaults__row">
            <span className="oc-cdefaults__label">
              {m.cdefaults_speed_label()}
            </span>
            <KnobSegmented
              options={speedOptions}
              value={
                draft.fastModeDefault === null
                  ? null
                  : draft.fastModeDefault
                    ? "fast"
                    : "standard"
              }
              onChange={(id) =>
                setDraft({ ...draft, fastModeDefault: id === "fast" })
              }
              disabled={saving}
            />
            <p className="oc-cdefaults__help">{m.cdefaults_speed_help()}</p>
          </div>
          <div className="oc-cdefaults__actions">
            <Button
              size="sm"
              disabled={!dirty || saving}
              onClick={() => setConfirmOpen(true)}
            >
              {saving ? m.conf_applying() : m.cdefaults_save()}
            </Button>
          </div>
          <p className="oc-cdefaults__note">{m.cdefaults_note()}</p>
        </>
      )}

      {(() => {
        const inst = instances?.find((i) => i.name === (instanceName ?? instances[0]?.name));
        return inst ? (
          <SummarizeThresholdCard
            instance={inst as unknown as {
              _id: string;
              name: string;
              config?: Record<string, unknown>;
            }}
          />
        ) : null;
      })()}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.cdefaults_confirm_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.cdefaults_confirm_desc()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.chat_cancel()}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void save()}>
              {m.cdefaults_confirm_cta()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
