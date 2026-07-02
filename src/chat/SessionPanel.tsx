import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { LoaderCircle } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
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
  const [compactState, setCompactState] = useState<ActionState>("idle");
  const [resetState, setResetState] = useState<ActionState>("idle");

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
            </>
          )}
        </div>
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
