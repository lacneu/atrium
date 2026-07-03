import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check,
  Copy,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pencil } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import { SessionKnobsGroup } from "./KnobRow";
import { useInstanceCapabilities } from "./useInstanceCapabilities";
import {
  agentLine,
  contextLine,
  contextPct,
  costLine,
  verbosityLine,
  type SessionMetaView,
  type SessionSettingsView,
} from "./sessionKnobs";

// CONF-4b — the right-side session-settings Sheet, opened from the
// "Advanced" popover's footer (the 2nd and LAST disclosure level). Layer-cake
// sections (spaced-caps headers, single column): GENERATION reuses the SAME
// SessionKnobsGroup as the popover (A11 — never two implementations); SESSION
// and AGENT are read-only meta; ACTIONS live in a SEPARATE bottom zone
// (actions ≠ settings, grammar §1.5), each behind an AlertDialog confirm with
// inline pending/done/error + retry states. No VOIX section (A6).

type ActionState = "idle" | "pending" | "done" | "error";

/** One ACTIONS-zone entry: confirm upstream; this renders button + states. */
/** Compact char-count for the summary gauge label (mirrors the context meter's k). */
function fmtChars(n: number): string {
  return n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}

function ActionRow({
  label,
  state,
  destructive,
  onClick,
  onRetry,
}: {
  label: string;
  state: ActionState;
  destructive?: boolean;
  onClick: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="oc-spanel__action">
      <Button
        variant={destructive ? "destructive" : "outline"}
        size="sm"
        disabled={state === "pending"}
        onClick={onClick}
      >
        {state === "pending" ? (
          <LoaderCircle className="oc-spanel__spin" aria-hidden />
        ) : null}
        {label}
      </Button>
      {state === "done" ? (
        <p className="oc-spanel__action-note" role="status">
          {m.spanel_action_done()}
        </p>
      ) : null}
      {state === "error" ? (
        <p className="oc-spanel__error" role="alert">
          {m.spanel_action_error()}
          <button type="button" className="oc-spanel__retry" onClick={onRetry}>
            {m.conf_retry()}
          </button>
        </p>
      ) : null}
    </div>
  );
}

export function SessionPanel({
  chatId,
  open,
  onOpenChange,
}: {
  chatId: ConvexId<"chats">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Same args as the chat header's subscriptions — Convex dedupes them, so the
  // panel adds no read cost while open and none at all while closed (skip).
  const meta = useQuery(
    api.messages.getSessionMeta,
    open ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const summaryInfo = useQuery(
    api.chatSummaries.getChatSummary,
    open ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const agentInfo = useQuery(
    api.agents.getChatAgent,
    open ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const sm = (meta?.sessionMeta ?? null) as SessionMetaView | null;
  const settings = (meta?.sessionSettings ?? null) as SessionSettingsView;
  // Capability gate (VCOMPAT-C): "Compacter" is HIDDEN when the chat's
  // instance lacks sessionCompact (legacy policy while loading/closed — the
  // action can appear once the snapshot lands, never flash and vanish).
  const { can } = useInstanceCapabilities(open ? chatId : null);

  const confirm = useConfirm();
  const compactAction = useAction(api.agentFiles.compactSession);
  const resetMutation = useMutation(api.chats.resetSession);
  const summarizeMutation = useMutation(api.chatSummaries.requestSummarize);
  const [compactState, setCompactState] = useState<ActionState>("idle");
  const [resetState, setResetState] = useState<ActionState>("idle");
  const [summarizeState, setSummarizeState] = useState<ActionState>("idle");
  // The manual trigger's OUTCOME (why nothing was dispatched, or confirmation) —
  // shown as a hint under the action row.
  const [summarizeNotice, setSummarizeNotice] = useState<string | null>(null);
  // Summary viewer states: copy feedback, expanded reading, inline edit buffer.
  const [summaryCopied, setSummaryCopied] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null);
  const [summarySaveState, setSummarySaveState] = useState<
    "idle" | "saving" | "error"
  >("idle");
  const updateSummaryMutation = useMutation(api.chatSummaries.updateSummary);
  // Switching CONVERSATIONS while the panel stays mounted must drop every
  // summary-viewer state — a lingering draft would otherwise be SAVED into the
  // new chat and overwrite the wrong summary (codex P2).
  useEffect(() => {
    setSummaryDraft(null);
    setSummarySaveState("idle");
    setSummaryExpanded(false);
    setSummaryCopied(false);
    setSummarizeNotice(null);
    setSummarizeState("idle");
  }, [chatId]);
  async function copySummary(): Promise<void> {
    if (!summaryInfo?.summary) return;
    try {
      await navigator.clipboard.writeText(summaryInfo.summary);
      setSummaryCopied(true);
      window.setTimeout(() => setSummaryCopied(false), 2_000);
    } catch {
      /* clipboard denied: no feedback beats a crash */
    }
  }
  async function saveSummaryDraft(): Promise<void> {
    if (summaryDraft === null || summaryDraft.trim().length === 0) return;
    setSummarySaveState("saving");
    try {
      await updateSummaryMutation({
        chatId: chatId as Id<"chats">,
        summary: summaryDraft,
      });
      setSummaryDraft(null);
      setSummarySaveState("idle");
    } catch {
      setSummarySaveState("error");
    }
  }
  // Live elapsed indicator for an in-flight summarize job (1s tick while running).
  const [nowTick, setNowTick] = useState(() => Date.now());
  const jobRunning = summaryInfo?.jobInFlight === true;
  useEffect(() => {
    if (!jobRunning) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [jobRunning]);

  // Retry re-runs the action WITHOUT re-confirming (the intent was confirmed;
  // only the transport failed) — A11 inline-error-with-retry.
  async function runCompact(): Promise<void> {
    setCompactState("pending");
    try {
      await compactAction({ chatId: chatId as Id<"chats"> });
      setCompactState("done");
    } catch {
      setCompactState("error");
    }
  }
  async function runSummarize(): Promise<void> {
    setSummarizeState("pending");
    setSummarizeNotice(null);
    try {
      const { outcome } = await summarizeMutation({
        chatId: chatId as Id<"chats">,
      });
      const notices: Record<string, () => string> = {
        dispatched: m.spanel_summarize_dispatched,
        in_flight: m.spanel_summarize_in_flight,
        nothing_to_do: m.spanel_summarize_nothing,
        scanning: m.spanel_summarize_scanning,
        bridge_outdated: m.spanel_summarize_bridge_outdated,
        engine_off: m.spanel_summarize_engine_off,
        no_agent: m.spanel_summarize_no_agent,
        backoff: m.spanel_summarize_nothing,
      };
      setSummarizeNotice((notices[outcome] ?? m.spanel_summarize_nothing)());
      setSummarizeState(
        outcome === "dispatched" || outcome === "scanning" ? "done" : "idle",
      );
    } catch {
      setSummarizeState("error");
    }
  }
  async function runReset(): Promise<void> {
    setResetState("pending");
    try {
      await resetMutation({ chatId: chatId as Id<"chats"> });
      setResetState("done");
    } catch {
      setResetState("error");
    }
  }

  async function onCompact(): Promise<void> {
    const ok = await confirm({
      title: m.spanel_compact_confirm_title(),
      description: m.spanel_compact_confirm_desc(),
      confirmLabel: m.spanel_compact_confirm_cta(),
      cancelLabel: m.chat_cancel(),
    });
    if (ok) await runCompact();
  }
  async function onReset(): Promise<void> {
    const ok = await confirm({
      title: m.spanel_reset_confirm_title(),
      description: m.spanel_reset_confirm_desc(),
      confirmLabel: m.spanel_reset_confirm_cta(),
      cancelLabel: m.chat_cancel(),
      destructive: true,
    });
    if (ok) await runReset();
  }

  const pct = contextPct(sm?.totalTokens, sm?.contextTokens);
  const meterLevel =
    pct == null ? "" : pct >= 90 ? "is-critical" : pct >= 75 ? "is-warn" : "is-ok";
  const context = contextLine(sm?.totalTokens, sm?.contextTokens);
  const cost = costLine(sm?.estimatedCostUsd, sm?.totalTokens);
  // getChatAgent only names the agent for multi-agent users; runtime/model
  // still come from sessionMeta, so the line degrades gracefully.
  const agent = agentInfo?.agent ?? null;
  const agentInfoLine = agentLine([
    agent ? (agent.displayName ?? agent.agentId) : null,
    sm?.agentRuntime,
    sm?.model,
  ]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="oc-spanel">
        <SheetHeader>
          <SheetTitle>{m.spanel_title()}</SheetTitle>
          <SheetDescription>{m.spanel_desc()}</SheetDescription>
        </SheetHeader>
        <div className="oc-spanel__body">
          {meta === undefined ? (
            <p className="oc-spanel__loading">{m.common_loading()}</p>
          ) : (
            <>
              {sm ? (
                <section>
                  <h3 className="oc-spanel__cat">
                    {m.spanel_section_generation()}
                  </h3>
                  <SessionKnobsGroup chatId={chatId} sm={sm} settings={settings} />
                </section>
              ) : null}
              <section>
                <h3 className="oc-spanel__cat">{m.spanel_section_session()}</h3>
                {context !== null && pct !== null ? (
                  <div className="oc-spanel__static">
                    <span className="oc-spanel__label">
                      {m.spanel_context_label()}
                    </span>
                    <span className={`oc-meter oc-spanel__meter ${meterLevel}`}>
                      <span className="oc-meter__track">
                        <span
                          className="oc-meter__fill"
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </span>
                      <span className="oc-meter__label">{context}</span>
                    </span>
                  </div>
                ) : null}
                <div className="oc-spanel__static">
                  <span className="oc-spanel__label">
                    {m.spanel_verbosity_label()}
                  </span>
                  <span className="oc-spanel__value">
                    {verbosityLine(sm?.verboseLevel)}
                  </span>
                  <p className="oc-spanel__help">{m.spanel_verbosity_help()}</p>
                </div>
                {cost !== null ? (
                  <div className="oc-spanel__static">
                    <span className="oc-spanel__label">
                      {m.spanel_cost_label()}
                    </span>
                    <span className="oc-spanel__value">{cost}</span>
                  </div>
                ) : null}
              </section>
              {agentInfoLine !== null || sm ? (
                <section>
                  <h3 className="oc-spanel__cat">{m.spanel_section_agent()}</h3>
                  {/* The agent's CONFIGURATION, detailed like the sub-agent panel's
                      "Advanced" list (same vocabulary/keys) — rendered ONLY from captured
                      values, never a fabricated default. */}
                  <dl className="oc-spanel__kv">
                    {agent ? (
                      <div className="oc-spanel__kv-row">
                        <dt>{m.subagent_bar_agent()}</dt>
                        <dd>
                          {agent.emoji ? `${agent.emoji} ` : ""}
                          {agent.displayName ?? agent.agentId}
                        </dd>
                      </div>
                    ) : null}
                    {agent?.instanceName ? (
                      <div className="oc-spanel__kv-row">
                        <dt>{m.spanel_agent_instance()}</dt>
                        <dd>{agent.instanceName}</dd>
                      </div>
                    ) : null}
                    {sm?.model ? (
                      <div className="oc-spanel__kv-row">
                        <dt>{m.subagent_bar_model()}</dt>
                        <dd>{sm.model}</dd>
                      </div>
                    ) : null}
                    {sm?.modelProvider ? (
                      <div className="oc-spanel__kv-row">
                        <dt>{m.subagent_bar_provider()}</dt>
                        <dd>{sm.modelProvider}</dd>
                      </div>
                    ) : null}
                    {sm?.agentRuntime ? (
                      <div className="oc-spanel__kv-row">
                        <dt>{m.subagent_bar_gateway()}</dt>
                        <dd>{sm.agentRuntime}</dd>
                      </div>
                    ) : null}
                    {sm?.thinkingLevel ? (
                      <div className="oc-spanel__kv-row">
                        <dt>{m.subagent_bar_reasoning()}</dt>
                        <dd>{sm.thinkingLevel}</dd>
                      </div>
                    ) : null}
                    {sm?.thinkingDefault ? (
                      <div className="oc-spanel__kv-row">
                        <dt>{m.spanel_thinking_default()}</dt>
                        <dd>{sm.thinkingDefault}</dd>
                      </div>
                    ) : null}
                  </dl>
                </section>
              ) : null}
              <section>
                <h3 className="oc-spanel__cat">{m.spanel_section_summary()}</h3>
                {/* The chat's ROLLING SUMMARY (hybrid rehydration): the exact text
                    injected — beside the recent verbatim turns — when the gateway
                    session resumes. The user's own content, shown verbatim. */}
                {summaryInfo ? (
                  /* Accumulation gauge: unsummarized content vs the AUTO trigger
                     threshold — full bar = the next turn can dispatch a summary. */
                  <div className="oc-spanel__static">
                    <span className="oc-spanel__label">
                      {m.spanel_summary_gauge_label()}
                    </span>
                    <span className="oc-meter oc-spanel__meter is-ok">
                      <span className="oc-meter__track">
                        <span
                          className="oc-meter__fill"
                          style={{
                            width: `${Math.min(
                              (summaryInfo.pendingChars /
                                Math.max(summaryInfo.thresholdChars, 1)) *
                                100,
                              100,
                            )}%`,
                          }}
                        />
                      </span>
                      <span className="oc-meter__label">
                        {m.spanel_summary_gauge({
                          pending: `${fmtChars(summaryInfo.pendingChars)}${
                            summaryInfo.pendingApprox ? "+" : ""
                          }`,
                          threshold: fmtChars(summaryInfo.thresholdChars),
                        })}
                      </span>
                    </span>
                  </div>
                ) : null}
                {summaryInfo &&
                !summaryInfo.jobInFlight &&
                summaryInfo.pendingChars >= summaryInfo.thresholdChars ? (
                  <p className="oc-spanel__hint">
                    {m.spanel_summary_gauge_ready()}
                  </p>
                ) : null}
                {summaryInfo?.jobInFlight ? (
                  <p className="oc-spanel__hint oc-spanel__job" role="status">
                    <LoaderCircle
                      size={13}
                      className="oc-spanel__job-spin"
                      aria-hidden
                    />
                    {summaryInfo.jobStreaming
                      ? m.spanel_summary_job_writing()
                      : m.spanel_summary_job_sent()}
                    {summaryInfo.jobStartedAt
                      ? ` · ${Math.max(0, Math.round((nowTick - summaryInfo.jobStartedAt) / 1000))} s`
                      : ""}
                  </p>
                ) : null}
                {summaryInfo && summaryInfo.summary.length > 0 ? (
                  <>
                    <p className="oc-spanel__hint">
                      {m.spanel_summary_meta({
                        count: String(summaryInfo.coveredCount),
                        date: new Intl.DateTimeFormat(undefined, {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(summaryInfo.updatedAt)),
                      })}
                      {summaryInfo.lastAgentId
                        ? ` ${m.spanel_summary_agent({
                            agent: summaryInfo.lastInstanceName
                              ? `${summaryInfo.lastAgentId} (${summaryInfo.lastInstanceName})`
                              : summaryInfo.lastAgentId,
                          })}`
                        : ""}
                    </p>
                    {summaryInfo.failureCount > 0 ? (
                      <p className="oc-spanel__hint oc-spanel__hint--warn">
                        {m.spanel_summary_failing({
                          count: String(summaryInfo.failureCount),
                        })}
                      </p>
                    ) : null}
                    <div className="oc-spanel__summary-tools">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="oc-spanel__summary-tool"
                        onClick={() => void copySummary()}
                        title={m.spanel_summary_copy()}
                        aria-label={m.spanel_summary_copy()}
                      >
                        {summaryCopied ? (
                          <Check size={14} aria-hidden />
                        ) : (
                          <Copy size={14} aria-hidden />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="oc-spanel__summary-tool"
                        onClick={() => setSummaryExpanded(true)}
                        title={m.spanel_summary_expand()}
                        aria-label={m.spanel_summary_expand()}
                      >
                        <Maximize2 size={14} aria-hidden />
                      </Button>
                      {!summaryInfo.jobInFlight ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="oc-spanel__summary-tool"
                          onClick={() => {
                            // Edit happens in the READING dialog (real space).
                            setSummaryDraft(summaryInfo.summary);
                            setSummaryExpanded(true);
                          }}
                          title={m.spanel_summary_edit()}
                          aria-label={m.spanel_summary_edit()}
                        >
                          <Pencil size={14} aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                    <div className="oc-spanel__summary">
                      {summaryInfo.summary}
                    </div>
                  </>
                ) : summaryInfo && summaryInfo.failureCount > 0 ? (
                  <p className="oc-spanel__hint oc-spanel__hint--warn">
                    {m.spanel_summary_failing({
                      count: String(summaryInfo.failureCount),
                    })}
                  </p>
                ) : summaryInfo?.jobInFlight ? null : (
                  <p className="oc-spanel__hint">{m.spanel_summary_none()}</p>
                )}
              </section>
            </>
          )}
        </div>
        <Dialog
          open={summaryExpanded}
          onOpenChange={(open) => {
            setSummaryExpanded(open);
            if (!open) {
              // Closing the dialog abandons an unsaved draft.
              setSummaryDraft(null);
              setSummarySaveState("idle");
            }
          }}
        >
          <DialogContent className="oc-summary-dialog">
            <DialogHeader>
              <DialogTitle>{m.spanel_section_summary()}</DialogTitle>
              <DialogDescription>
                {summaryDraft !== null
                  ? m.spanel_summary_edit_help()
                  : summaryInfo && summaryInfo.summary.length > 0
                    ? m.spanel_summary_meta({
                        count: String(summaryInfo.coveredCount),
                        date: new Intl.DateTimeFormat(undefined, {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(summaryInfo.updatedAt)),
                      })
                    : ""}
              </DialogDescription>
            </DialogHeader>
            {summaryDraft !== null ? (
              <textarea
                className="oc-summary-dialog__body oc-summary-dialog__edit"
                value={summaryDraft}
                onChange={(e) => setSummaryDraft(e.target.value)}
              />
            ) : (
              <div className="oc-summary-dialog__body">
                {summaryInfo?.summary ?? ""}
              </div>
            )}
            {summarySaveState === "error" ? (
              <p className="oc-spanel__hint oc-spanel__hint--warn">
                {m.spanel_summary_save_error()}
              </p>
            ) : null}
            <div className="oc-summary-dialog__actions">
              {summaryDraft !== null ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSummaryDraft(null);
                      setSummarySaveState("idle");
                    }}
                  >
                    {m.chat_cancel()}
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      summaryDraft.trim().length === 0 ||
                      summarySaveState === "saving"
                    }
                    onClick={() => void saveSummaryDraft()}
                  >
                    {summarySaveState === "saving"
                      ? m.conf_applying()
                      : m.spanel_summary_save()}
                  </Button>
                </>
              ) : (
                <>
                  {summaryInfo &&
                  summaryInfo.summary.length > 0 &&
                  !summaryInfo.jobInFlight ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSummaryDraft(summaryInfo.summary)}
                    >
                      <Pencil size={14} aria-hidden />
                      {m.spanel_summary_edit()}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void copySummary()}
                  >
                    {summaryCopied ? (
                      <Check size={14} aria-hidden />
                    ) : (
                      <Copy size={14} aria-hidden />
                    )}
                    {m.spanel_summary_copy()}
                  </Button>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
        <SheetFooter className="oc-spanel__actions">
          <h3 className="oc-spanel__cat">{m.spanel_section_actions()}</h3>
          {can("sessionCompact") ? (
            <ActionRow
              label={m.spanel_compact()}
              state={compactState}
              onClick={() => void onCompact()}
              onRetry={() => void runCompact()}
            />
          ) : null}
          <ActionRow
            label={m.spanel_generate_summary()}
            state={jobRunning ? "pending" : summarizeState}
            onClick={() => void runSummarize()}
            onRetry={() => void runSummarize()}
          />
          {summarizeNotice !== null ? (
            <p className="oc-spanel__hint">{summarizeNotice}</p>
          ) : null}
          <ActionRow
            label={m.spanel_reset()}
            state={resetState}
            destructive
            onClick={() => void onReset()}
            onRetry={() => void runReset()}
          />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
