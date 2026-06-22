import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAttachment,
  useComposer,
  useComposerRuntime,
  useMessage,
  useThread,
} from "@assistant-ui/react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { APP_HOST } from "@/lib/appHost";
import { useResolvedMode } from "@/lib/useChart";
import { uploadProgressStore } from "./uploadProgressStore";
import { pickLogoUrl, brandInitials } from "@/lib/brandLogo";
import { AtriumMark } from "@/components/AtriumMark";
import {
  AssistantIdentityContext,
  useAssistantIdentity,
  assistantDisplayName,
  type AssistantIdentity,
} from "./assistantIdentity";
import type { ConvexId, ConvexMessageView } from "./convexTypes";
import {
  transcriptToMarkdown,
  transcriptToJson,
  exportFilename,
  type ExportMessage,
} from "./transcriptExport";
import {
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Download,
  Plus,
  ArrowUp,
  Mic,
  Trash2,
  Code,
  Search,
  CircleAlert,
  Bot,
  Server,
  LoaderCircle,
  Paperclip,
  Image as ImageIcon,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";
import { useConvexChatRuntime, type TurnGate } from "./useConvexChatRuntime";
import { uiPrefOptimisticUpdate } from "./uiPrefOptimistic";
import { deleteMessageOptimisticUpdate } from "./deleteMessageOptimistic";
import { RunStatus } from "./RunStatus";
import { ToolActivity } from "./ToolActivity";
import {
  SourcesActivity,
  SourcesPanelContent,
  SourcesPanelContext,
  type SourcesPanelApi,
} from "./SourcesActivity";
import { useResizableWidth, useIsMobile } from "@/lib/useSidebarLayout";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { MediaPart } from "./MediaPart";
import { MarkdownText } from "./MarkdownText";
import { FeedbackButton } from "./FeedbackDialog";
import { SessionKnobsGroup } from "./KnobRow";
import { SessionPanel } from "./SessionPanel";
import {
  capitalize,
  formatTokens,
  isOverridden,
  type SessionMetaView,
  type SessionSettingsView,
} from "./sessionKnobs";

// Top-level chat surface. Wires the reactive Convex-backed runtime into
// assistant-ui and renders the thread with custom renderers for run status,
// tool cards, and media (audio for TTS). No HTTP chat transport is used.

export interface ConvexChatProps {
  chatId: ConvexId<"chats"> | null;
  // Optional message to scroll to + highlight on open (deep-link `?m=`).
  focusMessageId?: string | null;
}

// Effective per-user UI toggles, resolved by getMe.ui (see convex/lib/uiPrefs).
// Provided via context so the deep action-bar buttons render conditionally
// without prop-drilling through assistant-ui's message primitives.
export type UiEffective = {
  showSource: boolean;
  showReport: boolean;
  copyAssistant: boolean;
  copyUser: boolean;
  showDelete: boolean;
  showTools: boolean;
  voiceInput: boolean;
};
const DEFAULT_UI: UiEffective = {
  showSource: true,
  showReport: true,
  copyAssistant: true,
  copyUser: true,
  showDelete: true,
  showTools: false, // clean/content-focused view by default (see UI_PREF_CODE_DEFAULTS)
  voiceInput: false,
};
const UiPrefsContext = createContext<UiEffective>(DEFAULT_UI);
function useUiPrefs(): UiEffective {
  return useContext(UiPrefsContext);
}


// Imperative turn-gate handle (see useConvexChatRuntime.TurnGate): lets the
// delete-assistant flow arm the SAME thinking placeholder + composer lock a
// send uses, from inside any message row.
const TurnGateContext = createContext<TurnGate | null>(null);

// Mid-turn QUEUE (Phase 1): the composer reads this to send a follow-up WHILE a
// turn is in flight. Null when no chat is mounted. Provided by ConvexChat from the
// runtime hook; consumed by the composer's while-running send button.
const QueueSendContext = createContext<
  ((text: string) => Promise<boolean>) | null
>(null);

// The active charte's avatar tile, shared by the assistant message header AND the
// new-chat welcome (both under AssistantIdentityContext) so the two can't drift:
// uploaded logo (whole, contain) -> Atrium mark (default) -> initials (custom, no
// logo). `className` is the host tile (.oc-msg__avatar / .oc-emptystate__avatar).
function BrandAvatar({ className }: { className: string }) {
  const id = useAssistantIdentity();
  return (
    <div className={className} aria-hidden>
      {id.logoUrl ? (
        <img className="oc-avatar__img" src={id.logoUrl} alt="" />
      ) : id.isDefault ? (
        <AtriumMark className="oc-avatar__mark" />
      ) : (
        id.initials
      )}
    </div>
  );
}

export function ConvexChat({ chatId, focusMessageId }: ConvexChatProps) {
  const { runtime, turnGate, queueSend } = useConvexChatRuntime({ chatId });
  // Resolved UI preferences (reactive): the single source for which interface
  // elements render. The composer "Outils" quick toggle writes through the same
  // single path (setUiPref), so it stays consistent with the Préférences panel.
  // `showTools` semantics: the ANALYSIS view toggle. ON shows the tool-activity
  // block (summary + click-to-expand detail) AND the Sources block; OFF is the
  // clean, content-focused view (both hidden, in-progress signal kept via
  // RunStatus). Default is OFF (clean) — see UI_PREF_CODE_DEFAULTS.
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const ui = (me?.ui?.effective as UiEffective | undefined) ?? DEFAULT_UI;
  const showTools = ui.showTools;

  // Resolve the assistant identity ONCE (see AssistantIdentityContext): the
  // charte graphique drives the AVATAR (logo follows the SAME server-resolved
  // theme mode so it never desyncs from the applied CSS), and the responding
  // AGENT drives the NAME (multi-agent only — single-agent falls back to the
  // brand label). getChatAgent is the SAME subscription the header chip uses.
  const brandMode = useResolvedMode(me?.resolvedThemeMode);
  const brand = me?.resolvedChartBrand;
  const agentInfo = useQuery(
    api.agents.getChatAgent,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const agent = agentInfo?.multiAgent ? agentInfo.agent : null;
  const assistantIdentity = useMemo<AssistantIdentity>(() => {
    const label = brand?.label ?? "Atrium";
    return {
      label,
      logoUrl: pickLogoUrl(brand, brandMode),
      isDefault: brand?.isDefault ?? true,
      initials: brandInitials(label),
      agentName: agent?.displayName ?? agent?.agentId ?? null,
      agentEmoji: agent?.emoji ?? null,
    };
  }, [brand, brandMode, agent]);
  // OPTIMISTIC (shared updater — see uiPrefOptimistic.ts): the toggle flips in the
  // local getMe cache IMMEDIATELY; the write + its getMe-invalidation cascade run
  // in the background instead of blocking the click.
  const setUiPref = useMutation(api.me.setUiPref).withOptimisticUpdate(
    uiPrefOptimisticUpdate,
  );

  // Not-found detection for a deep-linked chat. getSessionMeta returns `null` once
  // LOADED for a malformed/deleted chat (and `undefined` while still loading), so
  // `meta === null` with a chatId present means "this conversation does not exist"
  // — we render a clean in-shell message instead of an empty thread. (The backend
  // queries tolerate a malformed id via normalizeId, so this never throws.)
  const meta = useQuery(
    api.messages.getSessionMeta,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const notFound = chatId !== null && meta === null;

  // Sources panel as an INTEGRATED, resizable right COLUMN (not an overlay): the
  // conversation stays visible + interactive on the left while the user reads the
  // sources. A per-message chip opens it (via SourcesPanelContext); it pins to
  // that message until closed or another chip is clicked, and resets on chat
  // switch. Mobile (< 767px) falls back to the overlay drawer (no 3rd column).
  const isMobile = useIsMobile();
  const { width: sourcesWidth, startResize: startSourcesResize } = useResizableWidth(
    { storageKey: "oc.sources.width", defaultWidth: 380, min: 300, max: 680, edge: "right" },
  );
  const [activeSourcesMessageId, setActiveSourcesMessageId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setActiveSourcesMessageId(null);
  }, [chatId]);
  const sourcesApi = useMemo<SourcesPanelApi>(
    () => ({
      activeMessageId: activeSourcesMessageId,
      openFor: (id) => setActiveSourcesMessageId(id),
      close: () => setActiveSourcesMessageId(null),
    }),
    [activeSourcesMessageId],
  );
  const sourcesOpen = activeSourcesMessageId !== null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TurnGateContext.Provider value={turnGate}>
      <QueueSendContext.Provider value={queueSend}>
      <UiPrefsContext.Provider value={ui}>
      <AssistantIdentityContext.Provider value={assistantIdentity}>
      <SourcesPanelContext.Provider value={sourcesApi}>
        <div className="oc-chat">
          <div className="oc-chat__convo">
            {chatId ? (
              notFound ? (
                <ChatNotFound />
              ) : (
                <ChatThread
                  chatId={chatId}
                  showTools={showTools}
                  onToggleTools={() =>
                    void setUiPref({ key: "showTools", value: !showTools })
                  }
                  focusMessageId={focusMessageId ?? null}
                />
              )
            ) : (
              <div className="oc-empty">{m.chat_empty_select()}</div>
            )}
          </div>
          {/* DESKTOP: integrated, resizable Sources column (conversation stays
              live on the left). MOBILE: overlay drawer below. */}
          {sourcesOpen && !isMobile ? (
            <>
              <div
                className="oc-sources-resizer"
                onPointerDown={startSourcesResize}
                role="separator"
                aria-orientation="vertical"
                aria-label={m.sources_panel_resize()}
              />
              <aside
                className="oc-sources-col"
                style={{ width: sourcesWidth, flex: `0 0 ${sourcesWidth}px` }}
              >
                <SourcesPanelContent
                  messageId={activeSourcesMessageId as string}
                  onClose={sourcesApi.close}
                />
              </aside>
            </>
          ) : null}
        </div>
        {sourcesOpen && isMobile ? (
          <Sheet open onOpenChange={(o) => { if (!o) sourcesApi.close(); }}>
            <SheetContent side="right" className="oc-sources-panel-sheet">
              <SourcesPanelContent
                messageId={activeSourcesMessageId as string}
                onClose={sourcesApi.close}
              />
            </SheetContent>
          </Sheet>
        ) : null}
      </SourcesPanelContext.Provider>
      </AssistantIdentityContext.Provider>
      </UiPrefsContext.Provider>
      </QueueSendContext.Provider>
      </TurnGateContext.Provider>
    </AssistantRuntimeProvider>
  );
}

// Clean, in-application "conversation not found" state for a stale/typo'd deep
// link (the backend returns not-found rather than throwing, so the user never
// sees the router's raw error screen). Stays inside the app shell (sidebar +
// top bar remain) and offers a way forward.
function ChatNotFound() {
  const navigate = useNavigate();
  return (
    <div className="oc-notfound" role="status">
      <div className="oc-notfound__icon" aria-hidden>
        <Search size={28} />
      </div>
      <h2 className="oc-notfound__title">{m.chat_notfound_title()}</h2>
      <p className="oc-notfound__body">{m.chat_notfound_body()}</p>
      <button
        type="button"
        className="oc-notfound__cta"
        onClick={() => void navigate({ to: "/" })}
      >
        <Plus size={16} aria-hidden />
        {m.chat_new_conversation()}
      </button>
    </div>
  );
}

// Deep-link to a specific message (`?m=<id>`): scroll it into view + flash a
// highlight. The list loads async and the target may be ABSENT (regenerated /
// deleted / older than the loaded window) — so we poll briefly then give up
// gracefully (the feedback bell still shows the frozen message text). The `?m`
// param is cleared after a hit so a re-render / browser-back doesn't re-jump.
function useFocusMessage(
  chatId: ConvexId<"chats">,
  focusMessageId: string | null,
) {
  useEffect(() => {
    if (!focusMessageId) return;
    let cancelled = false;
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(focusMessageId)}"]`,
      );
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        // CSS-class flash (re-add to retrigger the keyframes). We do NOT clear the
        // `?m` param here — the navigate caused a thread REMOUNT that discarded
        // the class before it could paint (verified). The effect only re-runs when
        // focusMessageId/chatId change, so leaving `?m` is harmless.
        el.classList.remove("oc-msg--highlight");
        void el.offsetWidth; // reflow so re-adding restarts the animation
        el.classList.add("oc-msg--highlight");
        window.setTimeout(() => el.classList.remove("oc-msg--highlight"), 2400);
        return;
      }
      if (tries++ < 40) timer = window.setTimeout(attempt, 150); // ~6s window
    };
    // Run after paint so the just-mounted thread is in the DOM.
    timer = window.setTimeout(attempt, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // chatId is intentionally a dep so re-opening another chat re-runs.
  }, [chatId, focusMessageId]);
}

function ChatThread({
  chatId,
  showTools,
  onToggleTools,
  focusMessageId,
}: {
  chatId: ConvexId<"chats">;
  showTools: boolean;
  onToggleTools: () => void;
  focusMessageId: string | null;
}) {
  // Chat availability gate: if the bridge is down/erroring (active health poll),
  // grey out the composer and show a banner BEFORE a turn is persisted — the
  // user never sends a message that cannot reach the agent. Fail-open: while
  // health is unknown (undefined / known:false) we do NOT block. The
  // failDispatch error bubble remains the backstop for a send that slips through.
  const avail = useQuery(api.bridgeHealth.getBridgeAvailability, {
    chatId: chatId as Id<"chats">,
  });
  const unavailable = avail && !avail.available ? avail : null;
  useFocusMessage(chatId, focusMessageId);
  return (
    <ThreadPrimitive.Root className="oc-thread">
      <ChatHeader chatId={chatId} />
      <ThreadAnnouncer chatId={chatId} />
      <ThreadPrimitive.Viewport className="oc-thread__viewport">
        <ThreadPrimitive.Empty>
          <ThreadEmptyState />
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
            SystemMessage,
          }}
        />
      </ThreadPrimitive.Viewport>
      {/* Auto-hides (returns null) when the viewport is at the bottom; also
          suppressed on an empty thread (nothing to scroll to). */}
      <ThreadPrimitive.If empty={false}>
        <ThreadPrimitive.ScrollToBottom className="oc-scrolldown">
          <IconArrowDown />
          <span>{m.chat_latest_messages()}</span>
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.If>
      {unavailable ? <BridgeUnavailableBanner /> : null}
      <Composer
        showTools={showTools}
        onToggleTools={onToggleTools}
        unavailable={unavailable !== null}
      />
    </ThreadPrimitive.Root>
  );
}

// Standardized, user-facing "chat unavailable" notice shown above a greyed-out
// composer. Generic on purpose (the technical reason is admin-only, in Settings →
// Santé / Traces); the user just needs to know not to type and to retry.
function BridgeUnavailableBanner() {
  return (
    <div className="oc-chat-banner oc-chat-banner--error" role="status">
      <CircleAlert size={16} aria-hidden />
      <span>{m.chat_unavailable_banner()}</span>
    </div>
  );
}

// Screen-reader announcement of turn COMPLETION (CHAT_UX_DESIGN a11y). The
// RunStatus chip (role="status") announces "Réflexion…"/"Erreur" but goes to null
// on complete — so without this a SR user hears the start then SILENCE. This is a
// PERSISTENT, initially-EMPTY aria-live region (mounting it WITH text suppresses
// the announcement on many SRs); it is populated with a SHORT CUE once per
// completed assistant turn (NOT the full answer — a polite region would read it
// all; the answer stays in the transcript for normal navigation).
function ThreadAnnouncer({ chatId }: { chatId: ConvexId<"chats"> }) {
  // Reuses the runtime's owner-scoped query (Convex dedupes identical args).
  const messages = useQuery(api.messages.listByChat, {
    chatId: chatId as Id<"chats">,
  }) as ConvexMessageView[] | undefined;
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedId = useRef<string | null>(null);

  // Reset the baseline when switching chats (the component is reused, not
  // remounted), so a prior chat's last turn never re-announces in the new one.
  useEffect(() => {
    lastAnnouncedId.current = null;
    setAnnouncement("");
  }, [chatId]);

  useEffect(() => {
    if (!messages) return;
    let latest: ConvexMessageView | undefined;
    for (const m of messages) if (m.role === "assistant") latest = m;
    if (!latest || latest.status !== "complete") return;
    if (lastAnnouncedId.current === null) {
      // First settled assistant turn after load/switch: adopt as baseline
      // WITHOUT announcing (it is history, not a just-arrived reply).
      lastAnnouncedId.current = latest._id;
      return;
    }
    if (lastAnnouncedId.current !== latest._id) {
      lastAnnouncedId.current = latest._id;
      // Toggle a trailing space so the textContent actually CHANGES even for a
      // second identical cue (a polite region only announces on content change).
      setAnnouncement((prev) =>
        prev === m.chat_announce_reply()
          ? `${m.chat_announce_reply()} `
          : m.chat_announce_reply(),
      );
    }
  }, [messages]);

  return (
    <div aria-live="polite" aria-atomic="true" className="oc-sr-only">
      {announcement}
    </div>
  );
}

// Empty-state (CHAT_UX_DESIGN Part 3): capability transparency + a few
// suggested prompts for the "vague prompt" conversation type. Each suggestion
// Minimal welcome — a calm avatar + prompt, NO suggestion cards (per product
// feedback: a new chat should not push canned suggestions).
function ThreadEmptyState() {
  return (
    <div className="oc-emptystate">
      <BrandAvatar className="oc-emptystate__avatar" />
      <h2 className="oc-emptystate__title">{m.chat_empty_help()}</h2>
    </div>
  );
}

// Chat-header "spotted strip" (CHAT_UX_DESIGN.md Part 3): surfaces the OpenClaw
// session knobs as FEATURES — current model, reasoning (thinking) level with its
// inheritance hint, and the always-visible context-usage meter. Data comes from
// the gateway's self-describing `sessions.describe` (mirrored to Convex by the
// bridge), so a new model / thinking level surfaces with no frontend change.
// Read-only here; the write-back ("Advanced ▾") is a later increment. Renders
// nothing until session meta exists, so it never flashes an empty bar.
// Context-window usage meter. The SAME control sits inline in the chat header AND
// inside the "Advanced" popover, so the usage stays reachable when a narrow workspace
// compacts the header (the popover is portalled out of the @container, so it keeps
// the full detail there). Renders nothing when usage is unknown.
function ContextMeter({
  sm,
  detail = true,
}: {
  sm: SessionMetaView;
  // detail: show the "· used/total" suffix (dropped inline when the header is tight;
  // the Advanced popover always passes detail).
  detail?: boolean;
}) {
  const pct =
    sm.totalTokens != null && sm.contextTokens && sm.contextTokens > 0
      ? Math.round((sm.totalTokens / sm.contextTokens) * 100)
      : null;
  if (pct == null) return null;
  // Calm → escalating usage colors (universal meter language, theme-stable).
  const level = pct >= 90 ? "is-critical" : pct >= 75 ? "is-warn" : "is-ok";
  return (
    <span
      className={`oc-meter ${level}`}
      title={m.chat_context_used({
        pct,
        used: formatTokens(sm.totalTokens as number),
        total: formatTokens(sm.contextTokens as number),
      })}
    >
      <span className="oc-meter__track">
        <span
          className="oc-meter__fill"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </span>
      <span className="oc-meter__label">
        {pct}%
        {detail ? (
          <span className="oc-meter__detail">
            {" · "}
            {formatTokens(sm.totalTokens as number)}/
            {formatTokens(sm.contextTokens as number)}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function ChatHeader({ chatId }: { chatId: ConvexId<"chats"> }) {
  // ConvexId<"chats"> is our structural string-id type; the generated arg
  // validator wants the branded Id (same cast the runtime uses for listByChat).
  const meta = useQuery(api.messages.getSessionMeta, {
    chatId: chatId as Id<"chats">,
  });
  // Which agent this conversation is bound to — surfaced ONLY when the user has
  // more than one agent (server-decided `multiAgent`), so a single-agent user
  // never sees disambiguation they don't need. Read-only: the binding is
  // write-once after the first dispatch (swapping forks the gateway session).
  const agentInfo = useQuery(api.agents.getChatAgent, {
    chatId: chatId as Id<"chats">,
  });
  const sm = (meta?.sessionMeta ?? null) as SessionMetaView | null;
  const settings = (meta?.sessionSettings ?? null) as SessionSettingsView;
  const agent = agentInfo?.multiAgent ? agentInfo.agent : null;
  // "Outils" = the technical/analysis layer. When OFF (clean view) the header
  // also sheds its TECHNICAL chips (model, reasoning, token meter) so the eye is
  // not pulled toward non-vital diagnostics — only IDENTITY (title, agent) and
  // ACTIONS (export, advanced) remain. model/reasoning stay reachable in Advanced.
  const ui = useUiPrefs();
  // "All session settings" Sheet, opened from the popover's footer.
  const [panelOpen, setPanelOpen] = useState(false);
  // Render the strip when there is EITHER session meta OR a multi-agent chip to
  // show (a returning chat with no meta yet must still name its agent).
  // CONTENT-AWARE responsiveness (not fixed px breakpoints): the chips' widths vary
  // by LOCALE (e.g. German "Nachdenken"/"Erweitert" are far wider than French) and
  // font, so a fixed breakpoint would clip one language while wasting space in
  // another. We MEASURE instead: a hidden ghost renders the meta at its full natural
  // width; a ResizeObserver on the (mode-INDEPENDENT) header compares the space left
  // for the chips — header width minus the title's claim — against that ghost. When
  // it doesn't fit we go COMPACT: model/reasoning collapse into the "Advanced"
  // popover (their home), the buttons iconify, the meter sheds its detail. Observing
  // the header (whose width is workspace-driven, NOT changed by the mode) avoids the
  // classic feedback loop a flex-collapsing target would create.
  const headRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  // BINARY, intent-based provenance (CONF amendment A1): inherited = no
  // thinkingLevel key in sessionSettings. The old value-equality heuristic
  // (level === default) was wrong when overriding TO the default's value.
  const inherited = !isOverridden(settings, "thinkingLevel");

  // The full meta (agent + model + reasoning + meter + actions). `compact` collapses
  // the technical chips; `ghost` swaps the interactive triggers for width-accurate,
  // non-focusable stand-ins (so the measurer mounts no second popover).
  const renderMeta = (isCompact: boolean, ghost: boolean) => (
    <>
      {agent ? (
        <span
          className={`oc-chip oc-chip--agent${agent.state !== "ok" ? " is-warn" : ""}`}
          title={
            m.chat_agent_of_conversation({
              name: agent.displayName ?? agent.agentId,
            }) +
            (agent.inheritedDefault ? m.chat_agent_default_suffix() : "") +
            (agent.state === "deleted"
              ? m.chat_agent_deleted_suffix()
              : agent.state === "stale"
                ? m.chat_agent_stale_suffix()
                : "")
          }
        >
          {agent.emoji ? (
            <span className="oc-chip__emoji" aria-hidden>
              {agent.emoji}
            </span>
          ) : (
            <Bot size={13} aria-hidden />
          )}
          <span className="oc-chip__label">{agent.displayName ?? agent.agentId}</span>
          {/* When the user's agents span MORE THAN ONE instance, name the bound
              agent's instance so the same display name on two gateways is not
              ambiguous. Part of the analysis layer: hidden when "Outils" is OFF. */}
          {ui.showTools && agentInfo?.multiInstance ? (
            <span
              className="oc-chip__instance"
              title={m.chat_agent_instance_title({ instance: agent.instanceName })}
            >
              <Server size={11} aria-hidden />
              {agent.instanceName}
            </span>
          ) : null}
        </span>
      ) : null}
      {ui.showTools && !isCompact && sm?.model ? (
        <span
          className="oc-chip oc-chip--info"
          title={
            sm.modelProvider
              ? m.chat_model_with_provider({ provider: sm.modelProvider })
              : m.chat_model()
          }
        >
          <IconCpu />
          <span className="oc-chip__label">{sm.model}</span>
        </span>
      ) : null}
      {ui.showTools && !isCompact && sm?.thinkingLevel ? (
        <span
          className="oc-chip oc-chip--info"
          title={
            inherited
              ? m.chat_thinking_inherited_title()
              : m.chat_thinking_specific_title()
          }
        >
          <IconBrain />
          <span className="oc-chip__label">
            {m.chat_thinking_label()}&nbsp;: {capitalize(sm.thinkingLevel)}
          </span>
          {inherited ? (
            <span className="oc-chip__hint">{m.chat_thinking_inherited_hint()}</span>
          ) : null}
        </span>
      ) : null}
      {ui.showTools && sm ? <ContextMeter sm={sm} detail={!isCompact} /> : null}
      <ExportMenu
        chatId={chatId}
        title={meta?.title ?? null}
        compact={isCompact}
        ghost={ghost}
      />
      {sm ? (
        <SessionKnobsMenu
          chatId={chatId}
          sm={sm}
          settings={settings}
          onOpenPanel={() => setPanelOpen(true)}
          compact={isCompact}
          ghost={ghost}
        />
      ) : null}
    </>
  );

  // Re-measure when anything that changes a measured width changes: the localized
  // labels, the model/reasoning/agent/instance/title strings, the tools toggle.
  const measureKey = [
    m.chat_export(),
    m.chat_advanced(),
    sm?.model ?? "",
    sm?.thinkingLevel ?? "",
    agent?.displayName ?? agent?.agentId ?? "",
    agentInfo?.multiInstance ? (agent?.instanceName ?? "") : "",
    meta?.title ?? "",
    ui.showTools ? "1" : "0",
  ].join("|");
  useLayoutEffect(() => {
    const head = headRef.current;
    if (!head) return;
    // The title is a higher priority than the technical chips, so it gets a budget
    // (it ellipsizes within it); the chips get the remainder. Reserving the title's
    // natural width (capped) keeps the threshold from drifting with title length.
    const TITLE_CAP = 360;
    const GAP = 16;
    const measure = () => {
      const ghostW = ghostRef.current?.offsetWidth ?? 0;
      if (ghostW === 0) return; // not laid out yet -> stay full (no spurious collapse)
      const titleW = Math.min(titleRef.current?.scrollWidth ?? 0, TITLE_CAP);
      const chipsAvail = head.clientWidth - titleW - GAP;
      const next = chipsAvail < ghostW;
      setCompact((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(head);
    return () => ro.disconnect();
  }, [measureKey]);

  return (
    <header className="oc-chathead" ref={headRef}>
      <div
        className="oc-chathead__title"
        title={meta?.title ?? undefined}
        ref={titleRef}
      >
        {meta?.title || m.chat_conversation_fallback()}
      </div>
      <div className="oc-chathead__meta">{renderMeta(compact, false)}</div>
      {/* Hidden measurer: the meta at FULL natural width, mode-independent. */}
      <div className="oc-chathead-ghost" aria-hidden ref={ghostRef}>
        {renderMeta(false, true)}
      </div>
      <SessionPanel
        chatId={chatId}
        open={panelOpen}
        onOpenChange={setPanelOpen}
      />
    </header>
  );
}

// Trigger a client-side file download from in-memory text (no server round-trip
// beyond the owner-scoped query that produced it).
function downloadText(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Export the current transcript as Markdown or JSON. Reads the owner-scoped
// `listByChat` query imperatively on click (bounded to the 200-message window);
// when that cap is hit the serialized file carries an EXPLICIT truncation marker
// (a silent drop of older turns would betray "the transcript"). Serialization is
// the pure, unit-tested `transcriptTo*`. PHI: never logged — this is a
// user-initiated download of the user's OWN data.
function ExportMenu({
  chatId,
  title,
  compact = false,
  ghost = false,
}: {
  chatId: ConvexId<"chats">;
  title: string | null;
  // compact: icon-only (the label/chevron collapse when the header is tight).
  compact?: boolean;
  // ghost: a non-interactive, width-accurate stand-in for the responsive measurer.
  ghost?: boolean;
}) {
  const convex = useConvex();

  async function run(format: "md" | "json"): Promise<void> {
    const rows = (await convex.query(api.messages.listByChat, {
      chatId: chatId as Id<"chats">,
    })) as ConvexMessageView[];
    const messages: ExportMessage[] = rows.map((m) => ({
      role: m.role,
      text: m.text,
      createdAt: m.updatedAt ?? m._creationTime,
      parts: m.parts.map((p) => ({
        kind: p.kind,
        filename: "filename" in p ? p.filename : undefined,
        name: "name" in p ? p.name : undefined,
      })),
    }));
    // 200 = MESSAGE_WINDOW; a full window means older messages may be omitted.
    const truncated = rows.length >= 200;
    const opts = { title: title ?? undefined, truncated, exportedAt: Date.now() };
    const stem = exportFilename(title);
    if (format === "md") {
      downloadText(transcriptToMarkdown(messages, opts), `${stem}.md`, "text/markdown");
    } else {
      downloadText(transcriptToJson(messages, opts), `${stem}.json`, "application/json");
    }
  }

  // Trigger content shared by the real button AND the ghost stand-in, so their
  // widths can never drift (the measurer stays accurate).
  const inner = (
    <>
      <Download size={13} aria-hidden />
      {!compact ? (
        <>
          <span className="oc-chip__label">{m.chat_export()}</span>
          <ChevronDown size={13} className="oc-chip__chev" aria-hidden />
        </>
      ) : null}
    </>
  );
  if (ghost) return <span className="oc-chip oc-chip--btn">{inner}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="oc-chip oc-chip--btn" title={m.chat_export_conversation()}>
          {inner}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{m.chat_export()}</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => void run("md")}>{m.chat_export_markdown()}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run("json")}>{m.chat_export_json()}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// "Advanced" write-back popover (CONF-4a): the daily session knobs (model,
// reasoning, speed) rendered by the SAME SessionKnobsGroup the session panel
// mounts (amendment A11: one implementation). A real Popover (not a menu): the
// segmented controls are adjusted repeatedly without the surface closing. The
// applied value is pushed IMMEDIATELY by the bridge (sessions.patch) and the
// live `sessionMeta` refreshes, so the controls reflect the gateway's real
// state, never an optimistic guess. ↺ per row = explicit gateway unset (A2,
// bench-lifted) — never a patch-to-default-value fake override. `verboseLevel`
// is intentionally NOT exposed (pinned by the bridge; read-only row in the
// session panel). Footer opens the all-session-settings Sheet — the
// 2nd and LAST disclosure level.
function SessionKnobsMenu({
  chatId,
  sm,
  settings,
  onOpenPanel,
  compact = false,
  ghost = false,
}: {
  chatId: ConvexId<"chats">;
  sm: SessionMetaView;
  settings: SessionSettingsView;
  onOpenPanel: () => void;
  // compact: icon-only trigger; ghost: width-accurate non-interactive stand-in.
  compact?: boolean;
  ghost?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Trigger content shared by the real button AND the ghost stand-in (no width drift).
  const inner = (
    <>
      <SlidersHorizontal size={13} aria-hidden />
      {!compact ? (
        <>
          <span className="oc-chip__label">{m.chat_advanced()}</span>
          <ChevronDown size={13} className="oc-chip__chev" aria-hidden />
        </>
      ) : null}
    </>
  );
  if (ghost) return <span className="oc-chip oc-chip--btn">{inner}</span>;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="oc-chip oc-chip--btn" title={m.chat_advanced_settings_title()}>
          {inner}
        </button>
      </PopoverTrigger>
      {/* w-80/p-2 go through tw-merge (they MUST beat the component's w-72/p-4;
          relying on stylesheet cascade order against utilities is not safe). */}
      <PopoverContent align="end" className="oc-spanel-pop w-80 p-2">
        {/* Read-only context-window usage. Lives here too so it stays reachable —
            with its full detail + on touch (no hover title) — when a narrow header
            compacts the inline meter. Model/reasoning are the knobs below. */}
        {sm.totalTokens != null && sm.contextTokens ? (
          <div className="oc-spanel-pop__usage">
            <span className="oc-spanel-pop__usage-label">
              {m.chat_context_label()}
            </span>
            <ContextMeter sm={sm} />
          </div>
        ) : null}
        <SessionKnobsGroup chatId={chatId} sm={sm} settings={settings} />
        <button
          type="button"
          className="oc-spanel-pop__all"
          onClick={() => {
            setOpen(false);
            onOpenPanel();
          }}
        >
          <SlidersHorizontal size={13} aria-hidden />
          {m.conf_all_settings()}
          <ChevronRight size={13} aria-hidden />
        </button>
      </PopoverContent>
    </Popover>
  );
}

// Inline Lucide-style icons (no emoji, no extra dep). 16px, currentColor.
function IconCpu() {
  return (
    <svg
      className="oc-chip__icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  );
}

function IconBrain() {
  return (
    <svg
      className="oc-chip__icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </svg>
  );
}

// Shared 16px inline-SVG icon (Lucide geometry, currentColor) for the buttons.
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function IconArrowDown() {
  return (
    <Icon>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </Icon>
  );
}

function IconCopy() {
  return (
    <Icon>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  );
}

function IconCheck() {
  return (
    <Icon>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

// Component overrides for MessagePrimitive.Parts (assistant-ui 0.14):
//   - file parts (media + attachments) -> MediaPart
// Tool calls no longer flow through content (convertMessage diverts them to
// metadata.custom.toolParts, rendered by ToolActivity above the body), so no
// tools.Fallback mapping is needed. Typed loosely at this seam: our MediaPart
// accepts the structural props assistant-ui passes; the exact exported
// component types shifted in 0.14.
//
// Assistant turns ALSO override Text -> MarkdownText (GFM rendering). User and
// system turns intentionally do NOT: a user's literal input must not be
// reinterpreted as markdown (typing `*foo*` must stay `*foo*`), so they keep the
// default plain-text renderer.
const plainComponents = {
  File: MediaPart as never,
};
const assistantComponents = {
  ...plainComponents,
  Text: MarkdownText,
};

// User turn: a subtle, low-contrast bubble aligned right (Open WebUI style).
// Uses --muted (light grey in light, elevated grey in dark) instead of the
// high-contrast --primary, so it never flips to a tiring solid white/black.
// Per-message delete. Reads the Convex message id from metadata (authoritative,
// set in convertMessage) and calls deleteMessage. Truncate-forward semantics live
// in the mutation: deleting an assistant turn regenerates the last user turn;
// deleting a user turn removes it + all following. The cascade is destructive +
// has no undo, so the user-message variant confirms first.
function DeleteMessageButton({ kind }: { kind: "user" | "assistant" }) {
  const messageId = useMessage(
    (m) => (m.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );
  // OPTIMISTIC truncation (perceived performance, same science as the send
  // echo): the deleted turn — and everything after it — vanishes on the NEXT
  // FRAME; Convex swaps in the server truth on commit and rolls back on error.
  const del = useMutation(api.messages.deleteMessage).withOptimisticUpdate(
    deleteMessageOptimisticUpdate,
  );
  // Styled, promise-based confirm (radix AlertDialog) — replaces window.confirm.
  // BOTH roles confirm (the action is destructive either way), with copy that
  // matches the actual behavior: user = cascade, assistant = delete + regenerate.
  const confirm = useConfirm();
  const toast = useToast();
  const turnGate = useContext(TurnGateContext);
  // In-flight latch: blocks a double-fire and feeds the button's spinner state
  // (visible system status — the optimistic paths make the window tiny, but the
  // affordance must exist for the slow/failure cases).
  const [busy, setBusy] = useState(false);
  if (!messageId) return null;

  async function onDelete(): Promise<void> {
    const ok = await confirm(
      kind === "assistant"
        ? {
            title: m.chat_delete_assistant_title(),
            description: m.chat_delete_assistant_desc(),
            confirmLabel: m.chat_regenerate(),
            cancelLabel: m.chat_cancel(),
            destructive: true,
          }
        : {
            title: m.chat_delete_user_title(),
            description: m.chat_delete_user_desc(),
            confirmLabel: m.chat_delete(),
            cancelLabel: m.chat_cancel(),
            destructive: true,
          },
    );
    if (!ok) return;
    setBusy(true);
    // Assistant delete = regenerate: arm the in-flight gate THIS FRAME so the
    // thinking placeholder + composer lock engage instantly, exactly like a
    // send. The reactive machinery clears it when the regenerated reply (or its
    // failDispatch error bubble) lands.
    if (kind === "assistant") turnGate?.begin();
    try {
      await del({ messageId: messageId as Id<"messages"> });
    } catch (err) {
      // Convex already rolled the optimistic truncation back (the messages
      // visibly snap back). Release the gate — no reply will arrive to clear it
      // — and SAY WHY (e.g. the "wait for the reply to settle" guard). The old
      // `void` fire-and-forget swallowed this entirely.
      if (kind === "assistant") turnGate?.cancel();
      toast.error(m.chat_delete_error(), err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="oc-iconbtn oc-iconbtn--danger"
      title={
        kind === "assistant"
          ? m.chat_delete_assistant_btn_title()
          : m.chat_delete_user_btn_title()
      }
      aria-label={m.chat_delete_message_aria()}
      aria-busy={busy}
      disabled={busy}
      onClick={() => void onDelete()}
    >
      {busy ? (
        <LoaderCircle size={15} className="oc-iconbtn__spin" aria-hidden />
      ) : (
        <Trash2 size={15} aria-hidden />
      )}
    </button>
  );
}

// "Source" view: the EXACT stored text, verbatim — no markdown, no autocorrect,
// no transformation of any kind. This is the convention-free trust guarantee:
// for a USER turn it's exactly what was typed/sent; for an ASSISTANT turn it's
// the gateway's final text (our pipeline leaves prose byte-identical — only
// server paths are stripped for security; see bridge/sanitize.ts). It lets a
// user verify a word was not silently changed by autocorrect or by rendering.
function MessageSource() {
  const raw = useMessage(
    (m) => (m.metadata?.custom as { rawText?: string } | undefined)?.rawText ?? "",
  );
  const [copied, setCopied] = useState(false);
  // Count CODE POINTS, not UTF-16 units (`.length`), so an emoji / non-BMP char
  // does not inflate the count — the number must be trustworthy.
  const codePoints = [...raw].length;
  return (
    <div className="oc-msg__source">
      <div className="oc-msg__source-head">
        <span className="oc-msg__source-label">
          {codePoints > 1
            ? m.chat_source_label_plural({ count: codePoints })
            : m.chat_source_label({ count: codePoints })}
        </span>
        <button
          type="button"
          className="oc-iconbtn"
          title={m.chat_copy_source()}
          aria-label={m.chat_copy_source()}
          onClick={() => {
            void navigator.clipboard?.writeText(raw).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
      <pre className="oc-msg__source-pre">{raw.length > 0 ? raw : m.chat_source_empty()}</pre>
    </div>
  );
}

// Toggle between the rendered message and its raw source.
function SourceToggleButton({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`oc-iconbtn${active ? " is-on" : ""}`}
      onClick={onToggle}
      aria-pressed={active}
      title={active ? m.chat_show_rendered() : m.chat_show_source()}
      aria-label={m.chat_show_source_aria()}
    >
      <Code size={15} aria-hidden />
    </button>
  );
}

// User turn: subtle right-aligned bubble + a hover/last-visible action bar with a
// delete (deleting a user turn removes it + every following turn — confirmed).
function UserMessage() {
  const [showSource, setShowSource] = useState(false);
  const ui = useUiPrefs();
  // The optimistic echo (id `optimistic-…`) is in transit until the server
  // message replaces it. While in transit, show a quiet "Envoi…" affordance
  // instead of the action bar so the user sees their message is registered +
  // being sent (esp. on a slow/overloaded/reconnecting backend).
  const sending = useMessage((msg) => msg.id.startsWith("optimistic-"));
  const messageId = useMessage((msg) => msg.id);
  return (
    <MessagePrimitive.Root
      className={`oc-msg oc-msg--user${sending ? " is-sending" : ""}`}
      data-message-id={messageId}
    >
      <div className="oc-msg__col oc-msg__col--user">
        <div className="oc-msg__bubble">
          {showSource ? (
            <MessageSource />
          ) : (
            <MessagePrimitive.Parts components={plainComponents} />
          )}
        </div>
        {sending ? (
          <span className="oc-msg__sending" role="status">
            <span className="oc-msg__sending-spin" aria-hidden />
            {m.chat_message_sending()}
          </span>
        ) : (
          <ActionBarPrimitive.Root
            className="oc-msg__actions oc-msg__actions--user"
            hideWhenRunning
            autohide="not-last"
          >
          {ui.copyUser ? (
            <ActionBarPrimitive.Copy className="oc-iconbtn" title={m.chat_copy_message()}>
              <MessagePrimitive.If copied>
                <IconCheck />
              </MessagePrimitive.If>
              <MessagePrimitive.If copied={false}>
                <IconCopy />
              </MessagePrimitive.If>
            </ActionBarPrimitive.Copy>
          ) : null}
          {ui.showSource ? (
            <SourceToggleButton
              active={showSource}
              onToggle={() => setShowSource((s) => !s)}
            />
          ) : null}
          {ui.showReport ? <FeedbackButton /> : null}
          {ui.showDelete ? <DeleteMessageButton kind="user" /> : null}
          </ActionBarPrimitive.Root>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

// Assistant turn: NO background bubble — content sits on the page background and
// fills the readable column (Open WebUI style). An avatar + name header carries
// the identity; RunStatus shows the live status (and hides itself when done).
function AssistantMessage() {
  const [showSource, setShowSource] = useState(false);
  const ui = useUiPrefs();
  // Avatar = active charte graphique (logo / Atrium mark / initials); name = the
  // responding AGENT's display name (falls back to the brand label for a
  // single-agent user). Replaces the hardcoded "OC" / "OpenClaw".
  const identity = useAssistantIdentity();
  const messageId = useMessage((msg) => msg.id);
  return (
    <MessagePrimitive.Root
      className="oc-msg oc-msg--assistant"
      data-message-id={messageId}
    >
      <BrandAvatar className="oc-msg__avatar" />
      <div className="oc-msg__col">
        <div className="oc-msg__name">
          {identity.agentEmoji ? (
            <span className="oc-msg__name-emoji" aria-hidden>
              {identity.agentEmoji}
            </span>
          ) : null}
          {assistantDisplayName(identity)}
        </div>
        <div className="oc-msg__body">
          {/* "Outils" ON = the ANALYSIS view: the grouped tool activity (summary +
              click-to-expand ToolCards) AND the Sources block (what memory/document
              plugins fed the LLM this turn) are shown so the user can drill into what
              the gateway did. OFF = the CLEAN, content-focused view: both hidden; the
              in-progress signal is carried by RunStatus ("… traite votre message")
              below, so nothing about an active treatment is lost. Tools + Sources are
              grouped ABOVE the body — the meta "what informed this turn" sits together
              at the top, so everything BELOW is purely the agent's returned message
              (text + delivered files), un-mixed. Above-the-body also keeps streamed
              text in view of the bottom-following auto-scroll. */}
          {ui.showTools ? (
            <div className="oc-msg__meta">
              <ToolActivity />
              <SourcesActivity />
            </div>
          ) : null}
          {showSource ? (
            <MessageSource />
          ) : (
            <MessagePrimitive.Parts components={assistantComponents} />
          )}
          <RunStatus />
        </div>
        {/* Per-message actions, hidden while a turn runs + revealed on hover for
            non-last turns (always shown on the last). Copy + Delete. Deleting an
            assistant turn truncates from here and REGENERATES the last user turn
            (see messages.deleteMessage) — no confirm (recoverable). */}
        <ActionBarPrimitive.Root
          className="oc-msg__actions"
          hideWhenRunning
          autohide="not-last"
        >
          {ui.copyAssistant ? (
            <ActionBarPrimitive.Copy className="oc-iconbtn" title={m.chat_copy_response()}>
              <MessagePrimitive.If copied>
                <IconCheck />
              </MessagePrimitive.If>
              <MessagePrimitive.If copied={false}>
                <IconCopy />
              </MessagePrimitive.If>
            </ActionBarPrimitive.Copy>
          ) : null}
          {ui.showSource ? (
            <SourceToggleButton
              active={showSource}
              onToggle={() => setShowSource((s) => !s)}
            />
          ) : null}
          {ui.showReport ? <FeedbackButton /> : null}
          {ui.showDelete ? <DeleteMessageButton kind="assistant" /> : null}
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function SystemMessage() {
  const messageId = useMessage((msg) => msg.id);
  return (
    <MessagePrimitive.Root
      className="oc-msg oc-msg--system"
      data-message-id={messageId}
    >
      <div className="oc-msg__body">
        <MessagePrimitive.Parts components={plainComponents} />
      </div>
    </MessagePrimitive.Root>
  );
}

// NOTE: the send->first-token "thinking" gap is filled by assistant-ui's own
// upcoming-message placeholder (it injects an assistant frame whenever the
// runtime is `isRunning` and the last message is not an assistant). That
// placeholder carries no status, so RunStatus renders it as "Réflexion…" (see
// runStatusView's `undefined` case) and hands off seamlessly to the real
// streaming doc. We deliberately do NOT render a second gap-filler frame here —
// doing so double-stacks the assistant avatar/name during every gap.

// Composer attachment chip (BUG-2 fix). Without an `Attachment` component
// passed to <ComposerPrimitive.Attachments>, assistant-ui's getComponent
// returns undefined for every attachment type and renders NOTHING — so a
// selected file was added to the composer state but stayed INVISIBLE (no chip,
// no upload status, no error surfaced): "the import does nothing, no trace".
// This chip restores the missing feedback for ALL types (images + documents):
// an icon, the filename, the live upload status, and a remove button.
function ComposerAttachmentChip() {
  const status = useAttachment((a) => a.status?.type);
  const type = useAttachment((a) => a.type);
  // The chip shows the selected file + filename; the live upload PROGRESS (which
  // runs in adapter.send() on send, the slow part for a big file) is surfaced
  // separately by <UploadProgress> (a % bar) so this chip stays simple. Only a
  // genuine failure ("incomplete") surfaces a state here, so an upload error is
  // never silent.
  const failed = status === "incomplete";
  return (
    <AttachmentPrimitive.Root
      className={`oc-attach${failed ? " oc-attach--error" : ""}`}
      data-status={status}
    >
      <span className="oc-attach__icon" aria-hidden>
        {failed ? (
          <CircleAlert size={14} />
        ) : type === "image" ? (
          <ImageIcon size={14} />
        ) : (
          <Paperclip size={14} />
        )}
      </span>
      <span className="oc-attach__name">
        <AttachmentPrimitive.Name />
      </span>
      {failed ? (
        <span className="oc-attach__state">{m.chat_attach_failed()}</span>
      ) : null}
      <AttachmentPrimitive.Remove
        className="oc-attach__remove"
        aria-label={m.chat_attach_remove()}
      >
        <X size={13} aria-hidden />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

// Immediate attachment-upload feedback (the "see that it is processing" the user
// asked for, for the BIG-file case). Subscribes to the upload store so ONLY this
// row re-renders on each progress tick — appears the instant send starts, shows
// the % advancing, vanishes when the upload completes (then the optimistic echo
// + the thinking indicator take over).
function UploadProgress() {
  const snap = useSyncExternalStore(
    uploadProgressStore.subscribe,
    uploadProgressStore.getSnapshot,
  );
  if (!snap.active) return null;
  return (
    <div className="oc-upload" role="status" aria-live="polite">
      <div className="oc-upload__head">
        <LoaderCircle className="oc-upload__spin" size={14} aria-hidden />
        <span>
          {snap.count > 1
            ? m.chat_uploading_many({ count: snap.count, percent: snap.percent })
            : m.chat_uploading({ percent: snap.percent })}
        </span>
      </div>
      <div className="oc-upload__track" aria-hidden>
        <div className="oc-upload__bar" style={{ width: `${snap.percent}%` }} />
      </div>
    </div>
  );
}

// Send-while-running button (Phase 1: mid-turn QUEUE). Reads the composer text
// reactively (enabled only when non-empty), queues it server-side via the
// QueueSendContext, then clears the composer. The queued user message echoes
// instantly (optimistic) below the streaming reply and is dispatched when the
// current turn ends.
function QueueSendButton() {
  const queueSend = useContext(QueueSendContext);
  const composer = useComposerRuntime();
  const text = useComposer((c) => c.text);
  const hasText = text.trim().length > 0;
  return (
    <button
      type="button"
      className="oc-composer__send"
      disabled={!hasText || queueSend === null}
      aria-label={m.chat_queue_send_aria()}
      title={hasText ? m.chat_queue_send_title() : m.chat_response_in_progress()}
      onClick={() => {
        if (queueSend === null) return;
        const t = composer.getState().text;
        if (t.trim() === "") return;
        void queueSend(t).then((ok) => {
          if (ok) composer.setText("");
        });
      }}
    >
      <ArrowUp size={18} aria-hidden />
    </button>
  );
}

function Composer({
  showTools,
  onToggleTools,
  unavailable = false,
}: {
  showTools: boolean;
  onToggleTools: () => void;
  /** Bridge down: disable input + send so no un-sendable turn is persisted. */
  unavailable?: boolean;
}) {
  // Voice-input feature flag: resolved via the UI-preferences module (gated by
  // system enablement + the user's override). The mic only renders when true.
  const voiceInput = useUiPrefs().voiceInput;
  // Mid-turn QUEUE (Phase 1): while a turn is in flight, assistant-ui blocks its
  // own Enter→send, so we intercept Enter HERE and queue instead (server-side
  // serialization). When NOT running, we do nothing and assistant-ui handles
  // Enter normally.
  const isRunning = useThread((t) => t.isRunning);
  const queueSend = useContext(QueueSendContext);
  const composerRuntime = useComposerRuntime();
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isRunning || queueSend === null) return;
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    const t = composerRuntime.getState().text;
    if (t.trim() === "") return;
    void queueSend(t).then((ok) => {
      if (ok) composerRuntime.setText("");
    });
  };
  // Unified composer card (per the design reference): the input sits ON TOP, with
  // a single action bar BELOW it — attach (+) and the tools toggle on the left,
  // the circular send (or stop while running) on the right. The CARD owns the
  // border + focus ring (`:focus-within`), so focusing the textarea never shifts
  // layout. (Voice/dictation mic intentionally omitted until the talk.* phase —
  // a non-functional control would mislead.)
  return (
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    <ComposerPrimitive.Root
      className={`oc-composer${unavailable ? " oc-composer--disabled" : ""}`}
    >
      <ComposerPrimitive.Attachments
        components={{ Attachment: ComposerAttachmentChip }}
      />
      <UploadProgress />
      {/* Content fidelity: disable the browser/OS conventions that MUTATE typed
          text (autocorrect, auto-capitalize, autocomplete) so a word is sent
          exactly as typed — never silently swapped at submit. `data-gramm`
          disables Grammarly. spellCheck stays ON (it underlines, it does NOT
          mutate). NB: no third-party extension is 100% controllable — the
          per-message "Source" view is the real, convention-free guarantee. */}
      <ComposerPrimitive.Input
        className="oc-composer__input"
        placeholder={
          unavailable ? m.chat_composer_unavailable() : m.chat_composer_placeholder()
        }
        autoFocus
        rows={1}
        disabled={unavailable}
        onKeyDownCapture={onInputKeyDown}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
      />
      <div className="oc-composer__bar">
        <div className="oc-composer__group">
          {/* Phase-1 QUEUE is TEXT-ONLY: while a turn is in flight the follow-up
              goes through queueSend (text only), so attaching here would be silently
              dropped. Disable the picker during a run (and when unavailable) so the
              affordance never lies. Including attachments in a queued send is a later
              phase. */}
          <ComposerPrimitive.AddAttachment
            className="oc-composer__icon"
            aria-label={m.chat_attach_file()}
            disabled={isRunning || unavailable}
            title={isRunning ? m.chat_response_in_progress() : undefined}
          >
            <Plus size={18} aria-hidden />
          </ComposerPrimitive.AddAttachment>
          <button
            type="button"
            className={`oc-composer__tools${showTools ? " is-on" : ""}`}
            onClick={onToggleTools}
            aria-pressed={showTools}
            title={
              showTools ? m.chat_tools_hide() : m.chat_tools_show()
            }
          >
            <SlidersHorizontal size={15} aria-hidden />
            {m.chat_tools()}
          </button>
        </div>
        <div className="oc-composer__group">
          {voiceInput ? (
            <button
              type="button"
              className="oc-composer__icon"
              title={m.chat_voice_soon_title()}
              aria-label={m.chat_voice_soon_aria()}
            >
              <Mic size={18} aria-hidden />
            </button>
          ) : null}
          {unavailable ? (
            // Greyed, non-clickable send: the bridge is down, so persisting a
            // turn would only produce an unanswerable message.
            <button
              type="button"
              className="oc-composer__send"
              disabled
              aria-label={m.chat_send_unavailable_aria()}
            >
              <ArrowUp size={18} aria-hidden />
            </button>
          ) : (
            <>
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send className="oc-composer__send" aria-label={m.chat_send()}>
                  <ArrowUp size={18} aria-hidden />
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                {/* A turn is in flight. Phase 1 (QUEUE): the follow-up is accepted
                    NOW and serialized server-side — parked as a `queued` outbox row
                    and auto-dispatched when the current turn ends (the bridge is
                    one-turn-per-session). The button is enabled iff there's text;
                    Enter also queues (see the Input's onKeyDown). No gateway abort
                    endpoint exists, so there is still no "Stop" affordance. */}
                <QueueSendButton />
              </ThreadPrimitive.If>
            </>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
