// Settings ▸ chat defaults — "Raisonnement" (0.103.0): the instance's DEFAULT (does a
// conversation that chose nothing itself show the model's reasoning?) and the agents that are
// EXCEPTIONS to it (convex/lib/reasoningDisplay.ts). Atrium's own display setting: the
// gateway's configuration is never written (its `reasoningDefault` applies to every channel
// of the agent, and Hermes has none). Only the exceptions are listed, and a new one is picked
// from a searchable list, so an instance with a hundred agents stays readable. Every
// decision is in reasoningDefaultsView.ts; this file only renders it.

import { useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useMutation, useQuery } from "convex/react";
import { LoaderCircle, Plus, Undo2 } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { KnobControl } from "../KnobRow";
import { api } from "../convexApi";
import {
  activeCandidateIndex,
  addCandidates,
  agentName,
  enterPick,
  exceptionFilterShown,
  exceptionsOf,
  newExceptionValue,
  nextActiveIndex,
  showsAgentId,
  visibleExceptions,
  type ReasoningAgentRow,
} from "./reasoningDefaultsView";

type CardData = { agents: ReasoningAgentRow[]; showReasoningDefault: boolean };
/** What is being saved, or failed to: the instance default, or one agent's exception. */
type Target = { kind: "instance" } | { kind: "agent"; agentId: string };

const valueLabel = (show: boolean): string =>
  show ? m.conf_reasoning_display_on() : m.conf_reasoning_display_off();

function sameTarget(a: Target | null, b: Target): boolean {
  if (a === null || a.kind !== b.kind) return false;
  return a.kind === "instance" || (b.kind === "agent" && a.agentId === b.agentId);
}

export function ReasoningDefaultsCard({ instanceName }: { instanceName: string }) {
  const data = useQuery(api.agents.listAgentsForInstance, { instanceName }) as CardData | undefined;
  const setInstanceDefault = useMutation(api.agents.setInstanceReasoningDefault);
  const setAgentDefault = useMutation(api.agents.setAgentReasoningDefault);
  const [pending, setPending] = useState<Target | null>(null);
  const [failed, setFailed] = useState<Target | null>(null);
  const [announce, setAnnounce] = useState("");
  const [filter, setFilter] = useState("");
  const addRef = useRef<HTMLButtonElement>(null);
  const switchId = useId();

  const instanceDefault = data?.showReasoningDefault === true;
  const agents = data?.agents ?? [];
  const exceptions = useMemo(() => exceptionsOf(agents, instanceDefault), [agents, instanceDefault]);
  const shown = visibleExceptions(exceptions, filter);
  const hasCandidates = addCandidates(agents, "").length > 0;

  async function save(target: Target, run: () => Promise<unknown>, done: string): Promise<boolean> {
    setPending(target);
    setFailed(null);
    setAnnounce("");
    try {
      await run();
      setAnnounce(done);
      return true;
    } catch {
      setFailed(target);
      return false;
    } finally {
      // A later save may have started meanwhile (the add list stays usable): keep its state.
      setPending((p) => (p === target ? null : p));
    }
  }

  const saveInstance = (show: boolean) =>
    void save(
      { kind: "instance" },
      () => setInstanceDefault({ instanceName, show }),
      m.cdefaults_reasoning_announce_default({ value: valueLabel(show) }),
    );

  const saveAgent = (a: ReasoningAgentRow, show: boolean | null, done: string) =>
    save({ kind: "agent", agentId: a.agentId }, () => setAgentDefault({ instanceName, agentId: a.agentId, show }), done);

  async function removeException(a: ReasoningAgentRow): Promise<void> {
    const ok = await saveAgent(a, null, m.cdefaults_reasoning_announce_removed({ agent: agentName(a) }));
    // The row is gone: keep the focus in the card rather than losing it to the page.
    if (ok) addRef.current?.focus();
  }

  const busy = pending !== null;

  return (
    <div className="oc-cdefaults__row oc-rdefaults">
      <span className="oc-cdefaults__label">{m.cdefaults_reasoning_label()}</span>
      <p className="oc-cdefaults__help">{m.cdefaults_reasoning_help()}</p>
      {data === undefined ? (
        <p className="oc-admin__hint">{m.common_loading()}</p>
      ) : agents.length === 0 ? (
        <p className="oc-admin__hint">{m.cdefaults_reasoning_none()}</p>
      ) : (
        <>
          <div className="oc-rdefaults__default">
            <label htmlFor={switchId} className="oc-rdefaults__default-label">
              {m.cdefaults_reasoning_default_label()}
            </label>
            <span className="oc-rdefaults__state" aria-hidden>
              {pending?.kind === "instance" ? (
                <LoaderCircle size={14} className="oc-rdefaults__spin" />
              ) : (
                valueLabel(instanceDefault)
              )}
            </span>
            <Switch
              id={switchId}
              checked={instanceDefault}
              disabled={busy}
              aria-busy={pending?.kind === "instance"}
              onCheckedChange={saveInstance}
            />
          </div>
          {failed?.kind === "instance" ? (
            <p className="oc-cdefaults__error" role="alert">
              {m.cdefaults_save_error()}
            </p>
          ) : null}

          <div className="oc-rdefaults__exhead">
            <span className="oc-rdefaults__exlabel">
              {m.cdefaults_reasoning_exceptions({ count: exceptions.length })}
            </span>
            <AddException
              agents={agents}
              instanceDefault={instanceDefault}
              disabled={!hasCandidates}
              triggerRef={addRef}
              onPick={(a) => {
                const show = newExceptionValue(instanceDefault);
                void saveAgent(a, show, m.cdefaults_reasoning_announce_added({ agent: agentName(a), value: valueLabel(show) }));
              }}
            />
          </div>

          {exceptions.length === 0 ? (
            <p className="oc-cdefaults__help">{m.cdefaults_reasoning_exceptions_empty()}</p>
          ) : (
            <>
              {exceptionFilterShown(exceptions.length) ? (
                <Input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={m.cdefaults_reasoning_filter()}
                  aria-label={m.cdefaults_reasoning_filter()}
                  className="oc-rdefaults__filter"
                />
              ) : null}
              {shown.length === 0 ? (
                <p className="oc-cdefaults__help">{m.cdefaults_reasoning_filter_empty()}</p>
              ) : (
                <ul className="oc-rdefaults__list" aria-label={m.cdefaults_reasoning_exceptions({ count: exceptions.length })}>
                  {shown.map(({ agent: a, show, sameAsDefault }) => {
                    const name = agentName(a);
                    const target: Target = { kind: "agent", agentId: a.agentId };
                    return (
                      <li key={a.agentId} className="oc-rdefaults__item">
                        <div className="oc-rdefaults__who">
                          <span className="oc-rdefaults__name">{name}</span>
                          {showsAgentId(a) ? <span className="oc-rdefaults__id">{a.agentId}</span> : null}
                          {sameAsDefault ? (
                            <span className="oc-rdefaults__same">{m.cdefaults_reasoning_same_as_default()}</span>
                          ) : null}
                        </div>
                        <div className="oc-rdefaults__ctl">
                          {sameTarget(pending, target) ? (
                            <LoaderCircle size={14} className="oc-rdefaults__spin" aria-label={m.conf_applying()} />
                          ) : null}
                          <KnobControl
                            field="showReasoning"
                            ariaLabel={m.cdefaults_reasoning_exception_aria({ agent: name })}
                            options={[
                              { id: "on", label: m.conf_reasoning_display_on() },
                              { id: "off", label: m.conf_reasoning_display_off() },
                            ]}
                            value={show ? "on" : "off"}
                            onChange={(id) =>
                              void saveAgent(
                                a,
                                id === "on",
                                m.cdefaults_reasoning_announce_changed({ agent: name, value: valueLabel(id === "on") }),
                              )
                            }
                            disabled={busy}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            aria-label={m.cdefaults_reasoning_remove_aria({ agent: name })}
                            title={m.cdefaults_reasoning_remove_aria({ agent: name })}
                            onClick={() => void removeException(a)}
                          >
                            <Undo2 aria-hidden />
                          </Button>
                        </div>
                        {sameTarget(failed, target) ? (
                          <p className="oc-cdefaults__error oc-rdefaults__rowerror" role="alert">
                            {m.cdefaults_save_error()}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
          {failed?.kind === "agent" && !exceptions.some((r) => r.agent.agentId === failed.agentId) ? (
            // A failed ADD has no row to carry its error.
            <p className="oc-cdefaults__error" role="alert">
              {m.cdefaults_save_error()}
            </p>
          ) : null}
        </>
      )}
      <p className="oc-sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </p>
    </div>
  );
}

/** "Ajouter une exception": a searchable, keyboard-driven list of the agents without one. */
function AddException({
  agents,
  instanceDefault,
  disabled,
  triggerRef,
  onPick,
}: {
  agents: ReasoningAgentRow[];
  instanceDefault: boolean;
  disabled: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onPick: (a: ReasoningAgentRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The chosen option, by agent id: see `activeCandidateIndex`.
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const candidates = addCandidates(agents, query);
  const active = activeCandidateIndex(candidates, activeId);
  const noneLeft = addCandidates(agents, "").length === 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  function close(): void {
    setOpen(false);
    setQuery("");
    setActiveId(null);
  }

  function move(next: number): void {
    setActiveId(next >= 0 ? candidates[next]!.agentId : null);
    if (next >= 0) {
      listRef.current?.querySelector(`#${CSS.escape(optionId(next))}`)?.scrollIntoView({ block: "nearest" });
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(nextActiveIndex(active, e.key, candidates.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = enterPick(candidates, activeId);
      if (pick !== null) {
        close();
        onPick(pick);
      } else {
        // The chosen agent left the list: nothing is added, and the choice is cleared.
        setActiveId(null);
      }
    }
  }

  return (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <Button ref={triggerRef} variant="outline" size="sm" disabled={disabled}>
          <Plus aria-hidden />
          {m.cdefaults_reasoning_add()}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="oc-rdefaults__pop p-0">
        <p className="oc-rdefaults__pophint">
          {m.cdefaults_reasoning_add_hint({ value: valueLabel(newExceptionValue(instanceDefault)) })}
        </p>
        <Input
          autoFocus
          type="search"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && active < candidates.length ? optionId(active) : undefined}
          aria-label={m.cdefaults_reasoning_search()}
          placeholder={m.cdefaults_reasoning_search()}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveId(null);
          }}
          onKeyDown={onKeyDown}
          className="oc-rdefaults__search"
        />
        <div id={listId} ref={listRef} role="listbox" aria-label={m.cdefaults_reasoning_add()} className="oc-rdefaults__options">
          {candidates.length === 0 ? (
            <p className="oc-rdefaults__empty">
              {noneLeft ? m.cdefaults_reasoning_all_excepted() : m.cdefaults_reasoning_search_empty()}
            </p>
          ) : (
            candidates.map((a, i) => (
              <div
                key={a.agentId}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={`oc-rdefaults__opt${a.enabled ? "" : " is-disabled"}${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActiveId(a.agentId)}
                // Keep the focus in the search field: the list is driven from it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  close();
                  onPick(a);
                }}
              >
                <span className="oc-rdefaults__name">{agentName(a)}</span>
                {showsAgentId(a) ? <span className="oc-rdefaults__id">{a.agentId}</span> : null}
                {a.enabled ? null : <span className="oc-rdefaults__badge">{m.cdefaults_reasoning_disabled()}</span>}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
