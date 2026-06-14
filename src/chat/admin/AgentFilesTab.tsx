import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { AlertTriangle } from "lucide-react";
import { api } from "../convexApi";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import {
  BOOTSTRAP_MAX_CHARS,
  GAUGE_WARN_PCT,
  TOTAL_BUDGET_CHARS,
  budgetPct,
  computeMiniDiff,
  formatKb,
  gaugePct,
  isConflictError,
  totalSize,
} from "./agentFilesView";
import { instanceTabGate } from "../capabilities";
import { unsupportedInstanceLabel } from "./compatView";
import "./confTabs.css";

// Settings › Fichiers d'agent (CONF-4c). Read (+ admin write) of an agent's
// workspace files over the bridge. Visible with `agents.files.read` OR admin;
// the SERVER filters what a non-admin can list/read (RULES_FILES allowlist, A3)
// — this UI just renders whatever api.agentFiles returns. Writes are admin-only
// with a confirm-with-mini-diff (A4) and compare-and-set (409 → reload).
//
// Agent selector (A10): the EXISTING agent registry, never an invented one —
// admins browse instances (api.admin.listInstances + agents.listAgentsForInstance,
// the InstancesTab queries); a granted non-admin picks among their OWN agents
// (api.agents.listMyAgents), since the per-instance registry query is admin-gated.

type AgentOption = {
  instanceName: string;
  agentId: string;
  label: string;
};

type FileRow = {
  name: string;
  size?: number;
  missing?: boolean;
  updatedAtMs?: number;
};

const keyOf = (o: { instanceName: string; agentId: string }) =>
  `${o.instanceName}::${o.agentId}`;

export function AgentFilesTab() {
  const me = useQuery(api.me.getMe) as
    | { role?: string; permissions?: string[] }
    | undefined;
  const isAdmin = me?.role === "admin";
  // Capability gate (VCOMPAT-C). api.compat.forInstance requires bridge.read;
  // a non-admin granted agents.files.read but NOT bridge.read cannot read the
  // snapshot — for them the tab stays UNGATED (the server still fails closed
  // on an unsupported gateway) rather than subscribing to a query that throws.
  const canReadCompat = (me?.permissions ?? []).includes("bridge.read");

  // Admin path: instance picker + the instance's DISCOVERED agents.
  const instances = useQuery(
    api.admin.listInstances,
    me !== undefined && isAdmin ? {} : "skip",
  ) as Array<{ name: string }> | undefined;
  const [instanceName, setInstanceName] = useState<string | null>(null);
  useEffect(() => {
    if (!isAdmin || !instances || instances.length === 0) return;
    if (!instanceName || !instances.some((i) => i.name === instanceName)) {
      setInstanceName(instances[0].name);
    }
  }, [isAdmin, instances, instanceName]);
  const instAgents = useQuery(
    api.agents.listAgentsForInstance,
    isAdmin && instanceName ? { instanceName } : "skip",
  );

  // Non-admin path: the user's own agents (registry-backed union).
  const myAgents = useQuery(
    api.agents.listMyAgents,
    me !== undefined && !isAdmin ? {} : "skip",
  ) as
    | Array<{
        instanceName: string;
        agentId: string;
        displayName: string | null;
        emoji: string | null;
      }>
    | undefined;

  const options: AgentOption[] | undefined = useMemo(() => {
    if (me === undefined) return undefined;
    if (isAdmin) {
      if (instanceName === null || instAgents === undefined) {
        return instances !== undefined && instances.length === 0 ? [] : undefined;
      }
      return instAgents.agents.map((a) => ({
        instanceName,
        agentId: a.agentId,
        label: `${a.emoji ? `${a.emoji} ` : ""}${a.displayName ?? a.agentId}`,
      }));
    }
    if (myAgents === undefined) return undefined;
    return myAgents.map((a) => ({
      instanceName: a.instanceName,
      agentId: a.agentId,
      label: `${a.emoji ? `${a.emoji} ` : ""}${a.displayName ?? a.agentId}`,
    }));
  }, [me, isAdmin, instanceName, instAgents, instances, myAgents]);

  const [agentKey, setAgentKey] = useState<string | null>(null);
  useEffect(() => {
    if (!options || options.length === 0) return;
    if (!agentKey || !options.some((o) => keyOf(o) === agentKey)) {
      setAgentKey(keyOf(options[0]));
    }
  }, [options, agentKey]);
  const selected = options?.find((o) => keyOf(o) === agentKey) ?? null;

  // File listing — an ACTION (bridge round-trip), not a reactive query: explicit
  // load on agent change + manual retry/refresh.
  const listFiles = useAction(api.agentFiles.listAgentFiles);
  const [listing, setListing] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error" }
    | { status: "done"; files: FileRow[] }
  >({ status: "idle" });
  // PRIMITIVE deps (not the `selected` object): the options array is rebuilt on
  // unrelated query updates, which would re-trigger the bridge round-trip.
  const selInstance = selected?.instanceName ?? null;
  const selAgent = selected?.agentId ?? null;
  // Compat verdict for the SELECTED instance (skip while nothing is selected
  // or when the user cannot read the snapshot → gate null = ungated).
  const compatRes = useQuery(
    api.compat.forInstance,
    canReadCompat && selInstance !== null
      ? { instanceName: selInstance }
      : "skip",
  );
  const gate =
    canReadCompat && selInstance !== null
      ? instanceTabGate(compatRes, "agentFiles")
      : null;
  // null = verdict unknown (compat loading), true/false = blocked/allowed.
  const gateBlocked =
    gate === null ? false : gate === "loading" ? null : gate.blocked;
  const loadFiles = useCallback(async () => {
    if (selInstance === null || selAgent === null) return;
    setListing({ status: "loading" });
    try {
      const res = await listFiles({
        instanceName: selInstance,
        agentId: selAgent,
      });
      setListing({ status: "done", files: res.files });
    } catch {
      setListing({ status: "error" });
    }
  }, [listFiles, selInstance, selAgent]);
  useEffect(() => {
    // No bridge round-trip while the compat verdict is pending or negative.
    if (gateBlocked !== false) return;
    void loadFiles();
  }, [loadFiles, gateBlocked]);

  // The file open in the editor dialog (null = closed).
  const [editing, setEditing] = useState<FileRow | null>(null);

  const locale = getLocale();
  const numFmt = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    [locale],
  );

  if (me === undefined || options === undefined) {
    return <p className="oc-admin__hint">{m.common_loading()}</p>;
  }

  return (
    <div className="oc-afiles">
      <p className="oc-admin__hint">{m.afiles_desc()}</p>

      <div className="oc-afiles__picker">
        {isAdmin && (instances?.length ?? 0) > 1 ? (
          <Select
            value={instanceName ?? ""}
            onValueChange={(v) => setInstanceName(v)}
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
        ) : null}
        {options.length > 0 ? (
          <Select value={agentKey ?? ""} onValueChange={(v) => setAgentKey(v)}>
            <SelectTrigger size="sm" aria-label={m.afiles_agent_label()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={keyOf(o)} value={keyOf(o)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="oc-admin__hint">{m.afiles_no_agents()}</p>
        )}
      </div>

      {selected === null ? null : gate === "loading" ? (
        <p className="oc-admin__hint">{m.common_loading()}</p>
      ) : gate !== null && gate.blocked ? (
        // Whole-tab gate: disabled-and-EXPLAINED (unlike the hidden popover
        // knobs) — the user must understand why the surface is unavailable.
        <p className="oc-compat__blocked" role="status">
          <AlertTriangle size={14} aria-hidden />{" "}
          {unsupportedInstanceLabel(gate.gatewayVersion)}
        </p>
      ) : listing.status === "loading" || listing.status === "idle" ? (
        <p className="oc-admin__hint">{m.common_loading()}</p>
      ) : listing.status === "error" ? (
        <p className="oc-afiles__error" role="alert">
          {m.afiles_error_bridge()}{" "}
          <Button variant="outline" size="sm" onClick={() => void loadFiles()}>
            {m.conf_retry()}
          </Button>
        </p>
      ) : listing.files.length === 0 ? (
        <p className="oc-admin__hint">{m.afiles_empty()}</p>
      ) : (
        <>
          <div className="oc-afiles__list">
            {listing.files.map((f) => {
              const pct = gaugePct(f.size);
              const warn = pct >= GAUGE_WARN_PCT;
              return (
                <div key={f.name} className="oc-afiles__row">
                  <span className="oc-afiles__name" title={f.name}>
                    {f.name}
                  </span>
                  {f.missing ? (
                    <Badge variant="outline">{m.afiles_missing()}</Badge>
                  ) : (
                    <>
                      <span className="oc-afiles__size">
                        {m.afiles_size_kb({ size: formatKb(f.size, locale) })}
                      </span>
                      <span
                        className={`oc-afiles__gauge${warn ? " is-warn" : ""}`}
                        aria-hidden
                      >
                        <span
                          className="oc-afiles__gauge-fill"
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </span>
                      <span className="oc-afiles__pct">
                        {m.afiles_pct({ pct: numFmt.format(pct) })}
                      </span>
                      {warn ? (
                        <AlertTriangle
                          size={14}
                          className="oc-afiles__warn"
                          aria-label={m.afiles_near_limit()}
                        />
                      ) : (
                        <span className="oc-afiles__warn-slot" aria-hidden />
                      )}
                    </>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="oc-afiles__open"
                    onClick={() => setEditing(f)}
                  >
                    {isAdmin ? m.afiles_edit() : m.afiles_view()}
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="oc-afiles__budget">
            {m.afiles_budget({
              used: formatKb(totalSize(listing.files), locale),
              total: formatKb(TOTAL_BUDGET_CHARS, locale),
              pct: numFmt.format(budgetPct(totalSize(listing.files))),
            })}
          </p>
        </>
      )}

      {editing && selected ? (
        <AgentFileEditor
          instanceName={selected.instanceName}
          agentId={selected.agentId}
          name={editing.name}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={() => void loadFiles()}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full-screen editor dialog: source textarea + LIVE char counter; admin save
// goes through a confirm AlertDialog showing an honest mini-diff (A4), then
// setAgentFile with the loaded `updatedAtMs` as the CAS token (409 → conflict
// banner + reload). The chat MarkdownText component is context-bound to
// assistant-ui message parts (not reusable standalone), so this editor is
// deliberately SOURCE-ONLY — no rendered markdown preview tab.
// ---------------------------------------------------------------------------

function AgentFileEditor({
  instanceName,
  agentId,
  name,
  isAdmin,
  onClose,
  onSaved,
}: {
  instanceName: string;
  agentId: string;
  name: string;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const getFile = useAction(api.agentFiles.getAgentFile);
  const setFile = useAction(api.agentFiles.setAgentFile);
  const toast = useToast();

  const [loaded, setLoaded] = useState<{
    content: string;
    updatedAtMs: number | null;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // (Re)load the file. On a CAS conflict the admin's DRAFT is preserved — only
  // the base content + CAS token refresh, so the edit can be re-diffed/re-saved.
  const load = useCallback(
    async (keepDraft: boolean) => {
      setLoadError(false);
      try {
        const res = await getFile({ instanceName, agentId, name });
        setLoaded({ content: res.content, updatedAtMs: res.updatedAtMs });
        if (!keepDraft) setDraft(res.content);
        setConflict(false);
      } catch {
        setLoadError(true);
      }
    },
    [getFile, instanceName, agentId, name],
  );
  useEffect(() => {
    void load(false);
  }, [load]);

  async function save() {
    if (loaded === null) return;
    setSaving(true);
    setSaveError(false);
    try {
      await setFile({
        instanceName,
        agentId,
        name,
        content: draft,
        baseUpdatedAtMs: loaded.updatedAtMs ?? undefined,
      });
      toast.success(m.afiles_saved({ name }));
      onSaved();
      await load(false); // refresh content + CAS token after a write
    } catch (err) {
      if (isConflictError(err)) setConflict(true);
      else setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  const dirty = loaded !== null && draft !== loaded.content;
  const diff = useMemo(
    () => (loaded === null ? null : computeMiniDiff(loaded.content, draft)),
    [loaded, draft],
  );
  const over = draft.length > BOOTSTRAP_MAX_CHARS;
  const locale = getLocale();
  const charFmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="oc-afiles__editor">
        <DialogHeader>
          <DialogTitle>{m.afiles_editor_title({ name })}</DialogTitle>
          <DialogDescription>
            {m.afiles_editor_desc({ agent: agentId, instance: instanceName })}
            {isAdmin ? null : <> · {m.afiles_readonly()}</>}
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="oc-afiles__error" role="alert">
            {m.afiles_load_error()}{" "}
            <Button variant="outline" size="sm" onClick={() => void load(false)}>
              {m.conf_retry()}
            </Button>
          </p>
        ) : loaded === null ? (
          <p className="oc-admin__hint">{m.common_loading()}</p>
        ) : (
          <>
            <textarea
              className="oc-afiles__source"
              value={draft}
              readOnly={!isAdmin}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={m.afiles_editor_title({ name })}
            />
            <p className="oc-afiles__hint">{m.afiles_source_note()}</p>
            {conflict ? (
              <p className="oc-afiles__error" role="alert">
                {m.afiles_conflict()}{" "}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void load(true)}
                >
                  {m.afiles_reload()}
                </Button>
              </p>
            ) : null}
            {saveError ? (
              <p className="oc-afiles__error" role="alert">
                {m.afiles_save_error()}
              </p>
            ) : null}
            <div className="oc-afiles__editor-foot">
              <span className={`oc-afiles__count${over ? " is-over" : ""}`}>
                {m.afiles_chars({
                  count: charFmt.format(draft.length),
                  max: charFmt.format(BOOTSTRAP_MAX_CHARS),
                })}
              </span>
              {isAdmin ? (
                <Button
                  size="sm"
                  disabled={!dirty || saving || conflict}
                  onClick={() => setConfirmOpen(true)}
                >
                  {saving ? m.conf_applying() : m.afiles_save()}
                </Button>
              ) : null}
            </div>
          </>
        )}

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.afiles_confirm_title({ name })}</AlertDialogTitle>
              <AlertDialogDescription>
                {m.afiles_confirm_desc({ agent: agentId })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {diff ? (
              <div className="oc-afiles__diff">
                <p className="oc-afiles__diff-counts">
                  {m.afiles_diff_summary({
                    added: diff.added,
                    removed: diff.removed,
                  })}
                </p>
                {diff.sampleAdded.length > 0 ? (
                  <div className="oc-afiles__diff-block">
                    <span className="oc-afiles__diff-label">
                      {m.afiles_diff_added()}
                    </span>
                    {diff.sampleAdded.map((l, i) => (
                      <code key={i} className="oc-afiles__diff-line is-add">
                        {l || " "}
                      </code>
                    ))}
                  </div>
                ) : null}
                {diff.sampleRemoved.length > 0 ? (
                  <div className="oc-afiles__diff-block">
                    <span className="oc-afiles__diff-label">
                      {m.afiles_diff_removed()}
                    </span>
                    {diff.sampleRemoved.map((l, i) => (
                      <code key={i} className="oc-afiles__diff-line is-del">
                        {l || " "}
                      </code>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel>{m.chat_cancel()}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void save()}>
                {m.afiles_confirm_cta()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
