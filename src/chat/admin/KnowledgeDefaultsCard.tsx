// Settings ▸ chat defaults — "Connaissances par agent": each agent's DEFAULT knowledge
// policy on its gateway (the `openclaw-knowledge` plugin), edited by an administrator
// through the gateway's own validated config write (bridge → `config.patch`). Only the
// sources the operator allows for the agent are offered; the saved value is the bridge's
// confirmed read-back. Decisions: knowledgeDefaultsView.ts.

import { useEffect, useState } from "react";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
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
import { api } from "../convexApi";
import {
  KNOWLEDGE_INJECTION_OPTIONS,
  agentDefaultForm,
  baselineDiverged,
  draftOf,
  expectedOf,
  injectionLabel,
  isInjectionOption,
  saveOutcomeText,
  toggleDraftSource,
  type AgentDefaultDraft,
  type AgentKnowledgeRow,
} from "./knowledgeDefaultsView";

function AgentDefaultRow({
  instanceName,
  row,
  supported,
}: {
  instanceName: string;
  row: AgentKnowledgeRow;
  supported: boolean;
}) {
  const save = useAction(api.knowledge.setAgentKnowledgeDefault);
  // THE ROW AS IT WAS WHEN THE ADMIN OPENED IT (codex pass 7): the draft starts from it,
  // and its raw + effective default is what the save is checked against — until the
  // admin reloads. A live row that moves meanwhile (another operator, the CLI — even a
  // raw change the effective default does not show) is announced, never silently
  // adopted, so an old draft can never be saved against a baseline nobody saw.
  const [base, setBase] = useState<AgentKnowledgeRow>(row);
  const [draft, setDraft] = useState<AgentDefaultDraft>(() => draftOf(row));
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  // After a confirmed save, the next live row IS the new baseline (it is our own write).
  const [adoptNext, setAdoptNext] = useState(false);
  const reload = (next: AgentKnowledgeRow) => {
    setBase(next);
    setDraft(draftOf(next));
    setError(null);
  };
  const diverged = baselineDiverged(base, row);
  useEffect(() => {
    if (adoptNext && diverged) {
      setAdoptNext(false);
      reload(row);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoptNext, diverged]);
  const form = agentDefaultForm(base, draft, supported);
  const editable = form.readOnlyReason === null;

  async function submit(): Promise<void> {
    setState("saving");
    setError(null);
    try {
      const out = await save({
        instanceName,
        agentId: row.agentId,
        injection: draft.injection,
        sources: draft.sources,
        expected: expectedOf(base),
      });
      const text = saveOutcomeText(out);
      setError(text);
      setState(text === null ? "done" : "idle");
      if (text === null) setAdoptNext(true);
    } catch (err) {
      setError(saveOutcomeText({ ok: false, code: String((err as Error)?.message ?? "error").slice(0, 60) }));
      setState("idle");
    }
  }

  return (
    <div className="oc-cdefaults__row" data-knowledge-agent={row.agentId}>
      <span className="oc-cdefaults__label">{row.agentId}</span>
      <>
          <div className="oc-cdefaults__inline">
            <Select
              value={draft.injection}
              onValueChange={(v) => {
                if (isInjectionOption(v)) setDraft({ ...draft, injection: v });
              }}
              disabled={!editable}
            >
              <SelectTrigger
                className="oc-cdefaults__select"
                aria-label={m.cdefaults_knowledge_injection()}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KNOWLEDGE_INJECTION_OPTIONS.map((o) => (
                  <SelectItem key={o} value={o}>
                    {injectionLabel(o)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="oc-cdefaults__label">{m.cdefaults_knowledge_sources()}</span>
          {row.sources.map((s) => (
            <label
              key={s.id}
              className="oc-cdefaults__inline"
              style={{ cursor: editable ? "pointer" : "default" }}
              title={s.description || undefined}
            >
              <Checkbox
                checked={draft.sources.includes(s.id)}
                onCheckedChange={() => setDraft(toggleDraftSource(row, draft, s.id))}
                disabled={!editable}
                aria-label={s.label}
                data-knowledge-default-source={s.id}
              />
              <span>{s.label}</span>
            </label>
          ))}
          {diverged && !adoptNext ? (
            <p className="oc-cdefaults__error" role="alert">
              {m.cdefaults_knowledge_changed()}{" "}
              <Button variant="outline" size="sm" onClick={() => reload(row)}>
                {m.cdefaults_knowledge_reload()}
              </Button>
            </p>
          ) : null}
          {!row.overridesAllowed ? (
            <p className="oc-cdefaults__help">{m.cdefaults_knowledge_overrides_off()}</p>
          ) : null}
          {editable ? (
            <div className="oc-cdefaults__inline">
              <Button
                size="sm"
                disabled={!form.dirty || !form.valid || state === "saving"}
                onClick={() => void submit()}
              >
                {state === "saving" ? m.conf_applying() : m.cdefaults_save()}
              </Button>
            </div>
          ) : (
            <p className="oc-cdefaults__note">{form.readOnlyReason}</p>
          )}
          {editable && form.dirty && form.invalidReason !== null ? (
            <p className="oc-cdefaults__error" role="alert">
              {form.invalidReason}
            </p>
          ) : null}
          {state === "done" && error === null ? (
            <p className="oc-admin__hint" role="status">
              {m.cdefaults_saved()}
            </p>
          ) : null}
          {error !== null ? (
            <p className="oc-cdefaults__error" role="alert">
              {error}
            </p>
          ) : null}
        </>
    </div>
  );
}

/** How many agents the card loads at a time (codex pass 22: paged, never cut). */
export const KNOWLEDGE_ADMIN_PAGE = 50;

export function KnowledgeDefaultsCard({ instanceName }: { instanceName: string }) {
  const data = useQuery(api.knowledge.knowledgeAdminInstance, { instanceName });
  // The agents WITH the plugin, a page at a time: every one reachable ("load more"), and
  // the card says when more remain — no hidden truncation.
  const { results: withPlugin, status, loadMore } = usePaginatedQuery(
    api.knowledge.agentKnowledgePage,
    { instanceName },
    { initialNumItems: KNOWLEDGE_ADMIN_PAGE },
  );
  // Hermes has no knowledge plugin surface; an instance nobody discovered a plugin on
  // shows nothing at all — the card appears where there is something to set.
  if (data === undefined || data.provider !== "openclaw") return null;
  if (withPlugin.length === 0 && status !== "CanLoadMore") return null;
  return (
    <section className="oc-cdefaults__row" aria-label={m.cdefaults_knowledge_title()}>
      <span className="oc-cdefaults__label">{m.cdefaults_knowledge_title()}</span>
      <p className="oc-admin__hint">{m.cdefaults_knowledge_hint()}</p>
      {!data.supported ? (
        <p className="oc-cdefaults__note">{m.cdefaults_knowledge_unsupported()}</p>
      ) : null}
      {withPlugin.map((row) => (
        <AgentDefaultRow
          key={row.agentId}
          instanceName={instanceName}
          row={row}
          supported={data.supported}
        />
      ))}
      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <div className="oc-cdefaults__inline">
          <p className="oc-admin__hint">
            {m.cdefaults_knowledge_more_agents({ shown: withPlugin.length })}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={status === "LoadingMore"}
            onClick={() => loadMore(KNOWLEDGE_ADMIN_PAGE)}
            data-knowledge-load-more
          >
            {m.cdefaults_knowledge_load_more()}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
