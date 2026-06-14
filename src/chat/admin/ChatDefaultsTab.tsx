import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { AlertTriangle } from "lucide-react";
import { api } from "../convexApi";
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
import { KnobSegmented } from "../KnobRow";
import { capitalize } from "../sessionKnobs";
import {
  THINKING_DEFAULT_OPTIONS,
  parseChatDefaults,
  type ChatDefaultsView,
} from "./chatDefaultsView";
import { snapshotTabGate } from "../capabilities";
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

  // Capability gate (VCOMPAT-C): the tab is admin-only, so reading the full
  // compat snapshot (bridge.read via the admin wildcard) is always allowed.
  // The write targets the bridge's DEFAULT-instance resolution, hence the
  // snapshot-level gate (see snapshotTabGate).
  const snapshot = useQuery(api.compat.getBridgeCompat, {});
  const gate = snapshotTabGate(snapshot, "configDefaults");
  const gateBlocked = gate === "loading" ? null : gate.blocked;

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const current = parseChatDefaults(await getDefaults({}));
      setState({ status: "done", current });
      setDraft(current);
    } catch {
      setState({ status: "error" });
    }
  }, [getDefaults]);
  useEffect(() => {
    // No bridge round-trip while the compat verdict is pending or negative.
    if (gateBlocked !== false) return;
    void load();
  }, [load, gateBlocked]);

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
      // Send ONLY the changed fields — an untouched knob must not be rewritten.
      await setDefaults({
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

      {gate === "loading" ? (
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
