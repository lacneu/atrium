import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cpu,
  Download,
  Flag,
  Gauge,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  Plus,
  SendHorizonal,
  SlidersHorizontal,
  Split,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatNumber } from "@/lib/format";
import { m } from "@/paraglide/messages.js";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ActivityRow } from "./ActivityRow";
import { AgentMarkdown } from "./MarkdownText";
import { ToolCard } from "./ToolCard";
import {
  SubAgentReportDialog,
  type SubAgentReportTarget,
} from "./SubAgentReportDialog";
import {
  buildSubAgentExportJson,
  buildSubAgentExportMarkdown,
  subAgentExportFilename,
} from "./subAgentExport";
import {
  subAgentKindLabel,
  buildSubAgentActivityView,
  formatCostUsd,
  formatRuntime,
  isReportableSubAgent,
  isSubAgentSessionArchived,
  isForkedSubAgentCopy,
  shortenSubAgentError,
  type SubAgentCardView,
  type SubAgentRow,
  type SubAgentSessionMeta,
  type SubAgentTelemetry,
} from "./subAgentActivityView";

/** Scroll the PRIMARY thread to the assistant message that spawned this sub-agent
 *  and flash it (reuses the `oc-msg--highlight` keyframe). `block:"start"` aligns the
 *  message TOP to the viewport top (the viewport sits BELOW the app + chat header
 *  bars, and `.oc-msg`'s scroll-margin-top adds a gap) so the spawning message lands
 *  fully visible, not centered with its top hidden under the bars. No-op if the
 *  message is outside the loaded window (no anchor in the DOM). */
function scrollToSpawnMessage(messageId: string): void {
  const el = document.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`,
  );
  if (!el) return;
  // Scroll ONLY the thread's own viewport. `scrollIntoView()` walks UP the DOM and
  // scrolls EVERY scrollable ancestor to reveal the target — which also shifted the
  // right sub-agent panel (a shared ancestor scrolled). Targeting the thread viewport
  // directly moves the conversation alone; the panel never budges.
  const viewport = el.closest<HTMLElement>(".oc-thread__viewport");
  if (viewport) {
    const delta =
      el.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollTo({ top: viewport.scrollTop + delta - 12, behavior: "smooth" });
  } else {
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  el.classList.remove("oc-msg--highlight");
  void el.offsetWidth; // reflow so re-adding restarts the animation
  el.classList.add("oc-msg--highlight");
  window.setTimeout(() => el.classList.remove("oc-msg--highlight"), 2400);
}

/** Trigger a client-side download of a text file (the sub-agent export). */
function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// The SECONDARY-CONVERSATION panel: a sub-agent's full detail in the resizable
// RIGHT column (the Sources-panel slot pattern) while the primary thread stays
// live on the left. Opened from the in-thread card via SubAgentPanelContext. Tools
// render like a main-agent turn (ToolActivity-style: collapsed summary → list);
// the result is collapsible + markdown; a footer affordance opens a prompt zone
// (the steer/send interaction — wiring is a later phase).
export interface SubAgentPanelApi {
  /** The childSessionKey of the open sub-agent (null = closed) — also drives the
   *  in-thread card's "currently detailed" highlight (the visual breadcrumb). */
  activeChildKey: string | null;
  openFor: (childKey: string) => void;
  close: () => void;
}
export const SubAgentPanelContext = createContext<SubAgentPanelApi | null>(null);

/** The header status line: a presence icon/spinner + the localized state. */
function HeaderStatus({ card }: { card: SubAgentCardView }) {
  const label =
    card.tone === "running"
      ? m.subagents_status_running()
      : card.tone === "failed"
        ? m.subagents_status_failed()
        : m.subagents_status_done();
  return (
    <span className={`oc-subpanel__status oc-subpanel__status--${card.tone}`}>
      {label}
      {card.tone === "running" ? (
        <LoaderCircle size={13} className="oc-subagent__spin" aria-hidden />
      ) : card.tone === "failed" ? (
        <CircleAlert size={13} aria-hidden />
      ) : (
        <Check size={13} aria-hidden />
      )}
    </span>
  );
}

/** One fetched per-tool detail row (convex subAgentToolParts). */
type SubAgentToolPartRow = {
  _id: string;
  toolCallId: string;
  name: string;
  status: "running" | "done" | "error";
  argsText?: string;
  resultText?: string;
};

/** One user<->sub-agent interaction (2c): the user's message + the child's reply. */
type SubAgentInteractionRow = {
  _id: string;
  userText: string;
  attachments?: Array<{ filename: string; mimeType: string }>;
  replyText?: string;
  status: "pending" | "done" | "error";
  errorMessage?: string;
};

/** Parse stored args JSON back to an object so ToolCard can derive its keyed one-line
 *  preview (command/query/url). Falls back to undefined on truncated/non-JSON args —
 *  the raw text still shows in the input block. */
function parseArgs(argsText: string | undefined): unknown {
  if (!argsText) return undefined;
  try {
    return JSON.parse(argsText);
  } catch {
    return undefined;
  }
}

/** A per-tool detail status -> the assistant-ui ToolCard phase its renderer expects. */
function toolCardStatus(status: SubAgentToolPartRow["status"]): { type: string } {
  return {
    type:
      status === "error" ? "error" : status === "done" ? "completed" : "running",
  };
}

/** The (childSessionKey, toolCallId) join key — matches the observer's, so a summary
 *  tool with no real id (`undefined`) correlates to its detail row keyed `name:<name>`. */
function toolJoinKey(t: { name: string; toolCallId?: string }): string {
  return t.toolCallId ?? `name:${t.name}`;
}

/** Tools, rendered IDENTICALLY to a MAIN-agent turn: the SAME `ActivityRow` chrome
 *  (Wrench + "N tool calls" + status + chevron-at-the-edge) collapsed by default →
 *  click to reveal real `ToolCard`s (name + input + output), the SAME component the
 *  main agent uses. ONE card per AUTHORITATIVE summary tool (so the card count can
 *  never disagree with the collapsed count); the args/result DETAIL is looked up by
 *  toolCallId from the on-demand fetch and fills in reactively as it streams. */
function PanelTools({
  summary,
  parts,
  subAgentRunning,
}: {
  summary: ReadonlyArray<{
    name: string;
    status: "running" | "done";
    toolCallId?: string;
  }>;
  parts: SubAgentToolPartRow[] | undefined;
  subAgentRunning: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Mirror the main agent's ToolActivity, which shows the in-progress spinner the
  // WHOLE time the turn streams (from the message status) — not just while a tool is
  // mid-call. So the summary spins while the SUB-AGENT is running, even BETWEEN tool
  // calls (when every captured tool is momentarily "done"); a stale check there would
  // read as "finished" when the sub-agent is still working.
  // A tool stuck "running" on a SETTLED card (lost completion event) must not
  // spin forever: once the sub-agent settled, nothing here is running anymore.
  const running = subAgentRunning;
  const label =
    summary.length === 1
      ? m.tools_activity_count({ count: summary.length })
      : m.tools_activity_count_plural({ count: summary.length });
  const trailing = running ? (
    <>
      <LoaderCircle
        size={13}
        className="oc-actrow__status-icon oc-actrow__spin"
        aria-hidden
      />
      {m.tools_activity_running()}
    </>
  ) : (
    <>
      <Check size={13} className="oc-actrow__status-icon" aria-hidden />
      <span className="oc-sr-only">{m.tools_activity_done()}</span>
    </>
  );
  const detailByKey = new Map<string, SubAgentToolPartRow>();
  for (const p of parts ?? []) detailByKey.set(p.toolCallId, p);
  return (
    <div className="oc-toolact">
      <ActivityRow
        icon={<Wrench size={14} />}
        label={label}
        trailing={trailing}
        open={open}
        ariaExpanded={open}
        title={open ? m.tools_activity_collapse() : m.tools_activity_expand()}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <div className="oc-toolact__detail">
          {summary.map((t, i) => {
            const detail = detailByKey.get(toolJoinKey(t));
            return (
              <ToolCard
                key={`${toolJoinKey(t)}-${i}`}
                toolName={t.name}
                args={detail ? parseArgs(detail.argsText) : undefined}
                argsText={detail?.argsText}
                result={detail?.resultText}
                status={toolCardStatus(detail?.status ?? t.status)}
                turnSettled={!subAgentRunning}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** The sub-agent SESSION BAR (Phase 2b): read-only chips (model / reasoning / speed)
 *  + the parent agent, with an "Advanced" toggle revealing the full static config.
 *  Mirrors the main chat header's chip language. Renders the reserved empty band
 *  until the first session frame populates the meta, so the layout never jumps. */
function SubAgentSessionBar({
  meta,
  telemetry,
  childAgentId,
  instanceName,
  parentAgentLabel,
  onExport,
}: {
  meta: SubAgentSessionMeta | undefined;
  telemetry?: SubAgentTelemetry;
  childAgentId?: string;
  /** The gateway instance the child runs on (= the parent chat's instance). */
  instanceName?: string;
  parentAgentLabel?: string;
  onExport?: (format: "md" | "json") => void;
}) {
  const [advOpen, setAdvOpen] = useState(false);
  // ANY captured field opens the Advanced detail — derived (not an enumerated field
  // list) so a newly-captured param can never be silently unreachable (codex P2:
  // a spawn that only carried label/agentId/… would otherwise never show the button).
  const hasMeta =
    (!!meta && Object.values(meta).some((v) => v !== undefined)) ||
    (!!telemetry && Object.values(telemetry).some((v) => v !== undefined)) ||
    childAgentId !== undefined;
  if (!hasMeta && !parentAgentLabel && !onExport) {
    return <div className="oc-subpanel__barslot" aria-hidden />;
  }
  const speed =
    meta?.fastMode === undefined
      ? null
      : meta.fastMode
        ? m.subagent_bar_fast()
        : m.subagent_bar_standard();
  return (
    <div className="oc-subpanel__bar">
      <div className="oc-subpanel__bar-chips">
        {meta?.model ? (
          <span
            className="oc-chip oc-chip--info"
            title={
              meta.modelProvider
                ? m.chat_model_with_provider({ provider: meta.modelProvider })
                : m.subagent_bar_model()
            }
          >
            <Cpu size={12} aria-hidden />
            <span className="oc-chip__label">{meta.model}</span>
          </span>
        ) : null}
        {meta?.thinkingLevel ? (
          <span className="oc-chip" title={m.subagent_bar_reasoning()}>
            <Brain size={12} aria-hidden />
            <span className="oc-chip__label">{meta.thinkingLevel}</span>
          </span>
        ) : null}
        {speed ? (
          <span className="oc-chip" title={m.subagent_bar_speed()}>
            <Gauge size={12} aria-hidden />
            <span className="oc-chip__label">{speed}</span>
          </span>
        ) : null}
        {meta?.context ? (
          <span
            className="oc-chip"
            title={
              meta.context === "fork"
                ? m.subagent_bar_context_fork_hint()
                : m.subagent_bar_context()
            }
          >
            <Split size={12} aria-hidden />
            <span className="oc-chip__label">{meta.context}</span>
          </span>
        ) : null}
        {parentAgentLabel ? (
          <span className="oc-chip" title={m.subagent_bar_parent()}>
            <Bot size={12} aria-hidden />
            <span className="oc-chip__label">{parentAgentLabel}</span>
          </span>
        ) : null}
        {onExport ? (
          // The SAME choice set as the conversation's Exporter menu (md | json),
          // in the same dropdown idiom — one export language across the app.
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="oc-chip oc-chip--btn oc-subpanel__bar-export"
                title={m.subagent_panel_export_hint()}
              >
                <Download size={12} aria-hidden />
                <span className="oc-chip__label">
                  {m.subagent_panel_export()}
                </span>
                <ChevronDown size={12} className="oc-chip__chev" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>{m.subagent_panel_export()}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onExport("md")}>
                {m.chat_export_markdown()}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("json")}>
                {m.chat_export_json()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {hasMeta ? (
        <button
          type="button"
          className={`oc-subpanel__adv-toggle${advOpen ? " is-open" : ""}`}
          aria-expanded={advOpen}
          onClick={() => setAdvOpen((o) => !o)}
        >
          <SlidersHorizontal size={13} aria-hidden />
          {m.subagent_bar_advanced()}
          <ChevronRight
            size={13}
            className="oc-subpanel__adv-chevron"
            aria-hidden
          />
        </button>
      ) : null}
      {advOpen && hasMeta ? (
        <AdvancedMeta
          meta={meta ?? {}}
          telemetry={telemetry}
          childAgentId={childAgentId}
          instanceName={instanceName}
        />
      ) : null}
    </div>
  );
}

/** The "Advanced" detail: every captured static field, labeled. The isolation/scope
 *  fields (controlScope / role / depth) are shown RAW — never collapsed into a guessed
 *  "isolated" boolean (there is no such field; the real flag may live in the spawn
 *  args we do not capture). */
/** What a sub-agent CAN/CANNOT do, DERIVED from its role (the reliable, always-present
 *  field — the doc: a `leaf` never spawns; an `orchestrator` can delegate). null for an
 *  unknown role (the raw Role row still shows it). */
function subAgentCapability(role: string | undefined): string | null {
  if (role === "leaf") return m.subagent_cap_leaf();
  if (role === "orchestrator") return m.subagent_cap_orchestrator();
  return null;
}

function AdvancedMeta({
  meta,
  telemetry,
  childAgentId,
  instanceName,
}: {
  meta: SubAgentSessionMeta;
  telemetry?: SubAgentTelemetry;
  childAgentId?: string;
  /** The gateway instance the child runs on (= the parent chat's instance). */
  instanceName?: string;
}) {
  const rows: Array<[string, string]> = [];
  if (meta.model) rows.push([m.subagent_bar_model(), meta.model]);
  if (meta.modelProvider)
    rows.push([m.subagent_bar_provider(), meta.modelProvider]);
  // The agent the CHILD runs AS (spawn agentId / derived from the session key) —
  // differs from the parent chip when the spawn delegated to another agent.
  const childAgent = meta.agentId ?? childAgentId;
  if (childAgent) rows.push([m.subagent_bar_agent(), childAgent]);
  if (instanceName) rows.push([m.spanel_agent_instance(), instanceName]);
  if (meta.label) rows.push([m.subagent_bar_label(), meta.label]);
  if (meta.thinkingLevel)
    rows.push([m.subagent_bar_reasoning(), meta.thinkingLevel]);
  if (meta.fastMode !== undefined)
    rows.push([
      m.subagent_bar_speed(),
      meta.fastMode ? m.subagent_bar_fast() : m.subagent_bar_standard(),
    ]);
  // Spawn-time config — rendered ONLY when the spawn actually set it (never a
  // fabricated default; `context` in particular is usually absent).
  if (meta.context) rows.push([m.subagent_bar_context(), meta.context]);
  if (meta.lightContext !== undefined)
    rows.push([
      m.subagent_bar_light_context(),
      meta.lightContext ? m.subagent_bar_light_on() : m.subagent_bar_light_off(),
    ]);
  if (meta.runtime) rows.push([m.subagent_bar_runtime(), meta.runtime]);
  if (meta.mode) rows.push([m.subagent_bar_mode(), meta.mode]);
  if (meta.cleanup) rows.push([m.subagent_bar_cleanup(), meta.cleanup]);
  if (meta.sandbox) rows.push([m.subagent_bar_sandbox(), meta.sandbox]);
  if (meta.controlScope) rows.push([m.subagent_bar_scope(), meta.controlScope]);
  if (meta.subagentRole) rows.push([m.subagent_bar_role(), meta.subagentRole]);
  if (meta.spawnDepth !== undefined)
    rows.push([m.subagent_bar_depth(), String(meta.spawnDepth)]);
  const capability = subAgentCapability(meta.subagentRole);
  if (capability) rows.push([m.subagent_bar_capability(), capability]);
  if (meta.sessionId) rows.push([m.subagent_bar_session_id(), meta.sessionId]);
  if (meta.gatewayKind) rows.push([m.subagent_bar_gateway(), meta.gatewayKind]);
  // Run telemetry — live-ish while running (heartbeat cadence), final once settled.
  if (telemetry?.runtimeMs !== undefined) {
    const v = formatRuntime(telemetry.runtimeMs);
    if (v) rows.push([m.subagent_tel_runtime(), v]);
  }
  if (telemetry?.totalTokens !== undefined)
    rows.push([m.subagent_tel_tokens(), formatNumber(telemetry.totalTokens)]);
  if (telemetry?.estimatedCostUsd !== undefined) {
    // The gateway computes a child's cost at SETTLE (persist), not live: a child
    // that overflowed/failed streams its tokens but never its final cost, so we
    // receive 0. Showing "0,00 $" beside a real token count is misleading (it was
    // not free) — surface it as UNREPORTED instead of a fake zero. A genuine
    // zero-token child (no work) keeps "0,00 $".
    const hasTokens =
      typeof telemetry.totalTokens === "number" && telemetry.totalTokens > 0;
    if (telemetry.estimatedCostUsd <= 0 && hasTokens) {
      rows.push([m.subagent_tel_cost(), m.subagent_tel_cost_unreported()]);
    } else {
      const v = formatCostUsd(telemetry.estimatedCostUsd);
      if (v) rows.push([m.subagent_tel_cost(), v]);
    }
  }
  return (
    <dl className="oc-subpanel__adv-list">
      {rows.map(([label, value]) => (
        <div key={label} className="oc-subpanel__adv-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SubAgentPanelContent({
  chatId,
  childKey,
  onClose,
  parentAgentLabel,
}: {
  chatId: string;
  childKey: string;
  onClose: () => void;
  parentAgentLabel?: string;
}) {
  const rows = useQuery(api.subAgents.listSubAgents, {
    chatId: chatId as Id<"chats">,
  }) as SubAgentRow[] | undefined;
  // The child runs on the PARENT chat's gateway instance by construction — but a
  // per-turn ROUTED chat can switch instances between turns, so the chat-level
  // instance is only trustworthy when per-turn routing is OFF (else omit the row
  // rather than risk naming the wrong gateway).
  const chatAgentInfo = useQuery(api.agents.getChatAgent, {
    chatId: chatId as Id<"chats">,
  });
  const chatMeta = useQuery(api.messages.getSessionMeta, { chatId });
  const instanceForChild =
    chatMeta?.perTurnRouting === true
      ? undefined
      : chatAgentInfo?.agent?.instanceName;
  const row = (rows ?? []).find((r) => r.childSessionKey === childKey);
  const card = row ? buildSubAgentActivityView([row]).cards[0] : undefined;
  const taskName = row?.taskName?.trim();
  // A terminal `cleanup: "delete"` child has no gateway session left to talk to —
  // the interaction composer disables with an explicit reason (pure, unit-tested).
  const sessionArchived = isSubAgentSessionArchived(card);
  // A card COPIED by a chat branch (fork: key prefix) is display-only: its
  // session belongs to the SOURCE chat — interact there, not from the copy.
  const forkedCopy = isForkedSubAgentCopy(childKey);
  // Which sub-agents the user already reported (drives the report button's
  // already-flagged state) — owner-scoped, Convex-deduped across consumers.
  const reportedIds = useQuery(api.subAgentReports.myReportedSubAgentIds, {
    chatId: chatId as Id<"chats">,
  }) as string[] | undefined;
  // The per-tool DETAIL (args + result), fetched ON DEMAND now the panel is open
  // (the Sources-panel pattern) — kept off the always-loaded list to avoid the
  // many-tool re-push. Rendered as real ToolCards, identical to the main agent.
  const toolParts = useQuery(api.subAgents.listSubAgentToolParts, {
    chatId: chatId as Id<"chats">,
    childSessionKey: childKey,
  }) as SubAgentToolPartRow[] | undefined;
  // 2c: the user's interaction thread with this sub-agent (live).
  const interactions = useQuery(
    api.subAgentInteractions.listSubAgentInteractions,
    { chatId: chatId as Id<"chats">, childSessionKey: childKey },
  ) as SubAgentInteractionRow[] | undefined;
  const sendToSubAgent = useAction(api.subAgentInteractions.sendToSubAgent);
  const generateUploadUrl = useMutation(api.chats.generateUploadUrl);
  const registerUpload = useMutation(api.uploads.registerUpload);
  const [sending, setSending] = useState(false);
  // Result expanded by default (it IS the answer); collapsible. Prompt zone closed.
  const [resultOpen, setResultOpen] = useState(true);
  const [promptOpen, setPromptOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [taskExpanded, setTaskExpanded] = useState(false);
  // Files staged for the NEXT interaction message (uploaded to storage, owner-
  // registered; the storageId is resolved to base64 server-side on send).
  const [attachments, setAttachments] = useState<
    Array<{ storageId: string; filename: string; mimeType: string }>
  >([]);
  const [uploading, setUploading] = useState(false);
  // The "Outils" composer button toggles THIS section (per design) — the panel's
  // tool detail, the local analog of the main composer's clean/analysis toggle.
  const [toolsSectionOpen, setToolsSectionOpen] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const MAX_ATTACHMENTS = 6;

  // Upload each picked file to storage, register ownership (IDOR gate), and stage it.
  const onPickFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      try {
        for (const file of Array.from(files)) {
          if (attachments.length >= MAX_ATTACHMENTS) break;
          const url = await generateUploadUrl();
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": file.type || "application/octet-stream" },
            body: file,
          });
          const { storageId } = (await res.json()) as { storageId: string };
          await registerUpload({ storageId: storageId as Id<"_storage"> });
          setAttachments((prev) =>
            prev.length >= MAX_ATTACHMENTS
              ? prev
              : [
                  ...prev,
                  {
                    storageId,
                    filename: file.name,
                    mimeType: file.type || "application/octet-stream",
                  },
                ],
          );
        }
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [attachments.length, generateUploadUrl, registerUpload],
  );
  const [reportTarget, setReportTarget] = useState<SubAgentReportTarget | null>(
    null,
  );
  const alreadyReported = card ? (reportedIds ?? []).includes(card.id) : false;

  // Export the sub-agent transcript (moved beside the session chips) — the SAME
  // format choices as the conversation export (Markdown | JSON). Prefers the
  // on-demand tool DETAIL (args + results) when loaded, else the summary tool list.
  const doExport = useCallback(
    (format: "md" | "json") => {
      if (!card) return;
      const exportTools =
        toolParts && toolParts.length > 0
          ? toolParts.map((p) => ({
              name: p.name,
              status: p.status,
              argsText: p.argsText,
              resultText: p.resultText,
            }))
          : (card.tools ?? []).map((t) => ({ name: t.name, status: t.status }));
      const input = {
        taskName,
        status: card.status,
        parentAgentLabel,
        sessionMeta: card.sessionMeta,
        telemetry: card.telemetry,
        result: card.resultText,
        error: card.failure ? shortenSubAgentError(card.errorMessage) : undefined,
        tools: exportTools,
      };
      downloadTextFile(
        subAgentExportFilename(taskName, format),
        format === "md"
          ? buildSubAgentExportMarkdown(input)
          : buildSubAgentExportJson({ ...input, exportedAt: Date.now() }),
      );
    },
    [card, toolParts, taskName, parentAgentLabel],
  );

  // Escape closes the panel — a reliable second way out beside the header's X (the X
  // can scroll out of reach on a long result / narrow window). Scoped to the panel's
  // lifetime; a captured handler so a focused textarea's Escape still closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Retry/regenerate deletes the spawning turn AND cascade-purges its sub-agents
  // (convex/messages.deleteMessage), so the viewed child's session no longer exists.
  // Once the list has LOADED (rows !== undefined) and the row is gone, close the panel
  // rather than sit on a stale/loading shell. (rows === undefined = still loading.)
  useEffect(() => {
    if (rows !== undefined && !row) onClose();
  }, [rows, row, onClose]);

  // Auto-scroll the panel body to the newest exchange — when a message is SENT (a new
  // pending row) AND when its async gateway reply LANDS (the last row's status flips).
  // Keeps the last message + its reply in view, like the main composer scrolls the
  // thread on send. Keyed so it fires on BOTH events, not on unrelated re-renders.
  const lastInteractionKey =
    interactions && interactions.length > 0
      ? `${interactions.length}:${interactions[interactions.length - 1]!.status}`
      : "";
  useEffect(() => {
    if (!lastInteractionKey) return;
    const el = bodyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lastInteractionKey]);

  // 2c send: dispatch the user's message (+ any staged files) to the sub-agent
  // (chat.send to the child); the reply arrives async into the interaction thread.
  // A message may be text-only OR file-only. Clears the draft + strip on accept.
  const doSend = async () => {
    const text = draft.trim();
    // Same guard as the disabled button — Enter in the textarea calls doSend()
    // directly, so an archived session must be refused HERE too (codex P2).
    if (sessionArchived || forkedCopy) return;
    if ((!text && attachments.length === 0) || sending || uploading) return;
    setSending(true);
    try {
      await sendToSubAgent({
        chatId: chatId as Id<"chats">,
        childSessionKey: childKey,
        text,
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                storageId: a.storageId as Id<"_storage">,
                filename: a.filename,
                mimeType: a.mimeType,
              })),
            }
          : {}),
      });
      setDraft("");
      setAttachments([]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="oc-subpanel">
      <header className="oc-subpanel__head">
        {/* The header tile is a BACK button: it jumps to the spawning message (the old
            "Remonter au message" action) — so the icon reads as a back affordance, not
            an agent avatar. Disabled when the parent message id is unknown. It stays
            top-left (aligned with the title row) even when the prompt expands below. */}
        <button
          type="button"
          className={`oc-subpanel__avatar oc-subpanel__back${
            card ? ` oc-subpanel__avatar--${card.tone}` : ""
          }`}
          disabled={!row?.parentMessageId}
          title={m.subagent_panel_jump_hint()}
          aria-label={m.subagent_panel_jump()}
          onClick={() =>
            row?.parentMessageId && scrollToSpawnMessage(row.parentMessageId)
          }
        >
          <ArrowLeft size={16} />
        </button>
        <div className="oc-subpanel__headmain">
          {/* Title ROW: kind + the controls (report / status / close), all vertically
              centered on ONE line so they align coherently. The prompt sits BELOW. */}
          <div className="oc-subpanel__head-top">
            <span className="oc-subpanel__kind">
              {card ? subAgentKindLabel(card) : m.subagent_panel_kind()}
            </span>
            <div className="oc-subpanel__head-ctrls">
              {/* Status BEFORE the report flag (order per design). */}
              {card ? <HeaderStatus card={card} /> : null}
              {/* Report THIS sub-agent (not a message) — same small icon-button as the
                  message feedback flag. */}
              {card && isReportableSubAgent(card.status) ? (
                <button
                  type="button"
                  className={`oc-iconbtn oc-subpanel__report${
                    alreadyReported ? " is-on" : ""
                  }`}
                  title={
                    alreadyReported
                      ? m.subagentreport_btn_reported()
                      : m.subagent_panel_report()
                  }
                  aria-label={m.subagent_panel_report()}
                  disabled={alreadyReported}
                  onClick={() =>
                    setReportTarget({ subAgentId: card.id, label: card.label })
                  }
                >
                  <Flag size={15} aria-hidden />
                </button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label={m.subagent_panel_close()}
                className="oc-subpanel__close"
              >
                <X size={16} />
              </Button>
            </div>
          </div>
          {taskName ? (
            // The task IS the sub-agent's prompt — click to see it in FULL (clamped to
            // one line by default). It expands DOWNWARD; the row above stays put.
            <button
              type="button"
              className={`oc-subpanel__task${taskExpanded ? " is-expanded" : ""}`}
              title={m.subagent_panel_task_toggle()}
              aria-expanded={taskExpanded}
              onClick={() => setTaskExpanded((v) => !v)}
            >
              {taskName}
            </button>
          ) : null}
        </div>
      </header>

      {/* The sub-agent SESSION BAR (Phase 2b): model / reasoning / speed chips + the
          parent agent + an Advanced toggle (scope / role / depth). Holds the reserved
          empty band until the first session frame fills it (no layout jump). */}
      <SubAgentSessionBar
        meta={card?.sessionMeta}
        telemetry={card?.telemetry}
        childAgentId={card?.childAgentId}
        instanceName={instanceForChild}
        parentAgentLabel={parentAgentLabel}
        onExport={card ? doExport : undefined}
      />

      <div className="oc-subpanel__body" ref={bodyRef}>
        {!card ? (
          <p className="oc-subpanel__muted">{m.subagent_panel_loading()}</p>
        ) : (
          <>
            {card.tools && card.tools.length > 0 && toolsSectionOpen ? (
              <section className="oc-subpanel__section">
                <h3 className="oc-subpanel__section-title">
                  {m.subagent_panel_tools()}
                </h3>
                <PanelTools
                  summary={card.tools}
                  parts={toolParts}
                  subAgentRunning={card.tone === "running"}
                />
              </section>
            ) : null}

            {card.failure ? (
              <section className="oc-subpanel__section">
                <h3 className="oc-subpanel__section-title">
                  {m.subagent_panel_error()}
                </h3>
                <p className="oc-subpanel__error">
                  {shortenSubAgentError(card.errorMessage)}
                </p>
              </section>
            ) : null}

            {card.resultText ? (
              <section
                className={`oc-subpanel__section oc-subpanel__result${
                  resultOpen ? " is-open" : ""
                }`}
              >
                <button
                  type="button"
                  className="oc-subpanel__result-toggle"
                  aria-expanded={resultOpen}
                  onClick={() => setResultOpen(!resultOpen)}
                >
                  <ChevronRight
                    size={13}
                    className="oc-subpanel__result-chevron"
                    aria-hidden
                  />
                  <span className="oc-subpanel__section-title">
                    {m.subagent_panel_result()}
                  </span>
                </button>
                {resultOpen ? <AgentMarkdown text={card.resultText} /> : null}
              </section>
            ) : card.tone === "running" ? (
              <p className="oc-subpanel__muted oc-subpanel__working">
                <LoaderCircle
                  size={14}
                  className="oc-subagent__spin"
                  aria-hidden
                />
                {m.subagent_panel_running()}
              </p>
            ) : null}

            {/* 2c: the user's INTERACTION thread with this sub-agent — each message
                + the child's reply (pending / markdown reply / error), live. */}
            {interactions && interactions.length > 0 ? (
              <section className="oc-subpanel__section">
                <h3 className="oc-subpanel__section-title">
                  {m.subagent_interact_thread()}
                </h3>
                <div className="oc-subpanel__thread">
                  {interactions.map((it) => (
                    <div key={it._id} className="oc-subpanel__exchange">
                      <div className="oc-subpanel__msg oc-subpanel__msg--user">
                        {it.userText}
                        {it.attachments && it.attachments.length > 0 ? (
                          <div className="oc-subpanel__msg-atts">
                            {it.attachments.map((a, i) => (
                              <span
                                key={`${it._id}-att-${i}`}
                                className="oc-subpanel__attchip oc-subpanel__attchip--sent"
                                title={a.filename}
                              >
                                <Paperclip size={11} aria-hidden />
                                <span className="oc-subpanel__attchip-name">
                                  {a.filename}
                                </span>
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      {it.status === "pending" ? (
                        <div className="oc-subpanel__msg oc-subpanel__msg--pending">
                          <LoaderCircle
                            size={13}
                            className="oc-actrow__spin"
                            aria-hidden
                          />
                          {m.subagent_interact_pending()}
                        </div>
                      ) : it.status === "error" ? (
                        <div className="oc-subpanel__msg oc-subpanel__msg--err">
                          {it.errorMessage ?? m.subagent_interact_error()}
                        </div>
                      ) : (
                        <div className="oc-subpanel__msg oc-subpanel__msg--reply">
                          <AgentMarkdown text={it.replyText ?? ""} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>

      {/* Prompt zone: a message box to talk to the sub-agent directly (2c). The send
          dispatches a chat.send to the child session; the reply streams back into the
          thread above. Enter sends (Shift+Enter = newline). */}
      <footer className="oc-subpanel__foot">
        {promptOpen ? (
          <div className="oc-subpanel__prompt">
            {/* Staged files (uploaded + owner-registered) — removable before send. */}
            {attachments.length > 0 ? (
              <div className="oc-subpanel__attstrip">
                {attachments.map((a, i) => (
                  <span
                    key={`${a.storageId}-${i}`}
                    className="oc-subpanel__attchip"
                    title={a.filename}
                  >
                    <Paperclip size={12} aria-hidden />
                    <span className="oc-subpanel__attchip-name">
                      {a.filename}
                    </span>
                    <button
                      type="button"
                      className="oc-subpanel__attchip-x"
                      aria-label={m.subagent_composer_remove_file()}
                      onClick={() =>
                        setAttachments((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <X size={11} aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <textarea
              className="oc-subpanel__prompt-input"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void doSend();
                }
              }}
              placeholder={m.subagent_panel_prompt_placeholder()}
              autoFocus
            />
            <div className="oc-subpanel__prompt-bar">
              {/* Attach (+) and the Outils toggle on the LEFT, mirroring the main
                  composer's action bar; the send button on the RIGHT. */}
              <div className="oc-subpanel__composer-actions">
                <button
                  type="button"
                  className="oc-subpanel__composer-btn"
                  title={m.subagent_composer_attach()}
                  aria-label={m.subagent_composer_attach()}
                  disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? (
                    <LoaderCircle
                      size={15}
                      className="oc-actrow__spin"
                      aria-hidden
                    />
                  ) : (
                    <Plus size={15} aria-hidden />
                  )}
                </button>
                {card?.tools && card.tools.length > 0 ? (
                  <button
                    type="button"
                    className={`oc-subpanel__composer-btn oc-subpanel__composer-btn--label${
                      toolsSectionOpen ? " is-on" : ""
                    }`}
                    title={m.subagent_composer_tools_hint()}
                    aria-pressed={toolsSectionOpen}
                    onClick={() => setToolsSectionOpen((v) => !v)}
                  >
                    <Wrench size={14} aria-hidden />
                    {m.subagent_panel_tools()}
                  </button>
                ) : null}
              </div>
              {/* Steering a RUNNING sub-agent is not yet verified (gated server-side),
                  and one interaction at a time per child — surface WHY send is off.
                  A `cleanup: "delete"` child is ARCHIVED by the gateway right after
                  its announce, so once terminal there is no session left to talk to. */}
              {card?.tone === "running" ? (
                <span className="oc-subpanel__prompt-hint">
                  {m.subagent_interact_wait_running()}
                </span>
              ) : forkedCopy ? (
                <span className="oc-subpanel__prompt-hint">
                  {m.subagent_interact_forked_copy()}
                </span>
              ) : sessionArchived ? (
                <span className="oc-subpanel__prompt-hint">
                  {m.subagent_interact_archived()}
                </span>
              ) : (interactions ?? []).some((it) => it.status === "pending") ? (
                <span className="oc-subpanel__prompt-hint">
                  {m.subagent_interact_wait_pending()}
                </span>
              ) : null}
              <Button
                variant="default"
                size="sm"
                className="gap-1.5"
                disabled={
                  (!draft.trim() && attachments.length === 0) ||
                  sending ||
                  uploading ||
                  card?.tone === "running" ||
                  sessionArchived ||
                  forkedCopy ||
                  (interactions ?? []).some((it) => it.status === "pending")
                }
                onClick={() => void doSend()}
              >
                {sending ? (
                  <LoaderCircle
                    size={14}
                    className="oc-actrow__spin"
                    aria-hidden
                  />
                ) : (
                  <SendHorizonal size={14} aria-hidden />
                )}
                {m.subagent_panel_send()}
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="oc-subpanel__fileinput"
              onChange={(e) => void onPickFiles(e.target.files)}
            />
          </div>
        ) : (
          <button
            type="button"
            className="oc-subpanel__interact"
            onClick={() => setPromptOpen(true)}
          >
            <MessageSquarePlus size={15} aria-hidden />
            {m.subagent_panel_interact()}
          </button>
        )}
      </footer>

      <SubAgentReportDialog
        target={reportTarget}
        onClose={() => setReportTarget(null)}
      />
    </div>
  );
}
