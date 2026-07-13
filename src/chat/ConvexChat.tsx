import {
  ActionBarMorePrimitive,
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
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  useAction, useQuery, useMutation, useConvex } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { APP_HOST } from "@/lib/appHost";
import {
  isMac,
  matchesShortcut,
  shortcutLabel,
  type Shortcut,
} from "@/lib/shortcuts";
import { useResolvedMode } from "@/lib/useChart";
import { uploadProgressStore } from "./uploadProgressStore";
import { pickAvatarLogo, avatarLogoMode, brandInitials } from "@/lib/brandLogo";
import { AtriumMark } from "@/components/AtriumMark";
import {
  AssistantIdentityContext,
  useAssistantIdentity,
  assistantDisplayName,
  type AssistantIdentity,
} from "./assistantIdentity";
import {
  groupByInstance,
  filterAgents,
  type PickableAgent,
} from "./AgentPicker";
import {
  agentRefEquals,
  findAgentDisplay,
  type AgentRef,
} from "./perTurnAgent";
import type { ConvexId, ConvexMessageView } from "./convexTypes";
import {
  transcriptToMarkdown,
  transcriptToJson,
  exportFilename,
  type ExportMessage,
} from "./transcriptExport";
import {
  Volume2,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Download,
  Plus,
  ArrowUp,
  Square,
  Mic,
  Trash2,
  Code,
  Search,
  CircleAlert,
  Eye,
  Bot,
  Server,
  LoaderCircle,
  Lock,
  Clock,
  Paperclip,
  Image as ImageIcon,
  Check,
  X,
  GitBranch,
  Ellipsis,
  Timer,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDateTime, formatDurationShort } from "@/lib/format";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useConfirm, usePrompt } from "@/components/ConfirmDialog";
import { flashSidebarChat } from "./sidebarFlash";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { CronActivity, CronDetailContext, type CronDetailApi } from "./CronActivity";
import { PlanActivity } from "./PlanActivity";
import { CronDetailContent } from "./CronDetailPanel";
import type { CronPartView } from "./convexTypes";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import {
  resolveSpeechLang,
  speakText,
  stopSpeaking,
  playGatewayAudio,
  stopGatewayAudio,
  startDictation,
  stripMarkdownForSpeech,
  ttsSupported,
  dictationSupported,
  type ChatVoiceConfig,
  type DictationHandle,
} from "./speech";
import {
  useConvexChatRuntime,
  type TurnGate,
  type ChatRouting,
} from "./useConvexChatRuntime";
import { uiPrefOptimisticUpdate } from "./uiPrefOptimistic";
import { deleteMessageOptimisticUpdate } from "./deleteMessageOptimistic";
import { RunStatus } from "./RunStatus";
import { QueuedTurnContext } from "./queuedTurnContext";
import { GatewayDegradedContext } from "./gatewayDegradedContext";
import { ToolActivity } from "./ToolActivity";
import { MessageSubAgents } from "./SubAgentActivity";
import { CompactionNotice } from "./CompactionNotice";
import { usageBadgeView, type ProviderUsageView } from "./usageView";
import { assistantEmptyState, extractSpawnedChildKeys } from "./assistantEmptyState";
import { errorDetailView, messageHasText } from "./runStatusView";
import { LightboxProvider } from "./ImageLightbox";
import { isPastedFile, markPastedFile, routePaste } from "./pasteRouting";
import { takePendingFocusTerms } from "./pendingFocusTerms";
import { useInstanceCapabilities } from "./useInstanceCapabilities";
import type { ToolActivityPart } from "./toolActivityView";
import {
  hasRunningSubAgent,
  subAgentRowsForMessage,
  type SubAgentRow,
} from "./subAgentActivityView";
import {
  composerQueueState,
  type ComposerQueueReason,
} from "./composerQueueState";
import {
  SourcesActivity,
  SourcesPanelContent,
  SourcesPanelContext,
  type SourcesPanelApi,
} from "./SourcesActivity";
import {
  SubAgentPanelContent,
  SubAgentPanelContext,
  type SubAgentPanelApi,
} from "./SubAgentPanel";
import { useResizableWidth, useIsMobile } from "@/lib/useSidebarLayout";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { MediaPart } from "./MediaPart";
import { MarkdownText, AgentMarkdown } from "./MarkdownText";
import { FeedbackButton } from "./FeedbackDialog";
import { SessionKnobsGroup } from "./KnobRow";
import { SessionPanel } from "./SessionPanel";
import {
  DocumentViewerContent,
  DocumentViewerContext,
  type DocumentViewerApi,
  type ViewerDoc,
} from "./DocumentViewer";
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
  showUsage: boolean;
  autoReadAloud: boolean;
};
const DEFAULT_UI: UiEffective = {
  showSource: true,
  showReport: true,
  copyAssistant: true,
  copyUser: true,
  showDelete: true,
  showTools: false, // clean/content-focused view by default (see UI_PREF_CODE_DEFAULTS)
  voiceInput: false,
  showUsage: true, // subscription-quota transparency (admin can disable fleet-wide)
  autoReadAloud: true, // instance-level auto-read applies unless the user vetoes
};
// Per-instance voice settings (read-aloud) resolved for the OPEN chat — see
// convex/voice.voiceConfigForChat. Disabled defaults until the query lands.
const VoiceConfigContext = createContext<ChatVoiceConfig & { loaded: boolean }>({
  enabled: false,
  lang: "auto",
  rate: 1,
  autoRead: false,
  engine: "browser",
  loaded: false,
});

// Chat-wide read-aloud state: WHICH message is being read (and whether the
// gateway synthesis is still loading). One reading at a time — starting a new
// one stops the previous EVERYWHERE (audio + every button's visual state, the
// per-button local state left stale "speaking" buttons behind). The floating
// stop banner reads the same state, so stopping never depends on a hover-
// hidden action row.
type ReadAloudState = {
  active: { messageId: string; phase: "loading" | "playing" } | null;
  setActive: (v: { messageId: string; phase: "loading" | "playing" } | null) => void;
  /** Clear ONLY if `messageId` is still the active reading — the natural end
   *  (or cancel-fired onend) of an OLD clip must never erase the reading the
   *  user just started on another message. */
  clearIf: (messageId: string) => void;
};
const ReadAloudContext = createContext<ReadAloudState>({
  active: null,
  setActive: () => {},
  clearIf: () => {},
});

/** Generation token: every stop/start bumps it, and an in-flight gateway
 *  synthesis only plays if ITS generation is still current — a reply resolving
 *  after a stop, a chat switch or another read must stay silent (codex P2). */
let readGeneration = 0;

/** Stop every voice output (browser synthesis + gateway clip). */
function stopAllReading(): void {
  readGeneration++;
  stopSpeaking();
  stopGatewayAudio();
}

const UiPrefsContext = createContext<UiEffective>(DEFAULT_UI);
// Exported: RunStatus gates the live phase detail on the Tools toggle.
export function useUiPrefs(): UiEffective {
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

// STOP button context: ends the chat's active turn (optimistic finalize) and
// best-effort kills the gateway run. Null when no chat is mounted.
const AbortTurnContext = createContext<(() => Promise<void>) | null>(null);


// MULTI-AGENT per-turn router context: the routing surface from the runtime hook
// (the entitled agent pool + selection + per-message attribution). Null when no
// chat is mounted. Consumed by the composer's agent selector and the per-message
// attribution chip.
type ChatRoutingValue = ChatRouting;
const ChatRoutingContext = createContext<ChatRoutingValue | null>(null);
function useChatRouting(): ChatRoutingValue | null {
  return useContext(ChatRoutingContext);
}

// The active charte's avatar tile, shared by the assistant message header AND the
// new-chat welcome (both under AssistantIdentityContext) so the two can't drift:
// uploaded logo (whole, contain) -> Atrium mark (default) -> initials (custom, no
// logo). `className` is the host tile (.oc-msg__avatar / .oc-emptystate__avatar).
function BrandAvatar({ className }: { className: string }) {
  const id = useAssistantIdentity();
  return (
    <div className={className} aria-hidden>
      {id.logoUrl ? (
        id.logoMasked ? (
          // Silhouette masked in --primary-foreground: auto-contrast on the tile in
          // both modes (color-agnostic), from the single uploaded logo.
          <span
            className="oc-avatar__img oc-avatar__img--mask"
            style={
              { "--oc-logo-url": `url("${id.logoUrl}")` } as CSSProperties
            }
          />
        ) : (
          <img className="oc-avatar__img" src={id.logoUrl} alt="" />
        )
      ) : id.isDefault ? (
        <AtriumMark className="oc-avatar__mark" />
      ) : (
        id.initials
      )}
    </div>
  );
}

export function ConvexChat({ chatId, focusMessageId }: ConvexChatProps) {
  const {
    runtime,
    turnGate,
    queueSend,
    abortTurn,
    routing,
    lastUserTurnQueued,
    initialLoading,
  } =
    useConvexChatRuntime({
    chatId,
  });
  // (The delivery-latency recorder now runs INSIDE useConvexChatRuntime, where it can see
  // the active transport + the SSE samples to close segment C on the displayed leg — Phase 5.)
  // Resolved UI preferences (reactive): the single source for which interface
  // elements render. The composer "Outils" quick toggle writes through the same
  // single path (setUiPref), so it stays consistent with the Preferences panel.
  // `showTools` semantics: the ANALYSIS view toggle. ON shows the tool-activity
  // block (summary + click-to-expand detail) AND the Sources block; OFF is the
  // clean, content-focused view (both hidden, in-progress signal kept via
  // RunStatus). Default is OFF (clean) — see UI_PREF_CODE_DEFAULTS.
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const ui = (me?.ui?.effective as UiEffective | undefined) ?? DEFAULT_UI;
  const showTools = ui.showTools;

  // Resolve the assistant identity ONCE (see AssistantIdentityContext): the
  // charte graphique drives the AVATAR, and the responding AGENT drives the NAME
  // (multi-agent only — single-agent falls back to the brand label). getChatAgent
  // is the SAME subscription the header chip uses.
  //
  // The avatar TILE paints the logo on `--primary` (see .oc-msg__avatar /
  // .oc-emptystate__avatar), NOT the page background. For guaranteed contrast in
  // BOTH modes from a SINGLE asset, an alpha-defined logo is rendered as a
  // SILHOUETTE masked in `--primary-foreground` (the contrast colour the chart
  // guarantees against `--primary`) — colour-agnostic, exactly how the bundled
  // Atrium mark already auto-contrasts via currentColor. An opaque logo can't be
  // silhouetted, so it falls back to a plain <img>; `avatarLogoMode` then picks the
  // variant whose polarity best contrasts with the tile (system-safe: brandMode is
  // the client-resolved mode, and `--primary` itself flips per mode).
  const brandMode = useResolvedMode(me?.resolvedThemeMode);
  const brand = me?.resolvedChartBrand;
  const chartTokens = me?.resolvedChartTokens;
  const agentInfo = useQuery(
    api.agents.getChatAgent,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const agent = agentInfo?.multiAgent ? agentInfo.agent : null;
  const assistantIdentity = useMemo<AssistantIdentity>(() => {
    const label = brand?.label ?? "Atrium";
    const colors = chartTokens?.colors?.[brandMode];
    const avatarMode = avatarLogoMode(
      colors?.primary,
      colors?.["primary-foreground"],
      brandMode,
    );
    const avatar = pickAvatarLogo(brand, avatarMode);
    return {
      label,
      logoUrl: avatar?.url ?? null,
      logoMasked: avatar?.masked ?? false,
      isDefault: brand?.isDefault ?? true,
      initials: brandInitials(label),
      agentName: agent?.displayName ?? agent?.agentId ?? null,
      agentEmoji: agent?.emoji ?? null,
    };
  }, [brand, brandMode, chartTokens, agent]);
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
  const {
    width: sourcesWidth,
    startResize: startSourcesResize,
    columnRef: sourcesColRef,
  } = useResizableWidth(
    { storageKey: "oc.sources.width", defaultWidth: 380, min: 300, max: 680, edge: "right" },
  );
  const [activeSourcesMessageId, setActiveSourcesMessageId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setActiveSourcesMessageId(null);
  }, [chatId]);
  const {
    width: subAgentWidth,
    startResize: startSubAgentResize,
    columnRef: subAgentColRef,
  } =
    useResizableWidth({
      storageKey: "oc.subagent.width",
      defaultWidth: 460,
      min: 320,
      max: 720,
      edge: "right",
    });
  const [activeSubAgentKey, setActiveSubAgentKey] = useState<string | null>(null);
  useEffect(() => {
    setActiveSubAgentKey(null);
  }, [chatId]);
  // Document Viewer (third occupant of the shared right column): a clicked
  // file chip opens the file IN PLACE — conversation stays live on the left.
  // Wider default than Sources (documents want room), own persisted width.
  // The ceiling is viewport-relative: reading the document is the point of
  // this panel, so the user may pull it across most of the window (the
  // conversation keeps the rest; collapsing the sidebar frees even more).
  const {
    width: docViewerWidth,
    startResize: startDocViewerResize,
    columnRef: docViewerColRef,
  } =
    useResizableWidth({
      storageKey: "oc.docviewer.width",
      defaultWidth: 560,
      min: 380,
      max: 1800,
      maxViewportFraction: 0.72,
      edge: "right",
    });
  const [activeDoc, setActiveDoc] = useState<ViewerDoc | null>(null);
  useEffect(() => {
    setActiveDoc(null);
  }, [chatId]);
  // Sources + the sub-agent panel + the document viewer SHARE one right column
  // (mutually exclusive): opening one closes the others, so there's never a 4th
  // column. Each keeps its own resizable width.
  const sourcesApi = useMemo<SourcesPanelApi>(
    () => ({
      activeMessageId: activeSourcesMessageId,
      openFor: (id) => {
        setActiveSourcesMessageId(id);
        setActiveSubAgentKey(null);
        setActiveDoc(null);
        setActiveCron(null);
      },
      close: () => setActiveSourcesMessageId(null),
    }),
    [activeSourcesMessageId],
  );
  const subAgentApi = useMemo<SubAgentPanelApi>(
    () => ({
      activeChildKey: activeSubAgentKey,
      openFor: (key) => {
        setActiveSubAgentKey(key);
        setActiveSourcesMessageId(null);
        setActiveDoc(null);
        setActiveCron(null);
      },
      close: () => setActiveSubAgentKey(null),
    }),
    [activeSubAgentKey],
  );
  const docViewerApi = useMemo<DocumentViewerApi>(
    () => ({
      activeDoc,
      openFor: (doc) => {
        setActiveDoc(doc);
        setActiveSourcesMessageId(null);
        setActiveSubAgentKey(null);
        setActiveCron(null);
      },
      close: () => setActiveDoc(null),
    }),
    [activeDoc],
  );
  // 4th occupant of the shared right column: the cron DETAIL (a job the turn
  // created/updated, opened from the message's "Crons" section).
  const [activeCron, setActiveCron] = useState<{
    instanceName: string;
    jobId: string | null;
    part: CronPartView;
  } | null>(null);
  useEffect(() => {
    setActiveCron(null);
  }, [chatId]);
  const chatInstanceName = agentInfo?.agent?.instanceName ?? null;
  const cronApi = useMemo<CronDetailApi>(
    () => ({
      active: activeCron,
      openFor: (part, routedInstanceName) => {
        const instanceName = routedInstanceName ?? chatInstanceName;
        if (instanceName === null) return; // no resolvable gateway — no panel
        setActiveCron({ instanceName, jobId: part.jobId ?? null, part });
        setActiveSourcesMessageId(null);
        setActiveSubAgentKey(null);
        setActiveDoc(null);
      },
      close: () => setActiveCron(null),
    }),
    [activeCron, chatInstanceName],
  );
  const sourcesOpen = activeSourcesMessageId !== null;
  const subAgentOpen = activeSubAgentKey !== null;
  const docViewerOpen = activeDoc !== null;
  const cronOpen = activeCron !== null;

  // Per-instance voice settings for THIS chat (read-aloud language/rate/auto).
  // One query at the root; the read-aloud button, the mic and the auto-reader
  // consume it via context.
  const voiceCfgRaw = useQuery(
    api.voice.voiceConfigForChat,
    chatId ? { chatId } : "skip",
  ) as ChatVoiceConfig | undefined;
  const [readingActive, setReadingActive] = useState<
    { messageId: string; phase: "loading" | "playing" } | null
  >(null);
  const readAloudState = useMemo<ReadAloudState>(
    () => ({
      active: readingActive,
      setActive: setReadingActive,
      clearIf: (messageId) =>
        setReadingActive((cur) =>
          cur?.messageId === messageId ? null : cur,
        ),
    }),
    [readingActive],
  );
  // Chat switch: never carry a reading (or its audio) into another chat.
  useEffect(() => {
    stopAllReading();
    setReadingActive(null);
  }, [chatId]);
  const voiceCfg = useMemo<ChatVoiceConfig & { loaded: boolean }>(
    () =>
      voiceCfgRaw
        ? { ...voiceCfgRaw, loaded: true }
        : {
            enabled: false,
            lang: "auto",
            rate: 1,
            autoRead: false,
            engine: "browser",
            loaded: false,
          },
    [voiceCfgRaw],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <VoiceConfigContext.Provider value={voiceCfg}>
      <ReadAloudContext.Provider value={readAloudState}>
      <TurnGateContext.Provider value={turnGate}>
      <QueueSendContext.Provider value={queueSend}>
      <AbortTurnContext.Provider value={abortTurn}>
      <QueuedTurnContext.Provider value={lastUserTurnQueued}>
      <ChatRoutingContext.Provider value={routing}>
      <UiPrefsContext.Provider value={ui}>
      <AssistantIdentityContext.Provider value={assistantIdentity}>
      <SourcesPanelContext.Provider value={sourcesApi}>
      <SubAgentPanelContext.Provider value={subAgentApi}>
      <CronDetailContext.Provider value={cronApi}>
      <DocumentViewerContext.Provider value={docViewerApi}>
      <LightboxProvider>
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
                  initialLoading={initialLoading}
                />
              )
            ) : (
              <div className="oc-empty">{m.chat_empty_select()}</div>
            )}
          </div>
          {/* DESKTOP: integrated, resizable Sources column (conversation stays
              live on the left). MOBILE: overlay drawer below. */}
          {(sourcesOpen || subAgentOpen || docViewerOpen || cronOpen) && !isMobile ? (
            <>
              <div
                className="oc-sources-resizer"
                onPointerDown={
                  docViewerOpen
                    ? startDocViewerResize
                    : subAgentOpen
                      ? startSubAgentResize
                      : startSourcesResize
                }
                role="separator"
                aria-orientation="vertical"
                aria-label={m.sources_panel_resize()}
              />
              <aside
                className="oc-sources-col"
                // One physical column shared by the three panels (mutually
                // exclusive) — bind every hook's ref; only the active panel's
                // drag writes to it.
                ref={(el) => {
                  sourcesColRef.current = el;
                  subAgentColRef.current = el;
                  docViewerColRef.current = el;
                }}
                style={{
                  width: docViewerOpen
                    ? docViewerWidth
                    : subAgentOpen
                      ? subAgentWidth
                      : sourcesWidth,
                  flex: `0 0 ${
                    docViewerOpen
                      ? docViewerWidth
                      : subAgentOpen
                        ? subAgentWidth
                        : sourcesWidth
                  }px`,
                }}
              >
                {cronOpen ? (
                  <CronDetailContent
                    instanceName={(activeCron as { instanceName: string }).instanceName}
                    part={(activeCron as { part: CronPartView }).part}
                    onClose={cronApi.close}
                  />
                ) : docViewerOpen ? (
                  <DocumentViewerContent
                    doc={activeDoc as ViewerDoc}
                    onClose={docViewerApi.close}
                  />
                ) : subAgentOpen ? (
                  <SubAgentPanelContent
                    chatId={chatId as string}
                    childKey={activeSubAgentKey as string}
                    onClose={subAgentApi.close}
                    parentAgentLabel={assistantDisplayName(assistantIdentity)}
                  />
                ) : (
                  <SourcesPanelContent
                    messageId={activeSourcesMessageId as string}
                    onClose={sourcesApi.close}
                  />
                )}
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
        {subAgentOpen && isMobile ? (
          <Sheet open onOpenChange={(o) => { if (!o) subAgentApi.close(); }}>
            <SheetContent side="right" className="oc-sources-panel-sheet">
              <SubAgentPanelContent
                chatId={chatId as string}
                childKey={activeSubAgentKey as string}
                onClose={subAgentApi.close}
                parentAgentLabel={assistantDisplayName(assistantIdentity)}
              />
            </SheetContent>
          </Sheet>
        ) : null}
        {cronOpen && isMobile ? (
          <Sheet open onOpenChange={(o) => { if (!o) cronApi.close(); }}>
            <SheetContent side="right" className="oc-sources-panel-sheet">
              <CronDetailContent
                instanceName={(activeCron as { instanceName: string }).instanceName}
                part={(activeCron as { part: CronPartView }).part}
                onClose={cronApi.close}
              />
            </SheetContent>
          </Sheet>
        ) : null}
        {docViewerOpen && isMobile ? (
          <Sheet open onOpenChange={(o) => { if (!o) docViewerApi.close(); }}>
            <SheetContent side="right" className="oc-sources-panel-sheet oc-docviewer-sheet">
              <DocumentViewerContent
                doc={activeDoc as ViewerDoc}
                onClose={docViewerApi.close}
              />
            </SheetContent>
          </Sheet>
        ) : null}
      </LightboxProvider>
      </DocumentViewerContext.Provider>
      </CronDetailContext.Provider>
      </SubAgentPanelContext.Provider>
      </SourcesPanelContext.Provider>
      </AssistantIdentityContext.Provider>
      </UiPrefsContext.Provider>
      </ChatRoutingContext.Provider>
      </QueuedTurnContext.Provider>
      </AbortTurnContext.Provider>
      </QueueSendContext.Provider>
      </TurnGateContext.Provider>
      </ReadAloudContext.Provider>
      </VoiceConfigContext.Provider>
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
// Highlight every occurrence of the searched terms INSIDE the focused message,
// via the CSS Custom Highlight API — zero DOM mutation (safe over rendered
// markdown). Feature-detected: absent support (older Firefox) degrades to the
// message flash alone. Cleared on unmount/renav.
function highlightTermsIn(el: HTMLElement, terms: string[]): (() => void) | null {
  const registry = (
    CSS as unknown as { highlights?: Map<string, unknown> }
  ).highlights;
  const HighlightCtor = (
    window as unknown as { Highlight?: new (...r: Range[]) => unknown }
  ).Highlight;
  if (!registry || !HighlightCtor) return null;
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
  if (needles.length === 0) return null;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    for (const needle of needles) {
      let at = lower.indexOf(needle);
      while (at !== -1) {
        const r = document.createRange();
        r.setStart(node, at);
        r.setEnd(node, at + needle.length);
        ranges.push(r);
        if (ranges.length >= 200) break; // bounded (pathological repeats)
        at = lower.indexOf(needle, at + needle.length);
      }
      if (ranges.length >= 200) break;
    }
    if (ranges.length >= 200) break;
  }
  if (ranges.length === 0) return null;
  registry.set("oc-search-terms", new HighlightCtor(...ranges));
  return () => registry.delete("oc-search-terms");
}

function useFocusMessage(
  chatId: ConvexId<"chats">,
  focusMessageId: string | null,
) {
  useEffect(() => {
    if (!focusMessageId) return;
    let cancelled = false;
    let tries = 0;
    let timer = 0;
    let clearHighlight: (() => void) | null = null;
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
        const terms = takePendingFocusTerms(focusMessageId);
        if (terms) {
          clearHighlight = highlightTermsIn(el, terms.split(/\s+/).filter(Boolean));
        }
        return;
      }
      if (tries++ < 40) timer = window.setTimeout(attempt, 150); // ~6s window
    };
    // Run after paint so the just-mounted thread is in the DOM.
    timer = window.setTimeout(attempt, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      clearHighlight?.();
    };
    // chatId is intentionally a dep so re-opening another chat re-runs.
  }, [chatId, focusMessageId]);
}

// Conversation LOADING skeleton: ghost bubbles shown while the first
// listByChat response for this chat is in flight. Without it a content-heavy
// chat renders as an EMPTY thread for the seconds the payload takes ("is
// anything happening?"), then the content pops in. Ghost widths alternate to
// read as a real exchange; shimmer respects prefers-reduced-motion; the
// container is a polite live region so SR users hear the state once.
function ChatLoadingSkeleton() {
  return (
    <div
      className="oc-thread-skeleton"
      role="status"
      aria-label={m.chat_loading()}
    >
      {[72, 38, 84, 56, 64].map((w, i) => (
        <div
          key={i}
          className={`oc-thread-skeleton__row${i % 2 ? " oc-thread-skeleton__row--user" : ""}`}
        >
          <span
            className="oc-thread-skeleton__bubble"
            style={{ width: `${w}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function ChatThread({
  chatId,
  showTools,
  onToggleTools,
  focusMessageId,
  initialLoading,
}: {
  chatId: ConvexId<"chats">;
  showTools: boolean;
  onToggleTools: () => void;
  focusMessageId: string | null;
  initialLoading: boolean;
}) {
  // Chat availability gate: if the bridge is down/erroring (active health poll),
  // grey out the composer and show a banner BEFORE a turn is persisted — the
  // user never sends a message that cannot reach the agent. Fail-open: while
  // health is unknown (undefined / known:false) we do NOT block. The
  // failDispatch error bubble remains the backstop for a send that slips through.
  const avail = useQuery(api.bridgeHealth.getBridgeAvailability, {
    chatId: chatId as Id<"chats">,
  });
  // GATEWAY OUTAGE (target-scoped): the bridge is up but a gateway target errors —
  // informational + NON-blocking (the anti-deadlock rule: one gateway must never
  // lock the composer). TWO scopes, two consumers (codex P2):
  //   - ACTIVE turn (RunStatus label): the chatId-only query — server-side it
  //     follows the LAST SEND's routing (the turn the spinner belongs to).
  //   - NEXT send (the warning banner + the availability BLOCK): scoped to the
  //     agent the COMPOSER currently targets, so switching to an agent on a DOWN
  //     instance greys the composer even when the chat's current instance is
  //     healthy. Convex dedupes the two subscriptions when no per-turn selection
  //     exists (identical args — the common case).
  const routing = useChatRouting();
  const selected = routing?.selected ?? null;
  const availNext = useQuery(api.bridgeHealth.getBridgeAvailability, {
    chatId: chatId as Id<"chats">,
    ...(selected
      ? {
          routedAgent: {
            instanceName: selected.instanceName,
            agentId: selected.agentId,
          },
        }
      : {}),
  });
  // BLOCK on the NEXT send's target (availNext), not the chat's current instance:
  // a per-turn selection to a down instance must grey the composer BEFORE the send,
  // and with no selection availNext === the chatId-only query, so the common case is
  // unchanged. Fail-open while unknown (undefined).
  const unavailable = availNext && !availNext.available ? availNext : null;
  const gatewayDegraded = avail?.available === true && avail.degraded === true;
  const gatewayDegradedNext =
    availNext?.available === true && availNext.degraded === true;
  // READ-ONLY: the chat is bound to an agent the user is no longer entitled to
  // (an admin narrowed their set). Lock the composer + show a reason so the user
  // understands WHY they cannot send (the dispatch also enforces it server-side).
  const agentInfo = useQuery(api.agents.getChatAgent, {
    chatId: chatId as Id<"chats">,
  });
  const readOnly = agentInfo?.readOnly === true;
  // The chat is ALSO busy when a sub-agent it spawned is still running: the parent
  // turn has finalized but the bridge is one-turn-per-session, so a follow-up must
  // be HELD (queued) — and that hold made VISIBLE in the composer. Owner-scoped +
  // reactive; Convex dedupes this with the sub-agent monitor's / AssistantEmptyState's
  // identical subscription, so it is one network query (returns [] for the common
  // no-sub-agent chat). When the child terminalizes, this flips false and the
  // composer's held state clears (the server drains the queued message).
  const subAgentRows = useQuery(api.subAgents.listSubAgents, {
    chatId: chatId as Id<"chats">,
  }) as SubAgentRow[] | undefined;
  const subAgentBusy = hasRunningSubAgent(subAgentRows ?? []);
  // Background-task engagements verify against the GATEWAY's task registry
  // while they spin (30s cadence + once on sight): the indicator reflects
  // the registry's truth — a task whose delivery frame was missed (bridge
  // restart, dropped wake) still settles instead of spinning forever.
  const reconcileTasks = useAction(api.subAgents.reconcileTaskEngagements);
  const hasRunningTask = (subAgentRows ?? []).some(
    (r) => (r as { kind?: string }).kind === "task" && r.status === "running",
  );
  // GRACE window: a sequential chain starts its next task INSIDE the previous
  // delivery run, invisibly (no ack ever reaches the bridge) — for a few
  // minutes after the last task activity the registry is the only witness,
  // so the poll keeps running (its discovery adopts the next link, which
  // re-lights the indicator). Expired + nothing running → the interval stops.
  // The window is armed on the LOCAL clock when the server activity stamp
  // CHANGES (comparing a server updatedAt to Date.now() would kill — or
  // eternalize — the window on a skewed client, same reasoning as the local
  // deliveringSince cap below).
  const TASK_POLL_GRACE_MS = 4 * 60_000;
  const lastTaskActivityAt = (subAgentRows ?? []).reduce(
    (max, r) =>
      (r as { kind?: string }).kind === "task" && r.updatedAt > max
        ? r.updatedAt
        : max,
    0,
  );
  const taskGraceRef = useRef<{
    chatId: string | null;
    seenStamp: number;
    armedAtLocal: number;
  }>({ chatId: null, seenStamp: 0, armedAtLocal: 0 });
  // The component is REUSED across chat switches: without this reset the new
  // chat's first (historical) stamp would differ from the previous chat's and
  // wrongly arm four minutes of probes — and a still-armed window would even
  // probe the new chat before its rows load.
  if (taskGraceRef.current.chatId !== (chatId ?? null)) {
    taskGraceRef.current = {
      chatId: chatId ?? null,
      seenStamp: 0,
      armedAtLocal: 0,
    };
  }
  if (
    lastTaskActivityAt > 0 &&
    taskGraceRef.current.seenStamp !== lastTaskActivityAt
  ) {
    // FIRST sight arms ONLY for RECENT activity (wide 10-min tolerance on
    // the client clock — the cost of a skewed clock here is a few pointless
    // probes or a missed resume, never a wrong signal): a reload mid-chain
    // must resume probing for the invisible next link, while a months-old
    // stamp on a historical thread must not open four minutes of pointless
    // probes. Later CHANGES always arm (live activity under observation).
    const first = taskGraceRef.current.seenStamp === 0;
    const recent = Date.now() - lastTaskActivityAt < 10 * 60_000;
    taskGraceRef.current = {
      chatId: chatId ?? null,
      seenStamp: lastTaskActivityAt,
      armedAtLocal: first && !recent ? 0 : Date.now(),
    };
  }
  const inTaskGraceWindow =
    taskGraceRef.current.armedAtLocal > 0 &&
    Date.now() - taskGraceRef.current.armedAtLocal < TASK_POLL_GRACE_MS;
  useEffect(() => {
    if ((!hasRunningTask && !inTaskGraceWindow) || !chatId) return;
    let cancelled = false;
    // In-flight lock: a probe can take up to ~50s on a cold gateway — the
    // 30s cadence must never stack concurrent operator connections.
    let inFlight = false;
    let t: number | undefined;
    const tick = () => {
      if (cancelled || inFlight) return;
      // The deadline is read from the REF at tick time: every reconcile
      // refresh bumps the rows' updatedAt (re-arming the window), and a
      // dependency on the armed timestamp would REMOUNT this effect on each
      // probe — an immediate tick() loop of back-to-back operator
      // connections. The booleans below only flip on real state changes.
      // Expired → SKIP (never clearInterval here: later activity can re-arm
      // the ref without flipping the rendered booleans, and a killed
      // interval would then never restart). The idle tick is a no-op; the
      // effect unmounts on the next render once the window is truly over.
      const deadline = taskGraceRef.current.armedAtLocal + TASK_POLL_GRACE_MS;
      if (!hasRunningTask && Date.now() > deadline) {
        return;
      }
      inFlight = true;
      void reconcileTasks({ chatId: chatId as Id<"chats"> })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    tick();
    t = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the armed
    // timestamp is deliberately read through the ref (see comment above).
  }, [hasRunningTask, inTaskGraceWindow, chatId, reconcileTasks]);
  // Thread-level "still working" indicator — INDEPENDENT of the Tools toggle:
  // in the clean view the sub-agent block is hidden, so without this the user
  // sees a settled reply and NOTHING while the sub-agent still works (or while
  // the gateway composes the follow-up delivery). Hidden whenever a message is
  // actively streaming (that bubble already carries its own dots).
  const turnActivity = useQuery(api.subAgents.turnActivity, {
    chatId: chatId as Id<"chats">,
  }) as { running: boolean; deliveringSince: number | null } | undefined;
  const liveRows = useQuery(api.messages.getStreamingText, { chatId }) as
    | unknown[]
    | undefined;
  const anyStreaming = (liveRows?.length ?? 0) > 0;
  // Local cap on the delivering window: a NO_REPLY announce never re-stamps
  // the chat, so the server-side signal alone would linger forever — and it
  // also bounds the residual write-order race (a detached terminal upsert
  // landing after the parent settled). Announces follow a done child within
  // seconds in practice.
  const DELIVERING_CAP_MS = 45_000;
  // deliveringSince is a SERVER timestamp — subtracting it from the browser
  // clock breaks the window under clock skew (a fast client never shows the
  // indicator; a slow one holds it far too long). Arm a purely LOCAL window
  // when the server value appears or changes instead.
  // The MOUNT-TIME value is a baseline that never arms the window: a NO_REPLY
  // announce (or a never-correlated terminal row) keeps the same server value
  // indefinitely, and arming on it would flash a stale "finalizing" for 45s on
  // every reopen — only a CHANGE observed while subscribed is a live delivery.
  const deliverKey = turnActivity?.deliveringSince ?? null;
  const deliverLoaded = turnActivity !== undefined;
  const deliverBaseline = useRef<{ chatId: string; key: number | null } | null>(
    null,
  );
  const [freshDeliverKey, setFreshDeliverKey] = useState<number | null>(null);
  useEffect(() => {
    if (!deliverLoaded) return;
    if (deliverBaseline.current?.chatId !== chatId) {
      deliverBaseline.current = { chatId, key: deliverKey };
      setFreshDeliverKey(null);
      return;
    }
    if (deliverKey == null || deliverKey === deliverBaseline.current.key) {
      if (deliverKey == null) {
        deliverBaseline.current = { chatId, key: null };
        setFreshDeliverKey(null);
      }
      return;
    }
    deliverBaseline.current = { chatId, key: deliverKey };
    setFreshDeliverKey(deliverKey);
    const t = window.setTimeout(
      () => setFreshDeliverKey(null),
      DELIVERING_CAP_MS,
    );
    return () => window.clearTimeout(t);
  }, [deliverLoaded, deliverKey, chatId]);
  const deliveringFresh = deliverKey != null && freshDeliverKey === deliverKey;
  const showTurnActivity =
    !anyStreaming && (turnActivity?.running === true || deliveringFresh);
  useFocusMessage(chatId, focusMessageId);
  return (
    <GatewayDegradedContext.Provider value={gatewayDegraded}>
    <ThreadPrimitive.Root className="oc-thread">
      <ChatHeader chatId={chatId} />
      <ThreadAnnouncer chatId={chatId} />
      {initialLoading ? <ChatLoadingSkeleton /> : null}
      <ThreadPrimitive.Viewport
        className="oc-thread__viewport"
        style={initialLoading ? { display: "none" } : undefined}
      >
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
        {showTurnActivity ? (
          <TurnActivityIndicator running={turnActivity?.running === true} />
        ) : null}
      </ThreadPrimitive.Viewport>
      {/* Auto-hides (returns null) when the viewport is at the bottom; also
          suppressed on an empty thread (nothing to scroll to). */}
      <ThreadPrimitive.If empty={false}>
        <ThreadPrimitive.ScrollToBottom className="oc-scrolldown">
          <IconArrowDown />
          <span>{m.chat_latest_messages()}</span>
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.If>
      {readOnly ? (
        <ChatReadOnlyBanner />
      ) : unavailable ? (
        <BridgeUnavailableBanner reason={unavailable.reason} />
      ) : gatewayDegradedNext ? (
        <GatewayDegradedBanner />
      ) : null}
      <Composer
        chatId={chatId}
        showTools={showTools}
        onToggleTools={onToggleTools}
        unavailable={unavailable !== null || readOnly}
        subAgentBusy={subAgentBusy}
      />
    </ThreadPrimitive.Root>
    </GatewayDegradedContext.Provider>
  );
}

// Thread-level activity chip: a settled reply whose TURN is still working
// (sub-agent running, or its result being composed into the follow-up
// delivery). Same visual language as the in-bubble thinking dots; shown in
// BOTH the clean and the analysis views.
function TurnActivityIndicator({ running }: { running: boolean }) {
  return (
    <div className="oc-turn-activity" role="status">
      <span className="oc-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span>
        {running ? m.turn_subagent_working() : m.turn_result_incoming()}
      </span>
    </div>
  );
}

// GATEWAY-OUTAGE notice (warning, NON-blocking): this chat's routed gateway is not
// responding while the bridge itself is up. The composer stays usable (one gateway
// must never lock everyone out — the failDispatch bubble backstops a failed send);
// the banner just makes the outage visible instead of leaving spinners lying.
function GatewayDegradedBanner() {
  return (
    <div className="oc-chat-banner oc-chat-banner--warn" role="status">
      <CircleAlert size={16} aria-hidden />
      <span>{m.chat_degraded_banner()}</span>
    </div>
  );
}

// Standardized, user-facing "chat unavailable" notice shown above a greyed-out
// composer. Generic on purpose (the technical reason is admin-only, in Settings →
// Health / Traces); the user just needs to know not to type and to retry.
function BridgeUnavailableBanner({ reason }: { reason: string | null }) {
  // A per-INSTANCE outage (the chat's gateway is unreachable while the bridge
  // and other instances are up) gets its own copy — the user should know it is
  // THIS agent's gateway, not the whole app.
  const label =
    reason === "instance_unreachable"
      ? m.chat_instance_unreachable_banner()
      : m.chat_unavailable_banner();
  return (
    <div className="oc-chat-banner oc-chat-banner--error" role="status">
      <CircleAlert size={16} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

// READ-ONLY notice: the chat is bound to an agent the user is no longer entitled
// to (an admin narrowed their agent set). Unlike the bridge banner, the reason IS
// actionable by the user (start a new chat with an available agent), so it is
// stated plainly.
function ChatReadOnlyBanner() {
  return (
    <div className="oc-chat-banner oc-chat-banner--error" role="status">
      <Lock size={16} aria-hidden />
      <span>{m.chat_readonly_banner()}</span>
    </div>
  );
}

// Screen-reader announcement of turn COMPLETION (CHAT_UX_DESIGN a11y). The
// RunStatus chip (role="status") announces the thinking/error labels but goes to null
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
// Subscription-usage gauge (the routed instance's most constrained provider
// rate-limit window, captured by the bridge poll). Same meter language as the
// context meter; gated by the showUsage pref at the CALL site. Renders nothing
// until a snapshot exists (bench/idle gateways have none).
function UsageBadge({ chatId }: { chatId: ConvexId<"chats"> }) {
  // MULTI-AGENT per-turn: follow the composer's ACTIVE target — the quota shown
  // is the one the NEXT send will consume, not the chat's primary (codex P2).
  // Server-side the override is per-option AUTHENTICATED (resolveTargetForTurn).
  const routing = useChatRouting();
  const selected = routing?.selected ?? null;
  const data = useQuery(api.agents.usageForChat, {
    chatId: chatId as Id<"chats">,
    ...(selected
      ? {
          routedAgent: {
            instanceName: selected.instanceName,
            agentId: selected.agentId,
          },
        }
      : {}),
  }) as { usage: ProviderUsageView[]; updatedAt: number } | null | undefined;
  const view = usageBadgeView(data?.usage ?? null, Date.now());
  if (!view) return null;
  const detail = view.windows
    .map(
      (w) =>
        `${w.provider} ${w.label}: ${w.percentLeft}%` +
        (w.resetText ? ` ⏱${w.resetText}` : ""),
    )
    .join(" · ");
  return (
    <span
      className={`oc-meter ${view.level}`}
      title={m.chat_usage_tooltip({ detail })}
    >
      <span className="oc-meter__track">
        <span
          className="oc-meter__fill"
          style={{ width: `${100 - view.percentLeft}%` }}
        />
      </span>
      <span className="oc-meter__label">
        {m.chat_usage_label({ pct: view.percentLeft })}
      </span>
    </span>
  );
}

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
  const sm = (meta?.sessionMeta ?? null) as SessionMetaView | null;
  const settings = (meta?.sessionSettings ?? null) as SessionSettingsView;
  // The agent identity is NO LONGER a header chip: the composer's per-turn agent
  // selector now carries (and disambiguates) the agent + instance, so a header chip
  // would be redundant. The header keeps the technical chips (model / thinking /
  // context meter) + title + actions.
  // "Outils" = the technical/analysis layer. When OFF (clean view) the header
  // also sheds its TECHNICAL chips (model, reasoning, token meter) so the eye is
  // not pulled toward non-vital diagnostics — only IDENTITY (title) and ACTIONS
  // (export, advanced) remain. model/reasoning stay reachable in Advanced.
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
      {/* Usage gauge FALLBACK: it lives in the Advanced popover, but that menu
          only renders once the session meta exists — a fresh chat (before the
          first sessions.describe) must not lose its quota alert, so render it
          inline for that transient window only (codex P2). */}
      {ui.showUsage && !sm ? <UsageBadge chatId={chatId} /> : null}
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
          showUsage={ui.showUsage}
        />
      ) : null}
    </>
  );

  // Re-measure when anything that changes a measured width changes: the localized
  // labels, the model/reasoning/title strings, the tools toggle. (The agent chip
  // moved to the composer selector, so it no longer factors into the header width.)
  const measureKey = [
    m.chat_export(),
    m.chat_advanced(),
    sm?.model ?? "",
    sm?.thinkingLevel ?? "",
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
    // ALSO observe the ghost: its width changes when ASYNC content lands (the
    // usage gauge's snapshot, late i18n, a model chip) without the header
    // resizing — measuring only the header would keep a stale compact state
    // and let the chips overflow (codex P2).
    if (ghostRef.current) ro.observe(ghostRef.current);
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
    // listByChat now carries only the persisted text; a turn still streaming has
    // its live tokens in the companion getStreamingText. Overlay it so exporting
    // MID-STREAM captures exactly what the user sees in the thread (not an empty body).
    const [rows, liveRows] = await Promise.all([
      convex.query(api.messages.listByChat, {
        chatId: chatId as Id<"chats">,
      }) as Promise<ConvexMessageView[]>,
      convex.query(api.messages.getStreamingText, {
        chatId: chatId as Id<"chats">,
      }) as Promise<{ messageId: string; text: string }[]>,
    ]);
    const liveByMsg = new Map(liveRows.map((r) => [r.messageId, r.text]));
    const messages: ExportMessage[] = rows.map((m) => ({
      role: m.role,
      text:
        m.status === "streaming"
          ? (liveByMsg.get(m._id as string) ?? m.text)
          : m.text,
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
  showUsage = false,
}: {
  chatId: ConvexId<"chats">;
  sm: SessionMetaView;
  settings: SessionSettingsView;
  onOpenPanel: () => void;
  /** User pref: surface the provider-subscription gauge (in this popover —
   *  deliberately NOT in the toolbar, where it read as chat-level info). */
  showUsage?: boolean;
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
        {showUsage ? (
          <div className="oc-spanel-pop__usage">
            <span className="oc-spanel-pop__usage-label">
              {m.chat_usage_section_label()}
            </span>
            <UsageBadge chatId={chatId} />
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

// Copy button that stays USEFUL on errored turns: copies the message text, or
// — when the turn produced no text (a connection-lost / overflow error) — the
// displayed error itself (actionable headline + technical detail). assistant-ui's
// ActionBarPrimitive.Copy silently DISABLES on empty content, which read as a
// dead button on error messages (live report 2026-07-04).
/** BRANCH the conversation from this reply into a NEW chat (ChatGPT's "branch
 *  in a new chat"): the fork carries the same visible history up to here, opens
 *  immediately, and its first send re-grounds the agent via the existing
 *  rehydration — the original conversation continues untouched. */
// Shadcn dropdown-menu look, replicated for the ActionBarMorePrimitive
// (which needs raw Radix parts — see the comment inside AssistantMoreMenu).
// Keep in sync with components/ui/dropdown-menu.tsx.
const MSG_MENU_CONTENT_CLS =
  "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md";
const MSG_MENU_ITEM_CLS =
  "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/** The assistant reply's "more actions" contextual menu (ChatGPT-style ⋯,
 *  LAST in the action row). Header = the message's datetime; items = the
 *  source toggle (moved off the bar) and branching. Branching opens a NAME
 *  dialog, creates the branch and STAYS in the current conversation — the new
 *  row flashes in the sidebar so the eye finds where it landed (no navigation;
 *  the earlier navigate-on-fork crashed the message tree's useMessage lookups
 *  mid-teardown). */
function AssistantMoreMenu({
  sourceShown,
  sourceActive,
  onToggleSource,
}: {
  /** Whether the source toggle is offered at all (the showSource UI pref). */
  sourceShown: boolean;
  sourceActive: boolean;
  onToggleSource: () => void;
}) {
  const messageId = useMessage(
    (msg) => (msg.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );
  // The message's true moment (fork copies carry their SOURCE time).
  const sentAt = useMessage(
    (msg) => (msg.metadata?.custom as { sentAt?: number } | undefined)?.sentAt,
  );
  const generationMs = useMessage(
    (msg) =>
      (msg.metadata?.custom as { generationMs?: number | null } | undefined)
        ?.generationMs ?? null,
  );
  // A STREAMING reply is not a valid branch point yet (the server refuses it —
  // no stable content); grey the affordance instead of toasting an error.
  const streaming = useMessage(
    (msg) =>
      (msg.metadata?.custom as { status?: string } | undefined)?.status ===
      "streaming",
  );
  const fork = useMutation(api.chatFork.forkChat);
  const prompt = usePrompt();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!messageId) return null;
  const branch = async () => {
    // Name dialog first — cancel aborts the whole branch (nothing created).
    const name = await prompt({
      title: m.chat_branch_action(),
      description: m.chat_branch_dialog_desc(),
      label: m.sidebar_title_field(),
      placeholder: m.chat_branch_name_placeholder(),
      confirmLabel: m.chat_branch_confirm(),
      // Blank confirm = keep the source title (the server-side fallback).
      allowEmpty: true,
    });
    if (name === null) return;
    setBusy(true);
    try {
      const { chatId } = await fork({
        branchMessageId: messageId as Id<"messages">,
        // Blank = keep the source title (server-side default).
        ...(name.trim() ? { title: name.trim() } : {}),
      });
      // Stay HERE; the sidebar row pulse shows where the branch landed (and
      // the toast covers a collapsed sidebar).
      flashSidebarChat(chatId, { expand: true });
      toast.success(m.chat_branch_created());
    } catch (err) {
      toast.error(m.chat_branch_failed(), err);
    } finally {
      setBusy(false);
    }
  };
  // ActionBarMorePrimitive (NOT the plain shadcn DropdownMenu): the action bar
  // AUTOHIDES on non-last messages (visible = hovering), and a plain Radix
  // menu steals the pointer/focus on open -> the bar unmounts -> the trigger
  // disappears -> the menu closes itself instantly. This primitive acquires
  // the action bar's interaction LOCK while open, keeping the bar mounted.
  // Classes mirror components/ui/dropdown-menu.tsx for an identical look.
  return (
    <ActionBarMorePrimitive.Root>
      <ActionBarMorePrimitive.Trigger
        className="oc-iconbtn"
        title={m.chat_more_actions()}
        aria-label={m.chat_more_actions()}
        disabled={busy}
      >
        <Ellipsis size={15} />
      </ActionBarMorePrimitive.Trigger>
      <ActionBarMorePrimitive.Content
        align="end"
        sideOffset={4}
        className={MSG_MENU_CONTENT_CLS}
      >
        {sentAt !== undefined ? (
          <>
            <div className="oc-msgmenu__when px-2 py-1.5 text-sm">
              {formatDateTime(sentAt, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {(() => {
                const dur =
                  generationMs !== null
                    ? formatDurationShort(generationMs)
                    : null;
                return dur !== null ? (
                  <span className="oc-msgmenu__duration">
                    <Timer size={12} aria-hidden />
                    {m.chat_reply_duration({ duration: dur })}
                  </span>
                ) : null;
              })()}
            </div>
            <ActionBarMorePrimitive.Separator className="bg-border -mx-1 my-1 h-px" />
          </>
        ) : null}
        {sourceShown ? (
          <ActionBarMorePrimitive.Item
            className={MSG_MENU_ITEM_CLS}
            onSelect={onToggleSource}
          >
            <Code size={14} aria-hidden />
            {sourceActive ? m.chat_show_rendered() : m.chat_show_source()}
          </ActionBarMorePrimitive.Item>
        ) : null}
        <ActionBarMorePrimitive.Item
          className={MSG_MENU_ITEM_CLS}
          disabled={busy || streaming}
          onSelect={() => void branch()}
        >
          <GitBranch size={14} aria-hidden />
          {m.chat_branch_action()}
        </ActionBarMorePrimitive.Item>
      </ActionBarMorePrimitive.Content>
    </ActionBarMorePrimitive.Root>
  );
}

function CopyAssistantButton() {
  const [copied, setCopied] = useState(false);
  const text = useMessage((msg) =>
    (msg.content as ReadonlyArray<{ type?: string; text?: string }>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n"),
  );
  const error = useMessage(
    (msg) => (msg.metadata?.custom as { error?: string | null } | undefined)?.error ?? null,
  );
  const errorCode = useMessage(
    (msg) =>
      (msg.metadata?.custom as { errorCode?: string | null } | undefined)?.errorCode ?? null,
  );
  const detail = errorDetailView(error, errorCode);
  const payload =
    text.trim() ||
    [detail.headline, detail.detail].filter(Boolean).join("\n");
  const disabled = payload.length === 0;
  return (
    <button
      type="button"
      className="oc-iconbtn"
      title={m.chat_copy_response()}
      aria-label={m.chat_copy_response()}
      disabled={disabled}
      onClick={() => {
        void navigator.clipboard.writeText(payload).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

/** Read the assistant reply aloud (browser TTS). Rendered only when the
 *  instance offers voice AND this browser has an engine. Toggle: reading →
 *  stop; a new read cancels the previous one (speech.ts guarantees single
 *  utterance). */
/** Auto-read: when the instance enables it, a reply that COMPLETES while this
 *  chat is open is read aloud. The ref-gated transition (non-complete →
 *  complete observed live) means history NEVER reads on load, and only the
 *  turn you just received speaks. */
function useAutoRead(text: string): void {
  const voice = useContext(VoiceConfigContext);
  const reading = useContext(ReadAloudContext);
  const autoReadId = useMessage(
    (msg) =>
      (msg.metadata?.custom as { messageId?: string } | undefined)?.messageId ??
      msg.id,
  );
  // Per-user veto: the instance opt-in only speaks for users who kept the
  // "auto read-aloud" preference on (codex P2 — the config help promises it).
  const userAllows = useUiPrefs().autoReadAloud;
  const status = useMessage(
    (msg) =>
      (msg.metadata?.custom as { status?: string } | undefined)?.status ?? "",
  );
  const prev = useRef<string | null>(null);
  useEffect(() => {
    // While the voice config is still loading, do NOT record the status — a
    // fast reply completing before the config lands would otherwise consume
    // the transition and never speak (codex P2).
    if (!voice.loaded) return;
    const was = prev.current;
    prev.current = status;
    // Auto-read speaks with the BROWSER engine only for now — a gateway
    // synthesis round-trip per reply is a separate opt-in (follow-up).
    if (
      !voice.enabled ||
      !voice.autoRead ||
      voice.engine === "gateway" ||
      !userAllows ||
      !ttsSupported()
    ) {
      return;
    }
    // Only a LIVE transition into `complete` triggers speech; the first
    // observation (was === null) is the mount of an already-settled message.
    if (status !== "complete" || was === null || was === "complete") return;
    if (!text.trim()) return;
    const ok = speakText(stripMarkdownForSpeech(text), {
      lang: resolveSpeechLang(voice.lang, getLocale()),
      rate: voice.rate,
      onEnd: () => reading.clearIf(autoReadId),
    });
    if (ok) reading.setActive({ messageId: autoReadId, phase: "playing" });
  }, [status, text, voice, reading, autoReadId, userAllows]);
}

function ReadAloudButton() {
  const voice = useContext(VoiceConfigContext);
  const reading = useContext(ReadAloudContext);
  const gatewayTts = useAction(api.voice.gatewayTts);
  const toast = useToast();
  const messageId = useMessage(
    (msg) =>
      (msg.metadata?.custom as { messageId?: string } | undefined)?.messageId ??
      msg.id,
  );
  const chatId = useMessage(
    (msg) =>
      (msg.metadata?.custom as { chatId?: string } | undefined)?.chatId ?? null,
  );
  const text = useMessage((msg) =>
    msg.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n"),
  );
  const browserEngine = voice.engine !== "gateway";
  if (!voice.enabled || !text.trim()) return null;
  if (browserEngine && !ttsSupported()) return null;
  const lang = resolveSpeechLang(voice.lang, getLocale());
  // GLOBAL state: this button is "mine" only when the chat-wide reading points
  // at THIS message — starting another message's reading releases this one.
  const mine = reading.active?.messageId === messageId;
  const loading = mine && reading.active?.phase === "loading";
  const speaking = mine && reading.active?.phase === "playing";
  const start = () => {
    // Exclusive: silence whatever was reading (any engine, any message).
    stopAllReading();
    const clean = stripMarkdownForSpeech(text);
    if (browserEngine) {
      const ok = speakText(clean, {
        lang,
        rate: voice.rate,
        onEnd: () => reading.clearIf(messageId),
      });
      reading.setActive(ok ? { messageId, phase: "playing" } : null);
      return;
    }
    if (!chatId) return;
    const generation = readGeneration;
    reading.setActive({ messageId, phase: "loading" });
    gatewayTts({ chatId, text: clean.slice(0, 1_500) })
      .then(({ mime, audioBase64 }: { mime: string; audioBase64: string }) => {
        // Superseded (stopped / another read / chat switch)? Stay silent.
        if (generation !== readGeneration) return;
        const ok = playGatewayAudio(audioBase64, mime, {
          rate: voice.rate,
          onEnd: () => reading.clearIf(messageId),
        });
        reading.setActive(ok ? { messageId, phase: "playing" } : null);
      })
      .catch((err) => {
        if (generation !== readGeneration) return;
        toast.error(m.chat_read_gateway_error(), err);
        reading.setActive(null);
      });
  };
  return (
    <button
      type="button"
      className={`oc-iconbtn${mine ? " oc-iconbtn--reading" : ""}`}
      title={mine ? m.chat_read_stop() : m.chat_read_aloud()}
      aria-label={mine ? m.chat_read_stop() : m.chat_read_aloud()}
      aria-pressed={mine}
      aria-busy={loading}
      onClick={() => {
        if (mine) {
          stopAllReading();
          reading.setActive(null);
          return;
        }
        start();
      }}
    >
      {loading ? (
        <LoaderCircle size={16} className="oc-actrow__spin" aria-hidden />
      ) : speaking ? (
        <IconVolumeStop />
      ) : (
        <IconVolume />
      )}
    </button>
  );
}

/** Floating "now reading" banner above the composer: names the state (loading
 *  vs playing) and offers a STOP that never hides — the per-message action row
 *  auto-hides on non-last messages, which made stopping an older message's
 *  reading a hover hunt. */
function ReadingBanner() {
  const reading = useContext(ReadAloudContext);
  if (!reading.active) return null;
  const loading = reading.active.phase === "loading";
  return (
    <div className="oc-reading-banner" role="status">
      {loading ? (
        <LoaderCircle size={14} className="oc-actrow__spin" aria-hidden />
      ) : (
        <Volume2 size={14} className="oc-reading-banner__pulse" aria-hidden />
      )}
      <span>
        {loading ? m.chat_reading_loading() : m.chat_reading_playing()}
      </span>
      <button
        type="button"
        className="oc-reading-banner__stop"
        onClick={() => {
          stopAllReading();
          reading.setActive(null);
        }}
      >
        {m.chat_read_stop()}
      </button>
    </div>
  );
}

function IconVolume() {
  return (
    <Icon>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </Icon>
  );
}

function IconVolumeStop() {
  return (
    <Icon>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
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
  // Read/copy actions stay AVAILABLE while a turn runs (the bars are no longer
  // hidden), but DELETE keeps a guard: truncating/regenerating mid-stream would
  // race the running turn's writes.
  const isRunning = useThread((t) => t.isRunning);
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
        isRunning
          ? m.chat_delete_while_running()
          : kind === "assistant"
            ? m.chat_delete_assistant_btn_title()
            : m.chat_delete_user_btn_title()
      }
      aria-label={m.chat_delete_message_aria()}
      aria-busy={busy}
      disabled={busy || isRunning}
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
  // A DELEGATED turn can settle with an EMPTY message text while the visible
  // answer is the sub-agent's resultText (rendered by AssistantEmptyState) —
  // the source view must show THAT text, not "(no text)" under a rendered
  // reply (live report). Same correlation as the empty state: parentMessageId
  // primary, spawn-output keys fallback. The subscription only runs for the
  // empty-text case (the common turn never pays it).
  const chatId = useMessage(
    (m) => (m.metadata?.custom as { chatId?: string } | undefined)?.chatId,
  );
  const messageId = useMessage(
    (m) => (m.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );
  const toolParts = useMessage(
    (m) =>
      (m.metadata?.custom as { toolParts?: ToolActivityPart[] } | undefined)
        ?.toolParts ?? EMPTY_TOOL_PARTS,
  );
  const subAgents = useQuery(
    api.subAgents.listSubAgents,
    raw === "" && chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  ) as SubAgentRow[] | undefined;
  const delegated =
    raw === ""
      ? (subAgentRowsForMessage(
          subAgents ?? [],
          extractSpawnedChildKeys(toolParts),
          messageId,
        ).find((s) => s.status === "done" && s.resultText)?.resultText ?? "")
      : "";
  const fromSubAgent = raw === "" && delegated !== "";
  const effective = raw !== "" ? raw : delegated;
  const [copied, setCopied] = useState(false);
  // Count CODE POINTS, not UTF-16 units (`.length`), so an emoji / non-BMP char
  // does not inflate the count — the number must be trustworthy.
  const codePoints = [...effective].length;
  return (
    <div className="oc-msg__source">
      <div className="oc-msg__source-head">
        <span className="oc-msg__source-label">
          {fromSubAgent
            ? m.chat_source_label_subagent({ count: codePoints })
            : codePoints > 1
              ? m.chat_source_label_plural({ count: codePoints })
              : m.chat_source_label({ count: codePoints })}
        </span>
        <button
          type="button"
          className="oc-iconbtn"
          title={m.chat_copy_source()}
          aria-label={m.chat_copy_source()}
          onClick={() => {
            void navigator.clipboard?.writeText(effective).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
      <pre className="oc-msg__source-pre">{effective.length > 0 ? effective : m.chat_source_empty()}</pre>
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
  // Mid-turn QUEUE: this user turn was sent while the chat was busy, so it is parked
  // behind the in-flight turn (its outbox row is `queued`). Show it as WAITING so the
  // interface makes the hold visible; it clears reactively when the drainer dispatches.
  const queued = useMessage(
    (msg) =>
      (msg.metadata?.custom as { queued?: boolean } | undefined)?.queued ===
      true,
  );
  const messageId = useMessage((msg) => msg.id);
  return (
    <MessagePrimitive.Root
      className={`oc-msg oc-msg--user${sending ? " is-sending" : ""}${
        queued ? " is-queued" : ""
      }`}
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
        ) : queued ? (
          <span className="oc-msg__queued" role="status">
            <Clock size={12} aria-hidden />
            {m.chat_message_queued()}
          </span>
        ) : (
          <ActionBarPrimitive.Root
            className="oc-msg__actions oc-msg__actions--user"
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

// MULTI-AGENT: the per-message attribution chip — emoji + name of the agent that
// answered THIS turn. Reuses the header's `.oc-chip--agent` styling so the two
// read identically. Rendered only in a perTurnRouting chat (see AssistantMessage).
function MessageAgentChip({
  pool,
  agent,
}: {
  pool: PickableAgent[];
  agent: AgentRef;
}) {
  const display = findAgentDisplay(pool, agent);
  const name = display?.displayName ?? agent.agentId;
  return (
    <span
      className="oc-chip oc-chip--agent oc-msg__agent"
      title={m.chat_agent_answered({ name })}
    >
      {display?.emoji ? (
        <span className="oc-chip__emoji" aria-hidden>
          {display.emoji}
        </span>
      ) : (
        <Bot size={13} aria-hidden />
      )}
      <span className="oc-chip__label">{name}</span>
    </span>
  );
}

// Stable empty array so the toolParts selector never returns a fresh reference
// (which would defeat useMessage's memoization and churn re-renders).
const EMPTY_TOOL_PARTS: ToolActivityPart[] = [];

// The "empty bubble" guard (the headline sub-agent fix): when a SETTLED assistant
// turn has NO visible answer — the delegated-and-waiting case where the parent
// finalizes complete with empty text — render a clear, designed inline note RIGHT
// WHERE THE ANSWER WOULD BE instead of a blank bubble. The decision is the pure,
// tested `assistantEmptyState`; this component supplies it the message facts + the
// chat's sub-agent rows and renders the result.
//
// COEXISTS with the in-context sub-agent card (MessageSubAgents), which now lives
// ONLY in the analysis view's meta group. So in the ANALYSIS view this defers the
// running/failed detail to the card (returns null to avoid doubling it); in the
// CLEAN view (card hidden) it surfaces the WAITING and FAILED notes ITSELF so a
// delegated turn is never a blank bubble. The DONE result is the turn's answer and
// renders as markdown ALWAYS (both views); the GENERIC "acted but answered nothing"
// note covers the rest.
//
// Returns null for a normal turn (there IS an answer) or an in-flight / errored
// turn (the thinking indicator / RunStatus error card already cover those), so it
// is inert on every healthy message.
function AssistantEmptyState({ show }: { show: boolean }) {
  const status = useMessage(
    (msg) => (msg.metadata?.custom as { status?: string } | undefined)?.status,
  );
  const chatId = useMessage(
    (msg) => (msg.metadata?.custom as { chatId?: string } | undefined)?.chatId,
  );
  // Boolean selectors -> re-render only on the empty<->non-empty crossing, not on
  // every streamed token.
  const hasText = useMessage((msg) =>
    messageHasText(
      msg.content as ReadonlyArray<{ type?: string; text?: unknown }>,
    ),
  );
  const hasMedia = useMessage((msg) =>
    (msg.content as ReadonlyArray<{ type?: string }>).some(
      (p) => p?.type === "file",
    ),
  );
  const toolParts = useMessage(
    (msg) =>
      (msg.metadata?.custom as { toolParts?: ToolActivityPart[] } | undefined)
        ?.toolParts ?? EMPTY_TOOL_PARTS,
  );
  // Owner-scoped + reactive. Convex dedupes this with the sub-agent monitor's
  // identical subscription, so every assistant row shares ONE network query; it
  // returns [] for a chat with no sub-agents (the common case) — bounded cost.
  const subAgents = useQuery(
    api.subAgents.listSubAgents,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  ) as SubAgentRow[] | undefined;
  // The Convex message _id (convertMessage surfaces it as custom.messageId) = the
  // bridge's `parentMessageId` → the robust, message-precise correlation key.
  const messageId = useMessage(
    (msg) =>
      (msg.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );

  const state = assistantEmptyState(
    { status, hasText, hasMedia },
    toolParts,
    subAgents ?? [],
    messageId,
  );
  if (state.kind === "none") return null;

  if (state.kind === "failed") {
    // In the ANALYSIS view the in-context sub-agent CARD owns the failure (its
    // destructive box + reason) — defer, else we'd double it. In the CLEAN view the
    // card is hidden (it now lives in the Outils-gated meta group), so the bubble
    // would otherwise be BLANK on a failed delegation — render the failure prose so
    // it stays un-missable (the persistent composer beacon is the chat-level echo).
    if (show) return null;
    return (
      <div className="oc-empty-answer oc-empty-answer--failed" role="status">
        <Bot size={15} className="oc-empty-answer__icon" aria-hidden />
        <span className="oc-empty-answer__text">
          {state.taskName
            ? m.assistant_empty_failed_named({
                task: state.taskName,
                reason: state.reason,
              })
            : m.assistant_empty_failed({ reason: state.reason })}
        </span>
      </div>
    );
  }

  if (state.kind === "waiting") {
    // The running CARD already shows this turn's delegation in the analysis view;
    // only the clean view (which hides running cards) needs the prose so the
    // settled-empty bubble is never blank.
    if (show) return null;
    return (
      <div className="oc-empty-answer oc-empty-answer--waiting" role="status">
        <LoaderCircle size={15} className="oc-empty-answer__spin" aria-hidden />
        <span className="oc-empty-answer__text">
          {state.taskName
            ? m.assistant_empty_waiting_named({ task: state.taskName })
            : m.assistant_empty_waiting()}
        </span>
      </div>
    );
  }

  if (state.kind === "done") {
    // The sub-agent's result IS this turn's answer — render it as MARKDOWN,
    // IDENTICAL to a normal reply (no special block). The "a sub-agent produced
    // this" detail lives in the gated in-thread card, not here.
    return state.resultText ? <AgentMarkdown text={state.resultText} /> : null;
  }

  return (
    <div className="oc-empty-answer oc-empty-answer--generic" role="status">
      <Bot size={15} className="oc-empty-answer__icon" aria-hidden />
      <span className="oc-empty-answer__text">{m.assistant_empty_generic()}</span>
    </div>
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
  // A QUEUED user turn's synthetic upcoming-message placeholder (assistant-ui shows it
  // only because ANOTHER turn is streaming; it carries no status of its own) is
  // redundant with the queued USER message's "En attente" badge. `status===undefined`
  // + last user turn queued identifies exactly that placeholder — suppress the whole
  // phantom "Atrium · En attente" row (see the early return below, AFTER all hooks) so
  // the queue shows ONE indicator. A real streaming turn (status defined) is untouched.
  const placeholderStatus = useMessage(
    (m) => (m.metadata?.custom as { status?: string } | undefined)?.status,
  );
  const lastUserTurnQueued = useContext(QueuedTurnContext);
  // Auto read-aloud (per-instance opt-in): speaks a reply that completes live.
  const autoReadText = useMessage((msg) =>
    msg.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n"),
  );
  useAutoRead(autoReadText);
  // MULTI-AGENT: in a perTurnRouting chat each reply names the agent that answered
  // it (per-message, inheriting the user turn's agent — see perTurnAgent.ts). A
  // single-agent chat keeps the identity name EXACTLY as before.
  //   - Message IN the map, resolved → that agent.
  //   - Message IN the map, null (an unrouted turn, e.g. pre-flip history) → the
  //     chat's PRIMARY (it answered in the single-agent era).
  //   - Message ABSENT (the synthetic in-flight placeholder) → the just-routed
  //     agent, so it does not flash the wrong identity before the real one lands.
  const routing = useChatRouting();
  const perMsgAgent =
    routing && routing.perTurnRouting
      ? routing.messageAgents.has(messageId)
        ? (routing.messageAgents.get(messageId) ?? routing.primary)
        : routing.fallbackAgent
      : null;
  // Per-message identity override for RunStatus: the "…{name} is processing…"
  // long-wait reassurance must name the agent THIS turn is routed to, not the
  // chat primary. Scoped to RunStatus only — the avatar stays brand-uniform. Falls
  // back to the chat identity (same object) on a single-agent chat → no change.
  const pool = routing?.pool;
  const messageIdentity = useMemo<AssistantIdentity>(() => {
    if (!perMsgAgent) return identity;
    const d = findAgentDisplay(pool ?? [], perMsgAgent);
    return {
      ...identity,
      agentName: d?.displayName ?? perMsgAgent.agentId,
      agentEmoji: d?.emoji ?? null,
    };
  }, [perMsgAgent, identity, pool]);
  // Suppress the queued synthetic placeholder entirely (its "En attente" lives on the
  // user message badge). Placed AFTER all hooks — Rules of Hooks.
  if (placeholderStatus === undefined && lastUserTurnQueued) return null;
  // NOTE (deliberate): a COMPLETE-but-empty assistant row (the silent
  // sessions_spawn parent whose reply arrives as a later spontaneous turn) is
  // NOT suppressed — AssistantEmptyState already renders it as an explanatory
  // line, and suppressing the row would also swallow the compaction marker
  // (codex R2 P2 vs R3 P2: rendering an honest explainer beats hiding a row).
  return (
    <MessagePrimitive.Root
      className="oc-msg oc-msg--assistant"
      data-message-id={messageId}
    >
      <BrandAvatar className="oc-msg__avatar" />
      <div className="oc-msg__col">
        <div className="oc-msg__name">
          {perMsgAgent ? (
            <MessageAgentChip pool={routing!.pool} agent={perMsgAgent} />
          ) : (
            <>
              {identity.agentEmoji ? (
                <span className="oc-msg__name-emoji" aria-hidden>
                  {identity.agentEmoji}
                </span>
              ) : null}
              {assistantDisplayName(identity)}
            </>
          )}
        </div>
        <div className="oc-msg__body">
          {/* "Outils" ON = the ANALYSIS view: ONE grouped meta block above the answer
              (a single subtly-ruled container so it reads as this turn's metadata, as
              one block) holding — in order — the sub-agent monitor (the child run(s)
              this turn delegated, opening the secondary-conversation panel), the tool
              activity (summary + click-to-expand ToolCards), and the Sources block
              (what memory/document plugins fed the LLM). All three share the same
              ActivityRow chrome (left icon+label / right status+chevron). OFF = the
              CLEAN, content-focused view: the block is hidden; the in-progress signal
              is carried by RunStatus below and any FAILED child stays reachable via
              the persistent SubAgentFailureBeacon near the composer, so nothing about
              an active treatment is lost. Everything BELOW the block is purely the
              agent's returned message (text + delivered files), un-mixed; above-the-
              body also keeps streamed text in view of the bottom-following scroll. */}
          {/* Cron mutations are ALWAYS visible (like the compaction marker):
              the user must notice their prompt produced/changed scheduled
              jobs even in the clean view — that's conversation-level info,
              not tool-call detail. */}
          <div className="oc-msg__meta oc-msg__meta--cron">
            <PlanActivity />
            <CronActivity />
          </div>
          {ui.showTools ? (
            <div className="oc-msg__meta">
              <MessageSubAgents />
              <ToolActivity />
              <SourcesActivity />
            </div>
          ) : null}
          {/* Gateway compaction marker — ALWAYS visible (outside the tools
              toggle): it explains a long pre-answer wait and the agent's
              condensed older memory, which is conversation-level information,
              not tool telemetry. Renders null on the (vast) majority of turns. */}
          <CompactionNotice />
          {showSource ? (
            <MessageSource />
          ) : (
            <MessagePrimitive.Parts components={assistantComponents} />
          )}
          {/* Empty-bubble guard: a settled turn that delegated to a sub-agent and
              returned no text renders a clear waiting/generic note here (where the
              answer would be) instead of a blank bubble. The FAILED case is owned
              by the in-context sub-agent card below; `show` lets the running note
              defer to the running card in the analysis view (no duplicate). Inert
              on a normal or in-flight turn (renders null). HIDDEN while the raw
              SOURCE view is open — MessageSource already shows the delegated
              result's raw text, so rendering it here too would duplicate the
              answer under its own source. */}
          {showSource ? null : <AssistantEmptyState show={ui.showTools} />}
          {/* RunStatus reads the assistant identity for its long-wait label; scope
              it to the per-message routed agent so the reassurance names the right
              one (the override equals the chat identity on a single-agent chat). */}
          <AssistantIdentityContext.Provider value={messageIdentity}>
            <RunStatus />
          </AssistantIdentityContext.Provider>
        </div>
        {/* Per-message actions, hidden while a turn runs + revealed on hover for
            non-last turns (always shown on the last). Copy + Delete. Deleting an
            assistant turn truncates from here and REGENERATES the last user turn
            (see messages.deleteMessage) — no confirm (recoverable). */}
        <ActionBarPrimitive.Root
          className="oc-msg__actions"
          autohide="not-last"
        >
          {ui.copyAssistant ? <CopyAssistantButton /> : null}
          <ReadAloudButton />
          {ui.showReport ? <FeedbackButton /> : null}
          {ui.showDelete ? <DeleteMessageButton kind="assistant" /> : null}
          {/* ChatGPT-style: the ⋯ menu closes the row (rightmost) and hosts the
              datetime header + the source toggle + branching. */}
          <AssistantMoreMenu
            sourceShown={ui.showSource}
            sourceActive={showSource}
            onToggleSource={() => setShowSource((s) => !s)}
          />
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
// placeholder carries no status, so RunStatus renders it as the thinking label (see
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
  // Image attachments show a THUMBNAIL preview (the user pasted an image and
  // wants to SEE it, not a generic file chip). The pending attachment carries
  // the File; an object URL renders it locally with zero upload wait, revoked
  // on unmount to avoid a leak.
  const file = useAttachment(
    (a) => (a as { file?: File }).file ?? null,
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (type !== "image" || !file) {
      setPreviewUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [type, file]);
  // The chip shows the selected file + filename; the live upload PROGRESS (which
  // runs in adapter.send() on send, the slow part for a big file) is surfaced
  // separately by <UploadProgress> (a % bar) so this chip stays simple. Only a
  // genuine failure ("incomplete") surfaces a state here, so an upload error is
  // never silent.
  const failed = status === "incomplete";
  // A routed large-paste chip announces ITSELF: a one-shot shimmer on mount
  // replaces the former success toast (the chip appearing IS the confirmation).
  const pasted = file !== null && isPastedFile(file);
  // Eye = full-size preview of the PENDING attachment (read the File locally,
  // zero upload): text renders in a scrollable <pre>, an image full-size. Lets
  // the user VERIFY a routed paste's content before sending (user request).
  const [viewOpen, setViewOpen] = useState(false);
  const [viewText, setViewText] = useState<string | null>(null);
  // Latest File this (index-keyed, reusable) chip renders — the staleness guard
  // for the async preview read.
  const fileRef = useRef<File | null>(null);
  fileRef.current = file;
  const isTextLike =
    file !== null &&
    (file.type.startsWith("text/") ||
      /\.(txt|md|json|csv|log|xml|yaml|yml)$/i.test(file.name));
  const openView = () => {
    setViewOpen(true);
    // RESET before the read: assistant-ui keys attachment chips by index, so a
    // removal can reuse this chip for ANOTHER file — a stale viewText would
    // show the previous file's content while the new read is in flight (or
    // forever, if it fails) (codex P2).
    setViewText(null);
    if (isTextLike && file) {
      // A slow read racing a chip reuse (index-keyed) must not paint the OLD
      // file's content: apply the result only if the chip still shows the same
      // File (codex P2).
      const current = file;
      // Bounded preview: a multi-MB text in one <pre> freezes the renderer —
      // the eye is for VERIFYING content, not reading megabytes (codex P2).
      const PREVIEW_CAP = 200_000;
      void current
        .slice(0, PREVIEW_CAP)
        .text()
        .then((t) => {
          if (fileRef.current !== current) return;
          setViewText(
            current.size > PREVIEW_CAP
              ? t + "\n\n" + m.chat_attach_view_truncated()
              : t,
          );
        })
        .catch(() => {
          if (fileRef.current === current) setViewText(null);
        });
    }
  };
  return (
    <AttachmentPrimitive.Root
      className={`oc-attach${failed ? " oc-attach--error" : ""}${
        previewUrl && !failed ? " oc-attach--image" : ""
      }${pasted ? " oc-attach--flash" : ""}`}
      data-status={status}
    >
      {previewUrl && !failed ? (
        <img src={previewUrl} alt="" className="oc-attach__thumb" />
      ) : (
        <span className="oc-attach__icon" aria-hidden>
          {failed ? (
            <CircleAlert size={14} />
          ) : type === "image" ? (
            <ImageIcon size={14} />
          ) : (
            <Paperclip size={14} />
          )}
        </span>
      )}
      {previewUrl && !failed ? null : (
        <span className="oc-attach__name">
          <AttachmentPrimitive.Name />
        </span>
      )}
      {failed ? (
        <span className="oc-attach__state">{m.chat_attach_failed()}</span>
      ) : null}
      {!failed && (isTextLike || previewUrl) ? (
        <button
          type="button"
          className="oc-attach__view"
          aria-label={m.chat_attach_view()}
          title={m.chat_attach_view()}
          onClick={openView}
        >
          <Eye size={13} aria-hidden />
        </button>
      ) : null}
      <AttachmentPrimitive.Remove
        className="oc-attach__remove"
        aria-label={m.chat_attach_remove()}
      >
        <X size={13} aria-hidden />
      </AttachmentPrimitive.Remove>
      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent className="oc-attach__dialog">
          <DialogHeader>
            <DialogTitle className="oc-attach__dialog-title">
              {file?.name ?? m.chat_attach_view()}
            </DialogTitle>
          </DialogHeader>
          {previewUrl ? (
            <img src={previewUrl} alt="" className="oc-attach__dialog-img" />
          ) : viewText !== null ? (
            <pre className="oc-attach__dialog-text">{viewText}</pre>
          ) : (
            <p className="oc-attach__dialog-text">…</p>
          )}
        </DialogContent>
      </Dialog>
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

// Send-while-busy button (mid-turn QUEUE). Reads the composer text reactively
// (enabled only when non-empty), queues it server-side via the QueueSendContext,
// then clears the composer. The queued user message echoes instantly (optimistic)
// and is dispatched when the chat frees up. `reason` only swaps the labels so the
// hold is attributed to the right cause: an in-flight TURN vs a running SUB-AGENT.
function QueueSendButton({ reason }: { reason: ComposerQueueReason }) {
  const queueSend = useContext(QueueSendContext);
  const composer = useComposerRuntime();
  const text = useComposer((c) => c.text);
  const hasText = text.trim().length > 0;
  const isSubagent = reason === "subagent";
  return (
    <button
      type="button"
      className="oc-composer__send"
      disabled={!hasText || queueSend === null}
      aria-label={
        isSubagent ? m.chat_queue_subagent_aria() : m.chat_queue_send_aria()
      }
      title={
        hasText
          ? isSubagent
            ? m.chat_queue_subagent_title()
            : m.chat_queue_send_title()
          : isSubagent
            ? m.chat_queue_hint_subagent()
            : m.chat_response_in_progress()
      }
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

// STOP button (shown beside the queue-send while a TURN is streaming): settles
// the reply instantly with what streamed so far and kills the gateway run so it
// stops burning tokens on an answer the user no longer wants. Not shown for the
// sub-agent hold (the parent turn is already finalized — nothing to stop).
function StopTurnButton() {
  const abortTurn = useContext(AbortTurnContext);
  if (abortTurn === null) return null;
  return (
    <button
      type="button"
      className="oc-composer__send oc-composer__stop"
      aria-label={m.chat_stop_aria()}
      title={m.chat_stop_title()}
      onClick={() => void abortTurn()}
    >
      <Square size={14} aria-hidden />
    </button>
  );
}

// MULTI-AGENT: inline per-turn agent selector for the composer action bar. Lets a
// user with more than one agent route the NEXT turn to a chosen specialist within
// the SAME conversation (the reply is then attributed to it). Reuses AgentPicker's
// pure helpers (groupByInstance / filterAgents) + the `.oc-agentpicker` list
// styling. Hidden for a single-agent user (nothing to choose). Disabled until the
// chat has a first turn: the agent is bound at creation, so turn 1 is never
// re-routable — matching the single-agent-path rule (never route the first turn).
function ComposerAgentSelect({ unavailable = false }: { unavailable?: boolean }) {
  const routing = useChatRouting();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const pool = routing?.pool ?? [];
  const groups = useMemo(() => groupByInstance(filterAgents(pool, q)), [pool, q]);
  // Does the entitled pool span MORE THAN ONE instance? When it does the agent name
  // alone can be ambiguous (the same display name can live on two gateways), so the
  // trigger also names the selected agent's instance (mirrors the old header chip).
  const multiInstance = useMemo(
    () => new Set(pool.map((a) => a.instanceName)).size > 1,
    [pool],
  );
  if (!routing || !routing.multiAgent) return null;
  const { selected, setSelected, hasUserTurn } = routing;
  // Disabled until the chat has a first turn (the agent is bound at creation), or
  // when the composer is unavailable (bridge down / read-only — nothing to send).
  const disabled = !hasUserTurn || unavailable;
  const display = findAgentDisplay(pool, selected);
  const currentName =
    display?.displayName ?? selected?.agentId ?? m.chat_agent_select_label();
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!disabled) setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="oc-composer__agent"
          disabled={disabled}
          title={
            hasUserTurn
              ? m.chat_agent_select_title()
              : m.chat_agent_select_firstturn_hint()
          }
          aria-label={m.chat_agent_select_aria()}
        >
          {display?.emoji ? (
            <span className="oc-composer__agent-emoji" aria-hidden>
              {display.emoji}
            </span>
          ) : (
            <Bot size={15} aria-hidden />
          )}
          <span className="oc-composer__agent-name">{currentName}</span>
          {multiInstance && selected ? (
            <span
              className="oc-composer__agent-instance"
              title={m.chat_agent_instance_title({
                instance: selected.instanceName,
              })}
            >
              <Server size={11} aria-hidden />
              {selected.instanceName}
            </span>
          ) : null}
          <ChevronDown size={13} className="oc-chip__chev" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="oc-composer__agent-pop p-0">
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={m.agentpicker_search_placeholder()}
          aria-label={m.agentpicker_search_aria_label()}
          className="oc-agentpicker__search"
        />
        <div className="oc-agentpicker__list" role="listbox">
          {groups.map((g) => (
            <div key={g.instanceName} className="oc-agentpicker__group">
              <div className="oc-agentpicker__instance">
                <Server size={13} aria-hidden />
                <span>{g.instanceName}</span>
                <Badge variant="outline" className="oc-agentpicker__kind">
                  {g.kind}
                </Badge>
              </div>
              {g.agents.map((a) => {
                const isSel = agentRefEquals(selected, {
                  instanceName: a.instanceName,
                  agentId: a.agentId,
                });
                return (
                  <button
                    key={`${a.instanceName}/${a.agentId}`}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className={`oc-agentpicker__item${isSel ? " is-selected" : ""}`}
                    disabled={a.state === "deleted"}
                    title={
                      a.state === "deleted"
                        ? m.agentpicker_agent_deleted_title()
                        : undefined
                    }
                    onClick={() => {
                      setSelected({
                        instanceName: a.instanceName,
                        agentId: a.agentId,
                      });
                      setOpen(false);
                      setQ("");
                    }}
                  >
                    <Bot size={15} aria-hidden className="oc-agentpicker__icon" />
                    <span className="oc-agentpicker__main">
                      <span className="oc-agentpicker__label">
                        {a.emoji ? `${a.emoji} ` : ""}
                        {a.displayName ?? a.agentId}
                      </span>
                      {a.description ? (
                        <span className="oc-agentpicker__desc">
                          {a.description}
                        </span>
                      ) : null}
                    </span>
                    {a.model ? (
                      <span className="oc-agentpicker__model">{a.model}</span>
                    ) : null}
                    {isSel ? (
                      <Check
                        size={14}
                        aria-hidden
                        className="oc-agentpicker__default"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}


/** The composer mic — REAL dictation (browser SpeechRecognition). Toggle:
 *  start → live transcription (final pieces appended to the composer text) →
 *  stop (button, or the engine's own end). Language follows the instance's
 *  voice config. Errors surface as a toast, and an unsupported browser gets a
 *  clear message instead of a dead button. */
function DictationButton() {
  const voice = useContext(VoiceConfigContext);
  const composer = useComposerRuntime();
  const toast = useToast();
  const [recording, setRecording] = useState(false);
  const handleRef = useRef<DictationHandle | null>(null);
  // Stop the engine when the composer unmounts mid-dictation (chat switch).
  useEffect(() => () => handleRef.current?.stop(), []);
  const lang = resolveSpeechLang(voice.lang, getLocale());
  // User-defined toggle shortcut (profile-stored; null = none). It must work
  // even while the composer textarea has focus — dictation targets it.
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const dictationShortcut =
    ((me as { dictationShortcut?: Shortcut | null } | undefined | null)
      ?.dictationShortcut ?? null);
  const toggleRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!dictationShortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!matchesShortcut(e, dictationShortcut)) return;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dictationShortcut]);
  const shortcutHint = dictationShortcut
    ? ` (${shortcutLabel(dictationShortcut, isMac())})`
    : "";
  return (
    <button
      type="button"
      className={`oc-composer__icon${recording ? " oc-composer__icon--rec" : ""}`}
      title={(recording ? m.chat_mic_stop() : m.chat_mic_start()) + shortcutHint}
      aria-label={recording ? m.chat_mic_stop() : m.chat_mic_start()}
      aria-pressed={recording}
      ref={(el) => {
        // The shortcut fires the SAME code path as a click — one behavior,
        // two triggers (no drift between them).
        toggleRef.current = () => el?.click();
      }}
      onClick={() => {
        if (recording) {
          handleRef.current?.stop();
          handleRef.current = null;
          setRecording(false);
          return;
        }
        if (!dictationSupported()) {
          toast.error(m.chat_mic_error_unsupported());
          return;
        }
        const h = startDictation({
          lang,
          onText: (t) => {
            const cur = composer.getState().text;
            composer.setText(cur ? `${cur.replace(/\s+$/, "")} ${t.trim()}` : t.trim());
          },
          onEnd: () => {
            handleRef.current = null;
            setRecording(false);
          },
          onError: (code) => {
            handleRef.current = null;
            setRecording(false);
            if (code === "not-allowed" || code === "service-not-allowed") {
              toast.error(m.chat_mic_error_denied());
            } else if (code !== "no-speech" && code !== "aborted") {
              toast.error(m.chat_mic_error_generic({ code }));
            }
          },
        });
        if (h === null) {
          toast.error(m.chat_mic_error_unsupported());
          return;
        }
        handleRef.current = h;
        setRecording(true);
      }}
    >
      <Mic size={18} aria-hidden />
    </button>
  );
}

function Composer({
  chatId,
  showTools,
  onToggleTools,
  unavailable = false,
  subAgentBusy = false,
}: {
  chatId: ConvexId<"chats">;
  showTools: boolean;
  onToggleTools: () => void;
  /** Bridge down: disable input + send so no un-sendable turn is persisted. */
  unavailable?: boolean;
  /** A sub-agent this chat spawned is still running: hold the next send (queue) and
   *  SHOW the hold, exactly like an in-flight turn. */
  subAgentBusy?: boolean;
}) {
  // Attachments affordance is capability-driven: OpenClaw advertises
  // `inboundAttachments`, Hermes does NOT (its API server takes no uploaded
  // files) — so the attach button HIDES itself on a Hermes chat with no
  // per-provider UI code (the multi-provider design's payoff). Defaults to
  // shown while capabilities load, so an OpenClaw chat never flickers.
  const {
    can: chatCan,
    loading: capsLoading,
    resolved: capsResolved,
  } = useInstanceCapabilities(chatId);
  // Hide the attach affordance ONLY on an EXPLICITLY resolved capability set
  // that lacks inboundAttachments (Hermes). While loading OR unresolved
  // (legacy bridge / missing snapshot during an upgrade) fail OPEN — a
  // long-standing OpenClaw affordance must not vanish on stale compat data
  // (codex P2); the bridge still rejects unsupported sends server-side.
  const attachmentsSupported =
    capsLoading || !capsResolved || chatCan("inboundAttachments");
  // Voice-input feature flag: resolved via the UI-preferences module (gated by
  // system enablement + the user's override). The mic only renders when true.
  const voiceInput = useUiPrefs().voiceInput;
  // Placeholder identity: the agent the composer CURRENTLY targets (the selector
  // chip — switching agents must update the placeholder instantly), falling back
  // to the resolved chat identity (brand / single-agent name).
  const composerIdentity = useAssistantIdentity();
  const composerRouting = useChatRouting();
  const composerSelected = composerRouting?.selected ?? null;
  const composerName = composerSelected
    ? (findAgentDisplay(composerRouting?.pool ?? [], composerSelected)
        ?.displayName ?? composerSelected.agentId)
    : assistantDisplayName(composerIdentity);
  // Mid-turn QUEUE: while a turn is in flight OR a sub-agent runs, the chat is
  // BUSY — assistant-ui blocks its own Enter→send only for the in-flight turn, so
  // we intercept Enter HERE and queue for BOTH busy sources. When idle we do
  // nothing and assistant-ui handles Enter normally. `composerQueueState` is the
  // single, tested source of the send-vs-queue decision + the hold REASON.
  const isRunning = useThread((t) => t.isRunning);
  const queueMode = composerQueueState({
    turnRunning: isRunning,
    hasRunningSubAgent: subAgentBusy,
  });
  const queued = queueMode.mode === "queue";
  const queueSend = useContext(QueueSendContext);
  const composerRuntime = useComposerRuntime();
  // Large-paste routing: a big pasted text becomes a FILE attachment instead
  // of inlining into the prompt (a single paste could overflow the agent's
  // context before compaction ran — live 2026-07-04). The attachment pipeline
  // (upload chip, size policy derived from the gateway, shared-fs/inline
  // transport) takes over; the composer text stays untouched.
  const pasteSeq = useRef(1);
  const pasteToast = useToast();
  // True while a routed paste's attachment is being ADDED (the adapter runs
  // async size-policy checks before it lands in the composer state): submit is
  // held so an immediate Enter can never send the message WITHOUT its pasted
  // file (codex P2).
  const [pasteAttachCount, setPasteAttachCount] = useState(0);
  // SR-only announcement of a routed paste (visually silent — codex P2 a11y).
  const [pasteAnnouncement, setPasteAnnouncement] = useState("");
  const pasteAttaching = pasteAttachCount > 0;
  const onInputPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // A clipboard carrying FILES (e.g. an image + text from an office app) is
    // the built-in handler's job — preventDefault here would silently drop
    // those files (codex P2). Only pure-text pastes are routed.
    if ((e.clipboardData?.files?.length ?? 0) > 0) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const route = routePaste(text, pasteSeq.current);
    if (route.kind !== "file") return;
    // Instance without attachment support (Hermes): let the paste land as
    // PLAIN TEXT in the input — never mint an attachment the bridge would
    // reject with ATTACHMENT_REJECTED (codex P2; the attach button is already
    // hidden on these instances).
    if (!attachmentsSupported) return;
    e.preventDefault();
    if (queued) {
      // A queued follow-up is TEXT-ONLY (the attach button is already disabled
      // in this mode) — refuse loudly instead of creating an attachment that
      // would silently NOT ride along (codex P2). The clipboard is untouched.
      pasteToast.error(m.chat_paste_queue_blocked());
      return;
    }
    pasteSeq.current += 1;
    const file = new File([text], route.filename ?? "texte-colle.txt", {
      type: "text/plain; charset=utf-8",
    });
    markPastedFile(file);
    // COUNTER (not a boolean): two rapid pastes overlap their async policy
    // checks; the first settle must not re-enable send while the second is
    // still adding (codex P2).
    setPasteAttachCount((n) => n + 1);
    void composerRuntime
      .addAttachment(file)
      .then(() => {
        // No VISIBLE success toast (user feedback 2026-07-05): the chip
        // appearing + its mount shimmer IS the confirmation. But the paste was
        // preventDefault-ed out of the textarea, so a NON-VISUAL user needs the
        // announcement — an sr-only live region replaces the toast (codex P2).
        // CLEAR-then-set: two same-size pastes produce the SAME string, and an
        // unchanged live-region node re-announces nothing — the empty frame in
        // between makes every paste announce (codex P3).
        setPasteAnnouncement("");
        requestAnimationFrame(() =>
          setPasteAnnouncement(
            m.chat_paste_as_file({ lines: String(route.lines) }),
          ),
        );
      })
      .catch((err) => {
        // NEVER fall back to inlining (a paste too big for the ATTACHMENT cap
        // inlined into the prompt would be the original context blow-up, worse
        // — codex P2). The adapter already toasts its reject reason; the
        // content is still in the user's clipboard, nothing is lost.
        console.error("[paste] attachment routing failed:", err);
        pasteToast.error(m.chat_paste_attach_failed());
      })
      .finally(() => setPasteAttachCount((n) => Math.max(0, n - 1)));
  };
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Hold submit while a routed paste's attachment is still being added.
    if (pasteAttaching && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!queued || queueSend === null) return;
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
    <>
    <ReadingBanner />
    <ComposerPrimitive.Root
      className={`oc-composer${unavailable ? " oc-composer--disabled" : ""}`}
    >
      <ComposerPrimitive.Attachments
        components={{ Attachment: ComposerAttachmentChip }}
      />
      {/* SR-only routed-paste confirmation: the paste never lands in the
          textarea, so without this a non-visual user cannot tell it became an
          attachment (the visible cue is the chip's mount shimmer). */}
      <span className="oc-sr-only" role="status" aria-live="polite">
        {pasteAnnouncement}
      </span>
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
          unavailable
            ? m.chat_composer_unavailable()
            : // The composer's TARGET name (selected agent, else brand/identity) —
              // never a hardcoded provider: OpenClaw is one gateway among others
              // (Hermes upcoming), not the product the user writes to.
              m.chat_composer_placeholder({ name: composerName })
        }
        autoFocus
        rows={1}
        disabled={unavailable}
        onKeyDownCapture={onInputKeyDown}
        onPaste={onInputPaste}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
      />
      {/* No in-composer status. Anything tied to an AI response — processing,
          held-send, sub-agents — is anchored to THAT response in the thread (the
          run status + sub-agent cards), never accumulated in the neutral composer
          (a response with sub-agents, then a plain one, then another with
          sub-agents must each carry their own context where they belong). The
          held-send LOGIC stays (Enter queues while busy); only its hint is gone. */}
      <div className="oc-composer__bar">
        <div className="oc-composer__group">
          {/* The QUEUE is TEXT-ONLY: while the chat is busy (in-flight turn OR a
              running sub-agent) the follow-up goes through queueSend (text only),
              so attaching here would be silently dropped. Disable the picker while
              queued (and when unavailable) so the affordance never lies. Including
              attachments in a queued send is a later phase. */}
          {attachmentsSupported ? (
            <ComposerPrimitive.AddAttachment
              className="oc-composer__icon"
              aria-label={m.chat_attach_file()}
              disabled={queued || unavailable}
            >
              <Plus size={18} aria-hidden />
            </ComposerPrimitive.AddAttachment>
          ) : null}
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
          {/* MULTI-AGENT: per-turn agent selector (self-hides for a single-agent
              user; disabled until the chat has a first turn, or when unavailable). */}
          <ComposerAgentSelect unavailable={unavailable} />
        </div>
        <div className="oc-composer__group">
          {voiceInput ? <DictationButton /> : null}
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
          ) : queueMode.mode === "queue" ? (
            /* The chat is BUSY — an in-flight turn OR a running sub-agent (the
               parent turn already finalized, but the bridge is one-turn-per
               -session). The follow-up is accepted NOW and serialized server-side
               (parked as a `queued` outbox row, auto-dispatched when the chat frees
               up). The button is enabled iff there's text; Enter also queues (see
               the Input's onKeyDown). `reason` only swaps the label. Driven by
               queueMode (NOT ThreadPrimitive.If running) so the sub-agent case —
               where the thread is NOT running — also shows the queue affordance. */
            <>
              {queueMode.reason === "turn" ? <StopTurnButton /> : null}
              <QueueSendButton reason={queueMode.reason} />
            </>
          ) : (
            <ComposerPrimitive.Send
              className="oc-composer__send"
              aria-label={m.chat_send()}
              disabled={pasteAttaching}
            >
              <ArrowUp size={18} aria-hidden />
            </ComposerPrimitive.Send>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
    </>
  );
}
